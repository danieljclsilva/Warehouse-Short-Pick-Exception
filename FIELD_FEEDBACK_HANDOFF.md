# Warehouse field feedback handoff

Updated: 2026-09-28. This is a continuation note for the approved sixteen-item warehouse feedback project. The product source of truth is `Warehouse_Short_Pick_Exception _System.md`; the binding change contracts and work boundaries are in `FIELD_FEEDBACK_CONTRACTS.md` and `WAREHOUSE_FEEDBACK_IMPLEMENTATION_PLAN.md`. Phase 8 in `DEVELOPMENT_PLAN.md` remains open.

## Coordination and ownership

- **OMP oversees implementation and its scoped agents.** Use the approved wave sequence and file ownership table in `WAREHOUSE_FEEDBACK_IMPLEMENTATION_PLAN.md`. Prefer Muse Spark or another inexpensive model for bounded edits; escalate only for a concrete hard problem. OMP must review each agent's diff, run the stated gates, and deliver a commit or an explicit list of unfinished files. Agents share a filesystem and must preserve each other's changes.
- **Codex verifies and releases.** Review OMP's committed slices, run integration and browser checks, update phase evidence, and deploy to the test environment after gates pass. Do not deploy these field-feedback changes to production until the warehouse acceptance criteria, including real iPhone scanning, are met. A Sol review is reserved for migration, permission, transition, or admin-recovery risks that tests and ordinary review do not settle.
- Keep feature branches isolated. Do not overwrite or archive the uncommitted domain worktree. Do not push or merge to `main` as a handoff step.

## Exact repository state

The main checkout `/Users/komorinokage/Developer/ShortPickException` is clean on `codex/field-feedback` at `a02c9a3`. It contains the approved plan and Wave 0 contracts, the notification slice, and the iOS scanner fallback. No field-feedback deployment has been made.

| Worktree | Branch | State |
| --- | --- | --- |
| Main checkout | `codex/field-feedback` | Clean; coordination branch at `a02c9a3` |
| `.codex/worktrees/field-contracts/ShortPickException` | `codex/field-i18n-notifications` | Clean; notification localization commit `dc9d773`, already merged |
| `.codex/worktrees/field-ios-scanner/ShortPickException` | `codex/field-ios-scanner` | Clean; scanner commit `30d79c9`, already merged |
| `.codex/worktrees/field-domain/ShortPickException` | `codex/field-domain` | **Uncommitted A1 domain edits and migration; preserve** |

The domain worktree is based on Wave 0 commit `997f342`. It edits `src/domain/permissions.ts`, `src/db/schema.ts`, `src/server/checks.ts`, `src/server/configuration.ts`, `src/app/api/checks/route.ts`, their tests, and the new `drizzle/0017_foamy_anita_blake.sql` plus snapshot/journal. It has not been merged. Inspect `git status` there before continuing.

## Delivered slices and limits

- Notifications: recipient-scoped, idempotent mark-all-read API and localized UI; callback now passes case and optional line IDs. The app shell still discards that callback target. Exact case navigation, refresh, and closed-case reads are unfinished.
- Scanner: lazy ZXing camera fallback for browsers without native `BarcodeDetector`, with photo fallback and cleanup. Build, typecheck, lint, `npm ci`, and focused normalization tests passed on the coordination branch. Component race tests and real iPhone Safari/PWA checks with warehouse barcodes remain. Do not count issue 7 as accepted.
- Domain A1, uncommitted: permission defaults/backfill, `FOUND_AT_ORIGINAL`, current operational check capacity, cursor pagination, and tracked migration. OMP reported focused 27 tests, `db:check`, fresh disposable migration, typecheck, and lint passing. Its full suite has one stale expectation in `tests/operations.integration.test.ts`: Picker message visibility changed under the new default. Re-run every gate after fixes and before merging; these reports do not establish acceptance.

## Immediate OMP review and repair queue

1. **Fix-first review:** `src/server/checks.ts` currently uses live configuration for `ALLOWED_RESOLUTION_CODES` and checker retrieval routing during completion. Historical cases must use their case snapshot for those workflow settings; only claim/capacity controls use current operational configuration. Add a test with an old case and changed current settings.
2. **Fix-first review:** check pagination orders PostgreSQL microsecond `created_at` values but encodes cursors with millisecond JavaScript dates. Preserve matching precision or use an ordering scheme that cannot skip rows sharing a millisecond. Add a page-boundary fixture. The existing 105-row test must fetch page 3 and verify all IDs, with no duplicates.
3. **Fix-first review:** prove migration 0017 on a pre-0017 database. Test revoked check grants restored by the required unconditional backfill, a later revoke persisting, cap `1` becoming `null`, and existing caps `2–100`/`null` remaining unchanged. Fresh migration proof alone is insufficient.
4. Fix the stale operations test to assert the intended Picker read access while retaining the restriction on posting to a case for which they are not responsible. Make the configuration test prove current claim capacity is used while historical snapshots remain intact. Review transaction boundaries, concurrency, and server authorization; preserve the Admin-only `OVERRIDE_CASE_STATE` default.
5. Run full tests, typecheck, lint, build in a proper worktree dependency setup, `db:check`, and fresh plus upgrade migration proofs. Commit the A1 work in `codex/field-domain`; then Codex can review and merge it into `codex/field-feedback`.
6. Continue domain A2/A3 in the same owned server/schema files: closed-case access and Picker history, notes, ad hoc location and replenishment; then bounded override/admin repair and typed case/line projections. Follow the plan's UI/analytics/integration ownership and ordering. OMP reviews every slice before handing it to Codex.
7. Integration owner wires case deep links, permissions UI, four-language strings, and final browser checks. Update `DEVELOPMENT_PLAN.md` after each accepted slice. Deploy to TEST only when the relevant gates pass; keep production separate.

The previously approved decisions are recorded in the contracts: all five roles receive line-check view/claim/complete defaults and existing users get an unconditional grant backfill; manual replenishment has actor, note, and retriever; same-location-found uses the agreed conclusive-outcome denominator and suppresses percentages below 20 observations. New permissions remain configurable within their role allowlists.

## Release evidence still required

- Exact notification URL opens its case, including closed cases, after direct navigation and reload.
- Real iPhone Safari and installed PWA scan the warehouse barcode twice in succession; verify camera and photo fallback and cleanup.
- State transitions, override/repair, messages, location/replenishment, responsibility, and timeline satisfy the contract acceptance matrix and preserve audit events atomically.
- Role/server authorization and four-language presentation; full test/type/lint/build/migration gates; populated TEST visual QA. Record any unresolved limitation in `DEVELOPMENT_PLAN.md`.
