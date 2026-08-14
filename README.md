# deferless

**Fail-closed gates for work an AI agent did on your behalf.** A plan it cannot quietly deviate
from, and findings it cannot defer to you.

There is no `--force`, no allowlist and no known-issues file. That is not an oversight — each of
those is a supported way to record a failure and ship past it, which is the exact behaviour these
gates exist to make impossible.

```
npx deferless demo
```

---

## The thing this is actually about

A coding agent will follow a plan for about ninety minutes. Then it hits something the plan did
not anticipate, invents a local fix, and the local fix is fine — it builds, it renders, nothing
errors, the output looks completely correct. The one sentence in the plan it just contradicted is
in a document, and the problem is right here in the shell.

Nothing in your pipeline can tell. Tests pass, because the agent wrote code that works. Lint
passes, because the code is clean. CI is green. You are the only detector, and you find out by
looking at the output days later and going *"wait, why is it zoomed in?"*

The second half is worse, because it is polite. The agent finds a real defect while working, and
hands it to you written up: *"one thing I deliberately left alone."* It saved itself two minutes
and spent twenty of yours — you now have to read the finding, decide, and re-issue an instruction
that was already obvious.

Both are the same bug. **A rule stated in prose is checked by the same judgement that just
decided to break it.** So none of these gates ask. They remove the state that made the deviation
possible, and they exit non-zero.

## What it looks like

Here is the actual output of `npx deferless demo`. Two directories of API documentation. Both
build. Both render. One of them was produced by an agent working from an approved plan.

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

Every violation is reported **in the plan's own words**, not the gate's. That is the whole design
of the spec format: each check carries the sentence it enforces, so a failure is a quote from
something a human approved rather than an error from a linter nobody remembers configuring.

## Install

```sh
npx deferless demo            # no install, runs the example above
npm i -D deferless            # in a project
```

Node 18+. **Zero runtime dependencies.** Playwright is an optional peer, needed only by the
browser gate; everything else runs on a bare node with nothing installed.

## The four gates

### 1. `deferless check` — the plan gate

Turns an approved plan into something that can refuse output. You write a `spec.json` beside the
plan, with one check per binding sentence, and the `quote` field holds that sentence verbatim.

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

Fourteen check kinds ship. Six are answerable from the filesystem (`files`, `requires`,
`forbids`, `pairedFile`, `sidecar`, `media`). Eight decode **real pixels** out of video with
ffmpeg — frame fill, luminance band, accent-colour share, motion floor, text ink height,
mark presence by cross-correlation, cut cadence against declared seams, shot distinctness.

That second group exists because the first version of this was metadata-only, and **a browser
rendering a single `<h1>` passed every check in a full video spec.** A text slide and a product
demo have identical `ffprobe` output. Every threshold in the pixel checks is calibrated against
measurements taken off real reference material, not guessed — the numbers and their provenance
are in the source, beside the check they govern.

Full reference: **[docs/SPEC.md](docs/SPEC.md)**.

### 2. `deferless promote` — the no-deferrals gate

Runs every gate you declare **against a local production build, before anything is promoted.**

The enabling mechanic for "I'll report it instead of fixing it" was never laziness — it was
ordering. The deploy script ran its live checks *after* the deploy had already landed. By the
time a finding appeared, the work was live, so writing it up genuinely was the only remaining
move. The deferral was baked into the script.

Move the checks in front of the promote and the same finding blocks instead of annotates.

```sh
deferless init          # writes deferless.json
deferless promote       # serves the production build, runs every gate, exits 1 on any finding
```

Two invariants, both tested: **a missing gate file is a failure, not a skip** — a renamed check
that silently stops running is indistinguishable from a check that found nothing wrong. And
**zero gates run is not a pass** — if nothing could be checked, the honest answer is "I could not
check", never "clean".

### 3. `deferless render` — the gate that opens the page

Every other gate reads source. All of them passed on the day a landing page shipped with an
invisible hero: the `<h1>` held its animation start frame at `opacity: 0.001`, permanently. The
element was in the DOM, at the right size, the right colour, the right position. **There is no
string to grep for that.** The only way to know is to render the page and measure the pixel.

