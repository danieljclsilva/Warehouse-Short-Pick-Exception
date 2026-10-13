# Shift-based push delivery

Production web and PostgreSQL remain online. Push delivery uses the latest
configured working days/start/end in Europe/Amsterdam, rather than a fixed UTC
shift. In-app notifications remain available regardless of working hours.

The exact Railway environment name `test` keeps its worker running until the
TEST lifecycle script parks it, preserving replica readiness for after-hours QA.
This does not bypass delivery hours or PUSH_ENABLED: it only preserves the TEST
process. Production and unknown environments retain the scheduled exit policy.

Railway runs `node build/push-worker.cjs` with cron `*/5 * * * *` and restart
policy `NEVER`. Each run reads the current configuration. Outside the shift or
15-minute warm-up window it closes the database pool and exits. Within that
window it stays running with serial five-second polling; Railway skips cron
runs while the prior run remains active. Warm-up does not send push alerts.
Closing time and live configuration changes are checked each poll and before
provider requests. An in-flight provider request may finish after closing.

Cron has five-minute granularity and platform startup delay. For starts not
aligned to five-minute boundaries, warm-up begins roughly 10–15 minutes before
opening, plus any platform delay. This is not a precise readiness guarantee.
An error exits nonzero; the next five-minute cron run retries. No external
scheduler, Railway API token, or new environment variable is required.

Queued notifications from before the current shift are marked `DISABLED` in
the push outbox, with `outside current working shift` as the reason. Their
in-app notifications remain unread/available; subscriptions are not disabled.
Current-shift retries retain their normal backoff. Old outbox cleanup is bounded
by the delivery batch, so a large pre-existing backlog can delay fresh pushes.
The web service still creates outbox records after hours; these are suppressed
when claimed in the next shift, never replayed as morning push alerts.

The worker image uses `push/Dockerfile`: bundle TypeScript with esbuild during
build, remove development dependencies, then run Node directly as an unprivileged
user. `npm run build:workers` builds the same bundle locally; `npm run build`
also builds it for Railway test-environment start workflows. No npm/tsx runtime
wrapper is used by production push delivery.

Verify with service-scoped deployment status and logs. Outside hours a completed
run should log `push.worker.started`, then `push.worker.stopped`, exit successfully,
and leave zero running replicas between cron checks. During the warm-up window
the process stays running but sends nothing; during the shift it delivers with
five-second polling. Compare shift-time memory after rollout before claiming
specific compiler savings. Brief off-hours cron checks still incur some usage.

Rollback: restore the previously recorded production push build/start/cron/restart
configuration and redeploy its prior successful deployment. Do not apply the
whole-project IaC file: it omits live test resources. Scope every live mutation
to production push-delivery only. No schema change or migration is needed.
