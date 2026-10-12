# Warehouse Short Pick Exception System
## Product Requirements Document

**Status:** Implementation specification  
**Target:** Production-capable internal web application  
**Primary deployment target:** Railway  
**Primary users:** Pickers, Troubleshooters, Team Leader, Team Leader Assistant, Administrator  
**Default language:** English  
**Additional supported languages:** Dutch, Polish, Spanish

---

# 1. Product Summary

Build a minimal, mobile-first warehouse application for reporting, checking, resolving, monitoring, and analyzing short-pick exceptions.

The application replaces the proposed WhatsApp-based short-pick workflow with structured data and explicit operational states.

It must remain:

- independent from Odoo;
- operationally useful if Odoo is unavailable;
- fast enough for warehouse-floor use;
- optimized for mobile devices used by pickers;
- usable on desktop and mobile by Team Leaders and Assistants;
- highly configurable without requiring code changes;
- event-driven and auditable;
- simple enough that a worker can understand the main actions without training beyond a short explanation.

The application is **not a WMS**.

It must not attempt to reproduce inventory management, picking, backorders, shipping, sales orders, stock moves, or other Odoo functions.

Its sole domain is:

> short-pick exception management.

---

# 2. Core Operational Principle

The fundamental entity is an **Order Case**.

An order may contain multiple missing products or locations.

Therefore:

> One open order = one open case.

A case contains one or more **Short-Pick Lines**.

Example:

```text
Order 341151
├── 03.AA.1 / FF405D-42 / missing 1
├── 07.BC.2 / ABC100-L / missing 2
└── 04.DD.1 / XYZ500-M / missing 1
```

The picker can continue adding short-pick lines to the case while continuing to pick the order.

Each short-pick line can be investigated independently.

There must never be two simultaneously open cases for the same order number.

Historical cases with the same order number are allowed.

---

# 3. Primary Goals

The system should:

1. Make short-pick reporting take only a few seconds.
2. Allow pickers to continue working while missing items are being checked.
3. Allow checks to be claimed or assigned without verbal coordination.
4. Route responsibility and notifications to the correct worker.
5. Allow Team Leader and Assistant to monitor the situation remotely.
6. Preserve the physical SHORT PICK / HOLD staging workflow.
7. Prevent unstructured or incomplete short-pick data.
8. Preserve a complete case history.
9. Detect repeated order numbers, including repetitions months apart.
10. Allow warehouse processes to be adjusted through configuration instead of code.
11. Generate structured data suitable for operational analysis.
12. Export analytics as CSV and formatted PDF reports.

---

# 4. Explicit Non-Goals

Do not implement the following unless added in a future specification:

- Odoo API integration;
- Odoo login;
- modifying stock quantities;
- reserving stock;
- validating picking operations;
- creating Odoo backorders;
- shipping;
- carrier selection;
- label printing;
- customer communication;
- automatic inventory corrections;
- AI recommendations;
- route optimization;
- worker productivity ranking;
- disciplinary scoring;
- warehouse maps;
- workforce scheduling;
- general-purpose internal chat;
- WhatsApp integration.

No functionality in the application should require Odoo to work.

---

# 5. User Roles

Provide these role presets (amended 2026-09-30 — Manager sits above Team Leader and below Admin):

- Picker
- Troubleshooter
- Assistant
- Team Leader
- Manager
- Admin

Roles are only default permission templates.

Actual capabilities must be controlled by granular permissions.

The frontend must render only capabilities that the authenticated user can use.

Do not show disabled functionality merely as greyed-out controls when it is irrelevant to that user.

Example (amended 2026-09-28 — defaults grant the queue, rendering stays permission-driven):

A Picker without `VIEW_AVAILABLE_CHECKS` must not see a queue of available checks. By default, however, every role preset — including Picker — grants `VIEW_AVAILABLE_CHECKS`, `CLAIM_CHECK`, and `COMPLETE_CHECK`, so all users normally see, claim, and finish every available line check. Frontend visibility always mirrors the server permission check; it is never the authorization boundary.
---

# 6. Permission Model

Use server-side permission enforcement.

Frontend hiding is not sufficient.

Recommended permissions include:

```text
REPORT_SHORT_PICK
VIEW_OWN_CASES
VIEW_ALL_OPEN_CASES

VIEW_AVAILABLE_CHECKS
CLAIM_CHECK
COMPLETE_CHECK

RETRIEVE_FOR_OTHER_PICKER

ASSIGN_CHECK
REASSIGN_CHECK
ASSIGN_TROUBLESHOOTER

ADD_CASE_MESSAGE
VIEW_CASE_MESSAGES

REPORT_NEW_LOCATION
CONFIRM_RETRIEVAL

MARK_ORDER_STAGED
RESOLVE_CASE
REOPEN_CASE
OVERRIDE_CASE_STATE
RECORD_REPLENISHMENT
REPAIR_CASE_DATA

CREATE_CASE_ON_BEHALF
CREATE_INVITES

VIEW_ANALYTICS
EXPORT_ANALYTICS

VIEW_USERS
EDIT_PICKER_PERMISSIONS
EDIT_TROUBLESHOOTER_PERMISSIONS
EDIT_ASSISTANT_PERMISSIONS
EDIT_TL_PERMISSIONS
EDIT_MANAGER_PERMISSIONS

MANAGE_CONFIGURATION
MANAGE_TRANSLATIONS

APPROVE_PROFILE_PHOTO

ARCHIVE_USERS
DISABLE_USERS
RESET_USER_PIN
REVOKE_USER_SESSIONS
```

`REPORT_NEW_LOCATION` defaults to Troubleshooter, Assistant, Team Leader, Manager, and Admin presets; Picker holds it only by explicit grant. `RECORD_REPLENISHMENT` defaults to Troubleshooter, Assistant, Team Leader, Manager, and Admin presets; Picker holds it only by explicit grant. `OVERRIDE_CASE_STATE` defaults to Admin only and may be granted only to Admin, Manager, or Team Leader. `REPAIR_CASE_DATA` defaults to Admin only and may be granted only to Admin. Each of these permissions is individually grantable/revocable per user within those bounds, including revoking any default. `EDIT_MANAGER_PERMISSIONS` is Admin-only: only Admin can create a Manager account or edit Manager or Admin accounts. Admin and Manager accounts are hidden from pickers, team leaders, assistants, and troubleshooters; Managers never see Admin accounts and cannot edit Admin accounts in any way.

---

# 7. Permission Hierarchy

## 7.1 Picker (amended 2026-09-28)

A normal Picker:

- cannot access user administration;
- cannot modify another user's permissions;
- may report short picks;
- may manage cases they are actively picking;
- may read and write case notes on accessible active cases and read their closed-case history; the server rejects new messages on closed cases;
- may receive `RECORD_REPLENISHMENT` or `REPORT_NEW_LOCATION` by explicit grant (`OVERRIDE_CASE_STATE` and `REPAIR_CASE_DATA` are never grantable to Picker).

## 7.2 Troubleshooter

A Troubleshooter:

- cannot access user administration;
- may handle escalated cases;
- may add case messages;
- may be assigned responsibility;
- may confirm retrievals and resolve cases when authorized.

## 7.3 Assistant

Assistant may:

- fully manage Picker permissions;
- fully manage Troubleshooter permissions;
- create user-registration invites;
- assign and reassign operational tasks;
- create manual short-pick reports;
- monitor all active cases;
- configure notifications;
- access analytics if permitted.

Assistant cannot change:

- Team Leader privileges;
- Manager privileges;
- Admin privileges.

Whether Assistant can modify operational configuration must itself be configurable by Team Leader.

## 7.4 Team Leader (amended 2026-09-30)

Team Leader may:

- manage all Picker permissions;
- manage all Troubleshooter permissions;
- manage Assistant permissions;
- create invites (except Manager and Admin invitations, which are Admin-only);
- assign/reassign operational work;
- manage operational configuration;
- manage notifications;
- access analytics;
- manually create, close and reopen cases.

Team Leader cannot alter Manager or Admin permissions, and cannot see Manager or Admin accounts.

## 7.5 Manager (amended 2026-09-30)

