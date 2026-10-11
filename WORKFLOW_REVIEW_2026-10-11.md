# Workflow, badges, and notifications review — 2026-10-11

Reviewed application source at `b966294` against the product requirements, especially §§29–39, 45A, 48–54. The interactive map accompanies this chat and covers 30 actions across 13 scenario paths plus an all-actions catalog. Its labels describe the default configuration, with configuration exceptions identified in each action. This is an inspection, not acceptance of a new build phase or a production release.

## Picker assignment verification

Picker check assignments **do create mandatory in-app notifications**. `assignCheck` accepts an active target with `COMPLETE_CHECK`, without excluding the Picker role, and inserts `RESPONSIBILITY_CHECK_ASSIGNED` within the assignment transaction. Monitoring preferences do not suppress it. The assignment UI also filters on active status and `COMPLETE_CHECK`, rather than excluding pickers.

The same transaction queues a push per enabled device subscription when current `PUSH_ENABLED` is true and `PUSH_PUBLIC_KEY`, `PUSH_PRIVATE_KEY`, and `PUSH_SUBJECT` exist. Actual receipt also requires a running push worker and browser/device notification permission. The worker retries transient failures and disables expired subscriptions; it does not remove the in-app alert.

A new PostgreSQL integration test in `tests/notifications.integration.test.ts` exercises the actual assignment route and notification API: an assigned Picker receives one unread in-app alert with the correct case/line/task; two enabled device subscriptions receive two queued pushes; a disabled subscription receives none; reassignment to an unsubscribed Picker still creates the mandatory in-app alert without a push row. VAPID keys are generated for the test and restored afterward; no real push is sent. Existing push integration tests exercise delivery with a mocked provider, and existing UI routing tests confirm a picker opens check alerts on Assignments.

**Production/device receipt was not verified.** Push click navigation also has a separate gap: the service worker supplies a notification ID, but the app does not consume it to open the exact case automatically.

## Source-confirmed gaps

| ID | Behavior in current code | Required behavior / consequence | Evidence |
| --- | --- | --- | --- |
| F1 | Replenishment saves only state, actor, and timestamp; notes/retriever are null. Completion creates no retrieval obligation or notification. | §39 requires note/named retriever and completion routing plus alert. | `src/server/case-progress.ts:171`; `src/components/replenishment-form.tsx:29` |
| F2 | OPEN lines with either WAITING or COMPLETED replenishment project REPLENISH / AWAITING_REPLENISHMENT. | Completed progress must not still instruct replenishment. | `src/server/cases.ts:90` |
| F3 | Staging looks only for a completed FOUND check when selecting retrieval owner. | FOUND_AT_ORIGINAL is missed; staging can clear the picker owner without finding a replacement. | `src/server/case-progress.ts:69` |
| F4 | Completion after staging prefers an assigned case Troubleshooter; staging after completion picks a FOUND checker only. External discovery uses a third formula. | §37 requires deterministic routing under either event order; locks alone do not make these formulas converge. | `src/server/checks.ts:233`; `src/server/checks.ts:282`; `src/server/case-progress.ts:64` |
| F5 | External location reporting silently completes the current check and notifies only retrieval owner/monitors. | §49 also requires an informational alert to the displaced checker. | `src/server/checks.ts:216` |
| F6 | Dashboard card/drawer and Checks header select the first line's badge. Checks header does not prioritize CLOSED phase. | A done first line can mask unresolved sibling lines; Ready to close is not reflected by these headers. Aggregate precedence needs agreement. | `src/components/operations-dashboard.tsx:472`; `src/components/operations-dashboard.tsx:499`; `src/components/check-workflow.tsx:330` |
| F7 | Original-location display status is returned before inspecting retrieval failure; retry badge override omits FOUND_AT_ORIGINAL. | Failed original-location retrieval still displays Ready to retrieve instead of Retry retrieval. | `src/server/cases.ts:65`; `src/components/case-status-badge.tsx:79` |
| F8 | Mark-one-read and Open case recalculate unread count from the loaded 50-row notification page. | Global unread count becomes page-scoped until polling refreshes. Example: 80 unread → mark one on full page → 49 displayed instead of 79. | `src/components/notification-center.tsx:224`; `src/components/notification-center.tsx:266` |
| F9 | Return-to-picking changes phase/placement without updating pending retrieval owners or alerts. | Existing staged retrieval ownership can conflict with the default picking rule. | `src/server/case-progress.ts:92` |
| F10 | Dashboard mixes global open-case/resolved-today totals with current-page checking/staged/attention/line totals; openShortPicks sums quantity. | §53 calls for a separate global summary and distinction between open lines and missing pieces. | `src/server/operations.ts:29`; `src/server/operations.ts:97`; `src/server/cases.ts:135` |
| F11 | Staging alerts only changed retrieval owners on already FOUND lines. | §38 says relevant checkers/resolvers must learn that the box is staged; ongoing checkers receive nothing. | `src/server/case-progress.ts:49` |
| F12 | Override REDERIVE_RETRIEVAL_ROUTING changes ownership but inserts no responsibility notification. | Newly responsible worker receives no in-app alert or queued push for this handoff. | `src/server/operations.ts:370` |
| F13 | Push titles/bodies are English literals. | §14 requires dictionaries with English fallback and EN/NL/PL/ES support. | `src/server/push.ts:137` |
| F14 | Push click opens notification center with `notification=<id>`, but neither AuthApp nor NotificationCenter consumes the ID. | Exact case/line navigation needs a second manual Open case action; inconsistent with §52A exact-case intent. | `public/sw.js:34`; `src/components/auth-app.tsx:569`; `src/components/notification-center.tsx:363` |

