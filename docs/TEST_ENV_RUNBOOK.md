# Test environment runbook (Railway)

On-demand start/stop/status for the Railway `test` environment. Explicit
manual control — there is intentionally no schedule; cost savings come from
the operator stopping the environment when it is not needed.

- Project: `10168080-e6e5-4e65-a8ec-b92f6cf514e5`
- Test env: `877f4590-5eb0-4aed-b811-d7d234195169`
- Production env: `eb369535-cde7-445d-90f3-baeab196e88c` (scripts REFUSE this)
- Services (test env):
  - web-test `fd533f19-cbed-4023-96e6-463dd299815e`
  - Postgres-ltHj `c44519a3-f013-4d49-a62b-7ca3bd61c4ff`
    (volume `postgres-volume-yEF7`, 5 GB)
  - push-delivery `d528d77e-fd99-4cd2-8c58-e9c4680e7587`
    (note: this service ID is shared with production, which is why every
    command below passes an explicit `--environment` flag and the scripts
    hard-guard on the env ID.)

Every mutation below MUST scope to the TEST env ID exactly and MUST refuse
`eb369535-cde7-445d-90f3-baeab196e88c` before any mutation logic
(fail closed; empty/unset resolves to test, anything else is refused).

## Witnessed failure: replica scale-to-zero does NOT park (2026-10-08/09)

On 2026-10-08/09 the operator attempted the old stop mechanism: replica
scaling to zero for web-test (region sfo) and push-delivery (region
europe-west4-drams3a).

What Railway returned vs what actually happened:

- The scale calls returned success, but Railway normalized the
  configuration to a default `us-west2` one-replica configuration
  (`numReplicas=1`) instead of parking the services.
- The test env did NOT park: services kept/resumed replicas rather than
  draining to zero.
- The database never scaled: the DB stayed up throughout.

The director then parked the environment natively (no service or volume
deleted):

- `deploymentStop` on the web-test active deployment.
- `deploymentStop` on the Postgres-ltHj active deployment.
- `deploymentRemove` of the pending push-delivery deployment `e88842ae`
  (a QUEUED/pending disposable TEST deployment; removal is only ever for
  pending disposable TEST deployments, never for the database and never
  for production).

Consequence: **no replica-scale stop instructions remain in this runbook.**
Replica scaling is not a stop mechanism for this environment. Do not
reintroduce it. (Workers A/B own `scripts/`; the scripts are being
corrected to the same native semantics — this document records the
target semantics.)

## Native lifecycle (current)

Verified live GraphQL shapes (use exactly these):

- `Mutation.deploymentStop(id: String!): Boolean` — stop an active
  deployment. This is the stop primitive.
- `Mutation.deploymentRemove(id: String!): Boolean` — remove ONE
  deployment. Use ONLY for a pending disposable TEST deployment (e.g. a
  stuck QUEUED/INITIALIZING push deployment). NEVER for the database,
  NEVER for production, NEVER as a general "stop".
- `Mutation.serviceInstanceAutoDeployUpdate(input { projectId,
  environmentId, serviceId, enabled })` + verification via
  `Query.serviceInstanceAutoDeployStatus(projectId, serviceId,
  environmentId) { enabled canEnable }` — autodeploy disable/verify.
- `Query.serviceInstance(serviceId, environmentId) { serviceName region
  numReplicas source { image repo } startCommand latestDeployment { id
  status deploymentStopped canRedeploy } activeDeployments[] { id status
  deploymentStopped } }` and `Query.deployments(input { projectId
  environmentId serviceId }, first) { edges { node { id status
  deploymentStopped serviceId environmentId } } }` — status reads.
- Start: `Mutation.serviceInstanceRedeploy(environmentId, serviceId):
  Boolean` or `Mutation.deploymentRedeploy(id): Deployment`, equivalently
  CLI `railway redeploy -s <service> -e <test-env> -p <project>
  [--from-source]` / `railway restart -s -e -p` / `railway up --service
  --environment --project --detach` for the source-less push recovery
  path below.

