#!/bin/sh
# railway-test-env.sh — safe on-demand start/stop/status for the Railway
# `test` environment. Single-file dispatcher (start|stop|status) so the
# production guard lives in exactly one place.
#
# Mechanism (native deployment lifecycle, 2026-10-09; replica-count commands
# are DELETED after the witnessed zero-replica failure — there is no
# start/stop is implemented with native deployment semantics observed live:
#   Mutation.deploymentStop(id: String!): Boolean
#   Mutation.deploymentRemove(id: String!): Boolean
#   Mutation.serviceInstanceAutoDeployUpdate(input): result
#   Query.serviceInstanceAutoDeployStatus(projectId,serviceId,environmentId)
#   Query.serviceInstance(serviceId,environmentId) (activeDeployments, latest)
#   Query.deployments(input{projectId environmentId serviceId},first)
#   Mutation.serviceInstanceRedeploy(environmentId,serviceId): Boolean
#   Mutation.deploymentRedeploy(id): Deployment
# Reads go through scripts/railway-test-env-state.mjs (`railway api` for
# instance/deployments/autodeploy plus `railway service list` for counts);
# mutations go through `railway api` with the same explicit
# --project/--environment/--service scoping.
#
# Parked (per shared schema) := running==0 AND no active non-stopped AND no
# pending (QUEUED INITIALIZING WAITING BUILDING DEPLOYING NEEDS_APPROVAL);
# configured replica counts are ignored; latest null only parked when scoped
# lists confirm empty. A stale SUCCESS/stopped deployment is NEVER readiness.
# Replica counts NEVER default: a missing service-list entry, missing
# replicas, or non-integer counts refuse the snapshot (retryable read);
# the sole exception is the witnessed source-less service shape (latest
# null + active/pending/nodes all empty), which reads back parked.
#
# Stop: disable TEST web autodeploy FIRST (serviceInstanceAutoDeployUpdate
# enabled:false, verified false before proceeding), then drain web+push via
# deploymentStop over the FULL scoped snapshot (serviceInstance
# activeDeployments + deployments list, not just latest), verify parked, and
# only then stop the DB and verify parked. deploymentRemove cancels early
# QUEUED/INITIALIZING/WAITING singles or explicitly stopped pending
# BUILDING/DEPLOYING/NEEDS_APPROVAL generations that can still land and wake. Unknown statuses
# are refused. Any dependent ambiguity/failure keeps the DB up, exit nonzero.
#
# Start: DB first via `railway redeploy -p -e -s(db)` (image source), the
# single fresh deployment id selected by before/after scoped diff (ambiguous
# concurrent changes refuse, never guess), then THAT deployment verified
# running+healthy (present, non-stopped, SUCCESS, running>=configured>=1,
# crashed 0, strict integer counts; pending BUILDING/DEPLOYING tolerated
# while converging, terminal FAILED/CRASHED refused) plus pg_isready over
# `railway ssh` before dependents. Web via deploymentRedeploy (works with
# autodeploy off) or redeploy --from-source; autodeploy is NEVER re-enabled.
# Push via deploymentRedeploy when a historical deployment exists, else
# `railway up --service --environment --project --detach` from a validated
# clean checkout only. Neither path touches IaC, regions, or the DB volume,
# and startCommand (npm run push:worker) is preserved. Every Railway/SSH
# child runs under scripts/railway-run-bounded.mjs (portable timeout, no
# new deps) within the overall --timeout deadline (positive integer only);
# signals kill the foreground child group (130/143) with no further
# mutations. A timed-out `railway up` parks push-delivery before any retry
# (uploads may continue server-side; never stack them). Final readback
# failure after start/stop exits nonzero (never WARNING success).
#
# Safety:
#  - Every command passes explicit project/environment/service IDs.
#  - Target environment MUST equal the test env ID or the script aborts
#    (fail closed). Empty/unset resolves to the test env; production is
#    NEVER a default and is refused with a clear message.
#  - NO delete/destroy of services, environments, or volumes anywhere.
#
# Usage:
#   sh scripts/railway-test-env.sh status [--env <env-id>]
#   sh scripts/railway-test-env.sh start  [--env <env-id>] [--timeout N]
#   sh scripts/railway-test-env.sh stop   [--env <env-id>] [--timeout N]
#
# Test hook: RAILWAY_TEST_ENV_POLL_INTERVAL overrides the seconds between
# readiness polls (default 5).
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
GUARD="$SCRIPT_DIR/railway-test-env-guard.mjs"
STATE_HELPER="$SCRIPT_DIR/railway-test-env-state.mjs"
RUN_BOUNDED="$SCRIPT_DIR/railway-run-bounded.mjs"

PROJECT="$(node "$GUARD" --print project)"
TEST_ENV="$(node "$GUARD" --print test-env)"
SVC_WEB="$(node "$GUARD" --print service:web)"
SVC_DB="$(node "$GUARD" --print service:db)"
SVC_PUSH="$(node "$GUARD" --print service:push)"

TIMEOUT_SECONDS=300
POLL_INTERVAL_SECONDS="${RAILWAY_TEST_ENV_POLL_INTERVAL:-5}"
ENV_OVERRIDE=""
COMMAND=""

while [ $# -gt 0 ]; do
  case "$1" in
    start|stop|status)
      COMMAND="$1"; shift ;;
    --env)
      [ $# -ge 2 ] || { echo "railway-test-env: --env requires a value" >&2; exit 2; }
      ENV_OVERRIDE="$2"; shift 2 ;;
    --env=*)
      ENV_OVERRIDE="${1#--env=}"; shift ;;
    --timeout)
      [ $# -ge 2 ] || { echo "railway-test-env: --timeout requires a value" >&2; exit 2; }
      TIMEOUT_SECONDS="$2"; shift 2 ;;
    --timeout=*)
      TIMEOUT_SECONDS="${1#--timeout=}"; shift ;;
    -h|--help)
      sed -n '2,/^[^#]/p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *)
      echo "railway-test-env: unknown argument '$1' (expected start|stop|status)" >&2
      exit 2 ;;
  esac
