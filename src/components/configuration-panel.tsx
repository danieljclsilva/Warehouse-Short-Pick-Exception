"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MessageKey } from "@/i18n/messages";
import { DEFAULT_WORKING_HOURS } from "@/domain/working-hours";
import { PaginationControls } from "@/components/pagination-controls";
import styles from "./configuration-panel.module.css";

type Translator = (key: MessageKey, values?: Record<string, string>) => string;
type ConfigValue = boolean | number | string | string[] | number[] | null;
type ConfigValues = Record<string, ConfigValue>;
type ConfigurationRecord = {
  id?: string;
  version?: number;
  versionId?: string;
  values?: Record<string, unknown>;
  createdAt?: string;
  changedAt?: string;
  changedBy?: string | { displayName?: string } | null;
};
type HistoryRecord = ConfigurationRecord & { previousVersion?: number | string | null; changedValues?: Record<string, unknown> };
type ConfigurationResponse = {
  configuration?: ConfigurationRecord;
  current?: ConfigurationRecord;
  values?: Record<string, unknown>;
  version?: number;
  history?: HistoryRecord[];
  versions?: HistoryRecord[];
  defaults?: Record<string, unknown>;
  total?: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
  error?: string;
};

type Props = { tr: Translator; locale: string; role: string };

const defaults: ConfigValues = {
  MAX_SIMULTANEOUS_CHECKS_PER_CASE: 1,
  CLAIM_CHECKS_ENABLED: true,
  CHECKER_RETRIEVAL_DURING_PICKING_ENABLED: false,
  CHECKER_RETRIEVAL_WHEN_STAGED_ENABLED: true,
  WARNING_THRESHOLD_MINUTES: 5,
  ATTENTION_THRESHOLD_MINUTES: 10,
  CRITICAL_THRESHOLD_MINUTES: 15,
  REQUIRE_STAGING_CONFIRMATION: true,
  INVITE_DEFAULT_EXPIRY_HOURS: 8,
  INVITE_DEFAULT_MAX_REGISTRATIONS: 1,
  LOGIN_MAX_FAILED_ATTEMPTS: 5,
  LOGIN_LOCKOUT_MINUTES: 15,
  SHORT_PICK_HOLD_LOCATION_NAME: "SHORT PICK / HOLD",
  WORKING_HOURS_TIME_ZONE: DEFAULT_WORKING_HOURS.timeZone,
  WORKING_HOURS_DAYS: [...DEFAULT_WORKING_HOURS.days],
  WORKING_HOURS_START: DEFAULT_WORKING_HOURS.start,
  WORKING_HOURS_END: DEFAULT_WORKING_HOURS.end,
  ALLOWED_RESOLUTION_CODES: ["FOUND", "NOT_FOUND", "WRONG_LOCATION", "OTHER"],
  MANUAL_CASE_CREATION_ENABLED: true,
  ASSISTANT_CAN_MANAGE_CONFIGURATION: false,
  PUSH_ENABLED: true,
  PROFILE_PHOTO_MAX_UPLOAD_BYTES: 5 * 1024 * 1024,
};

const MEBIBYTE_BYTES = 1024 * 1024;
const PROFILE_PHOTO_MIN_UPLOAD_BYTES = 64 * 1024;
const PROFILE_PHOTO_MAX_UPLOAD_BYTES = 25 * MEBIBYTE_BYTES;

type Definition = {
  key: string;
  label: MessageKey;
  description: MessageKey;
  kind: "number" | "boolean" | "text" | "codes" | "uploadSize";
  min?: number;
  max?: number;
};

