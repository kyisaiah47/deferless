#!/bin/sh
# deploy-lock.sh — THE ESTATE DEPLOY GATE.
#
# ⛔ Every scripts/deploy.sh in the estate sources this and calls `deploy_gate <repo>` before it
# builds anything.
#
# ── THE RULE ────────────────────────────────────────────────────────────────
#   A deploy fired while OTHER Claude sessions are still working does not deploy.
#   It registers the repo as pending and exits. When every session actually goes quiet,
#   deploy-watch fires ONE deploy-all pass that ships everything pending, once.
#
# ── WHY NOT JUST SERIALIZE ──────────────────────────────────────────────────
# The first version of this file was a plain mutex: parallel deploys queued up and went one at a
# time. That design was killed on sight, correctly — "if there are parallel sessions
# working, it doesn't even make sense to deploy serially. More updates will come after a session
# deploys." A queued deploy builds a tree that three other sessions are still editing, ships it,
# and is stale before it finishes. Ten sessions produce ten builds of the same repo and only the
# last one was ever worth running. So the gate DEFERS rather than queues: no build, no Vercel
# upload, no wasted 90 seconds, and the work still ships — in the one pass at the end.
#
# ── WHAT COUNTS AS A SESSION ────────────────────────────────────────────────
# Claude Code opens a control socket per session at /tmp/cc-socks/<pid>.sock. A session with a
# TTY is one of the operator's terminal tabs; one without is a headless `claude -p` lane (a
# reply judge, an image classifier) and is NOT a peer — those fire constantly and would keep the
# estate looking busy forever. A tabbed session counts as WORKING while it has a bash-tool
# subprocess running, and stays counted for DEFERLESS_SESSION_QUIET seconds after its last one, so a
# gap for thinking or a long file edit does not read as "done".
#
# ── THE MUTEX IS STILL HERE ─────────────────────────────────────────────────
# Deferral is the policy; the lock underneath is the backstop, for the case where the estate is
# quiet and two things still try to deploy in the same second. It carries a HEARTBEAT and is
# stolen once that goes cold — see the chromed spawn lock that stranded twelve daemons for two
# days because its lock had no expiry. Same bug class, deliberately not repeated.
#
# ── USAGE ───────────────────────────────────────────────────────────────────
#   . "$(npm root)/deferless/sh/deploy-lock.sh"      # or vendor the file into your repo
#   deploy_gate myrepo          # defers, or takes the lock and returns
#
#   DEPLOY_NOW=1 ./scripts/deploy.sh    ship right now regardless of who else is working
#
# Sourced by deploy scripts with both #!/bin/bash and #!/bin/zsh shebangs, so this file stays
# POSIX: no arrays, no [[ ]], no process substitution.
#
# ── KNOBS ───────────────────────────────────────────────────────────────────
#   DEPLOY_NOW=1               bypass the deferral (still takes the mutex)
#   DEFERLESS_SESSION_QUIET=300    seconds a session stays "working" after its last bash call
#   DEFERLESS_DEPLOY_STALE=600     seconds without a heartbeat before the lock is declared dead
#   DEFERLESS_DEPLOY_WAIT=1800     max seconds to queue on the mutex before giving up (exit 75)
#   DEFERLESS_SOCK_DIR             where session sockets live (tests only)

DEFERLESS_DEPLOY_HOME="${DEFERLESS_DEPLOY_HOME:-$HOME/.deferless}"
DEFERLESS_DEPLOY_LOCK_DIR="${DEFERLESS_DEPLOY_LOCK_DIR:-$DEFERLESS_DEPLOY_HOME/deploy.lock}"
DEFERLESS_DEPLOY_PENDING="${DEFERLESS_DEPLOY_PENDING:-$DEFERLESS_DEPLOY_HOME/deploy-pending}"
DEFERLESS_DEPLOY_STATE="${DEFERLESS_DEPLOY_STATE:-$DEFERLESS_DEPLOY_HOME/deploy-state}"
DEFERLESS_SESSION_ACT="${DEFERLESS_SESSION_ACT:-$DEFERLESS_DEPLOY_HOME/session-activity}"
DEFERLESS_DEPLOY_LOG="${DEFERLESS_DEPLOY_LOG:-$DEFERLESS_DEPLOY_HOME/deploy-gate.log}"
DEFERLESS_SESSION_QUIET="${DEFERLESS_SESSION_QUIET:-300}"
DEFERLESS_DEPLOY_STALE="${DEFERLESS_DEPLOY_STALE:-600}"
DEFERLESS_DEPLOY_WAIT="${DEFERLESS_DEPLOY_WAIT:-1800}"

