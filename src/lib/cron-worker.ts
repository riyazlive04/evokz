import { DeliveryStatus } from '@prisma/client';

import { describeError, runCreativePipeline, type PipelineOutcome } from '@/lib/ai-pipeline';
import { intEnv } from '@/lib/env';
import { prisma } from '@/lib/prisma';
import { nextSendDelay } from '@/lib/send-jitter';
import { buildMinuteWindow, getAppTimeZone, zonedDayRange } from '@/lib/time';

/**
 * Segmented interval dispatch engine.
 *
 * Platform cron fires on one global timer, but every client owns a private
 * `cronTime`. Each sweep therefore resolves the trailing minute window in the
 * app timezone, selects only the clients whose delivery minute falls inside it,
 * and hands each due calendar row to the creative pipeline.
 *
 * **Every sweep runs two phases.** Generation happens at the client's exact
 * minute; the WhatsApp broadcast is held back a random few minutes and carried
 * out by a *later* sweep, so a fleet of clients does not message WhatsApp in a
 * synchronised burst every day (`src/lib/send-jitter.ts`). The wait is a
 * timestamp in the database rather than a sleep, for two reasons: the sweep is an
 * HTTP request with a 300s ceiling that a longer delay would exceed, and a
 * sleeping worker would hold one of the sweep's concurrency slots against every
 * other client due on the same minute.
 *
 * The send phase is therefore the one that actually delivers, and it runs first —
 * a poster that came due while this sweep's predecessor was still generating
 * should not wait another minute behind fresh work.
 *
 * **Approval gates all of it.** A row whose `approvedAt` is null is never sent and
 * never released, on any phase. Posters are normally rendered days ahead by the
 * backlog phase and reviewed in the console, so by the time a delivery day
 * arrives the usual work is not generation at all — it is booking a send for a
 * poster that already exists. A row approved without ever being pre-generated is
 * marked for the backlog and rendered by it in the same sweep, so there is exactly
 * one path that calls the pipeline and exactly one claim guarding it.
 */

export interface DispatchQueueItem {
  calendarId: string;
  clientId: string;
  companyName: string;
  dayNumber: number;
  cronTime: string;
}

export interface DispatchSummary {
  ranAt: string;
  timeZone: string;
  /** "HH:MM" values matched this sweep, newest first. */
  minuteWindow: string[];
  matchedClients: number;
  queuedItems: number;
  delivered: number;
  failed: number;
  skipped: number;
  /** Posters generated this sweep and queued for a later broadcast. */
  scheduled: number;
  /** Posters whose held-back send came due and went out this sweep. */
  sent: number;
  /**
   * Pre-generated, approved posters whose delivery day arrived this sweep and
   * which were booked for a send without any fal.ai spend.
   */
  released: number;
  /**
   * Rows rendered this sweep and left waiting on a human.
   *
   * Counts the generation queue's unapproved output specifically. An approved row
   * rendered by the same phase lands in `scheduled` instead, because it left with
   * a send booked rather than held.
   */
  preGenerated: number;
  /**
   * Rows scheduled for today across the active fleet that nobody has approved.
   *
   * Counted rather than acted on: an unapproved poster is skipped silently by
   * every phase, so without this number a campaign can stop delivering with
   * nothing in the sweep output to say why.
   */
  awaitingApproval: number;
  items: Array<DispatchQueueItem & { outcome: PipelineOutcome }>;
}

