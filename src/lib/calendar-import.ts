import { DeliveryStatus, Prisma } from '@prisma/client';

import {
  calendarImportSchema,
  normalizeHashtags,
  type CalendarImportInput,
  type ConflictMode,
} from '@/lib/calendar-parse';
import { prisma } from '@/lib/prisma';
import { addZonedDays, getAppTimeZone } from '@/lib/time';

/**
 * Bulk `ContentCalendar` writer — the operator-authored counterpart to
 * `generateContentCalendar`.
 *
 * Same destination, same row shape, no LLM and no spend: the Evokz team writes
 * theme / caption / hashtags / image prompt in a spreadsheet and imports it. The
 * creative pipeline downstream cannot tell the two sources apart, which is the
 * point — a hand-written calendar day delivers exactly like a generated one.
 */

/** Rows an overwrite may replace. Anything further along owns a Drive asset. */
const REWRITABLE: DeliveryStatus[] = [DeliveryStatus.PENDING, DeliveryStatus.FAILED];

/**
 * Updates per transaction. A 365-row import would otherwise hold one
 * interactive transaction open across the entire write, which is exactly the
 * shape that exhausts a serverless connection pool.
 *
 * The tradeoff is that a mid-import fault leaves earlier chunks committed. That
 * is recoverable rather than corrupting: re-importing the same sheet is a no-op
 * in `skip` mode and rewrites identical copy in `overwrite` mode.
 */
const UPDATE_CHUNK = 25;

export interface CalendarImportResult {
  clientId: string;
  companyName: string;
  totalDays: number;
  /** New rows written. */
  created: number;
  /** Existing rows replaced (`overwrite` mode only). */
  updated: number;
  /**
   * Written rows that carried a hand-authored poster text layer. The remainder
   * get theirs from `ensurePosterCopy` on first render.
   */
  postersAuthored: number;
  /** Rows whose day already existed and `skip` mode left alone. */
  skippedExisting: number;
  /** Rows refused because the existing day is already GENERATED or DELIVERED. */
  blockedDelivered: number;
  /** Rows refused because their day number is past the plan duration. */
  outOfRange: number;
  /**
   * Rows that asked for automatic placement when no campaign day was left.
   * Counted apart from `outOfRange`: the fix is "the calendar is already full",
   * not "renumber your sheet".
   */
  noFreeDay: number;
  /** Rows refused because an earlier row in the same file claimed that day. */
  duplicateDay: number;
  /** Day-number span actually written, for the confirmation line. */
  firstDay: number | null;
  lastDay: number | null;
  /** Campaign days still unwritten after this import. */
  remaining: number;
}

export async function applyCalendarImport(
  clientId: string,
  input: CalendarImportInput,
): Promise<CalendarImportResult> {
  const { mode, rows } = calendarImportSchema.parse(input);

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      companyName: true,
      startDate: true,
      plan: { select: { name: true, durationDays: true } },
    },
  });
  if (!client) throw new Error(`Client ${clientId} does not exist`);

  const totalDays = client.plan.durationDays;
  if (totalDays < 1) {
    throw new Error(`Plan "${client.plan.name}" has an invalid durationDays`);
  }

  const existing = await prisma.contentCalendar.findMany({
    where: { clientId },
    select: { id: true, dayNumber: true, deliveryStatus: true },
  });
  const byDay = new Map(existing.map((row) => [row.dayNumber, row]));

  const plan = planWrites(rows, mode, {
    clientId,
    totalDays,
    startDate: client.startDate,
    byDay,
  });

  const created =
    plan.toCreate.length > 0
      ? // skipDuplicates leans on @@unique([clientId, dayNumber]): a generator run
        // racing this import cannot turn into a constraint failure.
        (
          await prisma.contentCalendar.createMany({
            data: plan.toCreate,
            skipDuplicates: true,
          })
        ).count
      : 0;

  let updated = 0;
  for (let offset = 0; offset < plan.toUpdate.length; offset += UPDATE_CHUNK) {
    const chunk = plan.toUpdate.slice(offset, offset + UPDATE_CHUNK);
    await prisma.$transaction(
      chunk.map((row) =>
        prisma.contentCalendar.update({ where: { id: row.id }, data: row.data }),
      ),
    );
    updated += chunk.length;
  }

  // Recounted rather than derived: `skipDuplicates` may have dropped a row that
  // a concurrent seed had just written, and coverage must reflect the table.
  const seeded = await prisma.contentCalendar.count({ where: { clientId } });

  return {
    clientId,
    companyName: client.companyName,
    totalDays,
    created,
    updated,
    postersAuthored: plan.postersAuthored,
    skippedExisting: plan.skippedExisting,
    blockedDelivered: plan.blockedDelivered,
    outOfRange: plan.outOfRange,
    noFreeDay: plan.noFreeDay,
    duplicateDay: plan.duplicateDay,
    firstDay: plan.writtenDays.length > 0 ? Math.min(...plan.writtenDays) : null,
    lastDay: plan.writtenDays.length > 0 ? Math.max(...plan.writtenDays) : null,
    remaining: Math.max(0, totalDays - seeded),
  };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

