#!/bin/sh
# railway-test-env-script.test.sh — stub-CLI tests for
# scripts/railway-test-env.sh + scripts/railway-test-env-state.mjs. Executes
# the real script against a stub `railway` binary on a scrubbed PATH, so
# native deployment-stop/start behavior is exercised end to end without
# touching Railway (no live access of any kind).
#
# Native lifecycle (post zero-scale failure): there is NO `railway scale`
# path. Stop disables TEST web autodeploy first (nested `input` variables,
# verified false), then parks web+push via deploymentStop over the FULL
# scoped snapshot (serviceInstance activeDeployments + deployments list),
# verifies parked (running==0, no active non-stopped, no pending; configured
# ignored), and only then stops the DB. deploymentRemove is ONLY for
# QUEUED/INITIALIZING/WAITING singles that survive a stop round. Start
# redeploys DB first (running>0 + pg_isready before dependents), web via
# deploymentRedeploy (or redeploy --from-source), push via deploymentRedeploy
# (or `railway up` from a validated clean checkout). Autodeploy stays off.
#
# The stub answers from $STUB_STATE_DIR fixtures:
#   instances.json    — serviceId -> serviceInstance payload (scalar
#                       numReplicas, source, startCommand, latestDeployment
#                       {id,status,deploymentStopped}|null, activeDeployments[])
#   deployments.json  — serviceId -> newest-first scoped deployment nodes
#                       [{id,status,deploymentStopped,serviceId,environmentId}]
#   servicelist.json  — array for `railway service list --json`
#                       [{id, replicas:{configured,running,crashed}}]; a
#                       missing replicas object mirrors live null replicas
#   autodeploy.json   — {enabled, canEnable} for the web autodeploy probe
# and appends every `railway`/`git` invocation to calls.log. Mutations mutate
# the fixtures (deploymentStop marks stopped + recomputes running,
# deploymentRemove deletes early-stage singles, redeploy/up resume running).
# Failure injection files:
#   fail-api-always / fail-api-once / invalid-api  -> scoped read queries fail
#   fail-service-list-always / fail-service-list-once / invalid-service-list
#   missing-service:<id>  -> that service reads back null/empty (terminal)
#   fail-ssh              -> `ssh ... pg_isready` exits 1 (DB never ready)
#   fail-autodeploy       -> autodeploy update mutation leaves enabled=true
#   fail-mutation-once    -> first StopDeployment exits 1 (mid-drain error)
#   fail-redeploy         -> RedeployDeployment exits 1
#   never-converge        -> redeploy/up mutations are no-ops (running stays 0)
#   defer-next-<svc> heads N -> armed as defer-converge-<svc> when that
#                            service next redeploys (async-build model)
#   defer-fresh-<svc>     -> `railway redeploy`/RedeployDeployment mints the
#                            fresh id as BUILDING with no running flip
#                            (gradual-build model; old generation keeps
#                            running while the fresh id builds)
#   defer-converge-<svc>  -> that service lands after N service-list reads
#                            (running stays 0 + stale crashed persists
#                            until the countdown lands)
#   stubborn-stop         -> StopDeployment succeeds without mutating (no park)
#   resist-stop-<dep-id>  -> that deployment survives StopDeployment (removal path)
#   pin-running-<svc-id>  -> that service's running stays 1 (stuck drain)
#   race-swap-web         -> a new BUILDING web deployment appears on the 3rd
#                            scoped web-deployments read (mid-drain race)
#   git-dirty             -> `git status --porcelain` prints this file (dirty)
#   git-ignore-all        -> `git check-ignore` treats every path as ignored
#
# Stub matching: `railway api` branches match on GraphQL operation names
# (AutoDeployStatus, AutoDeployUpdate, serviceInstanceRedeploy,
# RedeployDeployment, StopDeployment, RemoveDeployment) — NEVER on bare
# field substrings such as deploymentStop, which also occur inside
# deploymentStopped selections of read queries. Every inline `node -e`
# script closes with a trailing quote plus an explicit argument
# (' "$VARS", ' "$DEP_ID", ' "$VARS" "$STUB_SVC_WEB").
#
# Assertion helpers (id-scoped, fail-closed):
#   stop_logged/remove_logged/redeploy_logged <dep-id> — that deployment id
#     appears in calls.log variables alongside the matching operation name.
#   mut_logged <dep-id> — any mutation variables reference that id (scoped
#     reads only ever log service ids, so a deployment id in calls.log
#     proves a mutation targeted it).
#   mut_order <first-id> <second-id> — first mutation precedes the second.
#   log_order <first-op> <second-op> — first operation string precedes it.
# Mutation greps always use operation names (StopDeployment etc.), never
# bare field names that also match read selections.
#
# Live-shape mirrors (pinned IDs; web a9de8c69 CRASHED+stopped running0/
# configured1; DB 44f2bae4 SUCCESS+stopped 0/1; push latest null, active[],
# null replicas, startCommand retained; REMOVED history ids e88842ae/
# de074c88 never resurface). Fast: RAILWAY_TEST_ENV_POLL_INTERVAL=1 with
# short --timeout values.
set -eu

# Resolve the repo root even when a runner invokes this file with $0 set to
# an empty or relative path (dirname would yield an empty path otherwise).
ROOT="$(CDPATH= cd -- "$(dirname -- "${0:-.}")/.." 2>/dev/null && pwd)" || ROOT="$PWD"
if [ ! -f "$ROOT/scripts/railway-test-env.sh" ]; then
  ROOT="$PWD"
fi
SCRIPT="$ROOT/scripts/railway-test-env.sh"
STATE_HELPER="$ROOT/scripts/railway-test-env-state.mjs"

PROJECT="10168080-e6e5-4e65-a8ec-b92f6cf514e5"
TEST_ENV="877f4590-5eb0-4aed-b811-d7d234195169"
PROD_ENV="eb369535-cde7-445d-90f3-baeab196e88c"
SVC_WEB="fd533f19-cbed-4023-96e6-463dd299815e"
SVC_DB="c44519a3-f013-4d49-a62b-7ca3bd61c4ff"
SVC_PUSH="d528d77e-fd99-4cd2-8c58-e9c4680e7587"
DEP_WEB="a9de8c69-b7c4-4a0d-b53d-d4a94e89a5da"
DEP_DB="44f2bae4-c49b-4c8e-b4ce-992d836c63ca"
DEP_PUSH_HIST="c01d1111-2222-4333-8444-555555555555"
REMOVED_A="e88842ae-10ff-43ea-bdf7-633ee9028434"
REMOVED_B_PREFIX="de074c88"

# Toolchain dirs captured BEFORE PATH is scrubbed (the scrubbed PATH must
# still resolve node/git + POSIX tools, but must shadow `railway`).
REAL_PATH="$PATH"
NODE_DIR="$(CDPATH= cd -- "$(dirname "$(command -v node)")" && pwd)"
GITREAL_DIR="$(CDPATH= cd -- "$(dirname "$(command -v git)")" && pwd)"

PASS=0
FAIL=0

new_case() {
  CASE_DIR="$(mktemp -d)"
  STUB_BIN="$CASE_DIR/bin"
  export STUB_STATE_DIR="$CASE_DIR/state"
  mkdir -p "$STUB_BIN" "$STUB_STATE_DIR"
  export STUB_TEST_ENV="$TEST_ENV" STUB_PROJECT="$PROJECT"
  export STUB_SVC_WEB="$SVC_WEB" STUB_SVC_DB="$SVC_DB" STUB_SVC_PUSH="$SVC_PUSH"
  export TEST_REPO_ROOT="$ROOT"
  export GIT_TOPLEVEL="$ROOT"
  export STUB_RACE_ID="9ace0000-1111-4222-8333-444444444444"
  unset GIT_TOPLEVEL_OVERRIDE || true
  cat >"$STUB_BIN/railway" <<'STUB_EOF'
#!/bin/sh
# Stub railway: emulates the NEW native deployment lifecycle. See header in
# tests/railway-test-env-script.test.sh for the contract.
LOG="${STUB_STATE_DIR:?STUB_STATE_DIR unset; refusing (no live fallback)}/calls.log"
echo "railway $*" >>"$LOG"
TEST_ENV="${STUB_TEST_ENV:?STUB_TEST_ENV unset; refusing (no live fallback)}"
PROJECT="${STUB_PROJECT:?STUB_PROJECT unset; refusing (no live fallback)}"
SVC_WEB_ID="${STUB_SVC_WEB:?STUB_SVC_WEB unset; refusing (no live fallback)}"
PROD_ENV="eb369535-cde7-445d-90f3-baeab196e88c"
case " $* " in
  *" $PROD_ENV "*) echo "stub: refusing PROD-scoped call: $*" >&2; exit 1 ;;
esac
if [ "$1" = "scale" ]; then
  echo "stub: railway scale is deleted after the zero-scale failure; refusing ($*)" >&2
  exit 99
fi
if [ "$1" = "service" ] && [ "${2:-}" = "list" ]; then
  env_ok=0; proj_ok=0; prev=""
  for a in "$@"; do
    if [ "$prev" = "-e" ] && [ "$a" = "$TEST_ENV" ]; then env_ok=1; fi
    if [ "$prev" = "-p" ] && [ "$a" = "$PROJECT" ]; then proj_ok=1; fi
    prev="$a"
  done
  if [ "$env_ok" -ne 1 ] || [ "$proj_ok" -ne 1 ]; then echo "stub: service list missing TEST scope (needs -p project -e env)" >&2; exit 1; fi
  if [ -f "$STUB_STATE_DIR/fail-service-list-always" ]; then
    echo "stub: persistent service-list failure" >&2; exit 1
  fi
  if [ -f "$STUB_STATE_DIR/fail-service-list-once" ]; then
    rm -f "$STUB_STATE_DIR/fail-service-list-once"
    echo "stub: transient service-list failure" >&2; exit 1
  fi
  if [ -f "$STUB_STATE_DIR/invalid-service-list" ]; then
    echo "this is not json{{{["; exit 0
  fi
  node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const list = JSON.parse(fs.readFileSync(dir + "/servicelist.json", "utf8"));
