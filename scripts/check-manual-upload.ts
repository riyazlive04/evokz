/**
 * Fixture suite for the manual template upload — sheet parsing, filename
 * matching, and delivery-day scheduling.
 *
 * All three are pure functions by construction, which is the whole reason this
 * file can exist: no network, no database, no Drive. The matcher takes filenames
 * and rows; the scheduler takes a campaign window and a set of occupied days.
 * Everything that talks to Postgres or Google lives in `manual-upload.ts` and is
 * not exercised here.
 *
 * The two rules worth pinning hardest are the ones a future change would most
 * plausibly "improve" into something wrong:
 *
 *   - an unmatched image or row is never scheduled, in either direction; and
 *   - an overflow schedules what fits and lists the rest, rather than extending
 *     the campaign or asking.
 *
 * Run: npm run check:manual
 */
import {
  matchManualUploads,
  parseManualSheet,
  readDayFromFileName,
  type ManualSheetRow,
} from '@/lib/manual-upload-match';
import { planManualSchedule } from '@/lib/manual-upload-schedule';
import { describeCronTime } from '@/lib/time';

let bad = 0;
const t = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) bad += 1;
};

const HEAD = 'day,caption,hashtags';
/*
 * Comma-free on purpose. These strings are pasted straight into CSV fixtures
 * below, so a comma inside one would split the cell and the failure would look
 * like a parser bug rather than a fixture bug. Quoting is covered by its own
 * case instead.
 */
const CAP = (n: number) => `Caption for day ${n} written by the operator.`;

// ===========================================================================
console.log('\n--- sheet parsing -------------------------------------------');
// ===========================================================================

{
  const p = parseManualSheet(`${HEAD}\n1,${CAP(1)},#one #two\n2,${CAP(2)},`);
  t('a clean two-row sheet parses', p.error === null && p.rows.length === 2, p.error ?? '');
  t('hashtags are normalised', p.rows[0]?.hashtags === '#one #two', p.rows[0]?.hashtags);
  t('a blank hashtags cell is allowed', p.rows[1]?.hashtags === '', JSON.stringify(p.rows[1]));
  t('delimiter is reported', p.delimiter === 'comma', String(p.delimiter));
}

{
  const p = parseManualSheet(`day\tcaption\thashtags\n1\t${CAP(1)}\t#a`);
  t('a TSV is sniffed', p.delimiter === 'tab' && p.rows.length === 1, p.error ?? '');
}

{
  const p = parseManualSheet(`${HEAD}\n1,"A caption, with a comma and ""quotes"" in it",#a`);
  t(
    'a quoted caption keeps its comma and quotes',
    p.rows[0]?.caption === 'A caption, with a comma and "quotes" in it',
    p.rows[0]?.caption,
  );
}

{
  const p = parseManualSheet('day,caption\nday-7,A caption written for day seven.');
  t('the day cell accepts the filename form', p.rows[0]?.day === 7, JSON.stringify(p.rows[0]));
  t('hashtags may be absent entirely', p.rows[0]?.hashtags === '', JSON.stringify(p.rows[0]));
}

{
  const p = parseManualSheet('day,hashtags\n1,#a');
  t('a sheet with no caption column is fatal', (p.error ?? '').includes('caption'), p.error ?? '');
}

{
  const p = parseManualSheet(`${HEAD}\n1,,#a`);
  t(
    'a blank caption is refused, not defaulted',
    p.rows.length === 0 && p.problems[0]?.issue.includes('Caption is required') === true,
    JSON.stringify(p.problems),
  );
}

{
  const p = parseManualSheet(`${HEAD}\n,${CAP(1)},#a\nbanana,${CAP(2)},#b\n0,${CAP(3)},#c`);
  t(
    'blank / non-numeric / zero day values are all refused',
    p.rows.length === 0 && p.problems.length === 3,
    JSON.stringify(p.problems.map((problem) => problem.issue)),
  );
  t(
    'a blank day says which column is empty',
    p.problems[0]?.issue.includes('day column is blank') === true,
    p.problems[0]?.issue,
  );
  t(
    'a junk day quotes the cell back',
    p.problems[1]?.issue.includes('"banana"') === true,
    p.problems[1]?.issue,
  );
}

