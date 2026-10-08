#!/bin/sh
# railway-test-env-script.test.sh — stub-CLI tests for
# scripts/railway-test-env.sh. Executes the real script against a stub
# `railway` binary on PATH, so readiness and drain-ordering behavior is
# exercised end to end without touching Railway.
#
# The stub answers `service list --json` from $STUB_STATE_DIR/state.json
# (an array shaped like the real CLI: id, status, latestDeployment.status,
# replicas{configured,running,crashed}, regions[{name}]), appends every
# `scale` and `ssh` invocation to $STUB_STATE_DIR/calls.log, and honors
# failure-injection files:
#   fail-service-list-once  -> first `service list` exits 1, then succeeds
#   fail-service-list-always-> every `service list` exits 1
#   invalid-service-list    -> `service list` prints non-JSON
#   fail-ssh                -> `ssh ... pg_isready` exits 1 (DB never ready)
#   missing-service:<id>    -> that service is dropped from the list output
#
# Scale calls mutate state.json (region=N sets configured=N; scaling to 0
# also drops running to 0, modelling drain; scaling to 1 leaves running
# untouched so the fixture controls when convergence happens — unless
# the fixture sets auto_converge, which flips running=N immediately).
#
# Five cases: (a) stale SUCCESS + 0/0 replicas must NOT report started
# (finding 1 repro); (b) happy-path start converges; (c) stop drains
# dependents before touching the DB and verifies DB 0/0; (d) dependents
# that never drain keep the DB up + nonzero exit; (e) CLI/readback errors
# exit nonzero (missing service, invalid JSON, persistent CLI failure,
# failed DB probe). Each case asserts on exit codes AND the ordered
# calls.log. Fast: RAILWAY_TEST_ENV_POLL_INTERVAL=1 with short --timeout.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/railway-test-env.sh"

PROJECT="10168080-e6e5-4e65-a8ec-b92f6cf514e5"
TEST_ENV="877f4590-5eb0-4aed-b811-d7d234195169"
SVC_WEB="fd533f19-cbed-4023-96e6-463dd299815e"
SVC_DB="c44519a3-f013-4d49-a62b-7ca3bd61c4ff"
SVC_PUSH="d528d77e-fd99-4cd2-8c58-e9c4680e7587"

PASS=0
FAIL=0

new_case() {
  CASE_DIR="$(mktemp -d)"
  STUB_BIN="$CASE_DIR/bin"
  export STUB_STATE_DIR="$CASE_DIR/state"
  mkdir -p "$STUB_BIN" "$STUB_STATE_DIR"
  cat >"$STUB_BIN/railway" <<'STUB_EOF'
#!/bin/sh
# Stub railway: see header comment in railway-test-env-script.test.sh.
LOG="$STUB_STATE_DIR/calls.log"
echo "railway $*" >>"$LOG"
# A stale SUCCESS deployment is always reported: the pre-fix script treated
# this as readiness (finding 1); the fixed script must never consult it.
if [ "$1" = "deployment" ] && [ "${2:-}" = "list" ]; then
  echo '[{"id":"stale-deployment-id","status":"SUCCESS"}]'
  exit 0
fi
if [ "$1" = "service" ] && [ "${2:-}" = "list" ]; then
  if [ -f "$STUB_STATE_DIR/fail-service-list-always" ]; then
    echo "stub: persistent service-list failure" >&2
    exit 1
  fi
  if [ -f "$STUB_STATE_DIR/fail-service-list-once" ]; then
    rm -f "$STUB_STATE_DIR/fail-service-list-once"
    echo "stub: transient service-list failure" >&2
    exit 1
  fi
  if [ -f "$STUB_STATE_DIR/invalid-service-list" ]; then
    echo "this is not json{{{"
    exit 0
  fi
  node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
let services = JSON.parse(fs.readFileSync(dir + "/state.json", "utf8"));
const missing = fs.readdirSync(dir)
  .filter((f) => f.startsWith("missing-service:"))
  .map((f) => f.slice("missing-service:".length));
services = services.filter((s) => !missing.includes(s.id));
process.stdout.write(JSON.stringify(services));'
  exit $?
fi
if [ "$1" = "scale" ]; then
  node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const state = JSON.parse(fs.readFileSync(dir + "/state.json", "utf8"));
const args = process.argv.slice(1);
let serviceId = null;
const assignments = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--service") serviceId = args[++i];
  else if (/^[^ =]+=(\d+)$/.test(args[i])) assignments.push(args[i]);
}
const svc = state.find((s) => s.id === serviceId);
if (!svc) { console.error("stub: unknown service " + serviceId); process.exit(1); }
for (const a of assignments) {
  const n = Number(a.split("=")[1]);
  const auto = fs.existsSync(dir + "/auto_converge");
  svc.replicas.configured = n;
  if (n === 0) svc.replicas.running = 0;
  else if (auto) svc.replicas.running = n;
}
fs.writeFileSync(dir + "/state.json", JSON.stringify(state));' "$@"
  exit $?