done

[ -n "$COMMAND" ] || { echo "railway-test-env: missing command (start|stop|status)" >&2; exit 2; }

case "$TIMEOUT_SECONDS" in
  ''|*[!0-9]*)
    echo "railway-test-env: --timeout must be a positive integer (seconds)" >&2
    exit 2 ;;
esac
if [ "$TIMEOUT_SECONDS" -le 0 ] 2>/dev/null; then
  echo "railway-test-env: --timeout must be a positive integer (seconds)" >&2
  exit 2
fi

case "$POLL_INTERVAL_SECONDS" in
  ''|*[!0-9]*|0*)
    echo "railway-test-env: RAILWAY_TEST_ENV_POLL_INTERVAL must be a positive integer (seconds)" >&2
    exit 2 ;;
esac

# --- production guard (fail closed) --------------------------------------
TARGET_ENV="$(node "$GUARD" --assert-env "$ENV_OVERRIDE")" || exit 1

# INT/TERM stop issuing further mutations and kill the foreground child
# group promptly. Long-lived children run under railway-run-bounded (one
# process group per command), so a hung railway/ssh/sleep cannot hold the
# shell past the signal. Server-side work already received still completes;
# the shell only guarantees no FURTHER mutations after the signal.
CURRENT_PRIMARY_PID=""
interrupt_trap() {
  code="$1"
  if [ -n "$CURRENT_PRIMARY_PID" ] && kill -0 "$CURRENT_PRIMARY_PID" 2>/dev/null; then
    kill -TERM "-$CURRENT_PRIMARY_PID" 2>/dev/null || kill -TERM "$CURRENT_PRIMARY_PID" 2>/dev/null || true
    sleep 1
    if kill -0 "$CURRENT_PRIMARY_PID" 2>/dev/null; then
      kill -KILL "-$CURRENT_PRIMARY_PID" 2>/dev/null || kill -KILL "$CURRENT_PRIMARY_PID" 2>/dev/null || true
    fi
  fi
  exit "$code"
}
trap 'interrupt_trap 130' INT
trap 'interrupt_trap 143' TERM

# Bounded foreground runner: every long-lived child (snapshot reads, Railway
# mutations, ssh probes, redeploy/up) goes through railway-run-bounded so a
# hung subprocess cannot outlive the overall --timeout. Per-call bound is
# the caller's remaining budget (never larger than TIMEOUT_SECONDS);
# exhausted budgets refuse to spawn; runner exit 124 means timeout. Signals kill the child
# group via CURRENT_PRIMARY_PID (see traps above).
run_primary() {
  budget="$TIMEOUT_SECONDS"
  case "$budget" in ''|*[!0-9]*) budget=300 ;; esac
  if [ -n "${DEADLINE:-}" ]; then
    now=$(date +%s)
    budget=$((DEADLINE - now))
  fi
  if [ "$budget" -lt 1 ] 2>/dev/null; then
    echo "railway-test-env: operation deadline exhausted; refusing to spawn $1" >&2
    return 124
  fi
  if [ "$budget" -gt "$TIMEOUT_SECONDS" ] 2>/dev/null; then budget="$TIMEOUT_SECONDS"; fi
  node "$RUN_BOUNDED" "$budget" "$@" &
  CURRENT_PRIMARY_PID=$!
  wait "$CURRENT_PRIMARY_PID"
  rc=$?
  CURRENT_PRIMARY_PID=""
  return "$rc"
}

# Capture long-running output without a command substitution: keeping the
# runner in the parent shell makes its PID available to INT/TERM traps.
capture_primary() {
  capture_file="$(mktemp)" || return 3
  if run_primary "$@" >"$capture_file"; then
    CAPTURED_OUTPUT="$(cat "$capture_file")"
    rm -f "$capture_file"
    return 0
  else
    capture_rc=$?
    rm -f "$capture_file"
    return "$capture_rc"
  fi
}

# Polls consume the same operation budget; no wait phase extends it.
poll_pause() {
  remaining=$((DEADLINE - $(date +%s)))
  if [ "$remaining" -le 0 ]; then return 124; fi
  pause="$POLL_INTERVAL_SECONDS"
  if [ "$pause" -gt "$remaining" ]; then pause="$remaining"; fi
  sleep "$pause"
}

# A DB mutation requires BOTH dependents parked in one fresh snapshot.
assert_dependents_parked() {
  if ! read_snapshot; then
    echo "railway-test-env: dependent snapshot unreadable; leaving DB untouched" >&2
    return 1
  fi
  if ! svc_parked web || ! svc_parked push; then
    echo "railway-test-env: dependent reappeared; leaving DB untouched" >&2
    return 1
  fi
}

assert_all_parked() {
  read_snapshot || return 1
  svc_parked web && svc_parked push && svc_parked db || {
    echo "railway-test-env: final combined snapshot is not fully parked" >&2
    return 1
  }
}

# An upload may continue server-side after its client times out. Recovery
# has its own explicit, bounded 30s budget and never converts failure to success.
recover_push_upload() {
  operation_deadline="$DEADLINE"
  DEADLINE=$(( $(date +%s) + 30 ))
  if stop_service push "push-delivery" && wait_for_parked push "push-delivery"; then
    recovery_rc=0
  else
    recovery_rc=$?
    echo "railway-test-env: upload cleanup uncertain; check status before retrying" >&2
  fi
  DEADLINE="$operation_deadline"
  return "$recovery_rc"
}