Manager sits above Team Leader and below Admin. A Manager holds everything a Team Leader holds plus `EDIT_TL_PERMISSIONS`, and may manage all Picker, Troubleshooter, Assistant, and Team Leader accounts. Only Admin can create a Manager account; Managers cannot edit Manager or Admin accounts in any way and never see Admin accounts.

## 7.6 Admin

Admin has unrestricted access.

---

# 8. Authentication

## 8.1 Account Credentials

Account creation requires:

- display name;
- PIN.

PIN requirements:

- minimum 6 digits;
- numbers only.

Do not store PIN values in plaintext.

Store only a secure password/PIN hash.

## 8.2 Login

Login should require a stable identifier plus PIN.

The implementation may use:

- selected user/display name + PIN;
- generated username + PIN;
- another low-friction equivalent.

Do not rely on display name as the immutable database identity.

Every account must have an immutable internal UUID.

Duplicate human names must be supported.

## 8.3 Sessions

Sessions must last indefinitely.

Authentication persists until one of the following happens:

- user explicitly logs out;
- account is disabled;
- account is archived and access is revoked;
- PIN is reset;
- Admin/TL revokes sessions;
- session is manually revoked;
- security policy forces revocation.

Do not implement automatic time-based session expiration.

Use secure, HTTP-only cookies.

Use HTTPS in production.

## 8.4 Failed Login Attempts

Repeated failures must trigger temporary lockout.

Lockout parameters should be configurable.

Initial suggested defaults:

```text
Maximum failed attempts: 5
Lockout duration: 15 minutes
```

Do not permanently lock users automatically.

---

# 9. Public Internet Security and Registration

The application will be reachable from the public internet.

Public application access must not mean public account creation.

Self-service account creation without an invitation is forbidden.

---

# 10. App Access QR Code

Provide a permanent application URL.

Authorized users should be able to:

- copy the URL;
- generate a printable QR code representing that URL.

The QR code simply opens the application.

It must not contain authentication credentials.

Possible use:

- warehouse notice board;
- picking station;
- SHORT PICK / HOLD staging area;
- WhatsApp group.

---

# 11. User Registration Invitations

Team Leader, Assistant and Admin can create temporary registration invitations.

Each invitation must contain an unguessable random token.

The token must not encode privileges directly.

Invitation configuration:

```text
expires_at
max_registrations
registrations_used
default_role
default_permissions_or_permission_preset
created_by
created_at
revoked_at
```

Default expiration:

```text
8 hours
```

The creator must be able to:

- copy invitation URL;
- generate QR code;
- print QR code;
- revoke invitation;
- see registrations used;
- see expiration.

The invitation can allow one or multiple registrations.

Examples:

```text
Single worker invitation
max_registrations = 1
```

or:

```text
Picker onboarding session
max_registrations = 10
```

Expired, exhausted, or revoked invitations must fail closed.

---

# 12. User Profiles

Profile contains at minimum:

```text
id
display_name
role
status
preferred_language
profile_photo_status
created_at
updated_at
```

Account statuses:

```text
ACTIVE
DISABLED
ARCHIVED
```

Do not normally delete users because historical event references must remain intact.

---

# 13. Profile Pictures

Users may optionally upload a profile picture.

Upload rules:

- enforce maximum upload size;
- enforce supported file types;
- resize server-side;
- strip metadata such as EXIF;
- generate a standardized display image.

Suggested output:

```text
square image
maximum 512 × 512 px
optimized JPEG/WebP equivalent
```

Exact implementation is flexible.

Photo state:

```text
NONE
PENDING
APPROVED
REJECTED
```

Until approval:

- other users see initials/default avatar;
- pending photo is visible only to authorized approvers and the owner.

Team Leader/authorized approver receives a notification when approval is required.

Approver can:

- approve;
- reject.

---

# 14. Localization

Architecture must support localization from the beginning.

Ship with:

- English — default;
- Dutch;
- Polish;
- Spanish.

Do not hard-code visible strings directly throughout components.

Use translation keys.

Examples:

```text
shortPick.report
shortPick.addItem
case.moveToHold
check.claim
location.newFound
```

A user chooses preferred language in profile/settings.

Fallback language:

```text
English
```

Database operational data such as SKU/location/order number must never be translated.

---

# 15. Domain Model Overview

Main entities:

```text
User
Permission
RolePreset

Invite
Session
ProfilePhoto

OrderCase
ShortPickLine
CheckTask
CaseEvent
CaseMessage

Notification
PushSubscription

ConfigurationVersion
ConfigurationValue

AnalyticsExport
```

Exact table separation may vary, but the domain behavior must remain equivalent.

---

# 16. Order Case

The Order Case represents one operational occurrence of an order experiencing one or more short picks.

Suggested fields:

```text
id UUID
order_number string/numeric-string
phase enum
physical_state enum
physical_location nullable string

picking_user_id nullable UUID
current_case_responsible_user_id nullable UUID

created_by_user_id UUID
created_at timestamp
updated_at timestamp

staged_at nullable timestamp
resolved_at nullable timestamp
resolved_by_user_id nullable UUID

reopened_at nullable timestamp

configuration_version_id UUID

source enum

version integer
```

`version` may be used for optimistic concurrency control.

---

# 17. Order Number Rules

Order input:

- numbers only;
- store normalized representation;
- do not store unnecessary prefixes.

If scanner data includes something like:

```text
NLVW341151
```

and configuration says the numerical component is the order identifier, normalize to:

```text
341151
```

Never modify a value ambiguously without validation.

---

# 18. One Open Case Per Order Invariant

Database must guarantee:

> At most one non-closed case exists for a normalized order number.

Implement this server-side and preferably at database level where possible.

Never rely solely on frontend checks.

---

# 19. Historical Duplicate Detection

When a user submits/scans an order number:

## If an open case exists

Do not create another case.

Open the existing case.

Show:

```text
Existing open case found
Order 341151
```

## If no open case exists but historical cases exist

Warn:

```text
ORDER SEEN BEFORE

341151 has previous case history.

14 Mar 2026
08 Jun 2026

No active case exists.

[Cancel]
[Create new case]
```

The warning must occur even if previous occurrences happened months or years earlier.

This supports detection of duplicate/reprinted orders.

Historical occurrences remain separate cases linked by the normalized `order_number`.

---

# 20. Case Source

Cases should identify how they entered the system.

Example:

```text
PICKER_REPORT
TL_MANUAL
ASSISTANT_MANUAL
ADMIN_MANUAL
```

A manually created case found in the physical staging area may also include:

```text
manual_reason = PHYSICAL_HOLD_WITHOUT_DIGITAL_REPORT
```

This must remain analytically distinguishable.

---

# 21. Case Operational Phases

Required phases:

```text
PICKING
STAGED
RESOLUTION
CLOSED
```

`RESOLUTION` may be explicit internally or inferred depending on implementation.

Behavior is more important than exact enum names.

## PICKING

The order is physically with the picker.

The picker may continue adding missing lines.

## STAGED

The picker confirms that the physical order/box has been placed in SHORT PICK / HOLD.

The physical box is now assumed available at that staging area.

## CLOSED

The case is completed.

All required unresolved lines must either:

- be resolved;
- be explicitly dispositioned through an authorized resolution;
- or be administratively closed by authorized personnel.

---

# 22. Physical State

Do not infer physical location solely from workflow state.

Track explicit physical state.

Suggested values:

```text
WITH_PICKER
SHORT_PICK_HOLD
OTHER_KNOWN_LOCATION
UNKNOWN
```

When staging is confirmed:

```text
physical_state = SHORT_PICK_HOLD
physical_location = configured SHORT PICK / HOLD name
```

---

# 23. Short-Pick Line

Each missing location/product combination is its own line within a case.

Suggested fields:

```text
id UUID
case_id UUID

original_location string
sku string
missing_quantity integer

reported_by_user_id UUID
reported_at timestamp

state enum

current_responsible_user_id nullable UUID

discovered_location nullable string
discovered_by_user_id nullable UUID
discovered_at nullable timestamp

retrieval_state enum
retrieval_responsible_user_id nullable UUID
retrieved_by_user_id nullable UUID
retrieved_at nullable timestamp

resolved_at nullable timestamp
resolution_code nullable enum/string

created_at
updated_at
version
```

---

# 24. Input Rules