fi
if [ "$1" = "ssh" ]; then
  if [ -f "$STUB_STATE_DIR/fail-ssh" ]; then
    echo "stub: pg_isready: no response" >&2
    exit 1
  fi
  echo "postgres-lthj.railway.internal:5432 - accepting connections"
  exit 0
fi
echo "stub: unexpected railway invocation: $*" >&2
exit 99
STUB_EOF
  chmod +x "$STUB_BIN/railway"
  : >"$STUB_STATE_DIR/calls.log"
  export PATH="$STUB_BIN:$PATH"
}

end_case() {
  rm -rf "$CASE_DIR"
}

write_state() {
  # $1 = JSON array of services; covers all three services via heredoc body.
  cat >"$STUB_STATE_DIR/state.json"
}

svc() {
  # $1=id, $2=status, $3=configured, $4=running, $5=crashed, $6=region
  printf '{"id":"%s","name":"%s","status":"%s","latestDeployment":{"id":"dep-%s","status":"%s"},"replicas":{"configured":%s,"running":%s,"crashed":%s},"regions":[{"name":"%s"}]}' \
    "$1" "$1" "$2" "$1" "$2" "$3" "$4" "$5" "$6"
}

run_script() {
  # Runs the script under test; captures exit without tripping `set -e`.
  set +e
  RAILWAY_TEST_ENV_POLL_INTERVAL=1 sh "$SCRIPT" "$@" >"$CASE_DIR/out.txt" 2>"$CASE_DIR/err.txt"
  RC=$?
  set -e
}

check() {
  # $1 = description, $2 = shell condition (eval'd)
  if eval "$2"; then
    PASS=$((PASS + 1))
    echo "ok: $1"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $1"
  fi
}

log_has_nth_scale() {
  # $1 = 1-based scale-call index, $2 = expected service id, $3 = expected count
  line="$(grep "^railway scale " "$STUB_STATE_DIR/calls.log" | sed -n "${1}p")"
  case "$line" in
    *"--service $2 "*|*"--service $2") : ;;
    *) return 1 ;;
  esac
  case "$line" in
    *"$3") return 0 ;;
    *) return 1 ;;
  esac
}

db_scaled() {
  grep -q "railway scale .*--service $SVC_DB" "$STUB_STATE_DIR/calls.log"
}

# --- (a) stale SUCCESS + 0/0 replicas must NOT report started --------------
new_case
write_state <<JSON
[$(svc "$SVC_DB" SUCCESS 0 0 0 sfo),$(svc "$SVC_WEB" SUCCESS 0 0 0 sfo),$(svc "$SVC_PUSH" SUCCESS 0 0 0 europe-west4-drams3a)]
JSON
run_script start --timeout 3
check "a: stale SUCCESS + 0/0 replicas exits nonzero" "[ $RC -ne 0 ]"
check "a: does not claim started" "! grep -q 'test environment started' '$CASE_DIR/out.txt'"
check "a: DB scale comes before any dependent scale" "log_has_nth_scale 1 '$SVC_DB' '=1'"
check "a: deployment SUCCESS is not treated as readiness" "! grep -q ' is SUCCESS' '$CASE_DIR/out.txt'"
end_case

