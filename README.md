# Warehouse Short Pick Exception System

Internal web application for reporting and resolving warehouse short-pick exceptions. The full behavior is defined in the [product requirements](./Warehouse_Short_Pick_Exception%20_System.md); implementation progress is in [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md).

## Current implementation status

Phases 1–7 are complete locally. Phase 8 hardening is in progress; production deployment and acceptance remain pending. The latest disposable PostgreSQL run passed 82 tests across 16 files, and the app has tracked migrations through `0015`. Phase 7's fresh-database check covered migrations `0000` through `0013` (14 records), `db:check`, type checking, linting, production build, and diff check. PDF QA covered English, Dutch, Polish, and Spanish output with bundled Noto Sans fonts under the OFL, including a 46-page recurring-order report with an explicit omitted-date count. Frontend browser QA at 390px and 796px used fixture-mocked data, with no overflow or browser errors; it was not live-backend browser verification.

The analytics workspace provides date and operational-dimension filters, case and line metrics, recurring-order analysis, and bounded case/line/event CSV exports. It also generates a server-side PDF report on demand. Generated PDFs always stream to the requester; when S3-compatible object storage is configured, a retained copy is also saved as an object plus `analytics_reports` metadata with a UUID download id (`x-report-id`). Retention failures never fail the export: the PDF still streams, the response marks retention as unavailable, and the dashboard shows a translated warning. Retained reports are listed for the current user at `GET /api/analytics/reports` in newest-first pages, download again at `/api/analytics/reports/[id]`, and can be deleted with `DELETE /api/analytics/reports/[id]`; deletion is allowed for the report creator or a Team Leader with `EXPORT_ANALYTICS`, and storage failures return an error while keeping the report listed for retry. Generation and deletion both write audit events. Without configured storage (local development), the PDF still streams but no report id is issued. Dashboard access requires `VIEW_ANALYTICS`; CSV and PDF exports, including retained-report download and delete, require `EXPORT_ANALYTICS`, enforced by server routes. Analytics query limits are 5,000 cases, 10,000 lines, 20,000 events/tasks, and 1,000 recurring-order groups over at most 366 days; the dashboard indicates when results or derived metrics are partial. The UI and PDF support English, Dutch, Polish, and Spanish. Profile-photo uploads use S3-compatible persistent object storage.

## Local setup

Requirements: Node.js, npm, and PostgreSQL.

1. Copy `.env.example` to `.env` and set `DATABASE_URL` and `APP_URL` for your machine.
2. Create the `short_pick_exception` PostgreSQL database, or change `DATABASE_URL` to an existing empty development database.
3. Run `npm ci`.
4. Run `npm run db:migrate`.
5. Set `ADMIN_DISPLAY_NAME`, `ADMIN_IDENTIFIER`, and `ADMIN_PIN` temporarily in `.env`, then run `npm run seed:admin` to create the first administrator. `ADMIN_PIN` must be numeric with at least six digits. Remove these seed variables from `.env` after bootstrap.
6. Run `npm run dev` and open the URL in `APP_URL`.

The application has no public self-registration. An administrator must create an invitation before another person can register.

Team Leaders, Assistants, and Admins have an operations dashboard for reviewing cases, creating manual staged cases found in Short Pick / Hold, assigning responsibility, adding operational case messages, and closing or reopening cases. These actions are permission checked on the server; timeline events are immutable, and consequential assignments, closures, and reopenings also write audit entries.

The notification center provides persisted in-app responsibility and monitoring notifications, unread state, read actions, manager monitoring preferences, and optional device-specific browser push. In-app notifications remain available when push is unsupported, unavailable, or disabled. Live push delivery requires HTTPS and the VAPID variables in `.env.example`: `PUSH_PUBLIC_KEY`, `PUSH_PRIVATE_KEY`, and `PUSH_SUBJECT`.

Team Leaders, Admins, and permitted Assistants can edit the versioned operational configuration from the Configuration workspace when their permissions allow it. The panel covers workflow limits, timing thresholds, invitation defaults (8-hour expiry by default), login lockout policy, warehouse location naming, resolution codes, manual case creation, Assistant configuration access, push enablement, and the profile photo upload limit (default 5 MiB, configurable from 64 KiB to 25 MiB). Each save creates a new immutable version and audit entry; new cases keep the version captured at creation, while existing cases retain their historical behavior. Login lockout settings are managed by the active database configuration version; the old environment variable names are legacy and do not control runtime behavior.

Profile photo revisions, including superseded images and their object storage entries, are retained indefinitely in line with PRD §66. A failed database write attempts to delete the newly uploaded object as compensation. There is no automatic cleanup after a successful replacement, so operators should account for storage growth.

Authenticated activity refreshes the persistent HTTP-only session cookie. Server sessions have no scheduled expiry, but browsers can discard cookies after extended inactivity under their own retention limits.

If the only administrator loses access, a database operator can set `ADMIN_RECOVERY_IDENTIFIER`, `ADMIN_RECOVERY_PIN`, and `ADMIN_RECOVERY_CONFIRM` as shown in `.env.example`, then run `npm run recover:admin`. This resets only an existing active Admin PIN, revokes their sessions, and records an audit event. Remove the temporary recovery variables immediately afterward.

