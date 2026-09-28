# Field Feedback Contracts (Wave 0)

Status: **contract only, 2026-09-28**. No feature implementation claimed.
Source of truth: `Warehouse_Short_Pick_Exception _System.md` (as amended 2026-09-28).
Scope: sixteen warehouse feedback themes. Non-goals unchanged: no Odoo, no stock mutation, no AI, no general chat.

Downstream agents MUST implement exactly these contracts. If a required edit crosses the owner's file allowlist in `WAREHOUSE_FEEDBACK_IMPLEMENTATION_PLAN.md`, stop and return a proposed patch.

## 1. Permission contract

Central registry: `src/domain/permissions.ts`. Every new privilege is a named constant, server-enforced, individually grantable/revocable.

```text
OVERRIDE_CASE_STATE      # bounded stuck-state override commands; default Admin only, grantable to Team Leader
RECORD_REPLENISHMENT     # mark replenishment waiting/completed; default Troubleshooter, Assistant, Team Leader, Admin; Picker by explicit grant
REPAIR_CASE_DATA         # execute admin repair commands (state-breaking steps additionally require OVERRIDE_CASE_STATE); default Admin only
REPORT_NEW_LOCATION      # ad hoc location without owning check; default Troubleshooter, Assistant, Team Leader, Admin; Picker by explicit grant
```
Grants are individually configurable per user within these bounds: `OVERRIDE_CASE_STATE` may be granted only to Admin or Team Leader; `REPAIR_CASE_DATA` only to Admin; `RECORD_REPLENISHMENT` and `REPORT_NEW_LOCATION` may be granted to any role including Picker. Any default may be revoked per user.

Default preset change (all five roles):

```text
VIEW_AVAILABLE_CHECKS, CLAIM_CHECK, COMPLETE_CHECK → Picker, Troubleshooter, Assistant, Team Leader, Admin
```

Backfill rule (one tracked migration + upgrade-path test):

- Unconditionally grant the three check permissions to **all existing users**, including users who previously lacked them or had them revoked.
- Grants remain editable afterward; later revoke per user is allowed.
- Picker case-note grants (`ADD_CASE_MESSAGE`, `VIEW_CASE_MESSAGES`) reach existing and new pickers under the same migration.
- `REPORT_NEW_LOCATION` stays separate: Troubleshooter/Assistant/Team Leader/Admin preset; Picker only by explicit grant. Completing one's own claimed check with a found outcome requires `COMPLETE_CHECK` only, never the ad hoc grant.

Server rule: a claimed check MUST be finishable by its owner — `COMPLETE_CHECK` authorizes recording any check result, including a found location. Frontend queue/claim controls render if and only if the server grants say so; visibility is never authorization.

## 2. Status projection contract (server-owned)

Keep durable `case.phase` (`PICKING/STAGED/CLOSED`), line `state`, check status, and retrieval state separate. Add a typed read projection; do not overload phase.

```ts
type NextActionCode =
  | "CLAIM_CHECK" | "COMPLETE_CHECK" | "RETRIEVE" | "STAGE_ORDER"
  | "REPLENISH" | "RESOLVE" | "WAIT" | "NONE";
type BlockingReasonCode =
  | "CAPACITY_REACHED" | "CHECK_CLAIMED" | "AWAITING_RETRIEVAL"
  | "AWAITING_REPLENISHMENT" | "CASE_CLOSED" | null;
type LineProjection = {
  lineId: string; caseId: string; orderNumber: string;
  displayStatus: "OPEN" | "CHECKING" | "FOUND" | "FOUND_AT_ORIGINAL"
    | "WAITING_RETRIEVAL" | "RETRIEVING" | "RETRIEVED"
    | "NOT_FOUND" | "WRONG_LOCATION" | "TROUBLESHOOTING" | "RESOLVED" | "CANCELLED";
  originalLocation: string; knownNewLocation: string | null; // null renders "none known"
  reporterUserId: string; reporterName: string;
  checkerUserId: string | null; checkerName: string | null;
  retrieverUserId: string | null; retrieverName: string | null;
  replenishment: { state: "NONE" | "WAITING" | "COMPLETED"; note: string | null; actorName: string | null; at: string | null };
  nextActionCode: NextActionCode; nextActionParams: Record<string, string>;
  actionOwnerUserId: string | null; actionOwnerName: string | null;
  blockingReasonCode: BlockingReasonCode;
};
type CaseProjection = {
  caseId: string; orderNumber: string; phase: "PICKING" | "STAGED" | "CLOSED";
  openLineCount: number; lines: LineProjection[]; // ALL lines, open + terminal; closed detail needs every line
};
type DashboardSummary = {
  openCases: number; openLines: number; checking: number; staged: number; overThreshold: number; resolvedToday: number;
}; // separate endpoint/response from CaseProjection; never embedded in it
```

