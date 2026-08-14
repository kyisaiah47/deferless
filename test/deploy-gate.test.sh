#!/bin/bash
# deploy-gate.test.sh — regression tests for the deploy gate.
#
# Run after ANY edit to sh/deploy-lock.sh:   bash test/deploy-gate.test.sh
#
# Every test runs the gate under BOTH #!/bin/bash and #!/bin/zsh, because real repos have deploy
# scripts with both shebangs and the worst bug this gate has had so far was invisible in bash:
# zsh scopes a `trap ... EXIT` set inside a FUNCTION to that function, so installing the release
# trap inside _dl_take deleted the lock the instant it was taken. Two deploys then ran straight
# through each other while the code looked completely correct.
set -uo pipefail

LIB="$(cd "$(dirname "$0")/.." && pwd)/sh/deploy-lock.sh"
[ -f "$LIB" ] || { echo "cannot find sh/deploy-lock.sh next to this test"; exit 2; }
TMP=$(mktemp -d "${TMPDIR:-/tmp}/deploygate.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()   { echo "  ok    $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got [$2], want [$3])"; fi; }

mkfake() { # mkfake <shell> <path> <repo>
  cat > "$2" <<EOF
#!$1
set -euo pipefail
. "$LIB" || { echo "GATE-MISSING"; exit 1; }
deploy_gate "$3"
echo "DEPLOYED"
EOF
  chmod +x "$2"
}

for SH in /bin/bash /bin/zsh; do
  NAME=$(basename "$SH")
  echo "== $NAME =="
  D="$TMP/$NAME"; mkdir -p "$D/socks" "$D/home"
  export DEFERLESS_DEPLOY_HOME="$D/home" DEFERLESS_SOCK_DIR="$D/socks"
  unset DEFERLESS_DEPLOY_LOCK_TOKEN
  rm -rf "$D/home"; mkdir -p "$D/home"
  mkfake "$SH" "$D/dep.sh" demo

  # 1. No peers (no peer sockets at all) — deploys.
  check "no peers deploys" "$("$D/dep.sh" 2>/dev/null)" "DEPLOYED"

  # 2. Empty and missing socket dirs must not abort the script. zsh aborts on a glob that
  #    matches nothing, which is why the library uses `ls` instead of a pattern.
  DEFERLESS_SOCK_DIR="$D/socks" "$D/dep.sh" >/dev/null 2>&1 && ok "empty socket dir survives" || bad "empty socket dir survives"
  DEFERLESS_SOCK_DIR="$D/nope" "$D/dep.sh" >/dev/null 2>&1 && ok "missing socket dir survives" || bad "missing socket dir survives"

  # 3. A busy peer session — must DEFER: no build, exit 0, repo registered pending.
  #    The fake peer needs a real controlling TTY: the gate deliberately ignores socket owners
  #    without one, because those are headless `claude -p` lanes that fire constantly and would
  #    keep things looking busy forever. `script` allocates a pty for its child, which is the
  #    only cheap way to produce a process that looks like an operator's terminal tab. The
  #    test harness itself has no tty, so faking the peer as $$ tested nothing.
  # A pty is the only cheap way to make a process that looks like an operator's terminal tab.
  # BSD `script` takes the file then the command; GNU takes -c command then the file.
  if script -q /dev/null true >/dev/null 2>&1; then
    script -q /dev/null sh -c 'sleep 25' >/dev/null 2>&1 &
  else
    script -q -c 'sleep 25' /dev/null >/dev/null 2>&1 &
  fi
  SCRIPT_PID=$!
  sleep 1
  PEER=$(ps -eo pid,ppid,tty,command | awk -v s="$SCRIPT_PID" '$2==s && $3!="??" {print $1}' | head -1)
  if [ -z "$PEER" ]; then
    bad "could not allocate a pty-backed fake peer — tests 3-5 skipped"
  else
    : > "$D/socks/$PEER.sock"
    mkdir -p "$D/home/session-activity"; : > "$D/home/session-activity/$PEER"
    out=$(CLAUDE_PID=0 "$D/dep.sh" 2>/dev/null)
    check "busy peer defers (no build)" "$out" ""
    [ -f "$D/home/deploy-pending/demo" ] && ok "defer registers pending" || bad "defer registers pending"
    CLAUDE_PID=0 "$D/dep.sh" >/dev/null 2>&1 && ok "defer exits 0" || bad "defer exits 0"

    # 4. DEPLOY_NOW overrides the deferral.
    check "DEPLOY_NOW overrides" "$(DEPLOY_NOW=1 CLAUDE_PID=0 "$D/dep.sh" 2>/dev/null)" "DEPLOYED"

    # 5. Excluding yourself: the only session working is the caller, so it is not a peer.
    check "own session is not a peer" "$(CLAUDE_PID=$PEER "$D/dep.sh" 2>/dev/null)" "DEPLOYED"

    # 6. A session that has exited stops counting, and its stamp is reaped.
    kill "$SCRIPT_PID" 2>/dev/null; wait "$SCRIPT_PID" 2>/dev/null
    sleep 1
    check "dead session is not a peer" "$(CLAUDE_PID=0 "$D/dep.sh" 2>/dev/null)" "DEPLOYED"
    [ -f "$D/home/session-activity/$PEER" ] && bad "dead session stamp reaped" || ok "dead session stamp reaped"
    rm -f "$D/socks/$PEER.sock"
  fi
  rm -rf "$D/home/deploy-pending"; mkdir -p "$D/home/deploy-pending"

  # 6. THE MUTEX. No peers, two deploys at once — the second must wait for the first.
  #    This is the test the zsh function-scoped-trap bug failed.
  cat > "$D/slow.sh" <<EOF