So this one never reads a file. It takes a URL, drives a real browser, and asks the questions a
screenshot answers and a grep cannot:

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
```

`--sample N` reads the site's own `sitemap.xml` and takes up to N interior pages, one per
distinct first path segment — so a sitemap with four thousand `/kit/<slug>` URLs contributes one
of them, and the sample is a tour of page *types* rather than N near-identical rows.

### 4. `deferless deploy-gate` — the multi-agent deploy gate

A POSIX shell library for the case where **several agent sessions are editing the same tree at
once.**

A deploy fired while other sessions are still working does not deploy. It registers as pending
and exits. When everything actually goes quiet, one pass ships everything pending, once.

It defers rather than queues, deliberately: a queued deploy builds a tree that three other
sessions are still editing, ships it, and is stale before it finishes. Ten sessions produce ten
builds of the same repo and only the last was ever worth running.

```sh
. node_modules/deferless/sh/deploy-lock.sh
deploy_gate my-app

DEPLOY_NOW=1 ./scripts/deploy.sh    # ship now regardless
```

It counts a session as a peer by looking for interactive Claude Code control sockets
(`/tmp/cc-socks/*.sock`, configurable), and only ones with a TTY — a headless `claude -p` lane
fires constantly and would keep things looking busy forever. Underneath the deferral is a mutex
with a heartbeat, stolen once the heartbeat goes cold, because a lock with no expiry is how you
strand a fleet for two days.

46 regression tests, run under **both bash and zsh** — the worst bug this gate ever had was
invisible in bash: zsh scopes a `trap ... EXIT` set inside a function to that function, so
installing the release trap inside the acquire helper deleted the lock the instant it was taken.
Two deploys then ran straight through each other while the code looked completely correct.

## Exit codes

| | |
|---|---|
| `0` | clean |
| `1` | the output violates something that was agreed |
| `2` | **the gate could not run** — never collapses into 0 |
| `3` | every violation was "this was never produced" (see [docs/SPEC.md](docs/SPEC.md)) |

`2` is the one that matters. "I could not check" and "I checked and it was fine" are different
answers, and a pipeline that renders them both as green has taught itself to ignore the gate.

## Running the tests

```sh
git clone https://github.com/kyisaiah47/deferless && cd deferless
bash test/run.sh
```

Nothing to install. The suite asserts the claims this README makes — that a spec with no checks
cannot pass, that an unknown check kind fails rather than skips, that a missing gate file fails,
that an unreadable spec exits 2 and not 1, that the demo's passing tree passes and its failing
tree fails. Those tests exist because **a test suite that only proves the happy path leaves every
one of those claims unchecked**, which is the same failure this project is about.

## Honest limitations

- **The spec is written by hand.** Nothing here infers checks from prose, and the gate is only as
  good as the sentences you chose to encode. A plan with three binding sentences and a
  one-check spec is two-thirds ungated.
- **It gates output, not intent.** An agent can satisfy every check and still build the wrong
  thing. This narrows the gap between "approved" and "shipped"; it does not close it.
- **The pixel checks need ffmpeg**, and their thresholds are calibrated for dark, dense product
  UI. Recalibrate them against your own reference material rather than trusting the defaults —
  the source says where every number came from.
- **The browser gate needs Playwright** and takes real seconds per page.
- **The deploy gate is macOS/Linux shell** and detects Claude Code sessions specifically. The
  socket directory is configurable; other agent runners need a small patch.

## Why it is called deferless

The two failures it was built against are *deviation* — the agent quietly not doing what was
agreed — and *deferral* — the agent handing back a finding it could have fixed. The second one is
the one nobody talks about, because it arrives looking like diligence.

## Prior art, and what is different

There is a real and growing shelf of agent guardrails: pre-action authorization plugins, policy
gateways, runtime interception, approval steps in front of every tool call. Those all sit
**before** the agent acts, and they answer *is this action allowed*.

These gates sit **after**, and answer a different question: *does the artifact that came out match
the thing we agreed to build, and did anything get quietly left behind on the way.* No amount of
pre-action policy answers that, because every individual action was allowed.

## Contributing

New check kinds are the most useful contribution — see [CONTRIBUTING.md](CONTRIBUTING.md). One
rule governs every patch: **nothing may be added that lets a known failure ship.** No `--force`,
no allowlist, no known-issues file, no "warn instead of fail" toggle on an existing check. If a
check is wrong, fix the check in the open. See [docs/PRINCIPLES.md](docs/PRINCIPLES.md).

## Licence

MIT. Built and used in production by [Kynth Studios](https://kynth.studio).

These gates run against a live estate of ~35 products — the deviation, the deferral, the
invisible hero, the ten-stale-builds problem and the zsh trap bug are all real incidents from it,
and the comments in the source name the date and the measurement for each one.