## Location

Allow:

- manual typing;
- barcode/QR scanning.

Normalize visually and on storage:

```text
uppercase
trim whitespace
```

Example:

```text
03.aa.1
```

becomes:

```text
03.AA.1
```

## SKU

Allow:

- manual typing;
- scanning.

Normalize:

```text
uppercase
trim whitespace
```

Do not otherwise alter SKU semantics.

## Quantity

Allow:

- keyboard input;
- large minus button;
- large plus button.

Rules:

- positive integer;
- minimum `1`;
- reject zero;
- reject negative values;
- reject decimals.

Controls must be large enough for warehouse mobile use.

---

# 25. Reporting UX

The picker flow must be mobile-first.

Start:

```text
REPORT SHORT PICK
```

Step 1:

```text
ORDER
[Scan] [341151]
```

When submitted:

- find open case;
- otherwise check historical cases;
- otherwise prepare new case.

Inside case:

```text
ORDER 341151

03.AA.1
FF405D-42 ×1
CHECKING — Lucas

07.BC.2
ABC100-L ×2
OPEN

[ + ADD MISSING ITEM ]

[ ORDER PLACED IN SHORT PICK / HOLD ]
```

---

# 26. Picker Multiple-Order Management

Pickers frequently hold several orders simultaneously.

Picker home screen should present active relevant cases.

Example:

```text
MY SHORT-PICK ORDERS

341151
3 missing · 1 found
[Open]

341204
1 missing · checking
[Open]

341255
2 missing
[Open]

[ + REPORT SHORT PICK ]
```

Do not force the picker to finish one case before reporting another.

---

# 27. Adding More Missing Items

A picker may continue adding short-pick lines while:

- another line is being checked;
- another worker is checking;
- another line has already received a discovered location;
- the order remains physically with the picker.

Adding a new line must not automatically assign it to an existing checker.

Example:

```text
Line A → Lucas CHECKING
Line B → newly created OPEN
```

These remain separate.

---

# 28. Duplicate Short-Pick Line Detection

When adding a line to a case, detect probable duplicates.

At minimum compare:

```text
case_id
normalized location
normalized SKU
```

If the same combination already exists and is unresolved, warn instead of silently creating another.

Example:

```text
This item is already reported on this order.

03.AA.1
FF405D-42
Missing: 1

[Open existing]
[Cancel]
```

Do not silently merge quantities.

If authorized personnel intentionally need another line, support explicit override if necessary.

---

# 29. Check Tasks

Checking belongs to a **Short-Pick Line**, not to the entire Order Case.

A case may therefore contain:

```text
Line A → CHECKING by Lucas
Line B → OPEN
Line C → FOUND, retrieval pending
```

Suggested CheckTask fields:

```text
id
short_pick_line_id

status
claimed_by_user_id nullable
assigned_to_user_id nullable

claimed_at nullable
assigned_at nullable
started_at nullable
completed_at nullable

completion_code nullable

created_at
updated_at
```

---

# 30. Check Claiming

If user has `CLAIM_CHECK`, they may claim an unassigned claimable check. The available-checks list endpoint (`GET /api/checks`) is cursor-paginated with an explicit contract: query `?cursor=&limit=` (default limit 50), response `{ items, nextCursor, total }` where `total` is the full count of available checks; the silent 100-row cap MUST NOT truncate results without a `nextCursor`. Acceptance MUST fetch page 2 to prove all checks are visible.

Claiming must be atomic.

Two users must not successfully claim the same check.

Use a transaction or equivalent concurrency protection.

Once claimed:

```text
assigned/claimed checker = user
```

A claimed check is no longer visible as available to other workers.

---

# 31. Assigned Checks

A check may be explicitly assigned by:

- Team Leader;
- Assistant;
- Admin.

Assigned checks **cannot be claimed**.

Only TL, Assistant or Admin can reassign an assigned check.

This rule must be enforced server-side.

---

# 32. Check Concurrency Per Case

Maximum simultaneous checks per Order Case must be configurable.

Default for new configurations (amended 2026-09-28):

```text
unlimited (null)
```

Capacity roll-forward rule (2026-09-28): a deployed value of `1` is indistinguishable from an intentional choice of `1` without configuration history, so the migration MUST NOT assume intent. The migration records the prior value and reason in the new configuration version, then changes a prior value of `1` to unlimited (`null`) because the warehouse owner explicitly requires every available line to be claimable by default; any other prior explicit cap (finite 2–100 or unlimited) is preserved unchanged. If prior configuration history is unavailable so the pre-existing value cannot be determined, escalate to the operator instead of guessing.

If a finite limit has been reached:

- additional lines remain OPEN;
- no new claim is permitted until capacity becomes available.

---

# 33. Case Responsibility vs Line Responsibility

Maintain separate concepts.

## Case responsibility

Represents who currently owns the order-level operational action.

## Line responsibility

Represents who currently owns an individual shortage action.

Example:

```text
Order 341151
Case picker: Daniel

Line A:
checker = Lucas

Line B:
checker = none
```

Daniel still owns the physical order.

Lucas owns only Line A's check.

Never transfer the whole case to a checker just because they claimed one line.

---

# 34. New Location Discovery

Location discovery and physical retrieval are separate events.

When someone finds stock elsewhere, they report:

```text
NEW LOCATION
05.CC.2
```

This produces a structured event.

It does not imply that the item was physically retrieved.

Line state becomes equivalent to:

```text
FOUND
RETRIEVAL_PENDING
```
Found at the original location (amended 2026-09-28) is a distinct check outcome (`FOUND_AT_ORIGINAL`): the checker verifies stock at the line's original location. It records the original location and verifier, preserves the reporting picker, leaves `discovered_location` null (MUST NOT invent a location value), and still creates a physical retrieval obligation routed by the existing PICKING/STAGED rules (§35–§37). A later authorized correction supersedes the earlier outcome; analytics uses the latest conclusive outcome per line.

---

# 35. Responsibility Routing While Case Is PICKING

When:

```text
case.phase = PICKING
```

and a new location is discovered:

the active picker is responsible for retrieval.

Example:

```text
Daniel owns Order 341151.
Lucas checks a short-pick line.
Lucas finds stock at 05.CC.2.

Result:
Lucas's check is completed.
Daniel receives the actionable location notification.
Daniel retrieves the product.
```

The checker does not need to locate the moving box.

Preferred operational rule:

> During PICKING, checker locates; active picker retrieves.

---

# 36. Responsibility Routing When Case Is STAGED

When:

```text
case.phase = STAGED
```

the physical order is known to be at SHORT PICK / HOLD.

A checker/troubleshooter may then retrieve the product and deliver it to the staged order if permitted.

Routing:

```text
STAGED + assigned resolver
→ retrieval responsibility = assigned resolver
```

Authorized TL/Assistant/Admin can override.

---

# 37. Race Condition: Location Found While Order Is Being Staged

Do not attempt to prevent legitimate concurrent updates through excessive UI locking.

Use server-side timestamps and transactional state changes.

Example:

```text
14:03:11 Lucas reports FOUND at 05.CC.2
14:03:13 Daniel confirms STAGED
```

Final computed state:

```text
item = FOUND
case = STAGED
retrieval = assigned according to latest phase/routing rules
```

Events must not be lost.

---

# 38. Marking Order as Staged

Picker action:

```text
ORDER PLACED IN SHORT PICK / HOLD
```

Require confirmation:

```text
Order 341151 is physically in SHORT PICK / HOLD?

[Cancel]
[Confirm]
```

On confirmation:

```text
case.phase = STAGED
physical_state = SHORT_PICK_HOLD
staged_at = now
```

Generate event.

Notify relevant checkers/resolvers that the box is now staged.

---

# 39. Retrieval

Retrieval is a separate explicit action.

Example states:

```text
NOT_REQUIRED
PENDING
IN_PROGRESS
RETRIEVED
FAILED
```

When active picker retrieves:

```text
retrieved_by = active picker
```

When staged and authorized troubleshooter retrieves:

```text
retrieved_by = troubleshooter
```

Never treat location discovery alone as retrieval.

### Replenishment progress (added 2026-09-28)

