import type { PosterGenerationStatus } from '@prisma/client';

import { intEnv } from '@/lib/env';
import { AUTOMATIC_CAMPAIGNS } from '@/lib/campaign/delivery-service';
import { STALE_GENERATION_MS, type PosterBlockReason } from '@/lib/campaign/poster-generation';
import {
  generateCampaignDayPoster,
  loadPosterOverview,
  planPosterBatch,
  type PosterBatchPlan,
  type PosterBatchRequest,
  type PosterGenerationDeps,
  type PosterLoadOptions,
} from '@/lib/campaign/poster-generation-service';
import { CampaignDomainError, type CampaignDb } from '@/lib/campaign/service';

/**
 * Server-side campaign poster generation — Phase 7.
 *
 * Phase 4 generated posters one request at a time from the browser: closing the
 * tab stopped the batch. This module makes the same work durable without adding
 * any infrastructure, because the queue already existed in the schema.
 *
 * **`PosterGenerationStatus.QUEUED` is the queue.** Phase 1 defined it as "a
 * request nobody has claimed yet" and gave it the transitions
 * `NOT_REQUESTED/SUCCEEDED/FAILED → QUEUED → GENERATING`; until now it was only
 * ever a momentary state inside one claim. Queueing a batch writes that state
 * and returns; the cron sweep drains it. No new table, no new column, no Redis.
 *
 * What each half does:
 * - `queueCampaignPosters` marks eligible days QUEUED and returns immediately.
 *   It calls no provider and spends nothing, so the browser may close.
 * - `runQueuedCampaignGenerations` is the worker. It claims each day with the
 *   same conditional update Phase 4 used (`acceptQueued`), runs the unchanged
 *   pipeline, and settles to SUCCEEDED or FAILED.
 *
 * **Every Phase 4 safety property is preserved**, because the per-day work is
 * still `generateCampaignDayPoster`: eligibility is re-evaluated from fresh
 * rows, the claim restates what the decision was based on, and
 * `posterGenerationStartedAt` still identifies the attempt so a crashed worker
 * is recoverable after `STALE_GENERATION_MS` and two workers cannot both
 * generate — or both bill for — the same day.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * How many days one sweep will generate. Deliberately small: each day is an
 * image model call plus a composite plus two Drive writes, and the sweep shares
 * a request timeout with the legacy dispatch phases.
 */
export function generationBatchLimit(): number {
  return Math.max(1, intEnv('CAMPAIGN_GENERATION_LIMIT', 4));
}

/**
 * How many of those run at once. Default 1 — conservative on purpose: the
 * provider, the Drive account and the database are all shared with the legacy
 * pipeline, and a burst here is felt everywhere. Raise it only with evidence.
 */
