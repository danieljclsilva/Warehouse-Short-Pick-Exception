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
#
# Stop: disable TEST web autodeploy FIRST (serviceInstanceAutoDeployUpdate
# enabled:false, verified false before proceeding), then drain web+push via
# deploymentStop over the FULL scoped snapshot (serviceInstance
# activeDeployments + deployments list, not just latest), verify parked, and
# only then stop the DB and verify parked. deploymentRemove is used ONLY for
# QUEUED/INITIALIZING/WAITING singles that resist stopping. Unknown statuses
# are refused. Any dependent ambiguity/failure keeps the DB up, exit nonzero.
#
# Start: DB first via `railway redeploy -p -e -s(db)` (image source), new
# deployment id captured from the scoped deployments list, running>0 plus
# pg_isready over `railway ssh` before dependents. Web via deploymentRedeploy
# (works with autodeploy off) or redeploy --from-source; autodeploy is NEVER
# re-enabled. Push via deploymentRedeploy when a historical deployment
# exists, else `railway up --service --environment --project --detach` from a
# validated clean checkout only. Neither path touches IaC, regions, or the
# DB volume, and startCommand (npm run push:worker) is preserved.
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

case "$POLL_INTERVAL_SECONDS" in
  ''|*[!0-9]*|0*)
    echo "railway-test-env: RAILWAY_TEST_ENV_POLL_INTERVAL must be a positive integer (seconds)" >&2
    exit 2 ;;
esac

# --- production guard (fail closed) --------------------------------------
TARGET_ENV="$(node "$GUARD" --assert-env "$ENV_OVERRIDE")" || exit 1

# --- traps -----------------------------------------------------------------
# INT/TERM exit immediately with conventional codes; the shell does NOT kill
# already-sent server-side work (an in-flight deploymentStop already
# received still completes), it only stops issuing further mutations.
trap 'exit 130' INT
trap 'exit 143' TERM

# --- snapshot plumbing ------------------------------------------------------
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
  if node "$STATE_HELPER" --env "$TARGET_ENV" >"$SNAP_FILE" 2>"$SNAP_FILE.err"; then
    rm -f "$SNAP_FILE.err"
    return 0
  else
    # NOTE: capture $? HERE in the else branch (the condition's status).
    # `$?` after `fi` would be the if-statement's own status (0).
    snap_rc=$?
  fi
  if [ "$snap_rc" -eq 3 ]; then
    cat "$SNAP_FILE.err" >&2; rm -f "$SNAP_FILE.err"
    echo "railway-test-env: snapshot refused (fail closed; see above)" >&2
    return 3
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
  if (!d || !d.id || d.deploymentStopped === true) continue;
  const st = String(d.status || "").toUpperCase();
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
  railway api "$1" --variables "$2" >/dev/null
}