Replenishment is its own persisted state dimension on each short-pick line, separate from case phase and from the line's main state: `replenishment_state` is one of `NONE` (default), `WAITING`, or `COMPLETED`. It is a manual progress marker, not inventory integration: an authorized actor (`RECORD_REPLENISHMENT`) marks a line `WAITING` and later `COMPLETED`, each with timestamp, note, and named retriever/responsible user. `WAITING` is allowed from `NONE` only; `COMPLETED` is allowed from `WAITING` (or directly from `NONE` when no wait was recorded) and routes a retrieval task plus notification to the named responsible user using the existing PICKING/STAGED routing rules (§35–§37). Each transition writes its event (`REPLENISHMENT_WAITING` / `REPLENISHMENT_COMPLETED`) and audit entry atomically with the line update, renders with a display badge distinct from the line's main-state badge on dashboard and check screens, and remains visible without requiring a notification read. The system MUST NOT mutate stock quantities.

---

# 40. Troubleshooter Workflow

Troubleshooter interface should emphasize:

- assigned cases/lines;
- escalated items;
- current physical order state;
- shortage details;
- previously attempted checks;
- discovered locations;
- case messages;
- elapsed time.

Troubleshooter can use structured actions such as (amended 2026-09-28):

```text
FOUND_AT_ORIGINAL
FOUND
NOT FOUND
WRONG LOCATION
RETRIEVED
OTHER
```
`FOUND_AT_ORIGINAL` verifies stock at the line's original location and records no new location. `FOUND` requires a distinct new location. `NOT FOUND` and `WRONG LOCATION` are conclusive non-find outcomes; `OTHER` is non-conclusive and excluded from the same-location-found metric (§62A).

and free-text messages where necessary.

---

# 41. Free-Text Case Messages

Free-text messaging is intended only for complex operational notes.

Allowed by default (amended 2026-09-28):

- Troubleshooter;
- Team Leader;
- Assistant;
- Admin;
- any Picker (or other role) holding `ADD_CASE_MESSAGE` / `VIEW_CASE_MESSAGES` on a case they can access while the case is active.

Pickers with those grants can read and write notes on accessible active cases and read their own closed-case history. The server MUST reject a new message on a closed case; reopening restores posting only for authorized active participants. Do not build a general chat system.

A message must include:

```text
id
case_id
optional short_pick_line_id
author_user_id
message
created_at
```

Messages are immutable after posting except possibly admin moderation.

Do not build a general chat system.

---

# 42. Case Timeline

Structured events and messages should appear chronologically.

Example:

```text
12:31 Daniel
SHORT PICK REPORTED
03.AA.1 · FF405D-42 · 1

12:33 Lucas
CHECK CLAIMED

12:36 Lucas
NOT FOUND

12:38 Natalia
ASSIGNED TO TROUBLESHOOTER

12:43 Troubleshooter
Message:
Found unopened carton near BTS area.

12:44 Troubleshooter
NEW LOCATION
BTS-02
```

The timeline is an audit trail.

Timeline rendering rules (amended 2026-09-28): a case message renders as exactly one visible row; the `CASE_MESSAGE_ADDED` event stays in the audit store but MUST NOT render as a second row. Status and assignment events render previous and new values, the target person where applicable, location, actor, and timestamp when available. Older events with sparse payloads render a truthful fallback and MUST NOT invent missing values.

---

# 43. Immutable Event Log

Every meaningful state transition must create a CaseEvent.

Suggested event types:

```text
CASE_CREATED
CASE_REOPENED
CASE_CLOSED

SHORT_PICK_ADDED
SHORT_PICK_UPDATED

CHECK_CLAIMED
CHECK_ASSIGNED
CHECK_REASSIGNED
CHECK_COMPLETED

NEW_LOCATION_REPORTED
FOUND_AT_ORIGINAL_VERIFIED

REPLENISHMENT_WAITING
REPLENISHMENT_COMPLETED

RETRIEVAL_ASSIGNED
RETRIEVAL_CONFIRMED
RETRIEVAL_FAILED

ORDER_STAGED

RESPONSIBILITY_CHANGED

CASE_REPAIRED

CASE_MESSAGE_ADDED

MANUAL_CASE_CREATED

CONFIGURATION_CONTEXT_RECORDED
```

Event fields:

```text
id
case_id
short_pick_line_id nullable
event_type
actor_user_id nullable
timestamp
structured_payload JSON
```

Do not rewrite historical events.

---

# 44. Closing Cases

Primary closure should be performed by:

- responsible Picker; or
- responsible Troubleshooter.

TL/Assistant may also close a case.

If TL/Assistant closes it:

```text
resolved_by_user_id = that user
```

and that user becomes the final responsible resolver for audit purposes.

Closure should require that all lines are in a valid terminal state or that the closer explicitly selects an authorized administrative resolution.

---

# 45. Reopening Cases

TL, Assistant and Admin may reopen a closed case if permitted.

Reopening:

- must not erase closure history;
- creates `CASE_REOPENED` event;
- returns case to a valid active state;
- re-establishes responsibility explicitly.
Do not mutate the historical closure event.


# 45A. Stuck-State Override and Admin Repair (added 2026-09-28)

`OVERRIDE_CASE_STATE` defaults to Admin only and is grantable to Team Leader; it authorizes a bounded override command set that never edits data arbitrarily: retry a blocked close with explicit administrative resolution, force-resolve a stuck line to a terminal state with reason, release a stale check claim so the line becomes claimable again, and re-derive retrieval routing after a phase change. Each override validates invariants (including one-open-case-per-order and one-active-check-per-line), records actor, reason, before/after values, case event (`CASE_REPAIRED`), and audit entry in ONE database transaction, and rejects invariant violations. `OVERRIDE_CASE_STATE` alone never grants the broader repair set below.

`REPAIR_CASE_DATA` defaults to Admin only and may be granted only to Admin; it authorizes the separate closed Admin repair command set: correct phase/physical placement, reassign or release a stale check, change retrieval owner, correct a location, cancel/reopen a line, close/reopen a case. State-breaking repair steps additionally require `OVERRIDE_CASE_STATE`. Each command validates invariants, records actor, reason, before/after values, case event (`CASE_REPAIRED`), and audit entry in ONE database transaction, and rejects repairs that would violate invariants. The admin UI previews consequences and requires an explicit reason. Ordinary authorized close/reopen remains available to permitted roles without either permission.

After every consequential action — stage, assign, check completion, replenishment, retrieval, close, reopen, override, repair — the UI MUST show a concise confirmation stating the consequence and the next action with its owner.

---

# 46. Manual TL/Assistant Case Creation

TL/Assistant/Admin must be able to create a short-pick case if they physically find an order in SHORT PICK / HOLD without a corresponding app case.

Flow:

```text
CREATE MISSING DIGITAL CASE

Order
Location
SKU
Quantity
Optional original picker
Reason
```

Default reason:

```text
PHYSICAL_HOLD_WITHOUT_DIGITAL_REPORT
```

The created case should normally begin as:

```text
phase = STAGED
physical_state = SHORT_PICK_HOLD
```

unless manually overridden.

This source must remain analytically measurable.

---

# 47. Task Assignment UX

TL/Assistant should be able to assign a check or troubleshooting task in very few interactions.

Example:

```text
ASSIGN

Lucas         Available
Seba          1 active
Gondal        Available

[Show all]
```

Do not implement sophisticated scheduling.

Useful assignment context may include:

- current active tasks;
- role;
- availability status inferred only from application task state.

Do not infer employee attendance unless explicitly implemented later.

---

# 48. Notifications

There are two conceptual notification classes.

## 48.1 Responsibility notifications

Operational alerts sent to the user currently expected to act.

These cannot be disabled in the in-app notification center.

Examples:

- check assigned;
- new location found for item picker must retrieve;
- troubleshooting task assigned;
- case responsibility transferred.

## 48.2 Monitoring notifications

Optional notifications configured by TL/Assistant/Admin for awareness.

Examples:

```text
New short pick
Check claimed
New location discovered
Case message
Case unresolved > threshold
Case resolved
```

Each user may configure their allowed monitoring notifications subject to permissions.

---

# 49. Notification Routing

Use current responsibility.

Example:

