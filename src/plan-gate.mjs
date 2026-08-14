#!/usr/bin/env node
// THE PLAN GATE. Any plan, any domain. It reads a machine-readable spec and refuses output that
// violates it, exit non-zero.
//
//   deferless check <spec.json> [outputDir]
//   deferless check VIDEO-SPEC.json ./out
//
// WHY THIS EXISTS (2026-08-13). We keep doing real research, writing a real plan, approving it —
// and then violating it during execution, because the plan is a document and execution is a
// shell. A researched video plan said the product UI must be captured "at full size"; ninety
// minutes later the build hit friction (a short page made every clip the same shot) and fixed it
// with a 1.5x browser zoom, which is the exact opposite of that sentence. Nothing errored. The
// output looked fine. A human was the only detector, and the question was the right one: what is
// the point of doing research if we do not follow it.
//
// A PLAN WITHOUT A GATE IS ADVISORY, and advisory means it holds until it is inconvenient. This
// is the thing that makes a plan binding.
//
// ⛔ THE GATE HAS NO --force, NO ALLOWLIST AND NO KNOWN-ISSUES FILE. Each of those is a supported
// way to record a failure and ship past it. If a check is wrong, fix the check or fix the spec —
// in the open, as a decision, not as a flag on one run.
//
// THE SPEC SHAPE. Domain-agnostic. `checks` is an array; every entry names a `kind`, the thing it
// applies to, and — importantly — `quote`, the sentence from the PLAN it is enforcing. The quote
// is printed on failure so the violation is reported in the plan's own words, not the gate's.
//
// `source` names the PLAN this spec was lifted from. It must point at a durable location —
// a tracked path inside the repo, e.g. docs/plans/. NEVER a scratch directory or a desktop: on
// 2026-08-14 every plan cited from a desktop copy was deleted at once, leaving four live specs
// quoting documents that no longer existed anywhere on disk.
//
//   { "source": "docs/plans/launch-video.html",
//     "checks": [
//       { "kind":"files",  "glob":"micro/*.mp4", "min":3, "max":5, "quote":"three to five micro-demos per product" },
//       { "kind":"media",  "glob":"micro/*.mp4", "width":1280, "height":720, "fps":30,
//         "pixFmt":"yuv420p", "audioStreams":0, "maxBytes":2097152,
//         "durationSec":{"min":4,"max":6}, "quote":"1280x720, 4-6 seconds, silent, under 2 MB" },
//       { "kind":"sidecar","glob":"micro/*.mp4", "manifest":"capture.json", "field":"captureScale",
//         "equals":1, "quote":"the product's own interface doing a real thing, at full size" },
//       { "kind":"distinct","glob":"micro/*.mp4", "quote":"one MECHANISM per clip" },
//       { "kind":"pairedFile","glob":"micro/*.mp4", "ext":".jpg", "quote":"poster frame beside each" },
//       { "kind":"forbids", "glob":"**/*.txt", "patterns":["compliance studio"], "quote":"no vertical qualifier" }
//     ] }
//
// ── DESIGN CHECKS (added 2026-08-13) ──────────────────────────────────────────────────────────
// The kinds above are answerable from metadata, which is why the first VIDEO-SPEC.json was
// mechanics-only and why a browser rendering an <h1> passed every single check in it. A design
// rule needs the pixels, so the kinds below decode real frames (ffmpeg → rawvideo on stdout, no
// image library). Each is calibrated against measurements taken off the reference tier rather
// than a guessed threshold; the numbers and their sources are in
// docs/CALIBRATION.md.
//
//   { "kind":"frameFill",   "glob":"film/*.mp4", "window":[0.2,0.8], "minFillW":0.96, "minFillH":0.90 }
//        UNIFORM EDGE BANDS, not a content bounding box — the letterbox signature. Measured:
//        notion 99.7%x100%, supabase 100%, framer 100%; arc.net's Dia clip leaves a real 10.94%
//        white gutter and fails. A bounding-box version read a dark UI's own near-black page
//        margins as letterbox and failed a full-bleed film at 90.9%.
//   { "kind":"luminance",   "glob":"film/*.mp4", "meanMin":12, "meanMax":40 }
//        Mean frame luma band. A dark dense product film has a ground; a stock montage does not.
//   { "kind":"accentShare", "glob":"film/*.mp4", "colour":"#95c2ff",
//     "perFrameMin":0.0005, "perFrameMax":0.08, "medianMax":0.02 }
//        The accent is a MARK, never a field — and never absent either. Real BreachProbe pages
//        measure 0.01-0.55%; the most colour-forward clip in the reference tier peaks at 7.8%.
//   { "kind":"motionFloor", "glob":"film/*.mp4", "maxFrozenSec":2.5, "minMovingFrac":0.30 }
//        An interval is MOVING when >=areaEps of pixels each changed by >pixEps levels — an AREA
//        test, because mean-magnitude delta is dominated by how much of the frame moved and scored
//        every staged reveal in an end lockup as frozen. Measured on the tier at pixEps 24 /
//        areaEps 0.08%: frozen runs linear 0.00s, framer 0.10s, notion 0.40s, arc 0.90s,
//        supabase 1.00s, arc/dia 2.40s; moving fraction arc-zero-chrome 31.0% (the floor),
//        arc/dia 57.6%, supabase 80.6%, notion 83.5%, framer 99.0%, linear 100%.
//   { "kind":"textInk",     "glob":"film/*.mp4", "window":[0.75,0.95],
//     "region":{"x0":0.2,"x1":0.8,"y0":0.2,"y1":0.8}, "minFracH":0.0145 }
//        Median text-line ink height as a fraction of frame height, in a region and a window.
//        Notion's hero body text — the smallest in the reference tier — is 1.46%.
//   { "kind":"markPresent", "glob":"film/*.mp4", "template":"assets/mark.png",
//     "windows":[[0,0.12],[0.88,1]], "minScore":0.6 }
//        Normalised cross-correlation of the product's OWN mark against sampled frames, so a
//        film cannot ship a re-drawn mark or none at all.
//   { "kind":"cutCadence",  "glob":"film/*.mp4", "declaredIn":"film/capture.json",
//     "declaredField":"seams", "minCuts":4, "maxCuts":14, "minHoldSec":2.2, "maxHoldSec":13,
//     "minCutJump":0.18 }
//        The composition DECLARES its seams; this verifies each one is a real discontinuity in the
//        pixels, that no undeclared discontinuity exists, and that the held-shot lengths are in
//        range. ffmpeg's scene detector found ZERO cuts in a film with six, because a
//        velocity-matched cut between two shots of the same dark UI keeps ~88% of the frame.
//        Omit `declaredIn` to fall back to scene detection.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [, , specArg, outArg] = process.argv;
if (!specArg) {
  console.error('usage: plan-gate.mjs <spec.json> [outputDir]');
  process.exit(2);
}
const expand = (p) => p.replace(/^~/, process.env.HOME);
const SPEC_PATH = path.resolve(expand(specArg));
// ⛔ "I could not read the spec" is exit 2, never exit 1. Letting the throw escape reported a
// missing or malformed spec with the same code as "the output violates the plan", and a caller
// that only distinguishes 0 from non-zero would have read a typo in a path as a real finding —
// the same conflation between "checked and failed" and "could not check" that this file exists
// to keep out of the rest of the pipeline.
let spec;
try {
  spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
} catch (e) {
  console.error(`plan-gate: cannot read spec ${SPEC_PATH}\n  ${e.message}`);
  console.error('  Nothing was checked. That is exit 2 — it is not a finding and it is not a pass.');
  process.exit(2);
}
const ROOT = path.resolve(expand(outArg || spec.outputDir || '.'));

