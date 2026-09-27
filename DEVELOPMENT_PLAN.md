# Development plan

The [product requirements](./Warehouse_Short_Pick_Exception%20_System.md) are the source of truth. The project is a modular Next.js application with PostgreSQL. Each phase is accepted only after its behavior, tests, type checking, linting, migrations, and known limitations have been reviewed.

| Phase | Scope | Status |
| --- | --- | --- |
| 1. Foundation | PostgreSQL, migrations, invite-only registration, PIN login, persistent revocable sessions, granular permissions, four-language base UI | Complete locally; deployment pending |
| 2. Core case workflow | One open case per order, lines, duplicate history, picker lists, events | Complete locally; deployment pending |
| 3. Checking and responsibility | Claim/assignment races, discovery, retrieval, staging, responsibility routing | Complete locally; deployment pending |
| 4. Operations | TL dashboard, manual cases, troubleshooter, messages, close/reopen | Complete locally; deployment pending |
| 5. Notifications | In-app notifications, preferences, Web Push | Complete locally; deployment pending |
| 6. Configuration | Editable values, immutable versions, case snapshots, audit | Complete locally; deployment pending |
| 7. Analytics and export | Filters, duplicate analysis, CSV, PDF | Complete locally; web deployed; production acceptance pending |
| 8. Hardening | End-to-end tests, accessibility, performance, logging, security, deployment, backups | In progress; production deployment and acceptance pending |

## Architecture decisions

- Next.js App Router, strict TypeScript, PostgreSQL, Drizzle ORM, Zod, Tailwind CSS.
- A modular monolith with server-side authorization and validation.
- Database migrations are tracked in `drizzle/`.
- The only deployment target planned for v1 is Railway with a separate PostgreSQL service.
- The GitHub repository is private because this is an internal operational system.

## Phase 1 acceptance

- An administrator can bootstrap an account and create a registration invitation.
- A worker can register only with an active, unexpired, unexhausted invitation.
- A registered user can log in with a stable identifier and a numeric PIN of at least six digits.
- A session remains valid until explicit revocation or account/PIN state changes, and its cookie is HTTP-only.
- Server routes enforce permissions and role hierarchy.
- The responsive interface offers English, Dutch, Polish, and Spanish with English fallback.
- Migrations, tests, type checking, linting, and an HTTP health route pass.

## Phase 2 acceptance

- A picker can look up an order, open an existing active case, or confirm the exact historical occurrences before starting a new one.
- A new case and its first normalized shortage line are saved together. Cancelling a draft leaves no empty case.
- PostgreSQL enforces at most one non-closed case per order, including concurrent creation attempts.
- A picker can view multiple active orders and add more lines. An unresolved duplicate location/SKU combination produces a warning; only an authorized Team Leader or Admin can override it.
- Case creation and shortage-line mutations record immutable case events in their database transactions.
- Phase 2 integration tests, type checking, linting, migration validation, production build, and mobile browser checks pass.

## Phase 3 acceptance

- Every reported shortage line receives its own available check task. Claiming and assigning are transactional; simultaneous claims produce one winner, assigned checks cannot be claimed, and only authorized managers can reassign.
- The maximum active checks per case defaults to one and supports an authorized setting of 1–100 or unlimited. Changing capacity affects later claims without moving case ownership away from the picker.
- Check completion records a structured outcome. Reporting a new location creates a separate retrieval obligation; it does not mark stock retrieved. A failed check leaves the line open for an authorized new task.
- During picking, retrieval routes to the active picker. After the picker explicitly confirms physical placement in Short Pick / Hold, staged retrieval routes to the checker when permitted. A case-level lock serializes discovery and staging so either event order yields the staged routing.
- Picker and checker workflows have responsive controls in all four supported languages. A mobile browser walkthrough covered staging, discovery, retrieval, and console errors.
- A fresh PostgreSQL database applied all tracked migrations, then 22 tests passed. Type checking, linting, migration validation, and production build passed.

## Phase 4 acceptance

