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
    `[ace:cron] window=${minuteWindow.join(',')} tz=${timeZone} clients=${dueClients.length} queued=${queue.length}`,
  );

  // Items run concurrently up to `concurrency` — no item waits on the item
  // before it. The sweep is still awaited as a whole, because a serverless
  // invocation is torn down the moment its handler resolves; detaching the work
  // would silently kill in-flight generations.
  const items = await mapWithConcurrency(queue, concurrency, async (item) => ({
    ...item,
    outcome: await runCreativePipeline(item.calendarId),
  }));

  const delivered = items.filter(
    (item) => item.outcome.ok && item.outcome.status === DeliveryStatus.DELIVERED,
  ).length;
  const skipped = items.filter((item) => item.outcome.ok && item.outcome.skipped).length;
  const failed = items.filter((item) => !item.outcome.ok).length;

  return {
    ranAt: now.toISOString(),
    timeZone,
    minuteWindow,
    matchedClients: dueClients.length,
    queuedItems: queue.length,
    delivered,
    failed,
    skipped,
    items,
  };
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