const fails = [];
const notes = [];
const fail = (c, msg) => fails.push({ quote: c.quote || '(no quote recorded in the spec)', msg });

// ── UNBUILT vs WRONG, and why this is a REPORTING split and never a pass ──────────────────────
// A spec written before its lane exists fails every check, and it fails them for a reason that
// is not a defect: nothing has been produced yet. A spec whose lane HAS run and produced the
// wrong thing fails too. Both must stay non-zero — there is no flag here that makes either one
// green, no allowlist and no known-issues file, because a check that can be told to stop
// mattering is a check that has been taught to be ignored.
//
// What is added is only the ability to TELL THEM APART from outside. Exit 1 means the output is
// wrong; exit 3 means every violation was "this was never produced". A runner enumerating
// several specs can then report an unbuilt lane as unbuilt instead of as a red estate, and it
// still cannot report either as passing.
//
// `absent` is set ONLY where the glob matched zero files, so a missing manifest beside real
// clips — which is a genuine defect — is never miscounted as unbuilt.
const failAbsent = (c, msg) => fails.push({ quote: c.quote || '(no quote recorded in the spec)', msg, absent: true });

// -- tiny glob: **/ and * only. Enough for output trees; no dependency. ------------------------
function walk(dir, acc = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc); else acc.push(p);
  }
  return acc;
}
function glob(pattern) {
  const rx = new RegExp('^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*/g, '[^/]*') + '$');
  return walk(ROOT).filter((f) => rx.test(path.relative(ROOT, f))).sort();
}

const ffprobe = (file, args) => {
  try {
    return execFileSync('ffprobe', ['-v', 'error', ...args, '-of', 'default=nw=1', file], { encoding: 'utf8' }).trim();
  } catch { return ''; }
};
const kv = (s) => Object.fromEntries(s.split('\n').filter(Boolean).map((l) => {
  const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)];
}));

// ── PIXELS, WITHOUT A DEPENDENCY ──────────────────────────────────────────────────────────────
// The mechanics checks above can all be answered by ffprobe, which is why the first video spec
// was mechanics-only: a text slide and a product demo have identical metadata. Every DESIGN rule
// needs the actual pixels. ffmpeg will hand them over as raw planar bytes on stdout, so this
// stays a zero-dependency file — no image library, no canvas, no PNG decoder.
//
// `gray` gives one byte per pixel (luma). `rgb24` gives three. Both are decoded at a small
// working size: a design rule is about proportions of the frame, and a 320px-wide decode answers
// every one of them for a fraction of the time a full decode costs.
const RAW_W = 320;

function rawFrames(file, { fps = 10, w = RAW_W, rgb = false, ss = null, frames = null } = {}) {
  const px = rgb ? 3 : 1;
  const args = ['-v', 'error'];
  if (ss != null) args.push('-ss', String(ss));
  args.push('-i', file);
  if (frames != null) args.push('-frames:v', String(frames));
  // scale to a fixed WIDTH and let the height follow the source aspect, so a non-16:9 file is
  // measured as it really is rather than squeezed into an assumption.
  args.push('-vf', `${fps ? `fps=${fps},` : ''}scale=${w}:-2,format=${rgb ? 'rgb24' : 'gray'}`,
    '-f', 'rawvideo', '-');
  let buf;
  try {
    buf = execFileSync('ffmpeg', args, { maxBuffer: 1 << 30, encoding: 'buffer' });
  } catch (e) { throw new Error(`ffmpeg raw decode failed: ${String(e.message).split('\n')[0]}`); }
  // Recover the real frame height from the byte count and the frame count ffprobe reports.
  const v = kv(ffprobe(file, ['-select_streams', 'v:0', '-show_entries', 'stream=width,height']));
  const srcW = +v.width, srcH = +v.height;
  const fh = Math.round(w * srcH / srcW / 2) * 2;
  const stride = w * fh * px;
  if (!stride || buf.length < stride) throw new Error(`raw decode produced ${buf.length} bytes, one frame needs ${stride}`);
  const out = [];
  for (let o = 0; o + stride <= buf.length; o += stride) out.push(buf.subarray(o, o + stride));
  return { frames: out, w, h: fh, px, srcW, srcH };
}

const meanLuma = (f) => { let s = 0; for (let i = 0; i < f.length; i++) s += f[i]; return s / f.length; };