- Team Leaders, Assistants, and Admins can use the operations dashboard to review open and recently closed cases, filter the work list, inspect case details, and assign responsibility where permitted.
- Team Leaders, Assistants, and Admins can create a manual case for a physical Short Pick / Hold, including order, location, SKU, quantity, reason, and optional picker context. Manual cases start in the staged physical-hold state and record a `CASE_CREATED` event with the manual source and reason.
- Authorized operational users can add immutable case messages, and messages appear with structured events in the chronological case timeline. Pickers cannot use the general operations messaging flow.
- Authorized users can close cases when all lines are terminal or provide an authorized administrative resolution. Closure records the resolver, `CASE_CLOSED` event, and audit entry in one transaction.
- Team Leaders, Assistants, and Admins can reopen closed cases with an explicit active phase, responsibility, and line set. Reopening preserves closure history and records `CASE_REOPENED`, responsibility, and audit events atomically.
- A fresh `shortpick_phase4_verify` PostgreSQL database applied migrations `0000` through `0005`. Twenty-six tests across five test files passed; `db:check`, type checking, linting, and the production build passed.
- Final browser QA covered the operations workflow at 796px and 390px, including manual staged case creation, administrative close and reopen, preserved event timeline, localized physical-state and line/retrieval labels, no horizontal overflow, and no browser warnings or errors.

## Phase 5 acceptance

- Responsibility notifications are persisted in-app and routed to the current responsible picker, checker, retriever, or troubleshooter. Monitoring notifications are routed only to active manager users with the required permissions and respect per-user preferences.
- The notification center lists recent notifications, shows unread state, supports marking a notification read, and keeps responsibility notifications visible regardless of monitoring preferences.
- Team Leaders, Assistants, and Admins with `VIEW_ALL_OPEN_CASES` can save monitoring preferences and the unresolved-case threshold. Preferences are validated and persisted by the server.
- Browser push is device-specific and optional. Each notification is persisted in-app before any push delivery attempt; push failures do not fail the originating operational action. The browser UI supports enabling and removing individual devices when VAPID configuration and HTTPS are available.
- A fresh `shortpick_phase5_verify` PostgreSQL database applied migrations `0000` through `0009`. Thirty-two tests across seven test files passed; `db:check`, type checking, linting, and the production build passed.
- Final browser QA covered the notification list, mark-read action, preference save, unavailable push state, the `/` deep link with `section=notifications`, 390px and 796px layouts without horizontal overflow, and no browser warnings or errors.

## Phase 6 acceptance

- Authorized Team Leaders and Admins can edit the 17 active operational configuration keys. Assistants can use the panel only when they have the permission and the Team Leader controlled Assistant access setting is enabled. The server remains the authorization boundary.
- Configuration values are validated against documented bounds and defaults, including an 8-hour default invitation expiry. The maximum simultaneous checks setting supports a finite value or unlimited (`null`); resolution codes describe checker completion outcomes; environment-only secrets are not exposed in the panel.
- Every successful change creates an immutable configuration version and audit record. The panel shows the current version number and ID, changed values, actor, and timestamp. A stale `expectedVersion` produces a conflict that requires reviewing the latest version before retrying.
- New cases store their configuration version snapshot. Existing cases continue using the configuration version under which they were created, so later edits do not silently change historical behavior. The legacy configuration migration initializes the versioned settings from the previous policy values.
- A fresh PostgreSQL database applied migrations `0000` through `0011`. Forty-three tests across eight test files passed; `db:check`, type checking, linting, and the production build passed.
- Browser QA covered saving warning threshold v2 to v3 with immediate immutable history refresh, the unlimited check-capacity control, translated configuration labels, dashboard attention badges, 390px and 796px layouts without horizontal overflow, and no browser warnings or errors.

## Phase 7 implementation and acceptance review

- The analytics dashboard uses structured case, line, task, event, and versioned configuration data. It reports case and line totals, cases by period, lines by location and SKU, check outcomes, retrievals, median elapsed times, threshold cases, manual and reopened cases, recurring order numbers, and cases by configuration version.
- Server-validated filters cover date range (maximum 366 days), order number, location, SKU, case phase, resolution, case source, configuration version, picker, checker, and troubleshooter. User-level analytics remain operational data and do not rank workers.
- Recurring order analysis shows occurrence counts and case dates. Dashboard queries are bounded at 5,000 cases, 10,000 lines, 20,000 events/tasks, and 1,000 recurring-order groups. The UI reports when result sets or derived metrics are partial.
- CSV supports normalized case-level and line-level data, plus event data for users with export permission. Server endpoints enforce `VIEW_ANALYTICS` for dashboard access and `EXPORT_ANALYTICS` for CSV/PDF exports; export controls in the UI are presentation only.
- The server-generated PDF contains a report title, generated timestamp, applied filters, KPI summary, selected chart/table summaries, case and line detail, and configuration-version context. Its deliberate report layout is not a webpage screenshot. PDF generation is on demand and streamed with private/no-store headers; when object storage is configured, the retained copy is listed for the current user with cursor pagination, can be downloaded again, and can be deleted by its creator or a Team Leader. Retention failures keep the PDF download successful and show a translated dashboard warning.
- Analytics UI and report strings support English, Dutch, Polish, and Spanish with English fallback. Identifiers such as order numbers, locations, and SKUs remain data values.
- Migrations `0012` and `0013` add query-supporting indexes for analytics access patterns.
- A fresh disposable PostgreSQL database applied migrations `0000` through `0013` (14 migration records). `db:check`, all 55 tests across 11 files, type checking, linting, production build, and diff check passed.
- PDF QA covered English, Dutch, Polish, and Spanish output using bundled Noto Sans fonts under the OFL. A 46-page report with long recurring-order history included an explicit omitted-date count. Fixture-mocked browser QA at 390px and 796px found no overflow or browser errors. Live Safari QA then passed administrator login, workspace loading, analytics rendering, filter interaction, and logout on the deployed desktop site; live analytics JSON, CSV, and retained-report-list requests returned 200. The PDFKit production bundling fix is in `d779c3a`; the production PDF returned 200 with 22,052 bytes, and retained S3 copy, list, re-download byte match, and delete checks all returned 200. Live mobile and browser-console verification remain unverified.