{
  const p = parseManualSheet(`${HEAD}\n4,${CAP(4)},#a\n4,A different caption for day four.,#b`);
  t(
    'a repeated day keeps the first row and refuses the second',
    p.rows.length === 1 && p.rows[0]?.caption === CAP(4) && p.problems.length === 1,
    JSON.stringify(p.problems.map((problem) => problem.issue)),
  );
  t(
    'and the refusal names the line the first was on',
    p.problems[0]?.issue.includes('line 2') === true,
    p.problems[0]?.issue,
  );
}

{
  const p = parseManualSheet(`day,caption,hashtags,image prompt\n1,${CAP(1)},#a,ignored`);
  t(
    'an unknown column is carried as ignored rather than failing',
    p.rows.length === 1 && p.ignoredColumns.includes('image prompt'),
    JSON.stringify(p.ignoredColumns),
  );
}

{
  t('blank input is the resting state, not an error', parseManualSheet('  ').error === null);
  t(
    'a sheet with a header and nothing else says so',
    (parseManualSheet(`${HEAD}\n`).error ?? '').includes('no content rows'),
  );
  t(
    'a file with no recognisable header is fatal',
    (parseManualSheet('alpha,beta\n1,2').error ?? '').includes('No header row recognised'),
  );
}

// ===========================================================================
console.log('\n--- filenames -----------------------------------------------');
// ===========================================================================

{
  const cases: Array<[string, number | null]> = [
    ['day-1.png', 1],
    ['day-12.jpg', 12],
    ['Day-3.PNG', 3],
    ['DAY_4.webp', 4],
    ['day 5.jpeg', 5],
    ['day6.png', 6],
    ['day-01.png', 1],
    ['day-1', 1],
    ['day-1 (1).png', null],
    ['final_v2.png', null],
    ['1.png', null],
    ['monday-1.png', null],
    ['day-.png', null],
    ['day-0.png', null],
  ];
  for (const [name, expected] of cases) {
    const actual = readDayFromFileName(name);
    t(`filename "${name}" reads as ${expected ?? 'unreadable'}`, actual === expected, String(actual));
  }
}

// ===========================================================================
console.log('\n--- matching ------------------------------------------------');
// ===========================================================================

const rowsFor = (...days: number[]): ManualSheetRow[] =>
  days.map((day) => ({ day, caption: CAP(day), hashtags: `#day${day}` }));

// Scenario 1 — clean full match.
{
  const m = matchManualUploads(['day-1.png', 'day-2.png', 'day-3.png'], rowsFor(1, 2, 3));
  t(
    'clean match: 3 pairs, nothing unmatched',
    m.pairs.length === 3 && m.unmatchedImages.length === 0 && m.unmatchedRows.length === 0,
    JSON.stringify(m),
  );
  t(
    'and the caption travels with the image',
    m.pairs[1]?.fileName === 'day-2.png' && m.pairs[1]?.caption === CAP(2),
    JSON.stringify(m.pairs[1]),
  );
}

// Scenario 2 — an image with no sheet row.
{
  const m = matchManualUploads(['day-1.png', 'day-2.png', 'day-9.png'], rowsFor(1, 2));
  t(
    'an image with no row is flagged and not scheduled',
    m.pairs.length === 2 && m.unmatchedImages.length === 1,
    JSON.stringify(m.unmatchedImages),
  );
  t(
    'and the reason names the missing row',
    m.unmatchedImages[0]?.fileName === 'day-9.png' &&
      m.unmatchedImages[0].reason.includes('no row for day 9'),
    m.unmatchedImages[0]?.reason,
  );
}

// Scenario 3 — a sheet row with no image.
{
  const m = matchManualUploads(['day-1.png'], rowsFor(1, 5));
  t(
    'a row with no image is flagged and not scheduled',
    m.pairs.length === 1 && m.unmatchedRows.length === 1 && m.unmatchedRows[0]?.day === 5,
    JSON.stringify(m.unmatchedRows),
  );
  t(
    'and the reason names the file it wanted',
    m.unmatchedRows[0]?.reason.includes('day-5') === true,
    m.unmatchedRows[0]?.reason,
  );
}