// ── "full-bleed" vs "scaled down inside the frame with dark gutters" ──────────────────────────
// UNIFORM EDGE BANDS, not a content bounding box.
//
// The first version of this measured the bounding box of everything differing from the frame's
// corner colour, and it was WRONG for exactly the material this estate ships. A dark, dense
// product UI has its own near-black page margins: BreachProbe's content column is 1134 of 1280
// CSS px with hatched rails either side, so the box came back at 90.9% of frame width and the
// gate reported a full-bleed film as "inset inside the frame". Notion measured 98% only because
// its UI is white on white — the whole frame is bright.
//
// The defect the plan actually names is a LETTERBOX: "the captured page is scaled to fit inside
// the frame with gutters". A gutter is a band of IDENTICAL ground at the frame edge, spanning the
// full width or height. That is what this measures, at a tight threshold, so a textured rail
// counts as picture and a dead band does not.
function edgeBands(f, w, h, tol = 3) {
  const corner = f[2 * w + 2];
  const uniformRow = (y) => {
    for (let x = 0; x < w; x++) if (Math.abs(f[y * w + x] - corner) > tol) return false;
    return true;
  };
  const uniformCol = (x) => {
    for (let y = 0; y < h; y++) if (Math.abs(f[y * w + x] - corner) > tol) return false;
    return true;
  };
  let top = 0; while (top < h && uniformRow(top)) top++;
  let bottom = 0; while (bottom < h - top && uniformRow(h - 1 - bottom)) bottom++;
  let left = 0; while (left < w && uniformCol(left)) left++;
  let right = 0; while (right < w - left && uniformCol(w - 1 - right)) right++;
  return { top: top / h, bottom: bottom / h, left: left / w, right: right / w,
    fillW: (w - left - right) / w, fillH: (h - top - bottom) / h };
}

const hex2rgb = (s) => {
  const m = String(s).replace('#', '');
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
};
function colourShare(f, [tr, tg, tb], tol) {
  let n = 0, total = f.length / 3;
  for (let i = 0; i < f.length; i += 3) {
    const dr = f[i] - tr, dg = f[i + 1] - tg, db = f[i + 2] - tb;
    if (dr * dr + dg * dg + db * db <= tol * tol) n++;
  }
  return n / total;
}
const frameDelta = (a, b) => {
  let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length;
};

// ── "IS ANYTHING MOVING?" IS AN AREA QUESTION, NOT A MAGNITUDE ONE ────────────────────────────
// Mean absolute delta is dominated by how MUCH of the frame moved, so a caption line swapping or a
// URL arriving — a real, plainly visible event — scores 0.04-0.19 while a card sliding across a
// white workspace scores 3.8. Measured on the finished film: every staged reveal in the end lockup
// registered under the mean-delta threshold and the beat was reported frozen for 5.4s, when three
// separate elements arrive in it.
// The fraction of pixels that CHANGED, each by more than a per-pixel threshold, answers the actual
// question and is invariant to both the ground and the size of the moving thing.
const changedFrac = (a, b, pixEps) => {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > pixEps) n++;
  return n / a.length;
};

// ── A CUT IS A CHANGE NO SHIFT EXPLAINS ───────────────────────────────────────────────────────
// Raw inter-frame change cannot tell a cut from a fast scroll, and this is measured, not argued:
// in the finished film the artifact beat's scroll changed 15.1% of pixels in one 1/20s interval
// while the weakest surface cut changed 10.5%. A threshold on magnitude would have passed a scroll
// as a cut and failed a cut as a dissolve.
// A scroll IS a translation, so shifting one frame onto the other explains almost all of it. A cut
// is not a translation of anything. Searching the shift space and taking the residual separates
// them with room to spare: measured 10.7-17.6% at the five surface seams against 3.4% at the
// busiest in-shot moment in the same film.
function unexplainedByShift(a, b, w, h, pixEps, maxShift) {
  const m = maxShift;
  let best = 1;
  for (let dy = -m; dy <= m; dy++) {
    for (let dx = -m; dx <= m; dx++) {
      let n = 0, total = 0;
      for (let y = m; y < h - m; y++) {
        const ra = y * w, rb = (y + dy) * w + dx;
        for (let x = m; x < w - m; x++) {
          total++;
          if (Math.abs(a[ra + x] - b[rb + x]) > pixEps) n++;
        }
      }
      const v = n / total;
      if (v < best) best = v;
      if (best === 0) return 0;
    }
  }
  return best;
}

// Row-wise ink runs inside a region — one run is one line of text, and its height is the glyph
// extent. This is how "the UI text is below reading size" becomes a number instead of a squint.
function inkRuns(f, w, h, region, inkThresh = 55, minCoverage = 0.004) {
  const x0 = Math.round((region.x0 ?? 0) * w), x1 = Math.round((region.x1 ?? 1) * w);
  const y0 = Math.round((region.y0 ?? 0) * h), y1 = Math.round((region.y1 ?? 1) * h);
  const hist = new Array(32).fill(0);
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) hist[f[y * w + x] >> 3]++;
  const ground = hist.indexOf(Math.max(...hist)) * 8 + 4;
  const cols = Math.max(1, x1 - x0);
  const runs = []; let cur = 0;
  for (let y = y0; y < y1; y++) {
    let n = 0;
    for (let x = x0; x < x1; x++) if (Math.abs(f[y * w + x] - ground) > inkThresh) n++;
    if (n / cols > minCoverage) cur++; else { if (cur) runs.push(cur); cur = 0; }
  }
  if (cur) runs.push(cur);
  return { ground, runs: runs.filter((r) => r >= 2) };
}