Rules:

- Server DTOs carry stable codes + typed params/owner IDs only; all user-facing wording renders client-side from the four-language dictionaries (English fallback). `nextAction`/`blockingReason` free-text strings MUST NOT appear in any server DTO.
- `displayStatus` never encodes replenishment: the `replenishment.state` dimension (`NONE`/`WAITING`/`COMPLETED`, persisted per line) renders as a separate badge. `WAITING` allowed from `NONE` only; `COMPLETED` allowed from `WAITING` (or directly from `NONE` when no wait was recorded).
- Waiting/completed each persist `replenishment_state` on the line + event with authorized actor, timestamp, note, named retriever, without changing the line's main state. Completed routes retrieval task + notification to the named user via existing PICKING/STAGED routing rules.
- Badge and next action stay visible on the open case even when notifications are read.
- Check screens and dashboard consume the same projection; three divergent label derivations are removed.

## 3. Found-at-original + same-location-found metric

New conclusive check outcome `FOUND_AT_ORIGINAL` (alongside `FOUND` / `NOT_FOUND` / `WRONG_LOCATION`; `OTHER` stays non-conclusive):

- Records original location + verifier, preserves reporting picker, leaves `discovered_location` NULL (no fictitious new location), and still creates a physical retrieval obligation routed by existing PICKING/STAGED rules.
- Latest conclusive outcome per line wins, including later authorized corrections; repeat checks never double-count.

Metric (per reporting picker, chosen date range):

```text
denominator = unique reported lines with a final conclusive outcome (FOUND_AT_ORIGINAL, FOUND, NOT_FOUND, WRONG_LOCATION)
numerator   = denominator lines whose latest conclusive outcome is FOUND_AT_ORIGINAL
excluded    = unfinished lines, OTHER, cancelled lines without a conclusive check
```

Display: always numerator + denominator + date range + per-outcome counts for every user. Percentage only when denominator ≥ 20; below 20 show counts only. No rankings, no disciplinary scoring, export parity (dashboard/CSV/PDF).

## 4. Replenishment contract

Manual progress marker only. No inventory integration, no stock mutation.

- `POST /api/cases/:id/lines/:lineId/replenishment` `{ state: "WAITING" | "COMPLETED", note: string, retrieverUserId: string }` requires `RECORD_REPLENISHMENT`. Allowed transitions: `NONE`→`WAITING`, `WAITING`→`COMPLETED`, `NONE`→`COMPLETED` (no wait recorded). Retrieval routing follows existing PICKING/STAGED rules. No `replenishment_enabled` configuration key exists; availability is governed solely by the permission.

## 5. Notification + deep-link contract

- `POST /api/notifications/read-all` — atomic, recipient-scoped, idempotent; marks only the signed-in user's rows; returns updated unread count. Add missing error code or reuse `CASE_NOT_FOUND`-style envelope consistently.
- Every case notification carries `caseId` (+ optional `shortPickLineId`); the center calls back with the id instead of discarding it.
- Direct load/refresh applies the same access check as `GET /api/cases/:id`: readable by an active (non-disabled, non-archived) account holding `VIEW_OWN_CASES` who is the case picker, a line reporter, or a recorded check/retrieval participant (claimer, assignee, completer, retriever), or by a manager holding `VIEW_ALL_OPEN_CASES`. Message content additionally requires `VIEW_CASE_MESSAGES`. Whether historical participant links already exist in stored events/assignments or need a tracked migration is a Wave 1 domain-owner decision recorded before branching.
- Canonical deep link `/?case=<caseId>[&line=<lineId>]`, independent of which queue is open. Opening a notification marks that notification read, then navigates to the exact case (open, or closed read-only).

## 6. Timeline contract

- One visible row per case message. `CASE_MESSAGE_ADDED` remains in the audit store; UI MUST NOT render it as a second row.
- Status/assignment events render: previous value → new value, target person, location, actor, timestamp when present. Sparse legacy payloads render a truthful fallback; never invent values.
- New event types: `FOUND_AT_ORIGINAL_VERIFIED`, `REPLENISHMENT_WAITING`, `REPLENISHMENT_COMPLETED`, `CASE_REPAIRED`. Existing types keep names.