# Full scoped snapshot via the state helper (`railway api` reads only).
# Exit 0 = ok ($SNAP_FILE holds JSON), 1 = retryable read error, 3 = refusal.
SNAP_FILE=""
cleanup_snap() { [ -n "$SNAP_FILE" ] && rm -f "$SNAP_FILE"; SNAP_FILE=""; }
trap 'cleanup_snap' EXIT
read_snapshot() {
  cleanup_snap
  SNAP_FILE="$(mktemp)" || {
    echo "railway-test-env: could not create temp file; refusing to continue" >&2
    return 3
  }
  # Hard per-read bound: a hung `railway api` chain cannot outlive the
  # overall --timeout. Runner exit 124 = retryable read, never refusal;
  # callers retry until the deadline, then fail nonzero.
  run_primary node "$STATE_HELPER" --env "$TARGET_ENV" >"$SNAP_FILE" 2>"$SNAP_FILE.err"
  snap_rc=$?
  if [ "$snap_rc" -eq 0 ]; then
    rm -f "$SNAP_FILE.err"
    return 0
  fi
  if [ "$snap_rc" -eq 3 ]; then
    cat "$SNAP_FILE.err" >&2; rm -f "$SNAP_FILE.err"
    echo "railway-test-env: snapshot refused (fail closed; see above)" >&2
    return 3
  fi
  if [ "$snap_rc" -eq 124 ]; then
    echo "railway-test-env: snapshot read timed out (retrying until timeout)" >&2
    rm -f "$SNAP_FILE.err"
    return 1
  fi
  cat "$SNAP_FILE.err" >&2; rm -f "$SNAP_FILE.err"
  echo "railway-test-env: WARNING: snapshot read failed (retrying until timeout)" >&2
  return 1
}


# Portable extractor: node script file via temp file would be ideal, but a
# single inline program keeps POSIX sh happy (no eval anywhere).
extract_field() {
  # $1 = key, $2 = field
  node -e '
const fs = require("fs");
const root = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const s = root[process.argv[1]] || {};
const v = s[process.argv[3]];
if (Array.isArray(v)) {
  for (const d of v) console.log(d.id + " " + d.status);
} else if (v && typeof v === "object") {
  console.log((v.id || "") + " " + (v.status || ""));
} else if (v === true) console.log("1");
else if (v === false || v == null) console.log(v === false ? "0" : "");
else console.log(String(v));' "$1" "$SNAP_FILE" "$2"
}

svc_parked() { [ "$(extract_field "$1" parked)" = "1" ]; }
svc_running() { extract_field "$1" running; }
svc_crashed() { extract_field "$1" crashed; }
svc_latest() { extract_field "$1" latest | cut -d' ' -f1; }

# True (0) when the snapshot shows any active non-stopped deployment for
# the service: something is still in flight that could converge (or crash).
# Tells a stale crashed count (previous generation, fresh redeploy already
# BUILDING — witnessed live 2026-10-09) from a terminal crash with nothing
# left running.
svc_may_converge() {
  node -e '
const fs = require("fs");
const root = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const s = root[process.argv[1]] || {};
const live = ((s.active) || []).filter((d) => d && d.id && d.deploymentStopped !== true);
process.exit(live.length > 0 ? 0 : 1);' "$1" "$SNAP_FILE"
}

# Stop set from the FULL scoped snapshot: active non-stopped ids whose
# status is pending or stoppable (one per line: "<id> <CLASS>").
# Unknown statuses -> prints "UNKNOWN <status>" lines and returns 3.
stop_plan() {
  node -e '
const fs = require("fs");
const pending = ["QUEUED","INITIALIZING","WAITING","BUILDING","DEPLOYING","NEEDS_APPROVAL"];
const stoppable = ["SUCCESS","FAILED","CRASHED","SLEEPING","SKIPPED"];
const root = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const s = root[process.argv[1]];
if (!s || !Array.isArray(s.active)) process.exit(3);
let unknown = 0;
for (const d of s.active) {
  if (!d || !d.id) continue;
  const st = String(d.status || "").toUpperCase();
  if (d.deploymentStopped === true && !pending.includes(st)) continue;
  if (pending.includes(st)) console.log(d.id + " pending");
  else if (stoppable.includes(st)) console.log(d.id + " stoppable");
  else { console.log("UNKNOWN " + d.status); unknown = 1; }
}
process.exit(0);' "$1" "$SNAP_FILE"
}

# --- Railway API mutations ---------------------------------------------------
api_mutate() {
  # $1 = GraphQL mutation string, $2 = variables JSON. Response JSON is
  # intentionally discarded: callers verify through scoped readback, and
  # raw mutation output must never pollute status/start/stop reporting.
  # Bounded: a hung `railway api` surfaces as 124 (timeout), never silent.
  run_primary railway api "$1" --variables "$2" >/dev/null
}

autodeploy_disable() {
  # Disable TEST web autodeploy FIRST; verify false before proceeding.
  if ! api_mutate \
    'mutation DisableWebAutodeploy($input: ServiceInstanceAutoDeployUpdateInput!) { serviceInstanceAutoDeployUpdate(input: $input) { enabled } }' \
    "{\"input\":{\"projectId\":\"$PROJECT\",\"environmentId\":\"$TARGET_ENV\",\"serviceId\":\"$SVC_WEB\",\"enabled\":false}}"; then
    echo "railway-test-env: autodeploy disable request failed; refusing to continue" >&2
    return 1
  fi
  if capture_primary node "$STATE_HELPER" --env "$TARGET_ENV" --autodeploy "$SVC_WEB"; then
    autodeploy_json="$CAPTURED_OUTPUT"
  else
    autodeploy_rc=$?
    if [ "$autodeploy_rc" -eq 124 ]; then
      echo "railway-test-env: autodeploy status read timed out; refusing to continue" >&2
    else
      echo "railway-test-env: autodeploy status unreadable after disable; refusing to continue" >&2
    fi
    return 1
  fi
  case "$autodeploy_json" in
    *'"enabled":false'*)
      echo "railway-test-env: web-test autodeploy verified enabled=false" ;;
    *)
      echo "railway-test-env: web-test autodeploy still enabled; refusing to continue ($autodeploy_json)" >&2
      return 1 ;;
  esac
}

