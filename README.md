# Warehouse Short Pick Exception

A mobile-friendly web application for reporting and resolving warehouse short-pick exceptions. Track missing items, assign checks and retrievals, monitor progress, and export analytics.

- Permission-based workflows with immutable case history and audit events.
- Invitation-only accounts, in-app notifications, and optional browser push.
- CSV/PDF reports and optional private object storage for reports and profile photos.
- English, Dutch, Polish, and Spanish; light and dark themes.

Built with Next.js, React, TypeScript, PostgreSQL, and Drizzle ORM. The system operates independently of warehouse inventory software and does not modify stock.

## Local development

Use Node.js 22, npm, and PostgreSQL. Work with a local development database.

1. Copy `.env.example` to `.env`. Set `DATABASE_URL` and `APP_URL` for your machine, and create the database named in `DATABASE_URL`.
2. Install dependencies and apply the tracked migrations:

   ```sh
   npm ci
   npm run db:migrate
   ```

3. Temporarily set `ADMIN_DISPLAY_NAME`, `ADMIN_IDENTIFIER`, and a unique numeric `ADMIN_PIN` of at least six digits in your shell, then run `npm run seed:admin`. The bootstrap command requires an empty user table. Remove those variables afterward.
4. Run `npm run dev` and open the local address configured in `APP_URL`.

An administrator creates invitations for additional users. Environment variables for optional storage, push notifications, backups, and administrator recovery are documented in [`.env.example`](./.env.example).

To enable the optional external error-log handoff, set `NEXT_PUBLIC_ERROR_LOG_URL` before building. The destination receives order numbers, locations, SKUs, a case identifier, and the signed-in user’s display name as `by`. This is the person opening the error log, who may differ from the original reporter. Leave it blank to disable the handoff. This URL is public browser configuration; never include credentials or secret query parameters.

## Checks

Create a separate, ignored `.env.test` with `DATABASE_URL` pointing to a disposable local PostgreSQL database whose name ends in `_test`. Tests write data; use a database dedicated to testing. The wrapper rejects remote URLs, query parameters, and restore/fixture database names.

```sh
npm run db:migrate:test
npm test
npm run typecheck
npm run lint
npm run build
npm run db:check
```

`db:check` uses `.env`; test commands use `.env.test`. CI also runs backup, lifecycle-script, end-to-end, and secret-scanning checks.

## Fork collaboration

Treat this upstream repository's `main` as the shared source of truth. Fork owners should sync their `main` before starting work, create a feature branch, and open a pull request back to upstream. Enable maintainer edits when collaborators should be able to update that PR branch.

After the upstream PR merges, the fork owner can use GitHub's **Sync fork → Update branch**. When incorporating commits already made on a fork's `main`, preserve their original commit IDs with a merge commit so that fork can fast-forward afterward. Do not force-sync away unmerged work; incorporate those commits first. Repository owners still control write access to their own forks.

## Public repository safety

Keep credentials, real PINs, session and invitation tokens, uploads, database dumps, and production data outside Git. Use synthetic fixtures for tests and a secret store for deployed credentials. Values prefixed with `NEXT_PUBLIC_` are visible in browser bundles.

If a credential is exposed, revoke or rotate it promptly; deleting a file does not remove earlier Git history. See the [repository audit](./docs/PUBLIC_REPOSITORY_AUDIT.md) for scope, findings, and remaining actions.

## Documentation and status

The [product requirements](./Warehouse_Short_Pick_Exception%20_System.md) define behavior. [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md) records implementation and known limitations. Phases 1–7 are implemented; Phase 8 production acceptance remains incomplete, including outstanding backup retention and recovery verification. Historical deployment records are not a statement of current service health.
