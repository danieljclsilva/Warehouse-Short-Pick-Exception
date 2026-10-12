/**
 * Working-hours case clock.
 *
 * Browser-safe (no Node/server imports): elapsed working time between two
 * instants is the overlap with the configured weekly schedule, evaluated in
 * the schedule's IANA time zone via `Intl`. Absolute timestamps are never
 * mutated; there are no running timers to persist.
 */

export type WorkingHours = {
  timeZone: string;
  /** ISO weekdays 1 = Monday .. 7 = Sunday. */
  days: number[];
  /** Local opening time, half-open `[start, end)`. */
  start: string;
  /** Local closing time, half-open `[start, end)`. */
  end: string;
};

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  timeZone: "Europe/Amsterdam",
  days: [1, 2, 3, 4, 5],
  start: "08:00",
  end: "17:00",
};

/** Fixed supported zone this release (explicit; no timezone picker). */
export const SUPPORTED_WORKING_TIME_ZONES = ["Europe/Amsterdam"] as const;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOfDay(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = TIME_PATTERN.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function daysOfWeek(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 7) return null;
  const days: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 1 || entry > 7) return null;
    if (days.includes(entry)) return null;
    days.push(entry);
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * Tolerantly derive a schedule from configuration-shaped input: missing or
 * invalid keys fall back to the defaults per key, so legacy rows stored
 * before these keys existed read as the default schedule. Never throws.
 */
export function workingHoursFromConfiguration(values: unknown): WorkingHours {
  if (!values || typeof values !== "object") return { ...DEFAULT_WORKING_HOURS, days: [...DEFAULT_WORKING_HOURS.days] };
  const record = values as Record<string, unknown>;
  const nested = record.workingHours && typeof record.workingHours === "object"
    ? (record.workingHours as Record<string, unknown>)
    : null;
  const pick = (key: string): unknown => (nested && key in nested ? nested[key] : record[key]);
  const timeZoneRaw = pick("timeZone") ?? pick("WORKING_HOURS_TIME_ZONE");
  const daysRaw = pick("days") ?? pick("WORKING_HOURS_DAYS");
  const startRaw = pick("start") ?? pick("WORKING_HOURS_START");
  const endRaw = pick("end") ?? pick("WORKING_HOURS_END");
  const timeZone = typeof timeZoneRaw === "string" && (SUPPORTED_WORKING_TIME_ZONES as readonly string[]).includes(timeZoneRaw)
    ? timeZoneRaw
    : DEFAULT_WORKING_HOURS.timeZone;
  const days = daysOfWeek(daysRaw) ?? [...DEFAULT_WORKING_HOURS.days];
  const startMinutes = minutesOfDay(startRaw);
  const endMinutes = minutesOfDay(endRaw);
  // No overnight shifts this release: reversed or equal windows fall back.
  const valid = startMinutes !== null && endMinutes !== null && startMinutes < endMinutes;
  return {
    timeZone,
    days,
    start: valid ? (startRaw as string) : DEFAULT_WORKING_HOURS.start,
    end: valid ? (endRaw as string) : DEFAULT_WORKING_HOURS.end,
  };
}

type Instant = Date | string | number;