const definitions: Array<{ title: MessageKey; description: MessageKey; settings: Definition[] }> = [
  {
    title: "configurationWorkflowTitle",
    description: "configurationWorkflowDescription",
    settings: [
      { key: "MAX_SIMULTANEOUS_CHECKS_PER_CASE", label: "configurationMaxChecks", description: "configurationMaxChecksDescription", kind: "number", min: 1, max: 100 },
      { key: "CLAIM_CHECKS_ENABLED", label: "configurationClaimChecks", description: "configurationClaimChecksDescription", kind: "boolean" },
      { key: "CHECKER_RETRIEVAL_DURING_PICKING_ENABLED", label: "configurationRetrievalPicking", description: "configurationRetrievalPickingDescription", kind: "boolean" },
      { key: "CHECKER_RETRIEVAL_WHEN_STAGED_ENABLED", label: "configurationRetrievalStaged", description: "configurationRetrievalStagedDescription", kind: "boolean" },
      { key: "REQUIRE_STAGING_CONFIRMATION", label: "configurationStagingConfirmation", description: "configurationStagingConfirmationDescription", kind: "boolean" },
      { key: "MANUAL_CASE_CREATION_ENABLED", label: "configurationManualCases", description: "configurationManualCasesDescription", kind: "boolean" },
      { key: "ALLOWED_RESOLUTION_CODES", label: "configurationResolutionCodes", description: "configurationResolutionCodesDescription", kind: "codes" },
    ],
  },
  {
    title: "configurationThresholdsTitle",
    description: "configurationThresholdsDescription",
    settings: [
      { key: "WARNING_THRESHOLD_MINUTES", label: "configurationWarningThreshold", description: "configurationWarningThresholdDescription", kind: "number", min: 1, max: 1440 },
      { key: "ATTENTION_THRESHOLD_MINUTES", label: "configurationAttentionThreshold", description: "configurationAttentionThresholdDescription", kind: "number", min: 1, max: 1440 },
      { key: "CRITICAL_THRESHOLD_MINUTES", label: "configurationCriticalThreshold", description: "configurationCriticalThresholdDescription", kind: "number", min: 1, max: 1440 },
    ],
  },
  {
    title: "configurationSecurityTitle",
    description: "configurationSecurityDescription",
    settings: [
      { key: "INVITE_DEFAULT_EXPIRY_HOURS", label: "configurationInviteExpiry", description: "configurationInviteExpiryDescription", kind: "number", min: 1, max: 720 },
      { key: "INVITE_DEFAULT_MAX_REGISTRATIONS", label: "configurationInviteRegistrations", description: "configurationInviteRegistrationsDescription", kind: "number", min: 1, max: 100 },
      { key: "LOGIN_MAX_FAILED_ATTEMPTS", label: "configurationLoginAttempts", description: "configurationLoginAttemptsDescription", kind: "number", min: 1, max: 20 },
      { key: "LOGIN_LOCKOUT_MINUTES", label: "configurationLoginLockout", description: "configurationLoginLockoutDescription", kind: "number", min: 1, max: 1440 },
      { key: "ASSISTANT_CAN_MANAGE_CONFIGURATION", label: "configurationAssistantAccess", description: "configurationAssistantAccessDescription", kind: "boolean" },
      { key: "PUSH_ENABLED", label: "configurationPushEnabled", description: "configurationPushEnabledDescription", kind: "boolean" },
      { key: "PROFILE_PHOTO_MAX_UPLOAD_BYTES", label: "configurationUploadLimit", description: "configurationUploadLimitDescription", kind: "uploadSize", min: PROFILE_PHOTO_MIN_UPLOAD_BYTES, max: PROFILE_PHOTO_MAX_UPLOAD_BYTES },
    ],
  },
  {
    title: "configurationOperationsTitle",
    description: "configurationOperationsDescription",
    settings: [
      { key: "SHORT_PICK_HOLD_LOCATION_NAME", label: "configurationHoldLocation", description: "configurationHoldLocationDescription", kind: "text" },
    ],
  },
];

function readValue(value: unknown, fallback: ConfigValue): ConfigValue {
  if (typeof fallback === "boolean") return typeof value === "boolean" ? value : fallback;
  if (typeof fallback === "number") return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  if (Array.isArray(fallback)) {
    if (!Array.isArray(value)) return fallback;
    if (fallback.every((item) => typeof item === "number")) return value.filter((item): item is number => typeof item === "number");
    return value.filter((item): item is string => typeof item === "string");
  }
  return typeof value === "string" ? value : fallback;
}

function normalizeValues(raw: Record<string, unknown> | undefined): ConfigValues {
  return Object.keys(defaults).reduce<ConfigValues>((result, key) => {
    result[key] = key === "MAX_SIMULTANEOUS_CHECKS_PER_CASE" && raw?.[key] === null ? null : readValue(raw?.[key], defaults[key]);
    return result;
  }, { ...defaults });
}