// Normalised cross-correlation of a grayscale template over a frame, coarse stride. Enough to
// answer "is the product's own mark on this frame" without pulling in a vision library.
function bestMatch(frame, w, h, tpl, tw, th) {
  const tMean = meanLuma(tpl);
  let tVar = 0; for (let i = 0; i < tpl.length; i++) tVar += (tpl[i] - tMean) ** 2;
  tVar = Math.sqrt(tVar) || 1;
  let best = -1;
  const step = Math.max(1, Math.round(Math.min(tw, th) / 4));
  for (let oy = 0; oy + th <= h; oy += step) {
    for (let ox = 0; ox + tw <= w; ox += step) {
      let sum = 0, n = tw * th;
      for (let y = 0; y < th; y++) { const r = (oy + y) * w + ox; for (let x = 0; x < tw; x++) sum += frame[r + x]; }
      const fMean = sum / n;
      let num = 0, fVar = 0;
      for (let y = 0; y < th; y++) {
        const r = (oy + y) * w + ox, tr = y * tw;
        for (let x = 0; x < tw; x++) {
          const a = frame[r + x] - fMean, b = tpl[tr + x] - tMean;
          num += a * b; fVar += a * a;
        }
      }
      const score = num / ((Math.sqrt(fVar) || 1) * tVar);
      if (score > best) best = score;
    }
  }
  return best;
}
function loadTemplate(file, w) {
  try {
    const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${w}:-2,format=gray`,
      '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26, encoding: 'buffer' });
    const h = buf.length / w;
    if (!Number.isInteger(h)) throw new Error(`template decoded to ${buf.length} bytes, not divisible by width ${w}`);
    return { tpl: buf, tw: w, th: h };
  } catch (e) { throw new Error(`template unreadable (${String(e.message).split('\n')[0]})`); }
}

// Hard cuts, from ffmpeg's own scene detector. Held-shot lengths are the gaps between them.
function cutTimes(file, threshold = 0.30) {
  let out = '';
  try {
    out = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'info', '-i', file,
      '-vf', `select='gt(scene,${threshold})',metadata=print:file=-`, '-an', '-f', 'null', '-'],
    { maxBuffer: 1 << 26, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { out = e.stdout ? String(e.stdout) : ''; }
  return [...out.matchAll(/pts_time:([0-9.]+)/g)].map((m) => +m[1]);
}

// -- the checks --------------------------------------------------------------------------------
const CHECKS = {
  files(c) {
    const f = glob(c.glob);
    if (c.min != null && f.length < c.min) (f.length === 0 ? failAbsent : fail)(c, `${c.glob}: found ${f.length}, spec requires at least ${c.min}`);
    if (c.max != null && f.length > c.max) fail(c, `${c.glob}: found ${f.length}, spec allows at most ${c.max}`);
    if (!f.length && c.min == null) failAbsent(c, `${c.glob}: nothing matched — the gate cannot pass on an empty set`);
    notes.push(`${c.glob} → ${f.length} file(s)`);
  },

  // `optional: true` is for a role that is legitimately absent — one produced PER RELEASE rather
  // than per product, so zero of them is a valid state and not a failure. It only changes the
  // empty-glob case: every file that IS present is checked exactly as hard as before. Without it
  // an optional role cannot be expressed at all, and the only way to ship one is to leave it out
  // of the spec — which is how a format ends up with no gate. Pair it with a `files` check that
  // sets `min: 0`, so the absence is recorded rather than merely tolerated.
  media(c) {
    const files = glob(c.glob);
    if (!files.length && c.optional) { notes.push(`${c.glob} → none present (optional role)`); return; }
    if (!files.length) return failAbsent(c, `${c.glob}: no media to check`);
    for (const f of files) {
      const n = path.relative(ROOT, f);
      const v = kv(ffprobe(f, ['-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,pix_fmt']));
      const fm = kv(ffprobe(f, ['-show_entries', 'format=duration,size']));
      if (!v.width) { fail(c, `${n}: ffprobe read no video stream`); continue; }
      const w = +v.width, h = +v.height;
      const fps = v.r_frame_rate?.includes('/')
        ? +v.r_frame_rate.split('/')[0] / +v.r_frame_rate.split('/')[1] : +v.r_frame_rate;
      const dur = +fm.duration, size = +fm.size;
      const aud = (ffprobe(f, ['-select_streams', 'a', '-show_entries', 'stream=index']).match(/index=/g) || []).length;

      if (c.width && w !== c.width) fail(c, `${n}: width ${w}, spec ${c.width}`);
      if (c.height && h !== c.height) fail(c, `${n}: height ${h}, spec ${c.height}`);
      if (c.fps && Math.abs(fps - c.fps) > 0.51) fail(c, `${n}: ${fps.toFixed(2)}fps, spec ${c.fps}`);
      if (c.pixFmt && v.pix_fmt !== c.pixFmt) fail(c, `${n}: pix_fmt ${v.pix_fmt}, spec ${c.pixFmt}`);
      if (c.audioStreams != null && aud !== c.audioStreams) fail(c, `${n}: ${aud} audio stream(s), spec ${c.audioStreams}`);
      if (c.maxBytes && size > c.maxBytes) fail(c, `${n}: ${(size / 1048576).toFixed(2)}MB, spec max ${(c.maxBytes / 1048576).toFixed(2)}MB`);
      if (c.durationSec) {
        const { min, max } = c.durationSec;
        if (min != null && dur < min - 0.05) fail(c, `${n}: ${dur.toFixed(2)}s, spec min ${min}s`);
        if (max != null && dur > max + 0.05) fail(c, `${n}: ${dur.toFixed(2)}s, spec max ${max}s`);
      }
      notes.push(`${n} → ${w}x${h} ${dur.toFixed(2)}s ${fps.toFixed(0)}fps ${v.pix_fmt} ${aud}a ${(size / 1024).toFixed(0)}KB`);
    }
  },

  // The capture must DECLARE how it was made, and the declaration is checked. This is what makes
  // an invisible process choice (a browser zoom) gateable at all — the pixels cannot be asked.
  sidecar(c) {
    const mf = path.join(ROOT, c.manifest);
    if (!fs.existsSync(mf)) {
      // Absent only if the media it describes is absent too. A manifest missing BESIDE real
      // clips is a real defect and stays a plain violation.
      const report = (c.glob && glob(c.glob).length === 0) ? failAbsent : fail;
      return report(c, `${c.manifest} is missing — the capture did not declare how it was made, so this cannot be verified. An undeclared capture fails closed.`);
    }
    let m; try { m = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch (e) { return fail(c, `${c.manifest}: unreadable (${e.message})`); }
    const got = c.field.split('.').reduce((o, k) => (o == null ? o : o[k]), m);
    if (got === undefined) return fail(c, `${c.manifest}: field "${c.field}" not declared`);
    if (c.equals !== undefined && got !== c.equals) fail(c, `${c.manifest}: ${c.field} = ${JSON.stringify(got)}, spec requires ${JSON.stringify(c.equals)}`);
    notes.push(`${c.manifest}: ${c.field} = ${JSON.stringify(got)}`);
  },

  // Two clips that are the same shot are one clip shipped twice. Compared on real pixels.
  distinct(c) {
    const files = glob(c.glob);
    if (files.length < 2) return;
    const sigs = files.map((f) => {
      const tmp = path.join(process.env.TMPDIR || '/tmp', `pg-${path.basename(f)}.pgm`);
      try {
        execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', f, '-vf', 'scale=32:18,format=gray', '-frames:v', '1', tmp]);
        const b = fs.readFileSync(tmp); fs.rmSync(tmp, { force: true });
        return b.slice(-576);
      } catch { return null; }
    });
    for (let i = 0; i < files.length; i++) for (let j = i + 1; j < files.length; j++) {
      if (!sigs[i] || !sigs[j]) continue;
      let diff = 0;
      for (let k = 0; k < Math.min(sigs[i].length, sigs[j].length); k++) diff += Math.abs(sigs[i][k] - sigs[j][k]);
      const mean = diff / Math.min(sigs[i].length, sigs[j].length);
      if (mean < (c.minMeanDelta ?? 6)) {
        fail(c, `${path.relative(ROOT, files[i])} and ${path.relative(ROOT, files[j])} are the same shot (mean pixel delta ${mean.toFixed(1)} < ${c.minMeanDelta ?? 6})`);
      }
    }
  },

  pairedFile(c) {
    for (const f of glob(c.glob)) {
      const mate = f.replace(/\.[^.]+$/, c.ext);
      if (!fs.existsSync(mate)) fail(c, `${path.relative(ROOT, f)}: required companion ${c.ext} is missing`);
    }
  },

  forbids(c) {
    for (const f of glob(c.glob)) {
      let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
      for (const p of c.patterns || []) {
        if (new RegExp(p, 'i').test(t)) fail(c, `${path.relative(ROOT, f)} contains banned pattern /${p}/i`);
      }
    }
  },

  requires(c) {
    for (const f of glob(c.glob)) {
      let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
      for (const p of c.patterns || []) {
        if (!new RegExp(p, 'i').test(t)) fail(c, `${path.relative(ROOT, f)} is missing required pattern /${p}/i`);
      }
    }
  },

  // ── DESIGN CHECKS ───────────────────────────────────────────────────────────────────────────
  // Everything below reads real pixels. A spec built only from the kinds above cannot tell a
  // product demo from a title slide, which is exactly how a browser rendering an <h1> passed a
  // full video spec. These are the checks that would have failed it.

  // Full-bleed vs "scaled down inside the frame with dark gutters". Sampled across the window
  // named by `window` (fractions of duration) so a legitimately empty title card is not measured
  // as a failed UI shot.
  frameFill(c) {
    for (const f of glob(c.glob)) {
      const n = path.relative(ROOT, f);
      let R; try { R = rawFrames(f, { fps: c.sampleFps ?? 2 }); } catch (e) { fail(c, `${n}: ${e.message}`); continue; }
      const [a, b] = c.window || [0, 1];
      const lo = Math.floor(a * R.frames.length), hi = Math.ceil(b * R.frames.length);
      const sample = R.frames.slice(lo, Math.max(lo + 1, hi));
      // The widest/tallest frame in the window is the one held; the narrow ones are seam frames,
      // where a velocity-matched translate deliberately opens ground at one edge for ~0.3s.
      let bestW = 0, bestH = 0, worstBand = null;
      for (const fr of sample) {
        const e = edgeBands(fr, R.w, R.h, c.uniformTol ?? 3);
        if (e.fillW > bestW) bestW = e.fillW;
        if (e.fillH > bestH) bestH = e.fillH;
        const band = Math.max(e.top, e.bottom, e.left, e.right);
        if (worstBand == null || band < worstBand.band) worstBand = { band, e };
      }
      let worst = null;
      if (c.minFillW && bestW < c.minFillW) worst = `the widest frame in the window still leaves a uniform vertical gutter — picture fills only ${(bestW * 100).toFixed(1)}% of frame width, spec ≥ ${(c.minFillW * 100).toFixed(0)}%`;
      if (!worst && c.minFillH && bestH < c.minFillH) worst = `the tallest frame in the window still leaves a uniform horizontal band — picture fills only ${(bestH * 100).toFixed(1)}% of frame height, spec ≥ ${(c.minFillH * 100).toFixed(0)}%`;
      if (worst) fail(c, `${n}: ${worst} — the shot is letterboxed inside the frame instead of filling it`);
      notes.push(`${n} → picture fills up to ${(bestW * 100).toFixed(1)}% x ${(bestH * 100).toFixed(1)}% of frame `
        + `(thinnest uniform edge band ${(worstBand.band * 100).toFixed(2)}%)`);
    }
  },

  // Mean frame luminance band. A dark, dense product film has a measurable ground; a blown-out
  // stock-video montage or an accidentally white frame does not.
  luminance(c) {
    for (const f of glob(c.glob)) {
      const n = path.relative(ROOT, f);
      let R; try { R = rawFrames(f, { fps: c.sampleFps ?? 2 }); } catch (e) { fail(c, `${n}: ${e.message}`); continue; }
      const ls = R.frames.map(meanLuma);
      const mean = ls.reduce((s, x) => s + x, 0) / ls.length;
      const mn = Math.min(...ls), mx = Math.max(...ls);
      if (c.meanMin != null && mean < c.meanMin) fail(c, `${n}: mean luma ${mean.toFixed(1)}, spec ≥ ${c.meanMin}`);
      if (c.meanMax != null && mean > c.meanMax) fail(c, `${n}: mean luma ${mean.toFixed(1)}, spec ≤ ${c.meanMax}`);
      if (c.frameMax != null && mx > c.frameMax) fail(c, `${n}: a frame reaches luma ${mx.toFixed(1)}, spec ≤ ${c.frameMax} on every frame`);
      notes.push(`${n} → luma mean ${mean.toFixed(1)} (min ${mn.toFixed(1)}, max ${mx.toFixed(1)})`);
    }
  },

  // The accent is a MARK, never a field. Band per frame plus a ceiling on the whole-film median.
  accentShare(c) {
    const target = hex2rgb(c.colour);
    for (const f of glob(c.glob)) {
      const n = path.relative(ROOT, f);
      let R; try { R = rawFrames(f, { fps: c.sampleFps ?? 2, rgb: true }); } catch (e) { fail(c, `${n}: ${e.message}`); continue; }
      const shares = R.frames.map((fr) => colourShare(fr, target, c.tolerance ?? 60));
      const sorted = [...shares].sort((a, b) => a - b);
      const med = sorted[sorted.length >> 1], mx = sorted[sorted.length - 1];
      const anyAbove = shares.some((s) => s >= (c.perFrameMin ?? 0));
      if (c.perFrameMin != null && !anyAbove) fail(c, `${n}: the accent ${c.colour} never reaches ${(c.perFrameMin * 100).toFixed(2)}% of a frame — a film with no accent anywhere is an unfinished frame, not restraint`);
      if (c.perFrameMax != null && mx > c.perFrameMax) fail(c, `${n}: accent peaks at ${(mx * 100).toFixed(2)}% of a frame, spec ≤ ${(c.perFrameMax * 100).toFixed(2)}% — at that share the accent has become the subject`);
      if (c.medianMax != null && med > c.medianMax) fail(c, `${n}: accent median ${(med * 100).toFixed(2)}%, spec ≤ ${(c.medianMax * 100).toFixed(2)}%`);
      notes.push(`${n} → accent ${c.colour} median ${(med * 100).toFixed(2)}%, peak ${(mx * 100).toFixed(2)}%`);
    }
  },

  // A held static frame is detectable, and four static scroll positions held 4-5s each is what
  // this exists to refuse. `maxFrozenSec` is the longest run of consecutive sampled frames whose
  // delta is under `eps`. Calibrated against the reference tier, whose worst case is 2.80s.
  motionFloor(c) {
    const fps = c.sampleFps ?? 10;
    // An interval counts as MOVING when at least `areaEps` of pixels each changed by more than
    // `pixEps` levels. Both are measured, not guessed — see changedFrac() above.
    const pixEps = c.pixEps ?? 24, areaEps = c.areaEps ?? 0.0008;
    const eps = areaEps;
    for (const f of glob(c.glob)) {
      const n = path.relative(ROOT, f);
      let R; try { R = rawFrames(f, { fps, w: c.decodeWidth ?? 640 }); } catch (e) { fail(c, `${n}: ${e.message}`); continue; }
      if (R.frames.length < 3) { fail(c, `${n}: only ${R.frames.length} sampled frame(s) — too short to measure motion`); continue; }
      const deltas = [];
      for (let i = 1; i < R.frames.length; i++) deltas.push(changedFrac(R.frames[i - 1], R.frames[i], pixEps));
      let run = 0, worst = 0, worstEnd = 0;
      deltas.forEach((d, i) => { run = d < eps ? run + 1 : 0; if (run > worst) { worst = run; worstEnd = i; } });
      const frozen = worst / fps;
      const med = [...deltas].sort((a, b) => a - b)[deltas.length >> 1];
      // ⛔ MOVING FRACTION, NOT MEDIAN MAGNITUDE.
      // The median inter-frame delta is a function of the GROUND, not of the motion: the same move
      // on a white UI produces several times the pixel delta it produces on #0a0a0a, because the
      // delta is a contrast measurement. A threshold calibrated on notion.com (median 0.299, white)
      // failed a correct dark film at 0.067 and would have passed a nearly-dead white one. The
      // fraction of sampled intervals in which ANYTHING moves is ground-invariant.
      const moving = deltas.filter((d) => d >= eps).length / deltas.length;
      if (c.maxFrozenSec != null && frozen > c.maxFrozenSec + 1e-9) {
        fail(c, `${n}: frozen for ${frozen.toFixed(2)}s ending at t=${(worstEnd / fps).toFixed(1)}s, spec ≤ ${c.maxFrozenSec}s`);
      }
      if (c.minMovingFrac != null && moving < c.minMovingFrac) {
        fail(c, `${n}: something is moving in only ${(moving * 100).toFixed(1)}% of sampled intervals, spec ≥ ${(c.minMovingFrac * 100).toFixed(0)}% — the film is mostly holding still`);
      }
      notes.push(`${n} → longest frozen run ${frozen.toFixed(2)}s, moving ${(moving * 100).toFixed(1)}% of intervals `
        + `(changed-pixel fraction: median ${(med * 100).toFixed(3)}%, threshold ${(areaEps * 100).toFixed(3)}%)`);
    }
  },

  // Text height as a fraction of frame height, in a named region during a named window. The one
  // number that decides whether a viewer can read the payload at playback size.
  textInk(c) {
    for (const f of glob(c.glob)) {
      const n = path.relative(ROOT, f);
      let R; try { R = rawFrames(f, { fps: c.sampleFps ?? 1, w: c.decodeWidth ?? 960 }); } catch (e) { fail(c, `${n}: ${e.message}`); continue; }
      const [a, b] = c.window || [0, 1];
      const lo = Math.floor(a * R.frames.length), hi = Math.ceil(b * R.frames.length);
      const sample = R.frames.slice(lo, Math.max(lo + 1, hi));
      let best = 0, count = 0;
      for (const fr of sample) {
        const { runs } = inkRuns(fr, R.w, R.h, c.region || {}, c.inkThresh ?? 55);
        if (!runs.length) continue;
        const srt = [...runs].sort((x, y) => x - y);
        const medRun = srt[srt.length >> 1] / R.h;
        if (medRun > best) { best = medRun; count = runs.length; }
      }
      if (!best) { fail(c, `${n}: no text found in the region ${JSON.stringify(c.region)} during ${JSON.stringify(c.window || [0, 1])} — the beat that must be readable has nothing to read`); continue; }
      // A merged blob reads as one very tall "line" and would satisfy a height floor by accident,
      // so the number of separated lines is checked too: real prose in the region, not one smear.
      if (c.minLines != null && count < c.minLines) {
        fail(c, `${n}: only ${count} separated text line(s) in the region, spec ≥ ${c.minLines} — `
          + `a single tall ink run is a merged blob, not readable prose, and it would pass a height floor by accident`);
      }
      if (c.minFracH != null && best < c.minFracH) {
        fail(c, `${n}: tallest median text line is ${(best * 100).toFixed(2)}% of frame height, spec ≥ ${(c.minFracH * 100).toFixed(2)}% (≈${Math.round(c.minFracH * 1080)}px at 1080p)`);
      }
      notes.push(`${n} → text ${(best * 100).toFixed(2)}% of frame height (${count} lines) ≈ ${(best * 1080).toFixed(1)}px at 1080p`);
    }
  },

  // The product's own mark is on the frame. Template correlation against the product's real
  // icon, so a film cannot ship a re-drawn or missing mark.
  markPresent(c) {
    let T; try { T = loadTemplate(path.resolve(ROOT, c.template), c.templateWidth ?? 40); } catch (e) { return fail(c, e.message); }
    for (const f of glob(c.glob)) {
      const n = path.relative(ROOT, f);
      let R; try { R = rawFrames(f, { fps: c.sampleFps ?? 2, w: c.decodeWidth ?? 320 }); } catch (e) { fail(c, `${n}: ${e.message}`); continue; }
      const windows = c.windows || [[0, 1]];
      for (const [a, b] of windows) {
        const lo = Math.floor(a * R.frames.length), hi = Math.ceil(b * R.frames.length);
        const sample = R.frames.slice(lo, Math.max(lo + 1, hi));
        let best = -1;
        for (const fr of sample) {
          const s = bestMatch(fr, R.w, R.h, T.tpl, T.tw, T.th);
          if (s > best) best = s;
        }
        if (best < (c.minScore ?? 0.6)) {
          fail(c, `${n}: the product mark scores ${best.toFixed(3)} at best in ${(a * 100).toFixed(0)}–${(b * 100).toFixed(0)}% of the film, spec ≥ ${c.minScore ?? 0.6}`);
        }
        notes.push(`${n} → mark best score ${best.toFixed(3)} in window ${(a * 100).toFixed(0)}–${(b * 100).toFixed(0)}%`);
      }
    }
  },

  // Cut cadence. The reference tier's product heroes ship ZERO cuts inside a shot; a narrated
  // film cuts between mechanisms. Both bounds matter: too few and it is one long recording, too
  // many and it is a montage. Held-shot length is the gap between detected cuts.
  // ── DECLARED SEAMS, VERIFIED AGAINST THE PIXELS ─────────────────────────────────────────────
  // ffmpeg's scene detector is the wrong instrument for an authored cut. It found ZERO cuts in a
  // film with six hard cuts in it, because a velocity-matched cut between two shots of the SAME
  // dark product UI keeps ~88% of the frame across the boundary — exactly the case this estate
  // ships. So the composition DECLARES its seams and this verifies them: the count, the held-shot
  // lengths, and — the part that makes it a check rather than a formality — that a real
  // discontinuity is present in the pixels at each declared time, and that there is no large
  // undeclared jump anywhere else.
  cutCadence(c) {
    for (const f of glob(c.glob)) {
      const n = path.relative(ROOT, f);
      const dur = +kv(ffprobe(f, ['-show_entries', 'format=duration'])).duration;
      let cuts;
      if (c.declaredIn) {
        const mf = path.join(ROOT, c.declaredIn);
        if (!fs.existsSync(mf)) { fail(c, `${c.declaredIn} is missing — the film declares no seams, so they cannot be verified. An undeclared cut list fails closed.`); continue; }
        let m; try { m = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch (e) { fail(c, `${c.declaredIn}: unreadable (${e.message})`); continue; }
        const got = (c.declaredField || 'seams').split('.').reduce((o, k) => (o == null ? o : o[k]), m);
        if (!Array.isArray(got)) { fail(c, `${c.declaredIn}: "${c.declaredField || 'seams'}" is not an array of cut times`); continue; }
        // A seam may be declared as a bare time or as { t, kind }. `kind: "surface"` means at least
        // one side is a full-frame picture and the pixel test applies. `kind: "type"` means both
        // sides are sparse type on the same ground — two nearly-empty frames differ by ~1% however
        // hard you cut between them (measured: 1.29% at this film's sting→title seam, against 3.40%
        // at its busiest in-shot moment), so no pixel threshold can verify one and this says so
        // instead of pretending otherwise.
        const decl = got.map((x) => (typeof x === 'object' ? x : { t: Number(x), kind: 'surface' }))
          .filter((x) => x.t > 0.05 && x.t < dur - 0.05).sort((a, b) => a.t - b.t);
        cuts = decl.map((x) => x.t);

        const fps = c.verifyFps ?? 20, pixEps = c.pixEps ?? 24;
        const shift = c.maxShiftPx ?? 12;
        let R; try { R = rawFrames(f, { fps, w: c.verifyWidth ?? 320 }); } catch (e) { fail(c, `${n}: ${e.message}`); continue; }
        const jumps = [];
        for (let i = 1; i < R.frames.length; i++) jumps.push(changedFrac(R.frames[i - 1], R.frames[i], pixEps));
        const at = (t) => Math.max(0, Math.min(jumps.length - 1, Math.round(t * fps) - 1));
        const resid = (t, r = 1) => {
          let best = 0;
          for (let i = Math.max(0, at(t) - r); i <= Math.min(jumps.length - 1, at(t) + r); i++) {
            const v = unexplainedByShift(R.frames[i], R.frames[i + 1], R.w, R.h, pixEps, shift);
            if (v > best) best = v;
          }
          return best;
        };
        const minJump = c.minCutJump ?? 0.06;
        const minTypeJump = c.minTypeCutJump ?? 0.004;
        const weak = [];
        for (const d of decl) {
          const v = resid(d.t);
          const floor = d.kind === 'type' ? minTypeJump : minJump;
          if (v < floor) {
            fail(c, `${n}: the ${d.kind} seam declared at ${d.t.toFixed(2)}s leaves only ${(v * 100).toFixed(2)}% of the `
              + `frame unexplained by any ±${shift * (1920 / R.w)}px shift, spec ≥ ${(floor * 100).toFixed(2)}% — `
              + (d.kind === 'type' ? 'nothing changed across it at all' : 'that is a dissolve or a scroll, not a cut'));
          }
          if (d.kind === 'type') weak.push(d.t.toFixed(2));
        }
        // An undeclared cut is a discontinuity nobody meant. Candidates are pre-filtered on raw
        // jump (cheap) and only then confirmed with the shift search (expensive).
        const undeclared = jumps
          .map((v, i) => ({ t: (i + 1) / fps, v }))
          .filter((x) => x.v >= minJump && !cuts.some((t) => Math.abs(t - x.t) < 0.3) && x.t > 0.3 && x.t < dur - 0.3)
          .filter((x) => resid(x.t, 0) >= minJump);
        if (undeclared.length) {
          fail(c, `${n}: ${undeclared.length} undeclared discontinuity(ies), first at ${undeclared[0].t.toFixed(2)}s `
            + `leaving ${(resid(undeclared[0].t, 0) * 100).toFixed(1)}% unexplained by a shift — every cut in the film has to be one the composition meant`);
        }
        const surf = decl.filter((d) => d.kind !== 'type');
        notes.push(`${n} → ${decl.length} declared seam(s); ${surf.length} surface seam(s) verified `
          + `(weakest ${(Math.min(...surf.map((d) => resid(d.t))) * 100).toFixed(1)}% unexplained by a shift, spec ≥ ${(minJump * 100).toFixed(0)}%)`
          + (weak.length ? `; ${weak.length} type seam(s) at [${weak.join(', ')}] checked only for non-zero change — two sparse frames on one ground cannot be pixel-verified` : ''));
      } else {
        cuts = cutTimes(f, c.sceneThreshold ?? 0.30).filter((t) => t > 0.4 && t < dur - 0.4);
      }
      const bounds = [0, ...cuts, dur];
      const holds = bounds.slice(1).map((t, i) => t - bounds[i]);
      if (c.minCuts != null && cuts.length < c.minCuts) fail(c, `${n}: ${cuts.length} cut(s), spec ≥ ${c.minCuts}`);
      if (c.maxCuts != null && cuts.length > c.maxCuts) fail(c, `${n}: ${cuts.length} cut(s), spec ≤ ${c.maxCuts} — this is a montage, not a film`);
      if (c.minHoldSec != null) {
        const tooShort = holds.filter((h) => h < c.minHoldSec - 1e-9);
        if (tooShort.length) fail(c, `${n}: ${tooShort.length} shot(s) held under ${c.minHoldSec}s (shortest ${Math.min(...holds).toFixed(2)}s)`);
      }
      if (c.maxHoldSec != null) {
        const tooLong = holds.filter((h) => h > c.maxHoldSec + 1e-9);
        if (tooLong.length) fail(c, `${n}: ${tooLong.length} shot(s) held over ${c.maxHoldSec}s (longest ${Math.max(...holds).toFixed(2)}s)`);
      }
      notes.push(`${n} → holds [${holds.map((h) => h.toFixed(2)).join(', ')}]`);
    }
  },
};

// -- run ---------------------------------------------------------------------------------------
const checks = spec.checks || [];
if (!checks.length) {
  console.error(`✖ ${path.basename(SPEC_PATH)} declares no checks. A spec that checks nothing is a\n`
    + '  document, not a gate — write the checks or do not claim the output is gated.');
  process.exit(2);
}
for (const c of checks) {
  const fn = CHECKS[c.kind];
  if (!fn) { fails.push({ quote: c.quote || '', msg: `unknown check kind "${c.kind}"` }); continue; }
  try { fn(c); } catch (e) { fail(c, `check threw: ${e.message}`); }
}

console.log(`plan-gate · spec ${path.relative(process.cwd(), SPEC_PATH)}`);
if (spec.source) console.log(`           plan ${spec.source}`);
console.log(`           output ${ROOT}\n`);
for (const n of notes) console.log('  · ' + n);

if (fails.length) {
  const unbuilt = fails.every((f) => f.absent);
  const nAbsent = fails.filter((f) => f.absent).length;
  console.error(`\n✖ ${fails.length} violation(s) — the output does NOT match the approved plan:\n`);
  for (const f of fails) {
    console.error(`  ✖ ${f.msg}${f.absent ? '   [not produced]' : ''}`);
    console.error(`     plan says: "${f.quote}"\n`);
  }
  if (unbuilt) {
    console.error(`Nothing here ships — and every one of these ${fails.length} is "this was never produced",`);
    console.error('not "this was produced wrong". The spec is ahead of its lane. Exit 3.');
    process.exit(3);
  }
  console.error(`Nothing here ships. Fix the output, or change the plan in the open and say so.`
    + (nAbsent ? ` (${fails.length - nAbsent} wrong, ${nAbsent} not produced.)` : ''));
  process.exit(1);
}
console.log(`\n✔ ${checks.length} check(s) passed — output matches the approved plan.`);