#!$SH
set -euo pipefail
. "$LIB"
deploy_gate slowrepo
echo "SLOW-IN \$(date +%s)"
[ -d "\$DEFERLESS_DEPLOY_LOCK_DIR" ] || echo "LOCK-VANISHED-ON-ACQUIRE"
sleep 6
echo "SLOW-OUT \$(date +%s)"
EOF
  chmod +x "$D/slow.sh"
  rm -rf "$D/home/deploy.lock"
  ( "$D/slow.sh" > "$D/slow.out" 2>&1 ) &
  sleep 2
  [ -d "$D/home/deploy.lock" ] && ok "lock survives acquire" || bad "lock survives acquire"
  "$D/dep.sh" > "$D/fast.out" 2>/dev/null
  wait
  grep -q "LOCK-VANISHED-ON-ACQUIRE" "$D/slow.out" && bad "lock not deleted by its own trap" || ok "lock not deleted by its own trap"
  s_out=$(sed -n 's/SLOW-OUT //p' "$D/slow.out")
  f_at=$(stat -f %m "$D/fast.out" 2>/dev/null || stat -c %Y "$D/fast.out")
  [ "$f_at" -ge "$s_out" ] && ok "second deploy waited for the first" || bad "second deploy waited for the first"

  # 7. Lock released after the holder exits.
  [ -d "$D/home/deploy.lock" ] && bad "lock released on exit" || ok "lock released on exit"

  # 8. A dead holder's lock is stolen rather than starving everyone forever.
  mkdir -p "$D/home/deploy.lock"
  printf 'pid=999999\nname=zombie\nlabel=product\nstartedh=old\n' > "$D/home/deploy.lock/holder"
  echo tok > "$D/home/deploy.lock/token"
  touch -t 202601010000 "$D/home/deploy.lock/heartbeat"
  check "dead holder is stolen" "$("$D/dep.sh" 2>/dev/null)" "DEPLOYED"

  # 9. A LIVE holder whose heartbeat went cold is stolen too (wedged deploy).
  mkdir -p "$D/home/deploy.lock"
  printf "pid=$$\nname=wedged\nlabel=product\nstartedh=old\n" > "$D/home/deploy.lock/holder"
  echo tok > "$D/home/deploy.lock/token"
  touch -t 202601010000 "$D/home/deploy.lock/heartbeat"
  check "cold heartbeat is stolen" "$("$D/dep.sh" 2>/dev/null)" "DEPLOYED"

  # 10. Re-entrancy: a batch pass holds the lock and invokes a repo's own deploy.sh.
  rm -rf "$D/home/deploy.lock"
  cat > "$D/batch.sh" <<EOF
