#!/usr/bin/env node
/* render-gate — the gate that OPENS THE PAGE.
 *
 *   node ops/qa/render-gate.mjs <url> [--json] [--shots <dir>] [--quiet]
 *
 * WHY THIS EXISTS. Every gate in this estate reads source. icons-gate greps the icon set,
 * mark-gate greps the lockup, `workbench check` hashes the vendored files. All of them are
 * decidable without a renderer, which is why all of them passed on 2026-08-02 while StoreReady's
 * landing shipped with an empty hero: its `data-animate="17g0wbg"` resolved against motion data
 * from a different capture, so the h1 held the start frame — opacity 0.001 — permanently. The
 * element was in the DOM at the right size, the right colour and the right position. There is no
 * string to grep for that. The only way to know is to render the page and measure the pixel.
 *
 * So this gate never reads a file. It takes a URL, drives a real browser, and asks the six
 * questions that a screenshot answers and a grep cannot:
 *
 *   A · VISIBLE     is text that occupies space actually painted? (effective opacity, the whole
 *                   ancestor chain multiplied — the StoreReady class of bug)
 *   B · CONTRAST    does every text run clear WCAG against its COMPUTED background? (the
 *                   black-on-black class: a card that inherits `color` after its surface flipped)
 *   C · OVERFLOW    does the page scroll horizontally at any width from 320 to 1920?
 *   D · WRAP        does any nav link, footer link or CTA label break onto a second line?
 *   E · FOLD        at 1280x800, are the headline AND the primary CTA both above the fold?
 *   F · CLIPPED     is content trapped past the START edge of its own scroll container, where
 *                   no scroll position can reach it? (`overflow:auto` + `justify-content:center`
 *                   — the panel renders, and a reader cannot get to the top of it)
 *   G · NESTED      does every nested scroll region ACTUALLY SCROLL when a real wheel is driven
 *                   over it? (the Lenis class: smooth-scroll preventDefaults the wheel at the
 *                   document and moves the page instead, so the region is dead and looks fine)
 *
 * It is NOT in manifest.json and is NOT vendored into products. Products carry no browser
 * dependency and that is deliberate — they deploy prebuilt from their own repo and a Playwright
 * install inside a dozen deploy paths is a dozen ways for a deploy to fail. This runs standalone,
 * against a URL, on demand: a preview deploy, a live domain, or a production build on localhost.
 * Playwright is resolved at run time from whatever the host already has — see loadChromium.
 *
 * EXIT CODES.  0 = clean (warnings allowed).  1 = at least one hard failure.  2 = could not run.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/* ── PLAYWRIGHT IS AN OPTIONAL PEER, NOT A DEPENDENCY ─────────────────────────────────────────
 *
 * Everything else in this project is zero-dependency and runs on a bare node. This one gate
 * needs a real browser, and a browser download inside every consumer's install is a good way to
 * make the whole thing un-adoptable. So playwright is resolved at RUN time from wherever the
 * host already has it — the consuming project's node_modules first, then this package's, then
 * a path named in DEFERLESS_PLAYWRIGHT — and its absence is reported as "could not run" (exit 2),
 * never as a pass. */

function loadChromium() {
  const require_ = createRequire(import.meta.url);
  const tryLoad = (spec) => {
    try {
      const m = require_(spec);
      return m.chromium ?? null;
    } catch {
      return null;
    }
  };

  const explicit = process.env.DEFERLESS_PLAYWRIGHT;
  const candidates = [
    ...(explicit ? [explicit] : []),
    // the project being checked, which is where a repo that runs this in CI will have installed it
    path.join(process.cwd(), "node_modules", "playwright"),
    path.join(process.cwd(), "node_modules", "playwright-core"),
    // plain resolution: this package's own node_modules, then anything hoisted above it
    "playwright",
    "playwright-core",
  ];
  for (const spec of candidates) {
    const chromium = tryLoad(spec);
    if (chromium) return chromium;
  }
  return null;
}

/* ── Thresholds ────────────────────────────────────────────────────────────────────────────── */

// Below this, text that occupies space is not meaningfully painted. StoreReady's hero was 0.001;
// a legitimately dimmed caption is rarely under 0.35. 0.08 sits well clear of both.
const OPACITY_FLOOR = 0.08;

// Entrance animations need to finish before anything is measured. The workbench's reveal
// runtimes settle well inside this; it is deliberately generous because a false failure here
// would teach everyone to ignore the gate.
const SETTLE_MS = 2500;

const VIEWPORTS = [
  { w: 320, h: 720, label: "320 (small phone)" },
  { w: 375, h: 812, label: "375 (phone)" },
  { w: 414, h: 896, label: "414 (large phone)" },
  { w: 768, h: 1024, label: "768 (tablet)" },
  { w: 1280, h: 800, label: "1280x800 (13in laptop)" },
  { w: 1920, h: 1080, label: "1920 (desktop)" },
];

const FOLD = { w: 1280, h: 800 };

/* ── In-page probes ────────────────────────────────────────────────────────────────────────────
 * Everything below runs inside the browser. They are written as standalone functions with no
 * closure over module scope, because that is the only thing `page.evaluate` can serialise.
 */