Stop (autodeploy off FIRST, then dependents, DB last):

1. Disable autodeploy for web-test (`serviceInstanceAutoDeployUpdate`
   `enabled: false`) and verify with `serviceInstanceAutoDeployStatus`
   (`enabled=false`, witnessed `canEnable=true`) BEFORE any
   `deploymentStop`, so a GitHub push cannot resume replicas mid-drain.
2. `deploymentStop` every active (non-stopped) deployment on the
   dependents first (web-test, push-delivery), verify both parked, then
   Postgres-ltHj. An unconfirmed dependent drain keeps the DB UP.
3. `deploymentRemove` ONLY a pending disposable TEST deployment that
   blocks parking (witnessed case: push `e88842ae` / `de074c88`
   history). Never the DB, never production.
4. Confirm parked per the definition below. Volumes, variables, config,
   and all data are retained — only running deployments are stopped.

Start (DB-first, identity-aware):

1. Redeploy the database service first (TEST-scoped redeploy), capture the
   single fresh deployment id by before/after scoped diff (ambiguous
   concurrent changes refuse, never guess), wait for THAT deployment
   (present, non-stopped, SUCCESS, running>=configured>=1, crashed 0 —
   a fresh id that is stopped while still BUILDING/pending waits for the
   land; a stopped SUCCESS/terminal id refuses), then wait for it to
   accept connections: in-container `pg_isready` probe over
   `railway ssh` (needs a registered SSH key — see `railway ssh keys`).
   The Postgres host is a `*.railway.internal` name, unreachable from
   the operator shell, so the probe runs inside the DB container.
2. Only after the DB probe passes, redeploy web-test and push-delivery
   (TEST-scoped `deploymentRedeploy`, same fresh-id capture + verification
   per service). Autodeploy stays off throughout.
3. Source-less push recovery: if push-delivery has no redeployable
   deployment, recover it with a scoped upload from a clean checkout
   (`railway up --service <push-id> --environment <test-env> --project
   <project> --detach`), keeping its `npm run push:worker` start
   command. A timed-out upload parks push-delivery before any retry
   (uploads may continue server-side; never stack them). Never copy a
   production deployment into test.
4. Re-enable web-test autodeploy only when wanted (explicit operator
   decision, verified back with `serviceInstanceAutoDeployStatus`).
   The final status readback after start/stop must succeed — a readback
   failure exits nonzero (never WARNING success).

Timeouts/signals: every Railway/SSH child runs under
`scripts/railway-run-bounded.mjs` (portable node timeout, no new deps)
within the overall `--timeout` deadline (positive integer; 0 rejected).
Signals kill the foreground child group, including descendants (130/143),
and stop issuing mutations. An exhausted operation budget refuses new work.
A timed-out upload may already have reached Railway; cleanup gets a separate
30-second budget and still reports the original failure. If cleanup is
unconfirmed, inspect status and run stop before retrying. Replica counts
NEVER default: missing/unconfirmed counts refuse the snapshot. The sole
empty-replica allowance requires the exact source-less push service with
explicit source/replicas/latest null and validated empty scoped history.
History reads follow validated cursors with a bounded page limit; missing
or inconsistent page information fails closed.

Ordering: start brings Postgres-ltHj up first (dependents consume
`DATABASE_URL`-style reference variables); stop drains dependents first
and never touches the DB while a dependent drain is unconfirmed. Both
dependents must be parked in the same fresh snapshot before each DB stop
or cancellation request. Final success rechecks all three services together.
A timeout or unconfirmed dependent drain exits nonzero and leaves the DB
untouched. Pending builds block parking even when Railway marks them stopped:
the platform can unstop them when they land.

## Parked definition (normative)

Parked := ALL of:

