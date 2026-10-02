import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Static guard for the 360px phone crowding fix in SameLocationFoundSection.
// No jsdom/browser in this repo, so this asserts the markup + CSS rules that
// remove the crowding sources (title/export squeezing the description,
// 4-up stat cards, clipped per-reporter table).
const tsx = readFileSync(
  fileURLToPath(
    new URL("../src/components/analytics-dashboard.tsx", import.meta.url),
  ),
  "utf8",
);
const css = readFileSync(
  fileURLToPath(
    new URL("../src/components/analytics-dashboard.module.css", import.meta.url),
  ),
  "utf8",
);

const ruleBody = (selector: string): string => {
  const match = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, "s"));
  if (!match) throw new Error(`missing CSS rule: ${selector}`);
  return match[1];
};

describe("same-location-found phone layout (360px)", () => {
  it("renders title row and description as separate blocks", () => {
    expect(tsx).toMatch(/sameLocationTitleRow/);
    expect(tsx).toMatch(/sameLocationHead/);
    // Description must sit below the title row, not beside the export button.
    const head = tsx.match(/sameLocationHead[\s\S]*?SameLocationDescription/)!;
    expect(head).toBeTruthy();
  });

  it("title wraps without mid-word hyphenation", () => {
    const title = ruleBody("\\.sameLocationTitleRow h2");
    expect(title).toMatch(/overflow-wrap:\s*break-word/);
    expect(title).toMatch(/hyphens:\s*none/);
  });

  it("title row stacks vertically on narrow screens", () => {
    expect(css).toMatch(
      /\.sameLocationTitleRow\s*\{[^}]*flex-direction:\s*column/,
    );
  });

  it("stat cards stack full-width on narrow screens", () => {
    expect(css).toMatch(
      /\.sameLocationStats\s*\{[^}]*grid-template-columns:\s*1fr/,
    );
    const value = ruleBody("\\.sameLocationStats \\.timing strong");
    expect(value).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("per-reporter table scrolls horizontally with readable columns", () => {
    const table = ruleBody("\\.sameLocationTable table");
    expect(table).toMatch(/min-width:\s*\d+px/);
    const cells = ruleBody("\\.sameLocationTable th,\\s*\\.sameLocationTable td");
    expect(cells).toMatch(/white-space:\s*nowrap/);
    expect(css).toMatch(/\.sameLocationTable tbody th:first-child[\s\S]*?position:\s*sticky/);
  });

  it("keeps data, export, i18n keys, and empty states identical", () => {
    for (const key of [
      "analyticsSameLocationTitle",
      "analyticsSameLocationDescription",
      "analyticsSameLocationEligible",
      "analyticsSameLocationRate",
      "analyticsSameLocationDateRange",
      "analyticsSameLocationOutcomes",
      "analyticsSameLocationReporter",
      "analyticsSameLocationExport",
      "analyticsNoData",
    ]) {
      expect(tsx).toContain(`tr("${key}")`);
    }
    expect(tsx).toContain('onDownload("same-location-found")');
  });
});