// Deferred convergence (async-build model): defer-converge-<svcId> holds a
// remaining read count; each service-list read ticks it down, and at zero
// the fresh generation lands (running=1, stale crashed cleared — witnessed
// live 2026-10-09). Redeploy handlers skip the instant flip while armed.
for (const f of fs.readdirSync(dir).filter((x) => x.startsWith("defer-converge-"))) {
  const svc = f.slice("defer-converge-".length);
  let n = 0;
  try { n = Number(fs.readFileSync(dir + "/" + f, "utf8")) || 0; } catch {}
  if (n <= 1) {
    try { fs.unlinkSync(dir + "/" + f); } catch {}
    const e = list.find((s) => s && s.id === svc);
    if (e) {
      e.replicas = e.replicas || {};
      e.replicas.running = 1;
      e.replicas.crashed = 0;
      e.replicas.configured = Math.max(e.replicas.configured || 0, 1);
    }
  } else {
    fs.writeFileSync(dir + "/" + f, String(n - 1));
  }
}
fs.writeFileSync(dir + "/servicelist.json", JSON.stringify(list));
const missing = fs.readdirSync(dir)
  .filter((f) => f.startsWith("missing-service:"))
  .map((f) => f.slice("missing-service:".length));
process.stdout.write(JSON.stringify(list.filter((s) => s && s.id && !missing.includes(s.id))));'
  exit $?
fi
if [ "$1" = "api" ]; then
  QUERY="${2:-}"
  VARS=""; prev=""
  for a in "$@"; do
    if [ "$prev" = "--variables" ]; then VARS="$a"; fi
    prev="$a"
  done
  case "$QUERY" in
    *serviceInstanceAutoDeployStatus*)
      node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const vars = JSON.parse(process.argv[1]);
if (vars.environmentId && vars.environmentId !== process.env.STUB_TEST_ENV) {
  console.error("stub: autodeploy status wrong env scope");
  process.exit(1);
}
const st = JSON.parse(fs.readFileSync(dir + "/autodeploy.json", "utf8"));
process.stdout.write(JSON.stringify({ data: { serviceInstanceAutoDeployStatus: st } }));' "$VARS"
      exit $? ;;
    *serviceInstanceAutoDeployUpdate*)
      if ! printf "%s" "$VARS" | grep -q '"input"'; then echo "stub: autodeploy update requires nested input variables" >&2; exit 1; fi
      if ! printf "%s" "$VARS" | grep -q "$TEST_ENV"; then echo "stub: autodeploy update wrong env scope" >&2; exit 1; fi
      if [ ! -f "$STUB_STATE_DIR/fail-autodeploy" ]; then
        node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const st = JSON.parse(fs.readFileSync(dir + "/autodeploy.json", "utf8"));
st.enabled = false;
fs.writeFileSync(dir + "/autodeploy.json", JSON.stringify(st));'
      fi
      node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const st = JSON.parse(fs.readFileSync(dir + "/autodeploy.json", "utf8"));
process.stdout.write(JSON.stringify({ data: { serviceInstanceAutoDeployUpdate: st } }));'
      exit $? ;;
    *serviceInstanceRedeploy*)
      node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const vars = JSON.parse(process.argv[1]);
const svc = vars.serviceId;
const list = JSON.parse(fs.readFileSync(dir + "/servicelist.json", "utf8"));
const e = list.find((s) => s.id === svc);
if (!e) { console.error("stub: unknown service for redeploy"); process.exit(1); }
if (!fs.existsSync(dir + "/never-converge")) {
  e.replicas = e.replicas || {};
  e.replicas.running = 1;
  e.replicas.crashed = 0; // fresh/resumed generation clears the stale crashed count (witnessed live 2026-10-09)
  e.replicas.configured = Math.max(e.replicas.configured || 0, 1);
  fs.writeFileSync(dir + "/servicelist.json", JSON.stringify(list));
}
process.stdout.write(JSON.stringify({ data: { serviceInstanceRedeploy: true } }));' "$VARS"
      exit $? ;;
    *RedeployDeployment*)
      DEP_ID="$(printf '%s' "$VARS" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
      if [ -f "$STUB_STATE_DIR/fail-redeploy" ]; then
        echo "stub: deploymentRedeploy failure for $DEP_ID" >&2; exit 1
      fi
      node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const id = process.argv[1];
const deps = JSON.parse(fs.readFileSync(dir + "/deployments.json", "utf8"));
const inst = JSON.parse(fs.readFileSync(dir + "/instances.json", "utf8"));
const list = JSON.parse(fs.readFileSync(dir + "/servicelist.json", "utf8"));
let owner = null;
for (const svc of Object.keys(deps)) {
  if ((deps[svc] || []).some((n) => n && n.id === id)) owner = svc;
}
if (!owner) { console.error("stub: unknown deployment for redeploy " + id); process.exit(1); }
// Live deploymentRedeploy mints a FRESH deployment id doing fresh work
// (witnessed live 2026-10-09: redeploy of CRASHED a9de8c69 converged as
// SUCCESS 674e32c2 1/1; the old id stays a stopped history row). Same-id
// terminal+live coexistence never happens live, so the stub mints fresh.
let n = 0;
try { n = Number(fs.readFileSync(dir + "/redeploy-mutation-count", "utf8")) || 0; } catch {}
n += 1;
fs.writeFileSync(dir + "/redeploy-mutation-count", String(n));
const fresh = "rm-" + owner.slice(0, 8) + "-" + n;
const freshPending = fs.existsSync(dir + "/defer-fresh-" + owner);
const node = { id: fresh, status: freshPending ? "BUILDING" : "SUCCESS", deploymentStopped: freshPending, serviceId: owner, environmentId: process.env.STUB_TEST_ENV };
deps[owner] = deps[owner] || [];
deps[owner].unshift(node);
const p = inst[owner];
if (p) {
  const st = freshPending ? "BUILDING" : "SUCCESS";
  p.latestDeployment = { id: fresh, status: st, deploymentStopped: freshPending, canRedeploy: true };
  p.activeDeployments = p.activeDeployments || [];
  p.activeDeployments.push({ id: fresh, status: st, deploymentStopped: freshPending });
}
// Arm-on-redeploy: a defer-next-<svc> template becomes the live countdown
// when this redeploy runs, so pre-redeploy reads never consume it.
try {
  const t = fs.readFileSync(dir + "/defer-next-" + owner, "utf8");
  fs.writeFileSync(dir + "/defer-converge-" + owner, t);
  fs.unlinkSync(dir + "/defer-next-" + owner);
} catch {}
if (!fs.existsSync(dir + "/never-converge") && !fs.existsSync(dir + "/defer-converge-" + owner) && !fs.existsSync(dir + "/defer-fresh-" + owner)) {
  const e = list.find((s) => s.id === owner);
  if (e) {
    e.replicas = e.replicas || {};
    e.replicas.running = 1;
  e.replicas.crashed = 0; // fresh/resumed generation clears the stale crashed count (witnessed live 2026-10-09)
    e.replicas.configured = Math.max(e.replicas.configured || 0, 1);
  }
}
fs.writeFileSync(dir + "/deployments.json", JSON.stringify(deps));
fs.writeFileSync(dir + "/instances.json", JSON.stringify(inst));
fs.writeFileSync(dir + "/servicelist.json", JSON.stringify(list));' "$DEP_ID"
      rc=$?
      if [ "$rc" -ne 0 ]; then exit "$rc"; fi
      echo "{\"data\":{\"deploymentRedeploy\":{\"id\":\"$DEP_ID\",\"status\":\"SUCCESS\"}}}"
      exit 0 ;;
    *StopDeployment*)
      DEP_ID="$(printf '%s' "$VARS" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
      if [ -f "$STUB_STATE_DIR/fail-mutation-once" ]; then
        rm -f "$STUB_STATE_DIR/fail-mutation-once"
        echo "stub: transient deploymentStop failure for $DEP_ID" >&2; exit 1
      fi
      if [ -f "$STUB_STATE_DIR/stubborn-stop" ] || [ -f "$STUB_STATE_DIR/resist-stop-$DEP_ID" ]; then
        echo '{"data":{"deploymentStop":true}}'; exit 0
      fi
      node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const id = process.argv[1];
const deps = JSON.parse(fs.readFileSync(dir + "/deployments.json", "utf8"));
const inst = JSON.parse(fs.readFileSync(dir + "/instances.json", "utf8"));
const list = JSON.parse(fs.readFileSync(dir + "/servicelist.json", "utf8"));
let owner = null;
for (const svc of Object.keys(deps)) {
  for (const n of deps[svc] || []) {
    if (n && n.id === id) { n.deploymentStopped = true; owner = svc; }
  }
}
for (const svc of Object.keys(inst)) {
  const p = inst[svc];
  if (p && p.latestDeployment && p.latestDeployment.id === id) p.latestDeployment.deploymentStopped = true;
  for (const d of (p && p.activeDeployments) || []) {
    if (d.id === id) { d.deploymentStopped = true; owner = owner || svc; }
  }
}
if (!owner) { console.error("stub: unknown deployment for stop " + id); process.exit(1); }
const live = (deps[owner] || []).some((n) => n && n.deploymentStopped !== true);
const e = list.find((s) => s.id === owner);
if (e) {
  e.replicas = e.replicas || {};
  if (fs.existsSync(dir + "/pin-running-" + owner)) e.replicas.running = 1;
  else e.replicas.running = live ? Math.max(e.replicas.running || 0, 1) : 0;
}
fs.writeFileSync(dir + "/deployments.json", JSON.stringify(deps));
fs.writeFileSync(dir + "/instances.json", JSON.stringify(inst));
fs.writeFileSync(dir + "/servicelist.json", JSON.stringify(list));' "$DEP_ID"
      rc=$?
      if [ "$rc" -ne 0 ]; then exit "$rc"; fi
      echo '{"data":{"deploymentStop":true}}'
      exit 0 ;;
    *RemoveDeployment*)
      DEP_ID="$(printf '%s' "$VARS" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
      node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const id = process.argv[1];