- `running == 0` on every TEST service, AND
- no active non-stopped deployments (`activeDeployments` all
  `deploymentStopped=true`, or the scoped active list is empty), AND
- no pending deployments (none in `QUEUED`, `INITIALIZING`, `WAITING`,
  `BUILDING`, `DEPLOYING`, or `NEEDS_APPROVAL`).

The configured replica value is IGNORED (Railway normalizes it; it says
nothing about cost). A `latest: null` snapshot is parked ONLY when the
scoped deployment lists confirm empty — never assumed from null alone.
A stale `SUCCESS` or `CRASHED` `latestDeployment.status` is NEVER
readiness evidence: stopped deployments keep their terminal status, and
status alone cannot prove anything is (or is not) running.

Native per-service snapshot shape (informative; worker A/B schema):

```json
{
  "service": "web|db|push",
  "serviceId": "<id>",
  "latest": { "id": "<dep>", "status": "CRASHED", "deploymentStopped": true },
  "active": [{ "id": "<dep>", "status": "CRASHED" }],
  "running": 0, "configured": 1, "crashed": 1,
  "parked": true, "pending": []
}
```

## Live parked baseline (2026-10-08/09, manager-observed)

- web-test: latest `a9de8c69`, status `CRASHED`, `deploymentStopped=true`,
  active `[a9de8c69]`, running 0 / configured 1, region `us-west2`
  (zero-scale moved it; original `sfo`). Autodeploy `enabled=false`,
  `canEnable=true`.
- Postgres-ltHj: latest `44f2bae4`, status `SUCCESS`,
  `deploymentStopped=true`, running 0 / configured 1, region `sfo`,
  source image `ghcr.io/railwayapp-templates/postgres-ssl:18`, volume
  `postgres-volume-yEF7` `READY` ~187 MB.
- push-delivery: latest `null`, active `[]`, replicas `null`,
  source `null`; start command `npm run push:worker` retained. History
  shows `REMOVED` `e88842ae` / `de074c88`.

## Live round-trip evidence (2026-10-09, manager-executed via the scripts)

- Repair roundtrip 2026-10-09 (fail-closed repair witness, `2aa1b99` +
  `9819a91` + `82ab858`):
  Start (rc 0, ~137 s): DB redeploy → `8329e8b4` SUCCESS running=1 +
  `pg_isready`; web `deploymentRedeploy` → fresh `274e403a` waited through
  BUILDING+stopped (stopped-while-building platform shape) → SUCCESS
  running=1; push `deploymentRedeploy` → fresh `921af0d0` through
  DEPLOYING+stopped → SUCCESS running=1. All verified by initiated-id
  (never running>0 alone). Final: all running=1, crashed=0, autodeploy
  `enabled=false`. (An earlier attempt with the same code refused
  correctly when a fresh web id read back stopped, then converged on
  retry after the platform unstopped it on land — the wait does not
  bless stopped SUCCESS/terminal ids.)
- Stop (rc 0, ~149 s): web+push `deploymentStop` → parked, then DB
  `deploymentStop 8329e8b4` → parked. Final: web `274e403a`
  CRASHED+stopped, DB `8329e8b4` SUCCESS+stopped, push `921af0d0`
  CRASHED+stopped, all running=0, no pending, autodeploy `enabled=false`,
  volume `postgres-volume-yEF7` retained. (Stopped deployments presenting
  as CRASHED with running=0 is normal platform behavior — parked is
  defined by running/active/pending, never by the terminal status label.)
- Production untouched throughout: web/push/Postgres 1/1 running before
  and after, `https://web-production-f1537.up.railway.app/api/health`
  200 before and after. No production DB access, no main push, no IaC
  apply. TEST web/push/DB parked, no pending, web autodeploy off,
  volume retained.

