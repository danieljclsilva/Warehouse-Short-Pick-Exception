/** Normalize only recognizable location formats; legacy names remain usable. */
export function normalizeWarehouseLocation(raw: string): string {
  const value = raw.trim().toUpperCase();
  const rack = value.match(/^(\d{1,2})[.\s/-]*([A-Z]{2})[.\s/-]*(\d)$/);
  if (rack) return `${rack[1]!.padStart(2, "0")}.${rack[2]}.${rack[3]}`;
  const backwall = value.match(/^H[.\s/-]*([AB])[\s/]*BACK\s*WALL\s*(\d)[.\s/-]+(\d{1,2})$/);
  if (backwall) return `H.${backwall[1]}/BACKWALL${backwall[2]}.${backwall[3]!.padStart(2, "0")}`;
  const endcap = value.match(/^H[.\s/-]*([AB])[\s/]+(?:([A-Z])\s+)?END\s*CAP\s*-\s*(\d+)$/);
  if (endcap) return `H.${endcap[1]}/${endcap[2] ? `${endcap[2]} ` : ""}ENDCAP -${endcap[3]}`;
  return value;
}

/** Safe formatting while typing: never fill in missing digits or change a legacy name. */
export function formatLocationInput(raw: string): string {
  const value = raw.toUpperCase();
  // Add separators as the next segment arrives, so backspace remains natural.
  if (/^\d{2}[A-Z]{0,2}\d?$/.test(value)) {
    return value.replace(/^(\d{2})([A-Z]{1,2})(\d)?$/, (_, aisle: string, bay: string, level?: string) => `${aisle}.${bay}${level === undefined ? "" : `.${level}`}`);
  }
  if (/^\d{2}\.[A-Z]{2}\d$/.test(value)) return value.replace(/^(\d{2}\.[A-Z]{2})(\d)$/, "$1.$2");
  const backwall = value.match(/^H[.\s/-]*([AB])[\s/]*BACK\s*WALL\s*(\d)(\d{1,2})$/);
  if (backwall) return `H.${backwall[1]}/BACKWALL${backwall[2]}.${backwall[3]}`;
  return value;
}

/** Format completions, not a claim that these locations exist in the warehouse. */
export function suggestWarehouseLocations(raw: string): string[] {
  const normalized = normalizeWarehouseLocation(raw);
  const rack = normalized.match(/^(\d{1,2})[.\s/-]*([A-Z]{2})[.\s/-]*$/);
  if (rack) return Array.from({ length: 10 }, (_, level) => `${rack[1]!.padStart(2, "0")}.${rack[2]}.${level}`);
  const backwall = normalized.match(/^H[.\s/-]*([AB])[\s/]*BACK\s*WALL\s*(\d)[.\s/-]*(\d?)$/);
  if (backwall) {
    const prefix = backwall[3] || "0";
    return Array.from({ length: 10 }, (_, slot) => `H.${backwall[1]}/BACKWALL${backwall[2]}.${prefix}${slot}`);
  }
  const endcap = normalized.match(/^H[.\s/-]*([AB])[\s/]+(?:([A-Z])\s+)?END\s*CAP\s*-?$/);
  if (endcap) return Array.from({ length: 9 }, (_, index) => `H.${endcap[1]}/${endcap[2] ? `${endcap[2]} ` : ""}ENDCAP -${index + 1}`);
  const hall = normalized.match(/^H\.([AB])\/([A-Z]?)$/);
  if (hall) {
    const bays = Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)} ENDCAP -`);
    return ["BACKWALL", ...bays].map((suffix) => `H.${hall[1]}/${suffix}`).filter((item) => item.startsWith(normalized));
  }
  const templates = ["H.A/BACKWALL", "H.B/BACKWALL", "H.A/ENDCAP -", "H.B/ENDCAP -"];
  const matches = normalized ? templates.filter((item) => item.startsWith(normalized)) : templates;
  if (matches.length) return matches;
  return normalized && normalized !== raw ? [normalized] : [];
}