```text
Daniel is active picker.
Lucas claims check.
Natalia reports a new location while case = PICKING.

Actionable new-location notification → Daniel.
Informational "check resolved externally" notification → Lucas.
```

If case has been staged and Troubleshooter is assigned:

```text
Actionable new-location notification → Troubleshooter.
```

Routing must be deterministic.

---

# 50. Notification Delivery Channels

At minimum:

1. in-app notification center;
2. browser/Web Push when available.

Do not make correct operation depend on push delivery.

Every notification must exist in-app even if push fails.

Notification entity should contain:

```text
id
recipient_user_id
type
case_id nullable
short_pick_line_id nullable
payload
created_at
read_at nullable
push_attempted_at nullable
```

---

# 51. Push Subscription Behavior

Push should be optional and device-specific.

Users may have multiple devices/subscriptions.

Removing one device should not remove all notifications.

Push failure must not fail the operational action that generated it.

---

# 52. Notification Preferences

TL/Assistant user may configure monitoring preferences such as:

```text
New short pick            ON
Check claimed             OFF
New location              ON
Troubleshooter message    ON
Unresolved > 10 min       ON
Case resolved             OFF
```

Thresholds should be configurable where relevant.

Responsibility notifications remain visible in-app regardless.

### 52A. Mark-all-read and exact-case deep links (added 2026-09-28)

The notification center MUST offer an atomic, recipient-scoped "mark all read" action: it marks only the signed-in user's notifications, is idempotent, and refreshes the unread badge without a reload.

Every notification that references a case MUST deep-link to the canonical case URL `/?case=<caseId>` (with optional `&line=<lineId>`), independent of which queue is open. Opening a notification marks that notification read, opens the same case detail the viewer sees when opening that case from Dashboard (drawer, for `VIEW_ALL_OPEN_CASES` holders), Checks (case panel), or My Work (order detail) — never a separate deep-link screen — and lands on the matching surface for that viewer: `VIEW_ALL_OPEN_CASES` holders switch to the Dashboard surface if needed, everyone else to Checks or My Work per the routing rule below. There is exactly one case-detail component per surface. Direct load and refresh apply the same server access check as `GET /api/cases/:id`: a closed case is readable by an active (non-disabled, non-archived) account holding `VIEW_OWN_CASES` who is the case picker, a line reporter on the case, or a recorded check/retrieval participant on the case (claimer, assignee, completer, or retriever), or by a manager holding `VIEW_ALL_OPEN_CASES`; message content within the detail additionally requires `VIEW_CASE_MESSAGES`. Closed cases resolve to a read-only detail view, and inaccessible cases show a clear error. Whether the historical check/retrieval participant links needed for this rule already exist in stored events/assignments or require a tracked migration is a Wave 1 domain-owner decision recorded before branching.

Notification open MUST land on the live surface matching the viewer's access: `VIEW_ALL_OPEN_CASES` holders see the dashboard case drawer; otherwise the viewer sees the My Work or Checks case detail for that case (check notifications route pickers to Checks). A viewer who holds a notification for a case they cannot open (no `VIEW_ALL_OPEN_CASES`, not the picker, no `VIEW_OWN_CASES` responsibility path) sees the same access-denied state as opening that case directly: the native surface stays empty/loading with its standard error, never a separate deep-link error screen. Only the notification-opened case renders as an overlay, and only on narrow mobile widths: the case detail is fixed full-screen above the queue lists so it is never missed below them. Desktop keeps the native inline placement (drawer on the right, Checks panel below the queues, My Work in place).

---

# 53. Team Leader / Assistant Dashboard

Dashboard header metrics (open cases, open lines, checking, staged, over-threshold, resolved today) are served by a dedicated summary endpoint/response, separate from the per-case detail projection: the case-detail projection returns ALL lines of the case (open and terminal), never only open lines, so closed detail is complete.

Suggested header metrics:

```text
OPEN CASES
OPEN SHORT PICKS
CHECKING
STAGED
>15 MIN
RESOLVED TODAY
```

Main queue should be filterable and sortable.

Example:

| Age | Order | Phase | Missing | Picker | Current issue | Responsible |
|---|---|---|---:|---|---|---|
| 18m | 341151 | Picking | 4 | Daniel | 1 checking | Lucas |
| 12m | 341207 | Staged | 2 | Seba | unresolved | Troubleshooter |
| 4m | 341215 | Picking | 1 | Gondal | open | Gondal |

On mobile, render equivalent cards. Line-level detail (amended 2026-09-28): the dashboard and check screens distinguish open cases from open short-pick lines. Each line card shows its own display status, original location, known new location or an explicit "none known" state, reporter, assigned checker/retriever, replenishment badge (distinct from the main-state badge), and the next action with its owner. Server DTOs carry stable `nextActionCode` / `blockingReasonCode` values with typed parameters and owner IDs; all user-facing wording is rendered client-side from the four-language dictionaries (English fallback), never as free-text strings from the server. Waiting/completed replenishment has distinct visible states on both surfaces.

---

# 54. Dashboard Attention Thresholds

Thresholds should be configurable.

Suggested defaults:

```text
warning: 5 minutes
attention: 10 minutes
critical: 15 minutes
```

Do not hard-code presentation logic permanently.

---

# 54A. Working-Hours Case Clock (added 2026-10-12)

Case elapsed time counts only time inside the case's configured working schedule. Default: Monday–Friday, 08:00 inclusive to 17:00 exclusive, Europe/Amsterdam. The IANA timezone accounts for summer/winter time; the user's device or server timezone must not change the calculation. Authorized configuration managers may change the working weekdays and same-day start/end times. At least one weekday and a start earlier than the end are required; overnight shifts and holiday calendars are outside this release.

Use the same working-time basis for active case ages, attention thresholds, unresolved-over-threshold monitoring, analytics timing medians, report threshold counts and CSV/PDF timing output. Age monitoring is evaluated during that case's working window; responsibility/assignment notifications remain immediate. Preserve actual timestamps, audit history and calendar date filters. Closed case elapsed time ends at resolved_at. Reopened cases follow the existing created_at-to-latest-resolution timing model; working hours do not introduce a separate closure-interval exclusion.

Settings are versioned and audited with the existing configuration system. Each case retains its pinned configuration version. Configuration versions written before these settings existed use the default schedule; their stored JSON and original timestamps remain immutable. Subsequent schedule changes apply to new cases. Historical durations are recalculated on the working-time basis; already-generated PDF artifacts remain unchanged.

Configuration keys: WORKING_HOURS_TIME_ZONE (Europe/Amsterdam), WORKING_HOURS_DAYS (ISO weekdays 1–7, default 1–5), WORKING_HOURS_START (08:00), WORKING_HOURS_END (17:00). Reports must identify working-time durations and retain per-case schedule metadata where needed for reproducibility. Open-backlog age buckets measured as 24/72/168 working hours must say so, not imply calendar or scheduled working days.

Example: Friday 16:30 to Monday 08:30 counts as 60 minutes. A case reported after closing remains at zero until the next configured opening.

---

# 55. Picker UI Permission Rendering

Frontend must derive picker navigation/actions from permissions.

Example A:

```text
permissions:
REPORT_SHORT_PICK

UI:
My Orders
Report Short Pick
Notifications
Profile
```

Example B:

```text
permissions:
REPORT_SHORT_PICK
VIEW_AVAILABLE_CHECKS
CLAIM_CHECK

UI:
My Orders
Report Short Pick
Available Checks
My Checks
Notifications
Profile
```

Avoid exposing irrelevant options.

Defaults (amended 2026-09-28): every role preset includes `VIEW_AVAILABLE_CHECKS`, `CLAIM_CHECK`, and `COMPLETE_CHECK`, so Example B is the normal Picker experience. If those grants are revoked for a user, the queue and claim controls disappear entirely (Example A) rather than rendering disabled.

---

# 56. Network Failure

Do not support offline short-pick submission in v1.

All reports require confirmed server submission.

If connection fails:

```text
Unable to submit.

Check your connection and try again.

If the problem continues, report the short pick directly to the Team Leader or Assistant.

[Try Again]
```

Do not silently queue the case locally.

This avoids duplicate and conflicting warehouse exceptions.

---

# 57. Loading and Submission Safety

Every state-changing button should:

- prevent duplicate taps;
- show submission progress;
- wait for server confirmation;
- show clear success/failure state.

Example:

```text
[Reporting…]
```

then:

```text
SHORT PICK REPORTED
```

Do not optimistically show success before the server commits the action.

---

# 58. Configuration System

Do not create separate hard-coded workflows.

Use one workflow whose behavior is controlled through configuration.

Potential configuration values:

```text
max_simultaneous_checks_per_case
claim_checks_enabled
checker_retrieval_during_picking_enabled
checker_retrieval_when_staged_enabled

warning_threshold_minutes
attention_threshold_minutes
critical_threshold_minutes

require_staging_confirmation

invite_default_expiry_hours
invite_default_max_registrations

login_max_failed_attempts
login_lockout_minutes

short_pick_hold_location_name

allowed_resolution_codes

manual_case_creation_enabled

assistant_can_manage_configuration

profile_photo_max_upload_bytes

order_scanner_normalization_rule
```

All values must have documented defaults. `max_simultaneous_checks_per_case` defaults to unlimited (`null`) for new configurations; existing deployments roll their explicit value forward through an audited configuration change (§32). No `replenishment_enabled` key exists: replenishment availability is governed solely by the `RECORD_REPLENISHMENT` permission, and any such key MUST NOT be introduced without a specified default, tracked migration, and UI.

---

# 59. Configuration Versions

Every operational configuration change creates a new immutable configuration version.

Example:

```text
Configuration v7
max_simultaneous_checks_per_case = 1
critical_threshold = 15

Configuration v8
max_simultaneous_checks_per_case = 2
critical_threshold = 10
```

Each newly created Order Case stores:

```text
configuration_version_id
```

Workflow-affecting configuration changes apply to new cases by default.

Existing cases retain the configuration version under which they were created.

Authorized users may explicitly migrate an existing case only if such functionality is later implemented.

Do not silently change historical case behavior.

---

# 60. Configuration Audit

Record:

```text
changed_by
changed_at
previous_version
new_version
changed_values
```

This is critical for later process experiments.

---

# 61. Analytics

Analytics must be based on structured database data and event timestamps.

Initial metrics:

```text
total short-pick cases
total short-pick lines

cases by day/week/month
lines by location
lines by SKU

found during check
not found
wrong location
retrieved

median time:
report → check claimed
report → location found
report → retrieval
report → resolution

cases > configured threshold

manual TL/Assistant cases
reopened cases

historically repeated order numbers

cases by configuration version

same-location-found counts per reporting picker (added 2026-09-28; see §62A)
```

---

# 62. Analytical Dimensions

Allow filtering by:

```text
date range
order number
location
SKU
case phase
resolution type
case source
configuration version
picker
checker
troubleshooter
```

User-level analytics should be treated as operational data, not a performance score.

Do not automatically rank workers.

### 62A. Same-location-found metric and per-user analytics (added 2026-09-28)

Denominator: unique lines reported in the chosen date range whose final conclusive check outcome exists. Numerator: those lines whose latest conclusive outcome is `FOUND_AT_ORIGINAL`. `FOUND` elsewhere, `NOT FOUND`, and `WRONG LOCATION` count in the denominator; unfinished lines, `OTHER`, and cancelled lines without a conclusive check are excluded. Repeat checks never double-count: the latest conclusive outcome per line wins, including a later authorized correction.

Display: always show numerator, denominator, date range, and per-outcome counts for every user. Show a percentage only when the denominator is 20 or more; below that, suppress the percentage (counts only). No worker rankings, disciplinary scoring, or league tables — this is an operational signal, not a performance score. Per-user analytics add a reliable user-directory selector and per-user summaries with CSV/PDF export parity.

---

# 63. Duplicate Order Analytics

Provide specific analysis for recurring order numbers.

Example:

```text
Order 341151
Occurrences: 3

14 Mar 2026
08 Jun 2026
26 Sep 2026
```

Possible aggregate:

```text
37 order numbers appeared in more than one case during selected period.
```

---

# 64. PDF Reports

Analytics can be exported as a formatted PDF.

PDF should include:

- report title;
- generated timestamp;
- filters used;
- KPI summary;
- selected charts;
- selected tables;
- relevant configuration version context.

Do not implement PDF export as a screenshot of the webpage.

Generate a deliberate print/report layout.

---

# 65. CSV Export

Allow export of structured analytical data as CSV.

At minimum support:

- case-level export;
- short-pick-line export;
- event export where authorized.

CSV must use normalized machine-readable fields.

---

# 66. Data Retention

Data is retained indefinitely until manually removed.

This applies to:

- cases;
- short-pick lines;
- events;
- messages;
- accounts;
- profile photos;
- configuration history;
- analytics source data.

Normal account lifecycle should prefer:

```text
DISABLED
ARCHIVED
```

instead of deletion.

Deletion functionality, where implemented, must respect relational integrity.

---

# 67. Database Deletion Safety

Do not cascade-delete operational history merely because a user is removed.

Historical events should preserve:

```text
actor_user_id
```

where possible.

If privacy requirements later require user anonymization, support anonymization without destroying warehouse-event history.

---

# 68. Suggested Technical Architecture

Preferred stack:

```text
Next.js
TypeScript
PostgreSQL
Drizzle ORM or Prisma
Tailwind CSS
PWA support
Railway
GitHub
```

A different equivalent stack is acceptable only if it preserves all requirements and reduces—not increases—complexity.

Prefer a modular monolith.

Do not build microservices for v1.

Suggested conceptual modules:

```text
auth
users
permissions
invites
cases
short-picks
checks
notifications
configuration
analytics
exports
localization
```

---

# 69. Deployment

Primary deployment target:

```text
Railway
```

Recommended Railway components:

```text
Web application
PostgreSQL database
```

Use environment variables for secrets.

Required environments:

```text
development
production
```

Optional:

```text
staging
```

Provide:

```text
/health
```

endpoint suitable for deployment health checking.

---

# 70. Environment Variables

Document required environment variables in `.env.example`.

Example categories:

```text
DATABASE_URL
APP_URL
SESSION_SECRET
PUSH_PUBLIC_KEY
PUSH_PRIVATE_KEY
PUSH_SUBJECT
STORAGE_*
```

Never commit secrets.

---

# 71. File Storage

Profile images and generated PDFs should use persistent object/file storage suitable for Railway deployment.

Do not store persistent user uploads only on ephemeral application filesystem.

Storage abstraction should allow later migration.

---

# 72. Database Migrations

Use tracked schema migrations.

Codex must not rely on manual production database edits.

Commands for:

```text
migrate
seed
reset development db
```

should be documented.

---

# 73. Seed Data

Development environment should include optional seed data.

Example users:

```text
Admin User
Team Leader Natalia
Assistant
Picker Daniel
Picker Lucas
Picker Seba
Troubleshooter
```

Use obviously fake/demo credentials.

Seed representative cases:

```text
PICKING with open line
PICKING with claimed check
PICKING with discovered location
STAGED case
resolved historical case
historically repeated order number
```

This is important for rapid visual testing.

---

# 74. API Design

Use strongly validated server APIs.

Every mutation must validate:

- authenticated session;
- permission;
- entity existence;
- current state;
- requested transition;
- concurrency/version where relevant.

Never trust client-submitted user IDs for authority.

Example:

Client must not be able to submit:

```text
actor_user_id = Admin
```

The backend obtains actor identity from authenticated session.

---

# 75. Validation

Use shared schemas where practical.

Recommended:

```text
Zod
```

or equivalent.

Validate:

- API bodies;
- query parameters;
- configuration values;
- form fields.

---

# 76. State Transition Enforcement

State transitions must be centralized in domain/service logic.

Do not scatter critical workflow logic among React components.

Bad:

```text
if (case.phase === ...)
```

implemented independently in many UI files.

Preferred:

```text
CaseService.stageCase()
CheckService.claimCheck()
ShortPickService.reportLocation()
RetrievalService.confirmRetrieval()
```

The service validates transition and writes event atomically.

---

# 77. Transactions

Use database transactions for operations such as:

- claim check;
- assign check;
- stage case;
- discover location + complete check;
- retrieve item;
- close case;
- reopen case;
- change configuration version.

State update and event creation should normally commit together.