export async function executeIntervalDispatch(
  now: Date = new Date(),
): Promise<DispatchSummary> {
  const timeZone = getAppTimeZone();
  const windowMinutes = intEnv('CRON_WINDOW_MINUTES', 5);

  const minuteWindow = buildMinuteWindow(now, timeZone, windowMinutes);
  const { start, end } = zonedDayRange(now, timeZone);

  /**
   * A row must have been still this long before the release phase will book it.
   *
   * "GENERATED, approved, no send booked" is ambiguous by one case: it is what a
   * row looks like *while phase 1 is broadcasting it*, because the claim nulls
   * `sendAfter` before the WhatsApp call. Within one sweep that cannot bite —
   * the phases are sequential and awaited — but two overlapping sweeps can, and
   * a release there would send the same poster twice.
   *
   * `updatedAt` separates them: a poster rendered days ago by the backlog phase
   * has not been touched in hours, while one mid-broadcast was written seconds
   * ago. Costing a genuinely stranded row a two-minute wait is the right side of
   * that trade — the duplicate is neither visible to us nor recallable.
   */
  const settledBefore = new Date(now.getTime() - 2 * 60_000);

  // ---- Phase 1: posters whose held-back send has come due ------------------
  //
  // Deliberately not date-scoped: a 23:58 poster delayed eight minutes is due at
  // 00:06 the next day, and scoping this to "today" would strand it forever.
  //
  // `sendAfter: { not: null }` is load-bearing rather than defensive. Rows
  // written before this column existed have a null value, and among them are old
  // GENERATED rows left behind by broadcasts that failed months ago. Treating
  // null as "due now" would deliver every one of them on the next sweep.
  const dueSends = await prisma.contentCalendar.findMany({
    where: {
      deliveryStatus: DeliveryStatus.GENERATED,
      sendAfter: { not: null, lte: now },
      // A client paused between generation and send should not receive.
      client: { isActive: true, isDemo: false },
    },
    // Oldest first, so a backlog drains in the order it accumulated.
    orderBy: { sendAfter: 'asc' },
    // Bounded on purpose. If the box was down for an hour, the backlog is
    // released a few per minute rather than as one burst — which is the very
    // traffic shape the delay exists to avoid.
    take: Math.max(1, intEnv('CRON_SEND_BATCH_LIMIT', 5)),
    select: {
      id: true,
      dayNumber: true,
      clientId: true,
      client: { select: { companyName: true, cronTime: true } },
    },
  });

  const sentItems = await mapWithConcurrency(
    dueSends,
    // Lower than the generation fan-out: these are pure WhatsApp calls, and
    // hammering the gateway in parallel undoes the spreading.
    Math.max(1, intEnv('CRON_SEND_CONCURRENCY', 2)),
    async (row) => ({
      calendarId: row.id,
      clientId: row.clientId,
      companyName: row.client.companyName,
      dayNumber: row.dayNumber,
      cronTime: row.client.cronTime,
      outcome: await claimAndSend(row.id),
    }),
  );

  // ---- Phase 2: today's approved rows, at their client's delivery minute ----
  //
  // Single indexed round-trip: @@index([cronTime, isActive]) on Client and
  // @@index([scheduledDate, deliveryStatus]) on ContentCalendar.
  //
  // Two shapes qualify, and the common one is the first: a poster pre-generated
  // days ago and approved since, which needs nothing but a send booking. The
  // second is a row approved without ever being pre-generated, which still
  // renders on its own day exactly as the whole fleet used to.
  //
  // `approvedAt: { not: null }` sits on the outer filter rather than being checked
  // per row, so an unapproved day is never loaded, never claimed, and cannot be
  // acted on by accident.
  const dueClients = await prisma.client.findMany({
    where: {
      isActive: true,
      // Demo tenants are driven by hand from /admin/demo. Letting the sweep pick
      // them up would WhatsApp a prospect's number unattended.
      isDemo: false,
      cronTime: { in: minuteWindow },
      startDate: { lte: end },
      endDate: { gte: start },
    },
    select: {
      id: true,
      companyName: true,
      cronTime: true,
      calendarDays: {
        where: {
          scheduledDate: { gte: start, lt: end },
          approvedAt: { not: null },
          OR: [
            { deliveryStatus: DeliveryStatus.PENDING },
            {
              deliveryStatus: DeliveryStatus.GENERATED,
              sendAfter: null,
              updatedAt: { lt: settledBefore },
            },
          ],
        },
        select: {
          id: true,
          dayNumber: true,
          deliveryStatus: true,
          gDriveFileId: true,
          gDriveViewUrl: true,
        },
        orderBy: { dayNumber: 'asc' },
      },
    },
  });

  const queue: Array<
    DispatchQueueItem & {
      status: DeliveryStatus;
      gDriveFileId: string | null;
      gDriveViewUrl: string | null;
    }
  > = dueClients.flatMap((client) =>
    client.calendarDays.map((day) => ({
      calendarId: day.id,
      clientId: client.id,
      companyName: client.companyName,
      dayNumber: day.dayNumber,
      cronTime: client.cronTime,
      status: day.deliveryStatus,
      gDriveFileId: day.gDriveFileId,
      gDriveViewUrl: day.gDriveViewUrl,
    })),
  );

  const toRelease = queue.filter((item) => item.status === DeliveryStatus.GENERATED);
  const toGenerate = queue.filter((item) => item.status === DeliveryStatus.PENDING);

  // Counted across the whole active fleet, not just this minute's clients: the
  // number an operator needs is "how much of today is stuck", and a client whose
  // minute has already passed is exactly the case worth surfacing.
  const awaitingApproval = await prisma.contentCalendar.count({
    where: {
      scheduledDate: { gte: start, lt: end },
      approvedAt: null,
      deliveryStatus: { in: [DeliveryStatus.PENDING, DeliveryStatus.GENERATED] },
      client: { isActive: true, isDemo: false },
    },
  });

  // Booking a send is a database write, so these run at the send fan-out rather
  // than the generation one — there is no provider call to pace here.
  const releasedItems = await mapWithConcurrency(
    toRelease,
    Math.max(1, intEnv('CRON_SEND_CONCURRENCY', 2)),
    async (item) => ({
      calendarId: item.calendarId,
      clientId: item.clientId,
      companyName: item.companyName,
      dayNumber: item.dayNumber,
      cronTime: item.cronTime,
      outcome: await releaseApproved(item.calendarId, {
        gDriveFileId: item.gDriveFileId,
        gDriveViewUrl: item.gDriveViewUrl,
      }),
    }),
  );

  /*
   * An approved row that was never pre-generated is *marked* here, not rendered
   * here, and the backlog phase below picks it up in this same sweep.
   *
   * It used to call the pipeline inline, and that was the one generation path in
   * the sweep with no claim in front of it. Sweeps genuinely overlap — a client
   * matches every minute of `CRON_WINDOW_MINUTES`, and a render takes longer than
   * the crontab interval — so two of them would select the same PENDING row and
   * both pay fal.ai for it. The row only leaves the selection when it reaches
   * GENERATED, which is precisely the thing that had not happened yet.
   *
   * Marking cannot fix that on its own: a claim that stamps `generationQueuedAt`
   * and a claim that clears it are guarded on opposite states, so a phase-2 stamp
   * racing a phase-3 claim lets both proceed. Routing through the backlog leaves
   * exactly one claim on the row — `claimAndPreGenerate`'s — which is already
   * proven and already atomic.
   *
   * `updateMany` rather than a per-row loop: it is one statement, and two sweeps
   * running it concurrently converge on the same state rather than conflicting.
   */
  const marked =
    toGenerate.length === 0
      ? 0
      : (
          await prisma.contentCalendar.updateMany({
            where: {
              id: { in: toGenerate.map((item) => item.calendarId) },
              deliveryStatus: DeliveryStatus.PENDING,
              generationQueuedAt: null,
            },
            data: { generationQueuedAt: now },
          })
        ).count;

  // ---- Phase 3: drain the operator's pre-generation backlog ----------------
  //
  // Queried *after* the marking above so today's newly-marked rows are rendered
  // in this sweep rather than the next one, which is what keeps a client's
  // delivery on their own minute.
  //
  // Ordered by scheduled date so the days closest to needing review are rendered
  // first — which also puts today's work ahead of speculative future days — and
  // bounded per sweep because each row is a fal.ai render plus a satori
  // composite: a 365-day campaign queued in one click must not try to become 365
  // renders inside one HTTP request.
  const backlog = await prisma.contentCalendar.findMany({
    where: {
      deliveryStatus: DeliveryStatus.PENDING,
      generationQueuedAt: { not: null },
      client: { isActive: true, isDemo: false },
    },
    orderBy: { scheduledDate: 'asc' },
    take: Math.max(1, intEnv('CRON_BATCH_GENERATE_LIMIT', 6)),
    select: {
      id: true,
      dayNumber: true,
      clientId: true,
      client: { select: { companyName: true, cronTime: true } },
    },
  });

  console.info(
    `[ace:cron] window=${minuteWindow.join(',')} tz=${timeZone} clients=${dueClients.length} ` +
      `releasing=${toRelease.length} marked=${marked} sending=${dueSends.length} ` +
      `backlog=${backlog.length} unapproved=${awaitingApproval}`,
  );

  // Today's marked rows and the speculative backlog are the same work now, so
  // they share one fan-out — and `CRON_BATCH_GENERATE_LIMIT` bounds the pair of
  // them per sweep. The ordering above is what protects a due client: their row
  // carries today's date and sorts ahead of every speculative future day.
  const preGeneratedItems = await mapWithConcurrency(
    backlog,
    Math.max(1, intEnv('CRON_BATCH_GENERATE_CONCURRENCY', 2)),
    async (row) => ({
      calendarId: row.id,
      clientId: row.clientId,
      companyName: row.client.companyName,
      dayNumber: row.dayNumber,
      cronTime: row.client.cronTime,
      outcome: await claimAndPreGenerate(row.id),
    }),
  );

  const items = [...sentItems, ...releasedItems, ...preGeneratedItems];

  const delivered = items.filter(
    (item) => item.outcome.ok && item.outcome.status === DeliveryStatus.DELIVERED,
  ).length;
  const skipped = items.filter((item) => item.outcome.ok && item.outcome.skipped).length;
  const failed = items.filter((item) => !item.outcome.ok).length;
  const scheduled = items.filter(
    (item) => item.outcome.ok && item.outcome.scheduledSendAt !== undefined,
  ).length;

  return {
    ranAt: now.toISOString(),
    timeZone,
    minuteWindow,
    matchedClients: dueClients.length,
    queuedItems: queue.length,
    delivered,
    failed,
    skipped,
    scheduled,
    // Everything phase 1 actually put on the wire. `delivered` counts the same
    // rows, but stays a total across both phases so the existing shape holds.
    sent: sentItems.filter(
      (item) => item.outcome.ok && item.outcome.status === DeliveryStatus.DELIVERED,
    ).length,
    released: releasedItems.filter(
      (item) => item.outcome.ok && item.outcome.scheduledSendAt !== undefined,
    ).length,
    preGenerated: preGeneratedItems.filter(
      (item) => item.outcome.ok && item.outcome.heldForApproval === true,
    ).length,
    awaitingApproval,
    items,
  };
}

