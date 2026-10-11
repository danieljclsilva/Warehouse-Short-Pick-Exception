import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { briefInstructionForLine, DeepCaseView, resolveDeepTarget, stepperStageForLine } from "@/components/auth-app";
import { getMessages, translate, type Locale } from "@/i18n/messages";

const trFor = (locale: Locale) => {
  const { messages } = getMessages(locale);
  return (key: Parameters<typeof translate>[1], values?: Record<string, string>) => translate(messages, key, values);
};

const headingRef = { current: null };
const lineRef = { current: null };
const noop = () => {};

const baseLine = {
  id: "line-1",
  location: "01.AA.1",
  originalLocation: "01.AA.1",
  sku: "SKU-1",
  quantity: 2,
  missingQuantity: 2,
  state: "OPEN",
  retrievalState: null,
  discoveredLocation: null,
  reporterName: "Picker One",
  checkerName: null,
  retrieverName: null,
  replenishmentState: "NONE",
  replenishmentNote: null,
  replenishmentActorName: null,
  nextActionCode: "CLAIM_CHECK",
  blockingReasonCode: null,
};

const baseCase = {
  id: "case-open",
  orderNumber: "100001",
  phase: "PICKING",
  pickerName: "Picker One",
  responsibleName: null,
  closedAt: null,
  resolvedAt: null,
  lines: [baseLine],
  messages: [],
};

describe("NavAssign: notification-open live routing target", () => {
  it("lands actionable open cases on the live view and keeps closed/unauthorized on the read-only panel", () => {
    expect(resolveDeepTarget({ phase: "PICKING", closedAt: null, resolvedAt: null, canAct: true })).toEqual({ view: "live", section: "myWork" });
    expect(resolveDeepTarget({ phase: "CLOSED", closedAt: "2026-09-28T11:00:00Z", resolvedAt: "2026-09-28T11:00:00Z", canAct: true })).toEqual({ view: "readonly" });
    expect(resolveDeepTarget({ phase: "PICKING", closedAt: null, resolvedAt: null, canAct: false })).toEqual({ view: "readonly" });
  });

  it("shows an Open-live-case action for actionable users and read-only chrome for closed cases", () => {
    const live = renderToString(createElement(DeepCaseView, {
      tr: trFor("en"), data: baseCase, lineId: "line-1", canViewMessages: false,
      status: "ready", onClose: noop, headingRef, currentLineRef: lineRef, fromNotification: true,
    }));
    expect(live).toContain("Claim a check to start");
    expect(live).not.toContain("Closed · read-only");
    const closed = renderToString(createElement(DeepCaseView, {
      tr: trFor("en"), data: { ...baseCase, phase: "CLOSED", closedAt: "2026-09-28T11:00:00Z", resolvedAt: "2026-09-28T11:00:00Z" },
      lineId: "line-1", canViewMessages: false, status: "ready", onClose: noop, headingRef, currentLineRef: lineRef, fromNotification: true,
    }));
    expect(closed).toContain("Closed · read-only");
    expect(closed).not.toContain("Claim a check to start");
  });
});