These findings are established by source paths. The new runtime test establishes picker assignment persistence/queueing specifically; this review does not claim new end-to-end reproductions for every gap.

## Workflow decisions to settle

- D1: Should optional New short pick notifications trigger on every added shortage or only on initial case creation? Currently only creation emits them.
- D2: After NOT_FOUND, WRONG_LOCATION, or OTHER, should the system create another check, escalate, or explicitly ask a manager to act? Currently the line returns OPEN with a completed task, no replacement task, and a CLAIM_CHECK next-action DTO. Requesting another check requires ASSIGN_CHECK.
- D3: Should transferring a staged case to a new resolver also transfer existing pending retrievals? Currently case and line ownership remain separate and only the case owner is alerted.
- D4: Should completed or reassigned task alerts remain unread historical alerts, be annotated as obsolete, or be cleared? Currently completion/reassignment never reads or withdraws prior alerts. The unread badge measures unread history, not outstanding work.

## Other behavior captured by the map

- Found stock never implies physical retrieval. Retrieval confirmation resolves the line, then case closure is explicit.
- Replenishment is independent of main line state; its badge persists without reading alerts.
- Negative check outcomes preserve an unresolved shortage; no automatic escalation notification exists.
- RETRIEVING / IN_PROGRESS are persisted enum options without a normal start-retrieval action; RESOLUTION is inferred rather than persisted, which the PRD permits.
- Navigation unread counts poll every 15 seconds; workflow data polls every 5 seconds while active/visible/online. Reading alerts does not advance workflow.
- Default case attention badges use 5/10/15-minute thresholds. Unresolved notifications default to a separate personal 10-minute threshold and require the emitter to run.
- Unresolved monitoring dedupe is per recipient/case/threshold and survives reopening; repeated alerts per reopen cycle are not implemented.
- Ordinary close emits optional CASE_RESOLVED; override/repair close paths do not. Admin CORRECT_PHASE can also set CLOSED without terminalizing lines/tasks or setting resolution metadata, as already recorded in the earlier verification report. Dedicated override/repair UI remains absent.

## Verification

