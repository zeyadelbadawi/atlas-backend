/**
 * G1 — calendar arithmetic on Africa/Cairo local dates.
 *
 * Every report in this module buckets by the Cairo calendar: a signup at
 * 23:30 Cairo time on 31 March is a March signup even though it is already
 * April in no time zone that matters here, and the week is the Egyptian
 * work week, Saturday to Friday. Egypt observes daylight saving time again
 * since 2023 (UTC+3 from the last Friday of April to the last Thursday of
 * October; UTC+2 otherwise, and all year in 2015–2022), so local midnight
 * is never computed with a fixed offset: it is found from the time-zone
 * database (`Intl`), including the spring-forward day on which 00:00 does
 * not exist (the day then starts at 01:00).
 *
 * Local dates travel as `YYYY-MM-DD` strings and months as `YYYY-MM`;
 * arithmetic on them is plain calendar arithmetic (UTC, no zone).
 */

export const GROWTH_TIME_ZONE = 'Africa/Cairo';

const DAY_MS = 24 * 60 * 60 * 1000;

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: GROWTH_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function localParts(instant: Date): LocalParts {
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/** Cairo's offset from UTC at `instant`, in milliseconds (+2 h or +3 h). */
export function cairoOffsetMs(instant: Date): number {
  const p = localParts(instant);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The Cairo calendar date of an instant, `YYYY-MM-DD`. */
export function cairoDate(instant: Date): string {
  const p = localParts(instant);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** The Cairo calendar month of an instant, `YYYY-MM`. */
export function cairoMonth(instant: Date): string {
  return cairoDate(instant).slice(0, 7);
}

function parseDate(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number);
  return { y, m, d };
}

/** The first instant of a Cairo calendar day (01:00 on a spring-forward day). */
export function cairoStartOfDay(date: string): Date {
  const { y, m, d } = parseDate(date);
  const wallMidnight = Date.UTC(y, m - 1, d);
  const candidates = [
    wallMidnight - cairoOffsetMs(new Date(wallMidnight - 12 * 60 * 60 * 1000)),
    wallMidnight - cairoOffsetMs(new Date(wallMidnight + 12 * 60 * 60 * 1000)),
  ].filter((t) => cairoDate(new Date(t)) === date);
  return new Date(Math.min(...candidates));
}

/** Calendar arithmetic on a `YYYY-MM-DD` date. */
export function addDays(date: string, days: number): string {
  const { y, m, d } = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const a = parseDate(from);
  const b = parseDate(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS);
}

/** The Saturday that starts the Egyptian work week holding `date`. */
export function weekStartSaturday(date: string): string {
  const { y, m, d } = parseDate(date);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 Sun … 6 Sat
  return addDays(date, -((weekday + 1) % 7));
}

/** Calendar arithmetic on a `YYYY-MM` month. */
export function addMonths(month: string, months: number): string {
  const [y, m] = month.split('-').map(Number);
  const index = y * 12 + (m - 1) + months;
  return `${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1)}`;
}

/** Months from `from` to `to`, both included (0 or less when `to` is earlier). */
export function monthCount(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return ty * 12 + tm - (fy * 12 + fm) + 1;
}

/** Every month from `from` to `to`, oldest first. */
export function monthRange(from: string, to: string): string[] {
  const count = monthCount(from, to);
  return Array.from({ length: Math.max(0, count) }, (_, i) => addMonths(from, i));
}

/** The first instant of a Cairo calendar month. */
export function cairoStartOfMonth(month: string): Date {
  return cairoStartOfDay(`${month}-01`);
}

/** `YYYY-MM` → the `date` column value for its first day (UTC midnight). */
export function monthToDateColumn(month: string): Date {
  return new Date(`${month}-01T00:00:00.000Z`);
}

/** A `date` column value → `YYYY-MM-DD`. */
export function dateColumnToString(value: Date): string {
  return value.toISOString().slice(0, 10);
}