autodeploy_disable() {
  # Disable TEST web autodeploy FIRST; verify false before proceeding.
  if ! api_mutate \
    'mutation DisableWebAutodeploy($input: ServiceInstanceAutoDeployUpdateInput!) { serviceInstanceAutoDeployUpdate(input: $input) { enabled } }' \
    "{\"input\":{\"projectId\":\"$PROJECT\",\"environmentId\":\"$TARGET_ENV\",\"serviceId\":\"$SVC_WEB\",\"enabled\":false}}"; then
    echo "railway-test-env: autodeploy disable request failed; refusing to continue" >&2
    return 1
  fi
  if ! autodeploy_json="$(node "$STATE_HELPER" --env "$TARGET_ENV" --autodeploy "$SVC_WEB")"; then
    echo "railway-test-env: autodeploy status unreadable after disable; refusing to continue" >&2
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
# QUEUED/INITIALIZING/WAITING ids that survive a stop round.
stop_service() {
  round=0
  removed_round=0
  while [ "$round" -lt 6 ]; do
    round=$((round + 1))
    if read_snapshot; then snap_rc=0; else snap_rc=$?; fi
    if [ "$snap_rc" -ne 0 ]; then
      if [ "$snap_rc" -eq 3 ]; then return 3; fi
      sleep "$POLL_INTERVAL_SECONDS"; continue
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
      sleep "$POLL_INTERVAL_SECONDS"
      continue
    fi
    while read -r dep_id dep_class; do
      [ -n "$dep_id" ] || continue
      if [ "$dep_id" = "UNKNOWN" ]; then
        rm -f "$plan_file"
        echo "railway-test-env: $2 has unknown deployment status ($dep_class); REFUSING" >&2
        return 3
      fi
      echo "railway-test-env: stopping $2 deployment $dep_id ($dep_class)"
      if ! deployment_stop "$dep_id"; then
        echo "railway-test-env: deploymentStop failed for $dep_id; aborting (fail closed)" >&2
        rm -f "$plan_file"
        return 1
      fi
    done <"$plan_file"
    rm -f "$plan_file"
    sleep "$POLL_INTERVAL_SECONDS"
    # Removal pass: only early-stage singles still active after stopping.
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
const root = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const s = root[process.argv[1]];
for (const d of (s && s.active) || []) {
  if (d && d.id && d.deploymentStopped !== true && early.includes(String(d.status).toUpperCase())) console.log(d.id);
}' "$1" "$SNAP_FILE")" || stubborn=""
      if [ -n "$stubborn" ]; then
        removed_round=$((removed_round + 1))
        for dep_id in $stubborn; do
          echo "railway-test-env: removing stubborn early deployment $dep_id ($2)"
          if ! deployment_remove "$dep_id"; then
            echo "railway-test-env: deploymentRemove failed for $dep_id; aborting" >&2
            return 1
          fi
        done
        sleep "$POLL_INTERVAL_SECONDS"
      fi
    fi
  done
  echo "railway-test-env: $2 did not park within bounded stop rounds; aborting" >&2
  return 1
}

# --- start helpers --------------------------------------------------------------
wait_for_running() {
  # $1 = key, $2 = label. running>0 (stale stopped/SUCCESS never readiness).
  deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
  while :; do
    if read_snapshot; then
      running="$(svc_running "$1")"
      crashed="$(svc_crashed "$1")"
      case "$crashed" in ''|*[!0-9]*) crashed=0 ;; esac
      case "$running" in ''|*[!0-9]*) running=0 ;; esac
      if [ "$crashed" -gt 0 ] 2>/dev/null; then
        echo "railway-test-env: $2 reports $crashed crashed replica(s); refusing to continue" >&2
        return 3
      fi
      if [ "$running" -gt 0 ] 2>/dev/null; then
        echo "railway-test-env: $2 running (running=$running)"
        return 0
      fi
    else
      if [ "$?" -eq 3 ]; then return 3; fi
    fi
    now=$(date +%s)
    if [ "$now" -ge "$deadline" ]; then
      echo "railway-test-env: timed out after ${TIMEOUT_SECONDS}s waiting for $2 (running>0)" >&2
      return 1
    fi
    sleep "$POLL_INTERVAL_SECONDS"
  done
}

wait_for_parked() {
  # $1 = key, $2 = label. Bounded parked gate with fail-closed reads.
  deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
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
    sleep "$POLL_INTERVAL_SECONDS"
  done
}

wait_for_db_ready() {
  deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
  while :; do
    if railway ssh -p "$PROJECT" -e "$TARGET_ENV" -s "$SVC_DB" -- pg_isready 2>&1; then
      echo "railway-test-env: Postgres-ltHj accepts connections (pg_isready)"
      return 0
    fi
    now=$(date +%s)
    if [ "$now" -ge "$deadline" ]; then
      echo "railway-test-env: timed out after ${TIMEOUT_SECONDS}s waiting for Postgres-ltHj to accept connections (needs working 'railway ssh'; see 'railway ssh keys')" >&2
      return 1
    fi
    echo "railway-test-env: Postgres-ltHj not accepting connections yet; retrying..." >&2
    sleep "$POLL_INTERVAL_SECONDS"
  done
}

scoped_deployment_ids() {
  # $1 = service id. Newest-first scoped deployment ids (one per line).
  railway api \
    'query ScopedDeployments($projectId: String!, $environmentId: String!, $serviceId: String!) { deployments(input: {projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId}, first: 50) { edges { node { id status } } } }' \
    --variables "{\"projectId\":\"$PROJECT\",\"environmentId\":\"$TARGET_ENV\",\"serviceId\":\"$1\"}" \
  | node -e '
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
});'
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
  if autodeploy_json="$(node "$STATE_HELPER" --env "$TARGET_ENV" --autodeploy "$SVC_WEB" 2>/dev/null)"; then
    echo "web-test autodeploy: $autodeploy_json"
  else
    echo "web-test autodeploy: unreadable" >&2
  fi
}

