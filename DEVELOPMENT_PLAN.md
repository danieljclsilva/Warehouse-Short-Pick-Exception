# Development plan

The [product requirements](./Warehouse_Short_Pick_Exception%20_System.md) are the source of truth. The project is a modular Next.js application with PostgreSQL. Each phase is accepted only after its behavior, tests, type checking, linting, migrations, and known limitations have been reviewed.

| Phase | Scope | Status |
| --- | --- | --- |
| 1. Foundation | PostgreSQL, migrations, invite-only registration, PIN login, persistent revocable sessions, granular permissions, four-language base UI | Complete locally; deployment pending |
| 2. Core case workflow | One open case per order, lines, duplicate history, picker lists, events | Complete locally; deployment pending |
| 3. Checking and responsibility | Claim/assignment races, discovery, retrieval, staging, responsibility routing | Pending |
| 4. Operations | TL dashboard, manual cases, troubleshooter, messages, close/reopen | Pending |
| 5. Notifications | In-app notifications, preferences, Web Push | Pending |
| 6. Configuration | Editable values, immutable versions, case snapshots, audit | Pending |
| 7. Analytics and export | Filters, duplicate analysis, CSV, PDF | Pending |
| 8. Hardening | End-to-end tests, accessibility, performance, logging, security, deployment, backups | Pending |

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

## Known limitations

- Check tasks, staging, retrieval, closure, notifications, configuration, analytics, and Railway service deployment are later phases and are not yet implemented.
- The Team Leader duplicate-line override is enforced in the API; its management interface belongs to the later Team Leader operations phase.
- Local migration and integration checks used a disposable PostgreSQL instance; production database and web services have not been provisioned.
- Browser cookie retention caps can require a new login after a very long period without opening the app. Active sessions refresh their persistent HTTP-only cookie; server sessions have no time-based expiration.
- `npm audit --omit=dev` reports no production dependency advisories. The full audit reports four moderate advisories in Drizzle Kit's development-only dependency tree.
