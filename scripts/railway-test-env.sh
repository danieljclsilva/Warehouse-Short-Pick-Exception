#!/bin/sh
# railway-test-env.sh — safe on-demand start/stop/status for the Railway
# `test` environment. Single-file dispatcher (start|stop|status) so the
# production guard lives in exactly one place.
#
# Mechanism (verified read-only against Railway CLI 5.62.1, 2026-10-08):
# there is NO `railway service stop`. Start/stop is implemented as
# replica scaling: `railway scale --service <id> -e <env-id> <region>=N`.
# Scaling to 0 keeps the service, its variables, config, and volumes intact
# (volumes verified: postgres-volume-yEF7 187MB/5GB on the DB service) and
# scaling back to 1 (or a fresh deploy) restores replicas. `railway down`
# (deployment removal) is deliberately NOT used: it only removes the latest
# deployment and is destructive-ish.
#
# Readiness is replica convergence, NEVER deployment status. Scaling changes
# replica config without redeploying, so a stale `SUCCESS` deployment says
# nothing about resumed instances. Every wait below polls
# `railway service list --json` for the scoped service and requires
# running>0 && running>=configured with configured>0 (start) or
# running=0 && configured=0 (stop). A missing service, unparseable data,
# crashed replicas, or a FAILED/CRASHED latest deployment aborts the run.
# `railway deployment list` is never consulted.
#
# Ordering: start brings the database up first, waits for replica
# convergence plus an in-container `pg_isready` probe (via `railway ssh`,
# so this step needs a registered SSH key), and only then scales the
# dependents; stop drains dependents first, verifies both read back 0/0,
# and only then touches the database.
# Status is read-only and runs without mutating anything, but it goes
# through the same guard so every command stays on one code path.
#
# Safety:
#  - Every command passes explicit --project/--environment/--service IDs.
#  - Target environment MUST equal the test env ID or the script aborts
#    (fail closed). Empty/unset resolves to the test env; production is
#    NEVER a default and is refused with a clear message.
#  - NO delete/destroy/remove commands anywhere in this file.
#
# Usage:
#   sh scripts/railway-test-env.sh status [--env <env-id>]
#   sh scripts/railway-test-env.sh start  [--env <env-id>] [--timeout N]
#   sh scripts/railway-test-env.sh stop   [--env <env-id>] [--timeout N]
#
# Test hook: RAILWAY_TEST_ENV_POLL_INTERVAL overrides the seconds between
# readiness polls (default 5). The stub test suite sets it to 1 to keep
# negative-path tests fast; operators should leave it unset.
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
GUARD="$SCRIPT_DIR/railway-test-env-guard.mjs"

PROJECT="$(node "$GUARD" --print project)"
TEST_ENV="$(node "$GUARD" --print test-env)"
SVC_WEB="$(node "$GUARD" --print service:web)"
SVC_DB="$(node "$GUARD" --print service:db)"
SVC_PUSH="$(node "$GUARD" --print service:push)"
REGION_WEB="$(node "$GUARD" --print region:web)"
REGION_DB="$(node "$GUARD" --print region:db)"
REGION_PUSH="$(node "$GUARD" --print region:push)"

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
# Status is read-only, but scoping it to the same approved target keeps
# every command on an identical code path. The guard resolves an empty
# override to the test env, refuses production explicitly, and refuses
# anything else as unknown.
TARGET_ENV="$(node "$GUARD" --assert-env "$ENV_OVERRIDE")" || exit 1

# --- helpers ---------------------------------------------------------------
# Snapshot plumbing uses a temp file + redirected read loop (never a pipe
# into `while`, which would subshell the SNAP_* assignments away, and never
# an unquoted heredoc, which would command-substitute service JSON).
SNAP_FILE=""
cleanup_snap() { [ -n "$SNAP_FILE" ] && rm -f "$SNAP_FILE"; SNAP_FILE=""; }
trap cleanup_snap EXIT HUP INT TERM