export function generationConcurrency(): number {
  return Math.max(1, Math.min(intEnv('CAMPAIGN_GENERATION_CONCURRENCY', 1), 4));
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

export interface QueueOutcome {
  /** Day numbers now waiting for a worker. */
  queued: number[];
  /** Days in scope that were not queued, grouped by why. */
  skipped: Array<{ reason: PosterBlockReason; message: string; attention: boolean; dayNumbers: number[] }>;
  /** Days that were already queued when this ran. */
  alreadyQueued: number[];
  /** What the batch would have cost, from the same planner the confirmation uses. */
  estimatedGenerations: number;
}

/**
 * Marks every eligible day of a batch as QUEUED and returns.
 *
 * Spends nothing and calls no provider, so this is safe to run from a click and
 * safe to leave: the work is now the server's. Queueing is idempotent — a day
 * already QUEUED is reported rather than queued twice, and the transition is a
 * conditional update, so two clicks cannot double-book a day.
 */
export async function queueCampaignPosters(
  db: CampaignDb,
  campaignId: string,
  request: PosterBatchRequest,
  options: PosterLoadOptions = {},
): Promise<QueueOutcome> {
  const overview = await loadPosterOverview(db, campaignId, options);
  if (overview.campaign.status !== 'ACTIVE') {
    throw new CampaignDomainError(
      'invalid-transition',
      `The campaign is ${overview.campaign.status.toLowerCase()} — activate it before queueing posters.`,
    );
  }

  const plan: PosterBatchPlan = planPosterBatch(overview, request);
  const outcome: QueueOutcome = {
    queued: [],
    skipped: plan.skipped,
    alreadyQueued: overview.days.filter((day) => day.generationStatus === 'QUEUED').map((day) => day.dayNumber),
    estimatedGenerations: plan.estimatedGenerations,
  };

  for (const entry of plan.days) {
    const day = overview.days.find((candidate) => candidate.id === entry.dayId)!;
    const from: PosterGenerationStatus = day.generationStatus ?? 'NOT_REQUESTED';
    // Only the three settled states may be queued. A GENERATING day is left to
    // its attempt (or to the stale reaper); a QUEUED one is already waiting.
    if (from !== 'NOT_REQUESTED' && from !== 'SUCCEEDED' && from !== 'FAILED') continue;

    const queued = await db.contentCalendar.updateMany({
      where: {
        id: entry.dayId,
        campaignId,
        generationStatus: from,
        // Restated so a day that changed since the plan is not queued blindly.
        contentRevision: day.contentRevision,
        campaign: { status: 'ACTIVE' },
      },
      data: { generationStatus: 'QUEUED', errorMessage: null },
    });
    if (queued.count === 1) outcome.queued.push(day.dayNumber);
  }

  outcome.queued.sort((a, b) => a - b);
  return outcome;
}

/**
 * Withdraws queued days that no worker has taken yet (`QUEUED → NOT_REQUESTED`).
 * A day already being generated is left alone — it is too late to un-spend it.
 */
export async function cancelQueuedGeneration(db: CampaignDb, campaignId: string): Promise<number> {
  const cancelled = await db.contentCalendar.updateMany({
    where: { campaignId, generationStatus: 'QUEUED' },
    data: { generationStatus: 'NOT_REQUESTED', errorMessage: null },
  });
  return cancelled.count;
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

export interface GenerationSweepResult {
  claimed: number;
  generated: Array<{ campaignId: string; dayNumber: number }>;
  failed: Array<{ campaignId: string; dayNumber: number; message: string }>;
  skipped: Array<{ campaignId: string; dayNumber: number; reason: string; message: string }>;
  /** A credential/configuration/billing failure stopped the sweep early. */
  stopped: boolean;
  /** The time budget ran out: days listed but not started stay QUEUED for the next tick. */
  budgetExhausted: boolean;
}

/** An empty sweep result. */
export function emptyGenerationSweep(): GenerationSweepResult {
  return { claimed: 0, generated: [], failed: [], skipped: [], stopped: false, budgetExhausted: false };
}

interface QueuedDay {
  id: string;
  dayNumber: number;
  campaignId: string;
}

/**
 * Generates queued campaign posters. Called once per cron tick.
 *
 * Bounded twice over: at most `generationBatchLimit()` days per tick, at most
 * `generationConcurrency()` at a time. Only ACTIVE campaigns are considered — and,
 * for the cron sweep (no `campaignId`), only those of active, non-demo clients —
 * so pausing a campaign or its client stops its queue at once. A paused client's
 * queued days stay QUEUED and continue, with no duplicates, when it is resumed; a
 * paused campaign's queue is released (`releaseQueuedForInactiveCampaigns`), so
 * its days do not look as if they were being generated while it is paused.
 *
 * A configuration, credential or billing failure stops the sweep: every later
 * day would fail the same way, and marking them all FAILED would bury the cause.
 * They stay QUEUED for the next tick.
 *
 * With `budgetMs`, no day is started once that much wall-clock time has passed
 * since the sweep began; the day in flight finishes, and the rest stay QUEUED.
 * Each day's claim is stamped with the sweep's `now` advanced by the time
 * already spent, so a day started late in a long sweep does not look stale early.
 */
export async function runQueuedCampaignGenerations(
  db: CampaignDb,
  options: PosterLoadOptions & {
    deps?: PosterGenerationDeps;
    limit?: number;
    concurrency?: number;
    /** Only this campaign's queue — the board driving its own bulk run one poster at a time. */
    campaignId?: string;
    /** Stop starting days after this many wall-clock milliseconds. */
    budgetMs?: number;
    /** The wall clock the budget is measured on, in milliseconds. Tests pass a fake. */
    clock?: () => number;
  } = {},
): Promise<GenerationSweepResult> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? generationBatchLimit();
  const clock = options.clock ?? Date.now;
  const sweepStartedAt = clock();
  const result = emptyGenerationSweep();

  const queued = await db.contentCalendar.findMany({
    where: {
      campaignId: options.campaignId ?? { not: null },
      // The cron sweep generates only for active, non-demo clients, so pausing a
      // client stops its queue (the days stay QUEUED and continue on resume). The
      // board driving its own campaign's bulk run is an operator's explicit
      // request and is not filtered by the client.
      campaign: options.campaignId ? { status: 'ACTIVE' } : AUTOMATIC_CAMPAIGNS,
      OR: [
        { generationStatus: 'QUEUED' },
        // An attempt whose worker died: recoverable once it is stale.
        { generationStatus: 'GENERATING', posterGenerationStartedAt: { lt: new Date(now.getTime() - STALE_GENERATION_MS) } },
      ],
    },
    // Oldest slot first, so a backlog drains in the order it will be needed.
    orderBy: [{ scheduledDate: 'asc' }, { dayNumber: 'asc' }],
    take: limit,
    select: { id: true, dayNumber: true, campaignId: true },
  });
  if (queued.length === 0) return result;

  const days: QueuedDay[] = queued.map((day) => ({ id: day.id, dayNumber: day.dayNumber, campaignId: day.campaignId! }));
  let stop = false;

  await mapWithLimit(days, options.concurrency ?? generationConcurrency(), async (day) => {
    if (stop) return;
    const elapsed = Math.max(0, clock() - sweepStartedAt);
    if (options.budgetMs !== undefined && elapsed >= options.budgetMs) {
      // Out of time: left QUEUED, untouched, for the next tick.
      result.budgetExhausted = true;
      return;
    }
    try {
      const outcome = await generateCampaignDayPoster(db, day.campaignId, day.id, {
        ...options,
        mode: 'regenerate',
        explicit: true,
        acceptQueued: true,
        now: new Date(now.getTime() + elapsed),
      });

      if (outcome.outcome === 'generated') {
        result.claimed += 1;
        result.generated.push({ campaignId: day.campaignId, dayNumber: outcome.dayNumber });
        logGeneration('generated', day, { versionId: outcome.versionId });
      } else if (outcome.outcome === 'failed') {
        result.claimed += 1;
        result.failed.push({ campaignId: day.campaignId, dayNumber: outcome.dayNumber, message: outcome.message });
        logGeneration('failed', day, { kind: outcome.kind, billed: outcome.billed });
        if (outcome.stopBatch) {
          stop = true;
          result.stopped = true;
        }
      } else {
        result.skipped.push({ campaignId: day.campaignId, dayNumber: outcome.dayNumber, reason: outcome.reason, message: outcome.message });
        logGeneration('skipped', day, { reason: outcome.reason });
        /*
         * A queued day that can no longer be generated — its template was never
         * read, its date passed — would otherwise stay QUEUED and be picked again
         * on every tick (and by the board's own run, forever). It is released
         * instead, and the board shows why it is blocked. A conflict is another
         * worker's claim and is left alone.
         */
        if (outcome.reason !== 'conflict' && outcome.reason !== 'generating') {
          await db.contentCalendar.updateMany({ where: { id: day.id, generationStatus: 'QUEUED' }, data: { generationStatus: 'NOT_REQUESTED' } });
        }
      }
    } catch (error) {
      // One day's unexpected throw must not lose the rest of the sweep.
      const message = error instanceof Error ? error.message : 'Generation failed.';
      result.failed.push({ campaignId: day.campaignId, dayNumber: day.dayNumber, message });
      logGeneration('failed', day, { unexpected: true });
    }
  });

  return result;
}

// ---------------------------------------------------------------------------
// The cron step: one sweep at a time, within a budget
// ---------------------------------------------------------------------------

/**
 * How long, from the start of a cron sweep, its generation step keeps starting
 * new days: 150 seconds. The booking sync and due sends run first and use part
 * of it, and a sweep shares one request with a 300-second ceiling (Vercel's
 * `maxDuration`, the host cron's `curl -m 300`), so the day still in flight when
 * the budget runs out has room to finish.
 */
export const CRON_GENERATION_BUDGET_MS = 150_000;

/**
 * How long the lock's transaction may stay open: the budget plus one clone in
 * flight (a 5-minute image request, the 90-second text check, Drive writes),
 * with room to spare. If it ever expires the lock is released early, which only
 * reopens the race the claim itself already refuses.
 */
const GENERATION_LOCK_TRANSACTION_MS = 15 * 60_000;

/** SQL that takes the generation step's lock for the current transaction, if free. */
const TRY_GENERATION_LOCK = `SELECT pg_try_advisory_xact_lock(hashtext('evokz:campaign-generation-sweep')) AS locked`;

export type ExclusiveGenerationSweep = GenerationSweepResult & {
  /** Another sweep was already generating, so this one generated nothing. */
  lockHeld: boolean;
};

/**
 * `runQueuedCampaignGenerations` for the cron sweep: only one sweep generates at
 * a time. The cron fires every minute and a clone takes minutes, so overlapping
 * sweeps are normal; the second one skips generation instead of working the
 * same queue beside the first.
 *
 * The guard is a Postgres transaction-level advisory lock
 * (`pg_try_advisory_xact_lock`): it is taken without waiting, held by a
 * transaction that does nothing else while the queue is worked through the
 * ordinary client, and released when that transaction ends — commit, rollback,
 * a thrown error or a dropped connection alike — so it can never be left behind.
 * The database pool must allow at least two connections (the lock holds one).
 */
export async function runQueuedCampaignGenerationsExclusively(
  db: CampaignDb,
  options: Parameters<typeof runQueuedCampaignGenerations>[1] = {},
): Promise<ExclusiveGenerationSweep> {
  if (!('$transaction' in db)) {
    // Already inside a caller's transaction: its connection is the only one.
    const locked = await db.$queryRawUnsafe<Array<{ locked: boolean }>>(TRY_GENERATION_LOCK);
    if (!locked[0]?.locked) return { ...emptyGenerationSweep(), lockHeld: true };
    return { ...(await runQueuedCampaignGenerations(db, options)), lockHeld: false };
  }
  return db.$transaction(
    async (tx) => {
      const locked = await tx.$queryRawUnsafe<Array<{ locked: boolean }>>(TRY_GENERATION_LOCK);
      if (!locked[0]?.locked) return { ...emptyGenerationSweep(), lockHeld: true };
      return { ...(await runQueuedCampaignGenerations(db, options)), lockHeld: false };
    },
    { timeout: GENERATION_LOCK_TRANSACTION_MS, maxWait: 10_000 },
  );
}

/**
 * Releases queued work for campaigns that are no longer ACTIVE.
 *
 * The worker already skips them (it selects only ACTIVE campaigns); releasing
 * keeps a paused campaign from showing its days as "being generated" forever —
 * which also locks their editing — so the cron sweep calls this every tick and
 * pausing a campaign releases its own queue at once. Days being generated are
 * left to settle on their own.
 */
export async function releaseQueuedForInactiveCampaigns(db: CampaignDb): Promise<number> {
  const released = await db.contentCalendar.updateMany({
    where: {
      campaignId: { not: null },
      generationStatus: 'QUEUED',
      campaign: { status: { in: ['PAUSED', 'COMPLETED', 'CANCELLED'] } },
    },
    data: { generationStatus: 'NOT_REQUESTED' },
  });
  return released.count;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Bounded fan-out. A local copy rather than the dispatch sweep's, because that
 * one is typed to the legacy pipeline's outcome and importing it here would tie
 * campaign generation to the legacy module.
 *
 * Exported for `check:campaign-operations`, which pins the overlap directly: the
 * database suite runs everything inside one interactive transaction, and Prisma
 * serialises that, so genuine concurrency cannot be observed there.
 */
export async function mapWithLimit<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index]!);
      }
    }),
  );
}

/**
 * Structured, safe-identifier logging (Phase 7 §17).
 *
 * Ids only — never a prompt, a Drive id, a signed URL or anything from the
 * environment. The campaign and day are enough to find the row.
 */
function logGeneration(event: 'generated' | 'failed' | 'skipped', day: QueuedDay, detail: Record<string, unknown>): void {
  const fields = Object.entries(detail)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  console.info(`[ace:campaign-generation] ${event} campaign=${day.campaignId} day=${day.dayNumber} dayId=${day.id}${fields ? ` ${fields}` : ''}`);
}