/** A · every text run that occupies space, with its effective opacity and painted colours. */
function probeText() {
  const srgb = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  /* COLOUR IS NOT ALWAYS `rgb()` ANY MORE, AND ASSUMING IT WAS SUBSTITUTED BLACK.
   *
   * This used to be a regex for `rgba?(...)` and nothing else, with the caller
   * doing `parse(cs.color) ?? { r: 0, g: 0, b: 0, a: 1 }`. So any colour the
   * regex did not recognise silently became BLACK — not an error, not a skip, a
   * confident wrong answer that then flowed into a contrast ratio.
   *
   * Tailwind v4 emits modern colour syntax. `text-white/70` computes to
   * `oklab(0.999994 0.0000455677 0.0000200868 / 0.7)`, which is white at 70%
   * and was being measured as pure black. On parserail.kynth.studio/endpoints
   * that produced 106 findings at 1.06:1 and 1.11:1 — on a page that is white
   * text on near-black and completely legible in a screenshot. Every finding on
   * every Tailwind-v4 surface in this estate was affected, and the ratios were
   * plausible enough (a real black-on-black number looks just like this) that
   * they read as the very bug this gate was built to catch.
   *
   * The fix is to stop parsing colour and start ASKING THE BROWSER, which is
   * this gate's whole philosophy applied to the one place it had not been. A
   * 1x1 canvas resolves any syntax the browser can paint — hex, named,
   * `rgb()`, `hsl()`, `oklab()`, `oklch()`, `lab()`, `lch()`, `color()`,
   * `color-mix()`, and whatever ships next — because it is the same code path
   * that paints the page. Nothing here needs updating when CSS Color 5 lands.
   *
   * `getImageData` returns UNPREMULTIPLIED bytes, so alpha survives the trip
   * intact and a 70% white comes back as (255, 255, 255, 0.7). */
  let _cc = null;
  const _ccCache = new Map();
  const parse = (s) => {
    const str = String(s);
    if (!str || str === "none") return null;
    if (_ccCache.has(str)) return _ccCache.get(str);

    let out = null;

    // The fast path stays: most of the estate still computes to rgb(), and a
    // regex is cheaper than a canvas readback per text run.
    const m = str.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      if (p.length >= 3 && p.every((n) => Number.isFinite(n))) {
        out = { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      }
    }

    if (!out) {
      try {
        if (!_cc) {
          const cv = document.createElement("canvas");
          cv.width = 1;
          cv.height = 1;
          _cc = cv.getContext("2d", { willReadFrequently: true });
        }
        if (_cc) {
          /* An invalid value leaves `fillStyle` at its previous setting, so a
           * string the browser cannot read would silently hand back whatever
           * colour was asked about LAST — a neighbour's colour, reported with
           * total confidence. That is the same shape of bug as the black
           * fallback this whole function exists to remove, so it is worth
           * closing properly rather than with a guess.
           *
           * Two sentinels settle it with no pattern-matching at all: assign
           * against black, then against white. A valid colour lands on the
           * same result both times; an invalid one is left holding whichever
           * sentinel preceded it, and the two disagree. */
          _cc.fillStyle = "#000000";
          _cc.fillStyle = str;
          const asBlack = _cc.fillStyle;
          _cc.fillStyle = "#ffffff";
          _cc.fillStyle = str;
          const asWhite = _cc.fillStyle;
          if (asBlack === asWhite) {
            _cc.clearRect(0, 0, 1, 1);
            _cc.fillRect(0, 0, 1, 1);
            const d = _cc.getImageData(0, 0, 1, 1).data;
            out = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
          }
        }
      } catch {
        out = null;
      }
    }

    _ccCache.set(str, out);
    return out;
  };
  // src over dst, both opaque-ish; returns an opaque triple.
  const over = (src, dst) => [
    src.r * src.a + dst[0] * (1 - src.a),
    src.g * src.a + dst[1] * (1 - src.a),
    src.b * src.a + dst[2] * (1 - src.a),
  ];

  /* THE FLATTENED TREE, NOT THE DOM TREE.
   *
   * Tearline's receipt is a web component. `<tear-line>` holds a shadow root whose `.paper` div
   * is the near-white surface, and the receipt's own `<h1>`, `<td>`, `<small>` and `<strong>` are
   * LIGHT-DOM children slotted into it. `parentElement` on a slotted node walks straight past the
   * shadow tree to the custom element's own parent — so the background walk composited near-black
   * ink against the page's near-black panel and reported TWELVE findings at 1.19:1 on text that
   * measures about 13:1 where it is actually painted.
   *
   * That is the hero-plate bug one layer further in: the surface a reader sees behind the text is
   * not on the ancestor chain the gate was walking. The flattened tree is the one the browser
   * paints — a slotted node's parent is its `assignedSlot`, and a shadow root's is its `host`. */
  const flatParent = (n) => {
    if (n.assignedSlot) return n.assignedSlot;
    const p = n.parentNode;
    // 11 is DOCUMENT_FRAGMENT_NODE; a ShadowRoot is the only one with a `host`.
    if (p && p.nodeType === 11 && p.host) return p.host;
    return n.parentElement;
  };

  const label = (el) => {
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className.trim()
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
      : "";
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };

  /** Direct text of an element — not its descendants'. Keeps containers out of the results. */
  const ownText = (el) => {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.replace(/\s+/g, " ").trim();
  };

  const out = [];
  const all = document.body ? document.body.querySelectorAll("*") : [];

  for (const el of all) {
    const text = ownText(el);
    if (!text) continue;

    // NOT skipped — recorded. Text painted below the legibility floor is either decoration or a
    // bug, and the gate cannot tell which by looking. So it does not guess: it requires the
    // author to have said. `aria-hidden="true"` is that declaration, and it is the same
    // declaration a screen reader needs, so this asks for nothing extra.
    const decorative = !!el.closest("[aria-hidden='true']");

    /* AN INACTIVE CONTROL HAS NO CONTRAST REQUIREMENT — WCAG 1.4.3 says so outright, and the
     * whole point of a disabled control is that it reads as unavailable.
     *
     * BreachProbe's "Buy the full report" is a real `<button disabled>` sitting at the register's
     * 0.5 disabled opacity. Composited, #121212 on its #95c2ff accent measures 3.02:1 against a
     * true 10.2:1 — so the gate reported the disabled STYLING as a defect. Two of the estate's
     * last four contrast findings were this and nothing else.
     *
     * Worth recording how this was nearly missed: the first diagnosis blamed a reveal runtime
     * holding the button mid-fade, and a fix for that shipped before anyone checked whether the
     * element was simply disabled. It was. `disabled: true`, on the first probe that asked. */
    const inactive = !!el.closest("[disabled],[aria-disabled='true']");

    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;

    /* A CLOSED <details> IS LAID OUT AND NEVER PAINTED, and the two checks above cannot see it.
     * Neither can `getBoundingClientRect`, which is where this bit everyone.
     *
     * Chrome puts `content-visibility: hidden` on `::details-content` rather than `display: none`
     * — deliberately, so the disclosure can be animated open. The consequence is that the subtree
     * keeps a box: measured 2026-08-06 on parserail.kynth.studio, the closed phone-nav sheet
     * reported 40x379 at x=321 and every link inside it 4px wide, so "Get your key" measured as
     * three wrapped lines. Twenty-four WRAP findings across four viewports, on a control the
     * reader cannot see and cannot click until they open the menu.
     *
     * `checkVisibility()` is the one API that answers the actual question. It accounts for
     * `display: none` ANYWHERE up the chain (the element's own computed style does not),
     * `visibility`, and `content-visibility` subtree skipping.
     *
     * `opacityProperty` is left at its default of false ON PURPOSE. Opacity is precisely what
     * this gate exists to catch — StoreReady's h1 at 0.001 — so it must stay the gate's own
     * measurement and never be delegated to a boolean that would silently skip it. */
    if (!el.checkVisibility({ visibilityProperty: true })) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;

    /* THE VISUALLY-HIDDEN IDIOM IS NOT A HIDDEN HEADLINE.
     *
     * `position:absolute; width:1px; height:1px; clip:rect(0 0 0 0)` is how a heading is handed to
     * a screen reader on a page whose visible top heading is not semantic. Frontwire's
     * `SrHeading` and Agentwire's `.aw-sr-only` both do exactly that, and both were reported as
     * contrast failures ON AN H1 — the one finding this gate is built never to let anyone wave
     * away.
     *
     * "A heading is never decoration" is right and this is not a counterexample. StoreReady
     * shipped a FULL-SIZE h1 at opacity 0.001: 42px tall, in the layout, occupying the hero, and a
     * reader saw an empty page. This is a 1x1 box with its paint area clipped to nothing. Those
     * are two different observations, and the gate can tell them apart by measuring rather than by
     * being told: a box no larger than 4px in BOTH axes, with a clip that removes what little is
     * left, was never going to be read by an eye, and its ratio against anything behind it is a
     * number about nothing.
     *
     * Deliberately not an escape hatch. Shrinking a real headline to 1px to get past this makes it
     * genuinely invisible — and check E, headline above the fold at 1280x800, is what fails then.
     * The cost of being wrong here is bounded; the cost of the false finding is that an h1 failure
     * stops meaning anything. */
    const assistiveOnly =
      rect.width <= 4 &&
      rect.height <= 4 &&
      (cs.clipPath !== "none" || (cs.clip && cs.clip !== "auto"));
    if (assistiveOnly) continue;

    /* IS ANYTHING PAINTED ON TOP OF IT? — the third way this gate's model of the page can be
     * wrong, and the sibling of the blend case below.
     *
     * Both the computed walk and the pixel arbiter assume the text is the topmost thing in its
     * own box. An overlay breaks that assumption in the two directions that matter: the arbiter
     * samples the OVERLAY's pixels and can clear a genuine failure, and a text run the reader
     * cannot see at all gets judged as though they were reading it.
     *
     * MEASURED, 2026-08-06, kynth.studio: the apex opens behind a full-viewport `.cover-root`
     * index strip on a white plate, which folds away on a drag or a click. `hero-contrast.mjs`
     * sampled the top band with the cover still up and reported 41 failures — every white hero
     * run at 1.12:1, "Zero to One", "Kynth Studios", the whole nav — none of them real. It was
     * measuring white ink against the white sheet lying on top of it.
     *
     * `elementFromPoint` at the run's own centre is the cheap, exact answer: whatever the
     * compositor would hand a click is what the reader is looking at. Related by containment in
     * either direction is fine — a descendant span or an ancestor's padding is still this text. */
    const cx = Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
    const cy = Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
    const onTop = document.elementFromPoint(cx, cy);
    const occluded = !!onTop && onTop !== el && !onTop.contains(el) && !el.contains(onTop);
    const occluder = occluded ? label(onTop) : null;

    // EFFECTIVE opacity — the whole chain multiplied. An ancestor at 0.001 makes this element
    // invisible no matter what its own `opacity` says, and that is exactly the failure mode.
    let opacity = 1;
    let clipped = false;
    for (let n = el; n && n !== document.documentElement; n = flatParent(n)) {
      const s = getComputedStyle(n);

      /* THE SAME `display: contents` RULE AS THE BACKGROUND WALK BELOW, and it is here because
       * §8 of the house standard is that this estate's recurring defect is a fix applied to one
       * branch and not its sibling — four times in one week. These are the two ancestor walks in
       * this file and they had the identical blind spot.
       *
       * `opacity` and `transform` both require a box to apply to, and a `display: contents`
       * element generates none, so both are inert on it — folding them in would invent a
       * suppression the browser never performed.
       *
       * `visibility` is the exception and is deliberately still read: it INHERITS, so a hidden
       * `display: contents` ancestor really does hide its descendants, box or no box. */
      if (s.display === "contents") {
        if (s.visibility === "hidden") clipped = true;
        continue;
      }

      opacity *= parseFloat(s.opacity);
      if (s.visibility === "hidden") clipped = true;
      /* A transform that collapses the box paints nothing either.
       *
       * ⛔ THE TEST IS A SINGULAR MATRIX, NOT A ZERO SCALE TERM, and the difference is a whole
       * design device. This read `|a| < 0.01 || |d| < 0.01`, which is true of `scaleX(0)` — and
       * equally true of `rotate(90deg)`, whose matrix is (0, 1, -1, 0). A quarter-turn sets both
       * `a` and `d` to zero while painting every pixel it always did.
       *
       * PartsProof found it on 2026-08-06: three vertical labels on its horizontal accordion —
       * "Sept 11, 2026", "Retroactive", "€15M / 2.5%", the three facts the section sells —
       * reported as "collapsed by a transform. A heading is never decoration." All three were on
       * screen and perfectly legible, and no edit to that product could have satisfied the check
       * short of unrotating a deliberate piece of design.
       *
       * What actually collapses paint is a linear part with no area: determinant zero. That is
       * exactly `scaleX(0)`, `scaleY(0)`, `scale(0)` and any degenerate matrix, and it is
       * exactly NOT a rotation, a skew, a flip or a translation. */
      const m = new DOMMatrixReadOnly(s.transform === "none" ? "" : s.transform);
      if (Math.abs(m.a * m.d - m.b * m.c) < 1e-4) clipped = true;
    }

    // Effective background — walk up, compositing every layer, until something opaque.
    //
    // GRADIENTS ARE A FILL, NOT AN IMAGE. The first version of this gate treated any
    // `background-image` as unknowable and fell through to the page surface, so the estate's
    // primary button — near-black label on a light linear-gradient — measured 1.29:1 against
    // #121212 and reported as a contrast failure. It is about 12:1 and correct. Gradient stops
    // are literal colours in the computed value, so they are averaged and composited like any
    // other fill. Only `url()` is genuinely unknowable, and that alone sets photoBacked.
    /* TEXT PAINTED BY AN ARIA-HIDDEN TWIN.
     *
     * Tearline's markup editor is the standard highlighted-textarea shape: a tokenised
     * `<pre aria-hidden="true">` paints the glyphs, and a transparent-ink `<textarea>` lies
     * exactly on top of it holding the caret, the selection and the value. Both layers agree on
     * font, size, line-height, padding and tab size to the pixel — that agreement is what keeps
     * the caret on the glyphs, and it is why the two boxes coincide.
     *
     * The textarea's own painted contrast is 1:1, and that is the design rather than a defect: the
     * reader is looking at the `<pre>`. But the `<pre>` is `aria-hidden`, so the gate skipped it as
     * decoration and failed the textarea. Between the two of them the layer that is actually
     * painting was never measured at all.
     *
     * So the twin is DETECTED, never declared. An escape-hatch attribute would be available to a
     * real bug too, and the whole reason `aria-hidden` is the decoration signal is that it costs
     * the author something true. The observable fact here is the pairing: an aria-hidden element
     * inside the same container, whose box coincides with this one, holding the same text. When
     * one is found the contrast that matters is ITS contrast, so that is what gets measured and
     * reported under this element's name. If the twin is illegible too, the finding still fires —
     * on the layer doing the painting. */
    let painter = el;
    const ownFg = parse(cs.color);
    if (ownFg && ownFg.a < 0.05 && el.parentElement) {
      const mine = (el.value ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
      const area = rect.width * rect.height;
      for (const cand of el.parentElement.querySelectorAll("[aria-hidden='true']")) {
        if (cand === el || cand.contains(el)) continue;
        if ((cand.textContent || "").replace(/\s+/g, " ").trim() !== mine) continue;
        const cr = cand.getBoundingClientRect();
        const ov =
          Math.max(0, Math.min(rect.right, cr.right) - Math.max(rect.left, cr.left)) *
          Math.max(0, Math.min(rect.bottom, cr.bottom) - Math.max(rect.top, cr.top));
        if (ov > 0.5 * Math.min(area, cr.width * cr.height)) { painter = cand; break; }
      }
    }
    const paintCs = painter === el ? cs : getComputedStyle(painter);

    let bg = [255, 255, 255];
    const stack = [];
    let photoBacked = false;

    /* A BLEND OR A COLOUR FILTER MEANS THE DECLARED INK IS NOT THE PAINTED INK.
     *
     * The walk below composites `background-color` over `background-color` with source-over,
     * which is what the compositor does — right up until an ancestor asks for a different blend
     * equation or a filter. Then `color` stops predicting the pixel at all, and the pixel arbiter
     * further down cannot rescue it either: the arbiter only re-measures the BACKGROUND, while
     * the foreground still comes from `color` — and under `difference` the foreground is the one
     * that got inverted.
     *
     * MEASURED, 2026-08-06, kynth.studio: the cover's `<nav>` carries `mix-blend-mode:
     * difference` — a good decision, it keeps one nav legible over both the white plate and the
     * dark cards that scroll under it. Its links are `color: #fff` over a `#fff` page, so the
     * walk scored all seven at 1:1, white on white, the most alarming number this gate can
     * print. Rendered, they are BLACK. Forcing the ink red rendered them cyan, which is
     * `difference` and nothing else.
     *
     * So: the same treatment a photograph and a gradient already get — still composited, so the
     * number is the best available, but demoted to a warning that says the model does not apply.
     * A failure the gate cannot stand behind is worse than a warning.
     *
     * Walked to the ROOT, separately, because the background walk stops at the first opaque
     * layer and a blend applied above that layer still changes the composite. */
    let blended = false;
    for (let n = painter; n; n = flatParent(n)) {
      const s = getComputedStyle(n);
      if (s.mixBlendMode !== "normal" || (s.filter && s.filter !== "none")) { blended = true; break; }
    }

    for (let n = painter; n; n = flatParent(n)) {
      const s = getComputedStyle(n);

      /* A `display: contents` ELEMENT PAINTS NOTHING. It generates no box at all — its children
       * are promoted to its parent's formatting context — so its `background-color` is a declared
       * value that never reaches a pixel. `getComputedStyle` reports it regardless, because
       * "computed" is a cascade term, not a paint term.
       *
       * Measured 2026-08-06 on parserail.kynth.studio: ONE element, the vendored capture's page
       * root, `display: contents` with `background: rgb(255,255,255)` inherited from the
       * template's light-mode default. The walk stopped there and scored every heading on the
       * page as white-on-white and every body run as grey-on-white — 66 of that host's 93
       * findings, from a single declaration on a zero-size box, on a page that renders correctly
       * dark in a screenshot.
       *
       * This is the same class as the hero plate being a SIBLING: the gate's model of the page
       * disagreed with the page, and the finding was impossible rather than merely surprising.
       * `visibility: hidden` is deliberately NOT skipped here — that element still generates a
       * box and still paints its background; only its own content is invisible. */
      if (s.display === "contents") continue;

      const img = s.backgroundImage;
      let opaqueHere = false;

      if (img && img !== "none") {
        if (/\burl\(/.test(img)) {
          photoBacked = true;
        } else {
          /* A GRADIENT'S AVERAGE IS NOT THE COLOUR UNDER THE TEXT.
           *
           * Averaging its stops is the only thing a static walk can do, and it is right often
           * enough to be worth doing — it is what stops the estate's primary button, dark text on
           * a light gradient, being scored against the page behind it. But it is an estimate.
           * ListRun's stat note sits over the accent glow plate: the averaged stops came out
           * 48,45,43 where the pixels under that line are nearly #0a0a0a, so #8a8a8a scored 3.98
           * against a true 5.74 and reported as a failure.
           *
           * So a gradient is now treated the way a photograph is: still composited, so the number
           * is the best available, but demoted to a warning. The gate says what it measured and
           * admits it cannot know. A failure it cannot stand behind is worse than a warning. */
          photoBacked = true;
          /* The stop extractor matches the modern colour functions too, for the
           * same reason `parse` does: a Tailwind v4 gradient's stops compute to
           * `oklab(...)`, and an rgb-only regex found none of them, so `stops`
           * came back empty and the gradient contributed NOTHING to the
           * composite. The sibling branch of the oklab fix above — §8 of the
           * house standard is that the sibling is the one that gets missed.
           * Non-nested by design: `color-mix()` can contain another colour and
           * `[^()]*` would truncate it, so it is left to fall through to the
           * photoBacked warning rather than be averaged wrong. */
          const stops = (
            img.match(/(?:rgba?|hsla?|hwb|oklab|oklch|lab|lch|color)\([^()]*\)/g) || []
          )
            .map(parse)
            .filter(Boolean);
          if (stops.length) {
            const avg = stops.reduce(
              (acc, c) => ({ r: acc.r + c.r, g: acc.g + c.g, b: acc.b + c.b, a: acc.a + c.a }),
              { r: 0, g: 0, b: 0, a: 0 },
            );
            const layer = {
              r: avg.r / stops.length, g: avg.g / stops.length,
              b: avg.b / stops.length, a: avg.a / stops.length,
            };
            stack.push(layer);
            if (layer.a >= 0.999) opaqueHere = true;
          }
        }
      }

      const c = parse(s.backgroundColor);
      if (c && c.a > 0) {
        stack.push(c);
        if (c.a >= 0.999) opaqueHere = true;
      }
      if (opaqueHere) break;
    }
    const imageBacked = photoBacked;
    for (let i = stack.length - 1; i >= 0; i--) bg = over(stack[i], bg);

    const fg = parse(paintCs.color) ?? { r: 0, g: 0, b: 0, a: 1 };
    const fgOver = over({ ...fg, a: fg.a * opacity }, bg);

    const L1 = lum(fgOver);
    const L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);

    const size = parseFloat(paintCs.fontSize);
    const weight = parseInt(paintCs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);

    /* THE CONTENT BOX, IN VIEWPORT COORDINATES — what the pixel arbiter samples.
     *
     * Inset by border and padding for the same reason `hero-contrast.mjs` does it: on a small
     * element a 1px ring is better than a tenth of its area, so the 10th percentile lands on the
     * frame rather than behind a letter. The glyphs live in the content box. */
    const inset = (a, b) => (parseFloat(cs[a]) || 0) + (parseFloat(cs[b]) || 0);
    const il = inset("borderLeftWidth", "paddingLeft");
    const ir = inset("borderRightWidth", "paddingRight");
    const it = inset("borderTopWidth", "paddingTop");
    const ib = inset("borderBottomWidth", "paddingBottom");

    out.push({
      sel: label(el),
      text: text.slice(0, 70),
      opacity: Math.round(opacity * 1000) / 1000,
      clipped,
      decorative,
      inactive,
      heading: /^H[1-6]$/.test(el.tagName),
      ratio: Math.round(ratio * 100) / 100,
      need: large ? 3 : 4.5,
      large,
      imageBacked,
      blended,
      occluded,
      occluder,
      inFold: rect.top < innerHeight && rect.bottom > 0,
      top: Math.round(rect.top + scrollY),
      fontFamily: cs.fontFamily,
      // The composited foreground, so the arbiter compares the colour actually painted rather
      // than the declared one — a 60%-alpha label over its backdrop is not its `color`.
      fg: [Math.round(fgOver[0]), Math.round(fgOver[1]), Math.round(fgOver[2])],
      box: {
        x: Math.round(rect.left + il),
        y: Math.round(rect.top + it),
        w: Math.round(rect.width - il - ir),
        h: Math.round(rect.height - it - ib),
      },
    });
  }
  return out;
}

/** C · horizontal overflow, plus the widest offenders so the report can name them. */
function probeOverflow() {
  const doc = document.scrollingElement || document.documentElement;
  const overflow = doc.scrollWidth - doc.clientWidth;
  const offenders = [];
  if (overflow > 1) {
    for (const el of document.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const past = Math.round(r.right + scrollX - doc.clientWidth);
      if (past > 1) {
        const cls = typeof el.className === "string" && el.className.trim()
          ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
          : "";
        offenders.push({ sel: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls}`, past });
      }
    }
    offenders.sort((a, b) => b.past - a.past);
  }
  return { overflow: Math.max(0, overflow), offenders: offenders.slice(0, 6) };
}

/* ── H · TWO PRIMARIES ────────────────────────────────────────────────────────────────────────
 *
 * More than one accent-filled control on screen at once means neither is primary.
 *
 * `apex-one-primary-cta` has sat pending in intent.json as an apex-only item, and the condition
 * is estate-wide: these landings arrived as template ports and inherited the template's CTA
 * density, which was designed for a different funnel. A sticky bar plus its in-flow twin plus a
 * nav button is three "the one thing to do next" on one screen.
 *
 * ⛔ IT COUNTS WHAT IS ON SCREEN, NOT WHAT IS ON THE PAGE. A landing with six primaries down its
 * length is fine — the reader meets one at a time, which is the whole design. What is a failure
 * is two in the same viewport, so this measures per scroll stop like the rest of the gate.
 *
 * "Accent-filled" is read from the PAINT, not from a class name: a control whose background
 * resolves to the product's own --rs-accent. A product that names its primary something else
 * still gets measured, and a `.rs-btn` that has been overridden to a ghost correctly does not. */
function probePrimaries() {
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--rs-accent").trim();
  if (!accent) return [];

  /* Compare in rgb(), because the token is authored as a hex and the computed background is not.
   * Comparing the strings directly finds nothing and reports a clean page forever — the silent
   * kind of broken check this gate has already shipped twice. */
  const probe = document.createElement("span");
  probe.style.color = accent;
  document.body.appendChild(probe);
  const accentRgb = getComputedStyle(probe).color;
  probe.remove();

  const vh = window.innerHeight;
  const hits = [];
  for (const el of document.querySelectorAll("a, button, [role=button], input[type=submit]")) {
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh) continue;          // not on this screen
    if (r.width < 8 || r.height < 8) continue;
    if (!el.checkVisibility({ visibilityProperty: true })) continue;
    if (el.closest("[aria-hidden='true']")) continue;

    /* ⛔ A SELECTED FILTER CHIP IS NOT A CALL TO ACTION, and it is accent-filled on purpose.
     *
     * The first sweep reported SkillWorks and StackTab — five accent chips in one rail on
     * StackTab, which is a reader who has picked five filters and the rail correctly showing it.
     * Counting those as competing primaries would have made this check fire on the two products
     * using the filter rail hardest.
     *
     * ⚠️ EXCLUDED ON THE DECLARATION, NOT THE CLASS NAME. `.rs-chip--on` is the class those
     * happen to carry, and keying on it would break the moment a product names its own; every
     * one of them also carries `aria-pressed="true"`, which is the control SAYING it is a toggle
     * in its on state rather than an action to take. Same rule the CLIPPED exemptions run under:
     * what the author declared, never what the gate inferred from a name. */
    if (el.getAttribute("aria-pressed") === "true") continue;
    if (el.getAttribute("aria-selected") === "true") continue;
    if (el.getAttribute("aria-current") && el.getAttribute("aria-current") !== "false") continue;

    if (getComputedStyle(el).backgroundColor !== accentRgb) continue;
    const cls = typeof el.className === "string" && el.className.trim()
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
      : "";
    hits.push({
      sel: `${el.tagName.toLowerCase()}${cls}`,
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
    });
  }
  return hits;
}

/* ── F · UNREACHABLE OVERFLOW ─────────────────────────────────────────────────────────────────
 *
 * Content clipped by its own scroll container, in the one direction no scrollbar can undo.
 *
 * WHY THIS IS A CHECK AND NOT A CURIOSITY. `overflow: auto` on a flex column with
 * `justify-content: center` looks like the obvious way to centre a panel inside a fixed box, and
 * it behaves perfectly right up until the content is taller than the box. Then the centring
 * pushes the overflowing START out through the TOP — and unlike the bottom, there is no scroll
 * position that brings it back. `scrollTop` is already 0. The content is in the DOM, painted, at
 * full opacity, correct colour, and permanently unreachable.
 *
 * MEASURED TWICE IN ONE DAY, 2026-08-07, both times by a human opening the page rather than by any
 * gate: QuorumFile's deliverable preview turned into a pinned strip that ate 400px of a sheet and
 * truncated the timeline behind it, and GoodStanding's free diagnostic needed 426px in a 302px
 * card and served its first two rows sliced in half at the top border. Every other check in this
 * file passed on both — the text was legible, contrast fine, opacity 1, nothing wrapped. This is
 * the StoreReady lesson in a new costume: the page renders, and a reader cannot see it.
 *
 * ⚠️ ONLY THE UNREACHABLE DIRECTION IS A FAILURE. A results panel that scrolls is not a bug — it
 * is a results panel. What is reported is content pushed past the start edge, which the reader
 * cannot scroll to by any means. `justify-content: center | flex-end | end` on a column, or the
 * same on `align-items` for a row, is the whole condition; `flex-start` overflows downward where
 * the scrollbar works and is left alone.
 *
 * The fix is never `overflow: hidden`. It is `margin: auto` on the CHILD, which centres while the
 * content fits and collapses to zero when it does not. */
function probeClipped() {
  /* ⛔ THE FIRST VERSION OF THIS CHECK TESTED FOR A CONSTRUCTION AND MISSED THE BUG.
   *
   * It looked for `overflow: auto|scroll` plus `justify-content: center`, because that is the
   * shape the two known cases happened to have. A screenshot then arrived of another product's
   * footer cutting "After 15 months" in half — and of a pricing card cutting
   * "+ dated cure checklist" — and the gate had passed the page. Both boxes are
   * `overflow: hidden` on a fixed height, which is STRICTLY WORSE than the case it did catch:
   * there is not even a scrollbar to hint that something is missing.
   *
   * So it no longer asks how a box is built. It asks the only question a reader can answer:
   * IS TEXT BEING CUT BY A BOX ABOVE IT. Three constructions produce that and all three are
   * now caught — `hidden`, `clip`, and a scroll container clipped at its unreachable edge.
   *
   * TWO EXEMPTIONS, both of them things the author has DECLARED rather than things inferred:
   *   · `aria-hidden="true"` — the hover-swap's second label is parked outside its clip on
   *     purpose, and it says so. Nine of these on GoodStanding alone; without the exemption the
   *     check drowns in its own correct-by-design findings.
   *   · `overflow: visible` — nothing is cut, the content simply paints outside the box.
   *
   * For a scroll container only the START edge counts: content below the bottom of an
   * `overflow: auto` panel is a scroll away, which is a panel working. Content above the top is
   * unreachable, because `scrollTop` is already 0. */
  const out = [];
  const CLIPS = /^(hidden|clip|auto|scroll)$/;

  for (const el of document.body.querySelectorAll("*")) {
    let text = "";
    for (const n of el.childNodes) if (n.nodeType === 3) text += n.nodeValue;
    text = text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (el.closest("[aria-hidden='true']")) continue;

    /* ⛔ A CLOSED ACCORDION IS NOT CLIPPED CONTENT — it is a closed accordion.
     *
     * Third exemption, and the same principle as the two above: what the author DECLARED, not
     * what the gate inferred. A collapsed disclosure is content deliberately held back with a
     * control that brings it back, which is the exact opposite of unreachable.
     *
     * HeldBack's FAQ reported one finding — `div.faq-mobile-closed.nav-link-home`, "text cut by
     * 199px" — and the panel was doing precisely what a closed panel does: zero height, overflow
     * hidden, and `aria-expanded="false"` on the control right above it saying so. The class name
     * says `closed` in as many words.
     *
     * ⚠️ IT MUST BE DECLARED, and `aria-expanded` is the declaration. Guessing from the class
     * name would be the same mistake as reading `transition-property` without the duration — the
     * name is a hint, not a fact, and a check built on naming conventions breaks the moment a
     * template is exported with generated class names. `details:not([open])` is the native form
     * of the same statement and gets the same treatment.
     *
     * The reverse case stays a failure and that is the point of scoping it this tightly:
     * FetchDue's banner holds 188px of text in a 40.7px `overflow: clip` box with no
     * `aria-expanded` anywhere, so nothing on that page says the text is meant to be held back. */

    /* Declared here rather than below the exemptions that read it — a temporal-dead-zone error
     * `node --check` cannot see, because it is legal syntax and only throws when the line runs. */
    const cs = getComputedStyle(el);

    /* ⛔ AND `-webkit-line-clamp` IS A TRUNCATION SOMEBODY ASKED FOR. Fourth exemption, same
     * family: the author declared it, and unlike every case this check exists to catch, the
     * READER IS TOLD — line-clamp paints an ellipsis. FetchDue's launch banner is clamped to two
     * lines and reported as "text cut by 40px"; it is a designed two-line summary with a "…" on
     * the end, not 147px of copy nobody can reach.
     *
     * Whether a clamped banner is good COPY is a real question and it is not this gate's: the
     * gate asks whether the page is hiding something from the reader without saying so, and an
     * ellipsis is saying so. `text-overflow: ellipsis` is the single-line form of the same
     * statement and is exempted with it. */
    if (cs.webkitLineClamp && cs.webkitLineClamp !== "none") continue;
    if (cs.textOverflow === "ellipsis") continue;

    if (el.closest("details:not([open])")) continue;
    const collapsed = (() => {
      for (let a = el; a && a !== document.body; a = a.parentElement) {
        if (a.getAttribute?.("aria-expanded") === "false") return true;
        // The control usually sits beside the panel rather than around it.
        const sib = a.parentElement?.querySelector?.(":scope > [aria-expanded]");
        if (sib && sib.getAttribute("aria-expanded") === "false") return true;
      }
      return false;
    })();
    if (collapsed) continue;

    if (cs.display === "none" || cs.visibility === "hidden") continue;

    /* ⚠️ THE ELEMENT'S OWN COMPUTED STYLE DOES NOT KNOW ITS ANCESTORS ARE HIDDEN, and these
     * templates render the SAME section once per breakpoint with two of the three switched off.
     * QuorumFile's "$499" reported as cut 36px by `#pricing` at every scroll position, with no
     * sticky and no transform anywhere in the chain — because the copy being measured was the
     * phone variant, laid out inside a container that is `display: none` at 1280. The price a
     * visitor sees is fine, and the gate was accusing a card nobody can look at.
     *
     * `checkVisibility()` is the one API that answers the real question: it accounts for
     * `display: none` ANYWHERE up the chain, plus `visibility` and `content-visibility` subtree
     * skipping. probeText and probeWrap both already guard with it; this one did not, which is
     * §8's shape again — the sibling that got missed. */
    if (!el.checkVisibility({ visibilityProperty: true })) continue;

    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;

    /* ⛔ A TEXT BOX IS TALLER THAN ITS GLYPHS, AND CLIPPING THE DIFFERENCE IS NORMAL.
     *
     * `getBoundingClientRect()` on a text element returns the LINE BOX — font size plus the
     * half-leading above and below it. A logo lockup that crops a 78px line box to 30px is not
     * hiding anything: the leading is empty space, and cropping it is how a wordmark gets set
     * tight to its cap height. CoverCheck's header and footer marks are exactly that, and they
     * measured as 24px and 27px "cut" while every letter is on screen.
     *
     * So the overflow has to exceed the half-leading before it can be touching a glyph. Below
     * that it is whitespace, and reporting whitespace as lost content is how a gate earns the
     * reputation that makes people stop reading it. */
    const fontPx = parseFloat(cs.fontSize) || 16;
    const linePx = cs.lineHeight === "normal" ? fontPx * 1.2 : parseFloat(cs.lineHeight) || fontPx * 1.2;
    const leading = Math.max(2, (linePx - fontPx) / 2 + fontPx * 0.12);

    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const acs = getComputedStyle(a);
      const oy = acs.overflowY;
      const ox = acs.overflowX;
      if (!CLIPS.test(oy) && !CLIPS.test(ox)) continue;

      const ar = a.getBoundingClientRect();
      if (ar.width < 2 || ar.height < 2) continue;

      /* ⛔ THE DECLARED-TRUNCATION EXEMPTIONS BELONG HERE TOO, AND HERE IS WHERE THEY MATTER.
       *
       * They were first written against the TEXT element and did nothing, because the element
       * that declares the clamp is the one doing the CLIPPING — the ancestor — and the element
       * carrying the text is its child. FetchDue kept reporting after the exemption "landed":
       * all four `div.framer-1qrg0fm` carry `-webkit-line-clamp: 2` and every one of them has an
       * empty own-text, which is the tell. The check on `el` could never have fired.
       *
       * Same reasoning as on the text element: a clamp paints an ellipsis, so the reader is TOLD.
       * The gate asks whether the page hides something without saying so. */
      if (acs.webkitLineClamp && acs.webkitLineClamp !== "none") break;
      if (acs.textOverflow === "ellipsis") break;

      // A scroll container can only trap what is past its START edge.
      const scrolls = /^(auto|scroll)$/;
      const cutBottom = CLIPS.test(oy) && !scrolls.test(oy) && r.bottom - ar.bottom > leading;
      const cutTop = CLIPS.test(oy) && ar.top - r.top > leading;
      const cutRight = CLIPS.test(ox) && !scrolls.test(ox) && r.right - ar.right > 2;

      const cls = typeof a.className === "string" && a.className.trim()
        ? `.${a.className.trim().split(/\s+/).slice(0, 2).join(".")}`
        : "";
      out.push({
        sel: `${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ""}${cls}`,
        text: text.slice(0, 46),
        cut: cutTop || cutBottom || cutRight,
        by: Math.round(cutTop ? ar.top - r.top : cutBottom ? r.bottom - ar.bottom : cutRight ? r.right - ar.right : 0),
        edge: cutTop ? "top" : cutBottom ? "bottom" : cutRight ? "right" : "none",
        mode: cutRight ? ox : oy,
      });
      break; // the nearest clipping ancestor is the one to fix
    }
  }
  return out.slice(0, 80);
}

/* ── G · NESTED SCROLL ────────────────────────────────────────────────────────────────────────
 *
 * ⛔ THE ONLY CHECK IN THIS FILE THAT HAS TO TOUCH THE PAGE RATHER THAN READ IT.
 *
 * Lenis smooth-scroll listens for `wheel` on the document and calls `preventDefault()` on every
 * event it handles, then animates the PAGE. A wheel that started over an inner `overflow: auto`
 * box is cancelled before the browser can scroll that box. The box therefore sits at scrollTop 0
 * for ever while the page glides underneath it.
 *
 * NOTHING ABOUT THAT IS VISIBLE. The box is in the DOM, at the right size, with the right content
 * and a scrollbar. Computed styles are correct. A screenshot is correct. Every other check in
 * this file passes. The condition exists only in the response to an input, so the only way to
 * know is to send the input. Audited 2026-08-12: thirty repos, two hundred and eighty-seven dead
 * regions, twelve exemptions estate-wide, and not one gate anywhere that could see it.
 *
 * WHY THE WHEEL IS DIAGONAL. Lenis's default `gestureOrientation: "vertical"` makes it bail out
 * when `deltaY === 0`, so a perfectly horizontal wheel scrolls a horizontal box even when the
 * page is broken. Measured: pure-horizontal → scrollLeft 720 ✓, diagonal → scrollLeft 0 and the
 * page moved 240px instead. An axis-perfect probe would report those regions healthy and it
 * would be wrong about every real trackpad. So neither axis is ever driven clean.
 *
 * WHY SYNTHETIC EVENTS ARE NOT USED. `el.dispatchEvent(new WheelEvent(...))` does not scroll
 * anything in any browser — untrusted events do not drive the compositor. This uses Playwright's
 * `mouse.wheel`, which goes through CDP and is a real input event. A version of this check built
 * on `dispatchEvent` would pass every page in the estate, broken or not.
 *
 * ⛔ POSITIVE CONTROL. See `nestedControl` below. The control's two probes have outcomes that are
 * fixed no matter how Lenis is configured, so it tests the HARNESS rather than the page. If it
 * misbehaves the whole gate exits 2 — a check that can silently stop working is worse than no
 * check, and this one has a lot of ways to silently stop working (wrong coordinates, an occluding
 * overlay, a wheel that never lands, a page that navigated).
 */

/** Tag every element that genuinely scrolls, so it can be addressed from outside the page. */
function probeScrollables() {
  const out = [];
  let n = 0;
  for (const el of document.body.querySelectorAll("*")) {
    if (el.hasAttribute("data-rg-probe")) continue;
    const cs = getComputedStyle(el);
    const ox = cs.overflowX;
    const oy = cs.overflowY;
    /* ⚠️ 4px WAS TOO TIGHT, and the reason is a CSS coupling rather than a judgement call.
     * Setting `overflow-x: auto` forces `overflow-y` to `auto` as well, so every horizontal
     * table wrapper in this estate reports a small phantom VERTICAL overflow it was never meant
     * to have. QuorumFile's `.compare-band__scroll` is 1089 against 1065 — 24px — and check G
     * failed its deploy insisting that region must scroll vertically. Nobody would ever scroll
     * it; there is nothing down there.
     * 48px is about a line and a half of body copy: below that the overflow is an artefact, above
     * it there is genuinely content a reader cannot reach. The Lenis defect this check exists for
     * hides hundreds of pixels — goodstanding's lookup card had 358 unreachable — so nothing real
     * is lost by ignoring the noise. */
    const PHANTOM = 48;
    const scrollY = /^(auto|scroll|overlay)$/.test(oy) && el.scrollHeight - el.clientHeight > PHANTOM;
    const scrollX = /^(auto|scroll|overlay)$/.test(ox) && el.scrollWidth - el.clientWidth > PHANTOM;
    if (!scrollX && !scrollY) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) continue;
    const cls = typeof el.className === "string" && el.className
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
      : "";
    el.setAttribute("data-rg-scroll", String(n));
    out.push({
      id: n,
      sel: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls}`,
      axis: scrollY ? "y" : "x",
      /* An element already carrying an exemption is still driven — the attribute is a claim, and
       * this check exists precisely because claims in source were not matching the page. */
      exempt: !!el.closest("[data-lenis-prevent],[data-lenis-prevent-wheel]"),
    });
    n++;
    if (n >= 40) break;
  }
  return out;
}

/** Drive a real diagonal wheel over one tagged element and report what moved. */
async function wheelOn(page, selector, axis, notches = 6) {
  const box = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    if (cx < 2 || cy < 2 || cx > innerWidth - 2 || cy > innerHeight - 2) return { off: true };
    /* If something else is painted over the centre point the wheel lands on that instead, and a
     * "did not scroll" verdict would be about the wrong element. A DESCENDANT at the point is
     * fine — the event's composedPath still contains our node. */
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || !(el === hit || el.contains(hit))) return { occluded: true };
    return { cx, cy, top: el.scrollTop, left: el.scrollLeft, pageY: Math.round(scrollY) };
  }, selector);
  if (!box || box.off || box.occluded) return { skipped: true, why: box?.occluded ? "occluded" : "off-screen" };

  /* ⛔ LET THE SMOOTH-SCROLL RUNTIME SETTLE BEFORE TRUSTING THE RECT.
   *
   * `scrollIntoView({ behavior: "instant" })` above sets scrollTop in one jump — and then Lenis's
   * rAF loop, which lerps toward its OWN target, spends the next few hundred ms dragging the page
   * back. The coordinates measured in the same tick are therefore stale by the time the wheel is
   * dispatched, the gesture lands wherever the element has drifted to, and the element does not
   * move because the wheel never reached it.
   *
   * That produced a false NESTED failure on BreachProbe /smoke: this gate reported
   * "moved the element 0px and the page -1511px" — a page delta far larger than six 24px notches
   * can explain, which is the tell — while the same six wheel events, at the same viewport, on the
   * same live URL, driven by hand, moved `div.rs-rows-scroll` scrollLeft 0 -> 276. A gate that
   * fails a page which demonstrably works teaches everyone to ignore it.
   *
   * Waits for scrollY to hold still across two frames, then RE-READS the rect. */
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let last = -1;
      let stable = 0;
      const tick = () => {
        const y = Math.round(window.scrollY);
        stable = y === last ? stable + 1 : 0;
        last = y;
        if (stable >= 2) return resolve();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });
  const settled = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    if (cx < 2 || cy < 2 || cx > innerWidth - 2 || cy > innerHeight - 2) return { off: true };
    return { cx, cy, top: el.scrollTop, left: el.scrollLeft, pageY: Math.round(scrollY) };
  }, selector);
  if (!settled || settled.off) return { skipped: true, why: "off-screen after settle" };
  Object.assign(box, settled);

  /* ⛔ REWIND THE ELEMENT, OR A WORKING SCROLLER MEASURES AS DEAD.
   *
   * `moved` is `after − before`, and an element already sitting at its scroll END cannot move —
   * so it reports 0 and the gate calls it broken. That is not hypothetical: it failed a
   * SkillWorks deploy on 2026-08-13. Measured on the live page, same element, same six
   * dx120/dy24 notches, three times in one session:
   *
   *   probe 1, fresh          scrollLeft   0 -> 90   (moved 90, max 90)
   *   probe 2, not rewound    scrollLeft  90 -> 90   (moved  0, max 90)   <- reported as broken
   *   probe 3, after rewind   scrollLeft   0 -> 90   (moved 90, max 90)
   *
   * Anything that leaves the element scrolled reproduces it — the same node probed on both axes,
   * a selector matching a node already touched, or a page that restores a scroll position. And
   * the failure is silent and one-directional: it can only ever manufacture a false NESTED
   * finding, never hide a real one, which is the shape that gets believed.
   *
   * A gate that fails a page which demonstrably works teaches everyone to ignore it — the same
   * sentence the settle-wait above was written under, for the same check, six weeks earlier.
   * Rewound on the probed axis only, so the other axis keeps whatever state the page had. */
  await page.evaluate(
    ([s, ax]) => {
      const el = document.querySelector(s);
      if (!el) return;
      if (ax === "y") el.scrollTop = 0;
      else el.scrollLeft = 0;
    },
    [selector, axis],
  );
  /* Re-read after the rewind: `box.top`/`box.left` are the baseline `moved` subtracts. */
  const rewound = await page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? { top: el.scrollTop, left: el.scrollLeft } : null;
  }, selector);
  if (rewound) Object.assign(box, rewound);

  /* Nothing to consume: an element with no room on this axis cannot demonstrate anything, and
   * calling that a failure would be a finding about the fixture rather than the page. */
  const room = await page.evaluate(
    ([s, ax]) => {
      const el = document.querySelector(s);
      if (!el) return 0;
      return ax === "y" ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
    },
    [selector, axis],
  );
  if (room <= 1) return { skipped: true, why: "no overflow on this axis to consume" };

  await page.mouse.move(box.cx, box.cy);
  // Never axis-perfect: the minor component is what defeats Lenis's gestureOrientation escape.
  const [dx, dy] = axis === "y" ? [24, 120] : [120, 24];
  for (let i = 0; i < notches; i++) {
    await page.mouse.wheel(dx, dy);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(700);

  const after = await page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? { top: el.scrollTop, left: el.scrollLeft, pageY: Math.round(scrollY) } : null;
  }, selector);
  if (!after) return { skipped: true, why: "element left the DOM" };

  const moved = axis === "y" ? after.top - box.top : after.left - box.left;
  return { moved: Math.round(moved), pageMoved: Math.round(after.pageY - box.pageY) };
}

/** ⛔ THE POSITIVE CONTROL. Two probes whose verdicts do not depend on the page's Lenis config:
 *
 *   · `must-scroll`     — overflowing, and carries `data-lenis-prevent`. Lenis exempts it
 *                         unconditionally, and with no Lenis at all the browser scrolls it. So it
 *                         scrolls in every world. If it does NOT, the harness is broken: the
 *                         wheel is not landing, the coordinates are wrong, or the page moved.
 *   · `must-not-scroll` — `overflow: hidden` on overflowing content. No browser scrolls that by
 *                         wheel, ever. If it DOES appear to move, the measurement is reading
 *                         something that is not this element's scroll offset.
 *
 * Both have to come out right or the gate reports 2 rather than a verdict it cannot stand behind.
 */
async function nestedControl(page) {
  const gutter = await page.evaluate(() => {
    const d = document.createElement("div");
    d.setAttribute("data-rg-probe", "gutter");
    d.style.cssText = "position:fixed;top:-9999px;left:0;width:200px;height:100px;overflow-y:scroll";
    d.innerHTML = '<div style="height:400px"></div>';
    document.body.appendChild(d);
    const g = d.offsetWidth - d.clientWidth;
    d.remove();
    return g;
  });

  await page.evaluate(() => {
    const mk = (name, css) => {
      const d = document.createElement("div");
      d.setAttribute("data-rg-probe", name);
      d.style.cssText =
        `position:fixed;left:12px;width:220px;height:140px;z-index:2147483647;` +
        `background:#fff;color:#000;${css}`;
      if (name === "must-scroll") d.setAttribute("data-lenis-prevent", "");
      d.innerHTML = '<div style="height:1400px">rg</div>';
      document.body.appendChild(d);
      return d;
    };
    mk("must-scroll", "top:60px;overflow-y:auto");
    mk("must-not-scroll", "top:220px;overflow-y:hidden");
  });

  const good = await wheelOn(page, '[data-rg-probe="must-scroll"]', "y");
  const bad = await wheelOn(page, '[data-rg-probe="must-not-scroll"]', "y");
  await page.evaluate(() => document.querySelectorAll("[data-rg-probe]").forEach((n) => n.remove()));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);

  const problems = [];
  /* ⚠️ THE SCROLLBAR TRAP, AND WHY IT IS NOT A CONTROL HERE.
   *
   * Playwright passes `--hide-scrollbars` in headless, so anything that reasons about scrollbar
   * PRESENCE or WIDTH silently measures nothing — another session lost two rounds of "unchanged"
   * readings to it on 2026-08-12. The obvious response is to assert the gutter is back. That
   * assertion was written, and it failed on every page.
   *
   * MEASURED, this machine, playwright 1.61.1, an `overflow-y: scroll` box:
   *   default                                  gutter 0
   *   ignoreDefaultArgs: ['--hide-scrollbars']  gutter 0
   *   channel: 'chromium' + the same            gutter 0
   *   headless: false + the same                gutter 0
   * It is not the flag. macOS uses overlay scrollbars, so `offsetWidth - clientWidth` is 0 in
   * every configuration including a headed browser on a real desktop. A gutter assertion cannot
   * tell a hidden scrollbar from an ordinary Mac, so as a control it fails closed for ever and
   * blocks every deploy over a condition that is not a defect. That is the "worse than no gate"
   * shape, and it is why this is recorded and not enforced.
   *
   * What makes G immune to the trap anyway: it never asks whether a scrollbar exists. Its only
   * measurement is the delta in `scrollTop`/`scrollLeft` after a real wheel, which is unaffected
   * by whether the bar is painted. The arg is still removed at launch, because on a platform with
   * classic scrollbars the gutter is real and belongs in the widths. */
  if (good.skipped) problems.push(`the must-scroll probe could not be driven (${good.why})`);
  else if (!(good.moved > 0)) problems.push(`the must-scroll probe did not scroll (moved ${good.moved}px)`);
  if (bad.skipped) problems.push(`the must-not-scroll probe could not be driven (${bad.why})`);
  else if (bad.moved !== 0) problems.push(`the must-not-scroll probe reported ${bad.moved}px of movement`);
  return { ok: problems.length === 0, problems, good, bad, gutter };
}

