#!/bin/bash
# run.sh — the whole suite. Zero dependencies; runs from a clean clone with nothing installed.
#
#   bash test/run.sh
#
# The invariant tests below are not decoration. Each one asserts a claim this project makes in
# its README, and the claims are all of the same shape: THERE IS NO INPUT THAT TURNS A FAILURE
# INTO A PASS. A test suite that only proved the happy path would leave every one of them
# unchecked, which is precisely the failure mode the project exists to talk about.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

PASS=0; FAIL=0
ok()  { echo "  ok    $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
# exits <label> <want> <cmd...>
exits() {
  local label=$1 want=$2; shift 2
  "$@" >/dev/null 2>&1
  local got=$?
  if [ "$got" = "$want" ]; then ok "$label"; else bad "$label (exit $got, want $want)"; fi
}

EX=examples/api-docs
SPEC=$EX/plan.spec.json
TMP=$(mktemp -d -t deferless-test)
trap 'rm -rf "$TMP"' EXIT

echo "== plan-gate =="
exits "output matching the plan passes"            0 node src/plan-gate.mjs "$SPEC" "$EX/passing"
exits "output violating the plan fails"            1 node src/plan-gate.mjs "$SPEC" "$EX/failing"
exits "a missing spec cannot pass"                 2 node src/plan-gate.mjs "$TMP/nope.json" "$EX/passing"

# ⛔ A spec that declares no checks is a document, not a gate. It must not read as clean.
echo '{"source":"x","checks":[]}' > "$TMP/empty.json"
exits "a spec with no checks is not a pass"        2 node src/plan-gate.mjs "$TMP/empty.json" "$EX/passing"

# ⛔ An unknown kind is a violation, not a skip: a typo in a spec must never silently stop
#    enforcing the sentence it was written for.
echo '{"source":"x","checks":[{"kind":"filez","glob":"docs/*.md","quote":"q"}]}' > "$TMP/typo.json"
exits "an unknown check kind fails"                1 node src/plan-gate.mjs "$TMP/typo.json" "$EX/passing"

# Nothing produced yet is its own exit code — reportable as unbuilt from outside, still non-zero.
echo '{"source":"x","checks":[{"kind":"files","glob":"dist/*.js","min":1,"quote":"q"}]}' > "$TMP/unbuilt.json"
exits "an unbuilt lane exits 3, not 0"             3 node src/plan-gate.mjs "$TMP/unbuilt.json" "$TMP"

echo "== promote-gate =="
mkdir -p "$TMP/repo"
exits "no config is not a pass"                    2 node src/promote-gate.mjs --repo "$TMP/repo"
echo '{"gates":[]}' > "$TMP/repo/deferless.json"
exits "a config with no gates is not a pass"       2 node src/promote-gate.mjs --repo "$TMP/repo"
# ⛔ A gate whose file has been moved or renamed must FAIL, never silently stop running.
echo '{"gates":[{"name":"ghost","run":["node","gates/gone.mjs"]}]}' > "$TMP/repo/deferless.json"
exits "a missing gate file fails"                  1 node src/promote-gate.mjs --repo "$TMP/repo" --url http://127.0.0.1:1
# A gate that runs and passes, against a URL supplied directly (no server to start).
mkdir -p "$TMP/repo/gates"
echo 'process.exit(0)' > "$TMP/repo/gates/green.mjs"
echo '{"gates":[{"name":"green","run":["node","gates/green.mjs","{url}"]}]}' > "$TMP/repo/deferless.json"
exits "a clean gate promotes"                      0 node src/promote-gate.mjs --repo "$TMP/repo" --url http://127.0.0.1:1
echo 'process.exit(1)' > "$TMP/repo/gates/red.mjs"
echo '{"gates":[{"name":"red","run":["node","gates/red.mjs","{url}"]}]}' > "$TMP/repo/deferless.json"
exits "a failing gate blocks the promote"          1 node src/promote-gate.mjs --repo "$TMP/repo" --url http://127.0.0.1:1

echo "== render-gate =="
# Playwright is optional, so this asserts the ONE thing that must hold either way: it never
# reports a pass it did not earn. With a browser it measures the page; without one it exits 2.
node src/render-gate.mjs "https://example.com/" >/dev/null 2>&1
RG=$?
if [ "$RG" = 0 ] || [ "$RG" = 1 ]; then ok "render gate ran against a real page (exit $RG)"
elif [ "$RG" = 2 ]; then ok "render gate reports 'could not run' (exit 2), not a pass — playwright absent"
else bad "render gate returned an undefined exit ($RG)"; fi

echo "== cli =="
exits "demo self-verifies both trees"              0 node bin/deferless.mjs demo
exits "unknown command is an error"                2 node bin/deferless.mjs frobnicate
exits "help works"                                 0 node bin/deferless.mjs --help
( cd "$TMP" && node "$ROOT/bin/deferless.mjs" init >/dev/null 2>&1 )
[ -f "$TMP/deferless.json" ] && ok "init writes a config" || bad "init writes a config"
exits "init refuses to overwrite"                  2 sh -c "cd '$TMP' && node '$ROOT/bin/deferless.mjs' init"

echo "== deploy gate =="
bash test/deploy-gate.test.sh > "$TMP/dg.log" 2>&1
DG=$?
tail -1 "$TMP/dg.log"
[ "$DG" = 0 ] && ok "deploy-gate suite (bash + zsh)" || { bad "deploy-gate suite"; cat "$TMP/dg.log"; }

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ] || exit 1
