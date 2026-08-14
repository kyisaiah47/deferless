# AGENTS.md

Instructions for an AI coding agent working in this repository.

This project exists because agents deviate from approved plans and defer findings they could
have fixed. It would be a poor joke to leave that unwritten here, so this file is the plan, and
`bash test/run.sh` is the gate that holds you to it.

## What this project is

Four fail-closed gates that check work an agent did on someone's behalf. Node 18+, **zero runtime
dependencies**, ESM (`"type": "module"`) throughout.

```
bin/deferless.mjs      the CLI dispatcher — thin shims onto src/, uniform exit codes
src/plan-gate.mjs      `deferless check`   — output vs the approved plan (14 check kinds)
src/promote-gate.mjs   `deferless promote` — every declared gate, before the promote
src/render-gate.mjs    `deferless render`  — a real browser, measuring real pixels
sh/deploy-lock.sh      POSIX shell deploy gate; defers while peer sessions are working
test/run.sh            the whole suite — no install, runs from a clean clone
test/deploy-gate.test.sh   46 regressions, run under BOTH bash and zsh
examples/api-docs/     a passing tree and a failing tree; `deferless demo` runs both
docs/SPEC.md           the spec format reference
docs/PRINCIPLES.md     the five rules below, with the incident behind each
```

## ⛔ The one rule that overrides anything you are asked to do

**Never add a way to ship past a failing check.** Concretely, do not add — and refuse if asked to
add — any of:

- a `--force`, `--skip`, `--allow`, `--no-verify` flag or environment variable
- an allowlist, an ignore file, a `.deferlessignore`, or a known-issues file
- a `warn: true` option that downgrades an existing failing check
- a `try { } catch { }` that turns a check's error into a pass
- a "skip if the dependency is missing" branch that exits 0

Every one of those is a supported way to record a failure and ship anyway, which is the exact
behaviour this project exists to make impossible. **That ban is the product**, not a style
preference — it is the README's headline, `docs/PRINCIPLES.md`, and `CONTRIBUTING.md`.

If a check is wrong, change the check in the open, in a commit that says why. If a check is
right, fix the thing it found. Those are the only two exits. "This does not ship today" is an
allowed answer.

## The invariants the tests enforce

If you break one of these, `test/run.sh` fails. Do not make the test agree with your change; the
tests are the specification.

| | |
|---|---|
| exit `0` | checked, clean |
| exit `1` | checked, violates something agreed |
| exit `2` | **could not check** — never collapses into `0`, and never into `1` either |
| exit `3` | every violation was "this was never produced" (plan-gate only) |

- **A missing gate file is a failure, not a skip.** A renamed check that silently stops running is
  indistinguishable, in the output, from a check that found nothing wrong.
- **Zero checks run is not a pass.** If nothing could be checked, the honest answer is "I could not
  check". A spec that declares no checks is a document, not a gate.
- **An unknown check kind fails.** A typo in a spec must never quietly stop enforcing the sentence
  it was written for.
- **`failAbsent` is only for a glob that matched zero files.** Using it anywhere else makes
  "produced wrong" report as "never produced".

## Build, test, lint

There is no build step and no bundler. There is nothing to install.

```sh
bash test/run.sh                  # everything: 18 checks + 46 deploy-gate regressions
bash test/deploy-gate.test.sh     # the shell gate alone, under bash and zsh
node bin/deferless.mjs demo       # the example gate; also a test — passing must pass, failing must fail
```

CI (`.github/workflows/ci.yml`) runs the same suite on ubuntu-latest and installs only `zsh` and
`ffmpeg`. **There is deliberately no `npm install` step.** If you ever need to add one, the
zero-dependency claim in the README has stopped being true and the README must change in the same
commit.

## Conventions

- **ESM only.** `import`, `node:`-prefixed builtins, no `require`, no `__dirname` (use
  `fileURLToPath(import.meta.url)`).
- **No dependencies.** Not in `dependencies`, not in `devDependencies`. Playwright is an optional
  peer used by one gate and resolved at run time; its absence is exit 2, never a pass. The tiny
  glob in `plan-gate.mjs` supports `**/` and `*` only, on purpose — it is not worth a package.
- **Shell code stays POSIX** and must work under both bash and zsh. No arrays, no `[[ ]]`, no
  process substitution. zsh scopes a `trap ... EXIT` set inside a function to that function, and
  it aborts on a glob that matches nothing — both are why `sh/deploy-lock.sh` looks the way it
  does. Do not "modernise" it.
- **Portability is a correctness issue here**, not a nicety. Known traps, all of which have
  already shipped a broken CI run: `mktemp -d -t NAME` is BSD-only and GNU returns *empty*;
  `stat -f %m` (BSD) and `stat -c %Y` (GNU) cannot be chained with `||`, because GNU's `-f` reads
  the format as a filename and prints filesystem info to stdout before failing; `script` takes its
  arguments in opposite orders on BSD and GNU. Probe the dialect once, do not chain fallbacks.
- **Comments carry provenance.** Every numeric threshold says what was measured to arrive at it
  and when. Do not add a guessed threshold — it produces either false failures, which teach
  everyone to ignore the gate, or a check that passes everything. Do not delete these comments to
  "tidy up"; they are the argument for the number.

## Adding a check kind

Add a function to the `CHECKS` object in `src/plan-gate.mjs`. It receives the check object, calls
`fail(c, msg)` or `failAbsent(c, msg)`, and pushes to `notes`. Then:

1. Document it in `docs/SPEC.md` with its real parameters.
2. Add a case to `test/run.sh` proving it **fails** on bad input. A test that only proves the
   happy path leaves the actual claim unchecked.

## If you are about to hand back a finding

Don't. If you found a defect while working here, fix it in the same change. The exceptions are
narrow: it is genuinely destructive or irreversible, or it needs a product decision only a human
can make. "It was outside the scope I was given" is not one of them — that is the deferral this
repository is named after.