function recordFrom(body: ConfigurationResponse): ConfigurationRecord {
  return body.configuration ?? body.current ?? { values: body.values, version: body.version, versionId: (body as ConfigurationResponse & { versionId?: string }).versionId };
}

function recordValues(record: ConfigurationRecord, body: ConfigurationResponse) {
  return normalizeValues(record.values ?? body.values);
}

function versionFrom(record: ConfigurationRecord, body: ConfigurationResponse) {
  return typeof record.version === "number" ? record.version : typeof body.version === "number" ? body.version : 0;
}

function formatDate(value: string | undefined, locale: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(locale === "nl" ? "nl-NL" : locale === "pl" ? "pl-PL" : locale === "es" ? "es-ES" : "en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function bytesToMebibytes(value: number) {
  const rounded = Number((value / MEBIBYTE_BYTES).toFixed(7));
  return String(rounded);
}

function mebibytesToBytes(value: string): number | null {
  if (!value.trim()) return null;
  const mebibytes = Number(value);
  if (!Number.isFinite(mebibytes)) return null;
  const bytes = Math.round(mebibytes * MEBIBYTE_BYTES);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

const WORKING_HOUR_DAYS: Array<{ day: number; label: MessageKey }> = [
  { day: 1, label: "workingHoursMonday" },
  { day: 2, label: "workingHoursTuesday" },
  { day: 3, label: "workingHoursWednesday" },
  { day: 4, label: "workingHoursThursday" },
  { day: 5, label: "workingHoursFriday" },
  { day: 6, label: "workingHoursSaturday" },
  { day: 7, label: "workingHoursSunday" },
];

function isValidTimeRange(start: string, end: string) {
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(start)) return false;
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(end)) return false;
  return start < end;
}

function formatWorkingHoursDefault(days: unknown, start: unknown, end: unknown, timeZone: unknown) {
  const dayList = Array.isArray(days) ? days.filter((item): item is number => typeof item === "number").join(", ") : String(days ?? "");
  return `${dayList} · ${start ?? ""}–${end ?? ""} · ${timeZone ?? ""}`;
}

function actorName(actor: HistoryRecord["changedBy"]) {
  if (typeof actor === "string") return actor;
  return actor?.displayName || "—";
}

