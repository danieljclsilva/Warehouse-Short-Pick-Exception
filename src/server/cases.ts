import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, caseEvents, caseMessages, checkTasks, orderCases, shortPickLines, users } from "@/db/schema";
import type { AuthContext } from "@/server/auth";
import { hasAuthPermission } from "@/server/auth";
import { insertMonitoringNotifications } from "@/server/notifications";
import { getCurrentConfiguration } from "@/server/configuration";
import { CaseApiError } from "@/server/case-errors";

export const orderNumberSchema = z.string().trim().regex(/^\d+$/, "Order number must contain digits only").max(64);
export const lookupOrderSchema = z.object({ orderNumber: orderNumberSchema });
export const addLineSchema = z.object({
  location: z.string().trim().min(1).max(128).transform((value) => value.toUpperCase()),
  sku: z.string().trim().min(1).max(128).transform((value) => value.toUpperCase()),
  quantity: z.number().int().positive().max(1_000_000),
  confirmDuplicate: z.boolean().default(false),
});
export const createCaseSchema = z.object({
  orderNumber: orderNumberSchema,
  firstLine: addLineSchema.omit({ confirmDuplicate: true }),
  confirmedHistoricalCaseIds: z.array(z.string().uuid()).max(1000).default([]),
});

export { CaseApiError } from "@/server/case-errors";

export function normalizeOrderNumber(value: string) {
  return orderNumberSchema.parse(value);
}

const isOpen = ne(orderCases.phase, "CLOSED");

async function readCase(db: Pick<ReturnType<typeof getDb>, "select">, caseId: string, includeMessages: boolean) {
  const [record] = await db.select().from(orderCases).where(eq(orderCases.id, caseId)).limit(1);
  if (!record) return null;
  const lines = await db.select().from(shortPickLines).where(eq(shortPickLines.caseId, caseId)).orderBy(shortPickLines.createdAt, shortPickLines.id);
  const checks = lines.length ? await db.select().from(checkTasks).where(inArray(checkTasks.shortPickLineId, lines.map((line) => line.id))).orderBy(checkTasks.createdAt, checkTasks.id) : [];
  const events = await db.select({ id: caseEvents.id, shortPickLineId: caseEvents.shortPickLineId, actorUserId: caseEvents.actorUserId, actorName: users.displayName, eventType: caseEvents.eventType, details: caseEvents.details, createdAt: caseEvents.createdAt })
    .from(caseEvents).leftJoin(users, eq(caseEvents.actorUserId, users.id)).where(eq(caseEvents.caseId, caseId)).orderBy(caseEvents.createdAt, caseEvents.id);
  const messages = includeMessages ? await db.select({ id: caseMessages.id, shortPickLineId: caseMessages.shortPickLineId, authorUserId: caseMessages.authorUserId, authorName: users.displayName, message: caseMessages.message, createdAt: caseMessages.createdAt })
    .from(caseMessages).innerJoin(users, eq(caseMessages.authorUserId, users.id)).where(eq(caseMessages.caseId, caseId)).orderBy(caseMessages.createdAt, caseMessages.id) : [];
  const personIds = [record.pickingUserId, record.currentCaseResponsibleUserId].filter((id): id is string => Boolean(id));
  const people = personIds.length ? await db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, personIds)) : [];
  const names = new Map(people.map((person) => [person.id, person.displayName]));
  const unresolvedLines = lines.filter((line) => line.state !== "RESOLVED" && line.state !== "CANCELLED");
  const checkingCount = lines.filter((line) => line.state === "CHECKING").length;
  const currentIssue = lines.some((line) => line.retrievalState === "FAILED") ? "RETRIEVAL_FAILED"
    : lines.some((line) => line.state === "FOUND") ? "RETRIEVAL_PENDING"
      : checkingCount ? "CHECKING" : unresolvedLines.length ? "OPEN" : "READY_TO_CLOSE";
  return { ...record, pickerName: record.pickingUserId ? names.get(record.pickingUserId) ?? null : null,
    responsibleName: record.currentCaseResponsibleUserId ? names.get(record.currentCaseResponsibleUserId) ?? null : null,
    missingCount: unresolvedLines.reduce((total, line) => total + line.missingQuantity, 0), checkingCount, currentIssue,
    lines: lines.map((line) => ({ ...line, location: line.originalLocation, quantity: line.missingQuantity })), checks, events, messages };
}

