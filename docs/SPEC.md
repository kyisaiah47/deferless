# The spec format

A spec is one JSON file, written by hand, living beside the plan it enforces.

```jsonc
{
  "source": "docs/plans/api-reference.md",   // the plan this was lifted from
  "outputDir": "./out",                      // optional; the CLI argument wins
  "checks": [ /* one entry per binding sentence */ ]
}
```

Run it:

```sh
deferless check plan.spec.json ./out
```

## Two rules about the file itself

**`source` must point at a durable, tracked path.** Not a scratch directory, not a desktop. On
2026-08-14 every plan cited from a desktop copy was deleted at once, and four live specs were
left quoting documents that no longer existed anywhere on disk. A spec whose plan cannot be
opened is a gate nobody can argue with, which sounds strong and is the opposite.

**`quote` is not documentation.** It is the sentence from the plan that the check enforces, and
it is what gets printed on failure. The point is that a violation is reported as a quote from
something a human approved, rather than as an error from a linter nobody remembers configuring.
A check with no quote still runs; it just reports itself as `(no quote recorded in the spec)`,
which is a smell.

## Exit codes

| | |
|---|---|
| `0` | every check passed |
| `1` | at least one check failed on output that exists |
| `2` | the spec could not be read, declared no checks, or nothing could be checked |
| `3` | **every** violation was "this glob matched zero files" |

`3` is a reporting split, not an escape hatch. A spec written before its lane exists fails every
check for a reason that is not a defect: nothing has been produced yet. A spec whose lane *has*
run and produced the wrong thing fails too. Both stay non-zero — there is no flag that makes
either one green. What `3` adds is only the ability to tell them apart **from outside**, so a
runner enumerating many specs can report an unbuilt lane as unbuilt instead of as a red run.

`absent` is set only where the glob matched **zero** files, so a missing manifest sitting beside
real output — a genuine defect — is never miscounted as unbuilt.

## Globs

`**/` and `*` only, deliberately. No dependency, no `.gitignore` semantics, no negation. Paths are
relative to the output directory.

---

## Structural checks

These are answerable from the filesystem and `ffprobe`. They need nothing installed except
ffmpeg for `media`.

### `files` — how many

```jsonc
{ "kind": "files", "glob": "docs/*.md", "min": 3, "max": 3, "quote": "..." }
```

`min` / `max`, both optional. With neither, an empty match still fails: a check that matched
nothing has not verified anything.

### `requires` — the text must contain

```jsonc
{ "kind": "requires", "glob": "docs/*.md", "patterns": ["curl -", "Authorization"], "quote": "..." }
```

Patterns are case-insensitive regexes, tested against each matching file's text. **Every** pattern
must appear in **every** matched file.

### `forbids` — the text must not contain

```jsonc
{ "kind": "forbids", "glob": "**/*.md", "patterns": ["billing-core", "TODO"], "quote": "..." }
```

The mirror of `requires`. This is the one that catches a renamed internal service, a placeholder
that shipped, a vertical qualifier in outward copy, a leaked hostname.

### `pairedFile` — nothing ships alone

```jsonc
{ "kind": "pairedFile", "glob": "docs/*.md", "ext": ".json", "quote": "..." }
```

Every match must have a companion with the same basename and the given extension. A page without
its schema, a clip without its poster frame.

### `sidecar` — the output declares how it was made

```jsonc
{ "kind": "sidecar", "glob": "clips/*.mp4", "manifest": "capture.json",
  "field": "captureScale", "equals": 1, "quote": "..." }
```

Reads `manifest` (dotted paths supported in `field`) and optionally asserts `equals`. **An
undeclared capture fails closed**: if the manifest is missing while the output it describes
exists, that is a violation, not an absence.

This is the check that catches the class of deviation nothing else can see — a value the
producer chose at runtime that leaves no trace in the artifact. A browser zoom of 1.45× produces
a perfectly valid video file. The only way to gate it is to make the producer write down what it
did and then check the number.

### `media` — the file's mechanics

```jsonc
{ "kind": "media", "glob": "clips/*.mp4",
  "width": 1280, "height": 720, "fps": 30, "pixFmt": "yuv420p",
  "audioStreams": 0, "maxBytes": 2097152,
  "durationSec": { "min": 4, "max": 6 },
  "optional": true, "quote": "..." }
```

All fields optional. `optional: true` is for a role that is legitimately absent — one produced per
release rather than per item — and changes **only** the empty-glob case. Every file that is
present is checked exactly as hard as before.

---

## Pixel checks