To reset a **disposable local** PostgreSQL database, stop the app, drop and recreate only the database named in your local `DATABASE_URL`, then run `npm run db:migrate` and `npm run seed:admin` again. Never use this procedure against a Railway or shared database. Production changes use migrations and account administration instead.

## Checks

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm run db:check
```

## Railway deployment status

The private source repository is [danieljclsilva/Warehouse-Short-Pick-Exception](https://github.com/danieljclsilva/Warehouse-Short-Pick-Exception). Railway has a `production` environment in project `warehouse-short-pick-exception`. Its PostgreSQL service is provisioned, point-in-time recovery is enabled, and a private AMS object-storage bucket is provisioned for profile photos and reports. The `web` service has the domain [web-production-f1537.up.railway.app](https://web-production-f1537.up.railway.app), database, app URL, storage, and VAPID variables configured, and its IaC deploy settings applied, but it still has no source repository or deployment. The `notifications-emitter` and `push-delivery` services have their database and push variable references and IaC cron settings applied, but no source repository or deployment. Temporary web admin bootstrap variables are staged for the initial seed; the account has not yet been bootstrapped. A restore drill has not yet been completed.

The [`.railway/railway.ts`](./.railway/railway.ts) file is the single Railway IaC definition for the project. It keeps imported variable values as `preserve()` references, configures the web start command, migration pre-deploy step, and `/health` check, and gives each cron service its own start command and five-minute schedule without an HTTP health check. The repository includes Railway's TypeScript SDK as a development dependency for planning. Config as Code files are deprecated and cannot be enabled on new services; use the IaC workflow and preview changes with `railway config plan` before any apply.

### First production deployment

1. Connect the existing `web`, `notifications-emitter`, and `push-delivery` services to the private GitHub repository and select the reviewed production branch. Confirm each service root is the repository root. The IaC definition intentionally leaves source selection to Railway service settings.
2. The `web` service already has `DATABASE_URL`, `APP_URL`, storage, and VAPID variables configured. Verify `DATABASE_URL` remains a Railway reference to the PostgreSQL service's `DATABASE_URL`, and `APP_URL` is `https://web-production-f1537.up.railway.app`. The web config runs only tracked migrations in pre-deploy; do not make manual schema changes.
3. Verify the private bucket's Railway-provided endpoint, region, bucket name, access key, and secret key references map to `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, and `STORAGE_SECRET_ACCESS_KEY`. Keep `STORAGE_FORCE_PATH_STYLE=false` unless the bucket's credentials page specifies otherwise. Keep all secret values in Railway variables, never in Git or build output.
4. Verify stable `PUSH_PUBLIC_KEY`, `PUSH_PRIVATE_KEY`, and `PUSH_SUBJECT` variables from `.env.example`. Keep the private key secret and stable across releases. `WAREHOUSE_COMPANY_NAME` is optional. Do not configure the unused legacy login lockout variables.
5. Deploy the web service. Confirm the pre-deploy migration command succeeds and `/health` returns `{"status":"ok"}`. Check `/api/health` separately for database readiness; it returns an error when PostgreSQL is unavailable.
6. Bootstrap the first administrator once. Temporary `ADMIN_DISPLAY_NAME`, `ADMIN_IDENTIFIER`, and `ADMIN_PIN` references are currently staged and preserved in IaC. Run `npm run seed:admin` in a container connected to the Railway private network, verify the account can sign in, then remove those variables from Railway and remove their `preserve()` entries from IaC. Never put a real PIN in repository files or logs.
7. The applied IaC settings assign migrations and `/health` solely to web. The cron services use `npm run notifications:emit` and `npm run push:deliver` every five minutes, with no HTTP health check or migration pre-deploy command. After linking each service source, confirm `railway config plan` shows no unintended drift; GitHub source deployments do not apply IaC settings. Verify the existing database/push variable references, each job's first run, and the logs.

### Release and recovery checks

- Before a release, review the diff and migration, then run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `npm run db:check` against a disposable database. Use the fresh-database migration/integration test workflow for migration changes.
- Keep the PostgreSQL service's PITR configuration enabled and check its status after provisioning changes. Before accepting production data, perform and record a restore drill into a separate disposable database, run migrations/checks there, and verify the restored app can read expected records. PITR being enabled does not itself prove a successful restore.
- After release, smoke-test sign-in, invite-only registration, picker case creation, assignment/check flow, in-app notification and read action, profile photo upload/approval, analytics CSV/PDF plus retained-report list, download, pagination, and delete (`x-report-id` → `GET`/`DELETE /api/analytics/reports/[id]`), and both cron logs. Confirm at least one non-admin account sees only its authorized actions.
- For a bad application release, redeploy the last known-good application deployment and inspect `/api/health` and logs. Do not roll back the database by hand. Prefer forward-only, backward-compatible migrations; restore PITR to a separate database and rehearse recovery before any production data restore.

The IaC deploy settings are applied and the latest plan reports no drift. The web and cron services still have no source or deployments. Live push delivery is not verified. Production web deployment, admin bootstrap, restore drill, live browser QA, and the Phase 8 acceptance checklist remain outstanding. Durable PDF retention is implemented locally (retained copy plus metadata row, current-user list with pagination, re-download and creator/Team Leader deletion, audit-logged, export decoupled from retention failures); production verification against the live bucket is still part of the outstanding smoke test.
