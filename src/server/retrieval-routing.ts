import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type * as schema from "@/db/schema";
import { auditLog, caseEvents, checkTasks, shortPickLines, users } from "@/db/schema";
import { getConfigurationVersion } from "@/server/configuration";
import { insertResponsibilityNotification } from "@/server/notifications";

/**
 * Converged retrieval routing (F3/F4/F9).
 *
 * Single owner selector + transaction-aware loader shared by check completion,
 * external discovery, staging, and return-to-picking. Every candidate owner
 * must be ACTIVE with CONFIRM_RETRIEVAL regardless of role; anything else is
 * never selected.
 *
 * operations.ts uses the same updater for resolver transfer and REDERIVE:
 * ```ts
 * await getDb().transaction(async (tx) => {
 *   const [record] = await tx.select().from(orderCases)
 *     .where(eq(orderCases.id, caseId)).for("update").limit(1);
 *   // ... apply the override/repair state change to `record` first ...
 *   await rerouteCaseRetrievals(tx, {
 *     caseRecord: record, // persisted row AFTER the state change, under the row lock
 *     actorUserId: auth.user.id,
 *     reason: "OVERRIDE_REDERIVE",
 *     preserveEligibleManualOwner: true, // keep explicit manager line assignments
 *   });
 * });
 * ```
 * `reason` is stored as `details.source` on each RETRIEVAL_ASSIGNED event and in
 * the audit row. `preserveEligibleManualOwner` keeps a still-eligible owner put
 * in place by assignRetrieval (detected via its event source marker); a real
 * return-to-picking passes false so the picker rule applies.
 */

/** Drizzle transaction client shared by the retrieval call sites. */
export type RetrievalTx = PgTransaction<PostgresJsQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;

export type RetrievalPhase = "PICKING" | "STAGED" | "CLOSED";

export interface RetrievalCandidate {
  id: string;
  status: string;
  permissions: readonly string[];
}

export interface SelectRetrievalOwnerInput {
  phase: RetrievalPhase | string;
  picker: RetrievalCandidate | null;
  resolver: RetrievalCandidate | null;
  checker: RetrievalCandidate | null;
  /** Task-specific latest CHECK_ASSIGNED/CHECK_REASSIGNED pickerRetrieval=true. */
  explicitPickerOverride: boolean;
  checkerDuringPickingEnabled: boolean;
  checkerWhenStagedEnabled: boolean;
}

export function isEligibleRetrievalOwner(candidate: RetrievalCandidate | null | undefined): candidate is RetrievalCandidate {
  return !!candidate && candidate.status === "ACTIVE" && candidate.permissions.includes("CONFIRM_RETRIEVAL");
}

/**
 * Pure owner selection. Explicit picker override wins in every open phase and
 * only ever yields the eligible picker (else null). PICKING prefers the
 * eligible originating checker only when configured, falling back to the
 * eligible picker. STAGED prefers the eligible explicitly assigned case
 * resolver (responsible differs from picker) independently of checker config,
 * then the eligible checker only when configured, else null: the default case
 * picker is never an implicit staged owner.
 */
export function selectRetrievalOwner(input: SelectRetrievalOwnerInput): string | null {
  const picker = isEligibleRetrievalOwner(input.picker) ? input.picker : null;
  const resolver = isEligibleRetrievalOwner(input.resolver) ? input.resolver : null;
  const checker = isEligibleRetrievalOwner(input.checker) ? input.checker : null;
  if (input.phase !== "PICKING" && input.phase !== "STAGED") return null;
  if (input.explicitPickerOverride) return picker ? picker.id : null;
  if (input.phase === "PICKING") {
    if (input.checkerDuringPickingEnabled && checker) return checker.id;
    return picker ? picker.id : null;
  }
  if (resolver && resolver.id !== input.picker?.id) return resolver.id;
  if (input.checkerWhenStagedEnabled && checker) return checker.id;
  return null;
}

