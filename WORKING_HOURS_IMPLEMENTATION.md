# Working-hours case clock — 2026-10-12

Implemented through OMP from two scoped implementation briefs and a focused test-repair brief, with independent coordinator review. The user confirmed Monday–Friday. The PRD §54A records the behavior.

## Behavior and configuration

In Configuration → Working hours, authorized configuration managers can select working weekdays and same-day start/end times. Defaults are Monday–Friday, 08:00–17:00, Europe/Amsterdam. Opening is inclusive and closing exclusive. Amsterdam summer/winter time applies regardless of browser/server timezone. At least one unique ISO weekday (1=Monday through 7=Sunday) and a valid HH:mm start earlier than the end are required. Server validation, expected-version conflict checks, permission checks and atomic configuration/audit writes remain authoritative.

Keys: WORKING_HOURS_TIME_ZONE, WORKING_HOURS_DAYS, WORKING_HOURS_START, WORKING_HOURS_END. The timezone is fixed to Europe/Amsterdam in this release. Settings live in existing configuration-version JSON; no schema change, migration or environment variable is required.

Cases retain their pinned configuration version. Older versions missing the new keys read as the default schedule without rewriting immutable JSON or timestamps. Later schedule edits apply to new cases. Existing-case schedule migration is not introduced. Previously generated PDF artifacts remain unchanged; newly generated historical reports use the working-time calculation.

Friday 16:30 → Monday 08:30 counts as **60 minutes**. After-close submissions remain at zero until the next opening. Closed-case clocks end at resolvedAt. Reopened cases keep the existing createdAt-to-latest-resolution timing model; closed intervals are not separately subtracted.

## Implementation contracts

- `src/domain/working-hours.ts` is browser-safe and shared by server/UI. It calculates overlap of actual instants with local working windows, preserves milliseconds, handles skipped/repeated DST minutes, and uses a bounded cache of date windows for historical queries. No stored ticking counters or changes to audit timestamps.
- Case detail, active lists, history and dashboard DTOs include `workingHours` and `elapsedWorkingMinutes`. Shared elapsed formatting receives the case's schedule and resolution timestamp. Dashboard age/attention and the global over-threshold count use each case's pinned schedule; the global calculation remains independent of pagination.
- Unresolved-over-threshold monitoring uses working age and only emits during the case's working window. Mandatory assignment/responsibility notifications remain immediate. Existing recipient preferences, dedupe and transaction guards remain in place.
- Analytics calculate report-to-claim, report-to-location, report-to-retrieval and report-to-resolution medians on the owning case's schedule. Threshold counts use working elapsed time. Calendar date filters, event timestamps and volume grouping remain calendar-based.
- Case CSV adds `elapsed_working_seconds`, timezone, ISO weekdays, start and end columns. PDF and analytics UI describe working time under pinned schedules. Backlog buckets explicitly use <24, 24–72, 72–168 and 168+ working hours, not scheduled working days.
- Configuration controls, validation and report wording support English, Dutch, Polish and Spanish. Existing custom permission grants and revocations are unchanged.

## Validation

- **62 files / 431 tests pass** on a freshly migrated, owned disposable PostgreSQL database, removed after testing. Includes opening/closing edges, nights/weekends, both DST changes and custom Sunday repeated/skipped hours, exact millisecond overlap, custom schedules, closed-clock freezing, invalid configuration HTTP 400s, configuration audit/snapshot preservation, actual monitoring off-hours/during-hours/dedupe, dashboard page invariance, analytics medians and CSV fields.
- Type checking, lint, production build and Drizzle consistency pass. Critical HTTP A–F and security acceptance pass against their own disposable databases.
- Browser plugin not available; Chrome Playwright CLI used at 1280×900 and 390×844 against an isolated local QA database. Verified default controls, empty-day/reversed-time validation, saved schedule/reload, older-case snapshot preservation and closed Friday-to-Monday elapsed time of 1h. Page identity/content, framework overlay absence, page-error health and interaction checks pass. Expected unauthenticated session probe 401 appears before login. Mobile screenshots wait for the navigation transition to settle before layout verification.
- Independent historical-query smoke test: 100 ten-year calculations completed in approximately 223 ms on this workstation with the bounded cache (initial un-cached implementation took about 3.6 seconds). This is a smoke check, not a production load guarantee.

## Limits and release instructions

No holiday calendar, overnight shift, multiple daily windows or selectable timezone is included. Existing closed-interval/reopen semantics are preserved. Phase 8 physical-device/scanner and operational acceptance remain open.

The user authorized commit, push and production deployment on 2026-10-12 after local verification. Deploy the web service and notification emitter together so both use the same working clock. No manual database changes are needed. Review working-hour settings before creating cases under a changed schedule; existing cases keep their previous snapshot.
