# Warehouse Short Pick Exception System

Internal web application for reporting and resolving warehouse short-pick exceptions. The full behavior is defined in the [product requirements](./Warehouse_Short_Pick_Exception%20_System.md); implementation progress is in [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md).

## Current implementation status

Phases 1–6 are complete locally. The Phase 6 verification passed 43 tests across eight files on a fresh PostgreSQL database with migrations `0000` through `0011`, database checks, type checking, linting, production build, and responsive browser checks. The configuration panel uses 17 versioned operational keys, preserves case configuration snapshots, shows immutable audit history, and reports stale-version conflicts. Analytics, hardening, and Railway deployment remain pending.

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

Team Leaders, Admins, and permitted Assistants can edit the versioned operational configuration from the Configuration workspace when their permissions allow it. The panel covers workflow limits, timing thresholds, invitation defaults (8-hour expiry by default), login lockout policy, warehouse location naming, resolution codes, manual case creation, Assistant configuration access, and push enablement. Each save creates a new immutable version and audit entry; new cases keep the version captured at creation, while existing cases retain their historical behavior. Login lockout settings are managed by the active database configuration version; the old environment variable names are legacy and do not control runtime behavior.

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

## Railway deployment

Create a Railway web service from this private GitHub repository and add a Railway PostgreSQL service. Set `DATABASE_URL` from the PostgreSQL service, `APP_URL` to the public HTTPS origin, and stable Web Push variables `PUSH_PUBLIC_KEY`, `PUSH_PRIVATE_KEY`, and `PUSH_SUBJECT` described in `.env.example`. Login lockout policy is stored in the versioned database configuration; do not set the legacy `LOGIN_MAX_FAILED_ATTEMPTS` or `LOGIN_LOCKOUT_MINUTES` variables. Run tracked migrations before serving traffic. Set the liveness check path to `/health`; `/api/health` separately checks database readiness.

Phase 8 deployment must also provision separate periodic jobs for `npm run notifications:emit` and `npm run push:deliver`. The first emits threshold based monitoring notifications; the second delivers queued browser push notifications with retry handling. In-app notification operation does not depend on either job. Live VAPID delivery remains deployment QA until HTTPS, Railway variables, and both schedules are configured.

The Railway project has been created as `warehouse-short-pick-exception`; web and database services are not provisioned yet.

The later profile-photo and report features will need persistent object storage; Railway's ephemeral application filesystem is not suitable for uploads. Do not add storage credentials until those features are implemented. Keep secrets in Railway variables, never in Git.