const early = ["QUEUED", "INITIALIZING", "WAITING"];
const deps = JSON.parse(fs.readFileSync(dir + "/deployments.json", "utf8"));
const inst = JSON.parse(fs.readFileSync(dir + "/instances.json", "utf8"));
const list = JSON.parse(fs.readFileSync(dir + "/servicelist.json", "utf8"));
let owner = null;
let status = null;
for (const svc of Object.keys(deps)) {
  const hit = (deps[svc] || []).find((n) => n && n.id === id);
  if (hit) { owner = svc; status = String(hit.status || "").toUpperCase(); }
}
if (!owner) { console.error("stub: unknown deployment for remove " + id); process.exit(1); }
if (!early.includes(status)) {
  console.error("stub: deploymentRemove only for early-stage singles, got " + status);
  process.exit(2);
}
deps[owner] = (deps[owner] || []).filter((n) => !n || n.id !== id);
const p = inst[owner];
if (p && p.activeDeployments) p.activeDeployments = p.activeDeployments.filter((d) => d.id !== id);
const live = (deps[owner] || []).some((n) => n && n.deploymentStopped !== true);
const e = list.find((s) => s.id === owner);
if (e) {
  e.replicas = e.replicas || {};
  e.replicas.running = live ? Math.max(e.replicas.running || 0, 1) : 0;
}
fs.writeFileSync(dir + "/deployments.json", JSON.stringify(deps));
fs.writeFileSync(dir + "/instances.json", JSON.stringify(inst));
fs.writeFileSync(dir + "/servicelist.json", JSON.stringify(list));' "$DEP_ID"
      rc=$?
      if [ "$rc" -eq 2 ]; then exit 1; fi
      if [ "$rc" -ne 0 ]; then exit "$rc"; fi
      echo '{"data":{"deploymentRemove":true}}'
      exit 0 ;;
    *serviceInstance*)
      if [ -f "$STUB_STATE_DIR/fail-api-always" ]; then
        echo "stub: persistent api failure" >&2; exit 1
      fi
      if [ -f "$STUB_STATE_DIR/fail-api-once" ]; then
        rm -f "$STUB_STATE_DIR/fail-api-once"
        echo "stub: transient api failure" >&2; exit 1
      fi
      if [ -f "$STUB_STATE_DIR/invalid-api" ]; then
        echo "this is not json{{{["; exit 0
      fi
      node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const vars = JSON.parse(process.argv[1]);
if (vars.environmentId && vars.environmentId !== process.env.STUB_TEST_ENV) {
  console.error("stub: serviceInstance wrong env scope");
  process.exit(1);
}
const instances = JSON.parse(fs.readFileSync(dir + "/instances.json", "utf8"));
const missing = fs.readdirSync(dir)
  .filter((f) => f.startsWith("missing-service:"))
  .map((f) => f.slice("missing-service:".length));
const id = vars.serviceId;
if (!id || missing.includes(id) || !instances[id]) {
  process.stdout.write(JSON.stringify({ data: { serviceInstance: null } }));
} else {
process.stdout.write(JSON.stringify({ data: { serviceInstance: instances[id] } }));}' "$VARS"
      exit $? ;;
    *deployments*)
      if [ -f "$STUB_STATE_DIR/fail-api-always" ]; then
        echo "stub: persistent api failure" >&2; exit 1
      fi
      if [ -f "$STUB_STATE_DIR/fail-api-once" ]; then
        rm -f "$STUB_STATE_DIR/fail-api-once"
        echo "stub: transient api failure" >&2; exit 1
      fi
      if [ -f "$STUB_STATE_DIR/invalid-api" ]; then
        echo "this is not json{{{["; exit 0
      fi
      node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const vars = JSON.parse(process.argv[1]);
if (vars.environmentId && vars.environmentId !== process.env.STUB_TEST_ENV) {
  console.error("stub: deployments wrong env scope");
  process.exit(1);
}
const webId = process.argv[2];
if (vars.serviceId === webId && fs.existsSync(dir + "/race-swap-web")) {
  const countFile = dir + "/race-web-deploy-count";
  let count = 0;
  try { count = Number(fs.readFileSync(countFile, "utf8")) || 0; } catch {}
  count += 1;
  fs.writeFileSync(countFile, String(count));
  if (count === 3 && !fs.existsSync(dir + "/race-injected")) {
    fs.writeFileSync(dir + "/race-injected", "raced");
    const raceId = process.env.STUB_RACE_ID;
    const node = { id: raceId, status: "BUILDING", deploymentStopped: false, serviceId: webId, environmentId: vars.environmentId };
    const deps = JSON.parse(fs.readFileSync(dir + "/deployments.json", "utf8"));
    deps[webId] = deps[webId] || [];
    deps[webId].unshift(node);
    fs.writeFileSync(dir + "/deployments.json", JSON.stringify(deps));
    const inst = JSON.parse(fs.readFileSync(dir + "/instances.json", "utf8"));
    if (inst[webId]) {
      inst[webId].activeDeployments = inst[webId].activeDeployments || [];
      inst[webId].activeDeployments.push({ id: raceId, status: "BUILDING", deploymentStopped: false });
      fs.writeFileSync(dir + "/instances.json", JSON.stringify(inst));
    }
  }
}
const deps = JSON.parse(fs.readFileSync(dir + "/deployments.json", "utf8"));
const missing = fs.readdirSync(dir)
  .filter((f) => f.startsWith("missing-service:"))
  .map((f) => f.slice("missing-service:".length));
const arr = (!vars.serviceId || missing.includes(vars.serviceId)) ? [] : (deps[vars.serviceId] || []);
process.stdout.write(JSON.stringify({ data: { deployments: { edges: arr.map((n) => ({ node: n })) } } }));' "$VARS" "$SVC_WEB_ID"
      exit $? ;;
    *) echo "stub: unexpected api query: $QUERY" >&2; exit 99 ;;
  esac
fi
if [ "$1" = "redeploy" ]; then
  SVC=""; ENV=""; YES=0; FROMSRC=0; prev=""
  for a in "$@"; do
    case "$prev" in
      -s) SVC="$a" ;; -e) ENV="$a" ;; -p) PROJ="$a" ;;
    esac
    case "$a" in --yes) YES=1 ;; --from-source) FROMSRC=1 ;; esac
    prev="$a"
  done
  if [ "$YES" -ne 1 ]; then echo "stub: redeploy requires --yes (non-interactive)" >&2; exit 1; fi
  if [ "$ENV" != "$TEST_ENV" ]; then echo "stub: redeploy wrong env scope" >&2; exit 1; fi
  if [ -z "$SVC" ]; then echo "stub: redeploy missing -s service id" >&2; exit 1; fi
  node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const svc = process.argv[1];
const deps = JSON.parse(fs.readFileSync(dir + "/deployments.json", "utf8"));
const inst = JSON.parse(fs.readFileSync(dir + "/instances.json", "utf8"));
const list = JSON.parse(fs.readFileSync(dir + "/servicelist.json", "utf8"));
if (!deps[svc] && !inst[svc]) { console.error("stub: unknown service for redeploy"); process.exit(1); }
// Gradual-build model: defer-fresh-<svc> mints the fresh id as BUILDING
// non-stopped with no running flip (old generation keeps serving while the
// fresh generation builds). With never-converge also present it never lands.
const freshIsPending = fs.existsSync(dir + "/defer-fresh-" + svc);
const frozen = fs.existsSync(dir + "/never-converge") && !freshIsPending;
if (!frozen && freshIsPending) {
  // Gradual-build model: mint the fresh id as BUILDING with no running
  // flip (old generation keeps serving while the fresh id builds).
  let n = 0;
  try { n = Number(fs.readFileSync(dir + "/redeploy-count", "utf8")) || 0; } catch {}
  n += 1;
  fs.writeFileSync(dir + "/redeploy-count", String(n));
  const id = "rd-" + svc.slice(0, 8) + "-" + n;
  const node = { id, status: "BUILDING", deploymentStopped: true, serviceId: svc, environmentId: process.env.STUB_TEST_ENV };
  deps[svc] = deps[svc] || [];
  deps[svc].unshift(node);
  if (inst[svc]) {
    inst[svc].activeDeployments = inst[svc].activeDeployments || [];
    inst[svc].activeDeployments.push({ id, status: "BUILDING", deploymentStopped: true });
  }
  fs.writeFileSync(dir + "/deployments.json", JSON.stringify(deps));
  fs.writeFileSync(dir + "/instances.json", JSON.stringify(inst));
  fs.writeFileSync(dir + "/servicelist.json", JSON.stringify(list));
} else if (!frozen) {
  let n = 0;
  try { n = Number(fs.readFileSync(dir + "/redeploy-count", "utf8")) || 0; } catch {}
  n += 1;
  fs.writeFileSync(dir + "/redeploy-count", String(n));
  const id = "rd-" + svc.slice(0, 8) + "-" + n;
  const node = { id, status: "SUCCESS", deploymentStopped: false, serviceId: svc, environmentId: process.env.STUB_TEST_ENV };
  deps[svc] = deps[svc] || [];
  deps[svc].unshift(node);
  if (inst[svc]) {
    inst[svc].activeDeployments = inst[svc].activeDeployments || [];
    inst[svc].activeDeployments.push({ id, status: "SUCCESS", deploymentStopped: false });
  }
try {
  const t = fs.readFileSync(dir + "/defer-next-" + svc, "utf8");
  fs.writeFileSync(dir + "/defer-converge-" + svc, t);
  fs.unlinkSync(dir + "/defer-next-" + svc);
} catch {}
  if (!fs.existsSync(dir + "/defer-converge-" + svc)) {
  const e = list.find((s) => s.id === svc);
  if (e) {
    e.replicas = e.replicas || {};
    e.replicas.running = 1;
  e.replicas.crashed = 0; // fresh/resumed generation clears the stale crashed count (witnessed live 2026-10-09)
    e.replicas.configured = Math.max(e.replicas.configured || 0, 1);
  }
  }
  fs.writeFileSync(dir + "/deployments.json", JSON.stringify(deps));
  fs.writeFileSync(dir + "/instances.json", JSON.stringify(inst));
  fs.writeFileSync(dir + "/servicelist.json", JSON.stringify(list));
}' "$SVC"
  rc=$?
  if [ "$rc" -ne 0 ]; then exit "$rc"; fi
  echo "Redeploy started for $SVC (from-source=$FROMSRC)"
  exit 0
