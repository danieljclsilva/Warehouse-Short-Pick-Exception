import { describe, expect, it } from "vitest";
import { projectLines } from "@/server/cases";
import type { checkTasks, shortPickLines } from "@/db/schema";

type LineRow = typeof shortPickLines.$inferSelect;
type TaskRow = typeof checkTasks.$inferSelect;

const baseLine: LineRow = {
  id: "00000000-0000-4000-8000-000000000001",
  caseId: "00000000-0000-4000-8000-000000000010",
  originalLocation: "01.AA.1",
  sku: "SKU-1",
  missingQuantity: 1,
  reportedByUserId: "00000000-0000-4000-8000-000000000020",
  reportedAt: new Date("2026-10-01T00:00:00Z"),
  state: "OPEN",
  currentResponsibleUserId: "00000000-0000-4000-8000-000000000099",
  discoveredLocation: null,
  discoveredByUserId: null,
  discoveredAt: null,
  retrievalState: "NOT_REQUIRED",
  retrievalResponsibleUserId: null,
  retrievedByUserId: null,
  retrievedAt: null,
  replenishmentState: "NONE",
  replenishmentNote: null,
  replenishmentActorUserId: null,
  replenishmentAt: null,
  replenishmentRetrieverUserId: null,
  resolvedAt: null,
  resolutionCode: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
  version: 1,
};

const task = (overrides: Partial<TaskRow> & { id: string; shortPickLineId: string }): TaskRow => ({
  id: overrides.id,
  shortPickLineId: overrides.shortPickLineId,
  status: overrides.status ?? "AVAILABLE",
  claimedByUserId: overrides.claimedByUserId ?? null,
  assignedToUserId: overrides.assignedToUserId ?? null,
  claimedAt: overrides.claimedAt ?? null,
  assignedAt: overrides.assignedAt ?? null,
  startedAt: overrides.startedAt ?? null,
  completedAt: overrides.completedAt ?? null,
  completionCode: overrides.completionCode ?? null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
  version: 1,
});

const project = (lines: LineRow[], checks: TaskRow[], phase: "PICKING" | "STAGED" | "CLOSED" = "PICKING") =>
  projectLines({ orderNumber: "123", phase, lines, checks, names: new Map() });