/**
 * Books a send for a poster that already exists and has been approved.
 *
 * No provider call and no re-billing: the asset was rendered days ago by the
 * backlog phase, so all this owes is a `sendAfter`, after which phase 1 of a later
 * sweep delivers it through the ordinary path.
 *
 * A conditional update rather than a plain one, for the same reason as
 * `claimAndSend`: sweeps overlap, and two of them booking the same row would
 * stamp two different jitter times, of which the second silently wins — moving a
 * client's delivery for no reason anyone could later explain. Requiring
 * `sendAfter: null` means the loser matches nothing and says so.
 */
async function releaseApproved(
  calendarId: string,
  asset: { gDriveFileId: string | null; gDriveViewUrl: string | null },
): Promise<PipelineOutcome> {
  const scheduled = nextSendDelay();

  const claimed = await prisma.contentCalendar.updateMany({
    where: {
      id: calendarId,
      deliveryStatus: DeliveryStatus.GENERATED,
      approvedAt: { not: null },
      sendAfter: null,
    },
    data: { sendAfter: scheduled.sendAfter },
  });

  if (claimed.count === 0) {
    return {
      ok: true,
      calendarId,
      status: DeliveryStatus.GENERATED,
      skipped: 'claimed-by-another-sweep',
      gDriveFileId: asset.gDriveFileId,
      gDriveViewUrl: asset.gDriveViewUrl,
      reusedAsset: true,
    };
  }

  return {
    ok: true,
    calendarId,
    status: DeliveryStatus.GENERATED,
    scheduledSendAt: scheduled.sendAfter,
    gDriveFileId: asset.gDriveFileId,
    gDriveViewUrl: asset.gDriveViewUrl,
    reusedAsset: true,
  };
}