Everything below decodes real frames through ffmpeg (`rawvideo` on stdout — no image library, no
canvas, no PNG decoder) at a small working width, because a design rule is about proportions of
the frame.

They exist because the structural checks above **cannot tell a product demo from a title slide**.
A browser rendering a single `<h1>` has the same `ffprobe` output as a full screen capture, and
it passed an entire mechanics-only video spec.

Every threshold shipped here was measured off real reference material. The measurements and their
dates are in the source, beside the check they govern — **recalibrate them against your own
references rather than trusting the defaults.**

### `frameFill` — full-bleed, not letterboxed

```jsonc
{ "kind": "frameFill", "glob": "film/*.mp4", "window": [0.2, 0.8],
  "minFillW": 0.96, "minFillH": 0.90, "uniformTol": 3, "sampleFps": 2 }
```

Measures **uniform edge bands**, not a content bounding box. The bounding-box version was wrong
for exactly the material it was written for: a dark, dense UI has its own near-black page margins,
so the box came back at 90.9% of frame width and the gate called a full-bleed film "inset". A
gutter is a band of *identical* ground spanning the full width or height. That is what this
measures, so a textured rail counts as picture and a dead band does not.

### `luminance` — there is a ground

```jsonc
{ "kind": "luminance", "glob": "film/*.mp4", "meanMin": 12, "meanMax": 40, "frameMax": 200 }
```

Mean frame luma band. A dark dense product film has a ground; a stock montage does not.

### `accentShare` — the accent is a mark, never a field

```jsonc
{ "kind": "accentShare", "glob": "film/*.mp4", "colour": "#95c2ff", "tolerance": 28,
  "perFrameMin": 0.0005, "perFrameMax": 0.08, "medianMax": 0.02 }
```

Fraction of pixels within `tolerance` of the accent colour. Bounded on **both** sides: absent is a
failure too. Real product pages measure 0.01–0.55%; the most colour-forward clip in the reference
tier peaks at 7.8%.

### `motionFloor` — it moves, and it does not freeze

```jsonc
{ "kind": "motionFloor", "glob": "film/*.mp4", "maxFrozenSec": 2.5, "minMovingFrac": 0.30,
  "pixEps": 24, "areaEps": 0.0008 }
```

An interval is MOVING when at least `areaEps` of pixels each changed by more than `pixEps` levels.
An **area** test, not a mean-magnitude one: mean delta is dominated by how much of the frame
moved, and scored every staged reveal in an end lockup as frozen.

### `textInk` — the type is big enough to read

```jsonc
{ "kind": "textInk", "glob": "film/*.mp4", "window": [0.75, 0.95],
  "region": { "x0": 0.2, "x1": 0.8, "y0": 0.2, "y1": 0.8 },
  "minFracH": 0.0145, "minLines": 1, "inkThresh": 55 }
```

Median text-line ink height as a fraction of frame height, inside a region and a time window.

### `markPresent` — it carries its own mark

```jsonc
{ "kind": "markPresent", "glob": "film/*.mp4", "template": "assets/mark.png",
  "windows": [[0, 0.12], [0.88, 1]], "minScore": 0.6, "templateWidth": 48 }
```

Normalised cross-correlation of a template against sampled frames, so an artifact cannot ship a
re-drawn mark or none at all.

### `cutCadence` — the cuts are real and the holds are in range

```jsonc
{ "kind": "cutCadence", "glob": "film/*.mp4",
  "declaredIn": "film/capture.json", "declaredField": "seams",
  "minCuts": 4, "maxCuts": 14, "minHoldSec": 2.2, "maxHoldSec": 13, "minCutJump": 0.18 }
```

The composition **declares** its seams; this verifies each is a real discontinuity in the pixels,
that no undeclared discontinuity exists, and that the held-shot lengths are in range.

ffmpeg's own scene detector found **zero** cuts in a film with six, because a velocity-matched cut
between two shots of the same dark UI keeps about 88% of the frame. Omit `declaredIn` to fall back
to scene detection and accept that limitation.

### `distinct` — two clips are not one clip shipped twice

```jsonc
{ "kind": "distinct", "glob": "clips/*.mp4", "minMeanDelta": 6 }
```

Compares a 32×18 grayscale signature of the first frame of every pair.

---

## Adding a kind

Add a function to the `CHECKS` object in `src/plan-gate.mjs`. It receives the check object, calls
`fail(c, msg)` for a violation or `failAbsent(c, msg)` for "the glob matched nothing", and pushes
anything worth showing onto `notes`.

Two things it must not do: pass when it could not run, and accept any option whose effect is to
suppress a failure. See [PRINCIPLES.md](PRINCIPLES.md).