export function ConfigurationPanel({ tr, locale, role }: Props) {
  const [values, setValues] = useState<ConfigValues>(defaults);
  const [baseline, setBaseline] = useState<ConfigValues>(defaults);
  const [serverDefaults, setServerDefaults] = useState<ConfigValues>(defaults);
  const [version, setVersion] = useState(0);
  const [versionId, setVersionId] = useState("");
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [historyPage, setHistoryPage] = useState({ total: 0, page: 1, pageSize: 20, totalPages: 1 });
  const applyHistoryPage = (body: ConfigurationResponse, nextPage: number) => {
    const entries = body.history ?? body.versions ?? [];
    setHistory(entries);
    setHistoryPage({
      total: typeof body.total === "number" ? body.total : entries.length,
      page: typeof body.page === "number" && body.page >= 1 ? body.page : nextPage,
      pageSize: typeof body.pageSize === "number" && body.pageSize >= 1 ? body.pageSize : 20,
      totalPages: typeof body.totalPages === "number" && body.totalPages >= 1 ? body.totalPages : 1,
    });
  };
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [uploadSizeInput, setUploadSizeInput] = useState(bytesToMebibytes(Number(defaults.PROFILE_PHOTO_MAX_UPLOAD_BYTES)));

  const historyPageRef = useRef(historyPage.page);
  useEffect(() => { historyPageRef.current = historyPage.page; }, [historyPage.page]);
  const load = useCallback(async (nextHistoryPage?: number) => {
    setLoading(true);
    setError("");
    try {
      const page = typeof nextHistoryPage === "number" && nextHistoryPage >= 1 ? nextHistoryPage : historyPageRef.current;
      const response = await fetch(`/api/admin/configuration?page=${page}&pageSize=20`, { credentials: "same-origin", cache: "no-store" });
      const body = await response.json().catch(() => ({})) as ConfigurationResponse;
      if (!response.ok) throw new Error(body.error || tr("configurationLoadError"));
      const record = recordFrom(body);
      const catalogDefaults = normalizeValues(body.defaults);
      setServerDefaults(catalogDefaults);
      const loadedValues = { ...catalogDefaults, ...recordValues(record, body) };
      setValues(loadedValues);
      setBaseline(loadedValues);
      setUploadSizeInput(bytesToMebibytes(Number(loadedValues.PROFILE_PHOTO_MAX_UPLOAD_BYTES)));
      setVersion(versionFrom(record, body));
      setVersionId(record.versionId ?? "");
      applyHistoryPage(body, page);
      setConflict(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("configurationLoadError"));
    } finally {
      setLoading(false);
    }
  }, [tr]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const updateValue = (key: string, value: ConfigValue) => {
    setNotice("");
    setConflict(false);
    setValues((current) => ({ ...current, [key]: value }));
  };

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const uploadLimitBytes = mebibytesToBytes(uploadSizeInput);
    if (uploadLimitBytes === null || uploadLimitBytes < PROFILE_PHOTO_MIN_UPLOAD_BYTES || uploadLimitBytes > PROFILE_PHOTO_MAX_UPLOAD_BYTES) {
      setError(tr("configurationUploadLimitInvalid"));
      return;
    }
    const workingDays = Array.isArray(values.WORKING_HOURS_DAYS) ? values.WORKING_HOURS_DAYS : [];
    if (workingDays.length === 0) {
      setError(tr("configurationWorkingHoursEmptyDays"));
      return;
    }
    const workingStart = typeof values.WORKING_HOURS_START === "string" ? values.WORKING_HOURS_START : "";
    const workingEnd = typeof values.WORKING_HOURS_END === "string" ? values.WORKING_HOURS_END : "";
    if (!isValidTimeRange(workingStart, workingEnd)) {
      setError(tr("configurationWorkingHoursInvalidRange"));
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const valuesToSave: ConfigValues = { ...values, PROFILE_PHOTO_MAX_UPLOAD_BYTES: uploadLimitBytes };
      const changedValues = Object.keys(valuesToSave).reduce<Record<string, ConfigValue>>((result, key) => {
        if (role === "ASSISTANT" && key === "ASSISTANT_CAN_MANAGE_CONFIGURATION") return result;
        if (JSON.stringify(valuesToSave[key]) !== JSON.stringify(baseline[key])) result[key] = valuesToSave[key];
        return result;
      }, {});
      const response = await fetch("/api/admin/configuration", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ expectedVersion: version, values: changedValues }),
      });
      const body = await response.json().catch(() => ({})) as ConfigurationResponse;
      if (response.status === 409) {
        setConflict(true);
        throw new Error(body.error || tr("configurationConflict"));
      }
      if (!response.ok) throw new Error(body.error || tr("configurationSaveError"));
      const record = recordFrom(body);
      if (record.values || body.values) {
        const savedValues = { ...serverDefaults, ...recordValues(record, body) };
        setValues(savedValues);
        setBaseline(savedValues);
      }
      setVersion(versionFrom(record, body) || version + 1);
      setVersionId(record.versionId ?? versionId);
      if (body.history || body.versions) applyHistoryPage(body, historyPageRef.current);
      await load();
      setNotice(tr("configurationSaved"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("configurationSaveError"));
    } finally {
      setSaving(false);
    }
  };

  const settingCount = useMemo(() => definitions.reduce((count, group) => count + group.settings.filter((setting) => role !== "ASSISTANT" || setting.key !== "ASSISTANT_CAN_MANAGE_CONFIGURATION").length, 4), [role]);

  if (loading) return <div className={styles.panel}><p className={styles.loading} aria-live="polite">{tr("configurationLoading")}</p></div>;
  if (error && version === 0) return <div className={styles.panel}><div className={styles.error} role="alert"><span>{error}</span><div className={styles.errorActions}><button className={styles.reload} type="button" onClick={() => void load()}>{tr("tryAgain")}</button></div></div></div>;

  return (
    <div className={styles.panel}>
      <div className={styles.heading}>
        <div><h1>{tr("configurationTitle")}</h1><p>{tr("configurationDescription")}</p></div>
        <div className={styles.version}><span>{tr("configurationCurrentVersion")}</span><strong>{version ? `v${version}` : "—"}</strong>{versionId && <small title={versionId}>{versionId}</small>}</div>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {conflict && <p className={styles.error} role="alert">{tr("configurationConflictDescription")}</p>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      <form onSubmit={save}>
        {definitions.map((group) => (
          <section className={styles.section} key={group.title}>
            <div className={styles.sectionHeading}><div><h2>{tr(group.title)}</h2><p>{tr(group.description)}</p></div></div>
            <div className={styles.settings}>
              {group.settings.filter((setting) => role !== "ASSISTANT" || setting.key !== "ASSISTANT_CAN_MANAGE_CONFIGURATION").map((definition) => {
                const value = values[definition.key];
                const fallback = serverDefaults[definition.key] ?? defaults[definition.key];
                const formattedDefault = definition.kind === "uploadSize" && typeof fallback === "number"
                  ? `${bytesToMebibytes(fallback)} ${tr("configurationUnitMiB")}`
                  : Array.isArray(fallback) ? fallback.join(", ") : String(fallback);
                return <div className={styles.setting} key={definition.key}>
                  <div><h3>{tr(definition.label)}</h3><p>{tr(definition.description)}</p><small className={styles.default}>{tr("configurationDefault", { value: formattedDefault })}</small></div>
                  <div className={styles.control}>
                    {definition.kind === "boolean" && <label className={styles.toggle}><input type="checkbox" checked={Boolean(value)} onChange={(event) => updateValue(definition.key, event.target.checked)} /><span>{value ? tr("configurationEnabled") : tr("configurationDisabled")}</span></label>}
                    {definition.kind === "number" && definition.key === "MAX_SIMULTANEOUS_CHECKS_PER_CASE" ? <div className={styles.numberWithUnlimited}><label className={styles.toggle}><input type="checkbox" checked={value === null} onChange={(event) => updateValue(definition.key, event.target.checked ? null : 1)} /><span>{tr("configurationUnlimited")}</span></label>{value !== null && <input type="number" min={definition.min} max={definition.max} step={1} value={typeof value === "number" ? value : 1} onChange={(event) => updateValue(definition.key, Number(event.target.value))} aria-label={tr(definition.label)} />}</div> : definition.kind === "number" && <input type="number" min={definition.min} max={definition.max} step={1} value={typeof value === "number" ? value : ""} onChange={(event) => updateValue(definition.key, Number(event.target.value))} aria-label={tr(definition.label)} />}
                    {definition.kind === "uploadSize" && <div className={styles.uploadLimit}><input type="number" min={PROFILE_PHOTO_MIN_UPLOAD_BYTES / MEBIBYTE_BYTES} max={PROFILE_PHOTO_MAX_UPLOAD_BYTES / MEBIBYTE_BYTES} step="any" value={uploadSizeInput} onChange={(event) => {
                      const nextInput = event.target.value;
                      setUploadSizeInput(nextInput);
                      const nextBytes = mebibytesToBytes(nextInput);
                      if (nextBytes !== null && nextBytes >= PROFILE_PHOTO_MIN_UPLOAD_BYTES && nextBytes <= PROFILE_PHOTO_MAX_UPLOAD_BYTES) updateValue(definition.key, nextBytes);
                    }} aria-label={`${tr(definition.label)} (${tr("configurationUnitMiB")})`} /><span className={styles.uploadUnit} aria-hidden="true">{tr("configurationUnitMiB")}</span></div>}
                    {definition.kind === "text" && <input type="text" value={typeof value === "string" ? value : ""} onChange={(event) => updateValue(definition.key, event.target.value)} aria-label={tr(definition.label)} />}
                    {definition.kind === "codes" && <textarea value={Array.isArray(value) ? value.join(", ") : ""} onChange={(event) => updateValue(definition.key, event.target.value.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean))} aria-label={tr(definition.label)} />}
                  </div>
                </div>;
              })}
            </div>
          </section>
        ))}
        <section className={styles.section} aria-labelledby="configuration-working-hours-title">
          <div className={styles.sectionHeading}><div><h2 id="configuration-working-hours-title">{tr("configurationWorkingHoursTitle")}</h2><p>{tr("configurationWorkingHoursDescription")}</p></div></div>
          <div className={styles.settings}>
            <div className={styles.setting}>
              <div><h3>{tr("configurationWorkingHoursTimezone")}</h3><p>{tr("configurationWorkingHoursTimezoneDescription")}</p><small className={styles.default}>{tr("configurationWorkingHoursTimezoneValue")}</small></div>
              <div className={styles.control}><span aria-label={tr("configurationWorkingHoursTimezone")}>{tr("configurationWorkingHoursTimezoneValue")}</span></div>
            </div>
            <div className={styles.setting}>
              <div><h3>{tr("configurationWorkingHoursDays")}</h3><p>{tr("configurationWorkingHoursDaysDescription")}</p><small className={styles.default}>{tr("configurationDefault", { value: formatWorkingHoursDefault(serverDefaults.WORKING_HOURS_DAYS, serverDefaults.WORKING_HOURS_START, serverDefaults.WORKING_HOURS_END, serverDefaults.WORKING_HOURS_TIME_ZONE) })}</small></div>
              <div className={styles.control}><fieldset className={styles.dayGroup}><legend className={styles.srOnly}>{tr("configurationWorkingHoursDays")}</legend>{WORKING_HOUR_DAYS.map(({ day, label }) => {
                const selected: number[] = Array.isArray(values.WORKING_HOURS_DAYS) ? (values.WORKING_HOURS_DAYS as number[]) : [];
                const checked = selected.includes(day);
                return <label key={day} className={styles.toggle}><input type="checkbox" checked={checked} onChange={(event) => {
                  const next = event.target.checked ? [...selected, day].sort((a, b) => a - b) : selected.filter((item) => item !== day);
                  updateValue("WORKING_HOURS_DAYS", next);
                }} /><span>{tr(label)}</span></label>;
              })}</fieldset></div>
            </div>
            <div className={styles.setting}>
              <div><h3>{tr("configurationWorkingHoursStart")}</h3><p>{tr("configurationWorkingHoursStartDescription")}</p></div>
              <div className={styles.control}><input type="time" value={typeof values.WORKING_HOURS_START === "string" ? values.WORKING_HOURS_START : DEFAULT_WORKING_HOURS.start} onChange={(event) => updateValue("WORKING_HOURS_START", event.target.value)} aria-label={tr("configurationWorkingHoursStart")} /></div>
            </div>
            <div className={styles.setting}>
              <div><h3>{tr("configurationWorkingHoursEnd")}</h3><p>{tr("configurationWorkingHoursEndDescription")}</p></div>
              <div className={styles.control}><input type="time" value={typeof values.WORKING_HOURS_END === "string" ? values.WORKING_HOURS_END : DEFAULT_WORKING_HOURS.end} onChange={(event) => updateValue("WORKING_HOURS_END", event.target.value)} aria-label={tr("configurationWorkingHoursEnd")} /></div>
            </div>
          </div>
        </section>
        <div className={styles.actions}><button className={styles.reload} type="button" onClick={() => void load()} disabled={saving}>{tr("reloadConfiguration")}</button><button className={styles.save} type="submit" disabled={saving}>{saving ? tr("savingConfiguration") : tr("saveConfiguration")}</button></div>
      </form>
      <section className={styles.section} aria-labelledby="configuration-history-title">
        <div className={styles.sectionHeading}><div><h2 id="configuration-history-title">{tr("configurationHistoryTitle")}</h2><p>{tr("configurationHistoryDescription", { count: String(settingCount) })}</p></div></div>
        {history.length === 0 ? <p className={styles.empty}>{tr("configurationHistoryEmpty")}</p> : <><div className={styles.history}>
          {history.map((entry, index) => <div className={styles.historyRow} key={entry.id ?? entry.versionId ?? String(entry.version ?? index)}><strong>{entry.version ? `v${entry.version}` : "—"}</strong><span>{actorName(entry.changedBy)}</span><time dateTime={entry.changedAt ?? entry.createdAt}>{formatDate(entry.changedAt ?? entry.createdAt, locale)}</time><div className={styles.historyValues}>{Object.keys(entry.changedValues ?? entry.values ?? {}).slice(0, 8).map((key) => <code key={key}>{key}</code>)}</div></div>)}
        </div><PaginationControls tr={tr} meta={historyPage} loading={loading} onPage={(next) => { void load(next); }} /></>}
      </section>
    </div>
  );
}