// Scenario 4 — malformed input, both directions at once.
{
  const m = matchManualUploads(
    ['day-1.png', 'poster-final.png', 'day-2.png', 'day-2.jpg'],
    rowsFor(1, 2, 3),
  );
  t(
    'an unreadable filename is flagged',
    m.unmatchedImages.some(
      (image) => image.fileName === 'poster-final.png' && image.day === null,
    ),
    JSON.stringify(m.unmatchedImages),
  );
  t(
    'a duplicate day keeps the first file and names it in the second’s reason',
    m.pairs.some((pair) => pair.day === 2 && pair.fileName === 'day-2.png') &&
      m.unmatchedImages.some(
        (image) => image.fileName === 'day-2.jpg' && image.reason.includes('day-2.png'),
      ),
    JSON.stringify(m.unmatchedImages),
  );
  t('day 3’s row is reported unmatched', m.unmatchedRows[0]?.day === 3, JSON.stringify(m.unmatchedRows));
  t(
    'every input lands in exactly one list',
    m.pairs.length + m.unmatchedImages.length === 4 && m.unmatchedRows.length === 1,
    `${m.pairs.length} + ${m.unmatchedImages.length} images, ${m.unmatchedRows.length} rows`,
  );
}

// Scenario 5 — order is by day label, not upload order.
{
  const m = matchManualUploads(['day-10.png', 'day-2.png', 'day-1.png'], rowsFor(1, 2, 10));
  t(
    'pairs come back in ascending day order whatever order they arrived',
    m.pairs.map((pair) => pair.day).join(',') === '1,2,10',
    m.pairs.map((pair) => pair.day).join(','),
  );
}

// Scenario 6 — nothing at all.
{
  const m = matchManualUploads([], []);
  t('empty in, empty out', m.pairs.length === 0 && m.unmatchedImages.length === 0);
}

// ===========================================================================
console.log('\n--- scheduling ----------------------------------------------');
// ===========================================================================

const TZ = 'Asia/Kolkata';
/** 2026-09-01 is a Tuesday, which the weekday cases below rely on. */
const START = new Date('2026-09-01T00:00:00+05:30');
const END = new Date('2026-09-30T00:00:00+05:30');

const pairsFor = (...days: number[]) =>
  days.map((day) => ({ day, fileName: `day-${day}.png`, caption: CAP(day), hashtags: '' }));

const baseWindow = {
  startDate: START,
  endDate: END,
  deliveryDays: [] as number[],
  totalDays: 10,
  timeZone: TZ,
};

