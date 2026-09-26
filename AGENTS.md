<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project rules

- Read `Warehouse_Short_Pick_Exception _System.md` as the product source of truth. Implement its build phases in order. Record progress and known limitations in `DEVELOPMENT_PLAN.md` after each phase.
- This is an independent short-pick exception system. Do not introduce Odoo integration, warehouse stock mutation, AI features, or general chat.
- Use strict TypeScript. Keep permission names and state enums centralized. Enforce permissions, state transitions, and validation on the server; frontend visibility alone is never an authorization check.
- Make consequential state changes and their immutable audit events in the same database transaction. Use database constraints or transactions for uniqueness and concurrency invariants.
- Add a tracked migration for every schema change. Never require manual production database changes.
- Never commit secrets, real PINs, session tokens, invitation tokens, production data, or uploads. Add each required environment variable to `.env.example` and document it.
- Sessions have no automatic time expiry under the PRD. Revocation and disabled or archived accounts must still invalidate access.
- Keep user-facing text in translation dictionaries with English fallback and English, Dutch, Polish, and Spanish language support. Do not translate order numbers, locations, or SKUs.
- At the end of each phase, run tests, type checking, linting, verify migrations, and document known limitations. Do not claim later-phase features are complete before their acceptance conditions are met.