function canReadCase(auth: AuthContext, row: typeof orderCases.$inferSelect) {
  return hasAuthPermission(auth, "VIEW_ALL_OPEN_CASES")
    || (row.pickingUserId === auth.user.id && hasAuthPermission(auth, "VIEW_OWN_CASES"));
}

export async function hasCurrentCaseResponsibility(
  db: Pick<ReturnType<typeof getDb>, "select">,
  auth: AuthContext,
  row: typeof orderCases.$inferSelect,
) {
  if (row.currentCaseResponsibleUserId === auth.user.id) return true;
  const [retrieval] = await db.select({ id: shortPickLines.id }).from(shortPickLines).where(and(
    eq(shortPickLines.caseId, row.id), eq(shortPickLines.retrievalResponsibleUserId, auth.user.id),
    eq(shortPickLines.state, "FOUND"), inArray(shortPickLines.retrievalState, ["PENDING", "FAILED"]),
  )).limit(1);
  if (retrieval) return true;
  const [check] = await db.select({ id: checkTasks.id }).from(checkTasks).innerJoin(shortPickLines, eq(checkTasks.shortPickLineId, shortPickLines.id))
    .where(and(eq(shortPickLines.caseId, row.id), eq(shortPickLines.state, "CHECKING"), inArray(checkTasks.status, ["CLAIMED", "ASSIGNED"]),
      sql`(${checkTasks.claimedByUserId} = ${auth.user.id} OR ${checkTasks.assignedToUserId} = ${auth.user.id})`)).limit(1);
  return Boolean(check);
}

export async function lookupOrder(auth: AuthContext, rawOrderNumber: string) {
  const orderNumber = normalizeOrderNumber(rawOrderNumber);
  const db = getDb();
  const [open] = await db.select().from(orderCases).where(and(eq(orderCases.orderNumber, orderNumber), isOpen)).limit(1);
  if (open) {
    if (!canReadCase(auth, open)) throw new CaseApiError("OPEN_CASE_NOT_ACCESSIBLE", "An open case exists for this order, but you cannot access it", 403);
    return { kind: "OPEN" as const, case: await readCase(db, open.id, hasAuthPermission(auth, "VIEW_CASE_MESSAGES")) };
  }
  const history = await db.select({ id: orderCases.id, createdAt: orderCases.createdAt, phase: orderCases.phase })
    .from(orderCases).where(eq(orderCases.orderNumber, orderNumber)).orderBy(desc(orderCases.createdAt));
  return history.length
    ? { kind: "HISTORY" as const, normalizedOrderNumber: orderNumber, history }
    : { kind: "NEW" as const, normalizedOrderNumber: orderNumber };
}