deployment_stop() {
  # $1 = deployment id (single disposable TEST deployment id)
  api_mutate \
    'mutation StopDeployment($id: String!) { deploymentStop(id: $id) }' \
    "{\"id\":\"$1\"}"
}

deployment_remove() {
  # $1 = deployment id; ONLY for stubborn QUEUED/INITIALIZING/WAITING singles
  api_mutate \
    'mutation RemoveDeployment($id: String!) { deploymentRemove(id: $id) }' \
    "{\"id\":\"$1\"}"
}

deployment_redeploy() {
  # $1 = deployment id; works with autodeploy off
  api_mutate \
    'mutation RedeployDeployment($id: String!) { deploymentRedeploy(id: $id) { id status } }' \
    "{\"id\":\"$1\"}"
}

# --- stop one service via native deployment semantics -------------------------
# $1 = key, $2 = label. Bounded rounds: reread after every action; a changed
# set recomputes. Unknown statuses refuse immediately. Removal only for
# early pending or explicitly stopped pending ids that survive a stop round.
stop_service() {
  round=0
  removed_round=0
  while [ "$round" -lt 6 ]; do
    round=$((round + 1))
    if read_snapshot; then snap_rc=0; else snap_rc=$?; fi
    if [ "$snap_rc" -ne 0 ]; then
      if [ "$snap_rc" -eq 3 ]; then return 3; fi
      poll_pause; continue
    fi
    if svc_parked "$1"; then
      echo "railway-test-env: $2 parked (running=0, no active non-stopped, no pending)"
      return 0
    fi
    plan_file="$(mktemp)" || return 3
    if stop_plan "$1" >"$plan_file"; then
      plan_rc=0
    else
      plan_rc=$?
    fi
    if [ "$plan_rc" -ne 0 ]; then
      rm -f "$plan_file"
      echo "railway-test-env: $2 has unknown deployment status; REFUSING to act (fail closed)" >&2
      return 3
    fi
    if [ ! -s "$plan_file" ]; then
      rm -f "$plan_file"
      poll_pause
      continue
    fi
    while read -r dep_id dep_class; do
      [ -n "$dep_id" ] || continue
      if [ "$dep_id" = "UNKNOWN" ]; then
        rm -f "$plan_file"
        echo "railway-test-env: $2 has unknown deployment status ($dep_class); REFUSING" >&2
        return 3
      fi
      if [ "$1" = "db" ]; then
        assert_dependents_parked || { rm -f "$plan_file"; return 1; }
      fi
      echo "railway-test-env: stopping $2 deployment $dep_id ($dep_class)"
      if ! deployment_stop "$dep_id"; then
        echo "railway-test-env: deploymentStop failed for $dep_id; aborting (fail closed)" >&2
        rm -f "$plan_file"
        return 1
      fi
    done <"$plan_file"
    rm -f "$plan_file"
    poll_pause
    # Cancellation pass: early pending or stopped-pending builds may still
    # land and wake, so a stopped flag alone never certifies parked.
    if read_snapshot; then snap_rc=0; else snap_rc=$?; fi
    if [ "$snap_rc" -ne 0 ]; then
      if [ "$snap_rc" -eq 3 ]; then return 3; fi
      continue
    fi
    if svc_parked "$1"; then
      echo "railway-test-env: $2 parked (running=0, no active non-stopped, no pending)"
      return 0
    fi
    if [ "$removed_round" -lt 2 ]; then
      stubborn="$(node -e '
const fs = require("fs");
const early = ["QUEUED","INITIALIZING","WAITING"];
const pending = [...early,"BUILDING","DEPLOYING","NEEDS_APPROVAL"];
const root = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const s = root[process.argv[1]];
for (const d of (s && s.active) || []) {
  if (d && d.id && (early.includes(String(d.status).toUpperCase()) || (d.deploymentStopped === true && pending.includes(String(d.status).toUpperCase())))) console.log(d.id);
}' "$1" "$SNAP_FILE")" || stubborn=""
      if [ -n "$stubborn" ]; then
        removed_round=$((removed_round + 1))
        for dep_id in $stubborn; do
          if [ "$1" = "db" ]; then assert_dependents_parked || return 1; fi
          echo "railway-test-env: cancelling stubborn pending deployment $dep_id ($2)"
          if ! deployment_remove "$dep_id"; then
            echo "railway-test-env: deploymentRemove failed for $dep_id; aborting" >&2
            return 1
          fi
        done
        poll_pause
      fi
    fi
  done
  echo "railway-test-env: $2 did not park within bounded stop rounds; aborting" >&2
  return 1
}

# --- start helpers --------------------------------------------------------------
# $1 = key, $2 = label, $3 = expected initiated deployment id (may be empty
# only when the mutation path returns no id — then before/after scoping in
# the caller must have uniquely selected it, else the caller refuses).
# Success requires ALL of: expected deployment present + non-stopped +
# terminal-SUCCESS-or-converging (pending BUILDING/DEPLOYING tolerated while
# running grows), running>=configured>=1 with strict integer counts, no
# terminal FAILED/CRASHED for the expected id, and no malformed counts.
# A stale previous crashed count is tolerated ONLY while the expected id is
# distinctly pending or freshly SUCCESS (never while it is terminal-failed,
# and never to bless old-generation running while the expected id is still
# pending/failed).
wait_for_running() {
  key="$1"; label="$2"; expected="${3:-}"
  deadline="$DEADLINE"
  while :; do
    if read_snapshot; then
      if wait_running_converged "$key" "$label" "$expected"; then
        return 0
      else
        # NOTE: capture $? HERE in the else branch (the condition's
        # status). `$?` after `fi` would be the if-statement's own status.
        wait_rc=$?
      fi
      if [ "$wait_rc" -eq 3 ]; then return 3; fi
    else
      if [ "$?" -eq 3 ]; then return 3; fi
    fi
    now=$(date +%s)
    if [ "$now" -ge "$deadline" ]; then
      echo "railway-test-env: timed out after ${TIMEOUT_SECONDS}s waiting for $label (expected deployment ${expected:-unknown} running+healthy)" >&2
      return 1
    fi
    poll_pause
  done
}

