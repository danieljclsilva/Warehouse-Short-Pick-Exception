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

- `status` is read-only: service name, deployment status, configured vs
  running replicas, crashed replicas, and regions (verified live
  2026-10-08: all three services `SUCCESS`, 1/1 replicas).
- `start` scales the database to 1 replica first, waits for replica
  convergence (running>0 and running>=configured with configured>0) plus
  an in-container `pg_isready` probe over `railway ssh` (needs a
  registered SSH key — see `railway ssh keys`), and only then scales
  web-test and push-delivery and waits for each to converge. Default
  wait: 300 s per gate. A missing service, unparseable service-list
  data, crashed replicas, a FAILED/CRASHED latest deployment, or a failed
  DB probe aborts the run before dependents scale so the operator can
  triage logs (`railway logs --service <id>`) instead of scaling a
  broken service.
- `stop` scales web-test and push-delivery to 0 first, then WAITS until
  both read back running=0 AND configured=0 before touching the
  database. A timeout or readback failure exits nonzero and LEAVES THE
  DATABASE UP; only a confirmed drain proceeds to scale the DB to 0,
  followed by a final DB 0/0 verification. Volumes, variables, config,
  and all data are retained — only running replicas are removed.
- Readiness is replica convergence, never deployment status: scaling
  changes replica counts without redeploying, so a stale `SUCCESS`
  deployment says nothing about resumed instances. `railway deployment
  list` is never consulted by the scripts; the per-service
  `latestDeployment.status` from `railway service list` is used only as
  a refusal signal (FAILED/CRASHED aborts), never as readiness evidence.

## Ordering and readiness

- Start order: Postgres-ltHj → (replica convergence + `pg_isready`) →
  web-test + push-delivery → (convergence). The DB goes first because
  the app services consume `DATABASE_URL`-style reference variables;
  Railway also orders batched deploys by reference variables, but
  `start` issues independent scale calls, so the script enforces the
  order explicitly.
- Stop order: web-test + push-delivery → (both verified 0/0) →
  Postgres-ltHj → (verified 0/0). Dependents drain before the database
  they write to, and the DB is never touched while a dependent drain is
  unconfirmed.
- What the DB probe checks: `railway ssh -s <db-service> -- pg_isready`
  must report the container accepting connections. Replica counts alone
  cannot prove this — a container can be scheduled while Postgres is
  still starting. The Postgres host is a `*.railway.internal` name,
  unreachable from the operator shell, so the probe runs inside the DB
  container; it needs `railway ssh` to work (registered key). If the
  probe fails, `start` aborts before scaling dependents.

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

- A stopped (zero-scaled) service is EXPECTED to stay at 0 replicas
  across GitHub-push autodeploys of the connected repo (replica count
  is configuration, not deployment state), but this was never witnessed
  and is NOT claimed: a platform change could resume replicas, which
  would silently re-incur cost. Verify on first real use: stop, push a
  trivial commit to the connected branch, then `status` must still show
  0/0 replicas before trusting this. Until verified, treat a parked
  environment as "probably at 0, confirm with `status`" — and `status`
  is cheap and read-only, so run it whenever cost matters.
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
   autodeploy (mechanism says yes — replicas are config — but
   unwitnessed; see above: no persistence claimed until verified).
3. `railway service redeploy --from-source` as a recovery path if `start`
   ever finds a service with no deployable deployment.
4. Postgres data persistence across the stop/start cycle (volumes are
   documented to persist independently of deployments; the DB volume
   currently holds ~187 MB).
5. `railway service source disconnect` semantics — listed in help, behavior
   unverified, intentionally not used by the scripts.
6. The `pg_isready`-over-`railway ssh` DB probe path from an operator
   shell without a registered SSH key (the probe mechanism itself was
   verified live from this workstation, which has one; a keyless
   operator will see `start` abort after DB convergence with an SSH
   error — the DB is left running and the message says what to fix).
7. A real stop-while-busy drain: the stop gate waits for dependents to
   read back 0/0 and keeps the DB up otherwise, but the wait only
   observes counts — it cannot prove in-flight push batches finished,
   only that no replicas remain configured or running.

First-use checklist: run `status`, then `stop`, then `status` again
(expect 0/0 replicas, services still listed, volume intact), then `start`
(expect convergence on all three plus the DB probe). If step 2 in the
list above misbehaves, apply the autodeploy-toggle mitigation.

## Files

- `scripts/railway-test-env.sh` — start|stop|status dispatcher (executable).
- `scripts/railway-test-env-guard.mjs` — pinned IDs, env resolution, and
  the fail-closed production guard; single source of truth imported by the
  shell script (`--assert-env`) and unit-tested.
- `tests/railway-test-env-guard.test.ts` — guard unit tests (default→test,
  exact test-ID pass, production refusal, fail-closed unknowns, ID pins).
- `tests/railway-test-env-script.test.sh` — stub-CLI tests that execute
  the real script (`npm run test:railway-script`): stale-SUCCESS repro,
  happy-path start, stop ordering, stuck-drain DB protection, and
  CLI/readback error cases. No Railway access needed.