interface RowCopy {
  theme: string;
  caption: string;
  hashtags: string;
  imagePrompt: string;
  scheduledDate: Date;
}

interface WritePlan {
  toCreate: Array<Prisma.ContentCalendarCreateManyInput>;
  toUpdate: Array<{ id: string; data: Prisma.ContentCalendarUpdateInput }>;
  writtenDays: number[];
  /** Rows that supplied a hand-authored poster block rather than deferring it. */
  postersAuthored: number;
  skippedExisting: number;
  blockedDelivered: number;
  outOfRange: number;
  noFreeDay: number;
  duplicateDay: number;
}

/**
 * Resolves every row to a concrete day number and a create/update/refuse
 * decision. Pure — the whole plan is settled before the first write, so a row
 * that cannot land is counted rather than discovered halfway through.
 */
function planWrites(
  rows: ReturnType<typeof calendarImportSchema.parse>['rows'],
  mode: ConflictMode,
  context: {
    clientId: string;
    totalDays: number;
    startDate: Date;
    byDay: Map<number, { id: string; deliveryStatus: DeliveryStatus }>;
  },
): WritePlan {
  const { totalDays, startDate, byDay } = context;
  const timeZone = getAppTimeZone();

  const plan: WritePlan = {
    toCreate: [],
    toUpdate: [],
    writtenDays: [],
    postersAuthored: 0,
    skippedExisting: 0,
    blockedDelivered: 0,
    outOfRange: 0,
    noFreeDay: 0,
    duplicateDay: 0,
  };

  // Every explicit day number is claimed up front so auto-assignment can never
  // steal a slot a later row in the same file asked for by name.
  const claimed = new Set<number>();
  for (const row of rows) {
    if (row.dayNumber !== null) claimed.add(row.dayNumber);
  }

  // Auto-assignment walks upward once across the campaign; each free day is
  // therefore handed out at most once, in file order.
  let cursor = 1;
  const nextFreeDay = (): number | null => {
    while (cursor <= totalDays && (byDay.has(cursor) || claimed.has(cursor))) {
      cursor += 1;
    }
    return cursor <= totalDays ? cursor : null;
  };

  const handled = new Set<number>();

  for (const row of rows) {
    let dayNumber: number;

    if (row.dayNumber === null) {
      const assigned = nextFreeDay();
      if (assigned === null) {
        // Nothing left to append onto — the campaign is fully seeded.
        plan.noFreeDay += 1;
        continue;
      }
      claimed.add(assigned);
      dayNumber = assigned;
    } else {
      if (row.dayNumber > totalDays) {
        plan.outOfRange += 1;
        continue;
      }
      dayNumber = row.dayNumber;
    }

    if (handled.has(dayNumber)) {
      plan.duplicateDay += 1;
      continue;
    }
    handled.add(dayNumber);

    const copy: RowCopy = {
      theme: row.theme,
      caption: row.caption,
      hashtags: normalizeHashtags(row.hashtags),
      imagePrompt: row.imagePrompt,
      // Day 1 lands on the campaign start date. Calendar-day arithmetic, so a
      // DST transition mid-campaign cannot shift a row into the adjacent day.
      scheduledDate: addZonedDays(startDate, dayNumber - 1, timeZone),
    };

    const current = byDay.get(dayNumber);

    if (!current) {
      if (row.poster) plan.postersAuthored += 1;
      plan.toCreate.push({
        clientId: context.clientId,
        dayNumber,
        ...copy,
        // `undefined` omits the column, leaving it null — the signal
        // `ensurePosterCopy` reads to write the text layer at render time.
        posterCopy: row.poster ?? undefined,
        posterArchetype: row.archetype ?? undefined,
      });
      plan.writtenDays.push(dayNumber);
      continue;
    }

    if (mode === 'skip') {
      plan.skippedExisting += 1;
      continue;
    }

    if (!REWRITABLE.includes(current.deliveryStatus)) {
      plan.blockedDelivered += 1;
      continue;
    }

    if (row.poster) plan.postersAuthored += 1;

    plan.toUpdate.push({
      id: current.id,
      data: {
        ...copy,
        deliveryStatus: DeliveryStatus.PENDING,
        errorMessage: null,
        // Supplied copy wins; otherwise the column is cleared rather than left
        // alone, because poster copy is *derived from the caption being
        // replaced* — keeping it would typeset the old headline over the new
        // photo brief.
        posterCopy: row.poster ?? Prisma.DbNull,
        // Deliberately asymmetric with posterCopy above: the archetype is a
        // layout pin, not derived content, so a sheet with no opinion on it must
        // not silently discard one an operator set earlier.
        ...(row.archetype === null ? {} : { posterArchetype: row.archetype }),
        // A FAILED row can already hold an asset rendered from the *old* image
        // prompt (upload succeeded, broadcast did not). Keeping the reference
        // would let a later re-send deliver the previous creative under the new
        // caption. The orphaned Drive file is left in place, matching what
        // `deleteCalendarEntry` already does.
        gDriveFileId: null,
        gDriveViewUrl: null,
      },
    });
    plan.writtenDays.push(dayNumber);
  }

  return plan;
}