# One snapshot verdict for wait_for_running. Exit 0 = converged healthy;
# 1 = keep waiting; 3 = terminal refusal (crash-loop expected, unexpected
# terminal, malformed counts). All diagnostics go to stderr; the single
# stdout line is the success line so callers can distinguish silence.
#
# Generation matching: the expected id selects its own generation. Every
# mutation path (redeploy, deploymentRedeploy, up) must produce exactly one
# fresh id via the before/after scoped diff — otherwise the caller refuses.
# Live redeploys mint fresh ids doing fresh work (witnessed live
# 2026-10-09: redeploy of CRASHED a9de8c69 converged as SUCCESS 674e32c2
# 1/1; the old id stays a stopped history row). A stopped expected entry
# with no live SUCCESS generation waits; a live terminal row for the
# expected id (or any live terminal row) refuses.
wait_running_converged() {
  key="$1"; label="$2"; expected="$3"
  node -e '
const fs = require("fs");
const key = process.argv[1], label = process.argv[2], expected = process.argv[3] || "";
const snapFile = process.argv[4];
let root;
try { root = JSON.parse(fs.readFileSync(snapFile, "utf8")); }
catch { console.error(`railway-test-env: ${label} snapshot unreadable; retrying`); process.exit(1); }
const s = root[key];
if (!s || typeof s !== "object") { console.error(`railway-test-env: ${label} snapshot missing; retrying`); process.exit(1); }
for (const f of ["running", "configured", "crashed"]) {
  if (!Number.isInteger(s[f]) || s[f] < 0) {
    console.error(`railway-test-env: ${label} reports malformed ${f}=${JSON.stringify(s[f])}; refusing to continue`);
    process.exit(3);
  }
}
const active = Array.isArray(s.active) ? s.active : null;
if (active === null) { console.error(`railway-test-env: ${label} snapshot missing active list; refusing`); process.exit(3); }
const TERMINAL_FAIL = ["FAILED", "CRASHED"];
const PENDING = ["QUEUED", "INITIALIZING", "WAITING", "BUILDING", "DEPLOYING", "NEEDS_APPROVAL"];
const live = active.filter((d) => d && d.id && d.deploymentStopped !== true);
const byIdLive = new Map(live.map((d) => [String(d.id), d]));
if (!expected) {
  const latest = s.latest;
  if (!latest || latest.deploymentStopped === true || String(latest.status).toUpperCase() !== "SUCCESS") {
    console.error(`railway-test-env: ${label} latest deployment is not live SUCCESS; refusing idempotent success`); process.exit(1);
  }
  if ((s.pending || []).length || live.some((d) => PENDING.includes(String(d.status).toUpperCase()))) {
    console.error(`railway-test-env: ${label} pending deployment blocks idempotent success`); process.exit(1);
  }
}

if (expected) {
  const liveDep = byIdLive.get(String(expected));
  const anyDep = active.find((d) => d && String(d.id) === String(expected));
  if (!anyDep) { console.error(`railway-test-env: ${label} expected deployment ${expected} absent from scoped snapshot; retrying`); process.exit(1); }
  if (!liveDep) {
    // Expected id present but stopped. A fresh id that is stopped while
    // still PENDING (BUILDING/WAITING/...) is normal mid-build platform
    // state: the platform unstops it when the build lands (witnessed live
    // 2026-10-09: fresh 7abc0c5e BUILDING+stopped after deploymentRedeploy).
    // It waits below — AFTER the live-terminal sweep, so a visible
    // crash-loop elsewhere still refuses fast instead of hiding behind
    // the build wait. A stopped SUCCESS or terminal id refuses here.
    const stoppedEntry = active.find((d) => d && String(d.id) === String(expected));
    const stoppedStatus = String((stoppedEntry && stoppedEntry.status) || "").toUpperCase();
    if (!PENDING.includes(stoppedStatus)) {
      console.error(`railway-test-env: ${label} expected deployment ${expected} is stopped (${stoppedStatus || "unknown status"}); refusing`);
      process.exit(3);
    }
  }
} // end if (expected): presence asserted; liveness judged below
// Terminal failure anywhere live (non-stopped) refuses BEFORE any
// pending-wait: a live CRASHED/FAILED row is current platform state, not
// previous-generation residue (redeploys mint fresh ids; old ids stay
// stopped history rows). Waiting through a visible crash would bless a
// crash-looping service as "converging".
for (const d of live) {
  if (!d || !d.id) continue;
  const st = String(d.status || "").toUpperCase();
  if (!TERMINAL_FAIL.includes(st)) continue;
  if (expected && String(d.id) === String(expected)) {
    console.error(`railway-test-env: ${label} expected deployment ${expected} terminal ${st}; refusing`);
    process.exit(3);
  }
  console.error(`railway-test-env: ${label} deployment ${d.id} terminal ${st} with nothing converging; refusing`);
  process.exit(3);
}
// Stopped-while-building fresh ids wait here (after the terminal sweep):
// the build may still land and unstop the deployment.
if (expected) {
  const liveDep = byIdLive.get(String(expected));
  if (!liveDep) {
    const stoppedEntry = active.find((d) => d && String(d.id) === String(expected));
    const stoppedStatus = String((stoppedEntry && stoppedEntry.status) || "").toUpperCase();
    if (s.crashed > 0) console.error(`railway-test-env: ${label} reports ${s.crashed} crashed replica(s) but expected ${expected} still ${stoppedStatus} (stopped while building); waiting for convergence...`);
    else console.error(`railway-test-env: ${label} expected deployment ${expected} still ${stoppedStatus} (stopped while building); waiting...`);
    process.exit(1);
  }
}
if (expected) {
  const liveDep = byIdLive.get(String(expected));
  const st = String((liveDep && liveDep.status) || "").toUpperCase();
  if (TERMINAL_FAIL.includes(st)) { console.error(`railway-test-env: ${label} expected deployment ${expected} terminal ${st} non-stopped; refusing`); process.exit(3); }
  if (PENDING.includes(st)) {
    if (s.crashed > 0) console.error(`railway-test-env: ${label} reports ${s.crashed} crashed replica(s) but expected ${expected} still ${st}; waiting for convergence...`);
    else console.error(`railway-test-env: ${label} expected ${expected} still ${st} (running=${s.running}); waiting...`);
    process.exit(1);
  }
  if (st !== "SUCCESS") { console.error(`railway-test-env: ${label} expected deployment ${expected} has unknown status ${st}; refusing`); process.exit(3); }
}
if (s.configured < 1) { console.error(`railway-test-env: ${label} reports configured=${s.configured}; refusing (expected >=1)`); process.exit(3); }
if (s.running < s.configured) { console.error(`railway-test-env: ${label} partial replicas running=${s.running} configured=${s.configured}; waiting...`); process.exit(1); }
if (s.crashed > 0) { console.error(`railway-test-env: ${label} reports ${s.crashed} crashed replica(s) with nothing in flight; refusing to continue`); process.exit(3); }
console.log(`railway-test-env: ${label} running (running=${s.running} configured=${s.configured}${expected ? ` expected=${expected}` : ""})`);
' "$key" "$label" "$expected" "$SNAP_FILE"
}

