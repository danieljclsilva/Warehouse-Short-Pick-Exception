import { describe, expect, it } from "vitest";
import { isEligibleRetrievalOwner, selectRetrievalOwner, type RetrievalCandidate } from "../src/server/retrieval-routing";

const eligible = (id: string): RetrievalCandidate => ({ id, status: "ACTIVE", permissions: ["CONFIRM_RETRIEVAL"] });
const picker = eligible("picker");
const resolver = eligible("resolver");
const checker = eligible("checker");
const base = {
  phase: "PICKING" as const,
  picker,
  resolver: null,
  checker,
  explicitPickerOverride: false,
  checkerDuringPickingEnabled: false,
  checkerWhenStagedEnabled: true,
};

describe("selectRetrievalOwner", () => {
  it("requires ACTIVE status and CONFIRM_RETRIEVAL regardless of role", () => {
    const disabled = { ...picker, status: "DISABLED" };
    const archived = { ...picker, status: "ARCHIVED" };
    const unpermitted = { ...picker, permissions: [] as string[] };
    expect(isEligibleRetrievalOwner(disabled)).toBe(false);
    expect(isEligibleRetrievalOwner(archived)).toBe(false);
    expect(isEligibleRetrievalOwner(unpermitted)).toBe(false);
    expect(isEligibleRetrievalOwner(null)).toBe(false);
    expect(selectRetrievalOwner({ ...base, picker: disabled })).toBeNull();
    expect(selectRetrievalOwner({ ...base, phase: "STAGED", picker: null, resolver: unpermitted, checker: disabled })).toBeNull();
  });

  it("routes PICKING to the eligible picker by default and to the checker only when enabled", () => {
    expect(selectRetrievalOwner(base)).toBe("picker");
    expect(selectRetrievalOwner({ ...base, checkerDuringPickingEnabled: true })).toBe("checker");
    expect(selectRetrievalOwner({ ...base, checkerDuringPickingEnabled: true, checker: { ...checker, status: "DISABLED" } })).toBe("picker");
    expect(selectRetrievalOwner({ ...base, checkerDuringPickingEnabled: true, checker: { ...checker, permissions: [] } })).toBe("picker");
    expect(selectRetrievalOwner({ ...base, picker: null })).toBeNull();
  });

  it("routes STAGED to the explicit resolver independently of checker config", () => {
    const staged = { ...base, phase: "STAGED" as const, resolver, checkerDuringPickingEnabled: true, checkerWhenStagedEnabled: false };
    expect(selectRetrievalOwner(staged)).toBe("resolver");
    expect(selectRetrievalOwner({ ...staged, resolver: { ...resolver, status: "DISABLED" } })).toBeNull();
    expect(selectRetrievalOwner({ ...staged, resolver: { ...resolver, permissions: [] } })).toBeNull();
  });

  it("treats the default case picker as no explicit staged resolver", () => {
    const sameAsPicker = { ...base, phase: "STAGED" as const, resolver: picker, checkerWhenStagedEnabled: true };
    expect(selectRetrievalOwner(sameAsPicker)).toBe("checker");
    expect(selectRetrievalOwner({ ...sameAsPicker, checkerWhenStagedEnabled: false })).toBeNull();
    expect(selectRetrievalOwner({ ...sameAsPicker, checker: null })).toBeNull();
  });

  it("keeps the explicit picker override on an eligible picker only", () => {
    const override = { ...base, phase: "STAGED" as const, resolver, checker, explicitPickerOverride: true, checkerWhenStagedEnabled: true };
    expect(selectRetrievalOwner(override)).toBe("picker");
    expect(selectRetrievalOwner({ ...override, phase: "PICKING", checkerDuringPickingEnabled: true })).toBe("picker");
    expect(selectRetrievalOwner({ ...override, picker: { ...picker, status: "DISABLED" } })).toBeNull();
    expect(selectRetrievalOwner({ ...override, picker: null })).toBeNull();
  });

  it("selects nothing for missing or closed contexts", () => {
    expect(selectRetrievalOwner({ ...base, picker: null, checker: null })).toBeNull();
    expect(selectRetrievalOwner({ ...base, phase: "CLOSED", explicitPickerOverride: true })).toBeNull();
  });
});