## Known limitations

- Phase 7 is complete locally and the web service is deployed. Live analytics JSON, CSV, and retained-report-list requests returned 200. The PDFKit production bundling fix in `d779c3a` is deployed; the production PDF returned 200 with 22,052 bytes, and retained S3 copy, list, re-download byte match, and delete checks all returned 200. Generated PDFs always stream on demand; when S3-compatible object storage is configured, a retained copy is also saved as an object plus `analytics_reports` metadata, listed for the current user at `GET /api/analytics/reports` with cursor pagination, and available by UUID at `GET /api/analytics/reports/[id]`. The creator or a Team Leader can delete a report with `DELETE /api/analytics/reports/[id]`; storage failures leave the metadata available for retry. Retention failures never fail the export and are reported in the dashboard. Configuration is versioned in PostgreSQL; login lockout policy is now managed there rather than through environment variables.
- Web Push deployment requires HTTPS plus stable `PUSH_PUBLIC_KEY`, `PUSH_PRIVATE_KEY`, and `PUSH_SUBJECT` Railway variables. Live push delivery remains deployment QA; local acceptance covered the configured and unavailable states, while in-app notifications work without push.
- Railway Phase 8 requires `npm run notifications:emit` for unresolved-case monitoring and `npm run push:deliver` for queued Web Push delivery. Separate `notifications-emitter` and `push-delivery` services now exist with their five-minute IaC schedules and commands applied; all three Railway deployments and manual cron runs succeeded. The `web` service source is now connected to `danieljclsilva/Warehouse-Short-Pick-Exception` (`main`) via CLI, and `.railway/railway.ts` pins the same source with `railway config plan` reporting no drift. Daily/weekly volume-backup schedule setup via CLI still returns access-denied after token refresh; relay-verified dashboard shows `No backup schedule` with scheduled backups gated on the Pro plan.
- The Team Leader duplicate-line override is enforced in the API; its management interface belongs to the later Team Leader operations phase.
- Current production infrastructure is partially provisioned: the private GitHub repository is `danieljclsilva/Warehouse-Short-Pick-Exception`; Railway project `warehouse-short-pick-exception` has a `production` environment, a PostgreSQL service with PITR enabled, and a private AMS object-storage bucket. All three services deployed successfully through the CLI; bootstrap variables were removed and the web service was redeployed. Public `/api/health` reports database readiness and the seeded administrator passed a login smoke test. The `web` GitHub source is connected and pinned in IaC. Live Safari administrator/workspace/analytics/filter/logout QA passed, and live analytics JSON, CSV, and report-list requests returned 200. The production PDF returned 200 with 22,052 bytes, and retained S3 copy, list, re-download byte match, and delete checks all returned 200. The operator resized the Postgres volume to 5 GB (IaC `sizeMB: 5000`, `railway config plan` no drift; live shows the pre-restore source volume detached at 471MB/5000MB and the post-restore attached volume `postgres-2026-09-27 12:24 UTC` at 0MB/5000MB Ready). Point-in-time WAL replay into a disposable 5 GB service still failed with `[28] No space left on device` plus `recovery ended before configured recovery target was reached`; production Postgres was untouched by those attempts. A separate on-demand backup restore drill succeeded: backup `70945d9f` restored into a fresh 5 GB volume, `Postgres` redeployed (`a8966e7a`), `/api/health` returned 200 `database ok`, and the restored database reads 1 user (`spx-admin`/ADMIN), 0 `order_cases`, 16 migrations.
- `.railway/railway.ts` is the single IaC definition for the one-repository Railway project. The CLI import keeps existing non-secret variable values as `preserve()` references, and the SDK is a development dependency so the CLI can evaluate the file. The web migration pre-deploy command and `/health` liveness check, and the two cron commands/schedules without HTTP health or migration pre-deploy, are defined. A read-only plan reports no drift. The bootstrap `ADMIN_*` preserve entries were removed after the successful seed; temporary Railway variable cleanup remains an operator-owned action.
- The latest disposable PostgreSQL run passed 82 tests across 16 files with migrations through `0015`, plus passing real-HTTP critical/security e2e flows and a `railway config plan` with no drift. CI run `36318063179` passed. This does not satisfy Phase 8 acceptance: point-in-time WAL replay recovery remains failed/unverified despite the 5 GB resize (backup-restore drill succeeded instead), and daily/weekly volume-backup schedules remain unset (dashboard-verified `No backup schedule`, Pro plan required). The web deployment, GitHub source connection, cron run smoke, PDF/retention smoke, public health check, login smoke, headless Chromium login-shell checks (1280px/390px/796px, zero console errors), and authenticated PICKER role smoke (`spx-a0auliipli8`: picker-only nav, workspace/notifications/profile sections, order lookup without errors, 403 on admin/analytics probes, clean logout, 0 overflow at 390px/796px) are complete.
- Browser cookie retention caps can require a new login after a very long period without opening the app. Active sessions refresh their persistent HTTP-only cookie; server sessions have no time-based expiration.
- `npm audit --omit=dev` reports no production dependency advisories. The full audit reports four moderate advisories in Drizzle Kit's development-only dependency tree.