- Prior roundtrip 2026-10-09 (pre-repair code):
  Start (rc 0, ~148 s):
  DB redeploy `b3c7ad06` → running=1 + `pg_isready` accepting connections;
  web `deploymentRedeploy` → `674e32c2` SUCCESS running=1 (a first attempt
  earlier refused on a stale crashed=1 count while fresh redeploy `231c4603`
  was still BUILDING — the script now waits while a deployment is in
  flight and refuses on crashed only with nothing left running);
  push `railway up` from the committed clean checkout → `4d807426`
  SUCCESS running=1 with `npm run push:worker` preserved.
  Final: all three running=1, crashed=0, autodeploy still `enabled=false`.
- Stop (rc 0, ~200 s):
  web+push `deploymentStop` → parked, then DB `deploymentStop b3c7ad06`
  → parked. One transient `Operation timed out (os error 60)` snapshot
  read retried successfully mid-drain. No `deploymentRemove` needed.
  Final: web `674e32c2` CRASHED+stopped, DB `b3c7ad06` SUCCESS+stopped,
  push `4d807426` CRASHED+stopped, all running=0, no pending, autodeploy
  `enabled=false`, volume `postgres-volume-yEF7` READY ~188 MB retained.
  (Stopped deployments presenting as CRASHED with running=0 is normal
  platform behavior — parked is defined by running/active/pending, never
  by the terminal status label. Superseded stopped deployments later read
  back REMOVED; that is platform history, not a script deletion.)
- Production untouched throughout: web/push/Postgres 1/1 running before
  and after, `https://shortpickexception.nl/api/health` 200
  `{"status":"ok","database":"ok"}` before and after. No production DB
  access, no main push, no IaC apply.

## Autodeploy notes

- A natively parked (deployment-stopped) service stays parked until an
  explicit redeploy/restart; replica counts are configuration, not stop
  state, and MUST NOT be used as a parking signal.
- Web-test autodeploy is currently DISABLED (`enabled=false`) while the
  test env is parked. The start command keeps it disabled; re-enable only
  through a separate explicit operator decision.
- Do NOT use `railway service source disconnect` to suppress autodeploys:
  disconnecting removes the repo binding (reconnect requires the GitHub
  App flow) and its semantics were not verified — prefer the autodeploy
  toggle above.

## Files

- `scripts/railway-test-env.sh` — start|stop|status dispatcher (native
  deployment-stop lifecycle; replica-scale commands deleted).
- `scripts/railway-test-env-state.mjs` — scoped snapshot helper; see
  schema/exit codes above.
- `scripts/railway-test-env-guard.mjs` — pure ID/classification/parking
  guards (no Railway calls).
- `tests/` — guard unit tests + state-helper unit tests (run in routine
  `npm test`) + stub-CLI script tests (`npm run test:railway-script`,
  also in CI).

### Final independent-review safeguards (2026-10-09)

A stopped pending build still blocks parking: Railway can unstop it when it
lands. After a native stop attempt and fresh readback, cancellation is
restricted to stubborn early QUEUED/INITIALIZING/WAITING deployments or
explicitly stopped pending BUILDING/DEPLOYING/NEEDS_APPROVAL deployments.
Finished terminal deployments are not removed. An unconfirmed cancellation
refuses success and leaves the dependent-drain database gate closed.

Readbacks include validated paginated history and the latest deployment in
the stop set. Start success requires the initiated generations to remain
healthy together in one final snapshot. Idempotent start requires a live
SUCCESS latest generation, no pending work, full running replica convergence,
and a successful DB probe.

Final root witness: candidate `2d333e0`, 2026-10-09 03:53–03:59UTC;
start/status/stop/status all returned0. Initiated DB `c84edabf`, web
`c7d73abb`, push `ec408c8c` converged before stop. Final all running0,
parked, no pending, autodeployfalse. Production snapshots unchanged and
`https://shortpickexception.nl/api/health` returned status/databaseok.
Gates: script156/156, full unit/integration315/315, lint/types/build/backup
and migration validation pass.
