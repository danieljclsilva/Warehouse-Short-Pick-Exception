# Verification of development since the Codex handoff

Reviewed 2026-10-03 against `main` at `f4fd2f8`, using the referenced Codex chat, PRD, field-feedback contracts, handoff, development plan, and changes since coordination commit `a02c9a3`. The initial checkout was clean. This is a code and local execution review, not a new production release or complete warehouse acceptance.

## Outcome

Substantial implementation landed, and the automated gates pass. Field feedback is not fully accepted: recovery controls are missing from the UI, and isolated reproductions expose state/routing and dashboard regressions that the current suite misses. Prioritize the findings below before treating Phase 8 or the recovery workflow as complete.

## Implemented work

- Check permissions/backfill, unlimited default capacity, FOUND_AT_ORIGINAL, and stable check cursors; migrations 0017–0019 are tracked.
- Closed-case reads and participant access, picker messages with closed-post rejection, ad hoc location reporting, replenishment state, coded line projections, bounded override and repair APIs.
- Exact-case notification routing to the native case surfaces, bulk read, completion/assignment timeline detail, responsibility badges, shared line cards and four-language strings.
- Per-reporter same-location counts and suppression below 20, per-user/role filtering, CSV/PDF additions, analytics charts and filters. Some chart series intentionally use bounded loaded rows rather than full-period aggregates.
- Manager role, Admin-only Manager creation/management, troubleshooter reporting, reversible order phase, pagination across multiple lists, and UI layout refinements.

These describe implementation presence, not unconditional acceptance of every edge case.

## Findings, ordered by priority

### 1. P1 — Recovery APIs have no user interface

`src/app/api/cases/[id]/override/route.ts` and `repair/route.ts` implement server commands, and translation keys exist, but no application component invokes either endpoint or renders its preview/reason/confirmation controls. Searching `src/components` for those endpoints and permissions finds no recovery flow. The user still cannot perform the promised safe Admin repair or granted leader override through the app. Warehouse issues 8 and 13 remain incomplete.

Implement permission-gated, localized controls with a reason and concrete preview, backed by the existing server authorization. An ordinary close hint does not expose these commands.

### 2. P1 — Phase repair can close a case without closing its work

`src/server/operations.ts:419–426`, `repairCase(CORRECT_PHASE)`, accepts CLOSED and updates only phase/physical fields. It bypasses the close command's line/check cleanup and does not set resolution metadata. The reverse correction also fails to clear closure metadata. The preview does not validate the affected work before displaying consequences.

Isolated PostgreSQL reproduction: create a PICKING case with an OPEN line and AVAILABLE check; call CORRECT_PHASE with CLOSED and a reason. Result: `phase=CLOSED`, `resolvedAt=null`, `lineState=OPEN`, `physicalState=WITH_PICKER`; the active check remains. The work disappears from open queues without becoming resolved, and resolution analytics cannot count it normally.

Restrict phase correction to compatible active phases or reuse the full guarded close/reopen transition. Validate physical placement and closure metadata together.

### 3. P1 — Staging loses FOUND_AT_ORIGINAL retrieval ownership

`src/server/case-progress.ts:60–65` looks up only checks completed with FOUND. A FOUND_AT_ORIGINAL line is FOUND with pending retrieval, so staging processes it but fails to find its checker and clears the owner.

Isolated reproduction with checker retrieval when staged enabled and an active checker holding CONFIRM_RETRIEVAL: a PICKING line has FOUND_AT_ORIGINAL plus picker-owned pending retrieval; stage it. Result: pending retrieval remains but `retrievalResponsibleUserId=null`. Include both found outcomes and apply the applicable routing/assignment policy consistently.

The reverse phase transition also warrants coverage: `updateCasePhase` returns an order to PICKING without recalculating existing retrieval assignments.

### 4. P2 — Completed replenishment still asks the user to replenish

