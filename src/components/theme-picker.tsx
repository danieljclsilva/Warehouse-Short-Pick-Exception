"use client";

import { useEffect, useState } from "react";
import type { MessageKey } from "@/i18n/messages";
import {
  THEME_STORAGE_KEY,
  applyResolvedTheme,
  parseThemeChoice,
  readStoredThemeChoice,
  resolveTheme,
  type ThemeChoice,
} from "./theme";

type Translator = (key: MessageKey) => string;

function initialThemeChoice(): ThemeChoice {
  if (typeof window === "undefined") return "system";
  const stored = readStoredThemeChoice(window.localStorage);
  applyResolvedTheme(resolveTheme(stored, window.matchMedia("(prefers-color-scheme: dark)").matches));
  return stored;
}

export function ThemePicker({ tr }: { tr: Translator }) {
  const [choice, setChoice] = useState<ThemeChoice>(initialThemeChoice);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const current = parseThemeChoice(window.localStorage.getItem(THEME_STORAGE_KEY));
      if (current === "system") applyResolvedTheme(resolveTheme(current, media.matches));
    };
    media.addEventListener("change", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      media.removeEventListener("change", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  const change = (next: ThemeChoice) => {
    setChoice(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* Private browsing without storage: apply for this session only. */
    }
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