wait_for_parked() {
  # $1 = key, $2 = label. Bounded parked gate with fail-closed reads.
  deadline="$DEADLINE"
  while :; do
    if read_snapshot; then
      if svc_parked "$1"; then
        echo "railway-test-env: $2 parked (running=0, no active non-stopped, no pending)"
        return 0
      fi
    else
      if [ "$?" -eq 3 ]; then return 3; fi
    fi
    now=$(date +%s)
    if [ "$now" -ge "$deadline" ]; then
      echo "railway-test-env: timed out after ${TIMEOUT_SECONDS}s waiting for $2 to park" >&2
      return 1
    fi
    poll_pause
  done
}

wait_for_db_ready() {
  deadline="$DEADLINE"
  while :; do
    if run_primary railway ssh -p "$PROJECT" -e "$TARGET_ENV" -s "$SVC_DB" -- pg_isready 2>&1; then
      echo "railway-test-env: Postgres-ltHj accepts connections (pg_isready)"
      return 0
    else
      ssh_rc=$?
      if [ "$ssh_rc" -eq 124 ]; then
        echo "railway-test-env: Postgres-ltHj pg_isready probe timed out; retrying..." >&2
      else
        echo "railway-test-env: Postgres-ltHj not accepting connections yet; retrying..." >&2
      fi
    fi
    now=$(date +%s)
    if [ "$now" -ge "$deadline" ]; then
      echo "railway-test-env: timed out after ${TIMEOUT_SECONDS}s waiting for Postgres-ltHj to accept connections (needs working 'railway ssh'; see 'railway ssh keys')" >&2
      return 1
    fi
    poll_pause
  done
}

scoped_deployment_ids() {
  # $1 = service id. Newest-first scoped deployment ids (one per line).
  # Bounded read; empty output on failure so callers refuse (never select
  # an ambiguous id). Callers distinguish refusal via the empty result.
  scoped_file="$(mktemp)" || return 3
  if run_primary railway api \
    'query ScopedDeployments($projectId: String!, $environmentId: String!, $serviceId: String!) { deployments(input: {projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId}, first: 50) { edges { node { id status } } } }' \
    --variables "{\"projectId\":\"$PROJECT\",\"environmentId\":\"$TARGET_ENV\",\"serviceId\":\"$1\"}" \
    >"$scoped_file"; then
    :
  else
    scoped_rc=$?
    rm -f "$scoped_file"
    return "$scoped_rc"
  fi
  node -e '
let data = "";
process.stdin.on("data", (c) => { data += c; });
process.stdin.on("end", () => {
  let root;
  try { root = JSON.parse(data); } catch { process.exit(1); }
  const dep = (root && root.data && root.data.deployments) || root.deployments || root;
  const edges = (dep && dep.edges) || [];
  for (const e of edges) {
    const n = (e && e.node) || e;
    if (n && n.id) console.log(n.id);
  }
});' <"$scoped_file"
  scoped_rc=$?
  rm -f "$scoped_file"
  return "$scoped_rc"
}

# Capture the single fresh id from a before/after scoped diff. $1 = service
# id, $2 = file holding before-ids (one per line). Sets FRESH_DEP_ID iff exactly
# one new id appeared; otherwise prints nothing and returns 1 (ambiguous
# concurrent change => caller refuses, never guesses).
select_fresh_deployment_id() {
  svc="$1"; before_file="$2"
  after_file="$(mktemp)" || return 1
  if ! scoped_deployment_ids "$svc" >"$after_file"; then
    rm -f "$after_file"
    return 1
  fi
  fresh=""
  fresh_count=0
  while read -r dep_id _rest; do
    [ -n "$dep_id" ] || continue
    if ! grep -Fxq "$dep_id" "$before_file" 2>/dev/null; then
      fresh="$dep_id"
      fresh_count=$((fresh_count + 1))
    fi
  done <"$after_file"
  rm -f "$after_file"
  if [ "$fresh_count" -eq 1 ]; then
    FRESH_DEP_ID="$fresh"
    return 0
  fi
  return 1
}

