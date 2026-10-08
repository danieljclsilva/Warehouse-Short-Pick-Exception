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
# `railway service redeploy --from-source` (or a fresh deploy) restores
# replicas. `railway down` (deployment removal) is deliberately NOT used:
# it only removes the latest deployment and is destructive-ish.
#
# Ordering: start brings the database up first and waits for SUCCESS before
# dependents; stop drains dependents first, then the database.
# Status is read-only and runs without the guard (it cannot mutate).
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
      sed -n '2,32p' "$0" | sed 's/^# \?//'; exit 0 ;;
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

# --- production guard (fail closed) --------------------------------------
# Status is read-only, but scoping it to the same approved target keeps
# every command on an identical code path. The guard resolves an empty
# override to the test env, refuses production explicitly, and refuses
# anything else as unknown.
TARGET_ENV="$(node "$GUARD" --assert-env "$ENV_OVERRIDE")" || exit 1

# --- helpers ---------------------------------------------------------------
# Regions the service is currently configured in (live data wins; falls back
# to the pinned region when a zero-scaled service reports none).
service_regions() {
  # $1 = service id, $2 = fallback region
  live="$(railway service list -p "$PROJECT" -e "$TARGET_ENV" --json \
    | node -e '
const svc = process.argv[1];
let data = "";
process.stdin.on("data", (c) => { data += c; });
process.stdin.on("end", () => {
  try {
    const services = JSON.parse(data);
    const match = services.find((s) => s.id === svc);
    const regions = ((match && match.regions) || [])
      .map((r) => r.name)
      .filter(Boolean);
    for (const name of regions) console.log(name);
  } catch { process.exit(1); }
});' "$1")" || {
    echo "railway-test-env: could not read region list (is the CLI authenticated? try 'railway whoami')" >&2
    return 1
  }
  if [ -z "$live" ]; then
    printf '%s\n' "$2"
  else
    printf '%s\n' "$live"
  fi
}

# Scale a service to N replicas in each of its configured regions.
scale_service() {
  # $1 = service id, $2 = fallback region, $3 = replica count
  assignments=""
  for region in $(service_regions "$1" "$2"); do
    assignments="$assignments $region=$3"
  done
  # shellcheck disable=SC2086
  railway scale -p "$PROJECT" -e "$TARGET_ENV" --service "$1" $assignments
}

latest_status() {
  # $1 = service id -> prints "deployId status"
  railway deployment list -p "$PROJECT" -e "$TARGET_ENV" -s "$1" \
    --limit 1 --json \
    | node -e '
let data = "";
process.stdin.on("data", (c) => { data += c; });
process.stdin.on("end", () => {
  try {
    const [latest] = JSON.parse(data);
    if (!latest) { console.log("NONE NONE"); return; }
    console.log(`${latest.id} ${latest.status}`);
  } catch { process.exit(1); }
});'
}

# Wait until the latest deployment reaches one of the accepted statuses.
wait_for_status() {
  # $1 = service id, $2 = label, $3 = accepted statuses (space-separated)
  deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
  while :; do
    set -- "$1" "$2" "$3" $(latest_status "$1")
    id="$4"; status="$5"
    for want in $3; do
      if [ "$status" = "$want" ]; then
        echo "railway-test-env: $2 is $status (deployment $id)"
        return 0
      fi
    done
    case "$status" in
      FAILED|CRASHED)
        echo "railway-test-env: $2 entered $status (deployment $id); refusing to continue" >&2
        return 1 ;;
    esac
    now=$(date +%s)
    if [ "$now" -ge "$deadline" ]; then
      echo "railway-test-env: timed out after ${TIMEOUT_SECONDS}s waiting for $2 (last: $status, deployment $id)" >&2
      return 1
    fi
    sleep 10
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
    const regions = ((s.regions) || []).map((r) => r.name).join(",") || "-";
    console.log(`${s.name} [${s.id}]: status=${s.status} replicas=${running}/${configured} regions=${regions}`);
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
    scale_service "$SVC_DB" "$REGION_DB" 1
    wait_for_status "$SVC_DB" "Postgres-ltHj" "SUCCESS" || exit 1
    scale_service "$SVC_WEB" "$REGION_WEB" 1
    scale_service "$SVC_PUSH" "$REGION_PUSH" 1
    wait_for_status "$SVC_WEB" "web-test" "SUCCESS" || exit 1
    wait_for_status "$SVC_PUSH" "push-delivery" "SUCCESS" || exit 1
    echo "railway-test-env: test environment started"
    show_status
    ;;
  stop)
    echo "railway-test-env: stopping test env $TARGET_ENV (dependents first, DB last)"
    scale_service "$SVC_WEB" "$REGION_WEB" 0
    scale_service "$SVC_PUSH" "$REGION_PUSH" 0
    scale_service "$SVC_DB" "$REGION_DB" 0
    echo "railway-test-env: stop requested; data, volumes, variables, and config are retained"
    echo "railway-test-env: restart later with: sh scripts/railway-test-env.sh start"
    show_status
    ;;
esac
