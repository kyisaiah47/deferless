# Principles

Five rules. They are not style preferences — every one of them is the fix for a specific way a
gate stopped working while continuing to print green.

---

## 1. There is no `--force`, no allowlist and no known-issues file

Each of those is a supported way to record a failure and ship past it.

That is not a slippery-slope argument, it is what the artifacts are *for*. A known-issues file is
a place to write down a real defect and then deploy. An allowlist is a place to name the check
that is currently inconvenient. A `--force` flag is used exactly once as an emergency and then
lives in the deploy script forever, and after a month nobody remembers which failures it is
covering.

The moment any of them exists, the gate stops being a gate and becomes a log. A check that can be
told to stop mattering **has been taught to be ignored.**

There are two exits from a failing gate, and they are the only two:

- **The check is right.** Fix the output.
- **The check is wrong.** Fix the check, in the open, as a commit with a reason — so the next
  person sees that the rule changed and why, instead of finding a flag.

If neither is possible today, the honest state is *"this does not ship today."* That is allowed to
be the answer.

## 2. A missing gate is a failure, not a skip

```sh
[ -f ./gates/render.mjs ] && node ./gates/render.mjs    # ⛔
```

This is how a check silently stops running. Someone moves the file, renames the directory,
restructures the repo — and every deploy afterwards still prints OK. **A check that cannot see
anything is indistinguishable, in the output, from a check that found nothing wrong.**

Same shape, same bug: a dependency that is optional at runtime and reports "skipped ✓" when
absent. Absent means *could not check*, and could-not-check is never a pass.

## 3. Zero checks run is not a pass

If every gate went missing, the honest answer is "I could not check". A run that verified nothing
and exits 0 is worse than no run at all, because it is quoted afterwards as evidence.

Both `plan-gate` and `promote-gate` exit 2 if they end up having checked nothing — including the
case where the spec parsed fine and simply declared no checks. **A spec that checks nothing is a
document, not a gate.**

## 4. "Could not run" is its own exit code, and never collapses into 0 — or into 1

| | |
|---|---|
| `0` | checked, clean |
| `1` | checked, violates |
| `2` | could not check |

Collapsing `2` into `0` is the bug in rule 2 and 3. Collapsing `2` into `1` is subtler and was
live in this repo until the test suite caught it: a typo in a spec path reported the same code as
a genuine violation, so a caller that only distinguishes zero from non-zero would have read a
missing file as a real finding, chased it, and lost trust in the gate.

## 5. The gate runs BEFORE the promote, never after

This is the one that actually stops findings being handed to a human, and it is not about
discipline at all — it is about ordering.

Run the checks after the deploy has landed and a finding arrives when the work is already live.
At that moment, writing it up genuinely *is* the only remaining move. The deferral was baked into
the script before anyone made a decision.

Move the identical checks in front of the promote and the identical finding blocks instead of
annotates. Nothing about the check changed. Nobody had to be more disciplined.

**Where the same failure has happened twice, the fix is never a stronger rule. It is a gate that
fails closed, positioned where the failure would otherwise be convenient.**

---

## What this costs

A fail-closed gate with no override will, at some point, block something you are sure is fine, at
a bad time. That is the price, it is real, and it is worth paying — but the honest version of this
project says it out loud rather than pretending the tradeoff does not exist.

What makes it affordable is that the escape hatch is *fix the check in the open*, and that is
usually a two-minute commit. What makes it necessary is that every cheaper escape hatch turns out,
within a month, to be the mechanism by which nobody looks at the gate any more.
