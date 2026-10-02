"use client";

import styles from "../analytics-dashboard.module.css";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Locale, MessageKey } from "@/i18n/messages";
import type { AgingBuckets, VolumePoint } from "./derive";

type Translate = (key: MessageKey, values?: Record<string, string>) => string;

export const ANALYTICS_CHART_COLORS = [
  "var(--tone-blue)",
  "var(--tone-mint)",
  "var(--tone-amber)",
  "var(--tone-lavender)",
  "var(--tone-rose)",
  "var(--tone-gray)",
] as const;

const TICK_STYLE = { fill: "var(--muted)", fontSize: 11 } as const;

function NoData({ message }: { message: string }) {
  return (
    <p className={styles.chartEmpty} role="status">
      {message}
    </p>
  );
}

type VolumeDatum = { period: string; label: string; created: number; lines: number; resolved: number };

export function VolumeChart({ data, tr, locale, sliceNote }: {
  data: VolumePoint[];
  tr: Translate;
  locale: Locale;
  sliceNote: string;
}) {
  void locale;
  if (!data.length) return <NoData message={tr("analyticsNoData")} />;
  const chartData: VolumeDatum[] = data.map((point) => ({
    period: point.period,
    label: point.period,
    created: point.cases,
    lines: point.lines,
    resolved: point.resolved,
  }));
  return (
    <figure className={styles.chartFigure}>
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={TICK_STYLE} minTickGap={24} />
          <YAxis tick={TICK_STYLE} allowDecimals={false} width={48} />
          <Tooltip
            contentStyle={{ background: "var(--surface)", border: "1px solid var(--line-strong)", borderRadius: 8, color: "var(--ink)", fontSize: 12 }}
            labelStyle={{ color: "var(--ink)" }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Area type="monotone" dataKey="created" name={tr("analyticsVolumeCreated")} stroke={ANALYTICS_CHART_COLORS[0]} fill={ANALYTICS_CHART_COLORS[0]} fillOpacity={0.22} strokeWidth={2} />
          <Area type="monotone" dataKey="lines" name={tr("analyticsVolumeLines")} stroke={ANALYTICS_CHART_COLORS[2]} fill={ANALYTICS_CHART_COLORS[2]} fillOpacity={0.16} strokeWidth={2} />
          <Area type="monotone" dataKey="resolved" name={tr("analyticsVolumeResolved")} stroke={ANALYTICS_CHART_COLORS[1]} fill={ANALYTICS_CHART_COLORS[1]} fillOpacity={0.16} strokeWidth={2} strokeDasharray="5 3" />
        </AreaChart>
      </ResponsiveContainer>
      <figcaption className={styles.chartNote}>{sliceNote}</figcaption>
    </figure>
  );
}

export function TopBarsChart({ data, tr, topNote, emptyLabel }: {
  data: Array<{ label: string; count: number }>;
  tr: Translate;
  topNote: string;
  emptyLabel: string;
}) {
  void tr;
  const shown = data.slice(0, 10);
  if (!shown.length) return <NoData message={emptyLabel} />;
  const chartData = shown.map((item) => ({ name: item.label, value: item.count }));
  return (
    <figure className={styles.chartFigure}>
      <ResponsiveContainer width="100%" height={Math.max(220, shown.length * 30)}>
        <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 12, bottom: 0, left: 8 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" tick={TICK_STYLE} allowDecimals={false} />
          <YAxis type="category" dataKey="name" tick={TICK_STYLE} width={104} tickFormatter={(value: string) => (value.length > 14 ? `${value.slice(0, 13)}…` : value)} />
          <Tooltip
            contentStyle={{ background: "var(--surface)", border: "1px solid var(--line-strong)", borderRadius: 8, color: "var(--ink)", fontSize: 12 }}
            labelStyle={{ color: "var(--ink)" }}
          />
          <Bar dataKey="value" name="count" radius={[0, 6, 6, 0]}>
            {chartData.map((entry, index) => (
              <Cell key={entry.name} fill={ANALYTICS_CHART_COLORS[index % ANALYTICS_CHART_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <figcaption className={styles.chartNote}>{topNote}</figcaption>
    </figure>
  );
}

export function PhaseDonutChart({ data, tr, emptyLabel, labelFor }: {
  data: Array<{ phase: string; count: number }>;
  tr: Translate;
  emptyLabel: string;
  labelFor: (phase: string) => string;
}) {
  void tr;
  if (!data.length) return <NoData message={emptyLabel} />;
  const chartData = data.map((entry) => ({ name: labelFor(entry.phase), value: entry.count }));
  const total = chartData.reduce((sum, entry) => sum + entry.value, 0);
  return (
    <figure className={styles.chartFigure}>
      <ResponsiveContainer width="100%" height={240}>
        <PieChart>
          <Pie data={chartData} dataKey="value" nameKey="name" innerRadius={52} outerRadius={88} paddingAngle={2} stroke="var(--surface)" strokeWidth={2}>
            {chartData.map((entry, index) => (
              <Cell key={entry.name} fill={ANALYTICS_CHART_COLORS[index % ANALYTICS_CHART_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{ background: "var(--surface)", border: "1px solid var(--line-strong)", borderRadius: 8, color: "var(--ink)", fontSize: 12 }}
            formatter={(value: unknown) => {
              const count = typeof value === "number" ? value : 0;
              const share = total ? Math.round((count / total) * 100) : 0;
              return [`${count} (${share}%)`, ""];
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
        </PieChart>
      </ResponsiveContainer>
    </figure>
  );
}

export function OutcomeBarsChart({ found, notFound, wrongLocation, tr, emptyLabel }: {
  found: number;
  notFound: number;
  wrongLocation: number;
  tr: Translate;
  emptyLabel: string;
}) {
  const chartData = [
    { name: tr("analyticsResolutionFound"), value: found, fill: ANALYTICS_CHART_COLORS[1] },
    { name: tr("analyticsResolutionNotFound"), value: notFound, fill: ANALYTICS_CHART_COLORS[4] },
    { name: tr("analyticsResolutionWrongLocation"), value: wrongLocation, fill: ANALYTICS_CHART_COLORS[2] },
  ];
  if (!found && !notFound && !wrongLocation) return <NoData message={emptyLabel} />;
  return (
    <figure className={styles.chartFigure}>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="name" tick={TICK_STYLE} interval={0} tickFormatter={(value: string) => (value.length > 12 ? `${value.slice(0, 11)}…` : value)} />
          <YAxis tick={TICK_STYLE} allowDecimals={false} width={44} />
          <Tooltip
            contentStyle={{ background: "var(--surface)", border: "1px solid var(--line-strong)", borderRadius: 8, color: "var(--ink)", fontSize: 12 }}
            labelStyle={{ color: "var(--ink)" }}
          />
          <Bar dataKey="value" name="count" radius={[6, 6, 0, 0]}>
            {chartData.map((entry) => (
              <Cell key={entry.name} fill={entry.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}

export function AgingChart({ buckets, tr, emptyLabel, sliceNote }: {
  buckets: AgingBuckets;
  tr: Translate;
  emptyLabel: string;
  sliceNote: string;
}) {
  const chartData = [
    { name: tr("analyticsAgingUnder1d"), value: buckets.under1d, fill: ANALYTICS_CHART_COLORS[1] },
    { name: tr("analyticsAging1to3d"), value: buckets.d1to3, fill: ANALYTICS_CHART_COLORS[0] },
    { name: tr("analyticsAging3to7d"), value: buckets.d3to7, fill: ANALYTICS_CHART_COLORS[2] },
    { name: tr("analyticsAgingOver7d"), value: buckets.over7d, fill: ANALYTICS_CHART_COLORS[4] },
  ];
  if (!buckets.open) return <NoData message={emptyLabel} />;
  return (
    <figure className={styles.chartFigure}>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="name" tick={TICK_STYLE} interval={0} />
          <YAxis tick={TICK_STYLE} allowDecimals={false} width={44} />
          <Tooltip
            contentStyle={{ background: "var(--surface)", border: "1px solid var(--line-strong)", borderRadius: 8, color: "var(--ink)", fontSize: 12 }}
            labelStyle={{ color: "var(--ink)" }}
          />
          <Bar dataKey="value" name="count" radius={[6, 6, 0, 0]}>
            {chartData.map((entry) => (
              <Cell key={entry.name} fill={entry.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <figcaption className={styles.chartNote}>{sliceNote}</figcaption>
    </figure>
  );
}

export function ReporterBarsChart({ data, tr, emptyLabel, sliceNote }: {
  data: Array<{ userId: string; label: string; count: number }>;
  tr: Translate;
  emptyLabel: string;
  sliceNote: string;
}) {
  void tr;
  const shown = data.slice(0, 8);
  if (!shown.length) return <NoData message={emptyLabel} />;
  const chartData = shown.map((entry) => ({ name: entry.label, value: entry.count }));
  return (
    <figure className={styles.chartFigure}>
      <ResponsiveContainer width="100%" height={Math.max(200, shown.length * 32)}>
        <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 12, bottom: 0, left: 8 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" tick={TICK_STYLE} allowDecimals={false} />
          <YAxis type="category" dataKey="name" tick={TICK_STYLE} width={104} tickFormatter={(value: string) => (value.length > 14 ? `${value.slice(0, 13)}…` : value)} />
          <Tooltip
            contentStyle={{ background: "var(--surface)", border: "1px solid var(--line-strong)", borderRadius: 8, color: "var(--ink)", fontSize: 12 }}
            labelStyle={{ color: "var(--ink)" }}
          />
          <Bar dataKey="value" name="count" fill={ANALYTICS_CHART_COLORS[0]} radius={[0, 6, 6, 0]} />
        </BarChart>
      </ResponsiveContainer>
      <figcaption className={styles.chartNote}>{sliceNote}</figcaption>
    </figure>
  );
}