- 37 existing focused badge, polling, and notification-routing tests passed.
- 17 PostgreSQL notification/push tests passed, including the new picker assignment test; provider delivery is mocked.
- Type checking, linting, and guarded `drizzle-kit check` passed. No schema change or migration was needed.
- Browser verification checked all 30 action selections, the 18 finding/decision entries, finding-to-action navigation, and all three tabs at 736px and 320px. No script errors or horizontal overflow remained.
- Application workflow behavior and deployment were not modified. The tracked changes are this review, development-plan progress, and the targeted regression test.

## Implemented corrections — 2026-10-11

The findings and Verification section above describe the original audit at b966294. They are preserved as history. The subsequent working-tree implementation fixes F1–F14 and applies D1–D4: unified retrieval routing, replenishment notes/named owners and physical obligations, staging/external-resolution alerts, aggregate badges, global metrics/counts, localized push, and recipient-scoped exact notification navigation. Admin phase correction can no longer bypass explicit closure/reopening. Picker assignment still inserts its mandatory unread alert and enabled-device push queues.

Implementation contracts, per-finding test mapping and migration/release instructions are in [WORKFLOW_CORRECTIONS_IMPLEMENTATION.md](./WORKFLOW_CORRECTIONS_IMPLEMENTATION.md). Migrations 0020/0021 were verified fresh and from a seeded 0019 baseline, including backfill idempotence. Final independent application acceptance: 402 tests, typecheck, lint, build, Drizzle check and critical/security HTTP E2E pass. Browser verification covers global unread count, second-page push opening, closed/foreign targets, original location and actual named replenishment owner, retained notes, and manager follow-up.

Physical-device push receipt and production operational acceptance are unverified. Ordinary close monitoring and unresolved-alert dedupe retain the previously documented semantics. Nothing was committed, deployed, or sent through a real push provider.

## Troubleshooter follow-up — 2026-10-11

OMP implemented the missing default RECORD_REPLENISHMENT grant (T1) and assigned-case My Work visibility (T2). Troubleshooters retain every Picker default plus REPORT_NEW_LOCATION and RECORD_REPLENISHMENT. Existing stored/custom grants remain intact. Case responsibility changes preserve the original reporting Picker, and assigned case/check notifications create mandatory unread internal alerts and enabled-device push queues.

Independent review separated VIEW_OWN_CASES access from VIEW_CASE_MESSAGES disclosure, recognized pending/failed Completed replenishment responsibility, and restored the shared My Work retrieval control for Completed obligations. Both roles can fail, retry and confirm physical retrieval before explicit closure. Resolver-only users cannot add shortages to another Picker's case. Five Troubleshooter branches are now available in the visualization. Full contracts and existing-account instructions are in WORKFLOW_CORRECTIONS_IMPLEMENTATION.md.

### Follow-up verification

- Fresh disposable PostgreSQL database: **57 test files, 406 tests passed**, including default grants, assignment internal alerts/device queues, assigned My Work visibility, permission revocation, message redaction, completed replenishment responsibility, retrieval failure/retry and closure.
- Type checking, linting, production build and Drizzle schema consistency pass. Critical HTTP A–F and security acceptance pass. No schema change or additional migration in this follow-up.
- Chrome desktop/mobile QA passes for assigned Troubleshooter work, original-picker-only shortage controls, replenishment notes/named handoff, retrieval retry, closure, preserved original picker and closed read-only views; no runtime errors or horizontal overflow.
- Interactive map: 33 actions in original/corrected modes, 19 paths and 20 findings/decisions checked at 736px and 320px without runtime errors or overflow.
- Assignment push verification covers queued enabled-device delivery and mocked provider behavior; physical-device receipt remains unverified. Existing custom grants are preserved, so review existing Troubleshooter accounts for RECORD_REPLENISHMENT. Phase 8 operational/device acceptance remains open. No commit, push or deployment performed.