`src/server/cases.ts:90–91` maps both WAITING and COMPLETED to REPLENISH/AWAITING_REPLENISHMENT whenever the main line is OPEN. `recordReplenishment` leaves that main state unchanged, so this is reachable through normal use.

Isolated reproduction: record COMPLETED on an OPEN line. Result: `replenishmentState=COMPLETED`, `state=OPEN`, `retrievalState=NOT_REQUIRED`, but the projection returns `nextActionCode=REPLENISH` and `blockingReasonCode=AWAITING_REPLENISHMENT`. The writer is hidden at COMPLETED, so the displayed next step cannot be performed. Derive an actionable next step for completed markers.

Documentation also contradicts the implementation: PRD §38 and the binding contracts require note, named retriever, and completion routing/notification; the later development log describes a state-only marker. Confirm the intended product behavior and synchronize the source of truth. The code defect in the next-step projection exists even under the state-only interpretation.

### 5. P2 — Dashboard headline counters describe different populations

`src/server/operations.ts:97–107` returns global open-case and resolved-today totals, while open short picks, checking, staged, over-threshold, and summary open lines derive only from the current page. The UI displays these as dashboard headline metrics without a page-scope qualification.

Isolated reproduction with two open cases and pageSize=1: both pages report `openCases=2`; page 1 reports `openLines=2, staged=1`, while page 2 reports `openLines=1, staged=0`. Pagination changes apparent warehouse workload. Compute aggregate metrics independently of the displayed page, using each case's configuration snapshot for threshold classification. Clarify whether “short picks” counts lines or missing units.

### 6. P2 — Historical completion locations can change after repair

`src/server/checks.ts` writes CHECK_COMPLETED with code/task/note, without capturing location on that event. `src/server/cases.ts:172–175` fills absent completion locations from the line's current original/discovered location. A later location correction therefore changes the location displayed beside an earlier check completion. Companion events retain some historical context, but this completion row presents current data as the original result.

Capture locations with completion events and use immutable historical evidence for older rows; show a sparse fallback when that evidence is unavailable. Do not infer an earlier location from the current line.

Isolated reproduction: a FOUND_AT_ORIGINAL completion is recorded for A1; CORRECT_LOCATION changes the line to A2. Reading the case then displays A2 on the earlier CHECK_COMPLETED row.

## Verification performed

| Check | Result |
| --- | --- |
| Full Vitest suite using guarded local test environment | 241 tests / 37 files passed |
| TypeScript | Passed |
| ESLint | Passed |
| Drizzle migration consistency | Passed using guarded test environment |
| Next production build | Passed using test environment |
| Critical workflow HTTP/database E2E | Passed, including concurrent claim 200/409 |
| Security acceptance HTTP/database E2E | Passed |
| Fresh migrations 0000–0019 | Passed on dedicated disposable review database and E2E databases |
| Pre-0017 upgrade proof | Passed existing script on dedicated disposable review database |
| Backup runner and restore safety suites | Passed |
| Targeted state/projection/history reproductions | Findings 2–6 reproduced on a dedicated disposable PostgreSQL database |

The direct `npm run db:check` initially refused to run because DATABASE_URL was absent. Rerunning through `scripts/with-test-env.sh` passed. Test secrets/credentials were not printed. Review databases were dropped after execution. Application code was not changed and no deployment was performed.

## Acceptance and evidence limits

- No fresh browser/visual QA was performed in this review; the HTTP E2E runners explicitly do not use browser automation. Static rendering tests do not prove browser interaction behavior.
- Real iPhone Safari/installed-PWA double scans remain unverified. The development log records an operator waiver; this review does not turn that into device proof.
- Live deployment IDs and health claims in the log were not independently checked against Railway or production in this review.
- The handoff and early phase/status tables are historical and partly stale. Sections still labelled “uncommitted” now describe committed changes. Record current acceptance separately from earlier release claims.
- Regression tests should cover the demonstrated findings when fixes are implemented. Passing the existing suite is not evidence that these cases work.