/**
 * Takes ownership of a queued row, then renders it ahead of its delivery day.
 *
 * The claim clears `generationQueuedAt` before any work starts, which is what
 * removes the row from the backlog query — so an overlapping sweep cannot pay
 * fal.ai a second time for the same poster. Same trade as `claimAndSend`: a
 * process killed between the claim and the render leaves a PENDING row with no
 * queue marker, which the operator re-queues in one click. A duplicate render is
 * money; a dropped mark is a button press.
 *
 * No approval override, so an unapproved row stops at GENERATED of its own
 * accord — which is the common case, since approving it is what this pass exists
 * to make possible.
 *
 * `deferBroadcast` covers the other case. This is now also the path for a row
 * that was approved before it was ever pre-generated, and for that one the
 * pipeline would otherwise reach the broadcast and message the client the instant
 * the render finished — losing the jitter that stops a fleet hitting WhatsApp in
 * one burst. With it, the render stamps `sendAfter` and phase 1 of a later sweep
 * delivers. It is inert for an unapproved row, whose `sendAfter` stays null
 * either way.
 */
async function claimAndPreGenerate(calendarId: string): Promise<PipelineOutcome> {
  const claimed = await prisma.contentCalendar.updateMany({
    where: {
      id: calendarId,
      deliveryStatus: DeliveryStatus.PENDING,
      generationQueuedAt: { not: null },
    },
    data: { generationQueuedAt: null },
  });

  if (claimed.count === 0) {
    return {
      ok: true,
      calendarId,
      status: DeliveryStatus.PENDING,
      skipped: 'claimed-by-another-sweep',
      gDriveFileId: null,
      gDriveViewUrl: null,
      reusedAsset: false,
    };
  }

  return runCreativePipeline(calendarId, { deferBroadcast: true });
}

