import { optionalEnv } from '@/lib/env';

/**
 * Timezone-correct helpers for the dispatch engine.
 *
 * `Client.cronTime` is wall-clock intent ("deliver at 09:00"), but a serverless
 * container runs in UTC. Every conversion therefore goes through an explicit
 * IANA zone (`APP_TIMEZONE`) rather than the host's locale.
 */

export const HH_MM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function getAppTimeZone(): string {
  return optionalEnv('APP_TIMEZONE', 'Asia/Kolkata');
}

/** True when `value` is a valid 24-hour "HH:MM" string. */
export function isValidCronTime(value: string): boolean {
  return HH_MM_PATTERN.test(value);
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** Decomposes an instant into wall-clock fields inside `timeZone`. */
export function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = getFormatter(timeZone).formatToParts(date);
  const lookup = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    if (!found) throw new Error(`Unable to resolve "${type}" for zone ${timeZone}`);
    return Number.parseInt(found.value, 10);
  };

  return {
    year: lookup('year'),
    month: lookup('month'),
    day: lookup('day'),
    hour: lookup('hour'),
    minute: lookup('minute'),
    second: lookup('second'),
  };
}

/** Current wall-clock time in `timeZone`, formatted as "HH:MM". */
export function toTimeString(date: Date, timeZone: string): string {
  const { hour, minute } = getZonedParts(date, timeZone);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * The trailing minute window ending at `date`, as "HH:MM" strings — newest
 * first. A platform cron firing every 5 minutes only ever observes 1 minute in
 * 5, so matching a single exact minute would silently drop ~80% of clients.
 * `windowMinutes = 1` collapses this to strict exact-minute matching.
 */
export function buildMinuteWindow(
  date: Date,
  timeZone: string,
  windowMinutes: number,
): string[] {
  const span = Math.max(1, Math.min(windowMinutes, 60));
  const window: string[] = [];

  for (let offset = 0; offset < span; offset += 1) {
    const shifted = new Date(date.getTime() - offset * 60_000);
    window.push(toTimeString(shifted, timeZone));
  }

  // Distinct values only — a DST fold could repeat a minute.
  return Array.from(new Set(window));
}

/** Offset of `timeZone` from UTC at `date`, in milliseconds. */
function getZoneOffsetMs(date: Date, timeZone: string): number {
  const { year, month, day, hour, minute, second } = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second, date.getUTCMilliseconds());
  return asUtc - date.getTime();
}

/**
 * The UTC instant of local midnight for the calendar day containing `date`.
 * Resolved twice so that a day boundary landing on a DST transition still
 * settles on the correct offset.
 */
export function startOfZonedDay(date: Date, timeZone: string): Date {
  const { year, month, day } = getZonedParts(date, timeZone);
  const naiveUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const firstPass = new Date(naiveUtc - getZoneOffsetMs(date, timeZone));
  return new Date(naiveUtc - getZoneOffsetMs(firstPass, timeZone));
}

/** Half-open range `[start, end)` covering the local calendar day of `date`. */
export function zonedDayRange(
  date: Date,
  timeZone: string,
): { start: Date; end: Date } {
  const start = startOfZonedDay(date, timeZone);
  // Step 36h then re-truncate so DST-shortened/lengthened days stay correct.
  const end = startOfZonedDay(new Date(start.getTime() + 36 * 3_600_000), timeZone);
  return { start, end };
}

/** Adds whole days to an instant. Exact 24h multiples — not DST-aware. */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/**
 * Local midnight of the calendar day `days` after the one containing `date`.
 *
 * Use this — not `addDays` — for anything the dispatcher later matches against
 * a day window. Adding exact 24h multiples drifts by the UTC-offset change
 * across a DST transition, which is enough to push a row into the neighbouring
 * local day: a campaign starting in EDT would schedule its post-November days
 * at 23:00 the previous day, and the sweep would deliver them a day early.
 *
 * The 12-hour cushion absorbs any real-world offset shift before re-truncating.
 */
export function addZonedDays(date: Date, days: number, timeZone: string): Date {
  const base = startOfZonedDay(date, timeZone);
  const shifted = new Date(base.getTime() + days * 86_400_000 + 43_200_000);
  return startOfZonedDay(shifted, timeZone);
}

/** Formats an instant as "DD MMM YYYY" in `timeZone` for admin surfaces. */
export function formatDisplayDate(date: Date, timeZone = getAppTimeZone()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/** Formats an instant as "DD MMM, HH:MM" in `timeZone`. */
export function formatDisplayDateTime(date: Date, timeZone = getAppTimeZone()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}
