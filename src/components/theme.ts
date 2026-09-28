/**
 * Browser theme preference (Light / Dark / System).
 *
 * The choice is a pure browser preference: it is stored in localStorage only,
 * never sent to the server, and needs no database schema or secrets.
 */

export const THEME_STORAGE_KEY = "short-pick-theme";

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_LIGHT_META_COLOR = "#24765d";
export const THEME_DARK_META_COLOR = "#0f1513";

export function parseThemeChoice(value: unknown): ThemeChoice {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  if (choice === "light") return "light";
  if (choice === "dark") return "dark";
  return prefersDark ? "dark" : "light";
}

/**
 * Blocking inline script rendered before first paint. It mirrors resolveTheme
 * so the initial `data-theme` matches what the client picker computes after
 * hydration (SSR-safe: wrapped in try/catch, no server execution).
 */
export const THEME_INIT_SCRIPT = `(function(){try{var s=null;try{s=window.localStorage.getItem("${THEME_STORAGE_KEY}")}catch(e){}var c=s==="light"||s==="dark"||s==="system"?s:"system";var t=c==="dark"||(c!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches)?"dark":"light";var r=document.documentElement;r.dataset.theme=t;r.style.colorScheme=t;var m=r.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<m.length;i++){m[i].setAttribute("content",t==="dark"?"${THEME_DARK_META_COLOR}":"${THEME_LIGHT_META_COLOR}")}}catch(e){}})();`;

/**
 * Returns browser localStorage, or null when unavailable. Guards both the
 * `window.localStorage` property access and restricted contexts where even
 * touching the property throws (e.g. blocked third-party storage).
 */
export function getThemeStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    if (typeof window === "undefined") return null;
    const storage = window.localStorage;
    if (!storage) return null;
    return storage;
  } catch {
    return null;
  }
}

export function readStoredThemeChoice(storage: Pick<Storage, "getItem"> | null | undefined): ThemeChoice {
  try {
    if (!storage) return "system";
    return parseThemeChoice(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

/**
 * Persists the choice; returns false when storage is unavailable so the
 * caller keeps the in-memory choice in force for the current tab.
 */
export function persistThemeChoice(
  storage: Pick<Storage, "setItem"> | null | undefined,
  choice: ThemeChoice,
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(THEME_STORAGE_KEY, choice);
    return true;
  } catch {
    return false;
  }
}

/** Applies the resolved theme to the document; returns the resolved theme. No-op without a DOM. */
export function applyResolvedTheme(resolved: ResolvedTheme): ResolvedTheme {
  if (typeof document === "undefined") return resolved;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  metas.forEach((meta) => meta.setAttribute("content", resolved === "dark" ? THEME_DARK_META_COLOR : THEME_LIGHT_META_COLOR));
  return resolved;
}