describe("workflow projection corrections (pure projectLines)", () => {
  it("keeps CLOSED/terminal lines at NONE", () => {
    const closed = project([{ ...baseLine, state: "OPEN" }], [], "CLOSED")[0]!;
    expect(closed.nextActionCode).toBe("NONE");
    expect(closed.blockingReasonCode).toBe("CASE_CLOSED");
    const resolved = project([{ ...baseLine, state: "RESOLVED" }], [])[0]!;
    expect(resolved.nextActionCode).toBe("NONE");
    expect(resolved.blockingReasonCode).toBeNull();
  });

  it("projects REQUEST_CHECK with NO_ACTIVE_CHECK when OPEN has no noncompleted task", () => {
    const negative = project(
      [{ ...baseLine }],
      [task({ id: "00000000-0000-4000-8000-000000000031", shortPickLineId: baseLine.id, status: "COMPLETED", completedAt: new Date(), completionCode: "NOT_FOUND" })],
    )[0]!;
    expect(negative.displayStatus).toBe("NOT_FOUND");
    expect(negative.nextActionCode).toBe("REQUEST_CHECK");
    expect(negative.blockingReasonCode).toBe("NO_ACTIVE_CHECK");
    expect(negative.actionOwnerUserId).toBeNull();
    expect(negative.nextActionParams).toMatchObject({ lineId: baseLine.id, requiredPermission: "ASSIGN_CHECK" });

    const other = project(
      [{ ...baseLine }],
      [task({ id: "00000000-0000-4000-8000-000000000032", shortPickLineId: baseLine.id, status: "COMPLETED", completedAt: new Date(), completionCode: "OTHER" })],
    )[0]!;
    expect(other.displayStatus).toBe("OPEN");
    expect(other.nextActionCode).toBe("REQUEST_CHECK");
    expect(other.blockingReasonCode).toBe("NO_ACTIVE_CHECK");
  });

  it("still projects CLAIM_CHECK for a genuinely AVAILABLE task", () => {
    const line = project(
      [{ ...baseLine }],
      [task({ id: "00000000-0000-4000-8000-000000000033", shortPickLineId: baseLine.id, status: "AVAILABLE" })],
    )[0]!;
    expect(line.nextActionCode).toBe("CLAIM_CHECK");
    expect(line.blockingReasonCode).toBeNull();
  });

  it("uses the actual claimed/assigned task owner, not stale line.currentResponsibleUserId", () => {
    const actualOwner = "00000000-0000-4000-8000-000000000040";
    const staleOwner = "00000000-0000-4000-8000-000000000099";
    const claimed = project(
      [{ ...baseLine, state: "CHECKING", currentResponsibleUserId: staleOwner }],
      [task({ id: "00000000-0000-4000-8000-000000000034", shortPickLineId: baseLine.id, status: "CLAIMED", claimedByUserId: actualOwner })],
    )[0]!;
    expect(claimed.nextActionCode).toBe("COMPLETE_CHECK");
    expect(claimed.actionOwnerUserId).toBe(actualOwner);
    expect(claimed.checkerUserId).toBe(actualOwner);
  });

  it("keeps REPLENISH only for WAITING and surfaces FAILED above FOUND_AT_ORIGINAL", () => {
    const waiting = project(
      [{ ...baseLine, state: "OPEN", replenishmentState: "WAITING" }],
      [],
    )[0]!;
    expect(waiting.nextActionCode).toBe("REPLENISH");
    expect(waiting.blockingReasonCode).toBe("AWAITING_REPLENISHMENT");

    const failed = project(
      [{ ...baseLine, state: "FOUND", retrievalState: "FAILED" }],
      [task({ id: "00000000-0000-4000-8000-000000000036", shortPickLineId: baseLine.id, status: "COMPLETED", completedAt: new Date(), completionCode: "FOUND_AT_ORIGINAL" })],
    )[0]!;
    expect(failed.displayStatus).toBe("RETRIEVAL_FAILED");

    const original = project(
      [{ ...baseLine, state: "FOUND", retrievalState: "PENDING" }],
      [task({ id: "00000000-0000-4000-8000-000000000037", shortPickLineId: baseLine.id, status: "COMPLETED", completedAt: new Date(), completionCode: "FOUND_AT_ORIGINAL" })],
    )[0]!;
    expect(original.displayStatus).toBe("FOUND_AT_ORIGINAL");
    expect(original.knownNewLocation).toBeNull();
  });

  it("waits on the replenishment retriever for COMPLETED without a materialized retrieval", () => {
    const replenisher = "00000000-0000-4000-8000-000000000041";
    const waiting = project(
      [{ ...baseLine, state: "OPEN", replenishmentState: "COMPLETED", retrievalState: "NOT_REQUIRED", replenishmentRetrieverUserId: replenisher }],
      [task({ id: "00000000-0000-4000-8000-000000000039", shortPickLineId: baseLine.id, status: "AVAILABLE" })],
    )[0]!;
    expect(waiting.nextActionCode).toBe("WAIT");
    expect(waiting.blockingReasonCode).toBe("AWAITING_RETRIEVAL");
    expect(waiting.actionOwnerUserId).toBe(replenisher);
  });

  it("still retrieves materialized COMPLETED obligations with a live retrieval owner", () => {
    const retriever = "00000000-0000-4000-8000-000000000042";
    for (const retrievalState of ["PENDING", "IN_PROGRESS", "FAILED"] as const) {
      const pending = project(
        [{ ...baseLine, state: "OPEN", replenishmentState: "COMPLETED", retrievalState, retrievalResponsibleUserId: retriever }],
        [task({ id: "00000000-0000-4000-8000-000000000043", shortPickLineId: baseLine.id, status: "AVAILABLE" })],
      )[0]!;
      expect(pending.nextActionCode).toBe("RETRIEVE");
      expect(pending.blockingReasonCode).toBe("AWAITING_RETRIEVAL");
      expect(pending.actionOwnerUserId).toBe(retriever);
    }
  });

  it("never projects CLAIM_CHECK from a COMPLETED/NOT_REQUIRED line with an AVAILABLE task", () => {
    const completed = project(
      [{ ...baseLine, state: "OPEN", replenishmentState: "COMPLETED", retrievalState: "NOT_REQUIRED" }],
      [task({ id: "00000000-0000-4000-8000-000000000044", shortPickLineId: baseLine.id, status: "AVAILABLE" })],
    )[0]!;
    expect(completed.nextActionCode).not.toBe("CLAIM_CHECK");
    expect(completed.nextActionCode).not.toBe("REPLENISH");
    expect(completed.nextActionCode).toBe("WAIT");
  });

  it("keeps terminal precedence over failure evidence", () => {
    const resolvedFailed = project([{ ...baseLine, state: "RESOLVED", retrievalState: "FAILED" }], [])[0]!;
    expect(resolvedFailed.displayStatus).toBe("RESOLVED");
    const cancelledFailed = project([{ ...baseLine, state: "CANCELLED", retrievalState: "FAILED" }], [])[0]!;
    expect(cancelledFailed.displayStatus).toBe("CANCELLED");
  });
});