mkdir -p "$DEFERLESS_DEPLOY_HOME" "$DEFERLESS_DEPLOY_PENDING" "$DEFERLESS_DEPLOY_STATE" "$DEFERLESS_SESSION_ACT" 2>/dev/null || true

# Script-level, never function-local: an EXIT trap firing on a function-local trips `unbound
# variable` under `set -u`, which is how the chromed spawn lock leaked in the first place.
_DL_HELD=""
_DL_TOKEN=""
_DL_HB_PID=""
_DL_NAME=""
_DL_LABEL=""

_dl_now() { date +%s; }
_dl_stamp() { date '+%Y-%m-%d %H:%M:%S'; }
_dl_say() { echo "[deploy-gate] $*" >&2; }
_dl_log() { echo "$(_dl_stamp) $*" >> "$DEFERLESS_DEPLOY_LOG" 2>/dev/null || true; }
# ── MTIME, AND WHY THIS IS NOT A ONE-LINE `||` CHAIN ─────────────────────────────────────────
# BSD stat (macOS) and GNU stat (Linux) spell this differently and neither accepts the other's
# flag. The obvious `stat -f %m "$1" || stat -c %Y "$1"` is WRONG on GNU and fails in the worst
# way available: GNU's `-f` means "filesystem status" and takes no format, so it reads `%m` as a
# FILENAME. It then prints a whole block of filesystem info for the real file ON STDOUT, exits
# non-zero because `%m` does not exist, and the fallback runs and appends to it. The caller gets
# fifteen lines where it expected an integer, every numeric comparison errors, and every peer
# reads as idle — so a deploy that should have deferred shipped instead. Green locally, wrong on
# every Linux runner.
#
# So the dialect is decided ONCE, up front, by a probe whose output is discarded.
if stat -c %Y . >/dev/null 2>&1; then
    # 0 is the safe direction for an unreadable stamp: it reads as "ancient", which makes a lock
    # look stealable and a session look idle. Both are recoverable; the opposite default wedges a
    # deploy behind a stamp nobody can read.
    _dl_mtime() { stat -c %Y "$1" 2>/dev/null || echo 0; }   # GNU
else
    _dl_mtime() { stat -f %m "$1" 2>/dev/null || echo 0; }   # BSD
fi
_dl_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# ── SESSIONS ────────────────────────────────────────────────────────────────

# Every terminal-tab Claude session on this machine, one pid per line. Sockets outlive their
# process, so liveness is checked; a socket with no TTY is a headless lane, not a peer.
dl_sessions() {
    # `ls`, not a glob: this file is sourced into #!/bin/zsh deploy scripts, and zsh ABORTS on a
    # pattern that matches nothing (NOMATCH is on by default). An empty socket dir would take the
    # deploy script down with it before the loop body ever ran.
    for _p in $(ls -1 "${DEFERLESS_SOCK_DIR:-/tmp/cc-socks}" 2>/dev/null | sed -n 's/\.sock$//p'); do
        _dl_alive "$_p" || continue
        _t=$(ps -o tty= -p "$_p" 2>/dev/null | tr -d ' ')
        [ -z "$_t" ] && continue
        [ "$_t" = "??" ] && continue
        echo "$_p"
    done
    return 0
}

# Sessions running a bash tool RIGHT NOW. That shell is a direct child of the session process,
# so its ppid is the session pid — no tree walk needed.
_dl_running_now() {
    ps -eo ppid,command 2>/dev/null \
      | grep 'shell-snapshots/snapshot-' \
      | grep -v grep \
      | awk '{print $1}' | sort -u
    return 0
}

# Sample activity into the stickiness files. deploy-watch calls this every tick; the gate calls
# it too so a one-off deploy is not relying on the watcher having run recently.
dl_sample_sessions() {
    for _p in $(_dl_running_now); do
        touch "$DEFERLESS_SESSION_ACT/$_p" 2>/dev/null || true
    done
    # Reap sockets and stamps for sessions that have exited.
    for _f in $(ls -1 "$DEFERLESS_SESSION_ACT" 2>/dev/null); do
        _dl_alive "$_f" || rm -f "$DEFERLESS_SESSION_ACT/$_f"
    done
    return 0
}

