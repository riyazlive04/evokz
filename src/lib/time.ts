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

// ---------------------------------------------------------------------------
// Weekday-restricted scheduling
// ---------------------------------------------------------------------------

/** Every weekday, in ISO order. `1` is Monday, `7` is Sunday. */
export const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export const WEEKDAY_LABELS: Record<number, string> = {
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
  7: 'Sun',
};

/**
 * ISO-8601 weekday of an instant, resolved in `timeZone` — 1 = Monday … 7 =
 * Sunday.
 *
 * Goes through `Intl` rather than `Date.getDay()` so it reports the weekday in
 * the app's zone rather than the container's UTC clock. Near midnight those are
 * different days, which is exactly when a delivery would be misfiled.
 */
export function zonedWeekday(date: Date, timeZone: string): number {
  const { year, month, day } = getZonedParts(date, timeZone);
  // getUTCDay on a UTC-constructed date reads back the same calendar day, so
  // this is the weekday of the *local* date rather than of the instant.
  const isoLike = new Date(Date.UTC(year, month - 1, day));
  const sundayFirst = isoLike.getUTCDay(); // 0 = Sunday
  return sundayFirst === 0 ? 7 : sundayFirst;
}

/** Normalises a stored `deliveryDays` array: valid, deduplicated, sorted. */
export function normalizeDeliveryDays(days: readonly number[]): number[] {
  return [...new Set(days.filter((day) => Number.isInteger(day) && day >= 1 && day <= 7))].sort(
    (a, b) => a - b,
  );
}

/** True when `days` imposes no restriction — empty, or all seven. */
export function isEveryDay(days: readonly number[]): boolean {
  return normalizeDeliveryDays(days).length === 0 || normalizeDeliveryDays(days).length === 7;
}

/**
 * Local midnight of the `n`-th deliverable day of a campaign. `n` is 1-based,
 * so `n = 1` is the first delivery.
 *
 * With no restriction this is exactly `addZonedDays(startDate, n - 1)`. With a
 * restriction it walks forward from the start date counting only allowed
 * weekdays, so a 30-day plan still yields 30 deliveries — the campaign simply
 * spans more calendar days than its plan duration.
 *
 * The walk uses `addZonedDays`, never `addDays`: adding exact 24h multiples
 * drifts by the UTC-offset change across a DST transition, which is enough to
 * push a row into the neighbouring local day, and the dispatcher matches on
 * local days.
 */
export function nthDeliveryDate(
  startDate: Date,
  n: number,
  deliveryDays: readonly number[],
  timeZone: string,
): Date {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`nthDeliveryDate needs a 1-based day number, received ${n}`);
  }

  const allowed = normalizeDeliveryDays(deliveryDays);

  // Unrestricted (and all-seven, which is the same thing) keeps the original
  // arithmetic — no walking, and byte-identical dates for existing clients.
  if (allowed.length === 0 || allowed.length === 7) {
    return addZonedDays(startDate, n - 1, timeZone);
  }

  // At least one day a week is allowed, so the n-th delivery is at most 7n days
  // out. The cap turns a logic error into a loud failure rather than a hang.
  const maxOffset = n * 7 + 7;
  let found = 0;

  for (let offset = 0; offset <= maxOffset; offset += 1) {
    const candidate = addZonedDays(startDate, offset, timeZone);
    if (!allowed.includes(zonedWeekday(candidate, timeZone))) continue;

    found += 1;
    if (found === n) return candidate;
  }

  throw new Error(
    `Could not place delivery ${n} within ${maxOffset} days of the campaign start ` +
      `for weekdays [${allowed.join(', ')}]`,
  );
}

/** "Every day", "Mon–Fri", "Weekends", or an explicit list. */
export function describeDeliveryDays(days: readonly number[]): string {
  const allowed = normalizeDeliveryDays(days);
  if (allowed.length === 0 || allowed.length === 7) return 'Every day';
  if (allowed.join() === '1,2,3,4,5') return 'Mon–Fri';
  if (allowed.join() === '6,7') return 'Weekends';
  return allowed.map((day) => WEEKDAY_LABELS[day]).join(', ');
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