export interface CaseRoutingRef {
  id: string;
  orderNumber: string;
  phase: string;
  pickingUserId: string | null;
  currentCaseResponsibleUserId: string | null;
  configurationVersionId: string;
  /** Extra persisted columns (physical state, timestamps) pass through untouched. */
  [extra: string]: unknown;
}

export interface RoutingConfig {
  checkerDuringPickingEnabled: boolean;
  checkerWhenStagedEnabled: boolean;
}

/** Case-snapshot routing flags; missing snapshots fall back to safe defaults. */
export async function loadRoutingConfig(tx: RetrievalTx, configurationVersionId: string): Promise<RoutingConfig> {
  const snapshot = await getConfigurationVersion(tx, configurationVersionId);
  return {
    checkerDuringPickingEnabled: snapshot?.values.CHECKER_RETRIEVAL_DURING_PICKING_ENABLED ?? false,
    checkerWhenStagedEnabled: snapshot?.values.CHECKER_RETRIEVAL_WHEN_STAGED_ENABLED ?? true,
  };
}

export async function loadCandidate(tx: RetrievalTx, userId: string | null | undefined): Promise<RetrievalCandidate | null> {
  if (!userId) return null;
  const [row] = await tx.select({ id: users.id, status: users.status, permissions: users.permissions })
    .from(users).where(eq(users.id, userId)).limit(1);
  return row ? { id: row.id, status: row.status, permissions: row.permissions } : null;
}

/** Latest COMPLETED check with a found code is the origin for an existing found line. */
export async function loadOriginCheck(tx: RetrievalTx, lineId: string): Promise<{ taskId: string; checkerUserId: string | null } | null> {
  const [row] = await tx.select({
    id: checkTasks.id, assignedToUserId: checkTasks.assignedToUserId, claimedByUserId: checkTasks.claimedByUserId,
  }).from(checkTasks).where(and(
    eq(checkTasks.shortPickLineId, lineId),
    eq(checkTasks.status, "COMPLETED"),
    inArray(checkTasks.completionCode, ["FOUND", "FOUND_AT_ORIGINAL"]),
  )).orderBy(desc(checkTasks.completedAt), desc(checkTasks.createdAt), desc(checkTasks.id)).limit(1);
  if (!row) return null;
  return { taskId: row.id, checkerUserId: row.assignedToUserId ?? row.claimedByUserId ?? null };
}

export async function loadTaskChecker(tx: RetrievalTx, taskId: string): Promise<string | null> {
  const [row] = await tx.select({ assignedToUserId: checkTasks.assignedToUserId, claimedByUserId: checkTasks.claimedByUserId })
    .from(checkTasks).where(eq(checkTasks.id, taskId)).limit(1);
  return row ? (row.assignedToUserId ?? row.claimedByUserId ?? null) : null;
}

/**
 * Task-specific explicit picker override. The taskId predicate runs in SQL
 * (details->>'taskId' = origin) BEFORE ordering, so only the latest event for
 * the origin task decides: absent pickerRetrieval (or no match) means false
 * and never falls back to an older row. Never scans unbounded history.
 */
export async function loadExplicitPickerOverride(
  tx: RetrievalTx, caseId: string, lineId: string, originTaskId: string | null,
): Promise<boolean> {
  if (!originTaskId) return false;
  const [row] = await tx.select({ details: caseEvents.details }).from(caseEvents).where(and(
    eq(caseEvents.caseId, caseId),
    eq(caseEvents.shortPickLineId, lineId),
    inArray(caseEvents.eventType, ["CHECK_ASSIGNED", "CHECK_REASSIGNED"]),
    sql`${caseEvents.details}->>'taskId' = ${originTaskId}`,
  )).orderBy(desc(caseEvents.createdAt), desc(caseEvents.id)).limit(1);
  const details: unknown = row?.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  if (!("pickerRetrieval" in details)) return false;
  const flag: unknown = details.pickerRetrieval;
  return flag === true;
}

