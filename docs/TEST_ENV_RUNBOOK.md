# Test environment runbook (Railway)

On-demand start/stop/status for the Railway `test` environment. Explicit
manual control — there is intentionally no schedule; cost savings come from
the operator stopping the environment when it is not needed.

- Project: `10168080-e6e5-4e65-a8ec-b92f6cf514e5`
- Test env: `877f4590-5eb0-4aed-b811-d7d234195169`
- Production env: `eb369535-cde7-445d-90f3-baeab196e88c` (scripts REFUSE this)
- Services (test env):
  - web-test `fd533f19-cbed-4023-96e6-463dd299815e` (region `sfo`)
  - Postgres-ltHj `c44519a3-f013-4d49-a62b-7ca3bd61c4ff` (region `sfo`,
    volume `postgres-volume-yEF7`, 5 GB)
  - push-delivery `d528d77e-fd99-4cd2-8c58-e9c4680e7587`
    (region `europe-west4-drams3a`) — note: this service ID is shared with
    production, which is why every command below passes an explicit
    `--environment` flag and the scripts hard-guard on the env ID.

## Commands

All commands are safe to re-run. Production is never the default and is
refused outright (exact env-ID comparison, fail closed).

```sh
sh scripts/railway-test-env.sh status
sh scripts/railway-test-env.sh status --env 877f4590-5eb0-4aed-b811-d7d234195169
sh scripts/railway-test-env.sh start [--timeout 300]
sh scripts/railway-test-env.sh stop  [--timeout 300]
```

- `status` is read-only: service name, deployment status, configured vs
  running replicas, and regions (verified live 2026-10-08: all three
  services `SUCCESS`, 1/1 replicas).
- `start` scales the database to 1 replica first and waits for `SUCCESS`
  before scaling web-test and push-delivery, then waits for each to reach
  `SUCCESS`. Default wait: 300 s per service.
- `stop` scales web-test and push-delivery to 0 first, then the database.
  Volumes, variables, config, and all data are retained — only running
  replicas are removed.

## Ordering and readiness

- Start order: Postgres-ltHj → (SUCCESS) → web-test + push-delivery.
  The DB goes first because the app services consume `DATABASE_URL`-style
  reference variables; Railway also orders batched deploys by reference
  variables, but `start` issues independent scale calls, so the script
  enforces the order explicitly.
- Stop order: web-test + push-delivery → Postgres-ltHj (dependents drain
  before the database they write to).
- Readiness: `railway deployment list --limit 1 --json` must report
  `SUCCESS` for the service. `FAILED`/`CRASHED` aborts the run so the
  operator can triage logs (`railway logs --service <id>`) instead of
  scaling a broken service.

## What stop/start maps to (verified)

There is **no** `railway service stop` command (CLI 5.62.1 has no
stop/sleep/pause verb anywhere in root or subcommand help; Railway support
confirms there is no pause feature). The scripts use replica scaling:

- stop = `railway scale -p <project> -e <test-env> --service <id> <region>=0`
  per configured region. Scaling to 0 is the documented way to remove
  replicas from a region (`railway scale --help` example
  `eu-west=0`; `docs.railway.com/cli/scale`).
- start = the same command with `=1`, which restores replicas through the
  standard environment patch flow (no separate redeploy step); if the
  service has no current deployment, `railway service redeploy
  --from-source` recreates one.
- `railway down` (remove latest deployment, dashboard three-dot "Remove")
  is deliberately NOT used: it only removes one deployment, is
  destructive-ish, and must never touch the database.

## Autodeploy and rebuild notes

- A **stopped (zero-scaled) service stays at 0 replicas across GitHub-push
  autodeploys of the connected repo**: an autodeploy builds a new image but
  the replica count is configuration, not deployment state, so the new
  deployment also runs 0 replicas. Verify this the first time: stop, push a
  trivial commit to the connected branch, then `status` should still show
  0/0 replicas.
- If a web-test deployment instead comes back running after an autodeploy,
  disable autodeploy for the web-test service (dashboard: Service Settings →
  GitHub trigger → Disable) while the test env is parked, and re-enable it
  on the next `start`. Do NOT use `railway service source disconnect` for
  this: disconnecting removes the repo binding (reconnect requires the
  GitHub App flow) and the source-level semantics were not verified —
  prefer the autodeploy toggle.
- If `start` reports no regions for a service (service list shows an empty
  region list after a long stop), the script falls back to the pinned
  region (`sfo` for web-test/Postgres-ltHj, `europe-west4-drams3a` for
  push-delivery). If the fallback region is ever wrong,
  `railway service list` output will show the correct one — update
  `FALLBACK_REGIONS` in `scripts/railway-test-env-guard.mjs`.
- Railway-initiated host migrations redeploy services automatically; a
  zero-scaled service should remain at 0, but confirm with `status` after
  any platform maintenance notice.

## What could NOT be verified without mutations

Honestly, read-only only — the following were never executed and remain
operator-verified on first real use:

1. `railway scale … <region>=0` / `=1` round-trip on a real service
   (the exact JSON output shape on scale, and that 1 replica restores the
   previous image without a rebuild).
2. That a zero-scaled service stays at 0 across an actual GitHub-push
   autodeploy (mechanism says yes — replicas are config — but unwitnessed).
3. `railway service redeploy --from-source` as a recovery path if `start`
   ever finds a service with no deployable deployment.
4. Postgres data persistence across the stop/start cycle (volumes are
   documented to persist independently of deployments; the DB volume
   currently holds ~187 MB).
5. `railway service source disconnect` semantics — listed in help, behavior
   unverified, intentionally not used by the scripts.

First-use checklist: run `status`, then `stop`, then `status` again
(expect 0/0 replicas, services still listed, volume intact), then `start`
(expect SUCCESS on all three). If step 2 in the list above misbehaves,
apply the autodeploy-toggle mitigation.

## Files

- `scripts/railway-test-env.sh` — start|stop|status dispatcher (executable).
- `scripts/railway-test-env-guard.mjs` — pinned IDs, env resolution, and
  the fail-closed production guard; single source of truth imported by the
  shell script (`--assert-env`) and unit-tested.
- `tests/railway-test-env-guard.test.ts` — guard unit tests (default→test,
  exact test-ID pass, production refusal, fail-closed unknowns, ID pins).