const iso = (date: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(date);

// Scenario 1 — exact fit.
{
  const plan = planManualSchedule(pairsFor(1, 2, 3), { ...baseWindow, totalDays: 3, occupiedDays: [] });
  t(
    'exact fit: every pair is placed',
    plan.scheduled.length === 3 && plan.unscheduled.length === 0,
    JSON.stringify(plan.unscheduled),
  );
  t(
    'day-1 takes the soonest open day, in order',
    plan.scheduled.map((entry) => entry.dayNumber).join(',') === '1,2,3',
    plan.scheduled.map((entry) => entry.dayNumber).join(','),
  );
  t(
    'and day 1 lands on the campaign start date',
    iso(plan.scheduled[0]!.scheduledDate) === '2026-09-01',
    iso(plan.scheduled[0]!.scheduledDate),
  );
  t(
    'the label is carried alongside the campaign day it was given',
    plan.scheduled[2]?.pair.day === 3 && plan.scheduled[2]?.dayNumber === 3,
    JSON.stringify(plan.scheduled[2]),
  );
}

// Scenario 2 — overflow: schedule what fits, list the rest, never extend.
{
  const plan = planManualSchedule(pairsFor(1, 2, 3, 4, 5), {
    ...baseWindow,
    totalDays: 3,
    occupiedDays: [],
  });
  t(
    'overflow: only what fits is scheduled',
    plan.scheduled.length === 3 && plan.unscheduled.length === 2,
    `${plan.scheduled.length} scheduled, ${plan.unscheduled.length} left`,
  );
  t(
    'and the overflow is listed by its day-N label',
    plan.unscheduled.map((pair) => pair.day).join(',') === '4,5',
    plan.unscheduled.map((pair) => pair.day).join(','),
  );
  t(
    'the plan end date is never moved',
    plan.endDate.getTime() === END.getTime() && plan.extended === false,
    String(plan.extended),
  );
  t(
    'the lowest labels win the open days, not the last ones',
    plan.scheduled.map((entry) => entry.pair.day).join(',') === '1,2,3',
    plan.scheduled.map((entry) => entry.pair.day).join(','),
  );
}

// Scenario 3 — some days already occupied by existing rows.
{
  const plan = planManualSchedule(pairsFor(1, 2, 3), {
    ...baseWindow,
    totalDays: 6,
    occupiedDays: [1, 2, 5],
  });
  t(
    'occupied days are skipped',
    plan.scheduled.map((entry) => entry.dayNumber).join(',') === '3,4,6',
    plan.scheduled.map((entry) => entry.dayNumber).join(','),
  );
  t(
    'and the dates follow the campaign days they were given',
    iso(plan.scheduled[0]!.scheduledDate) === '2026-09-03' &&
      iso(plan.scheduled[2]!.scheduledDate) === '2026-09-06',
    plan.scheduled.map((entry) => iso(entry.scheduledDate)).join(','),
  );
}

// Scenario 4 — zero open days.
{
  const plan = planManualSchedule(pairsFor(1, 2), {
    ...baseWindow,
    totalDays: 2,
    occupiedDays: [1, 2],
  });
  t(
    'a full campaign schedules nothing and lists everything',
    plan.scheduled.length === 0 && plan.unscheduled.length === 2,
    JSON.stringify(plan.unscheduled.map((pair) => pair.day)),
  );
  t('and still does not extend the plan', plan.extended === false);
}

// Scenario 5 — weekday-restricted delivery reuses nthDeliveryDate.
{
  // Mon/Wed/Fri from Tuesday 2026-09-01: day 1 = Wed 2nd, day 2 = Fri 4th,
  // day 3 = Mon 7th. Proves the walk is the campaign's, not a naive +1 day.
  const plan = planManualSchedule(pairsFor(1, 2, 3), {
    ...baseWindow,
    deliveryDays: [1, 3, 5],
    totalDays: 3,
    occupiedDays: [],
  });
  t(
    'a Mon/Wed/Fri client gets Mon/Wed/Fri dates',
    plan.scheduled.map((entry) => iso(entry.scheduledDate)).join(',') ===
      '2026-09-02,2026-09-04,2026-09-07',
    plan.scheduled.map((entry) => iso(entry.scheduledDate)).join(','),
  );
}

// Scenario 6 — a campaign whose end date arrives before its day count does.
{
  const plan = planManualSchedule(pairsFor(1, 2, 3), {
    ...baseWindow,
    // Three campaign days are free, but the window closes after the 2nd.
    endDate: new Date('2026-09-02T00:00:00+05:30'),
    totalDays: 3,
    occupiedDays: [],
  });
  t(
    'a day past the campaign end is not scheduled',
    plan.scheduled.length === 2 && plan.unscheduled.length === 1,
    `${plan.scheduled.length} scheduled, ${plan.unscheduled.length} left`,
  );
  t(
    'and the one left out is the last label, not the first',
    plan.unscheduled[0]?.day === 3,
    JSON.stringify(plan.unscheduled.map((pair) => pair.day)),
  );
}

// Scenario 7 — nothing to place.
{
  const plan = planManualSchedule([], { ...baseWindow, occupiedDays: [] });
  t('no pairs schedules nothing and reports nothing left', plan.scheduled.length === 0 && plan.unscheduled.length === 0);
}


// ===========================================================================
console.log('\n--- delivery-time wording ------------------------------------');
// ===========================================================================

{
  const cases: Array<[string, string]> = [
    ['12:00', '12:00 noon'],
    ['00:00', '12:00 midnight'],
    ['09:00', '9:00 AM'],
    ['11:43', '11:43 AM'],
    ['13:30', '1:30 PM'],
    ['23:59', '11:59 PM'],
    ['12:30', '12:30 PM'],
    ['00:30', '12:30 AM'],
  ];
  for (const [value, expected] of cases) {
    t(`"${value}" reads as "${expected}"`, describeCronTime(value) === expected, describeCronTime(value));
  }
  t('a malformed value is passed through rather than guessed at',
    describeCronTime('nonsense') === 'nonsense');
}

console.log(
  bad === 0 ? '\nall manual-upload checks passed' : `\n${bad} manual-upload check(s) FAILED`,
);
process.exit(bad === 0 ? 0 : 1);