validate_clean_checkout() {
  # Gate for the `railway up` push fallback: clean tree, repo root is the
  # worktree, no secrets/.env*/uploads payloads, honor .gitignore.
  command -v git >/dev/null 2>&1 || {
    echo "railway-test-env: git not available; refusing 'railway up' fallback" >&2
    return 1
  }
  toplevel="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    echo "railway-test-env: not inside a git worktree; refusing 'railway up' fallback" >&2
    return 1
  }
  if [ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" != "true" ]; then
    echo "railway-test-env: unknown checkout state; refusing 'railway up' fallback" >&2
    return 1
  fi
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo "railway-test-env: worktree is dirty; refusing 'railway up' fallback (commit or stash first)" >&2
    return 1
  fi
  if git check-ignore -q .env .env.local .env.test secrets uploads 2>/dev/null; then
    : # ignored paths stay out of the deploy payload
  fi
  for risky in .env .env.local .env.test secrets uploads; do
    if [ -e "$toplevel/$risky" ]; then
      if ! git check-ignore -q "$toplevel/$risky" 2>/dev/null; then
        echo "railway-test-env: refusing 'railway up' fallback: unignored $risky present at repo root" >&2
        return 1
      fi
    fi
  done
  if [ "$toplevel" != "$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)" ]; then
    echo "railway-test-env: checkout root ($toplevel) is not this repo; refusing 'railway up' fallback" >&2
    return 1
  fi
}

show_status() {
  read_snapshot || {
    echo "railway-test-env: status read failed (fail closed)" >&2
    return 1
  }
  node -e '
const fs = require("fs");
const root = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const key of ["web", "db", "push"]) {
  const s = root[key];
  if (!s) continue;
  const latest = s.latest ? `${s.latest.id} ${s.latest.status}` : "-";
  console.log(`${s.service || key} [${s.serviceId}]: running=${s.running} configured=${s.configured} crashed=${s.crashed} parked=${s.parked} latest=${latest} pending=${(s.pending || []).length}`);
}' "$SNAP_FILE"
  if capture_primary node "$STATE_HELPER" --env "$TARGET_ENV" --autodeploy "$SVC_WEB" 2>/dev/null; then
    autodeploy_json="$CAPTURED_OUTPUT"
    echo "web-test autodeploy: $autodeploy_json"
  else
    echo "web-test autodeploy: unreadable" >&2
  fi
}

# Final success uses one fresh snapshot and the same generation predicate.
assert_all_running() {
  read_snapshot || return 1
  wait_running_converged db "Postgres-ltHj" "${new_db_dep:-}" &&
    wait_running_converged web "web-test" "${new_web_dep:-}" &&
    wait_running_converged push "push-delivery" "${new_push_dep:-}"
}