fi
if [ "$1" = "up" ]; then
  SVC=""; ENV=""; PROJ=""; DETACH=0; YES=0; prev=""
  for a in "$@"; do
    case "$prev" in
      --service) SVC="$a" ;; --environment) ENV="$a" ;; --project) PROJ="$a" ;;
    esac
    case "$a" in --detach) DETACH=1 ;; --yes) YES=1 ;; esac
    prev="$a"
  done
  if [ "$DETACH" -ne 1 ] || [ "$YES" -ne 1 ]; then
    echo "stub: up requires --detach --yes" >&2; exit 1
  fi
  if [ "$ENV" != "$TEST_ENV" ]; then echo "stub: up wrong env scope" >&2; exit 1; fi
  if [ -z "$SVC" ] || [ -z "$PROJ" ]; then echo "stub: up missing ids" >&2; exit 1; fi
  node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const svc = process.argv[1];
const deps = JSON.parse(fs.readFileSync(dir + "/deployments.json", "utf8"));
const inst = JSON.parse(fs.readFileSync(dir + "/instances.json", "utf8"));
const list = JSON.parse(fs.readFileSync(dir + "/servicelist.json", "utf8"));
if (!inst[svc]) { console.error("stub: unknown service for up"); process.exit(1); }
if (!fs.existsSync(dir + "/never-converge")) {
  const id = "up-" + svc.slice(0, 8) + "-1";
  const node = { id, status: "SUCCESS", deploymentStopped: false, serviceId: svc, environmentId: process.env.STUB_TEST_ENV };
  deps[svc] = deps[svc] || [];
  deps[svc].unshift(node);
  inst[svc].latestDeployment = { id, status: "SUCCESS", deploymentStopped: false, canRedeploy: true };
  inst[svc].activeDeployments = [{ id, status: "SUCCESS", deploymentStopped: false }];
try {
  const t = fs.readFileSync(dir + "/defer-next-" + svc, "utf8");
  fs.writeFileSync(dir + "/defer-converge-" + svc, t);
  fs.unlinkSync(dir + "/defer-next-" + svc);
} catch {}
  if (!fs.existsSync(dir + "/defer-converge-" + svc)) {
  const e = list.find((s) => s.id === svc);
  if (e) {
    e.replicas = e.replicas || {};
    e.replicas.running = 1;
  e.replicas.crashed = 0; // fresh/resumed generation clears the stale crashed count (witnessed live 2026-10-09)
    e.replicas.configured = Math.max(e.replicas.configured || 0, 1);
  }
  }
  fs.writeFileSync(dir + "/deployments.json", JSON.stringify(deps));
  fs.writeFileSync(dir + "/instances.json", JSON.stringify(inst));
  fs.writeFileSync(dir + "/servicelist.json", JSON.stringify(list));
}' "$SVC"
  rc=$?
  if [ "$rc" -ne 0 ]; then exit "$rc"; fi
  echo "Deploy started for $SVC"
  exit 0
fi
if [ "$1" = "ssh" ]; then
  ENV=""; prev=""
  for a in "$@"; do
    if [ "$prev" = "-e" ]; then ENV="$a"; fi
    prev="$a"
  done
  if [ "$ENV" != "$TEST_ENV" ]; then echo "stub: ssh wrong env scope" >&2; exit 1; fi
  if [ -f "$STUB_STATE_DIR/fail-ssh" ]; then
    echo "stub: pg_isready: no response" >&2; exit 1
  fi
  echo "postgres-lthj.railway.internal:5432 - accepting connections"
  exit 0
fi
echo "stub: unexpected railway invocation: $*" >&2
exit 99
STUB_EOF
  chmod +x "$STUB_BIN/railway"
  cat >"$STUB_BIN/git" <<'GIT_EOF'
#!/bin/sh
# Stub git: only the exact operations validate_clean_checkout uses.
echo "git $*" >>"${STUB_STATE_DIR:?}/calls.log"
if [ "$1" = "rev-parse" ] && [ "${2:-}" = "--show-toplevel" ]; then
  printf '%s\n' "${GIT_TOPLEVEL:-/nonexistent}"
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "${2:-}" = "--is-inside-work-tree" ]; then
  echo "true"; exit 0
fi
if [ "$1" = "status" ]; then
  if [ -f "$STUB_STATE_DIR/git-dirty" ]; then cat "$STUB_STATE_DIR/git-dirty"; fi
  exit 0
fi
if [ "$1" = "check-ignore" ]; then
  shift
  for p in "$@"; do
    case "$p" in -q) continue ;; esac
    if [ -f "$STUB_STATE_DIR/git-ignore-all" ]; then exit 0; fi
    base="$(basename "$p")"
    if [ -f "$STUB_STATE_DIR/git-ignored" ] && grep -qx "$base" "$STUB_STATE_DIR/git-ignored" 2>/dev/null; then
      exit 0
    fi
  done
  exit 1
fi
echo "stub-git: unexpected git invocation: $*" >&2
exit 1
GIT_EOF
  chmod +x "$STUB_BIN/git"
  : >"$STUB_STATE_DIR/calls.log"
  # Scrubbed PATH: stub first, then only the toolchain dirs + POSIX tools.
  # The real `railway` MUST resolve to the stub (asserted below in checks).
  export PATH="$STUB_BIN:$NODE_DIR:$GITREAL_DIR:/usr/bin:/bin"
}

end_case() {
  export PATH="$REAL_PATH"
  rm -rf "$CASE_DIR"
}

# Parked live-mirror baseline: web CRASHED+stopped 0/1 (region moved to
# us-west2 by the zero-scale attempt), DB SUCCESS+stopped 0/1, push latest
# null + empty active + null replicas + retained startCommand, autodeploy on.
fixtures_parked() {
  cat >"$STUB_STATE_DIR/instances.json" <<JSON
{"$SVC_WEB":{"serviceName":"web-test","region":"us-west2","numReplicas":null,"source":{"image":null,"repo":"example/web-repo"},"startCommand":"npm start","latestDeployment":{"id":"$DEP_WEB","status":"CRASHED","deploymentStopped":true,"canRedeploy":true},"activeDeployments":[{"id":"$DEP_WEB","status":"CRASHED","deploymentStopped":true}]},"$SVC_DB":{"serviceName":"Postgres-ltHj","region":"sfo","numReplicas":1,"source":{"image":"ghcr.io/railwayapp-templates/postgres-ssl:18","repo":null},"startCommand":null,"latestDeployment":{"id":"$DEP_DB","status":"SUCCESS","deploymentStopped":true,"canRedeploy":true},"activeDeployments":[{"id":"$DEP_DB","status":"SUCCESS","deploymentStopped":true}]},"$SVC_PUSH":{"serviceName":"push-delivery","region":"europe-west4-drams3a","numReplicas":null,"source":null,"startCommand":"npm run push:worker","latestDeployment":null,"activeDeployments":[]}}
JSON
  cat >"$STUB_STATE_DIR/deployments.json" <<JSON
{"$SVC_WEB":[{"id":"$DEP_WEB","status":"CRASHED","deploymentStopped":true,"serviceId":"$SVC_WEB","environmentId":"$TEST_ENV"}],"$SVC_DB":[{"id":"$DEP_DB","status":"SUCCESS","deploymentStopped":true,"serviceId":"$SVC_DB","environmentId":"$TEST_ENV"}],"$SVC_PUSH":[]}
JSON
  cat >"$STUB_STATE_DIR/servicelist.json" <<JSON
[{"id":"$SVC_WEB","replicas":{"configured":1,"running":0,"crashed":0}},{"id":"$SVC_DB","replicas":{"configured":1,"running":0,"crashed":0}},{"id":"$SVC_PUSH"}]
JSON
  printf '{"enabled":true,"canEnable":true}' >"$STUB_STATE_DIR/autodeploy.json"
}

# Mark one service resumed: latest+active+nodes non-stopped, running=1.
unpark_svc() {
  node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const id = process.argv[1];
const inst = JSON.parse(fs.readFileSync(dir + "/instances.json", "utf8"));
const deps = JSON.parse(fs.readFileSync(dir + "/deployments.json", "utf8"));
const list = JSON.parse(fs.readFileSync(dir + "/servicelist.json", "utf8"));
const p = inst[id];
if (p.latestDeployment) p.latestDeployment.deploymentStopped = false;
(p.activeDeployments || []).forEach((d) => { d.deploymentStopped = false; });
(deps[id] || []).forEach((d) => { d.deploymentStopped = false; });
const e = list.find((s) => s.id === id);
if (e) {
  e.replicas = e.replicas || {};
  e.replicas.running = 1;
  e.replicas.crashed = 0; // fresh/resumed generation clears the stale crashed count (witnessed live 2026-10-09)
  e.replicas.configured = Math.max(e.replicas.configured || 0, 1);
}
fs.writeFileSync(dir + "/instances.json", JSON.stringify(inst));
fs.writeFileSync(dir + "/deployments.json", JSON.stringify(deps));
fs.writeFileSync(dir + "/servicelist.json", JSON.stringify(list));' "$1"
}