## 7. Ad hoc location + claim/capacity contract

- `GET /api/checks` contract: `?cursor=&limit=` (default 50), response `{ items, nextCursor, total }` with full available-check count; no silent 100-row truncation without `nextCursor`. Acceptance MUST fetch page 2.
- `MAX_SIMULTANEOUS_CHECKS_PER_CASE` default becomes unlimited (`null`) for new configurations. Roll-forward: record prior value + reason in a new audited configuration version, then change a prior `1` to unlimited (owner requires every available line claimable by default); preserve any other explicit cap (2–100 or unlimited). If history is unavailable and the prior value cannot be determined, escalate to the operator instead of guessing.
- Ad hoc report: `POST /api/cases/:id/lines/:lineId/discovered-location` requires `REPORT_NEW_LOCATION` (Team Leader/Assistant/Troubleshooter/Admin preset), records finder, reconciles any active check (external-resolution path), derives retrieval owner from case phase, emits audit event + responsibility notification atomically. UI places the action beside the line's original location and current "no known new location" text.

## 8. Override vs repair contract

- `OVERRIDE_CASE_STATE` defaults to Admin only, grantable to Team Leader. Bounded override command set (no arbitrary editing): retry blocked close with explicit administrative resolution, force-resolve a stuck line to terminal with reason, release a stale check claim, re-derive retrieval routing after phase change. Each validates one-open-case-per-order + one-active-check-per-line, records actor + reason + before/after + `CASE_REPAIRED` + audit in ONE transaction.
- Repair (`REPAIR_CASE_DATA`, default Admin only, grantable only to Admin; state-breaking steps additionally require `OVERRIDE_CASE_STATE`) is a separate closed command set: correct phase/physical placement, reassign or release a stale check, change retrieval owner, correct a location, cancel/reopen a line, close/reopen a case. Same atomicity/audit/invariant rules. Ordinary authorized close/reopen needs neither permission.

## 9. API/DTO proposal (aligned with existing routes)

| Method + path (proposed) | Permission | Behavior |
| --- | --- | --- |
| `POST /api/notifications/read-all` | session | recipient-scoped bulk read; idempotent; returns `{ updated, unreadCount }` |
| `GET /api/cases/:id` (extend) | case access incl. closed read | closed cases return read-only payload; same check as deep link |
| `GET /api/checks?cursor=&limit=` (extend) | `VIEW_AVAILABLE_CHECKS` | paginated available line checks + `total` |
| `POST /api/checks/:id/complete` (extend) | `COMPLETE_CHECK` (+ owner rule) | accept `FOUND_AT_ORIGINAL` without location; `FOUND` requires distinct location |
| `POST /api/cases/:id/override` | `OVERRIDE_CASE_STATE` | bounded override commands only, reasoned, atomic, audited |
| `POST /api/cases/:id/lines/:lineId/replenishment` | `RECORD_REPLENISHMENT` | waiting/completed marker + routing |
| `POST /api/cases/:id/lines/:lineId/discovered-location` | `REPORT_NEW_LOCATION` | ad hoc new location without owning check; records finder, reconciles active check, derives retrieval owner from phase, atomic audit event + notification |

New error codes (centralize in `src/server/case-errors.ts`): `REPAIR_INVARIANT_VIOLATION`, `REPAIR_REASON_REQUIRED`, `CHECK_RESULT_FORBIDDEN`, `REPLENISHMENT_FORBIDDEN`, `CASE_MESSAGE_CLOSED`. Existing codes keep names.

## 10. i18n + scan + My Work

- All new user-facing strings go in `src/i18n/messages.ts` with English fallback; Dutch, Polish, Spanish required. Never translate order numbers, locations, SKUs.
- New keys cover: next-action codes + blocking-reason codes (client-rendered), found-at-original option/result, replenishment waiting/completed + note/retriever labels, mark-all-read, deep-link errors, override vs repair preview/consequence/next-action confirmations, line-card fields (original/new location, reporter, checker/retriever, replenishment badge, next step), "no known new location", suppressed-percentage note (`n<20`).
- iOS scanning fallback: native `BarcodeDetector` feature-check + tested JS decoder for live camera and photo decode, rear-camera selection, lifecycle cleanup, denial messaging, retained manual entry. Acceptance: real iPhone Safari AND installed web app each scan the actual warehouse order label twice in succession; Android still works; emulator-only proof rejected.
- My Work / line cards show per line: display status, separate replenishment badge, original location, known new location or "none known", reporter, checker, retriever/retrieval owner, client-rendered next step + owner.