# One scoped read of `railway service list --json`, parsed once.
# $1 = service id. Writes KEY=VALUE lines (found, configured, running,
# crashed, depstatus, region*) to stdout. Exit 0 = readback ok (found=0
# when the service is absent from the env); 1 = CLI failure (transient,
# retryable); 3 = unparseable or invalid data (terminal).
service_snapshot() {
  # Two steps, not `railway ... | node`: plain `sh` has no pipefail, so a
  # pipe would silently discard one side's exit code. Capture the CLI
  # result first, then parse.
  if ! snap_json="$(railway service list -p "$PROJECT" -e "$TARGET_ENV" --json)"; then
    return 1
  fi
  snap_out="$(printf '%s' "$snap_json" | node -e '
let data = "";
process.stdin.on("data", (c) => { data += c; });
process.stdin.on("end", () => {
  let services;
  try {
    services = JSON.parse(data);
  } catch {
    process.exit(3);
  }
  if (!Array.isArray(services)) process.exit(3);
  const svc = process.argv[1];
  const match = services.find((s) => s && s.id === svc);
  if (!match) { console.log("found=0"); return; }
  console.log("found=1");
  const rep = match.replicas || {};
  for (const key of ["configured", "running", "crashed"]) {
    const value = rep[key];
    if (!Number.isInteger(value) || value < 0) process.exit(3);
    console.log(key + "=" + value);
  }
  const dep = (match.latestDeployment && match.latestDeployment.status) || match.status || "UNKNOWN";
  console.log("depstatus=" + dep);
  for (const region of match.regions || []) {
    if (region && region.name) console.log("region=" + region.name);
  }
});' "$1")"
  snap_rc=$?
  if [ "$snap_rc" -ne 0 ]; then
    return "$snap_rc"
  fi
  printf '%s\n' "$snap_out"
}

# Read one scoped service into SNAP_* globals.
# $1 = service id, $2 = label. Returns 0 (read ok), 1 (CLI failure,
# retryable), or 3 (missing service or invalid data: refuse immediately).
read_service() {
  SNAP_FOUND=""; SNAP_CONFIGURED=""; SNAP_RUNNING=""; SNAP_CRASHED=""
  SNAP_DEPSTATUS=""; SNAP_REGIONS=""
  snapshot="$(service_snapshot "$1")"
  snapshot_rc=$?
  if [ "$snapshot_rc" -ne 0 ]; then
    if [ "$snapshot_rc" -eq 3 ]; then
      echo "railway-test-env: service-list data for $2 is missing or invalid; refusing to continue" >&2
      return 3
    fi
    echo "railway-test-env: WARNING: service-list read failed while checking $2 (retrying until timeout)" >&2
    return 1
  fi
  cleanup_snap
  SNAP_FILE="$(mktemp)" || {
    echo "railway-test-env: could not create temp file; refusing to continue" >&2
    return 3
  }
  printf '%s\n' "$snapshot" >"$SNAP_FILE"
  while IFS="=" read -r snap_key snap_value; do
    case "$snap_key" in
      found) SNAP_FOUND="$snap_value" ;;
      configured) SNAP_CONFIGURED="$snap_value" ;;
      running) SNAP_RUNNING="$snap_value" ;;
      crashed) SNAP_CRASHED="$snap_value" ;;
      depstatus) SNAP_DEPSTATUS="$snap_value" ;;
      region) SNAP_REGIONS="$SNAP_REGIONS $snap_value" ;;
    esac
  done <"$SNAP_FILE"
  cleanup_snap
  if [ "$SNAP_FOUND" != "0" ] && [ "$SNAP_FOUND" != "1" ]; then
    echo "railway-test-env: service-list data for $2 is missing or invalid; refusing to continue" >&2
    return 3
  fi
  return 0
}