#!$SH
set -euo pipefail
. "$LIB"
deploy_gate batch-pass batch
"$D/dep.sh"
EOF
  chmod +x "$D/batch.sh"
  check "estate pass re-enters" "$("$D/batch.sh" 2>/dev/null)" "DEPLOYED"

  # 11. A product deploy fired while a batch pass holds the lock registers and exits, rather
  #     than queueing behind the whole run to rebuild what the pass is about to build.
  rm -rf "$D/home/deploy.lock" "$D/home/deploy-pending"
  mkdir -p "$D/home/deploy.lock" "$D/home/deploy-pending"
  printf "pid=$$\nname=deploy-all\nlabel=estate\nstartedh=now\n" > "$D/home/deploy.lock/holder"
  echo tok > "$D/home/deploy.lock/token"; touch "$D/home/deploy.lock/heartbeat"
  check "estate in flight -> defer" "$("$D/dep.sh" 2>/dev/null)" ""
  [ -f "$D/home/deploy-pending/demo" ] && ok "estate deferral registers pending" || bad "estate deferral registers pending"
  rm -rf "$D/home/deploy.lock"

  # 12. THE HEARTBEAT MUST OUTLIVE THE DEPLOY THAT OWNS IT, AND NOTHING MAY MISTAKE IT FOR A
  #     SECOND DEPLOY. On 2026-08-14 machine-guard's singleton rule SIGKILLed it about a minute
  #     into every deploy: `( … ) &` inherits its parent's argv verbatim, so the heartbeat prints
  #     as `/bin/zsh ./scripts/deploy.sh` in the deploy's own cwd and looked like a duplicate run.
  #     The build carried on with a cold lock and the next deploy stole it out from under a live
  #     build — rulestack and stacktab both died that way and stayed silently in the pending list.
  #     A dead heartbeat is invisible from inside deploy-lock.sh, which is why this test drives a
  #     real run from a real `scripts/deploy.sh` path and then asks the reaper what it would do.
  rm -rf "$D/home/deploy.lock" "$D/home/deploy-pending"
  mkdir -p "$D/repo/scripts"
  cat > "$D/repo/scripts/deploy.sh" <<EOF
#!$SH
set -uo pipefail
. "$LIB"
deploy_gate demo-hb
sleep 26
echo "HB-AGE \$(( \$(date +%s) - \$(stat -f %m "$D/home/deploy.lock/heartbeat" 2>/dev/null || stat -c %Y "$D/home/deploy.lock/heartbeat") ))"
EOF
  chmod +x "$D/repo/scripts/deploy.sh"
  ( cd "$D/repo" && ./scripts/deploy.sh > "$D/hb.out" 2>/dev/null ) &
  HBRUN=$!
  sleep 12
  wait "$HBRUN"
  AGE=$(sed -n 's/HB-AGE //p' "$D/hb.out" 2>/dev/null)
  # touched every 20s, so 26s into a run the newest touch is at most ~21s old.
  if [ -n "$AGE" ] && [ "$AGE" -le 21 ]; then ok "heartbeat still beating 26s into a deploy"
  else bad "heartbeat still beating 26s into a deploy (age=${AGE:-none})"; fi
  rm -rf "$D/home/deploy.lock"

  # 13. A DEPLOY THAT SHIPPED IS NOT STILL PENDING. Only deploy-all.sh ever cleared these, so a
  #     repo deferred once stayed in the queue forever: every DEPLOY_NOW run after it shipped for
  #     real and left the entry sitting there. On 2026-08-14 that put thirteen repos in the list,
  #     several of them already live, and made "still pending" read as "never shipped" when it only
  #     ever meant "was deferred at least once". A queue that cannot be trusted as evidence is
  #     worse than no queue, because it is quoted as one.
  rm -rf "$D/home/deploy.lock"
  mkdir -p "$D/home/deploy-pending"
  printf 'requested earlier\n' > "$D/home/deploy-pending/demo"
  check "successful deploy still deploys" "$("$D/dep.sh" 2>/dev/null)" "DEPLOYED"
  [ -f "$D/home/deploy-pending/demo" ] && bad "successful deploy clears its pending entry" \
                                       || ok "successful deploy clears its pending entry"

  # …but a FAILED build is still owed, so its entry must survive.
  rm -rf "$D/home/deploy.lock"
  cat > "$D/depfail.sh" <<EOF
#!$SH
set -uo pipefail
. "$LIB"
deploy_gate demo
echo "BUILD-FAILED"
exit 1
EOF
  chmod +x "$D/depfail.sh"
  printf 'requested earlier\n' > "$D/home/deploy-pending/demo"
  "$D/depfail.sh" >/dev/null 2>&1
  [ -f "$D/home/deploy-pending/demo" ] && ok "failed deploy keeps its pending entry" \
                                       || bad "failed deploy keeps its pending entry"
  rm -rf "$D/home/deploy.lock" "$D/home/deploy-pending"
done

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ] || exit 1
