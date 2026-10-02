"use client";

import { useState } from "react";
import type { MessageKey } from "@/i18n/messages";
import styles from "../analytics-dashboard.module.css";

type Translate = (key: MessageKey, values?: Record<string, string>) => string;

export type AnalyticsFilterState = {
  from: string;
  to: string;
  orderNumber: string;
  location: string;
  sku: string;
  phase: string;
  resolution: string;
  source: string;
  configVersion: string;
  pickerUserId: string;
  checkerUserId: string;
  troubleshooterUserId: string;
  role: string;
};

export type FilterOption = { value: string; label: string };

export type ActiveFilterChip = { key: keyof AnalyticsFilterState; label: string; display: string };

export type DatePreset = "7" | "30" | "90" | "custom";

export function isoDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function presetRange(days: number, today: Date): { from: string; to: string } {
  const to = isoDay(today);
  const from = new Date(today);
  from.setDate(from.getDate() - days);
  return { from: isoDay(from), to };
}

/** Matches the current date range against the preset ranges ending today. */
export function detectPreset(from: string, to: string, today: Date): DatePreset {
  const todayIso = isoDay(today);
  if (to !== todayIso) return "custom";
  for (const days of [7, 30, 90] as const) {
    if (from === presetRange(days, today).from) return String(days) as DatePreset;
  }
  return "custom";
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function SelectField({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">—</option>
        {options.map((option) => (
          <option value={option.value} key={option.value}>{option.label}</option>
        ))}
      </select>
    </Field>
  );
}

export function AnalyticsFilters({ tr, filters, update, applyPreset, selects, chips, removeChip, onReset, resultSummary }: {
  tr: Translate;
  filters: AnalyticsFilterState;
  update: (key: keyof AnalyticsFilterState, value: string) => void;
  applyPreset: (preset: Exclude<DatePreset, "custom">) => void;
  selects: {
    phases: FilterOption[];
    resolutions: FilterOption[];
    sources: FilterOption[];
    configs: FilterOption[];
    people: FilterOption[];
    roles: FilterOption[];
  };
  chips: ActiveFilterChip[];
  removeChip: (key: keyof AnalyticsFilterState) => void;
  onReset: () => void;
  resultSummary: string;
}) {
  const [open, setOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const preset = detectPreset(filters.from, filters.to, new Date());
  return (
    <section className={styles.filters} aria-labelledby="analytics-filters-title">
      <div className={styles.sectionHeading}>
        <h2 id="analytics-filters-title">{tr("analyticsFilters")}</h2>
        <div className={styles.filterToggleRow}>
          <span className={styles.cardMeta} aria-live="polite">{resultSummary}</span>
          <button
            className={styles.clearButton}
            type="button"
            aria-expanded={open}
            aria-controls="analytics-filters-body"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? tr("analyticsFiltersHide") : tr("analyticsFiltersShow")}
          </button>
        </div>
      </div>
      {chips.length > 0 ? (
        <ul className={styles.chips} aria-label={tr("analyticsActiveFilters")}>
          {chips.map((chip) => (
            <li className={styles.chip} key={chip.key}>
              <span>{chip.label}: {chip.display}</span>
              <button type="button" aria-label={`${tr("analyticsClearFilters")}: ${chip.label}`} onClick={() => removeChip(chip.key)}>×</button>
            </li>
          ))}
          <li>
            <button className={styles.clearButton} type="button" onClick={onReset}>{tr("analyticsResetFilters")}</button>
          </li>
        </ul>
      ) : (
        <p className={styles.subtle}>{tr("analyticsNoActiveFilters")}</p>
      )}
      {open && (
        <div id="analytics-filters-body">
          <h3 className={styles.filterSubhead}>{tr("analyticsFiltersBasic")}</h3>
          <div className={styles.filterGrid}>
            <Field label={tr("analyticsDatePreset")}>
              <select value={preset} onChange={(event) => {
                const value = event.target.value;
                if (value !== "custom") applyPreset(value as Exclude<DatePreset, "custom">);
              }}>
                <option value="7">{tr("analyticsPreset7d")}</option>
                <option value="30">{tr("analyticsPreset30d")}</option>
                <option value="90">{tr("analyticsPreset90d")}</option>
                <option value="custom">{tr("analyticsPresetCustom")}</option>
              </select>
            </Field>
            <Field label={tr("analyticsFrom")}>
              <input type="date" value={filters.from} onChange={(event) => update("from", event.target.value)} />
            </Field>
            <Field label={tr("analyticsTo")}>
              <input type="date" value={filters.to} onChange={(event) => update("to", event.target.value)} />
            </Field>
          </div>
          <button
            className={styles.clearButton}
            type="button"
            aria-expanded={advanced}
            onClick={() => setAdvanced((value) => !value)}
          >
            {advanced ? tr("analyticsFiltersHide") : tr("analyticsFiltersAdvanced")}
          </button>
          {advanced && (
            <>
              <h3 className={styles.filterSubhead}>{tr("analyticsFiltersAdvanced")}</h3>
              <div className={styles.filterGrid}>
                <Field label={tr("orderNumber")}>
                  <input inputMode="numeric" value={filters.orderNumber} onChange={(event) => update("orderNumber", event.target.value)} placeholder={tr("orderNumberPlaceholder")} />
                </Field>
                <Field label={tr("location")}>
                  <input value={filters.location} onChange={(event) => update("location", event.target.value.toUpperCase())} />
                </Field>
                <Field label={tr("sku")}>
                  <input value={filters.sku} onChange={(event) => update("sku", event.target.value.toUpperCase())} />
                </Field>
                <SelectField label={tr("analyticsPhase")} value={filters.phase} options={selects.phases} onChange={(value) => update("phase", value)} />
                <SelectField label={tr("analyticsResolution")} value={filters.resolution} options={selects.resolutions} onChange={(value) => update("resolution", value)} />
                <SelectField label={tr("analyticsSource")} value={filters.source} options={selects.sources} onChange={(value) => update("source", value)} />
                <SelectField label={tr("analyticsConfiguration")} value={filters.configVersion} options={selects.configs} onChange={(value) => update("configVersion", value)} />
                <SelectField label={tr("analyticsPicker")} value={filters.pickerUserId} options={selects.people} onChange={(value) => update("pickerUserId", value)} />
                <SelectField label={tr("analyticsChecker")} value={filters.checkerUserId} options={selects.people} onChange={(value) => update("checkerUserId", value)} />
                <SelectField label={tr("analyticsTroubleshooter")} value={filters.troubleshooterUserId} options={selects.people} onChange={(value) => update("troubleshooterUserId", value)} />
                <SelectField label={tr("analyticsRoleFilter")} value={filters.role} options={selects.roles} onChange={(value) => update("role", value)} />
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
