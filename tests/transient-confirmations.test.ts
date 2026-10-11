import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("transient action confirmations", () => {
  it("retains replenishment success until dismissed, including across parent reload", () => {
    const form = read("../src/components/replenishment-form.tsx");
    expect(form).not.toContain("setOpen(compact)");
    expect(form).toContain('if (normalized === "COMPLETED" && !success) return null');
    expect(form).toContain("await onSaved()");
    expect(form).toContain('setSuccess(');
  });

  it("auto-dismisses success notices while keeping errors sticky", () => {
    for (const [surface, clear] of [
      ["../src/components/check-workflow.tsx", 'setNotice("")'],
      ["../src/components/picker-workflow.tsx", 'setActionNotice("")'],
      ["../src/components/operations-dashboard.tsx", 'setNotice("")'],
    ] as const) {
      const source = read(surface);
      expect(source).toContain(`window.setTimeout(() => ${clear}, 4000)`);
      // Errors render via role="alert" and are never cleared by the timer.
      expect(source).toContain('role="alert"');
    }
  });
});

describe("confirmation toast stacking", () => {
  const ruleBody = (css: string, selector: string): string => {
    const match = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, "s"));
    if (!match) throw new Error(`missing CSS rule: ${selector}`);
    return match[1];
  };

  it("renders check/picker confirmations as a fixed toast above all overlays", () => {
    const body = ruleBody(read("../src/app/globals.css"), "\\.check-notice");
    expect(body).toMatch(/position:\s*fixed/);
    const zIndex = Number(body.match(/z-index:\s*(\d+)/)?.[1]);
    // Scan dialog sits at 90; the toast must layer above every backdrop/drawer.
    expect(zIndex).toBeGreaterThanOrEqual(100);
  });

  it("renders operations confirmations as a fixed toast above the drawer backdrop", () => {
    const body = ruleBody(read("../src/components/operations-dashboard.module.css"), "\\.notice");
    expect(body).toMatch(/position:\s*fixed/);
    const zIndex = Number(body.match(/z-index:\s*(\d+)/)?.[1]);
    expect(zIndex).toBeGreaterThanOrEqual(100);
  });

  it("keeps errors inline so they stay next to the failing action", () => {
    const globals = read("../src/app/globals.css");
    expect(ruleBody(globals, "\\.case-alert")).not.toMatch(/position:\s*fixed/);
    const ops = read("../src/components/operations-dashboard.module.css");
    expect(ruleBody(ops, "\\.alert")).not.toMatch(/position:\s*fixed/);
  });
});