export interface ResolveRetrievalOwnerArgs {
  caseRecord: CaseRoutingRef;
  lineId: string;
  config: RoutingConfig;
  /** In-flight task context (completion/discovery); omit to load the origin check. */
  originTaskId?: string | null;
  /** undefined = load it; null = known to have no checker. */
  originCheckerId?: string | null;
  /** Used only when no origin checker resolves (external discovery finder). */
  fallbackCheckerId?: string | null;
  /** Precomputed task-specific override; undefined = load it from events. */
  explicitPickerOverride?: boolean;
}

/** Loads picker/resolver/checker candidates plus the task-specific override, then selects. */
export async function resolveRetrievalOwner(tx: RetrievalTx, args: ResolveRetrievalOwnerArgs): Promise<string | null> {
  let taskId: string | null = args.originTaskId ?? null;
  let checkerId: string | null;
  if (taskId && args.originCheckerId !== undefined) {
    checkerId = args.originCheckerId;
  } else if (taskId) {
    checkerId = await loadTaskChecker(tx, taskId);
  } else {
    const origin = await loadOriginCheck(tx, args.lineId);
    taskId = origin?.taskId ?? null;
    checkerId = origin?.checkerUserId ?? null;
  }
  // External-discovery fallback: the origin task may be AVAILABLE/unassigned
  // (or no task exists), so no originating checker resolves. The persisted
  // finder survives staging rederives that otherwise lose the in-flight
  // fallbackCheckerId. Eligibility still gates selection downstream.
  if (!checkerId && !args.fallbackCheckerId) {
    const [line] = await tx.select({ discoveredByUserId: shortPickLines.discoveredByUserId })
      .from(shortPickLines).where(eq(shortPickLines.id, args.lineId)).limit(1);
    if (line?.discoveredByUserId) checkerId = line.discoveredByUserId;
  }
  if (!checkerId && args.fallbackCheckerId) checkerId = args.fallbackCheckerId;
  const [picker, resolver, checker] = await Promise.all([
    loadCandidate(tx, args.caseRecord.pickingUserId),
    loadCandidate(tx, args.caseRecord.currentCaseResponsibleUserId),
    loadCandidate(tx, checkerId),
  ]);
  const explicitPickerOverride = args.explicitPickerOverride ?? await loadExplicitPickerOverride(tx, args.caseRecord.id, args.lineId, taskId);
  return selectRetrievalOwner({
    phase: args.caseRecord.phase,
    picker,
    resolver,
    checker,
    explicitPickerOverride,
    checkerDuringPickingEnabled: args.config.checkerDuringPickingEnabled,
    checkerWhenStagedEnabled: args.config.checkerWhenStagedEnabled,
  });
}

/** Marker written by assignRetrieval so rederive can preserve explicit manager assignments. */
export const MANUAL_RETRIEVAL_ASSIGNMENT_SOURCE = "MANUAL_RETRIEVAL_ASSIGNMENT";

export interface RerouteArgs {
  /** Persisted case row AFTER the caller's phase change, under the case-row lock. */
  caseRecord: CaseRoutingRef;
  actorUserId: string;
  /** Event/audit source marker, e.g. "STAGED" or "RETURNED_TO_PICKING". */
  reason: string;
  /** Keep a still-eligible explicitly assigned owner when recomputation would clear it. */
  preserveEligibleManualOwner?: boolean;
  config?: RoutingConfig;
  /** Optional override scope; other lines in the case remain untouched. */
  lineIds?: readonly string[];
}

export interface RerouteLineResult {
  lineId: string;
  previousOwnerId: string | null;
  ownerId: string | null;
  changed: boolean;
}

/**
 * Reroutes every nonterminal line carrying a PENDING/FAILED retrieval
 * obligation (covers both found codes and any replenishment-COMPLETED
 * obligation already materialized as PENDING/FAILED). RETRIEVED and terminal
 * lines are never touched. Owner changes update line responsibility/version,
 * write event + audit, and notify the new non-null owner via the existing
 * responsibility helper (normal push enqueue) — all in the caller's
 * transaction.
 */
