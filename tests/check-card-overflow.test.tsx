import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Static guard for the 390px phone overflow fix in the Active checks card.
// No jsdom/browser in this repo, so this asserts the CSS rules that remove
// the overflow sources (min track size, no-wrap flex rows, select min-content).
const css = readFileSync(
  fileURLToPath(new URL("../src/app/globals.css", import.meta.url)),
  "utf8",
);

const ruleBody = (selector: string): string => {
  const match = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, "s"));
  if (!match) throw new Error(`missing CSS rule: ${selector}`);
  return match[1];
};

describe("check-card phone overflow (390px)", () => {
  it("grid track can shrink to the container width", () => {
    expect(ruleBody("\\.check-card-grid")).toMatch(/minmax\(min\(275px,\s*100%\),\s*1fr\)/);
  });

  it("head row wraps with breakable text", () => {
    const head = ruleBody("\\.check-card-head");
    expect(head).toMatch(/flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.check-card-head strong[\s\S]*?overflow-wrap:\s*anywhere/);
  });

  it("item row wraps with breakable text", () => {
    const item = ruleBody("\\.check-card-item");
    expect(item).toMatch(/flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.check-card-item strong,\s*\.check-card-item span[\s\S]*?overflow-wrap:\s*anywhere/);
  });

  it("assign/actions rows wrap with bounded children", () => {
    const rows = ruleBody("\\.check-assign-row,\\s*\\.check-card-actions,\\s*\\.case-retrieval-actions,\\s*\\.case-stage-actions");
    expect(rows).toMatch(/flex-wrap:\s*wrap/);
    const children = ruleBody("\\.check-assign-row > \\*,\\s*\\.check-card-actions > \\*,\\s*\\.case-retrieval-actions > \\*,\\s*\\.case-stage-actions > \\*");
    expect(children).toMatch(/min-width:\s*0/);
    expect(children).toMatch(/max-width:\s*100%/);
  });

  it("worker select is width-bounded with ellipsis", () => {
    const select = ruleBody("\\.check-worker-select");
    expect(select).toMatch(/max-width:\s*100%/);
    expect(select).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("never clips focus outlines with overflow:hidden on the card", () => {
    const card = ruleBody("\\.check-card");
    expect(card).not.toMatch(/overflow:\s*hidden/);
  });
});
