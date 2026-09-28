import { createElement } from "react";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { ThemePicker } from "@/components/theme-picker";
import {
  THEME_DARK_META_COLOR,
  THEME_INIT_SCRIPT,
  THEME_LIGHT_META_COLOR,
  THEME_STORAGE_KEY,
  applyResolvedTheme,
  getThemeStorage,
  parseThemeChoice,
  persistThemeChoice,
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

describe("theme storage accessors", () => {
  it("returns null without a window (server render)", () => {
    expect(getThemeStorage()).toBeNull();
  });

  it("returns null when touching window.localStorage throws", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      get() {
        throw new Error("blocked storage");
      },
    });
    try {
      expect(getThemeStorage()).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  it("persists the choice and reports storage failures", () => {
    const setItem = vi.fn();
    expect(persistThemeChoice({ setItem }, "dark")).toBe(true);
    expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "dark");
    expect(persistThemeChoice(null, "dark")).toBe(false);
    expect(
      persistThemeChoice(
        {
          setItem: () => {
            throw new Error("denied");
          },
        },
        "dark",
      ),
    ).toBe(false);
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

describe("boot script behavior", () => {
  function runBootScript({ stored, prefersDark }: { stored: string | null; prefersDark: boolean }) {
    const state = { theme: undefined as string | undefined, colorScheme: undefined as string | undefined };
    const metaContents: string[] = [];
    const sandbox = {
      window: {
        localStorage: {
          getItem: () => stored,
        },
        matchMedia: () => ({ matches: prefersDark }),
      },
      document: {
        documentElement: {
          dataset: {
            set theme(value: string) {
              state.theme = value;
            },
          },
          style: {
            set colorScheme(value: string) {
              state.colorScheme = value;
            },
          },
          querySelectorAll: () => [{ setAttribute: (_: string, value: string) => metaContents.push(value) }],
        },
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(THEME_INIT_SCRIPT, sandbox);
    return { state, metaContents };
  }

  it("applies the stored choice before paint", () => {
    const { state, metaContents } = runBootScript({ stored: "dark", prefersDark: false });
    expect(state.theme).toBe("dark");
    expect(state.colorScheme).toBe("dark");
    expect(metaContents).toContain(THEME_DARK_META_COLOR);
  });

  it("tracks the OS preference for system and falls back safely without storage", () => {
    const dark = runBootScript({ stored: "system", prefersDark: true });
    expect(dark.state.theme).toBe("dark");
    const light = runBootScript({ stored: null, prefersDark: false });
    expect(light.state.theme).toBe("light");
    expect(light.metaContents).toContain(THEME_LIGHT_META_COLOR);
  });

  it("never throws in restricted browsing contexts", () => {
    const sandbox = {
      window: {
        matchMedia: () => ({ matches: false }),
        documentElement: {},
      },
      document: { documentElement: { dataset: {}, style: {}, querySelectorAll: () => [] } },
    };
    Object.defineProperty(sandbox.window, "localStorage", {
      get() {
        throw new Error("denied");
      },
    });
    vm.createContext(sandbox);
    expect(() => vm.runInContext(THEME_INIT_SCRIPT, sandbox)).not.toThrow();
  });
});

describe("ThemePicker server render", () => {
  it("renders a deterministic initial selection for SSR and first client paint", () => {
    const html = renderToString(createElement(ThemePicker, { tr: () => "label" }));
    // Hydration-safe default: same markup on server and first client render;
    // the stored choice syncs after mount while the boot script holds paint.
    expect(html).toContain('value="system"');
  });
});