# Set the single live deployment status for one service (active+nodes+latest).
set_live_status() {
  node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const id = process.argv[1];
const status = process.argv[2];
const inst = JSON.parse(fs.readFileSync(dir + "/instances.json", "utf8"));
const deps = JSON.parse(fs.readFileSync(dir + "/deployments.json", "utf8"));
const p = inst[id];
if (p.latestDeployment) { p.latestDeployment.status = status; p.latestDeployment.deploymentStopped = false; }
(p.activeDeployments || []).forEach((d) => { d.status = status; d.deploymentStopped = false; });
(deps[id] || []).forEach((d) => { d.status = status; d.deploymentStopped = false; });
fs.writeFileSync(dir + "/instances.json", JSON.stringify(inst));
fs.writeFileSync(dir + "/deployments.json", JSON.stringify(deps));' "$1" "$2"
}

# Set the crashed replica count for one service (stale-crash shapes).
set_crashed() {
  node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const list = JSON.parse(fs.readFileSync(dir + "/servicelist.json", "utf8"));
const e = list.find((s) => s.id === process.argv[1]);
e.replicas = e.replicas || {};
e.replicas.crashed = Number(process.argv[2]) || 0;
fs.writeFileSync(dir + "/servicelist.json", JSON.stringify(list));' "$1" "$2"
}
# Append an extra active non-stopped deployment to one service.
add_active() {
  node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const svc = process.argv[1];
const id = process.argv[2];
const status = process.argv[3];
const deps = JSON.parse(fs.readFileSync(dir + "/deployments.json", "utf8"));
const inst = JSON.parse(fs.readFileSync(dir + "/instances.json", "utf8"));
deps[svc] = deps[svc] || [];
deps[svc].push({ id, status, deploymentStopped: false, serviceId: svc, environmentId: process.env.STUB_TEST_ENV });
if (inst[svc]) {
  inst[svc].activeDeployments = inst[svc].activeDeployments || [];
  inst[svc].activeDeployments.push({ id, status, deploymentStopped: false });
}
fs.writeFileSync(dir + "/deployments.json", JSON.stringify(deps));
fs.writeFileSync(dir + "/instances.json", JSON.stringify(inst));' "$1" "$2" "$3"
}

# Give push a redeployable historical (stopped) deployment.
set_push_history() {
  node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const svc = process.argv[1];
const id = process.argv[2];
const deps = JSON.parse(fs.readFileSync(dir + "/deployments.json", "utf8"));
const inst = JSON.parse(fs.readFileSync(dir + "/instances.json", "utf8"));
const list = JSON.parse(fs.readFileSync(dir + "/servicelist.json", "utf8"));
deps[svc] = [{ id, status: "SUCCESS", deploymentStopped: true, serviceId: svc, environmentId: process.env.STUB_TEST_ENV }];
inst[svc].latestDeployment = { id, status: "SUCCESS", deploymentStopped: true, canRedeploy: true };
inst[svc].activeDeployments = [{ id, status: "SUCCESS", deploymentStopped: true }];
// Strict counts (fail-closed): a stopped history is provably parked only
// with explicit zero counts; replicas must never default.
const e = list.find((s) => s && s.id === svc);
if (e) e.replicas = { configured: 1, running: 0, crashed: 0 };
fs.writeFileSync(dir + "/deployments.json", JSON.stringify(deps));
fs.writeFileSync(dir + "/instances.json", JSON.stringify(inst));
fs.writeFileSync(dir + "/servicelist.json", JSON.stringify(list));' "$SVC_PUSH" "$DEP_PUSH_HIST"
}

# Web with no deployable deployment at all (forces --from-source path).
set_web_sourceless() {
  node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const svc = process.argv[1];
const deps = JSON.parse(fs.readFileSync(dir + "/deployments.json", "utf8"));
const inst = JSON.parse(fs.readFileSync(dir + "/instances.json", "utf8"));
deps[svc] = [];
inst[svc].latestDeployment = null;
inst[svc].activeDeployments = [];
fs.writeFileSync(dir + "/deployments.json", JSON.stringify(deps));
fs.writeFileSync(dir + "/instances.json", JSON.stringify(inst));' "$SVC_WEB"
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

log_order() {
  # $1 = first pattern, $2 = second pattern: first match of $1 precedes it.
  # Operation names only (never bare field names that match read selections).
  a="$(grep -n -m1 "$1" "$STUB_STATE_DIR/calls.log" | cut -d: -f1)"
  b="$(grep -n -m1 "$2" "$STUB_STATE_DIR/calls.log" | cut -d: -f1)"
  [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]
}

mut_logged() {
  # $1 = deployment id: its id appears in mutation variables in calls.log.
  # Scoped reads only log service ids, so a deployment id proves a mutation.
  grep -Fq "\"id\":\"$1\"" "$STUB_STATE_DIR/calls.log"
}

stop_logged() {
  # $1 = deployment id stopped via the StopDeployment operation.
  grep -F 'StopDeployment' "$STUB_STATE_DIR/calls.log" | grep -Fq "\"id\":\"$1\""
}

remove_logged() {
  # $1 = deployment id removed via the RemoveDeployment operation.
  grep -F 'RemoveDeployment' "$STUB_STATE_DIR/calls.log" | grep -Fq "\"id\":\"$1\""
}

redeploy_logged() {
  # $1 = deployment id redeployed via the RedeployDeployment operation.
  grep -F 'RedeployDeployment' "$STUB_STATE_DIR/calls.log" | grep -Fq "\"id\":\"$1\""
}

mut_order() {
  # $1 = first deployment id, $2 = second: first mutation precedes second.
  a="$(grep -n -F "\"id\":\"$1\"" "$STUB_STATE_DIR/calls.log" | cut -d: -f1 | head -1)"
  b="$(grep -n -F "\"id\":\"$2\"" "$STUB_STATE_DIR/calls.log" | cut -d: -f1 | head -1)"
  [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]
}

no_scale_calls() {
  ! grep -q "^railway scale " "$STUB_STATE_DIR/calls.log"
}

no_mutations() {
  # No mutation operation or CLI write path issued (reads only).
  ! grep -Eq 'StopDeployment|RemoveDeployment|RedeployDeployment|AutoDeployUpdate|serviceInstanceRedeploy' "$STUB_STATE_DIR/calls.log" \
    && ! grep -Eq '^railway (redeploy|up) ' "$STUB_STATE_DIR/calls.log"
}

# --- PATH / stub-integrity guards (every case benefits; asserted explicitly)
new_case
fixtures_parked
check "stub shadows PATH (no live railway reachable)" "[ '$(command -v railway)' = '$STUB_BIN/railway' ]"
check "PATH is scrubbed (stub bin leads)" "case '$PATH' in '$STUB_BIN:'*) true ;; *) false ;; esac"
check "scale fails loudly on the stub (zero-scale regression guard)" "railway scale --service $SVC_WEB -e $TEST_ENV us-west2=0 >/dev/null 2>&1; [ \$? -eq 99 ]"
check "stub refuses unset STUB_STATE_DIR (no live fallback)" "env -u STUB_STATE_DIR railway api 'x' >/dev/null 2>&1; [ \$? -ne 0 ]"
check "script has zero scale references" "! grep -qw 'scale' '$SCRIPT'"
end_case

# --- status: parked baseline is read-only ------------------------------------
new_case
fixtures_parked
run_script status
check "status: parked baseline exits 0" "[ $RC -eq 0 ]"
check "status: all three services report parked=true" "grep -q 'parked=true' '$CASE_DIR/out.txt'"
check "status: web shows stopped CRASHED latest" "grep -q '$DEP_WEB CRASHED' '$CASE_DIR/out.txt'"
check "status: autodeploy probe reported" "grep -q 'web-test autodeploy:' '$CASE_DIR/out.txt'"
check "status: no mutations issued" "no_mutations"
check "status: REMOVED history ids never resurface" "! grep -q '$REMOVED_A' '$CASE_DIR/out.txt' && ! grep -q '$REMOVED_B_PREFIX' '$CASE_DIR/out.txt' && ! grep -q '$REMOVED_A' '$STUB_STATE_DIR/calls.log'"
check "status: no scale calls" "no_scale_calls"
end_case

# --- status: active web is reported, still read-only --------------------------
new_case
fixtures_parked
unpark_svc "$SVC_WEB"
run_script status
check "status/active: exits 0" "[ $RC -eq 0 ]"
check "status/active: web reports parked=false running=1" "grep -q 'parked=false' '$CASE_DIR/out.txt'"
check "status/active: still no mutations" "no_mutations"
end_case

# --- stop: idempotent on already-parked ---------------------------------------
new_case
fixtures_parked
run_script stop --timeout 10
check "stop-idem: exits 0" "[ $RC -eq 0 ]"
check "stop-idem: reports already parked" "grep -q 'already parked' '$CASE_DIR/out.txt'"
check "stop-idem: autodeploy verified off" "grep -q 'autodeploy verified enabled=false' '$CASE_DIR/out.txt'"
check "stop-idem: no StopDeployment issued" "! grep -q 'StopDeployment' '$STUB_STATE_DIR/calls.log'"
check "stop-idem: REMOVED ids untouched" "! grep -q '$REMOVED_A\\|$REMOVED_B_PREFIX' '$STUB_STATE_DIR/calls.log'"
check "stop-idem: no scale calls" "no_scale_calls"
end_case