# --- (b) happy-path start converges -----------------------------------------
new_case
touch "$STUB_STATE_DIR/auto_converge"
write_state <<JSON
[$(svc "$SVC_DB" SUCCESS 0 0 0 sfo),$(svc "$SVC_WEB" SUCCESS 0 0 0 sfo),$(svc "$SVC_PUSH" SUCCESS 0 0 0 europe-west4-drams3a)]
JSON
run_script start --timeout 20
check "b: happy-path start exits 0" "[ $RC -eq 0 ]"
check "b: reports started with convergence evidence" "grep -q 'test environment started' '$CASE_DIR/out.txt'"
check "b: DB converges before dependents scale" "log_has_nth_scale 1 '$SVC_DB' '=1'"
check "b: DB readiness probe ran (pg_isready over ssh)" "grep -q 'railway ssh .*pg_isready' '$STUB_STATE_DIR/calls.log' && grep -q 'accepts connections' '$CASE_DIR/out.txt'"
web_scale_line="$(grep -n "railway scale .*--service $SVC_WEB" "$STUB_STATE_DIR/calls.log" | head -1 | cut -d: -f1)"
probe_line="$(grep -n "railway ssh " "$STUB_STATE_DIR/calls.log" | head -1 | cut -d: -f1)"
check "b: dependents scale only after DB probe" "[ -n '$web_scale_line' ] && [ -n '$probe_line' ] && [ '$probe_line' -lt '$web_scale_line' ]"
check "b: both dependents converge" "grep -q 'web-test.*converged' '$CASE_DIR/out.txt' && grep -q 'push-delivery.*converged' '$CASE_DIR/out.txt'"
end_case

# --- (c) stop drains dependents before DB, verifies DB 0/0 ------------------
new_case
write_state <<JSON
[$(svc "$SVC_DB" SUCCESS 1 1 0 sfo),$(svc "$SVC_WEB" SUCCESS 1 1 0 sfo),$(svc "$SVC_PUSH" SUCCESS 1 1 0 europe-west4-drams3a)]
JSON
run_script stop --timeout 20
check "c: stop exits 0" "[ $RC -eq 0 ]"
check "c: first scale is web, second is push, third is DB" "log_has_nth_scale 1 '$SVC_WEB' '=0' && log_has_nth_scale 2 '$SVC_PUSH' '=0' && log_has_nth_scale 3 '$SVC_DB' '=0'"
check "c: exactly three scale calls" "[ \"\$(grep -c '^railway scale ' '$STUB_STATE_DIR/calls.log')\" -eq 3 ]"
check "c: DB drain verified" "grep -q 'Postgres-ltHj drained' '$CASE_DIR/out.txt'"
end_case

# --- (d) dependents never drain: DB stays up, nonzero exit ------------------
new_case
write_state <<JSON
[$(svc "$SVC_DB" SUCCESS 1 1 0 sfo),$(svc "$SVC_WEB" SUCCESS 1 1 0 sfo),$(svc "$SVC_PUSH" SUCCESS 0 0 0 europe-west4-drams3a)]
JSON
# Web's running count is pinned at 1 via a shim around the stub binary:
# after every scale call, web is restored to running=1/configured=1,
# modelling replicas that never drain. Paths are baked into the shim at
# write time (a child process would not see shell-only variables).
mv "$STUB_BIN/railway" "$STUB_BIN/railway.real"
cat >"$STUB_BIN/railway" <<SHIM_EOF
#!/bin/sh
"$STUB_BIN/railway.real" "\$@"
rc=\$?
if [ "\$1" = "scale" ]; then
  STUB_STATE_DIR="$STUB_STATE_DIR" STUCK_SVC="$SVC_WEB" node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const state = JSON.parse(fs.readFileSync(dir + "/state.json", "utf8"));
const web = state.find((s) => s.id === process.env.STUCK_SVC);
if (web) { web.replicas.running = 1; web.replicas.configured = 1; }
fs.writeFileSync(dir + "/state.json", JSON.stringify(state));'
fi
exit \$rc
SHIM_EOF
chmod +x "$STUB_BIN/railway"
run_script stop --timeout 3
check "d: stuck dependents exit nonzero" "[ $RC -ne 0 ]"
check "d: DB never scaled (left up)" "! db_scaled"
check "d: operator told the DB was left up" "grep -q 'leaving Postgres-ltHj UP' '$CASE_DIR/err.txt'"
end_case

