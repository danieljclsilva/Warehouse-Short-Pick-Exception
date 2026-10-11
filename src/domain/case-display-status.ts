/**
 * Pure aggregate case display status for case-level badges (F6).
 *
 * Case headers must reflect ALL lines, never array order: a resolved first
 * line must not mask unresolved siblings. Precedence (coordinator decision):
 * CLOSED → RETRIEVAL_FAILED → CHECKING → WAITING_RETRIEVAL / RETRIEVING →
 * OPEN → READY_TO_CLOSE.
 *
 * Every returned code already has a localized badge label; this helper adds
 * no state enum and no user-facing text. Replenishment/phase badges stay
 * separate and are untouched.
 */

export type CaseAggregateStatus =
  | "CLOSED"
  | "RETRIEVAL_FAILED"
  | "CHECKING"
  | "RETRIEVING"
  | "WAITING_RETRIEVAL"
  | "OPEN"
  | "READY_TO_CLOSE";

export type AggregateLineInput = {
  readonly id?: string | null;
  readonly lineId?: string | null;
  readonly state?: string | null;
  readonly displayStatus?: string | null;
  readonly retrievalState?: string | null;
  readonly replenishmentState?: string | null;
};

export type AggregateProjectionInput = {
  readonly lineId?: string | null;
  readonly displayStatus?: string | null;
};

const codeOf = (value: string | null | undefined): string => (value ?? "").toUpperCase();

const TERMINAL_CODES: Record<string, true> = { RESOLVED: true, CANCELLED: true, RETRIEVED: true };
const PENDING_RETRIEVAL_CODES: Record<string, true> = { FOUND: true, FOUND_AT_ORIGINAL: true, WAITING_RETRIEVAL: true, RETRIEVAL_PENDING: true };
type ProjectionLookup = ReadonlyMap<string, AggregateProjectionInput | string | null | undefined>;


function projectionDisplayFor(
  projections: readonly AggregateProjectionInput[] | ProjectionLookup | null | undefined,
  lineId: string | null,
): string | null {
  if (!projections) return null;
  if (typeof (projections as ProjectionLookup).get === "function") {
    if (!lineId) return null;
    const entry = (projections as ProjectionLookup).get(lineId);
    if (!entry) return null;
    return typeof entry === "string" ? entry : (entry.displayStatus ?? null);
  }
  if (!lineId) return null;
  const list = projections as readonly AggregateProjectionInput[];
  for (const entry of list) {
    if (entry && entry.lineId === lineId && entry.displayStatus) return entry.displayStatus;
  }
  return null;
}

/**
 * Aggregate one case-level display status from the case phase and ALL lines.
 * Pure and order-independent: shuffling lines or projections never changes
 * the result. Pass server line projections so FOUND_AT_ORIGINAL and other
 * projected codes pair by lineId; bare line states work on their own.
 */
export function aggregateCaseDisplayStatus(
  phase: string | null | undefined,
  lines: readonly AggregateLineInput[] | null | undefined,
  projections?: readonly AggregateProjectionInput[] | ProjectionLookup | null,
): CaseAggregateStatus {
  if (codeOf(phase) === "CLOSED") return "CLOSED";
  const rows = lines ?? [];
  // No line evidence on an open case must never read as ready; prompt work.
  if (!rows.length) return "OPEN";
  let failed = false;
  let checking = false;
  let retrieving = false;
  let pending = false;
  let open = false;
  rows.forEach((line) => {
    const lineId = line?.id ?? line?.lineId ?? null;
    const state = codeOf(line?.state);
    const display = codeOf(projectionDisplayFor(projections, lineId) ?? line?.displayStatus);
    const retrieval = codeOf(line?.retrievalState);
    if (TERMINAL_CODES[state]) return;
    // A stale terminal projection must never close a line whose main state
    // is still nonterminal; only lines without a main state fall back to it.
    if (!state && TERMINAL_CODES[display]) return;
    // Likewise a stale RETRIEVED flag must not resolve nonterminal work.
    if (!state && retrieval === "RETRIEVED") return;
    if (retrieval === "FAILED" || display === "RETRIEVAL_FAILED") { failed = true; return; }
    // A completed replenishment preserves main CHECKING but hides it from the
    // check queue while its retrieval obligation is PENDING/IN_PROGRESS/FAILED.
    // Suppress raw CHECKING for that line so the retrieval classification wins;
    // a sibling with a genuine CHECKING still dominates ordinary pending work.
    const replenCompleted = codeOf(line?.replenishmentState) === "COMPLETED";
    const retrievalObligation = retrieval === "PENDING" || retrieval === "IN_PROGRESS" || retrieval === "FAILED";
    const projectedRetrieval = PENDING_RETRIEVAL_CODES[display] || display === "RETRIEVING" || display === "RETRIEVAL_FAILED";
    if (!replenCompleted || (!retrievalObligation && !projectedRetrieval)) {
      if (state === "CHECKING" || display === "CHECKING") { checking = true; return; }
    }
    if (state === "RETRIEVING" || display === "RETRIEVING" || retrieval === "IN_PROGRESS") { retrieving = true; return; }
    if (state === "FOUND" || PENDING_RETRIEVAL_CODES[display] || retrieval === "PENDING") { pending = true; return; }
    open = true;
  });
  if (failed) return "RETRIEVAL_FAILED";
  if (checking) return "CHECKING";
  if (retrieving) return "RETRIEVING";
  if (pending) return "WAITING_RETRIEVAL";
  if (open) return "OPEN";
  return "READY_TO_CLOSE";
}