/**
 * Takes ownership of a due poster, then broadcasts it.
 *
 * The claim is a conditional update rather than a read-then-write, because two
 * sweeps can genuinely overlap: generation runs for minutes while the crontab
 * fires every sixty seconds, so sweep N+1 can start while sweep N is still
 * working. Without this, a WhatsApp call slow enough to straddle that boundary
 * would leave the row `GENERATED` and due, and the next sweep would send the same
 * poster to the same client a second time.
 *
 * Nulling `sendAfter` is what removes it from the due set, and only the sweep
 * whose update reports a row actually proceeds. The loser reports a skip.
 *
 * The cost of this design is a narrow crash window — a process killed between the
 * claim and the broadcast strands the row as `GENERATED` with no schedule, which
 * needs a manual "Send now". That is the right trade: a stranded row is visible
 * and recoverable, whereas a duplicate message to a paying client is neither.
 */
async function claimAndSend(calendarId: string): Promise<PipelineOutcome> {
  const claimed = await prisma.contentCalendar.updateMany({
    where: {
      id: calendarId,
      // Re-asserted, not assumed: the row was selected moments ago and another
      // sweep may have taken it since.
      deliveryStatus: DeliveryStatus.GENERATED,
      sendAfter: { not: null },
    },
    data: { sendAfter: null },
  });

  if (claimed.count === 0) {
    return {
      ok: true,
      calendarId,
      status: DeliveryStatus.GENERATED,
      skipped: 'claimed-by-another-sweep',
      gDriveFileId: null,
      gDriveViewUrl: null,
      reusedAsset: true,
    };
  }

  // The asset is already in Drive, so this run is broadcast-only — no fal.ai
  // call, no re-billing.
  return runCreativePipeline(calendarId, { reuseExistingAsset: true });
}

/**
 * Runs `worker` over `items` with at most `limit` in flight. A worker that
 * throws is captured as a FAILED outcome so one bad row cannot abort the sweep.
 *
 * Exported so the console's bulk retry can reuse the same bounded-concurrency
 * behaviour as the dispatch sweep rather than growing a second copy that drifts.
 */
export async function mapWithConcurrency<T, R extends { outcome: PipelineOutcome }>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) continue;

      try {
        results[index] = await worker(item);
      } catch (error) {
        // runCreativePipeline already swallows its own failures; reaching here
        // means something outside it broke (e.g. the DB went away).
        console.error('[ace:cron] unhandled dispatch failure:', describeError(error));
        results[index] = {
          ...(item as object),
          outcome: {
            ok: false,
            calendarId: (item as { calendarId?: string }).calendarId ?? 'unknown',
            status: DeliveryStatus.FAILED,
            stage: 'load',
            error: describeError(error),
          },
        } as R;
      }
    }
  });

  await Promise.all(runners);
  return results.filter((value): value is R => value !== undefined);
}