## 11. Migration, backfill, and test gates

- Every schema change gets a tracked `drizzle/` migration; fresh-database apply + production-upgrade path verified.
- Permission backfill migration is unconditional (all existing users) with a test asserting a previously-revoked user regains the three check grants while a later explicit revoke still sticks.
- Capacity `1`→unlimited roll-forward ships as an audited configuration version change recording prior value + reason, not a silent default flip; escalate to the operator if history is unavailable.
- Slice gates per merge: PRD + `DEVELOPMENT_PLAN.md` updated; tests for permissions, closed/read-only guards, claim concurrency, event+audit atomicity, four-language text; `npm test`, `npm run typecheck`, `npm run lint`, `npm run db:check`, production build; desktop + narrow-mobile browser QA; real-iPhone scan proof; disposable-data reproduction of the reported blocked close/status flows before fix.

## 12. Acceptance matrix (per issue theme)

| # | Theme | Pass criteria |
| --- | --- | --- |
| 1 | Mark all read | bulk action affects only signer, idempotent, badge updates without reload |
| 2 | Exact-case link incl. closed | notification opens exact open/closed case after reload + direct URL check; closed is read-only; denied case shows clear error |
| 3 | Found-at-original + rate | checker picks original vs new distinctly; history accurate; per-user counts + suppressed `<20` percentage + export parity |
| 4 | Per-user analytics | user-directory selector, per-user summaries, role filter, counts always shown |
| 6 | Default claim + closed guards | every role sees/claims/finishes available checks by default; paginated list proves page 2; closed history readable with ALL lines; closed post rejected; reopen restores only authorized posting |
| 7 | iOS scanning | real-iPhone Safari + installed app double-scan proof, denial/rear/cleanup/manual/wedge covered |
| 8 | Override + feedback | authorized override repairs each supported stuck state with reason WITHOUT full admin repair; unauthorized fails; confirmation states consequence + next action/owner |
| 9 | Replenishment visibility | NONE/WAITING/COMPLETED dimension persisted per line, routed via PICKING/STAGED rules, distinct badge on dashboard + check screen without reading a notification |
| 10 | Duplicate timeline row | one message renders once; audit keeps the event |
| 11 | Rich status/assignment timeline | before/after + target person + location + actor + time; sparse legacy events use honest fallback |
| 12 | Assignee visibility | target person visible immediately on card, detail, event |
| 13 | Admin repair | closed command set, preview + reason, atomic audited writes, invariant rejection, concurrency-safe |
| 14 | Line cards | open cases vs open lines distinguished; each line shows status, locations, people, next step |
| 15 | Configurable permissions | every new privilege centralized, API-enforced, grant/revoke editable, backfill tested |
| 16 | My Work detail | original/new location, reporter, retriever, next step on every assigned line |

## 13. Unresolved risks / decisions for coordinator

1. `FOUND_AT_ORIGINAL` as new enum value vs distinct boolean on `FOUND`: contract proposes a new outcome code; domain owner confirms migration cost on `check_completion_code` enum vs text code before branching.
2. ~~Closed-case read access set assumed broad~~ — RESOLVED 2026-09-28: concrete rule in §5 (active account + `VIEW_OWN_CASES` as picker/reporter/recorded check-retrieval participant, or manager with `VIEW_ALL_OPEN_CASES`; messages need `VIEW_CASE_MESSAGES`). Domain owner records before branching whether participant links already exist or need a tracked migration.
3. ~~Pagination shape proposed~~ — RESOLVED 2026-09-28: binding contract in §7 (`cursor/limit` default 50, `{ items, nextCursor, total }`); reused envelopes MUST match.
4. Repair command transport (single `/repair` endpoint with discriminated `command` vs one endpoint per command) is left to the domain owner within the atomicity/audit constraints above. Override commands travel separately from repair commands so `OVERRIDE_CASE_STATE` never implies `REPAIR_CASE_DATA`.
5. Real-iPhone acceptance needs a scheduled device + warehouse label; without it Wave 1 scanning cannot close issue 7.