describe("NavAssign: per-case brief instruction from codes", () => {
  it("renders one line per nextAction code with the owner named where present", () => {
    expect(briefInstructionForLine({ nextActionCode: "CLAIM_CHECK" })).toEqual({ key: "navInstructionClaimCheck", values: { ownerSeparator: "", ownerSuffix: "" } });
    expect(briefInstructionForLine({ nextActionCode: "COMPLETE_CHECK", checkerName: "Checker Two" })).toEqual({ key: "navInstructionCompleteCheck", values: { ownerSeparator: " ", ownerSuffix: " · Checker Two" } });
    expect(briefInstructionForLine({ nextActionCode: "COMPLETE_CHECK", actionOwnerName: "Owner A", checkerName: "Checker Two" })).toEqual({ key: "navInstructionCompleteCheck", values: { ownerSeparator: " ", ownerSuffix: " · Owner A" } });
    expect(briefInstructionForLine({ nextActionCode: "RETRIEVE", discoveredLocation: "02.BB.9", retrieverName: "Picker One" })).toEqual(
      { key: "navInstructionRetrieve", values: { location: "02.BB.9", ownerSeparator: " ", ownerSuffix: " · Picker One" } });
    expect(briefInstructionForLine({ nextActionCode: "RETRIEVE", discoveredLocation: "02.BB.9", checkerName: "Checker Two", retrieverName: "Picker One" })).toEqual(
      { key: "navInstructionRetrieve", values: { location: "02.BB.9", ownerSeparator: " ", ownerSuffix: " · Picker One" } });
    expect(briefInstructionForLine({ nextActionCode: "RETRIEVE", discoveredLocation: "02.BB.9", actionOwnerName: "Owner B", checkerName: "Checker Two", retrieverName: "Picker One" })).toEqual(
      { key: "navInstructionRetrieve", values: { location: "02.BB.9", ownerSeparator: " ", ownerSuffix: " · Owner B" } });
    expect(briefInstructionForLine({ nextActionCode: "RETRIEVE" })).toEqual({ key: "navInstructionRetrieveHandoff", values: { ownerSeparator: "", ownerSuffix: "" } });
    expect(briefInstructionForLine({ nextActionCode: "RETRIEVE", discoveredLocation: "02.BB.9", pickerRetrieval: true })).toEqual(
      { key: "navInstructionPickerRetrieve", values: { location: "02.BB.9", ownerSeparator: "", ownerSuffix: "" } });
    expect(briefInstructionForLine({ nextActionCode: "REPLENISH", replenishmentRetrieverName: "Retriever R" })).toEqual(
      { key: "navInstructionReplenish", values: { ownerSeparator: " ", ownerSuffix: " · Retriever R" } });
    expect(briefInstructionForLine({ nextActionCode: "REPLENISH", actionOwnerName: "Owner C", replenishmentRetrieverName: "Retriever R", replenishmentActorName: "Troubleshooter" })).toEqual(
      { key: "navInstructionReplenish", values: { ownerSeparator: " ", ownerSuffix: " · Owner C" } });
    expect(briefInstructionForLine({ nextActionCode: "REPLENISH", replenishmentActorName: "Troubleshooter" })).toEqual(
      { key: "navInstructionReplenish", values: { ownerSeparator: "", ownerSuffix: "" } });
    expect(briefInstructionForLine({ nextActionCode: "REQUEST_CHECK", checkerName: "Stale Checker" })).toEqual({ key: "navInstructionRequestCheck", values: { ownerSeparator: "", ownerSuffix: "" } });
    expect(briefInstructionForLine({ nextActionCode: "WAIT", actionOwnerName: "Owner W" })).toEqual({ key: "navInstructionWait", values: { ownerSeparator: " ", ownerSuffix: " · Owner W" } });
    expect(briefInstructionForLine({ nextActionCode: "WAIT" })).toEqual({ key: "navInstructionWait", values: { ownerSeparator: "", ownerSuffix: "" } });
    expect(briefInstructionForLine({ nextActionCode: "NONE" })).toBeNull();
    expect(briefInstructionForLine({})).toBeNull();
    const html = renderToString(createElement(DeepCaseView, {
      tr: trFor("en"),
      data: { ...baseCase, lines: [{ ...baseLine, nextActionCode: "RETRIEVE", discoveredLocation: "02.BB.9", retrieverName: "Picker One" }] },
      lineId: "line-1", canViewMessages: false, status: "ready", onClose: noop, headingRef, currentLineRef: lineRef, fromNotification: true,
    }));
    expect(html).toContain("Retrieve from 02.BB.9 · Picker One");
  });

  it("never renders a free-text server string as the instruction", () => {
    const evil = "Server says <script>alert(1)</script>";
    const html = renderToString(createElement(DeepCaseView, {
      tr: trFor("en"),
      data: { ...baseCase, lines: [{ ...baseLine, nextActionCode: "RETRIEVE", discoveredLocation: evil }] },
      lineId: "line-1", canViewMessages: false, status: "ready", onClose: noop, headingRef, currentLineRef: lineRef, fromNotification: true,
    }));
    expect(html).toContain("Retrieve from");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("NavAssign: Waiting → Ready → Done stepper from displayStatus codes", () => {
  it("maps assigned-but-not-started to Waiting, retrieval-requested to Ready, resolved to Done", () => {
    expect(stepperStageForLine({ state: "OPEN" })).toBe("waiting");
    expect(stepperStageForLine({ state: "CHECKING" })).toBe("waiting");
    expect(stepperStageForLine({ displayStatus: "FOUND" })).toBe("ready");
    expect(stepperStageForLine({ displayStatus: "WAITING_RETRIEVAL" })).toBe("ready");
    expect(stepperStageForLine({ state: "OPEN", pickerRetrieval: true })).toBe("ready");
    expect(stepperStageForLine({ displayStatus: "RESOLVED" })).toBe("done");
    expect(stepperStageForLine({ displayStatus: "CANCELLED" })).toBe("done");
  });

  it("renders the stepper with the picker-retrieval Ready label where flagged", () => {
    const html = renderToString(createElement(DeepCaseView, {
      tr: trFor("en"),
      data: { ...baseCase, lines: [{ ...baseLine, displayStatus: "FOUND", pickerRetrieval: true }] },
      lineId: "line-1", canViewMessages: false, status: "ready", onClose: noop, headingRef, currentLineRef: lineRef, fromNotification: true,
    }));
    expect(html).toContain("Waiting");
    expect(html).toContain("Ready · picker retrieval");
    expect(html).toContain("Done");
  });
});