# --- stop: multi active+pending drains dependents before DB -------------------
new_case
fixtures_parked
set_live_status "$SVC_WEB" SUCCESS
unpark_svc "$SVC_WEB"
add_active "$SVC_WEB" "b111d000-1111-4222-8333-444444444444" BUILDING
unpark_svc "$SVC_PUSH"
set_push_history
node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const inst = JSON.parse(fs.readFileSync(dir + "/instances.json", "utf8"));
const deps = JSON.parse(fs.readFileSync(dir + "/deployments.json", "utf8"));
const list = JSON.parse(fs.readFileSync(dir + "/servicelist.json", "utf8"));
const svc = process.argv[1];
const id = "d9ac7000-1111-4222-8333-444444444444";
deps[svc] = [{ id, status: "SUCCESS", deploymentStopped: false, serviceId: svc, environmentId: process.env.STUB_TEST_ENV }];
inst[svc].latestDeployment = { id, status: "SUCCESS", deploymentStopped: false, canRedeploy: true };
inst[svc].activeDeployments = [{ id, status: "SUCCESS", deploymentStopped: false }];
const e = list.find((s) => s.id === svc);
e.replicas = { configured: 1, running: 1, crashed: 0 };
fs.writeFileSync(dir + "/deployments.json", JSON.stringify(deps));
fs.writeFileSync(dir + "/instances.json", JSON.stringify(inst));
fs.writeFileSync(dir + "/servicelist.json", JSON.stringify(list));' "$SVC_PUSH"
unpark_svc "$SVC_DB"
run_script stop --timeout 30
check "stop-multi: exits 0" "[ $RC -eq 0 ]"
check "stop-multi: autodeploy disabled+verified BEFORE any StopDeployment" "log_order 'AutoDeployUpdate' 'StopDeployment'"
check "stop-multi: autodeploy update uses nested input scope" "grep -q 'AutoDeployUpdate' '$STUB_STATE_DIR/calls.log' && grep -q '\"input\"' '$STUB_STATE_DIR/calls.log' && grep -q '\"enabled\":false' '$STUB_STATE_DIR/calls.log'"
check "stop-multi: both web deployments stopped (terminal + pending)" "stop_logged '$DEP_WEB' && stop_logged 'b111d000-1111-4222-8333-444444444444'"
check "stop-multi: web stops before push stops before DB stops" "mut_order '$DEP_WEB' 'd9ac7000-1111-4222-8333-444444444444' && mut_order 'd9ac7000-1111-4222-8333-444444444444' '$DEP_DB'"
check "stop-multi: BUILDING pending stopped, never removed" "stop_logged 'b111d000-1111-4222-8333-444444444444' && ! remove_logged 'b111d000-1111-4222-8333-444444444444'"
check "stop-multi: reports stopped with data retained" "grep -q 'test environment stopped' '$CASE_DIR/out.txt'"
check "stop-multi: no scale calls" "no_scale_calls"
end_case

# --- stop: stubborn QUEUED single is stopped first, then removed ---------------
new_case
fixtures_parked
unpark_svc "$SVC_WEB"
set_live_status "$SVC_WEB" QUEUED
touch "$STUB_STATE_DIR/resist-stop-$DEP_WEB"
run_script stop --timeout 30
check "stop-remove: exits 0" "[ $RC -eq 0 ]"
check "stop-remove: stop attempted before remove" "log_order 'StopDeployment' 'RemoveDeployment' && stop_logged '$DEP_WEB' && remove_logged '$DEP_WEB'"
check "stop-remove: web parked after removal" "grep -q 'push-delivery parked\\|test environment stopped' '$CASE_DIR/out.txt'"
check "stop-remove: no scale calls" "no_scale_calls"
end_case

# --- stop: race swap mid-drain recomputes and stops the newcomer ---------------
# Web AND DB resumed: the DB must stop after the raced newcomer drains, so
# the DB starts unparked here (a parked DB is never re-stopped; see the
# stuck/unknown cases that assert the DB stays untouched).
new_case
fixtures_parked
set_live_status "$SVC_WEB" SUCCESS
unpark_svc "$SVC_WEB"
unpark_svc "$SVC_DB"
touch "$STUB_STATE_DIR/race-swap-web"
run_script stop --timeout 30
check "stop-race: exits 0" "[ $RC -eq 0 ]"
check "stop-race: original deployment stopped" "stop_logged '$DEP_WEB'"
check "stop-race: raced BUILDING deployment also stopped" "stop_logged '$STUB_RACE_ID'"
check "stop-race: environment reports stopped" "grep -q 'test environment stopped' '$CASE_DIR/out.txt'"
check "stop-race: raced newcomer stopped, then DB stopped after dependents" "stop_logged '$STUB_RACE_ID' && mut_order '$STUB_RACE_ID' '$DEP_DB'"
end_case

# --- stop: stuck dependents keep the DB up ------------------------------------
new_case
fixtures_parked
unpark_svc "$SVC_WEB"
touch "$STUB_STATE_DIR/pin-running-$SVC_WEB"
run_script stop --timeout 15
check "stop-stuck: exits nonzero" "[ $RC -ne 0 ]"
check "stop-stuck: operator told the DB was left up" "grep -q 'leaving Postgres-ltHj UP' '$CASE_DIR/err.txt'"
check "stop-stuck: DB deployment never stopped/removed" "! mut_logged '$DEP_DB'"
check "stop-stuck: DB never redeployed" "! grep -q '^railway redeploy .*-s $SVC_DB' '$STUB_STATE_DIR/calls.log'"
end_case

# --- stop: unknown status refuses with DB up ----------------------------------
new_case
fixtures_parked
unpark_svc "$SVC_WEB"
set_live_status "$SVC_WEB" FROBNICATED
run_script stop --timeout 15
check "stop-unknown: exits nonzero" "[ $RC -ne 0 ]"
check "stop-unknown: refusal names unknown status" "grep -qi 'unknown' '$CASE_DIR/err.txt'"
check "stop-unknown: DB deployment untouched" "! mut_logged '$DEP_DB'"
check "stop-unknown: DB left up" "grep -q 'leaving Postgres-ltHj UP' '$CASE_DIR/err.txt'"
end_case

# --- stop: persistent read errors keep the DB up -------------------------------
new_case
fixtures_parked
unpark_svc "$SVC_WEB"
touch "$STUB_STATE_DIR/fail-api-always"
run_script stop --timeout 12
check "stop-readfail: exits nonzero" "[ $RC -ne 0 ]"
check "stop-readfail: no StopDeployment issued blind" "! grep -q 'StopDeployment' '$STUB_STATE_DIR/calls.log'"
check "stop-readfail: DB up message" "grep -q 'leaving Postgres-ltHj UP' '$CASE_DIR/err.txt'"
end_case

# --- stop: transient mutation failure mid-drain keeps the DB up ----------------
new_case
fixtures_parked
unpark_svc "$SVC_WEB"
touch "$STUB_STATE_DIR/fail-mutation-once"
run_script stop --timeout 15
check "stop-midfail: exits nonzero" "[ $RC -ne 0 ]"
check "stop-midfail: failure surfaces deploymentStop" "grep -q 'deploymentStop failed' '$CASE_DIR/err.txt'"
check "stop-midfail: DB left up" "grep -q 'leaving Postgres-ltHj UP' '$CASE_DIR/err.txt'"
check "stop-midfail: DB deployment untouched" "! mut_logged '$DEP_DB'"
end_case

# --- stop: invalid API payload refuses closed ----------------------------------
new_case
fixtures_parked
unpark_svc "$SVC_WEB"
touch "$STUB_STATE_DIR/invalid-api"
run_script stop --timeout 12
check "stop-invalid: exits nonzero" "[ $RC -ne 0 ]"
check "stop-invalid: no StopDeployment on garbage reads" "! grep -q 'StopDeployment' '$STUB_STATE_DIR/calls.log'"
end_case

# --- stop: missing service refuses with DB up ----------------------------------
new_case
fixtures_parked
unpark_svc "$SVC_WEB"
touch "$STUB_STATE_DIR/missing-service:$SVC_DB"
run_script stop --timeout 15
check "stop-missing: exits nonzero" "[ $RC -ne 0 ]"
check "stop-missing: missing service named" "grep -qi 'not found' '$CASE_DIR/err.txt'"
check "stop-missing: dependents drained message or DB left safe" "grep -q 'leaving Postgres-ltHj UP\\|stop unconfirmed' '$CASE_DIR/err.txt'"
check "stop-missing: terminal refusal returns promptly (no 6-round retry grind)" '[ "$(grep -c '"'"'SnapshotDeployments'"'"' "$STUB_STATE_DIR/calls.log")" -le 12 ]'
end_case

# --- stop: autodeploy stuck on refuses before any stop -------------------------
new_case
fixtures_parked
unpark_svc "$SVC_WEB"
touch "$STUB_STATE_DIR/fail-autodeploy"
run_script stop --timeout 10
check "stop-autodeploy: exits nonzero" "[ $RC -ne 0 ]"
check "stop-autodeploy: still-enabled refusal" "grep -q 'still enabled' '$CASE_DIR/err.txt'"
check "stop-autodeploy: no StopDeployment before autodeploy off" "! grep -q 'StopDeployment' '$STUB_STATE_DIR/calls.log'"
end_case

# --- guard: PROD refused before any mutation (shared push id included) ---------
new_case
fixtures_parked
run_script stop --env "$PROD_ENV" --timeout 5
check "guard-prod: stop --env PROD exits nonzero" "[ $RC -ne 0 ]"
check "guard-prod: refusal names PRODUCTION" "grep -q 'PRODUCTION' '$CASE_DIR/err.txt'"
check "guard-prod: zero stub calls (no mutation attempted)" "[ ! -s '$STUB_STATE_DIR/calls.log' ]"
run_script start --env "$PROD_ENV" --timeout 5
check "guard-prod: start --env PROD exits nonzero" "[ $RC -ne 0 ]"
run_script status --env "$PROD_ENV"
check "guard-prod: status --env PROD exits nonzero" "[ $RC -ne 0 ]"
end_case

# --- guard: autodeploy scope (helper refuses wrong env; stub enforces too) -----
new_case
fixtures_parked
set +e
node "$STATE_HELPER" --env "$PROD_ENV" --autodeploy "$SVC_WEB" >"$CASE_DIR/helper-out.txt" 2>"$CASE_DIR/helper-err.txt"
HRC=$?
set -e
check "guard-auto: helper --env PROD refused (exit 3)" "[ $HRC -eq 3 ]"
check "guard-auto: helper refusal says REFUSING" "grep -q 'REFUSING' '$CASE_DIR/helper-err.txt'"
check "guard-auto: stub rejects wrong-env autodeploy update" "railway api 'mutation X { serviceInstanceAutoDeployUpdate(input: \$i) { enabled } }' --variables '{\"input\":{\"projectId\":\"$PROJECT\",\"environmentId\":\"$PROD_ENV\",\"serviceId\":\"$SVC_WEB\",\"enabled\":false}}' >/dev/null 2>&1; [ \$? -ne 0 ]"
check "guard-auto: flat (non-nested) autodeploy variables rejected" "railway api 'mutation X { serviceInstanceAutoDeployUpdate(input: \$i) { enabled } }' --variables '{\"projectId\":\"$PROJECT\",\"environmentId\":\"$TEST_ENV\",\"serviceId\":\"$SVC_WEB\",\"enabled\":false}' >/dev/null 2>&1; [ \$? -ne 0 ]"
end_case

