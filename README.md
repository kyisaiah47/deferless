# deferless

> **deferless now runs [ShipProbe](https://github.com/kyisaiah47/shipprobe).** ShipProbe replaces
> leakless, stubless, glanceless and deferless with one CLI and one GitHub Action. `shipprobe plan`
> replaces `deferless check`. `shipprobe promote` replaces `deferless promote`. `shipprobe page`
> replaces `deferless render`. The deferless command still works. Since version 0.2.0, it forwards
> each command to shipprobe and keeps the same exit codes. New work happens in ShipProbe, documented
> at [shipprobe.thecompound.tech](https://shipprobe.thecompound.tech/plan). The code from before
> ShipProbe is at tag [v0.1.1](https://github.com/kyisaiah47/deferless/tree/v0.1.1).

[![gates](https://github.com/kyisaiah47/deferless/actions/workflows/ci.yml/badge.svg)](https://github.com/kyisaiah47/deferless/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/deferless.svg)](https://www.npmjs.com/package/deferless)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![dependencies: 1](https://img.shields.io/badge/dependencies-1-blue.svg)](package.json)
[![AGENTS.md](https://toolproof.thecompound.tech/badge/rulestack/kyisaiah47/deferless.svg)](https://rulestack.thecompound.tech)

<sub>The last one is a live third-party score of this repo's [AGENTS.md](AGENTS.md), re-read
nightly. Until that crawl reaches a repository this new, it reports ****not indexed****. That
is the correct output. An unmeasured subject renders as unmeasured, never as a pass. This
follows the same rule as [[exit code 2](docs/PRINCIPLES.md)](docs/PRINCIPLES.md).</sub>

****Fail-closed gates for work an AI agent did on your behalf.**** The plan cannot be quietly
changed, and findings cannot be deferred to you.

The CLI has no `--force`, allowlist or known-issues file. Each option would record a failure and
let the output ship. These gates prevent that behavior.

```
npx deferless demo
```

---

## What this checks

A coding agent follows a plan for about ninety minutes. It then encounters an unanticipated case
and invents a local fix. The fix can build and render without errors. The output can look
correct. The agent has still contradicted one sentence in the plan, and the contradiction remains
in the document and the shell.

Your pipeline cannot detect this case. Tests pass because the agent wrote working code. Lint
passes because the code is clean. CI is green. You detect the problem only by inspecting the
output days later and finding that it is zoomed in.

The agent can also find a real defect and report it as *"one thing I deliberately left alone."*
It saves itself two minutes and spends twenty of yours. You must read the finding, decide what to
do, and issue an instruction that was already clear.

Both are the same bug. ****A rule stated in prose is checked by the same judgement that
just
decided to break it.**** So these gates do not ask. They remove the state that made the
deviation possible, and they exit non-zero.

## Output example

`npx deferless demo` prints the actual output below. The example contains two directories of
API documentation. Both directories build. Both directories render. An agent produced one
directory from an approved plan.

```
✖ 5 violation(s) — the output does NOT match the approved plan:

  ✖ docs/*.md: found 2, spec requires at least 3
     plan says: "Ship exactly three endpoint pages: orders, refunds and webhooks."

  ✖ docs/refunds.md is missing required pattern /curl -/i
     plan says: "Every endpoint page carries a runnable curl example against the public host."

  ✖ docs/orders.md: required companion .json is missing
     plan says: "Every endpoint page ships with a matching .json schema file beside it, same basename."

  ✖ docs/refunds.md contains banned pattern /billing-core/i
     plan says: "No page mentions the internal service name billing-core."

  ✖ build.json: field "sourceCommit" not declared
     plan says: "The build declares the commit it was generated from in build.json, under sourceCommit."

Nothing here ships. Fix the output, or change the plan in the open and say so.
```

The system reports every violation ****in the plan's own words****, not the gate's. The spec
format gives each check the sentence it enforces. A failure therefore quotes text that a human
approved instead of reporting an error from a linter nobody remembers configuring.

## Install

```sh
npx deferless demo            # no install, runs the example above
npm i -D deferless            # in a project
```

Node 20+. The one runtime dependency is shipprobe, which runs every check. Playwright is an
optional peer, needed only by `deferless render`.

## The four gates

### 1. `deferless check` checks the plan

`deferless check` converts an approved plan into output checks. You write a `spec.json` beside
the plan. The file contains one check for each binding sentence. The `quote` field stores that
sentence verbatim.

```jsonc
{
  "source": "docs/plans/api-reference.md",
  "checks": [
    { "kind": "files",      "glob": "docs/*.md", "min": 3, "max": 3,
      "quote": "Ship exactly three endpoint pages: orders, refunds and webhooks." },
    { "kind": "requires",   "glob": "docs/*.md", "patterns": ["curl -"],
      "quote": "Every endpoint page carries a runnable curl example." },
    { "kind": "forbids",    "glob": "**/*.md",   "patterns": ["billing-core"],
      "quote": "No page mentions the internal service name billing-core." }
  ]
}
```

```sh
deferless check plan.spec.json ./out
```

The package includes fourteen check kinds. Six read the filesystem: `files`, `requires`,
`forbids`, `pairedFile`, `sidecar` and `media`. Eight use ffmpeg to decode ****real
pixels**** from video: frame fill, luminance band, accent-colour share, motion floor, text
ink height, mark presence by cross-correlation, cut cadence against declared seams and shot
distinctness.

That second group exists because the first version of this was metadata-only, and **a browser
rendering a single `<h1>` passed every check in a full video spec.** A text slide and a product
demo have identical `ffprobe` output. Every threshold in the pixel checks is calibrated against
measurements taken off real reference material, not guessed — the numbers and their provenance
are in the source, beside the check they govern.

Read the full reference in ****[docs/SPEC.md](docs/SPEC.md)****.

### 2. `deferless promote` blocks deferrals

The system runs every gate you declare ****against a local production build, before anything is promoted.****

The script's ordering enabled the behavior described as "I'll report it instead of fixing
it." The deploy script ran its live checks after the deploy landed. The work was live when
the finding appeared. Writing up the finding was then the only remaining action. The script
made deferral part of the deployment process.

The promote step runs the checks first. The same finding then blocks the promote instead of adding an annotation.

```sh
deferless init          # writes deferless.json
deferless promote       # serves the production build, runs every gate, exits 1 on any finding
```

Two invariants, both tested: **a missing gate file is a failure, not a skip** — a renamed check
that silently stops running is indistinguishable from a check that found nothing wrong. And
**zero gates run is not a pass** — if nothing could be checked, the honest answer is "I could not
check", never "clean".

### 3. `deferless render` checks the rendered page

Every other gate reads source. All of them passed when a landing page shipped with an invisible
hero: the `<h1>` held its animation start frame at `opacity: 0.001`, permanently. The element
was in the DOM, at the right size, the right colour, and the right position. ****There is
no
string to grep for that.**** Rendering the page and measuring its pixels is the only way to
detect it.

This gate does not read a file. It takes a URL and drives a real browser. It checks conditions
that a screenshot can answer and grep cannot:

| | |
|---|---|
| **visible** | is text that occupies space actually painted? (effective opacity, whole ancestor chain multiplied) |
| **contrast** | does every text run clear WCAG against its *computed* background? |
| **overflow** | does the page scroll horizontally at any width from 320 to 1920? |
| **wrap** | does any nav link, footer link or CTA label break onto a second line? |
| **fold** | at 1280×800, are the headline and the primary CTA both above the fold? |
| **clipped** | is content trapped past the *start* edge of its own scroll container, where no scroll position can reach it? |
| **nested** | does every nested scroll region actually scroll when a real wheel is driven over it? |

```sh
npm i -D playwright && npx playwright install chromium
deferless render https://example.com/ --sample 6
deferless render ./dist/index.html --shots shots/
```

The `--shots <dir>` option saves a full-page PNG at each width it renders. Each file is named
`<width>.png`. Pictures are taken only at 1280px and wider. The folder gets `1280.png` and
`1920.png` by default. deferless 0.1 also saved `320.png`, `375.png`, `414.png` and `768.png`.
The run still measures those widths. The run no longer captures those widths. The run prints a
note that names them. A picture that cannot be saved exits 2.

`--sample N` reads the site's `sitemap.xml`. It selects up to N interior pages, with one page
for each distinct first path segment. A sitemap with four thousand `/kit/<slug>` URLs
contributes one page. The sample therefore covers page *types* instead of N near-identical rows.

### 4. `deferless deploy-gate` coordinates multi-agent deploys

A POSIX shell library handles the case where ****several agent sessions are editing the same
tree at
once.****

A deploy does not run while other sessions are working. The gate registers the deploy as
pending and exits. After all sessions become idle, one pass ships every pending deploy once.

The gate defers deploys instead of queuing them. A queued deploy would build a tree that three
other sessions are still editing. That build could ship stale before it finishes. Ten sessions
would produce ten builds of the same repository, although only the last build would matter.

```sh
. node_modules/deferless/sh/deploy-lock.sh
deploy_gate my-app

DEPLOY_NOW=1 ./scripts/deploy.sh    # ship now regardless
```

The gate identifies a peer session by finding interactive Claude Code control sockets
(`/tmp/cc-socks/*.sock`, configurable). It counts only sockets with a TTY. A headless `claude
-p` lane fires constantly and would keep the tree busy forever. The gate uses a mutex with a
heartbeat. It steals the mutex after the heartbeat goes cold. A lock without expiry can strand
a fleet for two days.

The suite contains 46 regression tests under ****both bash and zsh****. Bash did not expose the
worst bug. In zsh, a `trap ... EXIT` set inside a function applies to that function. The release
trap inside the acquire helper therefore deleted the lock immediately after acquisition. Two
deploys then ran concurrently while the code appeared correct.

## Exit codes

| | |
|---|---|
| `0` | clean |
| `1` | the output violates something that was agreed |
| `2` | **the gate could not run** — never collapses into 0 |
| `3` | every violation was "this was never produced" (see [docs/SPEC.md](docs/SPEC.md)) |

`2` reports that the gate could not check the output. "I could not check" and "I checked and
it was fine" are different results. A pipeline that renders both results as green teaches
itself to ignore the gate.

## Run the tests

```sh
git clone https://github.com/kyisaiah47/deferless && cd deferless
npm install
bash test/run.sh
```

The suite asserts the claims this README makes — that a spec with no checks
cannot pass, that an unknown check kind fails rather than skips, that a missing gate file fails,
that an unreadable spec exits 2 and not 1, that the demo's passing tree passes and its failing
tree fails. Those tests exist because **a test suite that only proves the happy path leaves every
one of those claims unchecked**, which is the same failure this project is about.

## Honest limitations

- ****The spec is written by hand.**** The package does not infer checks from prose. The gate is
  only as complete as the sentences you encode. A plan with three binding sentences and a
  one-check spec leaves two-thirds of the plan ungated.
- ****It gates output, not intent.**** An agent can satisfy every check and still build the
  wrong thing. The gate narrows the gap between "approved" and "shipped"; it does not close
  it.
- ****The pixel checks need ffmpeg**.** Their thresholds are calibrated for dark, dense product
  UI. Recalibrate them against your own reference material instead of using the defaults. The
  source records the origin of every number.
- ****The browser gate needs Playwright**.** It takes real seconds per page.
- ****The deploy gate is macOS/Linux shell**** and detects Claude Code sessions specifically.
  You can configure the socket directory. Other agent runners need a small patch.

## Why the name is deferless

Deferless checks two failures: deviation occurs when an agent does not follow the agreed work,
and deferral occurs when an agent returns a finding it could have fixed. A deferral can look like
diligence because the agent returns a finding it could have fixed.

## Prior art and differences

Agent guardrails form a growing set of pre-action authorization plugins, policy gateways,
runtime interception, and approval steps in front of every tool call. These mechanisms run
**before** the agent acts and answer whether an action is allowed.

These gates run **after** the agent acts. They determine whether the resulting artifact matches
the agreed work and whether the agent left a finding unresolved. Pre-action policy cannot answer
those questions because every individual action was allowed.

## Contributing

New check kinds are the most useful contribution. See
[[CONTRIBUTING.md](CONTRIBUTING.md)](CONTRIBUTING.md). One rule governs every patch: ****nothing
may be added that lets a known failure ship.**** The project has no `--force`, allowlist,
known-issues file, or "warn instead of fail" toggle on an existing check. Fix an incorrect check
in the open. See [[docs/PRINCIPLES.md](docs/PRINCIPLES.md)](docs/PRINCIPLES.md).

## The defect class these gates address, counted

A census published the same week as this repo measured ****445,348 published Claude Code
artefacts and found 43,199 of
them fail a structural check****. A YAML block that does not parse
caused 88.4% of those failures. The publishing path performs no check for this failure.

- [The census links to its dataset DOI: [The
  census](https://toolproof.thecompound.tech/census) and
  [[10.5281/zenodo.21936490](https://doi.org/10.5281/zenodo.21936490)](https://doi.org/10.5281/zenodo.21936490),
  CC BY 4.0.
- [The [Measurement vocabulary](https://toolproof.thecompound.tech/methodology/vocabulary) covers
  load rate, drift, shipping status, and skill decay.
- [[Toolproof](https://toolproof.thecompound.tech) provides the indexes used for the census.

The census and these gates address the same problem from opposite ends. The census counts
artefacts that were published broken. These gates refuse to publish that kind of artefact.

## Licence

MIT. Built and used in production by [Compound Labs](https://thecompound.tech).

These gates run against a live estate of ~35 products. The deviation, deferral, invisible hero,
ten-stale-builds problem, and zsh trap bug are real incidents from that estate. The source
comments name the date and measurement for each incident.
