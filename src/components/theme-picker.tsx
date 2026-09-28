"use client";

import { useEffect, useRef, useState } from "react";
import type { MessageKey } from "@/i18n/messages";
import {
  applyResolvedTheme,
  getThemeStorage,
  persistThemeChoice,
  readStoredThemeChoice,
  resolveTheme,
  type ThemeChoice,
} from "./theme";

type Translator = (key: MessageKey) => string;

export function ThemePicker({ tr }: { tr: Translator }) {
  // Deterministic initial render ("system") on server and client: the
  // pre-paint boot script already set the correct data-theme, and the stored
  // choice hydrates after mount to avoid a hydration mismatch.
  const [choice, setChoice] = useState<ThemeChoice>("system");
  const choiceRef = useRef<ThemeChoice>("system");

  // Hydration from storage is an event subscription: the stored choice may
  // already differ at mount, so apply it immediately, then keep listening
  // for other tabs (native storage events). State updates live in the
  // subscription callbacks, not the effect body.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    // System tracks the OS preference using the in-memory choice, so a tab
    // whose storage writes fail keeps its unsaved choice in force.
    const onMediaChange = () => {
      if (choiceRef.current === "system") {
        applyResolvedTheme(resolveTheme("system", media.matches));
      }
    };
    // Cross-tab updates: another tab's write changes both the applied theme
    // and this picker's selected value.
    const applyStoredChoice = () => {
      const current = readStoredThemeChoice(getThemeStorage());
      choiceRef.current = current;
      setChoice(current);
      applyResolvedTheme(resolveTheme(current, media.matches));
    };
    media.addEventListener("change", onMediaChange);
    window.addEventListener("storage", applyStoredChoice);
    // Re-apply after mount: covers dev StrictMode remounts (which clear the
    // script-set attribute) and syncs the picker with the stored choice.
    applyStoredChoice();
    return () => {
      media.removeEventListener("change", onMediaChange);
      window.removeEventListener("storage", applyStoredChoice);
    };
  }, []);

  const change = (next: ThemeChoice) => {
    choiceRef.current = next;
    setChoice(next);
    // Ignore the return: when storage is unavailable the in-memory choice
    // above stays in force for this tab.
    persistThemeChoice(getThemeStorage(), next);
    applyResolvedTheme(resolveTheme(next, window.matchMedia("(prefers-color-scheme: dark)").matches));
  };

  return (
    <label className="theme-field">
      <span>{tr("theme")}</span>
      <select value={choice} onChange={(event) => change(event.target.value as ThemeChoice)} aria-label={tr("theme")}>
        <option value="light">{tr("themeLight")}</option>
        <option value="dark">{tr("themeDark")}</option>
        <option value="system">{tr("themeSystem")}</option>
      </select>
    </label>
  );
}
