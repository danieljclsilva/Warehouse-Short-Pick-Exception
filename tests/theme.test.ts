import { describe, expect, it, vi } from "vitest";
import {
  THEME_DARK_META_COLOR,
  THEME_INIT_SCRIPT,
  THEME_LIGHT_META_COLOR,
  THEME_STORAGE_KEY,
  applyResolvedTheme,
  parseThemeChoice,
  readStoredThemeChoice,
  resolveTheme,
} from "@/components/theme";

describe("parseThemeChoice", () => {
  it("accepts light, dark, and system", () => {
    expect(parseThemeChoice("light")).toBe("light");
    expect(parseThemeChoice("dark")).toBe("dark");
    expect(parseThemeChoice("system")).toBe("system");
  });

  it("falls back to system for missing or unexpected values", () => {
    expect(parseThemeChoice(null)).toBe("system");
    expect(parseThemeChoice("sepia")).toBe("system");
  });
});

describe("resolveTheme", () => {
  it("keeps explicit light and dark choices", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("follows prefers-color-scheme for system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("readStoredThemeChoice", () => {
  it("reads the stored value and tolerates hostile storage", () => {
    expect(readStoredThemeChoice({ getItem: () => "dark" })).toBe("dark");
    expect(readStoredThemeChoice(null)).toBe("system");
    expect(
      readStoredThemeChoice({
        getItem: () => {
          throw new Error("denied");
        },
      }),
    ).toBe("system");
  });
});

describe("theme persistence contract", () => {
  it("documents the localStorage key so login and workspace stay in sync", () => {
    expect(THEME_STORAGE_KEY).toBe("short-pick-theme");
  });

  it("keeps the boot script in sync with resolveTheme outcomes", () => {
    expect(THEME_INIT_SCRIPT).toContain(THEME_STORAGE_KEY);
    expect(THEME_INIT_SCRIPT).toContain("(prefers-color-scheme: dark)");
    expect(THEME_INIT_SCRIPT).toContain("dataset.theme");
    expect(THEME_INIT_SCRIPT).toContain("colorScheme");
    expect(THEME_INIT_SCRIPT).toContain(THEME_LIGHT_META_COLOR);
    expect(THEME_INIT_SCRIPT).toContain(THEME_DARK_META_COLOR);
    expect(THEME_INIT_SCRIPT.length).toBeLessThan(1200);
  });

  it("applies the resolved theme to the document and theme-color meta", () => {
    const setAttribute = vi.fn();
    const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
    const documentStub = {
      documentElement: root,
      querySelectorAll: vi.fn(() => [{ setAttribute }]),
    };
    vi.stubGlobal("document", documentStub);
    try {
      expect(applyResolvedTheme("dark")).toBe("dark");
      expect(root.dataset.theme).toBe("dark");
      expect(root.style.colorScheme).toBe("dark");
      expect(setAttribute).toHaveBeenCalledWith("content", THEME_DARK_META_COLOR);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