# Regions the service is currently configured in (live data wins; falls back
# to the pinned region when a zero-scaled service reports none). Refuses
# when the service is missing or unreadable — never scales blindly.
service_regions() {
  # $1 = service id, $2 = fallback region
  if ! snapshot="$(service_snapshot "$1")"; then
    echo "railway-test-env: could not read region list (is the CLI authenticated? try 'railway whoami')" >&2
    return 1
  fi
  if ! printf '%s\n' "$snapshot" | grep -q "^found=1$"; then
    echo "railway-test-env: service $1 not found in environment $TARGET_ENV; refusing to scale" >&2
    return 1
  fi
  live="$(printf '%s\n' "$snapshot" | sed -n 's/^region=//p')"
  if [ -z "$live" ]; then
    printf '%s\n' "$2"
  else
    printf '%s\n' "$live"
  fi
}

# Scale a service to N replicas in each of its configured regions.
scale_service() {
  # $1 = service id, $2 = label, $3 = fallback region, $4 = replica count
  if ! regions_list="$(service_regions "$1" "$3")"; then
    echo "railway-test-env: could not resolve regions for $2; refusing to scale blindly" >&2
    return 1
  fi
  assignments=""
  # shellcheck disable=SC2086
  for region in $regions_list; do
    assignments="$assignments $region=$4"
  done
  # shellcheck disable=SC2086
  if ! railway scale -p "$PROJECT" -e "$TARGET_ENV" --service "$1" $assignments; then
    echo "railway-test-env: scale request failed for $2; aborting" >&2
    return 1
  fi
  echo "railway-test-env: $2 scale requested ($assignments )"
}

# Check one convergence gate.
# $1 = service id, $2 = label, $3 = want ("up" or "zero").
# "up" needs configured>0, running>0, running>=configured. "zero" needs
# running=0 AND configured=0 (a configured-but-not-yet-running service is
# not drained). Returns 0 converged, 1 not-yet (retry), 3 terminal refusal.
check_converged() {
  read_service "$1" "$2" || return $?
  if [ "$SNAP_FOUND" != "1" ]; then
    echo "railway-test-env: $2 not found in environment $TARGET_ENV; refusing to continue" >&2
    return 3
  fi
  case "$SNAP_DEPSTATUS" in
    FAILED|CRASHED)
      echo "railway-test-env: $2 latest deployment is $SNAP_DEPSTATUS; refusing to continue (see 'railway logs --service $1')" >&2
      return 3 ;;
  esac
  if [ "$SNAP_CRASHED" -gt 0 ]; then
    echo "railway-test-env: $2 reports $SNAP_CRASHED crashed replica(s); refusing to continue (see 'railway logs --service $1')" >&2
    return 3
  fi
  if [ "$3" = "zero" ]; then
    if [ "$SNAP_RUNNING" -eq 0 ] && [ "$SNAP_CONFIGURED" -eq 0 ]; then
      echo "railway-test-env: $2 drained (running=0, configured=0)"
      return 0
    fi
    return 1
  fi
  if [ "$SNAP_CONFIGURED" -gt 0 ] && [ "$SNAP_RUNNING" -gt 0 ] && [ "$SNAP_RUNNING" -ge "$SNAP_CONFIGURED" ]; then
    echo "railway-test-env: $2 converged (running=$SNAP_RUNNING, configured=$SNAP_CONFIGURED)"
    return 0
  fi
  return 1
}

# Poll one convergence gate until it holds or TIMEOUT_SECONDS elapses.
# Terminal refusals abort immediately; CLI hiccups retry until the
# deadline. Exit 0 converged, 1 otherwise.
wait_for_replicas() {
  # $1 = service id, $2 = label, $3 = want ("up"|"zero")
  deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
  while :; do
    if check_converged "$1" "$2" "$3"; then
      return 0
    else
      wait_rc=$?
      if [ "$wait_rc" -eq 3 ]; then
        return 1
      fi
    fi
    now=$(date +%s)
    if [ "$now" -ge "$deadline" ]; then
      echo "railway-test-env: timed out after ${TIMEOUT_SECONDS}s waiting for $2 (last: running=${SNAP_RUNNING:-?}, configured=${SNAP_CONFIGURED:-?})" >&2
      return 1
    fi
    sleep "$POLL_INTERVAL_SECONDS"
  done
}