Do not permit:

```text
state changed
event missing
```

or vice versa.

---

# 78. Concurrency Control

Expect simultaneous use.

Important races include:

- two workers claim same check;
- TL assigns while worker claims;
- picker stages while checker reports location;
- two people resolve same line;
- same order submitted simultaneously;
- duplicate short-pick line submitted twice.

Use:

- database uniqueness constraints;
- transactions;
- row locks where appropriate;
- optimistic versioning where appropriate.

Return useful conflict messages rather than generic 500 errors.

---

# 79. Error Handling

User-facing errors should explain what happened.

Examples:

```text
This check was claimed by Lucas a moment ago.
```

```text
Order 341151 already has an open case.
Opening it now.
```

```text
This case was updated by another user.
Refresh to see the latest state.
```

Do not expose stack traces or database errors to users.

---

# 80. Auditability

Security-sensitive actions should be auditable.

At minimum:

```text
user created
user disabled
PIN reset
permissions changed
invite created/revoked
configuration changed
case manually closed
case reopened
session revoked
```

These can use a dedicated audit table or structured system events.

---

# 81. UX Principles

Prioritize:

1. few taps;
2. large touch targets;
3. obvious status;
4. minimal text entry;
5. strong contrast;
6. immediate server confirmation;
7. no unnecessary navigation;
8. no hidden critical actions;
9. one-handed mobile use where practical.

Warehouse users should not need to understand system terminology such as:

```text
entity
workflow state
configuration version
```

Use operational language.

---

# 82. Mobile Input Requirements

All primary buttons should be suitable for gloved/warehouse use where practical.

Suggested minimum touch target:

```text
44 × 44 CSS px
```

Quantity controls should be larger.

Inputs should use correct keyboards:

```text
Order → numeric
Quantity → numeric
PIN → numeric
Location → text
SKU → text
```

Do not allow browser auto-capitalization to be the only uppercase mechanism.

Normalize programmatically.

---

# 83. Scanner Support

Scanning is a per-field input mechanism.

Do not create a separate global "scanner mode."

Example:

```text
Order
[scan icon] [input]

Location
[scan icon] [input]

SKU
[scan icon] [input]
```

Workers may mix scan and typing within one report.

Initial camera scanning can use browser capabilities, but MUST include a tested JavaScript decoder fallback when native `BarcodeDetector` is absent (notably iOS Safari), covering live camera and photo decode, rear-camera selection, lifecycle cleanup, camera-denial messaging, and retained manual entry. Acceptance requires a real iPhone Safari (and installed web-app) check scanning the actual warehouse order label twice in succession with Android still working; emulator-only proof is insufficient.

Also support keyboard-wedge scanners naturally by allowing focused inputs.

---

# 84. Accessibility

Use semantic controls.

Support:

- keyboard navigation;
- focus indicators;
- readable contrast;
- labels for icons;
- screen-reader-friendly forms;
- non-color-only status indicators.

Do not rely only on red/green.

---

# 85. Core Screens

Required v1 screens:

## Authentication

- Login
- Invitation registration
- Locked-out state

## Picker

- My Cases
- Report/Open Order
- Order Case Detail
- Add Short-Pick Line
- Available Checks if permitted
- My Checks
- Notifications
- Profile

## Troubleshooter

- Assigned Work
- Case Detail
- Line Detail
- Message Timeline
- Notifications
- Profile

## TL/Assistant

- Dashboard
- All Active Cases
- Case Detail
- Assign/Reassign
- Manual Case Creation
- Notifications
- User Management
- Invite Management
- Profile Photo Approval
- Analytics
- Reports
- Configuration, subject to permission

## Admin

All above plus unrestricted administration.

---

# 86. Case Detail Information Hierarchy

Top:

```text
ORDER 341151
PICKING
Daniel
18 min
```

Then shortages:

```text
03.AA.1
FF405D-42
Missing 1
Checking — Lucas
```

Then another line.

Then actions permitted to the current user.

Then timeline/messages.

Do not make the timeline dominate the picker interface.

---

# 87. Suggested Status Vocabulary

User-visible statuses should remain short.

Case:

```text
Picking
In Short Pick / Hold
Resolving
Closed
```

Line:

```text
Open
Checking
Found
Waiting for retrieval
Retrieved
Not found
Troubleshooting
Resolved
```

Internal enums may be more precise.

---

# 88. Analytics Performance

Do not prematurely build a data warehouse.

Use PostgreSQL queries/materialized aggregates only when necessary.

Initial warehouse volume should be handled by transactional DB plus indexed analytical queries.

Add indexes for:

```text
order_number
case phase
created_at
short_pick location
SKU
configuration version
responsible user
event timestamp
```

---

# 89. PDF Generation

PDF generation should happen server-side.

It must support:

- long tables;
- pagination;
- charts;
- filters;
- warehouse/company title;
- generation timestamp.

Do not block interactive request longer than necessary.

For v1, synchronous generation is acceptable if reasonably fast.

---

# 90. Logging

Provide structured server logs for:

- errors;
- failed auth;
- lockouts;
- notification failures;
- PDF generation failures;
- critical workflow conflicts.

Do not log:

- plaintext PINs;
- session secrets;
- invitation tokens in full;
- sensitive cookies.

---

# 91. Health Endpoint

`GET /health`

Should verify application process is alive.

Optionally verify DB connectivity separately.

Return simple machine-readable status.

Do not expose sensitive environment information.

---

# 92. Testing Requirements

At minimum implement:

## Unit tests

For:

- normalization;
- permissions;
- state transitions;
- responsibility routing;
- invitation expiration;
- PIN lockout;
- configuration version behavior.

## Integration tests

For:

- one-open-case invariant;
- check claiming race;
- assignment vs claim;
- discovered-location routing;
- case staging;
- closure/reopen;
- duplicate-order history;
- manual TL report.

## End-to-end tests

Critical workflows:

### Flow A — Simple picker case

```text
Picker logs in
→ reports order
→ adds short pick
→ location found
→ picker retrieves
→ closes case
```

### Flow B — Checker

```text
Picker reports line
→ checker claims
→ checker finds new location
→ picker receives notification
→ picker retrieves
```

### Flow C — Staged

```text
Picker reports shortages
→ checker fails
→ picker stages order
→ troubleshooter assigned
→ troubleshooter finds/retrieves
→ closes case
```

### Flow D — Multi-line

```text
Picker creates case
→ adds line A
→ checker claims A
→ picker adds B
→ A resolves
→ B remains open
```

### Flow E — Historical duplicate

```text
Closed historical case exists for order 341151
→ new scan of 341151
→ warning shown
→ authorized new occurrence created
```

### Flow F — Same-time claim

```text
Lucas and Seba claim same task
→ exactly one succeeds
```

---

# 93. Security Tests

Verify:

- expired invite cannot register;
- exhausted invite cannot register;
- revoked invite cannot register;
- picker cannot access user administration endpoint;
- Assistant cannot alter TL/Admin privileges;
- TL cannot alter Admin privileges;
- session cookie is HTTP-only;
- PIN hashes never exposed;
- disabled user loses access;
- session revocation works;
- repeated PIN failures cause temporary lockout.

---

# 94. Performance Targets

Normal user interactions should feel immediate.

Targets under normal load:

```text
page interaction response: < 500 ms where practical
simple API mutations: < 1 second
dashboard refresh/update: a few seconds maximum
```

Do not overengineer for massive scale.

Primary expected deployment is one warehouse/team.

---

# 95. Realtime Updates

Dashboard and relevant active case screens should receive updates without manual refresh.

Preferred options:

- Server-Sent Events;
- WebSockets;
- lightweight polling if materially simpler.

Choose the simplest reliable mechanism.

Realtime implementation must not make core actions dependent on a persistent connection.

If realtime disconnects:

- normal API actions continue;
- UI indicates stale/disconnected state;
- reconnect automatically.

---

# 96. PWA

Implement as installable PWA where practical.

Requirements:

- application manifest;
- app icon;
- standalone-capable presentation;
- service worker if needed for installation/push.

Do not implement offline mutation caching.

PWA installation is optional for users.

The application remains usable in normal mobile browser.

---

# 97. Build Phases

Codex should implement incrementally.

