import { nthDeliveryDate } from '@/lib/time';

import type { ManualPair } from '@/lib/manual-upload-match';

/**
 * Where a batch of manually-uploaded posters lands in a client's campaign.
 *
 * **This does not invent a calendar.** A campaign already has one: `startDate`,
 * a set of ISO weekdays it delivers on, a plan duration, and an `endDate` derived
 * from all three. `nthDeliveryDate` is the function that turns a campaign day
 * number into a date under those rules, and it is the only thing here that knows
 * how — a second implementation that walked weekdays itself would drift from the
 * importer and the generator the first time any of them changed, and the symptom
 * would be a poster delivered on a day the client said they do not accept.
 *
 * So this walks campaign day numbers, asks that function for each date, and
 * decides only which pair gets which of the days that are actually free.
 *
 * **A day is open when three things are true.** It has no `ContentCalendar` row
 * already (an occupied day belongs to whatever is on it — a manual upload must
 * never displace a generated poster or a delivered one), its date is not already
 * behind us, and its date is inside the campaign window.
 *
 * The middle one is easy to overlook and is the difference between working and
 * silently not: the dispatch sweep selects rows by *today's* date, so a row
 * written onto a day that has already passed is never selected by any phase, on
 * any sweep, forever. It would sit in the console looking approved and scheduled
 * and never send. `notBefore` is what keeps that from being written at all.
 *
 * **Overflow is fixed behaviour, not a setting.** More pairs than open days
 * schedules as many as fit, lowest label first, and hands the rest back by name.
 * The plan's `endDate` is echoed untouched and `extended` is a literal `false` —
 * both exist so a caller, a test, or a reader can see at a glance that nothing
 * here moves a campaign's boundary. Extending a plan is a commercial decision
 * about a contract; an upload is not the place it gets made.
 *
 * Pure: dates and numbers in, dates and numbers out. No Prisma, no clock of its
 * own — `notBefore` is passed in, so a test can place "today" wherever it needs.
 */

/** The campaign this batch is being scheduled into. */
export interface ManualScheduleWindow {
  /** Campaign start. Day 1 lands here. */
  startDate: Date;
  /**
   * Last deliverable day, as stored on the client. Read, never written — see the
   * note above about overflow.
   */
  endDate: Date;
  /** ISO weekdays the client accepts (1 = Mon … 7 = Sun). Empty means every day. */
  deliveryDays: readonly number[];
  /** The plan's duration, i.e. the highest campaign day number that may exist. */
  totalDays: number;
  /** Campaign day numbers that already carry a `ContentCalendar` row. */
  occupiedDays: readonly number[];
  timeZone: string;
  /**
   * The earliest date still worth scheduling onto, as a local midnight.
   *
   * Normally today's midnight, or tomorrow's when the client's delivery minute
   * has already gone by — a poster placed on today after `cronTime` has passed is
   * picked up by nothing. Omitted, no floor is applied, which is what the
   * fixtures use to test the placement rules on their own.
   */
  notBefore?: Date;
}

/** One pair and the campaign day it was given. */
export interface ScheduledManualPair {
  pair: ManualPair;
  /** `ContentCalendar.dayNumber` — the campaign day, not the `day-N` label. */
  dayNumber: number;
  /** `ContentCalendar.scheduledDate`, from `nthDeliveryDate`. */
  scheduledDate: Date;
}

export interface ManualSchedulePlan {
  /** Placed pairs, in the order they were placed (ascending `day-N` label). */
  scheduled: ScheduledManualPair[];
  /**
   * Pairs there was no open day for, in label order.
   *
   * Matched perfectly well — image and caption both present — and simply left
   * out. The panel lists these by their `day-N` label so the operator knows
   * exactly which files did not land.
   */
  unscheduled: ManualPair[];
  /** The client's `endDate`, echoed unchanged. */
  endDate: Date;
  /** Always `false`. Present so "we did not extend the plan" is assertable. */
  extended: false;
  /** Open days found while placing — for the panel's "3 of 5 fit" line. */
  openDaysFound: number;
}

export function planManualSchedule(
  pairs: readonly ManualPair[],
  window: ManualScheduleWindow,
): ManualSchedulePlan {
  const { startDate, endDate, deliveryDays, totalDays, timeZone, notBefore } = window;
  const occupied = new Set(window.occupiedDays);

  const scheduled: ScheduledManualPair[] = [];
  // Ascending label order is the contract: day-1 takes the soonest open day.
  // The matcher already sorts, and sorting again costs nothing and removes the
  // dependency on it having happened.
  const queue = [...pairs].sort((a, b) => a.day - b.day);

  let cursor = 0;

  for (let dayNumber = 1; dayNumber <= totalDays; dayNumber += 1) {
    // Every pair placed. Stopping here matters on a 365-day plan: each step
    // below is a `nthDeliveryDate` walk, and there is no reason to price out
    // three hundred days nobody is going to use.
    if (cursor >= queue.length) break;

    if (occupied.has(dayNumber)) continue;

    const scheduledDate = nthDeliveryDate(startDate, dayNumber, deliveryDays, timeZone);

    // Past the campaign's last deliverable day. Dates rise monotonically with the
    // day number, so nothing further along can come back inside the window.
    if (scheduledDate.getTime() > endDate.getTime()) break;

    // Behind us. Unlike the check above this one keeps going — the campaign's
    // early days may be in the past while its later ones are not, which is the
    // normal state of any campaign already running.
    if (notBefore && scheduledDate.getTime() < notBefore.getTime()) continue;

    const pair = queue[cursor];
    if (!pair) break;
    cursor += 1;

    scheduled.push({ pair, dayNumber, scheduledDate });
  }

  return {
    scheduled,
    unscheduled: queue.slice(cursor),
    // Echoed, never recomputed. See the note on overflow above.
    endDate,
    extended: false,
    openDaysFound: scheduled.length,
  };
}
