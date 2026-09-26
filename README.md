# Warehouse Short Pick Exception System

Internal web application for reporting and resolving warehouse short-pick exceptions. The full behavior is defined in the [product requirements](./Warehouse_Short_Pick_Exception%20_System.md); implementation progress is in [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md).

## Local setup

Requirements: Node.js, npm, and PostgreSQL.

1. Copy `.env.example` to `.env` and set `DATABASE_URL` and `APP_URL` for your machine.
2. Create the `short_pick_exception` PostgreSQL database, or change `DATABASE_URL` to an existing empty development database.
3. Run `npm ci`.
4. Run `npm run db:migrate`.
5. Set `ADMIN_DISPLAY_NAME`, `ADMIN_IDENTIFIER`, and `ADMIN_PIN` temporarily in `.env`, then run `npm run seed:admin` to create the first administrator. `ADMIN_PIN` must be numeric with at least six digits. Remove these seed variables from `.env` after bootstrap.
6. Run `npm run dev` and open the URL in `APP_URL`.

The application has no public self-registration. An administrator must create an invitation before another person can register.

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

Create a Railway web service from this private GitHub repository and add a Railway PostgreSQL service. Set `DATABASE_URL` from the PostgreSQL service, `APP_URL` to the public HTTPS origin, and the authentication policy variables described in `.env.example`. Run tracked migrations before serving traffic. Set the liveness check path to `/health`; `/api/health` separately checks database readiness.

The Railway project has been created as `warehouse-short-pick-exception`; web and database services are not provisioned yet.

The later profile-photo and report features will need persistent object storage; Railway's ephemeral application filesystem is not suitable for uploads. Do not add storage credentials until those features are implemented. Keep secrets in Railway variables, never in Git.