# --- commands --------------------------------------------------------------
DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))
case "$COMMAND" in
  status)
    echo "railway-test-env: test environment $TARGET_ENV"
    show_status
    ;;
  start)
    echo "railway-test-env: starting test env $TARGET_ENV (DB first)"
    # Overall deadline: every wait loop and every bounded child shares it.
    DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))
    # Idempotent start: genuinely converged healthy snapshots only — strict
    # integer counts, running>=configured>=1, crashed 0, latest SUCCESS
    # non-stopped, plus pg_isready. running>0 alone never counts.
    if read_snapshot; then
      if wait_running_converged web "web-test" "" >/dev/null 2>&1 \
        && wait_running_converged db "Postgres-ltHj" "" >/dev/null 2>&1 \
        && wait_running_converged push "push-delivery" "" >/dev/null 2>&1 \
        && run_primary railway ssh -p "$PROJECT" -e "$TARGET_ENV" -s "$SVC_DB" -- pg_isready >/dev/null 2>&1; then
        autodeploy_disable || exit 1
        assert_all_running || exit 1
        echo "railway-test-env: test environment already running+healthy (idempotent start)"
        exit 0
      fi
    fi
    # DB first (image source): snapshot before-ids, redeploy, select the
    # single fresh id (refuse ambiguous concurrent changes), wait for THAT
    # deployment running+healthy, then prove pg_isready.
    db_before="$(mktemp)" || exit 3
    scoped_deployment_ids "$SVC_DB" >"$db_before" || { rm -f "$db_before"; echo "railway-test-env: DB scoped read failed before redeploy; refusing" >&2; exit 1; }
    if ! run_primary railway redeploy -s "$SVC_DB" -e "$TARGET_ENV" -p "$PROJECT" --yes; then
      rm -f "$db_before"
      echo "railway-test-env: DB redeploy request failed" >&2
      exit 1
    fi
    if select_fresh_deployment_id "$SVC_DB" "$db_before"; then
      new_db_dep="$FRESH_DEP_ID"
    else
      rm -f "$db_before"
      echo "railway-test-env: DB redeploy ambiguous (no single fresh deployment); refusing to guess" >&2
      exit 1
    fi
    rm -f "$db_before"
    echo "railway-test-env: Postgres-ltHj redeploy requested (newest scoped deployment $new_db_dep)"
    wait_for_running db "Postgres-ltHj" "$new_db_dep" || exit 1
    wait_for_db_ready || exit 1
    # Web via deploymentRedeploy (works with autodeploy off), else --from-source.
    web_latest="$(svc_latest web)"
    if [ -n "$web_latest" ]; then
      web_before="$(mktemp)" || exit 3
      scoped_deployment_ids "$SVC_WEB" >"$web_before" || { rm -f "$web_before"; echo "railway-test-env: web scoped read failed before redeploy; refusing" >&2; exit 1; }
      deployment_redeploy "$web_latest" || {
        rm -f "$web_before"
        echo "railway-test-env: web deploymentRedeploy failed" >&2
        exit 1
      }
      if select_fresh_deployment_id "$SVC_WEB" "$web_before"; then
        new_web_dep="$FRESH_DEP_ID"
      else
        rm -f "$web_before"
        echo "railway-test-env: web deploymentRedeploy produced no single fresh deployment; refusing to guess" >&2
        exit 1
      fi
      rm -f "$web_before"
      echo "railway-test-env: web-test redeploy requested (newest scoped deployment $new_web_dep)"
    else
      web_before="$(mktemp)" || exit 3
      scoped_deployment_ids "$SVC_WEB" >"$web_before" || { rm -f "$web_before"; echo "railway-test-env: web scoped read failed before redeploy; refusing" >&2; exit 1; }
      run_primary railway redeploy -s "$SVC_WEB" -e "$TARGET_ENV" -p "$PROJECT" --from-source --yes || {
        rm -f "$web_before"
        echo "railway-test-env: web redeploy --from-source failed" >&2
        exit 1
      }
      if select_fresh_deployment_id "$SVC_WEB" "$web_before"; then
        new_web_dep="$FRESH_DEP_ID"
      else
        rm -f "$web_before"
        echo "railway-test-env: web redeploy ambiguous (no single fresh deployment); refusing to guess" >&2
        exit 1
      fi
      rm -f "$web_before"
      echo "railway-test-env: web-test redeploy requested (newest scoped deployment $new_web_dep)"
    fi
    wait_for_running web "web-test" "$new_web_dep" || exit 1
    # Push: redeployable historical deployment wins; `railway up` only from a
    # validated clean checkout. startCommand (npm run push:worker) preserved.
    # Timeout recovery: uploads may keep running server-side after a client
    # timeout, so park the service before retrying (never stack uploads).
    push_latest="$(svc_latest push)"
    if [ -n "$push_latest" ]; then
      push_before="$(mktemp)" || exit 3
      scoped_deployment_ids "$SVC_PUSH" >"$push_before" || { rm -f "$push_before"; echo "railway-test-env: push scoped read failed before redeploy; refusing" >&2; exit 1; }
      deployment_redeploy "$push_latest" || {
        rm -f "$push_before"
        echo "railway-test-env: push deploymentRedeploy failed" >&2
        exit 1
      }
      if select_fresh_deployment_id "$SVC_PUSH" "$push_before"; then
        new_push_dep="$FRESH_DEP_ID"
      else
        rm -f "$push_before"
        echo "railway-test-env: push deploymentRedeploy produced no single fresh deployment; refusing to guess" >&2
        exit 1
      fi
      rm -f "$push_before"
      echo "railway-test-env: push-delivery redeploy requested (newest scoped deployment $new_push_dep)"
    else
      validate_clean_checkout || exit 1
      push_before="$(mktemp)" || exit 3
      scoped_deployment_ids "$SVC_PUSH" >"$push_before" || { rm -f "$push_before"; echo "railway-test-env: push scoped read failed before upload; refusing" >&2; exit 1; }
      if run_primary railway up --service "$SVC_PUSH" --environment "$TARGET_ENV" --project "$PROJECT" --detach --yes; then
        :
      else
        up_rc=$?
        rm -f "$push_before"
        if [ "$up_rc" -eq 124 ]; then
          echo "railway-test-env: push 'railway up' timed out; parking push-delivery before any retry (safe recovery)" >&2
          recover_push_upload || true
        fi
        echo "railway-test-env: push 'railway up' fallback failed" >&2
        exit 1
      fi
      if select_fresh_deployment_id "$SVC_PUSH" "$push_before" 2>/dev/null; then
        new_push_dep="$FRESH_DEP_ID"
      else
        rm -f "$push_before"
        echo "railway-test-env: push upload ambiguous (no single fresh deployment); parking before any retry" >&2
        recover_push_upload || true
        exit 1
      fi
      rm -f "$push_before"
      echo "railway-test-env: push-delivery upload requested (newest scoped deployment $new_push_dep)"
    fi
    wait_for_running push "push-delivery" "$new_push_dep" || exit 1
    autodeploy_disable || exit 1
    assert_all_running || exit 1
    echo "railway-test-env: test environment started (deployments running + DB probe verified; autodeploy stays off)"
    if ! show_status; then
      echo "railway-test-env: started, but the final status readback failed (fail closed)" >&2
      exit 1
    fi
    ;;
  stop)
    echo "railway-test-env: stopping test env $TARGET_ENV (dependents first, DB last)"
    DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))
    # Idempotent stop: everything already parked -> ok 0 (after autodeploy off).
    if read_snapshot; then
      if svc_parked web && svc_parked push && svc_parked db; then
        echo "railway-test-env: test environment already parked (idempotent stop)"
        autodeploy_disable || exit 1
        assert_all_parked || exit 1
        exit 0
      fi
    fi
    # Autodeploy off FIRST, verified false before any deploymentStop.
    autodeploy_disable || exit 1
    stop_service web "web-test" || {
      echo "railway-test-env: web-test stop unconfirmed; leaving Postgres-ltHj UP" >&2
      exit 1
    }
    stop_service push "push-delivery" || {
      echo "railway-test-env: push-delivery stop unconfirmed; leaving Postgres-ltHj UP" >&2
      exit 1
    }
    # Park gate: both dependents must read back parked before the DB moves.
    wait_for_parked web "web-test" || {
      echo "railway-test-env: web-test park unconfirmed; leaving Postgres-ltHj UP" >&2
      exit 1
    }
    wait_for_parked push "push-delivery" || {
      echo "railway-test-env: push-delivery park unconfirmed; leaving Postgres-ltHj UP" >&2
      exit 1
    }
    stop_service db "Postgres-ltHj" || {
      echo "railway-test-env: Postgres-ltHj stop unconfirmed (stops were requested); check status before retrying" >&2
      exit 1
    }
    wait_for_parked db "Postgres-ltHj" || {
      echo "railway-test-env: Postgres-ltHj park unconfirmed (stops were requested); check status before retrying" >&2
      exit 1
    }
    autodeploy_disable || exit 1
    assert_all_parked || exit 1
    echo "railway-test-env: test environment stopped (dependents parked, DB parked; data, volumes, variables, and config are retained)"
    echo "railway-test-env: restart later with: sh scripts/railway-test-env.sh start"
    if ! show_status; then
      echo "railway-test-env: stopped, but the final status readback failed (fail closed)" >&2
      exit 1
    fi
    ;;
esac
cleanup_snap