# --- start: idempotent when already running+healthy -----------------------------
new_case
fixtures_parked
set_push_history
set_live_status "$SVC_WEB" SUCCESS
unpark_svc "$SVC_WEB"
unpark_svc "$SVC_DB"
unpark_svc "$SVC_PUSH"
run_script start --timeout 10
check "start-idem: exits 0" "[ $RC -eq 0 ]"
check "start-idem: reports already running+healthy" "grep -q 'already running+healthy' '$CASE_DIR/out.txt'"
check "start-idem: no redeploy/up issued" "! grep -Eq '^railway (redeploy|up) ' '$STUB_STATE_DIR/calls.log' && ! grep -q 'RedeployDeployment' '$STUB_STATE_DIR/calls.log'"
check "start-idem: autodeploy still verified off" "grep -q 'autodeploy verified enabled=false' '$CASE_DIR/out.txt'"
end_case

# --- start: stale stopped/SUCCESS is never readiness -----------------------------
new_case
fixtures_parked
touch "$STUB_STATE_DIR/never-converge"
run_script start --timeout 4
check "start-stale: exits nonzero" "[ $RC -ne 0 ]"
check "start-stale: never claims started" "! grep -q 'test environment started' '$CASE_DIR/out.txt'"
check "start-stale: DB redeploy requested first" "grep -q '^railway redeploy .*-s $SVC_DB' '$STUB_STATE_DIR/calls.log'"
check "start-stale: dependents never started on unproven DB" "! grep -q 'RedeployDeployment' '$STUB_STATE_DIR/calls.log' && ! grep -q '^railway redeploy .*-s $SVC_WEB' '$STUB_STATE_DIR/calls.log'"
end_case

# --- start: stale crashed count converges when a redeploy is in flight --------
# Live shape 2026-10-09: web parked CRASHED+stopped with crashed=1; the fresh
# redeploy builds (running 0, crashed still 1) then lands (running 1,
# crashed 0). Refusing on the stale count aborts a healthy start; refusing
# only with nothing in flight keeps the start-crash guard intact.
new_case
fixtures_parked
set_push_history
set_crashed "$SVC_WEB" 1
printf '2' >"$STUB_STATE_DIR/defer-next-$SVC_WEB"
run_script start --timeout 30
check "start-stalecrash: exits 0" "[ $RC -eq 0 ]"
check "start-stalecrash: stale crash tolerated while converging" "grep -q 'waiting' '$CASE_DIR/err.txt'"
check "start-stalecrash: reports started" "grep -q 'test environment started' '$CASE_DIR/out.txt'"
check "start-stalecrash: no scale calls" "no_scale_calls"
end_case
new_case
fixtures_parked
set_push_history
run_script start --timeout 30
check "start-happy: exits 0" "[ $RC -eq 0 ]"
check "start-happy: DB redeploy precedes web redeploy" "log_order '^railway redeploy .*-s $SVC_DB' 'RedeployDeployment'"
check "start-happy: DB probe precedes dependent starts" "log_order 'pg_isready' 'RedeployDeployment'"
check "start-happy: web redeployed before push redeployed" "redeploy_logged '$DEP_WEB' && redeploy_logged '$DEP_PUSH_HIST' && mut_order '$DEP_WEB' '$DEP_PUSH_HIST'"
check "start-happy: fresh web id captured and verified" "grep -q 'web-test redeploy requested (newest scoped deployment rm-' '$CASE_DIR/out.txt' && grep -q 'web-test running (running=1 configured=1 expected=rm-' '$CASE_DIR/out.txt'"
check "start-happy: fresh push id captured and verified" "grep -q 'push-delivery redeploy requested (newest scoped deployment rm-' '$CASE_DIR/out.txt' && grep -q 'push-delivery running (running=1 configured=1 expected=rm-' '$CASE_DIR/out.txt'"
check "start-happy: fresh DB id captured and verified" "grep -q 'Postgres-ltHj redeploy requested (newest scoped deployment rd-' '$CASE_DIR/out.txt' && grep -q 'Postgres-ltHj running (running=1 configured=1 expected=rd-' '$CASE_DIR/out.txt'"
check "start-happy: redeploy is non-interactive (--yes)" "grep -q '^railway redeploy .*--yes' '$STUB_STATE_DIR/calls.log'"
check "start-happy: reports started with autodeploy off" "grep -q 'test environment started' '$CASE_DIR/out.txt' && grep -q 'autodeploy stays off' '$CASE_DIR/out.txt'"
check "start-happy: push startCommand preserved, no config writes" "grep -q 'npm run push:worker' '$STUB_STATE_DIR/instances.json' && ! grep -Eq 'variable set|config patch|service update' '$STUB_STATE_DIR/calls.log'"
check "start-happy: no scale calls" "no_scale_calls"
end_case

# --- start: web without any deployment uses --from-source ---------------------------
new_case
fixtures_parked
set_web_sourceless
set_push_history
run_script start --timeout 30
check "start-source: exits 0" "[ $RC -eq 0 ]"
check "start-source: web redeploy --from-source --yes issued" "grep -q 'from-source' '$STUB_STATE_DIR/calls.log'"
check "start-source: reports started" "grep -q 'test environment started' '$CASE_DIR/out.txt'"
end_case

# --- start: push without deployment uploads from a clean checkout --------------------
new_case
fixtures_parked
set_push_history
node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const deps = JSON.parse(fs.readFileSync(dir + "/deployments.json", "utf8"));
const inst = JSON.parse(fs.readFileSync(dir + "/instances.json", "utf8"));
deps[process.argv[1]] = [];
inst[process.argv[1]].latestDeployment = null;
inst[process.argv[1]].activeDeployments = [];
fs.writeFileSync(dir + "/deployments.json", JSON.stringify(deps));
fs.writeFileSync(dir + "/instances.json", JSON.stringify(inst));' "$SVC_PUSH"
touch "$STUB_STATE_DIR/git-ignore-all"
run_script start --timeout 30
check "start-up: exits 0" "[ $RC -eq 0 ]"
check "start-up: railway up issued with ids + --detach --yes" "grep -q '^railway up .*--service $SVC_PUSH.*--environment $TEST_ENV.*--project $PROJECT.*--detach.*--yes' '$STUB_STATE_DIR/calls.log'"
check "start-up: reports started" "grep -q 'test environment started' '$CASE_DIR/out.txt'"
end_case

# --- start: push upload refused on dirty checkout --------------------------------------
new_case
fixtures_parked
node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const deps = JSON.parse(fs.readFileSync(dir + "/deployments.json", "utf8"));
const inst = JSON.parse(fs.readFileSync(dir + "/instances.json", "utf8"));
deps[process.argv[1]] = [];
inst[process.argv[1]].latestDeployment = null;
inst[process.argv[1]].activeDeployments = [];
fs.writeFileSync(dir + "/deployments.json", JSON.stringify(deps));
fs.writeFileSync(dir + "/instances.json", JSON.stringify(inst));' "$SVC_PUSH"
printf ' M dirty-probe-file\n' >"$STUB_STATE_DIR/git-dirty"
run_script start --timeout 30
check "start-dirty: exits nonzero" "[ $RC -ne 0 ]"
check "start-dirty: dirty checkout named" "grep -q 'worktree is dirty' '$CASE_DIR/err.txt'"
check "start-dirty: no upload attempted" "! grep -q '^railway up ' '$STUB_STATE_DIR/calls.log'"
end_case

# --- start: push upload refused when secrets would be in scope ---------------------------
new_case
fixtures_parked
node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const deps = JSON.parse(fs.readFileSync(dir + "/deployments.json", "utf8"));
const inst = JSON.parse(fs.readFileSync(dir + "/instances.json", "utf8"));
deps[process.argv[1]] = [];
inst[process.argv[1]].latestDeployment = null;
inst[process.argv[1]].activeDeployments = [];
fs.writeFileSync(dir + "/deployments.json", JSON.stringify(deps));
fs.writeFileSync(dir + "/instances.json", JSON.stringify(inst));' "$SVC_PUSH"
mkdir -p "$CASE_DIR/fakeroot"
touch "$CASE_DIR/fakeroot/.env"
export GIT_TOPLEVEL="$CASE_DIR/fakeroot"
run_script start --timeout 30
check "start-secrets: exits nonzero" "[ $RC -ne 0 ]"
check "start-secrets: unignored .env named" "grep -q 'unignored .env' '$CASE_DIR/err.txt'"
check "start-secrets: no upload attempted" "! grep -q '^railway up ' '$STUB_STATE_DIR/calls.log'"
end_case

# --- start: failed DB probe aborts before dependents --------------------------------------
new_case
fixtures_parked
set_push_history
touch "$STUB_STATE_DIR/fail-ssh"
run_script start --timeout 8
check "start-probe: exits nonzero" "[ $RC -ne 0 ]"
check "start-probe: dependents never started on unproven DB" "! grep -q 'RedeployDeployment' '$STUB_STATE_DIR/calls.log' && ! grep -q '^railway up ' '$STUB_STATE_DIR/calls.log'"
check "start-probe: never claims started" "! grep -q 'test environment started' '$CASE_DIR/out.txt'"
end_case

