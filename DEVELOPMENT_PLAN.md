# Development plan

The [product requirements](./Warehouse_Short_Pick_Exception%20_System.md) are the source of truth. The project is a modular Next.js application with PostgreSQL. Each phase is accepted only after its behavior, tests, type checking, linting, migrations, and known limitations have been reviewed.

| Phase | Scope | Status |
| --- | --- | --- |
| 1. Foundation | PostgreSQL, migrations, invite-only registration, PIN login, persistent revocable sessions, granular permissions, four-language base UI | Complete locally; deployment pending |
| 2. Core case workflow | One open case per order, lines, duplicate history, picker lists, events | Complete locally; deployment pending |
| 3. Checking and responsibility | Claim/assignment races, discovery, retrieval, staging, responsibility routing | Complete locally; deployment pending |
| 4. Operations | TL dashboard, manual cases, troubleshooter, messages, close/reopen | Complete locally; deployment pending |
| 5. Notifications | In-app notifications, preferences, Web Push | Complete locally; deployment pending |
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

## Known limitations

- Editable configuration UI, analytics, and Railway service deployment remain later work. Check capacity is configurable through an authorized API; the broader settings interface belongs to Phase 6.
- Web Push deployment requires HTTPS plus stable `PUSH_PUBLIC_KEY`, `PUSH_PRIVATE_KEY`, and `PUSH_SUBJECT` Railway variables. Live push delivery remains deployment QA; local acceptance covered the configured and unavailable states, while in-app notifications work without push.
- Railway Phase 8 must schedule `npm run notifications:emit` for unresolved-case monitoring and `npm run push:deliver` for queued Web Push delivery. These periodic jobs are separate from the web service and are not yet provisioned.
- The Team Leader duplicate-line override is enforced in the API; its management interface belongs to the later Team Leader operations phase.
- Local migration and integration checks used a disposable PostgreSQL instance; production database and web services have not been provisioned.
- Browser cookie retention caps can require a new login after a very long period without opening the app. Active sessions refresh their persistent HTTP-only cookie; server sessions have no time-based expiration.
- `npm audit --omit=dev` reports no production dependency advisories. The full audit reports four moderate advisories in Drizzle Kit's development-only dependency tree.