# Prove the resumed Postgres actually accepts connections. Replica counts
# alone cannot: a container can be scheduled while Postgres is still
# starting. Runs `pg_isready` inside the DB container over `railway ssh`
# (needs a registered SSH key; see `railway ssh keys`). The DB host is a
# `*.railway.internal` name, unreachable from the operator shell, so there
# is no direct-TCP alternative from here.
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

show_status() {
  railway service list -p "$PROJECT" -e "$TARGET_ENV" --json \
    | node -e '
let data = "";
process.stdin.on("data", (c) => { data += c; });
process.stdin.on("end", () => {
  const services = JSON.parse(data);
  for (const s of services) {
    const configured = s.replicas ? s.replicas.configured : "?";
    const running = s.replicas ? s.replicas.running : "?";
    const crashed = s.replicas ? s.replicas.crashed : "?";
    const regions = ((s.regions) || []).map((r) => r.name).join(",") || "-";
    console.log(`${s.name} [${s.id}]: status=${s.status} replicas=${running}/${configured} crashed=${crashed} regions=${regions}`);
  }
});'
}

# --- commands --------------------------------------------------------------
case "$COMMAND" in
  status)
    echo "railway-test-env: test environment $TARGET_ENV"
    show_status
    ;;
  start)
    echo "railway-test-env: starting test env $TARGET_ENV (DB first)"
    scale_service "$SVC_DB" "Postgres-ltHj" "$REGION_DB" 1 || exit 1
    wait_for_replicas "$SVC_DB" "Postgres-ltHj" up || exit 1
    wait_for_db_ready || exit 1
    scale_service "$SVC_WEB" "web-test" "$REGION_WEB" 1 || exit 1
    scale_service "$SVC_PUSH" "push-delivery" "$REGION_PUSH" 1 || exit 1
    wait_for_replicas "$SVC_WEB" "web-test" up || exit 1
    wait_for_replicas "$SVC_PUSH" "push-delivery" up || exit 1
    echo "railway-test-env: test environment started (replica convergence + DB probe verified)"
    show_status || echo "railway-test-env: WARNING: started, but the final status readback failed" >&2
    ;;
  stop)
    echo "railway-test-env: stopping test env $TARGET_ENV (dependents first, DB last)"
    scale_service "$SVC_WEB" "web-test" "$REGION_WEB" 0 || exit 1
    scale_service "$SVC_PUSH" "push-delivery" "$REGION_PUSH" 0 || exit 1
    # Drain gate: both dependents must read back running=0 AND
    # configured=0 before the database is touched. Any timeout or
    # readback failure exits nonzero WITH THE DATABASE LEFT UP.
    wait_for_replicas "$SVC_WEB" "web-test" zero || {
      echo "railway-test-env: web-test drain unconfirmed; leaving Postgres-ltHj UP" >&2
      exit 1
    }
    wait_for_replicas "$SVC_PUSH" "push-delivery" zero || {
      echo "railway-test-env: push-delivery drain unconfirmed; leaving Postgres-ltHj UP" >&2
      exit 1
    }
    scale_service "$SVC_DB" "Postgres-ltHj" "$REGION_DB" 0 || exit 1
    wait_for_replicas "$SVC_DB" "Postgres-ltHj" zero || {
      echo "railway-test-env: Postgres-ltHj stop unconfirmed (scale was requested); check status before retrying" >&2
      exit 1
    }
    echo "railway-test-env: test environment stopped (dependents drained, DB at 0/0); data, volumes, variables, and config are retained"
    echo "railway-test-env: restart later with: sh scripts/railway-test-env.sh start"
    show_status || echo "railway-test-env: WARNING: stopped, but the final status readback failed" >&2
    ;;
esac