# --- start: crashed DB replicas refuse ----------------------------------------------------
# Persistent crash: the redeploy cannot heal it (never-converge), so the DB
# never runs with nothing in flight and the crash refusal (not a silent
# timeout) names the crash while dependents stay untouched. The healable
# stale-crash shape is covered by start-stalecrash.
new_case
fixtures_parked
set_push_history
touch "$STUB_STATE_DIR/defer-fresh-$SVC_DB"
node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const list = JSON.parse(fs.readFileSync(dir + "/servicelist.json", "utf8"));
const e = list.find((s) => s.id === process.argv[1]);
e.replicas = { configured: 1, running: 1, crashed: 1 };
fs.writeFileSync(dir + "/servicelist.json", JSON.stringify(list));' "$SVC_DB"
run_script start --timeout 8
check "start-crash: exits nonzero" "[ $RC -ne 0 ]"
check "start-crash: crash named, dependents untouched" "grep -q 'crashed' '$CASE_DIR/err.txt' && ! grep -q 'RedeployDeployment' '$STUB_STATE_DIR/calls.log'"
end_case

# --- start: old healthy running while the fresh deployment is still pending waits, never blesses ----
# Blocker 2: the initiated deployment id (not running>0) is readiness. The
# old generation still reports running=1 while the fresh redeploy id is
# BUILDING non-stopped (defer-fresh gradual-build model): start must wait for
# THAT id, never bless the old generation's running count, and time out
# nonzero with dependents untouched.
new_case
fixtures_parked
set_push_history
touch "$STUB_STATE_DIR/defer-fresh-$SVC_DB"
touch "$STUB_STATE_DIR/never-converge"
node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const list = JSON.parse(fs.readFileSync(dir + "/servicelist.json", "utf8"));
const e = list.find((x) => x && x.id === process.argv[1]);
e.replicas = { configured: 1, running: 1, crashed: 0 };
fs.writeFileSync(dir + "/servicelist.json", JSON.stringify(list));' "$SVC_DB"
run_script start --timeout 8
check "start-oldhealthy: exits nonzero (fresh id never converges)" "[ $RC -ne 0 ]"
check "start-oldhealthy: waits on the fresh id, never blesses old running" "grep -q 'still BUILDING.*waiting' '$CASE_DIR/err.txt'"
check "start-oldhealthy: never claims started on old running" "! grep -q 'test environment started' '$CASE_DIR/out.txt'"
check "start-oldhealthy: dependents never started on unproven DB" "! grep -q 'RedeployDeployment' '$STUB_STATE_DIR/calls.log' && ! grep -q '^railway redeploy .*-s $SVC_WEB' '$STUB_STATE_DIR/calls.log'"
end_case

# --- start: partial replica counts refuse ------------------------------------------------------
# Blocker 2: configured=2 but running=1 for the expected SUCCESS deployment
# is partial, not ready. The shell must keep waiting (never declare running),
# then time out nonzero — never claim started.
new_case
fixtures_parked
set_push_history
node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const list = JSON.parse(fs.readFileSync(dir + "/servicelist.json", "utf8"));
const e = list.find((x) => x && x.id === process.argv[1]);
e.replicas = { configured: 2, running: 1, crashed: 0 };
fs.writeFileSync(dir + "/servicelist.json", JSON.stringify(list));' "$SVC_DB"
run_script start --timeout 6
check "start-partial: exits nonzero" "[ $RC -ne 0 ]"
check "start-partial: never claims started on partial counts" "! grep -q 'test environment started' '$CASE_DIR/out.txt'"
check "start-partial: partial replicas named" "grep -q 'partial replicas' '$CASE_DIR/err.txt'"
end_case

# --- start: stale crash with fresh pending waits; crash-loop fresh terminal refuses ------------
# Blocker 2, two halves. (a) Stale crashed=1 while the fresh id is BUILDING:
# tolerated while converging (already covered by start-stalecrash). (b) The
# fresh id itself terminal CRASHED non-stopped with crashed>0: immediate
# refusal naming the expected id, dependents untouched.
new_case
fixtures_parked
set_push_history
set_crashed "$SVC_DB" 1
touch "$STUB_STATE_DIR/never-converge"
node -e '
const fs = require("fs");
const dir = process.env.STUB_STATE_DIR;
const svc = process.argv[1];
const deps = JSON.parse(fs.readFileSync(dir + "/deployments.json", "utf8"));
const inst = JSON.parse(fs.readFileSync(dir + "/instances.json", "utf8"));
// Pre-seed a live CRASHED row that the fresh redeploy id will share only
// if the platform crash-loops it: here the fresh id stays distinct, so
// flip the minted head to CRASHED after start mints it is racy; instead
// seed a competing live CRASHED newcomer now — any live terminal row
// refuses the start even with crashed>0 tolerated-while-pending.
deps[svc] = deps[svc] || [];
deps[svc].unshift({ id: "loop-0000-1111-2222-333333333333", status: "CRASHED", deploymentStopped: false, serviceId: svc, environmentId: process.env.STUB_TEST_ENV });
fs.writeFileSync(dir + "/deployments.json", JSON.stringify(deps));
fs.writeFileSync(dir + "/instances.json", JSON.stringify(inst));' "$SVC_DB"
touch "$STUB_STATE_DIR/defer-fresh-$SVC_DB"
run_script start --timeout 8
check "start-crashloop: exits nonzero" "[ $RC -ne 0 ]"
check "start-crashloop: terminal deployment named" "grep -q 'terminal .*CRASHED' '$CASE_DIR/err.txt'"
check "start-crashloop: dependents untouched" "! grep -q 'RedeployDeployment' '$STUB_STATE_DIR/calls.log' && ! grep -q '^railway redeploy .*-s $SVC_WEB' '$STUB_STATE_DIR/calls.log'"
end_case

# --- status: unreadable readback exits nonzero (never WARNING success) --------------------------------
# Blocker 2 tail: start/stop end with `if ! show_status; ... exit 1`, and the
# status command surfaces the same readback. An unreadable snapshot must fail
# the command (exit nonzero), never print WARNING and exit 0.
new_case
fixtures_parked
touch "$STUB_STATE_DIR/fail-api-always"
run_script status --timeout 10
check "status-readfail: exits nonzero" "[ $RC -ne 0 ]"
check "status-readfail: failure is named, never a WARNING success" "grep -qi 'fail' '$CASE_DIR/err.txt' && ! grep -q 'parked=true' '$CASE_DIR/out.txt'"
check "status-readfail: no mutations on unreadable reads" "no_mutations"
end_case

# --- timeout: hung read is bounded by --timeout -------------------------------------------------
# Blocker 3: a hung `railway api` (sleeping stub) must not outlive the
# operation deadline. The stub sleeps longer than --timeout; the command
# must exit nonzero within a bounded multiple of the deadline.
new_case
fixtures_parked
printf '#!/bin/sh\necho "railway $*" >>"${STUB_STATE_DIR}/calls.log"\nsleep 60\nexit 0\n' >"$STUB_BIN/railway"
chmod +x "$STUB_BIN/railway"
T0=$(date +%s)
run_script status --timeout 6
T1=$(date +%s)
check "hung-read: exits nonzero" "[ $RC -ne 0 ]"
check "hung-read: bounded by timeout (<30s for 6s deadline)" "[ $((T1 - T0)) -lt 30 ]"
end_case

# --- args: zero timeout rejected ------------------------------------------------------------------
# Blocker 3: --timeout 0 would disable every bound (busy-spin). Reject it.
new_case
fixtures_parked
run_script status --timeout 0
check "args: zero timeout exits 2" "[ $RC -eq 2 ]"
run_script start --timeout 0
check "args: zero timeout on start exits 2" "[ $RC -eq 2 ]"
check "args: zero timeout issues no calls" "[ ! -s '$STUB_STATE_DIR/calls.log' ]"
end_case

# --- start: missing service refuses ---------------------------------------------------------
new_case
fixtures_parked
touch "$STUB_STATE_DIR/missing-service:$SVC_DB"
run_script start --timeout 8
check "start-missing: exits nonzero" "[ $RC -ne 0 ]"
check "start-missing: never claims started" "! grep -q 'test environment started' '$CASE_DIR/out.txt'"
end_case

# --- arg validation ----------------------------------------------------------------------------
new_case
fixtures_parked
run_script bogus-command
check "args: unknown argument exits 2" "[ $RC -eq 2 ]"
run_script --timeout nope status
check "args: bad timeout exits 2" "[ $RC -eq 2 ]"
set +e
RAILWAY_TEST_ENV_POLL_INTERVAL=1 sh "$SCRIPT" >"$CASE_DIR/out.txt" 2>"$CASE_DIR/err.txt"
RC=$?
set -e
check "args: missing command exits 2" "[ $RC -eq 2 ]"
end_case

# --- SIGTERM during a stop wait exits 143 promptly, loop does not continue --------------------
new_case
fixtures_parked
unpark_svc "$SVC_WEB"
touch "$STUB_STATE_DIR/stubborn-stop"
set +e
RAILWAY_TEST_ENV_POLL_INTERVAL=1 sh "$SCRIPT" stop --timeout 60 >"$CASE_DIR/out.txt" 2>"$CASE_DIR/err.txt" &
TPID=$!
# Wait until a stop is actually in flight (bounded; slow machines need more
# than a fixed sleep before the first StopDeployment is issued).
i=0
while [ "$i" -lt 30 ] && ! grep -q 'StopDeployment' "$STUB_STATE_DIR/calls.log"; do sleep 1; i=$((i+1)); done
BEFORE="$(wc -l <"$STUB_STATE_DIR/calls.log")"
kill -TERM "$TPID" 2>/dev/null || true
T0=$(date +%s)
wait "$TPID"
TRC=$?
T1=$(date +%s)
sleep 2
AFTER="$(wc -l <"$STUB_STATE_DIR/calls.log")"
set -e
check "sigterm: exits 143 on TERM" "[ $TRC -eq 143 ]"
check "sigterm: exits promptly after TERM (<8s)" "[ $((T1 - T0)) -lt 8 ]"
check "sigterm: loop does not continue (log stable)" "[ '$BEFORE' = '$AFTER' ]"
check "sigterm: a stop was actually in flight" "grep -q 'StopDeployment' '$STUB_STATE_DIR/calls.log'"
end_case

echo "---"
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
