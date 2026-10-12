"use client";

import { useId } from "react";
import type { AnalyticsManagement, PeriodChange } from "@/domain/analytics-management";
import type { Locale, MessageKey } from "@/i18n/messages";
import styles from "./management-summary.module.css";

type Translate = (key: MessageKey, values?: Record<string, string>) => string;

const LOCALE_TAGS: Record<Locale, string> = { en: "en-GB", nl: "nl-NL", pl: "pl-PL", es: "es-ES" };

/** Parses UTC ISO strings and calendar dates; keeps narrowing explicit. */
function toDate(value: string | Date): Date | null {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

function formatDate(value: string | Date, locale: Locale, withTime = false): string {
  const parsed = toDate(value);
  if (!parsed) return typeof value === "string" ? value : "—";
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], withTime
    ? { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }
    : { dateStyle: "medium", timeZone: "UTC" }).format(parsed);
}

function formatCount(value: number, locale: Locale): string {
  return new Intl.NumberFormat(LOCALE_TAGS[locale]).format(value);
}

/** The API range is half-open; the inclusive end is one millisecond earlier. */
function periodRange(from: string, toExclusive: string, locale: Locale): string {
  const end = toDate(toExclusive);
  const inclusiveEnd = end ? new Date(end.valueOf() - 1) : null;
  const start = formatDate(from, locale);
  return inclusiveEnd ? `${start} – ${formatDate(inclusiveEnd, locale)}` : start;
}

function changeText(change: PeriodChange, locale: Locale, tr: Translate): string {
  if (change.current === 0 && change.previous === 0) return tr("managementChangeNoChange");
  if (change.percentage === null || !Number.isFinite(change.percentage)) return tr("managementChangeNoBaseline");
  if (change.delta === 0) return tr("managementChangeNoChange");
  return new Intl.NumberFormat(LOCALE_TAGS[locale], { style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero" }).format(change.percentage / 100);
}

type Metric = { labelKey: MessageKey; change: PeriodChange };

function ChangeTile({ metric, locale, tr }: { metric: Metric; locale: Locale; tr: Translate }) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{tr(metric.labelKey)}</span>
      <strong className={styles.tileValue}>{formatCount(metric.change.current, locale)}</strong>
      <span className={styles.tilePrevious}>{tr("managementPreviousCount", { count: formatCount(metric.change.previous, locale) })}</span>
      <span className={styles.tileChange}>
        <span className={styles.delta}>
          {new Intl.NumberFormat(LOCALE_TAGS[locale], { signDisplay: "exceptZero" }).format(metric.change.delta)}
        </span>
        <span className={styles.percent}>{changeText(metric.change, locale, tr)}</span>
      </span>
    </div>
  );
}

function CountTile({ labelKey, value, locale, tr }: { labelKey: MessageKey; value: number; locale: Locale; tr: Translate }) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{tr(labelKey)}</span>
      <strong className={styles.tileValue}>{formatCount(value, locale)}</strong>
    </div>
  );
}

