# Plan — public API reference, v2

**Status: approved.** This is the plan the work was signed off against. The spec beside it
(`plan.spec.json`) quotes these sentences verbatim, so a violation is reported in the plan's own
words rather than the gate's.

## Scope

Ship **exactly three endpoint pages: orders, refunds and webhooks.** Nothing else goes in this
release — a fourth page is scope we did not agree, and a missing one is a hole in the reference.

## Per page

Every endpoint page carries a **runnable `curl` example** against the public host. A reference
page a reader cannot copy a working call out of is a page that has not done its job.

Every endpoint page ships with a **matching `.json` schema file beside it**, same basename. The
schema is what the client generators read; a page without one is undocumented to every machine
consumer even though it looks complete to a human.

## Naming

**No page mentions the internal service name `billing-core`.** It was renamed before launch and
the old name is not ours to publish — it appears in internal traces, dashboards and one very
old runbook, so it leaks into generated copy constantly.

## Provenance

The build **declares the commit it was generated from** in `build.json`, under `sourceCommit`.
Docs that cannot name their source revision cannot be audited later.
