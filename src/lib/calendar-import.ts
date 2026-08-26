import { DeliveryStatus, Prisma } from '@prisma/client';

import {
  buildTemplateIndex,
  calendarImportSchema,
  normalizeHashtags,
  resolveTemplateName,
  type CalendarImportInput,
  type ConflictMode,
} from '@/lib/calendar-parse';
import { checkRowFit, type FitWarning } from '@/lib/calendar-fit';
import { prisma } from '@/lib/prisma';
import { getAppTimeZone, nthDeliveryDate } from '@/lib/time';
import { countSubjectSlots, parseLayoutSpec } from '@/lib/types/layout-spec';

/**
 * Bulk `ContentCalendar` writer — the operator-authored counterpart to
 * `generateContentCalendar`.
 *
 * Same destination, same row shape, no LLM and no spend: the Evokz team writes
 * template / caption / hashtags / image prompt in a spreadsheet and imports it. The
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
  /**
   * Rows that imported but will not draw as the sheet intends — a headline whose
   * line count does not match its template's emphasis pattern, copy that will
   * wrap, features the template cannot show, an image brief that does not
   * describe the figure the layout composites.
   *
   * Advisory. Every one of these still delivers a poster; the warning is so an
   * operator learns it here rather than from the creative.
   */
  fitWarnings: FitWarning[];
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
      categoryId: true,
      startDate: true,
      deliveryDays: true,
      plan: { select: { name: true, durationDays: true } },
    },
  });
  if (!client) throw new Error(`Client ${clientId} does not exist`);

  const totalDays = client.plan.durationDays;
  if (totalDays < 1) {
    throw new Error(`Plan "${client.plan.name}" has an invalid durationDays`);
  }

  /*
   * The authority on template names.
   *
   * The panel resolved these already against a catalogue passed down at page
   * render, but that snapshot can be minutes old: a template may have been
   * renamed, un-approved or deleted since. Resolving again here, scoped to the
   * client's own vertical, also makes cross-vertical pinning structurally
   * impossible — there is no separate authorization check to forget.
   */
  const approved = await prisma.categoryTemplate.findMany({
    where: { categoryId: client.categoryId, layoutApprovedAt: { not: null } },
    orderBy: { createdAt: 'asc' },
    // The spec comes along so each row's copy can be checked against the layout
    // it names before anything is written. See `checkRowFit`.
    select: { id: true, label: true, layoutSpec: true },
  });

  const index = buildTemplateIndex(approved);

  /*
   * Parsed once, not per row: a sheet routinely names the same template on many
   * days, and `parseLayoutSpec` is a Zod pass plus a structural validation.
   */
  const specByTemplate = new Map(
    approved.map((template) => [
      template.id,
      { label: template.label, spec: parseLayoutSpec(template.layoutSpec) },
    ]),
  );
  const resolutions = rows.map((row) => resolveTemplateName(row.templateName, index));

  /*
   * Throws rather than importing the good rows and counting the rest.
   *
   * `planWrites` is pure precisely so the whole plan is settled before the first
   * write, and a name failure here means the browser preview was wrong — the
   * library moved underneath the operator. Writing the rows that happened to
   * survive would leave a calendar nobody reviewed, which is worse than an error
   * they can act on. `importCalendarEntries` funnels this into the panel intact.
   */
  const unresolved = resolutions.flatMap((resolution, position) =>
    'error' in resolution ? [`Row ${position + 1}: ${resolution.error}`] : [],
  );
  if (unresolved.length > 0) {
    const shown = unresolved.slice(0, 5).join(' · ');
    throw new Error(
      unresolved.length > 5
        ? `${shown} · and ${unresolved.length - 5} more row(s). Nothing was imported.`
        : `${shown} Nothing was imported.`,
    );
  }

  const pinned = rows.map((row, position) => ({
    ...row,
    // Non-null: every resolution was checked above.
    templateId: (resolutions[position] as { id: string }).id,
  }));

  const existing = await prisma.contentCalendar.findMany({
    where: { clientId },
    select: { id: true, dayNumber: true, deliveryStatus: true },
  });
  const byDay = new Map(existing.map((row) => [row.dayNumber, row]));

  const plan = planWrites(pinned, mode, {
    clientId,
    totalDays,
    startDate: client.startDate,
    deliveryDays: client.deliveryDays,
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

  /*
   * What will not draw as the sheet intends.
   *
   * Reported, never refused. A headline one line short of its template still
   * makes a poster — it just makes it without the accent the design is built
   * around — and refusing the import over that would cost the operator every
   * good row in the file. The point is that they find out here rather than from
   * a delivered creative.
   */
  const fitWarnings: FitWarning[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    const resolution = resolutions[rowIndex];
    const templateId = resolution && 'id' in resolution ? resolution.id : null;
    const template = templateId ? specByTemplate.get(templateId) : undefined;
    if (!template?.spec) continue;

    fitWarnings.push(
      ...checkRowFit({
        dayNumber: row.dayNumber ?? rowIndex + 1,
        templateLabel: template.label,
        spec: template.spec,
        copy: row.poster,
        imagePrompt: row.imagePrompt,
        wantsSubject: countSubjectSlots(template.spec) > 0,
      }),
    );
  }

  return {
    clientId,
    fitWarnings,
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
  caption: string;
  hashtags: string;
  imagePrompt: string;
  scheduledDate: Date;
  /** The template this day must be laid out from. Always set — the column is required. */
  posterTemplateId: string;
}

interface WritePlan {
  toCreate: Array<Prisma.ContentCalendarCreateManyInput>;
  // Unchecked rather than the checked variant: the payload is all scalars, and
  // the checked input would demand `posterTemplate: { connect: … }` for what is
  // already a plain id in hand.
  toUpdate: Array<{ id: string; data: Prisma.ContentCalendarUncheckedUpdateInput }>;
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
  rows: Array<
    ReturnType<typeof calendarImportSchema.parse>['rows'][number] & { templateId: string }
  >,
  mode: ConflictMode,
  context: {
    clientId: string;
    totalDays: number;
    startDate: Date;
    /** ISO weekdays the client accepts; empty means every day. */
    deliveryDays: number[];
    byDay: Map<number, { id: string; deliveryStatus: DeliveryStatus }>;
  },
): WritePlan {
  const { totalDays, startDate, deliveryDays, byDay } = context;
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
      posterTemplateId: row.templateId,
      caption: row.caption,
      hashtags: normalizeHashtags(row.hashtags),
      imagePrompt: row.imagePrompt,
      // Day 1 lands on the campaign start date. Calendar-day arithmetic, so a
      // DST transition mid-campaign cannot shift a row into the adjacent day.
      scheduledDate: nthDeliveryDate(startDate, dayNumber, deliveryDays, timeZone),
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
        // Cleared for the same reason as posterCopy above — the theme described
        // the caption being replaced. Leaving it would anchor the new poster's
        // headline to the old angle in `ensurePosterCopy`, and show a stale angle
        // over new copy in the queue ledger.
        theme: null,
        // The template arrives through `...copy` and is written unconditionally.
        // Its predecessor `posterArchetype` was deliberately asymmetric here — a
        // sheet with no opinion had to leave an operator's pin alone — but under
        // the strict rule there is no no-opinion state: the column is required
        // and every accepted row carries a resolved template.
        // A FAILED row can already hold an asset rendered from the *old* image
        // prompt (upload succeeded, broadcast did not). Keeping the reference
        // would let a later re-send deliver the previous creative under the new
        // caption. The orphaned Drive file is left in place, matching what
        // `deleteCalendarEntry` already does.
        gDriveFileId: null,
        gDriveViewUrl: null,
        // Approval belonged to the copy being replaced, not to the day. Carrying
        // it over would let a sheet rewrite an already-reviewed day and have the
        // new wording generated and delivered without anyone reading it — which
        // is precisely the review this import is bypassing.
        approvedAt: null,
        sendAfter: null,
        // A row that was mid-pre-generation is now describing different content,
        // so the queued render would produce a poster for copy that no longer
        // exists. Dropping the mark leaves it to be re-queued deliberately.
        generationQueuedAt: null,
      },
    });
    plan.writtenDays.push(dayNumber);
  }

  return plan;
}