export async function rerouteCaseRetrievals(tx: RetrievalTx, args: RerouteArgs): Promise<RerouteLineResult[]> {
  const config = args.config ?? await loadRoutingConfig(tx, args.caseRecord.configurationVersionId);
  const lines = await tx.select().from(shortPickLines).where(eq(shortPickLines.caseId, args.caseRecord.id));
  const now = new Date();
  const results: RerouteLineResult[] = [];
  for (const line of lines) {
    if (args.lineIds && !args.lineIds.includes(line.id)) continue;
    if (line.retrievalState !== "PENDING" && line.retrievalState !== "FAILED") continue;
    if (line.state === "RESOLVED" || line.state === "CANCELLED") continue;
    const ownerId = await resolveRetrievalOwner(tx, { caseRecord: args.caseRecord, lineId: line.id, config });
    // Explicit manager assignments survive STAGED rederives while the marked
    // owner stays eligible, regardless of the recomputed owner. PICKING never
    // preserves: return-to-picking passes false and follows the picker rule.
    if (ownerId !== line.retrievalResponsibleUserId && args.preserveEligibleManualOwner && args.caseRecord.phase === "STAGED") {
      const [lastAssignment] = await tx.select({ details: caseEvents.details }).from(caseEvents).where(and(
        eq(caseEvents.caseId, args.caseRecord.id),
        eq(caseEvents.shortPickLineId, line.id),
        eq(caseEvents.eventType, "RETRIEVAL_ASSIGNED"),
      )).orderBy(desc(caseEvents.createdAt), desc(caseEvents.id)).limit(1);
      const marker: unknown = lastAssignment?.details;
      if (marker && typeof marker === "object" && !Array.isArray(marker) && "source" in marker
        && marker.source === MANUAL_RETRIEVAL_ASSIGNMENT_SOURCE
        && isEligibleRetrievalOwner(await loadCandidate(tx, line.retrievalResponsibleUserId))) {
        results.push({ lineId: line.id, previousOwnerId: line.retrievalResponsibleUserId, ownerId: line.retrievalResponsibleUserId, changed: false });
        continue;
      }
    }
    if (ownerId === line.retrievalResponsibleUserId) {
      results.push({ lineId: line.id, previousOwnerId: line.retrievalResponsibleUserId, ownerId, changed: false });
      continue;
    }
    await tx.update(shortPickLines).set({
      retrievalResponsibleUserId: ownerId, currentResponsibleUserId: ownerId,
      updatedAt: now, version: sql`${shortPickLines.version} + 1`,
    }).where(eq(shortPickLines.id, line.id));
    await tx.insert(caseEvents).values({
      caseId: args.caseRecord.id, shortPickLineId: line.id, actorUserId: args.actorUserId, eventType: "RETRIEVAL_ASSIGNED",
      details: { responsibleUserId: ownerId, previousUserId: line.retrievalResponsibleUserId, casePhase: args.caseRecord.phase, source: args.reason },
    });
    await tx.insert(auditLog).values({
      actorUserId: args.actorUserId, action: "RETRIEVAL_ASSIGNED",
      details: { caseId: args.caseRecord.id, lineId: line.id, responsibleUserId: ownerId, previousUserId: line.retrievalResponsibleUserId, reason: args.reason },
    });
    if (ownerId) {
      const physicalLocation: unknown = args.caseRecord.physicalLocation;
      await insertResponsibilityNotification(tx, {
        recipientUserId: ownerId, type: "RESPONSIBILITY_RETRIEVAL_ASSIGNED",
        caseId: args.caseRecord.id, shortPickLineId: line.id,
        payload: { orderNumber: args.caseRecord.orderNumber, reassigned: true, casePhase: args.caseRecord.phase,
          discoveredLocation: line.discoveredLocation ?? null, originalLocation: line.originalLocation,
          location: line.discoveredLocation ?? line.originalLocation,
          ...(args.caseRecord.phase === "STAGED" && typeof physicalLocation === "string" && physicalLocation.length > 0 ? { physicalLocation } : {}) },
      });
    }
    results.push({ lineId: line.id, previousOwnerId: line.retrievalResponsibleUserId, ownerId, changed: true });
  }
  return results;
}
