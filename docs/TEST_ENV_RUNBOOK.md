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

Start (DB-first):

1. Redeploy the database service first (TEST-scoped redeploy), then wait
   for it to accept connections: in-container `pg_isready` probe over
   `railway ssh` (needs a registered SSH key — see `railway ssh keys`).
   The Postgres host is a `*.railway.internal` name, unreachable from
   the operator shell, so the probe runs inside the DB container.
2. Only after the DB probe passes, redeploy web-test and push-delivery
   (TEST-scoped).
3. Source-less push recovery: push-delivery currently has no configured
   source and no current deployment, so a plain redeploy has nothing to
   redeploy. Recover it with a scoped upload from a clean checkout
   (`railway up --service <push-id> --environment <test-env> --project
   <project> --detach`), keeping its `npm run push:worker` start
   command. Never copy a production deployment into test.
4. Re-enable web-test autodeploy only when wanted (explicit operator
   decision, verified back with `serviceInstanceAutoDeployStatus`).

Ordering: start brings Postgres-ltHj up first (dependents consume
`DATABASE_URL`-style reference variables); stop drains dependents first
and never touches the DB while a dependent drain is unconfirmed. A
timeout or unconfirmed drain exits nonzero and LEAVES THE DATABASE UP.

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

## Pending live validation (placeholders — manager fills in)

The following identifiers are intentionally left open until the manager
completes live validation. Do not invent them.

- Start round-trip redeploy IDs: `<!-- MANAGER: TEST start redeploy IDs (db, web, push) + timestamps -->`
- Post-start status snapshot IDs: `<!-- MANAGER: post-start latest/active deployment IDs + pg_isready result -->`
- Stop round-trip stop/remove IDs: `<!-- MANAGER: TEST stop deploymentStop/deploymentRemove IDs + timestamps -->`
- Post-stop status snapshot IDs: `<!-- MANAGER: post-stop parked snapshot IDs confirming parked := running0 + no active non-stopped + no pending -->`

## Autodeploy notes

- A natively parked (deployment-stopped) service stays parked until an
  explicit redeploy/restart; replica counts are configuration, not stop
  state, and MUST NOT be used as a parking signal.
- Web-test autodeploy is currently DISABLED (`enabled=false`) while the
  test env is parked. Re-enable only on an explicit `start` decision.
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