# Peer sessions that are still working. $1 = a session pid to exclude (our own).
dl_busy_peers() {
    _me="${1:-${CLAUDE_PID:-0}}"
    dl_sample_sessions
    _cut=$(( $(_dl_now) - DEFERLESS_SESSION_QUIET ))
    for _p in $(dl_sessions); do
        [ "$_p" = "$_me" ] && continue
        _a=$(_dl_mtime "$DEFERLESS_SESSION_ACT/$_p")
        [ "$_a" -gt "$_cut" ] && echo "$_p"
    done
    return 0
}

dl_session_report() {
    _me="${1:-${CLAUDE_PID:-0}}"
    dl_sample_sessions
    _cut=$(( $(_dl_now) - DEFERLESS_SESSION_QUIET ))
    for _p in $(dl_sessions); do
        _a=$(_dl_mtime "$DEFERLESS_SESSION_ACT/$_p")
        if [ "$_a" = "0" ]; then _ago="no bash call since this gate was installed"
        else _ago="last bash call $(( $(_dl_now) - _a ))s ago"; fi
        if [ "$_a" -gt "$_cut" ]; then _tag="WORKING"; else _tag="idle   "; fi
        [ "$_p" = "$_me" ] && _tag="$_tag (this session)"
        echo "  pid $_p  $(ps -o tty= -p "$_p" 2>/dev/null | tr -d ' ')  $_tag  $_ago"
    done
    return 0
}

# ── THE LOCK ────────────────────────────────────────────────────────────────

_dl_field() {
    [ -f "$DEFERLESS_DEPLOY_LOCK_DIR/holder" ] || return 1
    sed -n "s/^$1=//p" "$DEFERLESS_DEPLOY_LOCK_DIR/holder" 2>/dev/null | head -1
}

_dl_holder_desc() {
    _age=$(( $(_dl_now) - $(_dl_mtime "$DEFERLESS_DEPLOY_LOCK_DIR/heartbeat") ))
    echo "$(_dl_field name) ($(_dl_field label)) pid $(_dl_field pid) since $(_dl_field startedh), heartbeat ${_age}s ago"
}

_dl_is_stale() {
    _pid=$(_dl_field pid)
    [ -z "$_pid" ] && return 0
    _dl_alive "$_pid" || return 0
    [ "$(( $(_dl_now) - $(_dl_mtime "$DEFERLESS_DEPLOY_LOCK_DIR/heartbeat") ))" -gt "$DEFERLESS_DEPLOY_STALE" ]
}

# Steal under a second short-lived lock so two waiters cannot both clear it and both proceed.
_dl_steal() {
    _sl="$DEFERLESS_DEPLOY_LOCK_DIR.steal"
    if [ -d "$_sl" ] && [ "$(( $(_dl_now) - $(_dl_mtime "$_sl") ))" -gt 60 ]; then rmdir "$_sl" 2>/dev/null; fi
    mkdir "$_sl" 2>/dev/null || return 1
    if _dl_is_stale; then
        _dl_say "stealing a dead lock — $(_dl_holder_desc)"
        _dl_log "STEAL by $$ ($_DL_NAME) from $(_dl_holder_desc)"
        rm -rf "$DEFERLESS_DEPLOY_LOCK_DIR"
    fi
    rmdir "$_sl" 2>/dev/null
    return 0
}

_dl_release() {
    # ⛔ FIRST LINE, BEFORE ANY OTHER COMMAND. This runs as the EXIT trap, so $? here is the
    # deploy script's own exit status and any command above would overwrite it.
    _dl_rc=$?
    [ -n "$_DL_HELD" ] || return 0
    [ -n "$_DL_HB_PID" ] && kill "$_DL_HB_PID" 2>/dev/null
    # A deploy that held the lock and ran to completion is NOT pending any more, however it got
    # the lock. Only deploy-all.sh used to clear these, so a repo deferred once stayed in the queue
    # forever: every DEPLOY_NOW run after it shipped for real and left the entry sitting there, and
    # `--status` then reported a repo that was live as still waiting to ship. That made the queue
    # unreadable as evidence — which is the whole reason it exists. A non-zero exit leaves the
    # entry alone, because a failed build IS still owed.
    if [ "$_dl_rc" = 0 ] && [ -n "$_DL_NAME" ] && [ "$_DL_LABEL" != "estate" ]; then
        rm -f "$DEFERLESS_DEPLOY_PENDING/$_DL_NAME" 2>/dev/null || true
    fi
    # Only tear down a lock we still own. If it was stolen from under us the token no longer
    # matches and the directory belongs to somebody else — never remove theirs.
    if [ "$(cat "$DEFERLESS_DEPLOY_LOCK_DIR/token" 2>/dev/null)" = "$_DL_TOKEN" ]; then
        rm -rf "$DEFERLESS_DEPLOY_LOCK_DIR"
        _dl_log "RELEASE $_DL_NAME by $$"
    else
        _dl_log "RELEASE $_DL_NAME by $$ — lock had been taken over, left alone"
    fi
    _DL_HELD=""
}