export async function createCase(auth: AuthContext, rawOrderNumber: string, confirmedHistoricalCaseIds: string[], firstLine: z.infer<typeof createCaseSchema>["firstLine"]) {
  const orderNumber = normalizeOrderNumber(rawOrderNumber);
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    // Serialize all create attempts for this normalized identifier; the partial unique index remains the final invariant.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`order-case:${orderNumber}`}))`);
    const [open] = await tx.select().from(orderCases).where(and(eq(orderCases.orderNumber, orderNumber), isOpen)).limit(1);
    if (open) return { kind: "OPEN_EXISTS" as const, caseId: open.id, accessible: canReadCase(auth, open) };
    const history = await tx.select({ id: orderCases.id, createdAt: orderCases.createdAt, phase: orderCases.phase })
      .from(orderCases).where(eq(orderCases.orderNumber, orderNumber)).orderBy(desc(orderCases.createdAt));
    const expectedIds = history.map((row) => row.id).sort();
    const confirmedIds = [...new Set(confirmedHistoricalCaseIds)].sort();
    if (expectedIds.length !== confirmedIds.length || expectedIds.some((id, index) => id !== confirmedIds[index])) {
      return { kind: "HISTORY_CONFIRMATION_REQUIRED" as const, history };
    }
    const configuration = await getCurrentConfiguration(tx);
    const [created] = await tx.insert(orderCases).values({ orderNumber, pickingUserId: auth.user.id, currentCaseResponsibleUserId: auth.user.id, createdByUserId: auth.user.id, source: "PICKER_REPORT", configurationVersionId: configuration.id }).returning();
    const [line] = await tx.insert(shortPickLines).values({
      caseId: created!.id, originalLocation: firstLine.location, sku: firstLine.sku,
      missingQuantity: firstLine.quantity, reportedByUserId: auth.user.id,
    }).returning({ id: shortPickLines.id });
    await tx.insert(checkTasks).values({ shortPickLineId: line!.id });
    await tx.insert(caseEvents).values({ caseId: created!.id, actorUserId: auth.user.id, eventType: "CASE_CREATED", details: { orderNumber, source: "PICKER_REPORT" } });
    await tx.insert(caseEvents).values({ caseId: created!.id, shortPickLineId: line!.id, actorUserId: auth.user.id, eventType: "SHORT_PICK_LINE_ADDED", details: { lineId: line!.id, location: firstLine.location, sku: firstLine.sku, quantity: firstLine.quantity } });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: "CASE_CREATED", details: { caseId: created!.id, orderNumber, source: "PICKER_REPORT" } });
    await insertMonitoringNotifications(tx, { type: "NEW_SHORT_PICK", caseId: created!.id, shortPickLineId: line!.id,
      payload: { orderNumber, location: firstLine.location, sku: firstLine.sku, quantity: firstLine.quantity }, excludeUserId: auth.user.id });
    return { kind: "CREATED" as const, caseId: created!.id };
  });
  if (result.kind === "OPEN_EXISTS") {
    if (!result.accessible) throw new CaseApiError("OPEN_CASE_NOT_ACCESSIBLE", "An open case exists for this order, but you cannot access it", 403);
    throw new CaseApiError("OPEN_CASE_EXISTS", "An open case already exists for this order", 409, { case: await readCase(db, result.caseId, hasAuthPermission(auth, "VIEW_CASE_MESSAGES")) });
  }
  if (result.kind === "HISTORY_CONFIRMATION_REQUIRED") throw new CaseApiError("HISTORICAL_CONFIRMATION_REQUIRED", "Confirm the current historical cases before creating another case", 409, { history: result.history });
  return readCase(db, result.caseId, hasAuthPermission(auth, "VIEW_CASE_MESSAGES"));
}