# --- commands --------------------------------------------------------------
case "$COMMAND" in
  status)
    echo "railway-test-env: test environment $TARGET_ENV"
    show_status
    ;;
  start)
    echo "railway-test-env: starting test env $TARGET_ENV (DB first)"
    # Idempotent start: everything already running+healthy -> ok 0.
    if read_snapshot; then
      all_up=1
      for key in web db push; do
        r="$(svc_running "$key")"; c="$(svc_crashed "$key")"
        case "$r" in ''|*[!0-9]*) r=0 ;; esac
        case "$c" in ''|*[!0-9]*) c=0 ;; esac
        if [ "$r" -le 0 ] || [ "$c" -gt 0 ]; then all_up=0; fi
      done
      if [ "$all_up" -eq 1 ] && railway ssh -p "$PROJECT" -e "$TARGET_ENV" -s "$SVC_DB" -- pg_isready >/dev/null 2>&1; then
        echo "railway-test-env: test environment already running+healthy (idempotent start)"
        autodeploy_disable || exit 1
        exit 0
      fi
    fi
    # DB first (image source): redeploy, capture the new deployment id from
    # the scoped list, wait running>0, then prove pg_isready.
    if ! railway redeploy -s "$SVC_DB" -e "$TARGET_ENV" -p "$PROJECT" --yes; then
      echo "railway-test-env: DB redeploy request failed" >&2
      exit 1
    fi
    if new_db_dep="$(scoped_deployment_ids "$SVC_DB" | head -n 1)"; then
      [ -n "$new_db_dep" ] && echo "railway-test-env: Postgres-ltHj redeploy requested (newest scoped deployment $new_db_dep)"
    fi
    wait_for_running db "Postgres-ltHj" || exit 1
    wait_for_db_ready || exit 1
    # Web via deploymentRedeploy (works with autodeploy off), else --from-source.
    web_latest="$(svc_latest web)"
    if [ -n "$web_latest" ]; then
      deployment_redeploy "$web_latest" || {
        echo "railway-test-env: web deploymentRedeploy failed" >&2
        exit 1
      }
    else
      railway redeploy -s "$SVC_WEB" -e "$TARGET_ENV" -p "$PROJECT" --from-source --yes || {
        echo "railway-test-env: web redeploy --from-source failed" >&2
        exit 1
      }
    fi
    wait_for_running web "web-test" || exit 1
    # Push: redeployable historical deployment wins; `railway up` only from a
    # validated clean checkout. startCommand (npm run push:worker) preserved.
    push_latest="$(svc_latest push)"
    if [ -n "$push_latest" ]; then
      deployment_redeploy "$push_latest" || {
        echo "railway-test-env: push deploymentRedeploy failed" >&2
        exit 1
      }
    else
      validate_clean_checkout || exit 1
      railway up --service "$SVC_PUSH" --environment "$TARGET_ENV" --project "$PROJECT" --detach --yes || {
        echo "railway-test-env: push 'railway up' fallback failed" >&2
        exit 1
      }
    fi
    wait_for_running push "push-delivery" || exit 1
    autodeploy_disable || exit 1
    echo "railway-test-env: test environment started (deployments running + DB probe verified; autodeploy stays off)"
    show_status || echo "railway-test-env: WARNING: started, but the final status readback failed" >&2
    ;;
  stop)
    echo "railway-test-env: stopping test env $TARGET_ENV (dependents first, DB last)"
    # Idempotent stop: everything already parked -> ok 0 (after autodeploy off).
    if read_snapshot; then
      if svc_parked web && svc_parked push && svc_parked db; then
        echo "railway-test-env: test environment already parked (idempotent stop)"
        autodeploy_disable || exit 1
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
    echo "railway-test-env: test environment stopped (dependents parked, DB parked; data, volumes, variables, and config are retained)"
    echo "railway-test-env: restart later with: sh scripts/railway-test-env.sh start"
    show_status || echo "railway-test-env: WARNING: stopped, but the final status readback failed" >&2
    ;;
esac
cleanup_snap