_dl_take() {
    mkdir "$DEFERLESS_DEPLOY_LOCK_DIR" 2>/dev/null || return 1
    _DL_TOKEN="$$-$(_dl_now)-${RANDOM:-0}"
    {
        echo "pid=$$"
        echo "name=$_DL_NAME"
        echo "label=$_DL_LABEL"
        echo "session=${CLAUDE_PID:-$(tty 2>/dev/null | sed 's|/dev/||')}"
        echo "started=$(_dl_now)"
        echo "startedh=$(_dl_stamp)"
        echo "cwd=$PWD"
    } > "$DEFERLESS_DEPLOY_LOCK_DIR/holder"
    echo "$_DL_TOKEN" > "$DEFERLESS_DEPLOY_LOCK_DIR/token"
    : > "$DEFERLESS_DEPLOY_LOCK_DIR/heartbeat"

    # The heartbeat is what makes the lock safe to steal: it dies with its owner, so a SIGKILLed
    # deploy goes cold within DEFERLESS_DEPLOY_STALE instead of wedging the estate forever.
    # ⛔ Its stdio MUST be redirected. A background subshell inherits the deploy script's fds, so
    # an unredirected heartbeat holds stdout open and any `out=$(./scripts/deploy.sh)` blocks
    # forever waiting for a pipe that a sleeping loop is still holding.
    _dl_owner=$$
    ( while [ -d "$DEFERLESS_DEPLOY_LOCK_DIR" ] && kill -0 "$_dl_owner" 2>/dev/null; do
          touch "$DEFERLESS_DEPLOY_LOCK_DIR/heartbeat" 2>/dev/null || exit 0
          sleep 20
      done ) >/dev/null 2>&1 </dev/null &
    _DL_HB_PID=$!

    _DL_HELD=1
    export DEFERLESS_DEPLOY_LOCK_TOKEN="$_DL_TOKEN"
    _dl_log "ACQUIRE $_DL_NAME ($_DL_LABEL) by $$"
    return 0
}

# ⛔ THE TRAPS GO HERE, AT THE TOP LEVEL OF THE SOURCED FILE — NEVER INSIDE _dl_take.
# In zsh, `trap ... EXIT` set inside a FUNCTION is scoped to that function and fires the moment
# the function RETURNS. The first version installed them in _dl_take, so under every #!/bin/zsh
# deploy script the release ran instantly on acquire: the lock was deleted in the same breath it
# was created, and two deploys sailed straight past each other. It reproduced as "SLOW acquired;
# lockdir exists: NO". bash hid it completely, which is why it has to be tested in both shells.
# Sourcing happens at the deploy script's top level, so installing them here makes them global in
# both shells. _dl_release is a no-op unless this process actually holds the lock.
trap _dl_release EXIT
trap '_dl_release; exit 130' INT
trap '_dl_release; exit 143' TERM

_dl_wait_for_lock() {
    _t0=$(_dl_now); _ticks=0
    while :; do
        _dl_take && return 0
        _dl_is_stale && { _dl_steal; continue; }
        if [ "$(( $(_dl_now) - _t0 ))" -ge "$DEFERLESS_DEPLOY_WAIT" ]; then
            _dl_say "$_DL_NAME — gave up after ${DEFERLESS_DEPLOY_WAIT}s waiting on $(_dl_holder_desc)"
            _dl_log "TIMEOUT $_DL_NAME by $$"
            exit 75
        fi
        _ticks=$(( _ticks + 1 ))
        if [ "$_ticks" = 1 ] || [ "$(( _ticks % 12 ))" = 0 ]; then
            _dl_say "$_DL_NAME — waiting $(( $(_dl_now) - _t0 ))s for $(_dl_holder_desc)"
        fi
        sleep 5
    done
}