# --- (e) CLI/readback errors exit nonzero -----------------------------------
# e1: persistent service-list failure on start.
new_case
write_state <<JSON
[$(svc "$SVC_DB" SUCCESS 0 0 0 sfo),$(svc "$SVC_WEB" SUCCESS 0 0 0 sfo),$(svc "$SVC_PUSH" SUCCESS 0 0 0 europe-west4-drams3a)]
JSON
touch "$STUB_STATE_DIR/fail-service-list-always"
run_script start --timeout 3
check "e1: persistent read failure exits nonzero" "[ $RC -ne 0 ]"
check "e1: never claims started" "! grep -q 'test environment started' '$CASE_DIR/out.txt'"
end_case

# e2: missing service refused.
new_case
touch "$STUB_STATE_DIR/auto_converge"
write_state <<JSON
[$(svc "$SVC_DB" SUCCESS 0 0 0 sfo),$(svc "$SVC_WEB" SUCCESS 0 0 0 sfo),$(svc "$SVC_PUSH" SUCCESS 0 0 0 europe-west4-drams3a)]
JSON
touch "$STUB_STATE_DIR/missing-service:$SVC_PUSH"
run_script start --timeout 20
check "e2: missing service exits nonzero" "[ $RC -ne 0 ]"
check "e2: missing service named" "grep -q 'not found' '$CASE_DIR/err.txt'"
check "e2: never claims started" "! grep -q 'test environment started' '$CASE_DIR/out.txt'"
end_case

# e3: invalid JSON refused.
new_case
write_state <<JSON
[$(svc "$SVC_DB" SUCCESS 0 0 0 sfo),$(svc "$SVC_WEB" SUCCESS 0 0 0 sfo),$(svc "$SVC_PUSH" SUCCESS 0 0 0 europe-west4-drams3a)]
JSON
touch "$STUB_STATE_DIR/invalid-service-list"
run_script start --timeout 3
check "e3: invalid JSON exits nonzero" "[ $RC -ne 0 ]"
end_case

# e4: FAILED deployment refused even with converged replicas.
new_case
write_state <<JSON
[$(svc "$SVC_DB" FAILED 1 1 0 sfo),$(svc "$SVC_WEB" SUCCESS 0 0 0 sfo),$(svc "$SVC_PUSH" SUCCESS 0 0 0 europe-west4-drams3a)]
JSON
run_script start --timeout 5
check "e4: FAILED latest deployment exits nonzero" "[ $RC -ne 0 ]"
check "e4: dependents never scaled after FAILED DB" "! grep -q 'railway scale .*--service $SVC_WEB' '$STUB_STATE_DIR/calls.log'"
end_case

# e5: DB probe failure aborts start before dependents.
new_case
touch "$STUB_STATE_DIR/auto_converge"
write_state <<JSON
[$(svc "$SVC_DB" SUCCESS 0 0 0 sfo),$(svc "$SVC_WEB" SUCCESS 0 0 0 sfo),$(svc "$SVC_PUSH" SUCCESS 0 0 0 europe-west4-drams3a)]
JSON
touch "$STUB_STATE_DIR/fail-ssh"
run_script start --timeout 3
check "e5: failed DB probe exits nonzero" "[ $RC -ne 0 ]"
check "e5: dependents never scale when DB is unproven" "! grep -q 'railway scale .*--service $SVC_WEB' '$STUB_STATE_DIR/calls.log' && ! grep -q 'railway scale .*--service $SVC_PUSH' '$STUB_STATE_DIR/calls.log'"
end_case

# e6: crashed replicas refused.
new_case
write_state <<JSON
[$(svc "$SVC_DB" SUCCESS 1 1 2 sfo),$(svc "$SVC_WEB" SUCCESS 0 0 0 sfo),$(svc "$SVC_PUSH" SUCCESS 0 0 0 europe-west4-drams3a)]
JSON
run_script start --timeout 5
check "e6: crashed replicas exit nonzero" "[ $RC -ne 0 ]"
check "e6: crash named, dependents untouched" "grep -q 'crashed' '$CASE_DIR/err.txt' && ! grep -q 'railway scale .*--service $SVC_WEB' '$STUB_STATE_DIR/calls.log'"
end_case

echo "---"
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