function toTime(value: Instant): number | null {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function zonedFormat(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

type ZonedParts = { year: number; month: number; day: number; minutes: number; seconds: number; milliseconds: number };

function zonedParts(time: number, timeZone: string): ZonedParts {
  const byType: Record<string, string> = {};
  for (const part of zonedFormat(timeZone).formatToParts(new Date(time))) {
    if (part.type !== "literal") byType[part.type] = part.value;
  }
  // `hour12: false` can render midnight as "24".
  const hour = byType.hour === "24" ? 0 : Number(byType.hour);
  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    minutes: hour * 60 + Number(byType.minute),
    seconds: Number(byType.second),
    milliseconds: new Date(time).getUTCMilliseconds(),
  };
}

/** UTC offset in minutes for the zone at `time` (DST-aware, no hardcoded offsets). */
function offsetMinutesAt(time: number, timeZone: string): number {
  const parts = zonedParts(time, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day,
    Math.floor(parts.minutes / 60), parts.minutes % 60, parts.seconds, parts.milliseconds);
  return Math.round((asUtc - time) / 60_000);
}

/**
 * UTC instant of a wall-clock time on a calendar date in `timeZone`.
 * Used for unambiguous day boundaries and normal-day windows. Transition-day
 * working windows are built from actual local minutes below.
 */
function zonedTimeToUtc(year: number, month: number, day: number, minutes: number, timeZone: string): number {
  const naive = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  let guess = naive - offsetMinutesAt(naive, timeZone) * 60_000;
  guess = naive - offsetMinutesAt(guess, timeZone) * 60_000;
  return guess;
}

type WorkingInterval = readonly [number, number];
const shiftCache = new Map<string, WorkingInterval[]>();
const SHIFT_CACHE_LIMIT = 8192;

/** Cache bounded local-date windows; transition dates can contain two disjoint windows. */
function shiftIntervals(year: number, month: number, day: number, startMinutes: number, endMinutes: number, timeZone: string): WorkingInterval[] {
  const key = `${timeZone}:${year}-${month}-${day}:${startMinutes}-${endMinutes}`;
  const cached = shiftCache.get(key);
  if (cached) return cached;
  const date = new Date(Date.UTC(year, month - 1, day + 1));
  const dayStart = zonedTimeToUtc(year, month, day, 0, timeZone);
  const dayEnd = zonedTimeToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), 0, timeZone);
  const intervals: WorkingInterval[] = [];
  if (dayEnd - dayStart === 86_400_000) {
    intervals.push([zonedTimeToUtc(year, month, day, startMinutes, timeZone), zonedTimeToUtc(year, month, day, endMinutes, timeZone)]);
  } else {
    // On DST transition dates inspect actual local minutes: count both occurrences
    // of an included repeated minute, and never count nonexistent spring minutes.
    let windowStart: number | null = null;
    for (let time = dayStart; time < dayEnd; time += 60_000) {
      const localMinutes = zonedParts(time, timeZone).minutes;
      const included = localMinutes >= startMinutes && localMinutes < endMinutes;
      if (included && windowStart === null) windowStart = time;
      if (!included && windowStart !== null) { intervals.push([windowStart, time]); windowStart = null; }
    }
    if (windowStart !== null) intervals.push([windowStart, dayEnd]);
  }
  if (shiftCache.size >= SHIFT_CACHE_LIMIT) shiftCache.delete(shiftCache.keys().next().value!);
  shiftCache.set(key, intervals);
  return intervals;
}

function isoWeekday(year: number, month: number, day: number): number {
  return ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
}

/** Half-open `[start, end)`: at opening counts as inside, at closing does not. */
export function isWithinWorkingHours(now: Instant, schedule: WorkingHours = DEFAULT_WORKING_HOURS): boolean {
  const time = toTime(now);
  if (time === null) return false;
  const days = daysOfWeek(schedule.days) ?? [...DEFAULT_WORKING_HOURS.days];
  const startMinutes = minutesOfDay(schedule.start);
  const endMinutes = minutesOfDay(schedule.end);
  if (startMinutes === null || endMinutes === null || startMinutes >= endMinutes) return false;
  const parts = zonedParts(time, schedule.timeZone);
  if (!days.includes(isoWeekday(parts.year, parts.month, parts.day))) return false;
  return parts.minutes >= startMinutes && parts.minutes < endMinutes;
}

/**
 * Working milliseconds overlapped by `[start, end)` with the schedule.
 * Day-by-day walk over whole calendar dates (never 24h steps, so DST
 * transitions cannot skew day boundaries); each business day contributes at
 * most one bounded shift overlap. O(days) with a tiny constant — a decade is
 * a few thousand iterations.
 */
export function workingElapsedMilliseconds(start: Instant, end: Instant, schedule: WorkingHours = DEFAULT_WORKING_HOURS): number {
  const startTime = toTime(start);
  const endTime = toTime(end);
  if (startTime === null || endTime === null || endTime <= startTime) return 0;
  const active = new Set(daysOfWeek(schedule.days) ?? [...DEFAULT_WORKING_HOURS.days]);
  const startMinutes = minutesOfDay(schedule.start);
  const endMinutes = minutesOfDay(schedule.end);
  if (startMinutes === null || endMinutes === null || startMinutes >= endMinutes) return 0;
  const timeZone = schedule.timeZone;
  const first = zonedParts(startTime, timeZone);
  const last = zonedParts(endTime, timeZone);
  let total = 0;
  for (let cursor = Date.UTC(first.year, first.month - 1, first.day); cursor <= Date.UTC(last.year, last.month - 1, last.day); cursor += 86_400_000) {
    const date = new Date(cursor);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (!active.has(isoWeekday(year, month, day))) continue;
    for (const [opening, closing] of shiftIntervals(year, month, day, startMinutes, endMinutes, timeZone)) {
      const overlapStart = Math.max(startTime, opening);
      const overlapEnd = Math.min(endTime, closing);
      if (overlapEnd > overlapStart) total += overlapEnd - overlapStart;
    }
  }
  return total;
}

/** Whole elapsed working minutes (floor) from `createdAt` to `end ?? now`. */
export function elapsedWorkingMinutes(start: Instant, end?: Instant | null, schedule: WorkingHours = DEFAULT_WORKING_HOURS, now: Instant = new Date()): number {
  return Math.floor(workingElapsedMilliseconds(start, end ?? now, schedule) / 60_000);
}