## Phase 1 — Foundation

Implement:

- project setup;
- PostgreSQL;
- migrations;
- authentication;
- persistent sessions;
- users;
- roles/permissions;
- invite registration;
- base localization;
- responsive shell.

Completion condition:

Users can securely register by invite and log in.

## Phase 2 — Core Case Workflow

Implement:

- OrderCase;
- ShortPickLine;
- duplicate-order detection;
- one-open-case invariant;
- picker case list;
- reporting;
- adding multiple shortages;
- case event log.

Completion condition:

Picker can manage multiple short-pick orders reliably.

## Phase 3 — Checking and Responsibility

Implement:

- check queue;
- claim;
- assignment;
- reassignment;
- discovered locations;
- retrieval;
- case responsibility;
- PICKING/STAGED behavior;
- concurrency protection.

Completion condition:

Complete checker edge cases work correctly.

## Phase 4 — TL/Troubleshooter Operations

Implement:

- dashboard;
- task assignment;
- manual case creation;
- troubleshooter interface;
- case messages;
- closure/reopen.

## Phase 5 — Notifications

Implement:

- in-app notifications;
- notification preferences;
- Web Push;
- responsibility routing.

## Phase 6 — Configuration

Implement:

- editable configuration;
- configuration versions;
- case configuration snapshots/version references;
- audit history.

## Phase 7 — Analytics and Export

Implement:

- dashboard analytics;
- filters;
- duplicate-order analytics;
- CSV;
- PDF.

## Phase 8 — Hardening

Implement/refine:

- tests;
- accessibility;
- performance;
- logs;
- security review;
- race-condition tests;
- deployment documentation;
- backup considerations.

---

# 98. Definition of Done for v1

The product is v1-ready when all of the following are true:

1. Unauthorized people cannot create accounts without valid invites.
2. Users can register with name and minimum six-digit PIN.
3. Sessions persist indefinitely until explicitly invalidated.
4. Permissions are enforced server-side.
5. Picker UI changes according to permissions.
6. Picker can manage several active orders.
7. Each order has only one open case.
8. A case can contain multiple shortage lines.
9. New shortages can be added while other shortages are being checked.
10. Check claiming is concurrency-safe.
11. Assigned checks cannot be claimed.
12. TL/Assistant/Admin can reassign checks.
13. New-location discovery is separate from retrieval.
14. While PICKING, retrieval responsibility routes to active picker.
15. While STAGED, retrieval can route to assigned resolver.
16. Physical staging is explicitly confirmed.
17. TL/Assistant can manually create a missing digital case.
18. Historical duplicate orders produce warnings.
19. Cases have immutable event history.
20. Complex cases support authorized free-text messages.
21. Responsibility notifications route to the correct user.
22. In-app notifications work even without push.
23. Configuration is versioned.
24. Configuration changes apply to new cases by default.
25. Dashboard works on desktop and mobile.
26. Analytics can be filtered.
27. CSV export works.
28. PDF report generation works.
29. English, Dutch, Polish and Spanish localization works.
30. Critical workflows have automated tests.
31. App deploys successfully to Railway.
32. Persistent uploads do not depend on ephemeral filesystem.
33. Production secrets are outside source control.

---

# 99. Implementation Rules for the Coding Agent

The coding agent must follow these rules.

### Rule 1
Do not invent warehouse workflow behavior when this PRD defines it.

### Rule 2
If implementation details are unspecified, choose the simplest conventional solution compatible with the requirements.

### Rule 3
Prefer explicit domain states over implicit UI assumptions.

### Rule 4
Critical permissions must always be enforced server-side.

### Rule 5
Critical workflow state changes and their audit events should be written atomically.

### Rule 6
Do not add Odoo integration.

### Rule 7
Do not add AI features.

### Rule 8
Do not build features merely because they may be useful later.

### Rule 9
Keep components and domain modules small enough to reason about.

### Rule 10
Use strict TypeScript.

### Rule 11
Avoid `any` unless technically unavoidable and documented.

### Rule 12
Every database schema change must have a migration.

### Rule 13
Every environment dependency must appear in `.env.example` and setup documentation.

### Rule 14
Every permission must have a clearly named constant/enumeration.

### Rule 15
Every state enum must be centrally defined.

### Rule 16
Use normalized values for matching order numbers, SKUs and locations.

### Rule 17
Do not silently merge or discard warehouse data.

### Rule 18
Do not use destructive deletion where archive/disable is more appropriate.

### Rule 19
Implement the build phases in sequence.

### Rule 20
At the end of each phase:
- run tests;
- run type checking;
- run linting;
- verify migrations;
- document known limitations.

---

# 100. Suggested Repository Structure

This is illustrative rather than mandatory:

```text
src/
  app/
    (auth)/
    picker/
    troubleshooter/
    operations/
    admin/

  components/
    cases/
    short-picks/
    checks/
    notifications/
    users/
    analytics/

  server/
    auth/
    permissions/
    cases/
    short-picks/
    checks/
    notifications/
    configuration/
    analytics/

  db/
    schema/
    migrations/

  domain/
    enums/
    transitions/
    permissions/
    normalization/

  i18n/
    en/
    nl/
    pl/
    es/

  lib/

tests/
  unit/
  integration/
  e2e/
```

Prefer separation by domain over one enormous service file.

---

# 101. Suggested Initial Database Invariants

Enforce or emulate these strongly:

```text
one active case per normalized order number

missing_quantity > 0

configuration version immutable after activation

case event immutable after creation

invitation registrations_used <= max_registrations

disabled users cannot create authenticated actions

one active claim/assignment per check task

resolved timestamp requires terminal state
```

---

# 102. Important Operational Examples

## Example 1 — Multiple shortages while picking

Daniel is picking order `341151`.

He reports:

```text
03.AA.1
FF405D-42
1 missing
```

Lucas claims the check.

Daniel continues picking.

Daniel then reports:

```text
07.BC.2
ABC100-L
2 missing
```

Result:

```text
Order 341151

Line 1
CHECKING — Lucas

Line 2
OPEN
```

Lucas has no automatic ownership of Line 2.

---

## Example 2 — Checker finds stock while order is moving

Lucas finds FF405D-42 at:

```text
05.CC.2
```

Order remains `PICKING`.

System:

```text
Line 1 → FOUND
Retrieval → PENDING
Retrieval responsible → Daniel
Lucas's check → COMPLETE
```

Daniel receives:

```text
FF405D-42 ×1 found at 05.CC.2
```

Daniel retrieves it.

---

## Example 3 — TL finds location while checker is active

Daniel owns order.

Lucas is checking Line 1.

Natalia reports:

```text
NEW LOCATION
05.CC.2
```

System:

```text
Lucas check → RESOLVED BY EXTERNAL LOCATION REPORT
Daniel → actionable retrieval notification
Lucas → informational notification
```

---

## Example 4 — Box moves to SHORT PICK / HOLD

Daniel cannot resolve remaining shortages.

He taps:

```text
ORDER PLACED IN SHORT PICK / HOLD
```

and confirms.

System:

```text
phase = STAGED
physical state = SHORT_PICK_HOLD
```

Relevant checkers receive update.

Troubleshooter may now retrieve found products and place them with the known box.

---

## Example 5 — Physical box exists without app case

Natalia sees order `341999` physically in SHORT PICK / HOLD.

No open digital case exists.

She creates:

```text
Order 341999
Location 04.BB.1
SKU XYZ-L
Missing 1
Reason: physical hold without digital report
```

System records:

```text
source = TL_MANUAL
phase = STAGED
```

This remains separately measurable in analytics.

---

## Example 6 — Duplicate months later

A case for `341151` was closed on 14 March.

Another case occurred 8 June.

On 26 September, Daniel scans `341151`.

There is no open case.

App shows:

```text
ORDER SEEN BEFORE

Previous occurrences:
14 Mar 2026
08 Jun 2026

[Cancel]
[Create new case]
```

If confirmed, a new case is created.

---

# 103. Final Product Principle

The software should model one operational truth:

> The order moves through the warehouse as one physical object, while its individual shortages may be investigated independently.

Everything else—permissions, responsibility, notifications, checks, staging, analytics and configuration—should support that model without making the picker workflow unnecessarily complicated.