export async function addCaseLine(auth: AuthContext, caseId: string, input: z.infer<typeof addLineSchema>) {
  const db = getDb();
  const normalizedLocation = input.location.trim().toUpperCase();
  const normalizedSku = input.sku.trim().toUpperCase();
  const result = await db.transaction(async (tx) => {
    // Locking the case row serializes concurrent line submissions before duplicate detection.
    const [record] = await tx.select().from(orderCases).where(eq(orderCases.id, caseId)).for("update").limit(1);
    if (!record) throw new CaseApiError("CASE_NOT_FOUND", "Case not found", 404);
    const canManage = hasAuthPermission(auth, "REPORT_SHORT_PICK") && (
      (record.pickingUserId === auth.user.id && hasAuthPermission(auth, "VIEW_OWN_CASES"))
      || hasAuthPermission(auth, "VIEW_ALL_OPEN_CASES")
    );
    if (!canManage) {
      throw new CaseApiError("CASE_ACCESS_DENIED", "You cannot add lines to this case", 403);
    }
    if (record.phase !== "PICKING") throw new CaseApiError("CASE_NOT_OPEN", "This case is no longer accepting new lines", 409);
    const [duplicate] = await tx.select().from(shortPickLines).where(and(
      eq(shortPickLines.caseId, caseId), eq(shortPickLines.originalLocation, normalizedLocation), eq(shortPickLines.sku, normalizedSku),
      inArray(shortPickLines.state, ["OPEN", "CHECKING", "FOUND", "RETRIEVING"]),
    )).limit(1);
    const mayOverride = (auth.user.role === "TEAM_LEADER" || auth.user.role === "ADMIN")
      && hasAuthPermission(auth, "OVERRIDE_DUPLICATE_SHORT_PICK_LINE");
    if (duplicate && (!input.confirmDuplicate || !mayOverride)) {
      return { kind: "DUPLICATE" as const, duplicate, mayOverride };
    }
    const [line] = await tx.insert(shortPickLines).values({ caseId, originalLocation: normalizedLocation, sku: normalizedSku, missingQuantity: input.quantity, reportedByUserId: auth.user.id }).returning();
    await tx.insert(checkTasks).values({ shortPickLineId: line!.id });
    await tx.update(orderCases).set({ updatedAt: new Date(), version: sql`${orderCases.version} + 1` }).where(eq(orderCases.id, caseId));
    const details = { lineId: line!.id, location: normalizedLocation, sku: normalizedSku, quantity: input.quantity, ...(duplicate ? { duplicateOfLineId: duplicate.id, override: true } : {}) };
    await tx.insert(caseEvents).values({ caseId, shortPickLineId: line!.id, actorUserId: auth.user.id, eventType: duplicate ? "SHORT_PICK_LINE_DUPLICATE_OVERRIDE_USED" : "SHORT_PICK_LINE_ADDED", details });
    await tx.insert(auditLog).values({ actorUserId: auth.user.id, action: duplicate ? "SHORT_PICK_LINE_DUPLICATE_OVERRIDE_USED" : "SHORT_PICK_LINE_ADDED", details: { caseId, ...details } });
    return { kind: "CREATED" as const, line: line! };
  });
  if (result.kind === "DUPLICATE") {
    const line = { ...result.duplicate, location: result.duplicate.originalLocation, quantity: result.duplicate.missingQuantity };
    if (input.confirmDuplicate && !result.mayOverride) throw new CaseApiError("DUPLICATE_OVERRIDE_FORBIDDEN", "You are not authorized to add a duplicate unresolved line", 403, { line });
    throw new CaseApiError("DUPLICATE_LINE", "This item is already reported on this order", 409, { line, overrideAllowed: result.mayOverride });
  }
  return { ...result.line, location: result.line.originalLocation, quantity: result.line.missingQuantity };
}

export async function getCaseForUser(auth: AuthContext, caseId: string) {
  return getDb().transaction(async (tx) => {
    const [row] = await tx.select().from(orderCases).where(eq(orderCases.id, caseId)).for("update").limit(1);
    if (!row) throw new CaseApiError("CASE_NOT_FOUND", "Case not found", 404);
    if (!canReadCase(auth, row)) {
      if (row.phase === "CLOSED" || !hasAuthPermission(auth, "VIEW_CASE_MESSAGES") || !(await hasCurrentCaseResponsibility(tx, auth, row))) {
        throw new CaseApiError("CASE_ACCESS_DENIED", "You cannot access this case", 403);
      }
    }
    return readCase(tx, caseId, hasAuthPermission(auth, "VIEW_CASE_MESSAGES"));
  });
}

export async function listCasesForUser(auth: AuthContext, scope: "mine" | "active") {
  const db = getDb();
  if (scope === "active" && !hasAuthPermission(auth, "VIEW_ALL_OPEN_CASES")) throw new CaseApiError("CASE_ACCESS_DENIED", "You cannot view all active cases", 403);
  if (scope === "mine" && !hasAuthPermission(auth, "VIEW_OWN_CASES")) throw new CaseApiError("CASE_ACCESS_DENIED", "You cannot view your cases", 403);
  const rows = await db.select().from(orderCases).where(and(isOpen, ...(scope === "mine" ? [eq(orderCases.pickingUserId, auth.user.id)] : []))).orderBy(desc(orderCases.updatedAt)).limit(250);
  const ids = rows.map((row) => row.id);
  const lines = ids.length ? await db.select().from(shortPickLines).where(inArray(shortPickLines.caseId, ids)).orderBy(shortPickLines.createdAt) : [];
  const grouped = new Map<string, typeof lines>();
  for (const line of lines) grouped.set(line.caseId, [...(grouped.get(line.caseId) ?? []), line]);
  return rows.map((row) => ({ ...row, lines: (grouped.get(row.id) ?? []).map((line) => ({ id: line.id, state: line.state, quantity: line.missingQuantity, location: line.originalLocation, sku: line.sku })) }));
}