## Phase 8 deployment readiness progress

- Added profile photo storage and review flows, server-side structured logging, a configurable upload limit (default 5 MiB; 64 KiB–25 MiB), the Railway IaC definition, and durable PDF retention with an `EXPORT_ANALYTICS`-gated list/re-download/delete API plus paginated retained-report controls and four-language labels. Generation and deletion write audit events; creator/Team Leader deletion keeps metadata when storage deletion fails so it can be retried. Profile photo replacement marks older revisions superseded but retains their database records and stored objects under the PRD's indefinite retention rule. Failed database writes attempt compensating object deletion. Storage growth from retained revisions and retained PDF reports remains an operational consideration, now bounded by explicit operator/user deletion.
- The latest local Phase 8 gate has 82 passing tests across 16 files and migrations through `0015`, plus passing real-HTTP critical/security e2e suites and `railway config plan` with no drift. CI run `36318063179` passed. All three Railway deployments succeeded, bootstrap variables were removed, and the web service was redeployed. The public database health check, administrator login smoke, live desktop analytics shell checks, cron runs, and PDF/retention smoke are complete; the PostgreSQL, PITR, and private object-storage resources are provisioned in Railway production.
- The Railway web service is serving the deployed application. The `web` GitHub source is connected (`main`) and pinned in `.railway/railway.ts` with `railway config plan` reporting no drift; pushing `512b7ba` triggered a Railway GitHub deploy (`d8cc2e5e`, SUCCESS) with post-deploy `/api/health` 200 `database ok`. Daily/weekly volume-backup schedule setup via CLI still returns access-denied after a clean `railway logout` + `railway login` (scopes include `workspace:admin project:admin`) and `railway link`; relay-verified dashboard shows `No backup schedule` with `Creating backups and enabling PITR are only available for customers on the Pro plan`, so this needs a Pro upgrade (operator-owned). Point-in-time WAL replay into a disposable 5 GB service still fails with `[28] No space left on device` plus `recovery ended before configured recovery target was reached`; production Postgres was untouched. A separate on-demand backup restore drill succeeded (`70945d9f` into a fresh 5 GB volume, `Postgres` redeployed as `a8966e7a`, `/api/health` 200 `database ok`, restored reads 1 user, 0 `order_cases`, 16 migrations). Headless Chromium login-shell smoke passed at 1280px/390px/796px with zero console errors and only 4px overflow at 796px; unauthenticated export probes correctly return 401. Authenticated PICKER role smoke passed (`spx-a0auliipli8`/Tester: picker-only nav, workspace/notifications/profile, order lookup without errors, 403 on admin/analytics probes, clean logout, 0 overflow at 390px/796px, zero console errors). The temporary bootstrap preserve entries have been removed.
- Do not mark Phase 8 accepted until the complete test/type/lint/build/migration gate passes on the current tree, deployment succeeds, the health/readiness checks pass, and deployment/backup/restore/browser checks in the README are recorded.