/** G runs in its OWN browser.
 *
 * ⚠️ Not for isolation — for `--hide-scrollbars`. Playwright passes that flag by default in
 * headless, and it changes `clientWidth`/`clientHeight` by the width of a scrollbar, which is
 * exactly the quantity "does this box overflow" is measured against. G needs it off. Every other
 * check in this file was calibrated WITH it on, and their thresholds are tuned — flipping the
 * shared launch would move OVERFLOW and WRAP findings across twelve deploy paths for a reason
 * that has nothing to do with either. So G pays for one extra page load and leaves the rest alone.
 */
async function nestedScrollPass(chromium, url) {
  const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
  const findings = [];
  let broken = null;
  try {
    const ctx = await browser.newContext({ viewport: { width: FOLD.w, height: FOLD.h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    /* Its own settle, because run()'s closes over run()'s page. Same three steps, plus a step
     * down the document: a scroll-reveal runtime holds a section at opacity 0 until it has been
     * in view, and a region that has never been laid out has nothing to overflow. */
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);
    for (let i = 0; i < 8; i++) {
      await page.evaluate((k) => window.scrollTo(0, k * innerHeight), i);
      await page.waitForTimeout(200);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);

    const seen = new Set();
    for (const vp of [{ w: FOLD.w, h: FOLD.h, label: "1280x800" }, { w: 414, h: 896, label: "414 (large phone)" }]) {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await page.evaluate(() => document.fonts?.ready).catch(() => {});
      await page.waitForTimeout(400);

      const control = await nestedControl(page);
      if (!control.ok) {
        broken = control.problems.map((p) => `${p} (at ${vp.label})`);
        break;
      }

      for (const s of await page.evaluate(probeScrollables)) {
        const r = await wheelOn(page, `[data-rg-scroll="${s.id}"]`, s.axis);
        if (r.skipped || r.moved > 0) continue;
        const key = `${s.sel}|${s.axis}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ ...s, vp: vp.label, pageMoved: r.pageMoved });
      }
      await page.evaluate(() => {
        document.querySelectorAll("[data-rg-scroll]").forEach((n) => n.removeAttribute("data-rg-scroll"));
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(300);
    }
  } catch (err) {
    broken = [`the nested-scroll pass threw: ${err.message}`];
  } finally {
    await browser.close();
  }
  return { findings, broken };
}

/** D · clickable text on two lines. getClientRects() gives one rect per line box.
 *
 * SCOPE. Only AFFORDANCES — the top nav, and anything that paints as a button. A footer
 * directory of article titles legitimately wraps at 320px and always will; flagging it produced
 * 75 findings on the first run and no useful one among them. The rule is about elements a
 * visitor reads as a control, where a second line reads as a styling bug. */
function probeWrap() {
  const sels = [
    "header nav a", "nav a", "[role='navigation'] a",
    "button", "[role='button']",
    "a[class*='cta' i]", "a[class*='btn' i]", "a[class*='button' i]",
  ];
  const seen = new Set();
  const bad = [];
  for (const sel of sels) {
    for (const el of document.querySelectorAll(sel)) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (el.closest("footer")) continue; // directory lists, not controls
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      // The closed-<details> case, same as probeText — a disclosure's contents keep a box after
      // Chrome stops painting them, and a 4px-wide nav link inside one reads as wrapped text.
      // This is the sibling branch of that fix; §8 of the house standard is that the sibling is
      // the one that gets missed.
      if (!el.checkVisibility({ visibilityProperty: true })) continue;
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      // A label this long is a content problem, not a layout one — and at 320px it has to wrap.
      if (!text || text.length > 28) continue;
      // Measure the TEXT NODES, not the element box.
      //
      // A range over `selectNodeContents` returns a rect for every inline child too — and the
      // shared Lockup puts the brand glyph in an inline-block beside the name, at its own
      // vertical offset. That read as three lines on a wordmark that has never wrapped, at every
      // viewport including 1920. Only text nodes are text; and tops are grouped with a tolerance
      // because superscripts, icons and mixed font-sizes jitter the baseline by a pixel or two
      // without starting a new line.
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const tops = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.nodeValue.trim()) continue;

        /* A HOVER-SWAP'S SECOND COPY IS NOT A SECOND LINE.
         *
         * The template family behind Batch C builds its primary button by stacking the label
         * TWICE inside an `overflow: hidden` box and sliding one out as the other slides in. One
         * copy is always parked outside the clip, at a different `top`, so a walk over text nodes
         * counts two lines on a label that has never wrapped in its life: GoodStanding reported
         * "Check statusCheck status" on two lines at every viewport from 320 to 1920, twenty-six
         * findings on four controls.
         *
         * It is skipped only when the author has DECLARED the copy decorative, which is the same
         * declaration the contrast check already demands and the same one a screen reader needs —
         * that duplicate is announced twice without it. So the gate is not being told to trust a
         * layout; it is being told, in the markup, that this text is not for reading. An
         * undeclared duplicate still fails, which is what keeps this from becoming an escape
         * hatch: silence does not qualify, only the attribute does. */
        if (n.parentElement?.closest("[aria-hidden='true']")) continue;

        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) {
          if (r.width < 1 || r.height < 1) continue;
          if (!tops.some((t) => Math.abs(t - r.top) <= 4)) tops.push(r.top);
        }
        range.detach?.();
      }
      /* AN AUTHORED LINE BREAK IS NOT A WRAP, and the difference is in the DOM rather than in
       * anybody's judgement.
       *
       * This check exists to catch a label REFLOWING because its row got too tight — the failure
       * that makes a nav look broken at 375 and fine on the desk it was designed on. A `<br>` is
       * the opposite of that: somebody typed it, it produces the same break at 320 and at 1920,
       * and no amount of width will remove it.
       *
       * GoodStanding's footer lockup is the case. Its wordmark is a stacked logotype — "GOOD"
       * over "STANDING", 28.53px Space Grotesk, an explicit <br> between them — and it reported
       * as a two-line control label at all six viewports. Six findings, one authored newline.
       *
       * So the count subtracts the breaks that were WRITTEN, and what remains is the count of
       * lines the browser chose. A lockup with one <br> on two lines is clean; the same lockup on
       * three lines still fails, because that third line is a reflow. This does not soften the
       * check, it aims it: the gate now measures what it was always trying to measure. */
      const authored = el.querySelectorAll("br").length;
      if (tops.length - authored > 1) {
        bad.push({ sel: el.tagName.toLowerCase(), text, lines: tops.length });
      }
    }
  }
  return bad;
}

/** E · headline and primary CTA above the fold. */
function probeFold() {
  const h1 = document.querySelector("h1");
  const heroRoot = h1 ? (h1.closest("section, header, div[class*='hero' i]") || document.body) : null;
  const cta = heroRoot
    ? heroRoot.querySelector("a[class*='cta' i], a[class*='btn' i], a[class*='button' i], button, nav ~ * a[href]")
    : null;
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      within: r.bottom <= innerHeight,
    };
  };
  return { h1: box(h1), cta: box(cta), viewportH: innerHeight };
}

/* ── The run ───────────────────────────────────────────────────────────────────────────────── */

const SLOP_FONTS = /\b(Inter|Roboto|Open Sans|Poppins|Lato|-apple-system|system-ui|BlinkMacSystemFont)\b/i;

/** A · the verdict on one text run. Three outcomes, and the middle one is the point.
 *
 *  · legible                                    → nothing
 *  · below the floor, declared decorative       → nothing, UNLESS it is a heading
 *  · below the floor, not declared              → fail, and say which of the two fixes applies
 *
 * The estate's footers carry a 179px brand wordmark at opacity 0.07 — a watermark, and correct.
 * StoreReady's hero h1 sat at opacity 0.001 — a bug, and shipped. Measured, those are the same
 * observation. What separates them is whether anyone said the text was decoration, which is also
 * exactly what a screen reader needs to know, so requiring the declaration costs nothing and
 * makes the two cases distinguishable forever. A heading is never decoration.
 */
/* ── B′ · THE PIXEL ARBITER ────────────────────────────────────────────────────────────────────
 *
 * WHY. Check B walks the ancestor chain compositing `background-color` and `background-image`
 * until it finds something opaque. That is the right algorithm for a page made of boxes, and it
 * is exactly wrong for a page whose dark surface is painted by a SIBLING — an absolutely
 * positioned photo, an overlay, a plate. On a page like that the walk climbs straight past the
 * artwork to the document wrapper, finds `#fff`, and reports white-on-white.
 *
 * MEASURED, 2026-08-06, on Batch C: 143 hard failures across six compliance products, of which
 * ~93 were one root cause — a `background: #fff` root under six Framer ports whose heroes are
 * dark photographs. QuorumFile alone produced 31, every one of them a word-span in a headline
 * that a human eye reads as white on near-black. `hero-contrast.mjs` — which reads pixels —
 * passed the same page with 45 clean runs. Two gates, opposite verdicts, and the one reading
 * pixels was right.
 *
 * ⛔ IT ONLY EVER DROPS A FAILURE, NEVER RAISES ONE. That asymmetry is deliberate and it is
 * what makes this safe to add to a gate twelve products already deploy against. A computed PASS
 * is never re-opened here, so nothing that passes today starts failing tomorrow; the direction
 * the arbiter can move a verdict is from "the stylesheet says this is unreadable" to "the pixels
 * say it is not". The reverse case — a computed pass that pixels would fail, a white shader over
 * white text — is what `hero-contrast.mjs` exists for and stays there.
 *
 * THE STATISTIC IS THE 10TH PERCENTILE, not the minimum and not the mean, for the reason
 * hero-contrast documents at length: the worst pixel fails everything, the mean passes
 * everything, and a tenth of the backdrop is the smallest share that can hide a word.
 */
async function arbitrate(page, runs) {
  if (!runs.length) return new Map();

  // Every glyph goes transparent; nothing else moves. `text-shadow: none` matters — a shadow is
  // painted FROM the text and would otherwise be sampled as though it were background.
  const style = await page.addStyleTag({
    content: `*, *::before, *::after {
      color: transparent !important;
      text-shadow: none !important;
      -webkit-text-fill-color: transparent !important;
      caret-color: transparent !important;
    }`,
  });
  await page.waitForTimeout(220);

  let shot;
  try {
    shot = (await page.screenshot({ type: "png" })).toString("base64");
  } finally {
    // Put the text back before anything else measures this page.
    await style.evaluate((n) => n.remove()).catch(() => {});
    await page.waitForTimeout(120);
  }

  // The sampling runs IN the page: decoding a PNG in Node would mean a raster dependency in a
  // repo that has deliberately avoided one, and a canvas is already here.
  const sampled = await page.evaluate(
    async ({ shot, runs }) => {
      const lin = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

      const img = new Image();
      img.src = "data:image/png;base64," + shot;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      // The screenshot is at the context's deviceScaleFactor; box coordinates are CSS pixels.
      const dpr = img.width / innerWidth;

      const out = [];
      for (const run of runs) {
        const x = Math.round(run.box.x * dpr);
        const y = Math.round(run.box.y * dpr);
        const w = Math.round(run.box.w * dpr);
        const h = Math.round(run.box.h * dpr);
        if (w < 2 || h < 2 || x < 0 || y < 0 || x + w > c.width || y + h > c.height) continue;

        let data;
        try { data = ctx.getImageData(x, y, w, h).data; } catch { continue; }

        const fl = lum(run.fg[0], run.fg[1], run.fg[2]);
        const ratios = [];
        for (let i = 0; i < data.length; i += 4) {
          ratios.push(ratio(fl, lum(data[i], data[i + 1], data[i + 2])));
        }
        if (!ratios.length) continue;
        ratios.sort((a, b) => a - b);
        out.push({
          key: run.key,
          pct: Math.round(ratios[Math.floor(ratios.length * 0.1)] * 100) / 100,
        });
      }
      return out;
    },
    { shot, runs },
  );

  return new Map(sampled.map((s) => [s.key, s.pct]));
}

/** Walk the page and concatenate whatever each stop returns. `sweep` merges by element+text and
 * keeps the best reading, which is right for text runs and wrong for a container whose overflow
 * only exists once it has content in it. */
async function sweepAll(page, probe, settleMs = 400) {
  const stops = await page.evaluate(() => {
    // Same whole-page spread as sweep() — see the note there. A fixed step plus a hard slice
    // stopped covering the page entirely once it grew past the budget.
    const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const MAX = 14;
    const step = Math.max(Math.round(innerHeight * 0.75), Math.ceil(h / MAX));
    const out = [];
    for (let y = 0; y < h; y += step) out.push(y);
    return out.length ? out.slice(0, MAX) : [0];
  });
  const all = [];
  for (const y of stops) {
    await page.evaluate((top) => scrollTo(0, top), y);
    await page.waitForTimeout(settleMs);
    all.push(...(await page.evaluate(probe)));
  }
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(200);
  return all;
}

/** Walk the page, probing only what is on screen at each stop, and merge by element+text. */
async function sweep(page, probe, settleMs = 750, { pixels = false } = {}) {
  const seen = new Map();
  const stops = await page.evaluate(() => {
    /* ⚠️ THE STOPS SPAN THE WHOLE PAGE. THEY USED TO SPAN THE FIRST 14 OF THEM.
     *
     * The walk stepped a fixed 0.75 viewport from the top and then took `.slice(0, 14)` for the
     * time budget — so on anything taller than about 9,450px at a 900px viewport the sweep
     * simply stopped, and every element below that was never judged at all. A gate that reports
     * clean because it ran out of stops is worse than one that reports nothing.
     *
     * It also produced a false POSITIVE, which is how it was found. On goodstanding an element
     * entered at the very bottom of the final stop — measured at y=798 of 900, mid-reveal, at
     * opacity 0 — and because the walk ended there it was never measured again. The merge keeps
     * the best reading of each element, and one truncated reading is the only reading. The
     * finding was real-looking, deterministic across runs, and describing nothing a reader
     * would ever see.
     *
     * Spreading the same budget over the real height fixes both: coverage is complete, and an
     * element caught at a stop's edge gets another look from a different offset. Density
     * degrades on a very long page instead of coverage vanishing, which is the right trade —
     * a missed defect in the last third is worse than a coarser walk. */
    const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const MAX = 14; // 14 stops at 750ms is the time budget
    const step = Math.max(Math.round(innerHeight * 0.75), Math.ceil(h / MAX));
    const out = [];
    for (let y = 0; y < h; y += step) out.push(y);
    if (!out.length) out.push(0);
    return out.slice(0, MAX);
  });

  for (const y of stops) {
    await page.evaluate((top) => scrollTo(0, top), y);
    // Long enough for a reveal to FINISH, not merely to start. At 320ms the sweep kept catching
    // FetchDue's sections at opacity 0.061 — mid-fade, which reads as a defect and is not one.
    await page.waitForTimeout(settleMs);

    const here = await page.evaluate(probe);

    /* The arbiter runs PER STOP, because its input is a screenshot of the viewport and its
     * coordinates are viewport coordinates. Sampling later, from the top of the page, would
     * measure whatever happens to be at those y values then. Only the runs that the computed
     * walk condemned are sampled — everything else costs nothing. */
    let px = new Map();
    if (pixels) {
      const condemned = here.filter(
        (t) =>
          t.inFold &&
          t.ratio < t.need &&
          t.opacity >= OPACITY_FLOOR &&
          !t.decorative &&
          !t.inactive &&
          t.box.w >= 2 &&
          t.box.h >= 2,
      );
      if (condemned.length) {
        px = await arbitrate(
          page,
          condemned.map((t) => ({ key: `${t.sel}|${t.text}`, fg: t.fg, box: t.box })),
        ).catch(() => new Map());
      }
    }

    for (const t of here) {
      if (!t.inFold) continue; // judged only where the reader can see it
      const key = `${t.sel}|${t.text}`;
      // An occluded run's "backdrop" pixels belong to whatever is lying on top of it, so a
      // reading taken there can only mislead — and because the arbiter exists to DROP failures,
      // a misleading reading here drops a real one. Never attach it.
      if (px.has(key) && !t.occluded) t.pxRatio = px.get(key);
      // Keep the BEST reading of each element: if it was ever properly painted, it works.
      const prev = seen.get(key);
      if (!prev || t.opacity > prev.opacity) seen.set(key, t);
      // …and the best CONTRAST reading too. An element measured at two stops can be sampled
      // over two different backdrops; a single legible reading is enough to clear it, for the
      // same reason a single properly-painted reading clears the opacity check.
      else if (t.pxRatio != null && (prev.pxRatio == null || t.pxRatio > prev.pxRatio)) {
        prev.pxRatio = t.pxRatio;
      }
    }
  }
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(220);
  return [...seen.values()];
}

function visibility(t, fails, note, when = "") {
  if (t.opacity >= OPACITY_FLOOR && !t.clipped) return;
  const how = t.clipped ? "collapsed by a transform or a hidden ancestor" : `painted at opacity ${t.opacity}`;

  if (t.heading) {
    note(fails, "VISIBLE", `${t.sel} is ${how}${when}. A heading is never decoration.`, `"${t.text}"`, t.sel);
    return;
  }
  if (t.decorative) return;
  note(
    fails,
    "VISIBLE",
    `${how}${when}, and not marked decorative — either it is a bug, or it is a watermark and needs aria-hidden="true"`,
    `${t.sel} — "${t.text}"`,
  );
}

async function run(url, opts) {
  const chromium = loadChromium();
  if (!chromium) {
    console.error("✗ Playwright not found — this gate could not run, which is NOT a pass (exit 2).");
    console.error("  Install it in the project you are checking:  npm i -D playwright && npx playwright install chromium");
    console.error("  Or point at an existing install:              DEFERLESS_PLAYWRIGHT=/path/to/playwright");
    return 2;
  }

  const fails = [];
  const warns = [];
  /* Set only by check G's positive control. Not a finding about the page — a statement that this
   * process cannot make findings about the page — so it bypasses the report and exits 2. */
  let harnessBroken = null;
  /* `sel` is carried as its own field rather than left inside `detail`, so the summary can group
   * by ROOT CAUSE. Three times now the useful number was found by hand-grouping this output —
   * 134 findings resolving to 3 selectors, 487 to 2 root causes carrying 224, 143 to 14 fixes —
   * and every time the raw list read as a month of work while the grouped one read as an
   * afternoon. The gate had the data and printed the wrong shape. */
  const note = (list, area, msg, detail, sel) => list.push({ area, msg, detail, sel });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: FOLD.w, height: FOLD.h },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  /* SCROLL THE WHOLE PAGE BEFORE MEASURING ANYTHING.
   *
   * Scroll-reveal runtimes hold an element at opacity 0 until it enters the viewport. Measuring
   * without scrolling therefore reports every below-fold element on such a page as invisible —
   * and it did: the first off-shell sweep returned 889 VISIBLE findings across thirteen sites,
   * essentially all of them framer `whileInView` sections that had simply never been asked to
   * appear. A gate that cries wolf 889 times is not a gate.
   *
   * The estate's own shell hid this, because its entrance runtime reveals on mount rather than on
   * intersection — so the twelve products scored honestly by accident, which is the worst way to
   * be right. Stepping down the page triggers every observer, and returning to the top leaves the
   * viewport where the fold checks expect it. */
  const settle = async () => {
    await page.waitForLoadState("networkidle").catch(() => {});

    /* WAIT FOR THE FACES. A label measured in the fallback face is measured at the wrong width.
     *
     * `networkidle` is about requests, and a webfont is not requested until the layout that needs
     * it exists — so the gate could measure a viewport in whatever the fallback stack resolves to,
     * which is a different set of advance widths from the face that ships. Every check that
     * depends on how wide a string is inherits that: WRAP most directly, then OVERFLOW, then FOLD.
     *
     * MEASURED, 2026-08-06, kynth.studio: the sweep reported the "Send the brief" CTA on THREE
     * lines at 320, 375, 414 and 768 — four hard failures. Re-run against the same unchanged page
     * with the faces loaded: zero, at all four widths. The pill has never wrapped. Four findings
     * on a defect that does not exist, and the site's own display face (BDO Grotesk) is narrower
     * than the fallback, which is exactly the direction that manufactures a phantom.
     *
     * A gate that reports a bug that is not there costs more than one that misses a bug, because
     * the next person to see a real finding has already learned to discount it. */
    await page.evaluate(() => document.fonts?.ready).catch(() => {});

    await page.waitForTimeout(SETTLE_MS);
  };

  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (!res || !res.ok()) {
      note(fails, "LOAD", `${url} returned ${res ? res.status() : "no response"}`);
      await browser.close();
      return report(fails, warns, opts);
    }
    await settle();

    /* ── A · VISIBLE ───────────────────────────────────────────────────────────────────────
     * JUDGED IN VIEW, AND ONLY IN VIEW.
     *
     * A scroll-reveal holds an element at opacity 0 until it intersects the viewport, and many
     * of them re-hide when it leaves again. Measuring the whole document from one scroll position
     * therefore condemns every section the reader has not reached yet — 889 findings on the first
     * off-shell sweep, essentially all of them sections that had simply never been asked to
     * appear. Verified directly on FetchDue: effective opacity 0 with the element below the fold,
     * 1 once scrolled to, own opacity 1 the whole time.
     *
     * So the page is walked, and at each stop only what is ON SCREEN is judged. An element
     * off-screen at opacity 0 is not a defect. An element in front of the reader at opacity 0 is
     * the StoreReady bug. That distinction is the whole check, and one scroll position cannot
     * make it. */
    const text = await sweep(page, probeText, 750, { pixels: true });

    /* ── A′ · THE SECOND LOOK ───────────────────────────────────────────────────────────────
     *
     * Anything the walk condemned as invisible gets ONE more measurement, taken deliberately:
     * scrolled to the middle of the viewport, settled long enough for a staggered reveal to
     * finish, and re-read. Only condemned runs are re-checked, so on a clean page this costs
     * nothing.
     *
     * WHY IT IS NEEDED. The stops are spread over the whole page height, which on a long page
     * means an element can be in front of the reader at exactly one of them. If that one stop
     * catches it mid-reveal — entering at the bottom edge, or partway through a stagger — the
     * best-reading merge has only the bad reading to keep, and the gate reports text painted at
     * opacity 0 that every real reader sees perfectly. Measured on quorumfile: three cells of a
     * seventeen-row table condemned by the walk, all three at opacity 1 when scrolled to.
     *
     * This is deliberately NOT a longer settle or more stops. The question "is this element
     * ever actually painted" is answered by looking at it, once, on purpose — and a check that
     * only runs against findings can afford to be slow. A finding that survives being scrolled
     * to and stared at for a second is the StoreReady bug; one that does not was never a bug. */
    const condemned = text.filter((t) => t.opacity < OPACITY_FLOOR && !t.decorative && !t.clipped);
    for (const t of condemned) {
      await page.evaluate((top) => scrollTo(0, Math.max(0, top - innerHeight / 2)), t.top);
      await page.waitForTimeout(1400);
      /* The whole probe is re-run here, not just the opacity. A reading taken while an element
       * was still at opacity 0 also carries the CONTRAST it had against whatever was behind it
       * then — 1:1, because the ink was not painted. Adopting the opacity alone would clear the
       * VISIBLE finding and hand that dead 1:1 straight to the contrast check, turning one false
       * finding into another. The fresh reading replaces the stale one WHOLE. */
      const fresh = await page.evaluate(probeText);
      const better = fresh.find((f) => f.sel === t.sel && f.text === t.text && f.inFold);
      if (better && better.opacity > t.opacity) Object.assign(t, better, { pxRatio: undefined });
    }
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(220);

    for (const t of text) visibility(t, fails, note);

    /* ── B · CONTRAST ────────────────────────────────────────────────────────────────────── */
    for (const t of text) {
      if (t.opacity < OPACITY_FLOOR) continue; // already reported as invisible
      if (t.decorative) continue;              // declared decoration, nobody has to read it
      if (t.inactive) continue;                // disabled control — WCAG 1.4.3 exempts it
      if (t.ratio >= t.need) continue;

      /* THE PIXELS OVERRULE THE STYLESHEET, in one direction only — see `arbitrate` above.
       * Where the backdrop was sampled and clears the floor, the computed walk climbed past a
       * sibling that paints the surface, and there is nothing here to fix. */
      if (t.pxRatio != null && t.pxRatio >= t.need) continue;

      // A background image under the text means the computed colour is not what is painted.
      // Report it, but as a warning — unless the pixels were read, in which case the gate is no
      // longer estimating and the finding stands as a failure.
      // Under a blend or a colour filter the arbiter cannot settle it either: it re-measures the
      // BACKGROUND, and what a blend moved is the INK. So `blended` outranks a pixel reading and
      // the finding never hardens into a failure. `occluded` does the same for a different
      // reason — nobody is reading this run at all while something is painted over it.
      const unsure = t.blended || t.occluded;
      const measured = t.pxRatio != null && !unsure;
      const list = (t.imageBacked || unsure) && !measured ? warns : fails;
      note(
        list,
        "CONTRAST",
        measured
          ? `${t.pxRatio}:1 against the pixels actually painted behind it (10th percentile), needs ${t.need}:1`
          : t.occluded
            ? `${t.ratio}:1 by the stylesheet, but ${t.occluder} is painted on top of it — this is not what the reader is looking at. Dismiss the overlay and measure again.`
            : t.blended
              ? `${t.ratio}:1 by the stylesheet, but an ancestor carries mix-blend-mode or a filter — the painted ink is not this colour, so the number is not the verdict. Verify by eye.`
              : `${t.ratio}:1 against its computed background, needs ${t.need}:1${t.imageBacked ? " (sits over a gradient or image — the composite is an estimate, verify by eye)" : ""}`,
        `${t.sel} — "${t.text}"`,
        t.sel,
      );
    }

    /* Display font — gate 1 of the slop test. A warning, not a failure: the estate is on Inter
     * today and a hard failure here would break twelve builds for a change that is scheduled. */
    const h1Font = text.find((t) => t.sel.startsWith("h1"))?.fontFamily;
    if (h1Font && SLOP_FONTS.test(h1Font)) {
      note(warns, "TYPE", `display face is ${h1Font.split(",")[0].replace(/["']/g, "")} — an AI-default tell`, "h1");
    }

    /* ── F · CLIPPED ─────────────────────────────────────────────────────────────────────
     *
     * SWEPT, THEN CONFIRMED, and the second half is not optional.
     *
     * Swept because a box only clips once it has content — on these products that means after a
     * determination has landed or a reveal has run, which one scroll position cannot see.
     *
     * ⛔ CONFIRMED because a masked text-reveal is INDISTINGUISHABLE FROM THIS BUG for the
     * length of its animation. Text translated up from behind a clip parent is exactly "text cut
     * by a box above it", and it is also exactly how the effect is supposed to work. The first
     * run of this check reported CertScope's "BUILT ON 16 CFR 1110" as cut by 1134px; settled, it
     * is cut by nothing. That is the same trap the opacity sweep already fell into and documented
     * — FetchDue's sections caught mid-fade at 0.061 — and it is worth catching the same way.
     *
     * So a finding has to survive a second look: swept once for coverage, then re-walked after a
     * full settle, and only what appears in BOTH is reported. A transient frame drops out; baked
     * geometry does not move. */
    /* ⛔ CUT AT EVERY STOP, OR IT IS NOT CUT.
     *
     * This replaces a heuristic that tried to guess INTENT — skip anything under a transform,
     * on the theory that a masked reveal moves and baked geometry does not. It leaked in both
     * directions: CertScope's scroll-linked headline was excused correctly, QuorumFile's stacked
     * pricing card was not (its transform is the identity matrix at rest), and a permanently
     * mis-transformed element would have been excused wrongly.
     *
     * The honest discriminator needs no theory about why an element moved. Walk the page and
     * record, per text run, how many stops it was VISIBLE at and how many it was CUT at. Baked
     * geometry — a footer column with a captured pixel height — is cut at every one of them. A
     * card that slides, a headline that rises out of a mask, a sticky panel mid-travel: cut at
     * some, clear at others. Only a run that never once appears whole is reported.
     *
     * Verified against four pages: a fixture carrying the bug and its fix side by side,
     * GoodStanding (three real cases, all reported), CertScope's masked reveal and QuorumFile's
     * stacked cards (both silent). */
    const tally = new Map();
    for (const c of await sweepAll(page, probeClipped, 750)) {
      const key = `${c.sel}|${c.text}`;
      const t = tally.get(key) ?? { seen: 0, cut: 0, worst: null };
      t.seen++;
      if (c.cut) {
        t.cut++;
        if (!t.worst || c.by > t.worst.by) t.worst = c;
      }
      tally.set(key, t);
    }

    const clipped = new Map();
    for (const t of tally.values()) {
      if (!t.worst || t.cut !== t.seen) continue; // whole at least once → not clipped
      const c = t.worst;
      const key = `${c.sel}|${c.edge}`;
      const prev = clipped.get(key);
      if (!prev || c.by > prev.by) clipped.set(key, c);
    }
    for (const c of clipped.values()) {
      const how =
        c.mode === "auto" || c.mode === "scroll"
          ? `past the ${c.edge} edge of its own scroll container, where no scroll position reaches it`
          : `by ${c.by}px, and \`overflow: ${c.mode}\` means there is no scrollbar to reach it`;
      note(fails, "CLIPPED", `text cut ${how}`, `${c.sel} — "${c.text}"`, c.sel);
    }

    /* ── E · FOLD (at 1280x800, before the viewport starts moving) ───────────────────────── */
    const fold = await page.evaluate(probeFold);
    if (fold.h1 && !fold.h1.within) {
      note(fails, "FOLD", `headline runs past the fold (bottom ${fold.h1.bottom} > ${fold.viewportH})`, `"${fold.h1.text}"`);
    }
    if (fold.cta && !fold.cta.within) {
      note(warns, "FOLD", `primary CTA sits below the fold (top ${fold.cta.top} > ${fold.viewportH})`, `"${fold.cta.text}"`);
    }

    /* ── G · NESTED SCROLL ───────────────────────────────────────────────────────────────
     *
     * TWO viewports, and the narrow one is not optional. At 1280 the estate's wide-content
     * wrappers — `.guide-scroll`, `.rs-prose`, `.compare-band__body`, every comparison table —
     * do not overflow, so there is nothing to scroll and the check correctly finds nothing.
     * Measured on the live CertScope guide: 0 scrollable elements at 1280 and at 768, ONE at
     * 414 that overflowed by 205px — and a diagonal wheel over it moved the element 0px while
     * the page moved 72px. A single-viewport version of this check would have reported that
     * page clean, which is how a gate ends up worse than no gate.
     *
     * 1280 is where the vertical regions live (a modal body, a result pane, a listbox) and
     * where the desktop pointer that triggers the bug actually is. 414 is where the horizontal
     * ones finally have something to scroll.
     *
     * ⛔ THE CONTROL RUNS FIRST AND ITS FAILURE IS TERMINAL. If the harness cannot prove it can
     * both see a scroll and see the absence of one, nothing it says afterwards is worth reading.
     *
     * WHAT THIS CANNOT REACH. A region behind an interaction — the signup modal, the free-tool
     * result pane, the command palette — is not in the DOM when the gate looks, so a clean G is
     * not a statement about those. That is the division of labour with lenis-gate.mjs, which
     * reads the instantiation and covers every region on every route including the ones no
     * crawler can open. */
    const nested = await nestedScrollPass(chromium, url);
    if (nested.broken) {
      harnessBroken = nested.broken;
    } else {
      for (const s of nested.findings) {
        note(
          fails,
          "NESTED",
          `nested ${s.axis === "y" ? "vertical" : "horizontal"} scroll region does not scroll at ${s.vp}`,
          `${s.sel} — a real diagonal wheel over it moved the element 0px and the page ${s.pageMoved}px` +
            (s.exempt
              ? ". It CARRIES data-lenis-prevent, so the attribute is not taking effect — look for a competing handler or a wrapper that stops the event"
              : ". If you use a smooth-scroll library, it is preventDefault-ing the wheel at the document and moving the page instead — set its nested-scroll escape (Lenis: allowNestedScroll) or mark the region with its opt-out attribute"),
          s.sel,
        );
      }
    }

    /* ── C + D · across every viewport ───────────────────────────────────────────────────── */
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      // The sibling of the `document.fonts.ready` wait in settle(), and the branch that actually
      // produced the phantom: a viewport change re-lays out and can pull a face this breakpoint
      // had not needed yet. WRAP and OVERFLOW are both measured from string widths right below.
      await page.evaluate(() => document.fonts?.ready).catch(() => {});
      await page.waitForTimeout(400);

      const { overflow, offenders } = await page.evaluate(probeOverflow);
      if (overflow > 1) {
        note(
          fails,
          "OVERFLOW",
          `page scrolls horizontally by ${overflow}px at ${vp.label}`,
          offenders.map((o) => `${o.sel} (+${o.past}px)`).join(", ") || "no single element identified",
        );
      }

      const wrapped = await page.evaluate(probeWrap);
      for (const w of wrapped) {
        note(fails, "WRAP", `clickable text on ${w.lines} lines at ${vp.label}`, `${w.sel} — "${w.text}"`, w.sel);
      }

      /* H · at the TOP of each viewport only. Scrolling the whole page per breakpoint would
       * multiply this gate's runtime by six for a condition whose worst case is the first
       * screen — where the sticky bar, its in-flow twin and the nav button all coincide. */
      const primaries = await page.evaluate(probePrimaries);
      if (primaries.length > 1) {
        note(
          fails,
          "PRIMARY",
          `${primaries.length} accent-filled controls on one screen at ${vp.label} — none of them reads as the primary action`,
          primaries.map((p) => `${p.sel} "${p.text}"`).join(" · "),
          primaries.map((p) => p.sel).sort().join(" + "),
        );
      }

      if (opts.shots) {
        fs.mkdirSync(opts.shots, { recursive: true });
        await page.screenshot({
          path: path.join(opts.shots, `${vp.w}.png`),
          fullPage: true,
        });
      }
    }

    /* ── A again, with motion off ────────────────────────────────────────────────────────────
     * With reduced motion the reveal runtimes never start, so every element must already be at
     * its final state. Anything invisible here is invisible by construction, not mid-animation —
     * which is precisely how StoreReady's hero failed. */
    await page.setViewportSize({ width: FOLD.w, height: FOLD.h });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await settle();
    // 180ms, not 750: with motion disabled there is no reveal to wait for. That is the entire
    // premise of this pass — anything still hidden here is hidden by construction. Halves the
    // gate's runtime, which matters now that it runs inside twelve deploy paths.
    const reduced = await sweep(page, probeText, 180);
    // Only what the motion-on pass did NOT already catch. An element that is invisible both ways
    // is one finding, not two — and the motion-on wording is the one that describes it.
    const already = new Set(text.filter((t) => t.opacity < OPACITY_FLOOR || t.clipped).map((t) => `${t.sel}|${t.text}`));
    for (const t of reduced) {
      if (already.has(`${t.sel}|${t.text}`)) continue;
      visibility(t, fails, note, " only when prefers-reduced-motion is set — the reveal never runs, so this never appears");
    }
  } catch (err) {
    note(fails, "RUN", err.message);
  } finally {
    await browser.close();
  }

  /* ⛔ FAIL CLOSED. The control proves the wheel harness can both see a scroll and see the absence
   * of one. If it cannot, every NESTED verdict in this run is unfounded — including the clean
   * ones — so the run reports "could not run" rather than a number it cannot stand behind. */
  if (harnessBroken) {
    console.error("✗ NESTED · the check's own positive control failed, so this run cannot be trusted:");
    for (const p of harnessBroken) console.error(`    ${p}`);
    console.error("  Nothing about nested scrolling was measured. Exit 2.");
    return 2;
  }

  return report(fails, warns, opts);
}

/* ── Reporting ─────────────────────────────────────────────────────────────────────────────── */

function dedupe(list) {
  const seen = new Set();
  return list.filter((f) => {
    const k = `${f.area}|${f.msg}|${f.detail ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function report(rawFails, rawWarns, opts) {
  const fails = dedupe(rawFails);
  const warns = dedupe(rawWarns);

  if (opts.json) {
    console.log(JSON.stringify({ ok: fails.length === 0, fails, warns }, null, 2));
    return fails.length ? 1 : 0;
  }

  const group = (list) => {
    const by = new Map();
    for (const f of list) {
      if (!by.has(f.area)) by.set(f.area, []);
      by.get(f.area).push(f);
    }
    return by;
  };

  /* ⛔ ROOT CAUSES FIRST, THEN THE LIST — and on a big sweep, INSTEAD of the list.
   *
   * house-standard §8 names the recurring shape of every defect this estate has found: a fix
   * applied to one branch and not its sibling. The corollary is that findings arrive in families,
   * and the three sweeps on record all proved it — 134 findings resolving to 3 selectors, 487
   * resolving to 2 root causes that carried 224 of them, 143 going to zero from 14 fixes. Every
   * one of those numbers was worked out by hand from a flat list the gate had already printed.
   *
   * The flat list is not neutral. 487 lines reads as a month of work and the same data grouped
   * reads as two afternoons, and the second reading is the true one — so printing the flat list
   * first is the gate arguing, in effect, for the wrong plan. */
  const causes = new Map();
  for (const f of fails) {
    const key = `${f.area} · ${f.sel ?? "—"}`;
    causes.set(key, (causes.get(key) ?? 0) + 1);
  }
  const ranked = [...causes.entries()].sort((a, b) => b[1] - a[1]);

  if (fails.length) {
    console.error(`\nBY ROOT CAUSE — ${ranked.length} cause(s) behind ${fails.length} finding(s)`);
    for (const [key, n] of ranked.slice(0, 12)) {
      const share = Math.round((n / fails.length) * 100);
      console.error(`  ${String(n).padStart(4)}×  ${String(share).padStart(3)}%   ${key}`);
    }
    if (ranked.length > 12) console.error(`        … and ${ranked.length - 12} more cause(s)`);
  }

  /* Past a couple of hundred findings the per-item list stops being information and starts being
   * a wall — and a wall is what teaches people to skip the whole report. `--all` prints it anyway
   * for the case where the cause table is not enough. It says what it withheld: a gate that
   * silently truncates reads as "that was everything". */
  const listCap = fails.length > 200 && !opts.all ? 0 : 12;
  if (listCap === 0 && fails.length) {
    console.error(
      `\n  ${fails.length} findings withheld — fix by cause, or re-run with --all to see each one.`,
    );
  }

  for (const [area, items] of group(fails)) {
    if (!listCap) break;
    console.error(`\n✗ ${area}`);
    for (const i of items.slice(0, listCap)) {
      console.error(`    ${i.msg}`);
      if (i.detail) console.error(`      ${i.detail}`);
    }
    if (items.length > listCap) console.error(`    … and ${items.length - listCap} more`);
  }

  if (!opts.quiet) {
    for (const [area, items] of group(warns)) {
      console.log(`\n· ${area} (warning)`);
      for (const i of items.slice(0, 8)) {
        console.log(`    ${i.msg}`);
        if (i.detail) console.log(`      ${i.detail}`);
      }
      if (items.length > 8) console.log(`    … and ${items.length - 8} more`);
    }
  }

  if (fails.length) {
    console.error(
      `\n${fails.length} failure(s). These are measured on the rendered page — a grep cannot ` +
        `see any of them.\n`,
    );
    return 1;
  }
  console.log(`\n✓ render gate clean${warns.length ? ` — ${warns.length} warning(s)` : ""}`);
  return 0;
}

/* ── CLI ───────────────────────────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
/* ⛔ A FLAG'S VALUE IS NOT A URL. `--sample 3` and `--shots out/` each put a bare token in argv,
 * and the first version of this filter took `3` as a target and tried to navigate to it —
 * "Cannot navigate to invalid URL", one manufactured failure per run. The positions immediately
 * after a value-taking flag are skipped. */
const VALUE_FLAGS = new Set(["--shots", "--sample"]);
const urls = argv.filter(
  (a, i) => !a.startsWith("-") && !(i > 0 && VALUE_FLAGS.has(argv[i - 1])),
);
if (!urls.length) {
  console.error(
    "usage: node ops/qa/render-gate.mjs <url> [<url>…] [--sample N] [--json] [--shots <dir>] [--quiet] [--all]",
  );
  process.exit(2);
}
const shotsFlag = argv.indexOf("--shots");
const sampleFlag = argv.indexOf("--sample");
const opts = {
  json: argv.includes("--json"),
  quiet: argv.includes("--quiet"),
  all: argv.includes("--all"),
  shots: shotsFlag !== -1 ? argv[shotsFlag + 1] : null,
};

/* ── WHICH PAGES GET MEASURED ─────────────────────────────────────────────────────────────────
 *
 * ⛔ IT USED TO BE EXACTLY ONE, AND ALWAYS THE HOMEPAGE. Audited 2026-08-13: all twelve products
 * that vendor this gate invoke it as `render-gate.mjs "https://<slug>.kynth.studio/"` and nothing
 * else. So check G — the nested-scroll wheel probe, the one written after a horizontal-only
 * scroller was found eating the whole gesture — has never measured a single interior page, and
 * interior pages are where the scrollers live. StackTab's chip rail and its widest price tables
 * are on /catalogue; measured there at 414px, five scrollers overflow and the homepage has none.
 * A gate aimed at the one page that does not have the thing it checks for is a gate that passes.
 *
 * `--sample N` reads the product's OWN sitemap.xml and takes up to N interior pages, one per
 * distinct first path segment. That last part is what makes it bounded and useful: a sitemap with
 * four thousand /kit/<slug> URLs contributes ONE of them, so the sample is a tour of the site's
 * page TYPES rather than N near-identical rows. And a route added next month is covered without
 * anyone remembering this file exists, which is the only property that matters here.
 *
 * Explicit URLs still work and still win — pass them when a specific page must be checked. */
async function sampleFromSitemap(origin, n) {
  const base = new URL(origin);
  try {
    const res = await fetch(new URL("/sitemap.xml", base), { redirect: "follow" });
    if (!res.ok) return [];
    const xml = await res.text();
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
    const bySegment = new Map();
    for (const loc of locs) {
      let u;
      try {
        u = new URL(loc);
      } catch {
        continue;
      }
      if (u.host !== base.host) continue;
      const seg = u.pathname.split("/").filter(Boolean)[0];
      /* The homepage is measured anyway — it is the URL that was passed in. */
      if (!seg) continue;
      if (!bySegment.has(seg)) bySegment.set(seg, u.href);
    }
    return [...bySegment.values()].slice(0, n);
  } catch {
    /* An unreadable sitemap is not a finding about any page, so it is not a failure — but it is
     * said out loud, because a silent empty sample is a gate that quietly went back to one page. */
    console.error(`  ! could not read ${new URL("/sitemap.xml", base).href} — sampling skipped`);
    return [];
  }
}

const targets = [...urls];
if (sampleFlag !== -1) {
  const n = Number(argv[sampleFlag + 1]) || 3;
  const extra = await sampleFromSitemap(urls[0], n);
  for (const u of extra) if (!targets.includes(u)) targets.push(u);
}

let worst = 0;
for (const target of targets) {
  if (targets.length > 1 && !opts.quiet) console.log(`\n── ${target}`);
  const code = await run(target, opts);
  /* Exit 2 means the harness itself could not make a finding, which is worse than a finding. */
  worst = code === 2 || worst === 2 ? 2 : Math.max(worst, code);
}
process.exit(worst);