# ── THE GATE ────────────────────────────────────────────────────────────────

# deploy_gate <repo> [label]
#   Defers if other sessions are working. Otherwise takes the mutex and returns 0.
deploy_gate() {
    _DL_NAME="${1:-$(basename "$PWD")}"
    _DL_LABEL="${2:-product}"

    # Re-entrant: deploy-all already owns the lock and is invoking this repo's own deploy.sh.
    if [ -n "${DEFERLESS_DEPLOY_LOCK_TOKEN:-}" ] && \
       [ "$(cat "$DEFERLESS_DEPLOY_LOCK_DIR/token" 2>/dev/null)" = "$DEFERLESS_DEPLOY_LOCK_TOKEN" ]; then
        return 0
    fi

    if [ -z "${DEPLOY_NOW:-}" ] && [ "$_DL_LABEL" != "estate" ]; then
        _peers=$(dl_busy_peers || true)
        if [ -n "$_peers" ]; then
            printf '%s\n' "requested $(_dl_stamp) by pid $$ in $PWD" > "$DEFERLESS_DEPLOY_PENDING/$_DL_NAME"
            _dl_say ""
            _dl_say "$_DL_NAME — NOT DEPLOYED. Other Claude sessions are still working:"
            dl_session_report >&2
            _dl_say ""
            _dl_say "Deploying now would ship a tree those sessions are still changing, and it"
            _dl_say "would be stale before the build finished. $_DL_NAME is registered as PENDING."
            _dl_say "deploy-watch runs ONE deploy-all pass the moment every session goes quiet, and"
            _dl_say "everything pending ships in it — from whatever HEAD is by then."
            _dl_say ""
            _dl_say "  pending now : $(ls -1 "$DEFERLESS_DEPLOY_PENDING" 2>/dev/null | tr '\n' ' ')"
            _dl_say "  watch it    : tail -f $DEFERLESS_DEPLOY_HOME/deploy-all.log"
            _dl_say "  ship anyway : DEPLOY_NOW=1 ./scripts/deploy.sh"
            _dl_say ""
            _dl_log "DEFER $_DL_NAME by $$ — busy peers: $(echo "$_peers" | tr '\n' ' ')"
            exit 0
        fi
    fi

    # An estate pass is already running. Waiting an hour to rebuild the same repo it is about to
    # build is the exact waste the deferral exists to stop, so register and let it be picked up.
    if [ "$_DL_LABEL" != "estate" ] && [ -d "$DEFERLESS_DEPLOY_LOCK_DIR" ] && \
       [ "$(_dl_field label)" = "estate" ] && ! _dl_is_stale; then
        printf '%s\n' "requested $(_dl_stamp) by pid $$ in $PWD" > "$DEFERLESS_DEPLOY_PENDING/$_DL_NAME"
        _dl_say "$_DL_NAME — NOT DEPLOYED HERE. An estate pass is already running ($(_dl_holder_desc))."
        _dl_say "$_DL_NAME — registered as pending; that pass ships it. tail -f $DEFERLESS_DEPLOY_HOME/deploy-all.log"
        _dl_log "DEFER $_DL_NAME by $$ — estate pass in flight"
        exit 0
    fi

    _dl_wait_for_lock
}

# Back-compat for anything still calling the mutex by its first name.
deploy_lock() { deploy_gate "$@"; }

deploy_gate_status() {
    echo "sessions:"
    dl_session_report
    echo ""
    if [ ! -d "$DEFERLESS_DEPLOY_LOCK_DIR" ]; then
        echo "deploy lock: FREE"
    elif _dl_is_stale; then
        echo "deploy lock: STALE (next deploy steals it) — $(_dl_holder_desc)"
    else
        echo "deploy lock: HELD — $(_dl_holder_desc)"
    fi
    echo ""
    echo "pending deploys (ship in the next quiet-estate pass):"
    ls -1 "$DEFERLESS_DEPLOY_PENDING" 2>/dev/null | sed 's/^/  /'
    [ -z "$(ls -A "$DEFERLESS_DEPLOY_PENDING" 2>/dev/null)" ] && echo "  (none)"
}
