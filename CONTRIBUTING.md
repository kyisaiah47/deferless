# Contributing

New check kinds are the most useful contribution. A check kind is a function in the `CHECKS`
object in `src/plan-gate.mjs`; there is no plugin system and no registry to update.

## The one rule that governs every patch

**Nothing may be added that lets a known failure ship.** Concretely, a PR is declined if it adds:

- a `--force`, `--skip`, `--allow` or equivalent flag
- an allowlist, an ignore file, or a known-issues file
- a `warn: true` option that downgrades an existing failing check
- a "skip if the dependency is missing" branch that exits 0

If a check is wrong, the fix is to change the check and say why in the commit. That is a feature,
not friction — see [docs/PRINCIPLES.md](docs/PRINCIPLES.md).

## Writing a check kind

```js
myCheck(c) {
  const files = glob(c.glob);
  if (!files.length) return failAbsent(c, `${c.glob}: nothing matched`);
  for (const f of files) {
    if (/* it violates */ false) fail(c, `${path.relative(ROOT, f)}: what is wrong, concretely`);
  }
  notes.push(`${c.glob} → ${files.length} file(s)`);
}
```

- `fail(c, msg)` — a violation on output that exists.
- `failAbsent(c, msg)` — **only** where the glob matched zero files. This drives exit 3. Using it
  for anything else makes "produced wrong" report as "never produced".
- The message must say what is wrong in concrete terms, with a measured value where there is one.
  The plan's own sentence is printed underneath it automatically from `quote`.

## Thresholds

If your check has a numeric threshold, the comment above it must say **what was measured to
arrive at that number, and when**. A guessed threshold produces either false failures — which
teach everyone to ignore the gate — or a check that passes everything.

## Tests

Every check kind needs a case in `test/run.sh` proving it **fails** on bad input. A test that only
proves the happy path leaves the actual claim unchecked.

```sh
bash test/run.sh        # zero dependencies, runs from a clean clone
```

Shell changes must pass under both bash and zsh — `test/deploy-gate.test.sh` runs the whole suite
twice for a reason, and the reason is in its header.
