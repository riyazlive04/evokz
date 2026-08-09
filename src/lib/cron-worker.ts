import { DeliveryStatus } from '@prisma/client';

import { describeError, runCreativePipeline, type PipelineOutcome } from '@/lib/ai-pipeline';
import { intEnv } from '@/lib/env';
import { prisma } from '@/lib/prisma';
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
  items: Array<DispatchQueueItem & { outcome: PipelineOutcome }>;
}

export async function executeIntervalDispatch(
  now: Date = new Date(),
): Promise<DispatchSummary> {
  const timeZone = getAppTimeZone();
  const windowMinutes = intEnv('CRON_WINDOW_MINUTES', 5);
  const concurrency = Math.max(1, intEnv('CRON_MAX_CONCURRENCY', 4));

  const minuteWindow = buildMinuteWindow(now, timeZone, windowMinutes);
  const { start, end } = zonedDayRange(now, timeZone);

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

  // Single indexed round-trip: @@index([cronTime, isActive]) on Client and
  // @@index([scheduledDate, deliveryStatus]) on ContentCalendar.
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
          deliveryStatus: DeliveryStatus.PENDING,
        },
        select: { id: true, dayNumber: true },
        orderBy: { dayNumber: 'asc' },
      },
    },
  });

  const queue: DispatchQueueItem[] = dueClients.flatMap((client) =>
    client.calendarDays.map((day) => ({
      calendarId: day.id,
      clientId: client.id,
      companyName: client.companyName,
      dayNumber: day.dayNumber,
      cronTime: client.cronTime,
    })),
  );

  console.info(
    `[ace:cron] window=${minuteWindow.join(',')} tz=${timeZone} clients=${dueClients.length} ` +
      `queued=${queue.length} sending=${dueSends.length}`,
  );

  // Items run concurrently up to `concurrency` — no item waits on the item
  // before it. The sweep is still awaited as a whole, because a serverless
  // invocation is torn down the moment its handler resolves; detaching the work
  // would silently kill in-flight generations.
  const generatedItems = await mapWithConcurrency(queue, concurrency, async (item) => ({
    ...item,
    // Stops at GENERATED and stamps `sendAfter`. Phase 1 of a later sweep sends it.
    outcome: await runCreativePipeline(item.calendarId, { deferBroadcast: true }),
  }));

  const items = [...sentItems, ...generatedItems];

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
    items,
  };
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