export function ManagementSummary({ data, tr, locale, canExport, exporting, onExport }: {
  data: AnalyticsManagement;
  tr: Translate;
  locale: Locale;
  canExport: boolean;
  exporting: boolean;
  onExport: () => void;
}) {
  const { comparison, backlog, lifetimeRecurrence } = data;
  const baseId = useId();
  const metrics: Metric[] = [
    { labelKey: "managementReportedCases", change: comparison.changes.cases },
    { labelKey: "managementCohortLines", change: comparison.changes.lines },
    { labelKey: "managementCasesResolved", change: comparison.changes.resolvedCases },
  ];
  const snapshotCounts: Array<{ labelKey: MessageKey; value: number }> = [
    { labelKey: "managementTotalOpen", value: backlog.totalOpen },
    { labelKey: "managementPicking", value: backlog.picking },
    { labelKey: "managementStaged", value: backlog.staged },
    { labelKey: "managementUnassignedStaged", value: backlog.unassignedStaged },
  ];
  const agingBands: Array<{ labelKey: MessageKey; value: number }> = [
    { labelKey: "managementAgingUnder24", value: backlog.aging.under24h },
    { labelKey: "managementAging24to72", value: backlog.aging.h24to72 },
    { labelKey: "managementAging72to168", value: backlog.aging.h72to168 },
    { labelKey: "managementAgingOver168", value: backlog.aging.over168h },
  ];

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <h2 className={styles.title}>{tr("managementTitle")}</h2>
        {canExport ? (
          <button type="button" className={styles.exportButton} disabled={exporting} onClick={onExport}>
            {tr("managementExportCsv")}
          </button>
        ) : null}
      </div>

      <div className={styles.pairRow}>
        <section className={styles.card} aria-labelledby={`${baseId}-comparison`}>
          <div className={styles.cardHead}>
            <h3 id={`${baseId}-comparison`} className={styles.cardTitle}>
              {tr("managementComparisonTitle")}
            </h3>
            <p className={styles.range}>
              {tr("managementCurrentPeriod", { range: periodRange(comparison.current.from, comparison.current.toExclusive, locale) })}
            </p>
            <p className={styles.range}>
              {tr("managementPreviousPeriod", { range: periodRange(comparison.previous.from, comparison.previous.toExclusive, locale) })}
            </p>
          </div>
          <div className={styles.tileGrid}>
            {metrics.map((metric) => (
              <ChangeTile key={metric.labelKey} metric={metric} locale={locale} tr={tr} />
            ))}
          </div>
          <p className={styles.note}>{tr("managementComparisonNote")}</p>
        </section>

        <section className={styles.card} aria-labelledby={`${baseId}-backlog`}>
          <div className={styles.cardHead}>
            <h3 id={`${baseId}-backlog`} className={styles.cardTitle}>
              {tr("managementBacklogTitle")}
            </h3>
            <p className={styles.meta}>{tr("managementSnapshot", { at: formatDate(backlog.asOf, locale, true) })}</p>
          </div>
          <div className={`${styles.tileGrid} ${styles.backlogCounts}`}>
            {snapshotCounts.map((entry) => (
              <CountTile key={entry.labelKey} labelKey={entry.labelKey} value={entry.value} locale={locale} tr={tr} />
            ))}
          </div>
          <p className={styles.note}>{tr("managementBacklogNote")}</p>

          <div className={styles.subhead}>
            <h4 className={styles.subTitle}>{tr("managementAgingTitle")}</h4>
            <p className={styles.meta}>{tr("managementAgingNote")}</p>
          </div>
          {backlog.truncated ? (
            <p className={styles.warnText}>
              {tr("managementAgingTruncated", {
                evaluated: formatCount(backlog.evaluatedCases, locale),
                total: formatCount(backlog.totalOpen, locale),
              })}
            </p>
          ) : (
            <div className={styles.bandGrid}>
              {agingBands.map((band) => (
                <CountTile key={band.labelKey} labelKey={band.labelKey} value={band.value} locale={locale} tr={tr} />
              ))}
              <CountTile labelKey="managementOverThreshold" value={backlog.overThreshold} locale={locale} tr={tr} />
            </div>
          )}

          <p className={styles.oldest}>
            <span className={styles.meta}>{tr("managementOldestReported")}</span>{" "}
            <strong>{backlog.oldestCreatedAt ? formatDate(backlog.oldestCreatedAt, locale) : "-"}</strong>
            <span className={styles.meta}> {tr("managementOldestNote")}</span>
          </p>
        </section>
      </div>

      <section className={styles.card} aria-labelledby={`${baseId}-recurrence`}>
        <details className={styles.details}>
          <summary className={styles.detailsSummary}>
            <span id={`${baseId}-recurrence`} className={styles.cardTitle}>
              {tr("managementRecurrenceTitle")}
            </span>
            <span className={styles.meta}>{tr("managementRecurrenceSummary", { count: formatCount(lifetimeRecurrence.repeatedOrderCount, locale) })}</span>
          </summary>
          <p className={styles.note}>{tr("managementRecurrenceNote")}</p>
          {lifetimeRecurrence.groupsTruncated ? <p className={styles.warnText}>{tr("managementRecurrenceGroupsTruncated")}</p> : null}
          {lifetimeRecurrence.datesTruncated ? <p className={styles.warnText}>{tr("managementRecurrenceDatesTruncated")}</p> : null}
          {lifetimeRecurrence.orders.length ? (
            <div className={styles.tableWrap}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">{tr("managementColumnOrder")}</th>
                    <th scope="col">{tr("managementColumnOccurrences")}</th>
                    <th scope="col">{tr("managementColumnSelectedPeriod")}</th>
                    <th scope="col">{tr("managementColumnFirstSeen")}</th>
                    <th scope="col">{tr("managementColumnLastSeen")}</th>
                    <th scope="col">{tr("managementColumnDates")}</th>
                  </tr>
                </thead>
                <tbody>
                  {lifetimeRecurrence.orders.map((order) => (
                    <tr key={order.orderNumber}>
                      <th scope="row">{order.orderNumber}</th>
                      <td>{formatCount(order.occurrences, locale)}</td>
                      <td>{formatCount(order.selectedPeriodOccurrences, locale)}</td>
                      <td><time dateTime={order.firstSeenAt || undefined}>{formatDate(order.firstSeenAt, locale)}</time></td>
                      <td><time dateTime={order.lastSeenAt || undefined}>{formatDate(order.lastSeenAt, locale)}</time></td>
                      <td>
                        <details className={styles.dateDetails}>
                          <summary className={styles.dateSummary}>{tr("managementShowDates")}</summary>
                          <div className={styles.dateList}>
                            {order.cases.length ? (
                              order.cases.map((entry) => (
                                <time key={entry.caseId} dateTime={entry.createdAt || undefined}>
                                  {formatDate(entry.createdAt, locale)}
                                </time>
                              ))
                            ) : (
                              <span className={styles.meta}>-</span>
                            )}
                          </div>
                          {order.datesTruncated ? <p className={styles.warnText}>{tr("managementRecurrenceGroupDatesTruncated")}</p> : null}
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className={styles.empty}>{tr("managementRecurrenceEmpty")}</p>
          )}
        </details>
      </section>
    </div>
  );
}
