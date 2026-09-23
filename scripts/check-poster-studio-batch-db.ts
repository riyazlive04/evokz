/**
 * Database checks for bulk Poster Studio runs (src/lib/poster-studio/batch-service.ts).
 *
 * Creates STUDIO and CAMPAIGN batches, drives the queue (claim, stale reclaim,
 * lost claims), settles every provider outcome (success, a billing stop, a rate
 * limit, a plain failure), saves images to campaign days, and checks the cron
 * runner and the History filter.
 *
 * **No provider is reachable.** The image call is an in-process fake that
 * writes a studio row with fake Drive ids; `fetch` is disabled and counted.
 *
 * How it stays harmless (the `check:campaign-operations-db` technique):
 *   - `globalThis.prisma` is a facade over ONE interactive transaction that is
 *     always rolled back, with SAVEPOINTs for nested transactions; table row
 *     counts are compared before and after.
 *   - Refuses to run unless DATABASE_URL is a local development database.
 *
 * Run: npm run check:poster-studio-batch-db
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { Prisma, PrismaClient } from '@prisma/client';

(globalThis as unknown as { AsyncLocalStorage: typeof AsyncLocalStorage }).AsyncLocalStorage = AsyncLocalStorage;

for (const key of ['OPENAI_API_KEY', 'FAL_KEY', 'EVOLUTION_API_KEY', 'EVOLUTION_API_URL', 'GOOGLE_PRIVATE_KEY', 'GOOGLE_SERVICE_ACCOUNT_EMAIL']) {
  process.env[key] = '';
}
let networkAttempts = 0;
globalThis.fetch = (async () => {
  networkAttempts += 1;
  throw new Error('network disabled by check:poster-studio-batch-db');
}) as typeof fetch;

{
  let host = '';
  let database = '';
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    host = url.hostname;
    database = url.pathname.replace(/^\//, '');
  } catch {
    // Refused below.
  }
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) || !/dev/i.test(database)) {
    console.error(`Refusing to run: DATABASE_URL must be a local development database (got host "${host || '?'}", database "${database || '?'}").`);
    process.exit(2);
  }
  console.log(`database: ${database} @ ${host}`);
}

let bad = 0;
const t = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) bad += 1;
};
const section = (title: string) => console.log(`\n--- ${title} ${'-'.repeat(Math.max(0, 58 - title.length))}`);

class Rollback extends Error {}

const realPrisma = new PrismaClient();
let activeTx: Prisma.TransactionClient | null = null;
let savepoints = 0;

const facade: PrismaClient = new Proxy({} as PrismaClient, {
  has(_target, prop) {
    return prop === '$transaction' || (activeTx !== null && prop in activeTx);
  },
  get(_target, prop) {
    if (prop === '$transaction') {
      return async (arg: unknown) => {
        if (Array.isArray(arg)) {
          const results: unknown[] = [];
          for (const operation of arg) results.push(await operation);
          return results;
        }
        if (typeof arg !== 'function') throw new Error('Unsupported $transaction argument');
        const name = `check_sp_${(savepoints += 1)}`;
        await activeTx!.$executeRawUnsafe(`SAVEPOINT ${name}`);
        try {
          const result = await (arg as (tx: PrismaClient) => unknown)(facade);
          await activeTx!.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
          return result;
        } catch (error) {
          await activeTx!.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
          throw error;
        }
      };
    }
    if (!activeTx) throw new Error('No active check transaction');
    const value = Reflect.get(activeTx, prop) as unknown;
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(activeTx) : value;
  },
});
(globalThis as unknown as { prisma: PrismaClient }).prisma = facade;

// ---------------------------------------------------------------------------

async function suite(): Promise<void> {
  const tx = facade;
  const batches = await import('@/lib/poster-studio/batch-service');
  const { loadStudioBatchView } = await import('@/lib/poster-studio/batch-view');
  const { studioHistorySelect, toStudioHistoryItem, loadStudioHistory } = await import('@/lib/poster-studio/history');
  const { createCampaign } = await import('@/lib/campaign/service');
  const { startOfZonedDay } = await import('@/lib/time');
  const { STALE_GENERATION_MS } = await import('@/lib/campaign/poster-generation');
  type Deps = import('@/lib/poster-studio/batch-service').BatchDeps;
  type Row = import('@/lib/poster-studio/batch-sheet').BatchSheetRow;
  type Result = import('@/lib/poster-studio/generate').StudioGenerateResult;

  const TZ = process.env.APP_TIME_ZONE || 'Asia/Kolkata';
  let clock = new Date();
  const today = startOfZonedDay(clock, TZ);
  const tomorrow = new Date(today.getTime() + 36 * 3_600_000);

  // ---- Fakes -------------------------------------------------------------------
  const requests: Array<{ prompt: string; aspectRatio: string; festival: string | null; quality: string | null; overlay: string[] }> = [];
  const failures: Result[] = [];
  let fileCounter = 0;
  const deps: Deps = {
    now: () => clock,
    generate: async (request, options) => {
      requests.push({ prompt: request.prompt, aspectRatio: request.aspectRatio, festival: request.festival ?? null, quality: request.quality ?? null, overlay: request.overlayElements });
      const failure = failures.shift();
      if (failure) return failure;
      const row = await tx.posterStudioGeneration.create({
        data: {
          mode: 'GENERATE',
          prompt: request.prompt,
          sentPrompt: `sent: ${request.prompt}`,
          aspectRatio: request.aspectRatio,
          size: '1152x2048',
          model: 'fake',
          quality: request.quality ?? 'low',
          textFree: request.textFree,
          festival: request.festival ?? null,
          imageDriveFileId: `fake-drive-${(fileCounter += 1)}`,
          imageMimeType: 'image/png',
          width: 1152,
          height: 2048,
          clientId: request.clientId,
          batchItemId: options.batchItemId,
        },
        select: studioHistorySelect,
      });
      return { ok: true, generation: toStudioHistoryItem(row) };
    },
    saveToDay: batches.defaultBatchDeps.saveToDay,
    brandSummary: async () =>
      ({
        logo: { available: true, loadError: null, removal: { possible: false }, defaultBackground: 'ORIGINAL' },
        tagline: 'Care',
        website: 'batch-fixture.invalid',
        phone: null,
      }) as unknown as Awaited<ReturnType<Deps['brandSummary']>>,
  };
  const row = (position: number, dayLabel: string, prompt: string, extra: Partial<Row> = {}): Row => ({
    position,
    sheetRow: position + 1,
    dayLabel,
    dayNumber: /^\d+$/.test(dayLabel) ? Number(dayLabel) : null,
    prompt,
    aspectRatio: null,
    festival: null,
    textFree: null,
    quality: null,
    ...extra,
  });
  const itemsOf = (batchId: string) => tx.posterStudioBatchItem.findMany({ where: { batchId }, orderBy: { position: 'asc' } });
  const statusOf = async (batchId: string) => (await tx.posterStudioBatch.findUnique({ where: { id: batchId } }))!.status;
  async function expectBatchError(name: string, work: () => Promise<unknown>, pattern?: RegExp) {
    try {
      await work();
      t(name, false, 'succeeded but should have failed');
    } catch (error) {
      t(name, error instanceof batches.StudioBatchError && (!pattern || pattern.test(error.message)), error instanceof Error ? error.message : String(error));
    }
  }

  // ---- Fixtures ----------------------------------------------------------------
  const plan = await tx.plan.create({ data: { name: 'check:batch 6', durationDays: 6 } });
  const vertical = await tx.category.create({ data: { name: 'check:batch Vertical' } });
  const client = await tx.client.create({
    data: { companyName: 'check:batch Clinic', whatsappNumber: '919876500888', startDate: today, endDate: today, planId: plan.id, categoryId: vertical.id, isDemo: false, isActive: true, imageSizePreset: 'whatsapp-status' },
  });

  // =======================================================================
  section('a STUDIO batch: draft, customize, start');
  // =======================================================================
  const studio = await batches.createStudioBatch(
    tx,
    {
      name: '',
      target: 'STUDIO',
      clientId: client.id,
      campaignId: null,
      defaults: { aspectRatio: '1:1', quality: null, textFree: false, festival: 'diwali' },
      brandIdentity: true,
      fileName: 'october.xlsx',
      rows: [row(1, 'Day 1', 'Checkup camp poster'), row(2, 'Diwali', 'Festive greeting', { aspectRatio: '9:16', quality: 'high' }), row(3, '3', 'Gum care tips')],
    },
    deps,
  );
  const studioBatch = (await tx.posterStudioBatch.findUnique({ where: { id: studio.batchId } }))!;
  t('three rows become a DRAFT batch named after the file', studio.created === 3 && studioBatch.status === 'DRAFT' && studioBatch.name === 'october');
  t('branding takes what the Brand Canvas has', JSON.stringify(studioBatch.overlayElements) === JSON.stringify(['logo', 'tagline', 'website']), studioBatch.overlayElements.join(','));
  let items = await itemsOf(studio.batchId);
  t('rows keep order, labels and their own settings', items.map((item) => item.dayLabel).join('|') === 'Day 1|Diwali|3' && items[1]!.aspectRatio === '9:16' && items[1]!.quality === 'high');
  t('nothing is queued or generated in a draft', items.every((item) => item.status === 'NOT_REQUESTED') && requests.length === 0);

  const draftCustomize = await batches.customizeBatchItem(tx, items[2]!.id, { prompt: 'Gum care tips, illustrated', aspectRatio: '16:9', festival: null, textFree: true, quality: 'medium' }, deps);
  const customized = (await tx.posterStudioBatchItem.findUnique({ where: { id: items[2]!.id } }))!;
  t('customizing a draft row is free: it is not queued', !draftCustomize.requeued && customized.status === 'NOT_REQUESTED');
  t('…and "no festival" overrides the Diwali default', batches.effectiveItemSettings(studioBatch, customized).festival === null && customized.festival === '');
  t('…the other settings are the row’s own', customized.aspectRatio === '16:9' && customized.textFree === true && customized.quality === 'medium' && customized.prompt === 'Gum care tips, illustrated');

  const started = await batches.startStudioBatch(tx, studio.batchId, deps);
  t('start queues every row and runs the batch', started.queued === 3 && (await statusOf(studio.batchId)) === 'RUNNING');
  await expectBatchError('a batch cannot be started twice', () => batches.startStudioBatch(tx, studio.batchId, deps), /already/);

  // =======================================================================
  section('the queue: claims, outcomes, settling');
  // =======================================================================
  const first = await batches.claimBatchItem(tx, clock, { batchId: studio.batchId });
  const second = await batches.claimBatchItem(tx, clock, { batchId: studio.batchId });
  t('two claims take two different rows, in sheet order', first !== null && second !== null && first.itemId === items[0]!.id && second.itemId === items[1]!.id);
  t('a claimed row is GENERATING with its token', (await tx.posterStudioBatchItem.findUnique({ where: { id: first!.itemId } }))!.status === 'GENERATING');

  const outcome1 = await batches.processBatchItem(tx, first!, deps);
  const made1 = (await tx.posterStudioBatchItem.findUnique({ where: { id: first!.itemId } }))!;
  t('success settles the row with its image', outcome1.kind === 'succeeded' && made1.status === 'SUCCEEDED' && made1.generationId !== null);
  t('the request carried the batch defaults', requests[0]!.aspectRatio === '1:1' && requests[0]!.festival === 'diwali' && requests[0]!.quality === null && requests[0]!.overlay.join(',') === 'logo,tagline,website');
  const image1 = (await tx.posterStudioGeneration.findUnique({ where: { id: made1.generationId! } }))!;
  t('the image is tied to its row', image1.batchItemId === made1.id);
  const history = await loadStudioHistory();
  t('bulk images stay out of the studio History', !history.some((item) => item.id === image1.id));

  failures.push({ ok: false, kind: 'quota', error: 'The OpenAI account has run out of credit.' });
  const outcome2 = await batches.processBatchItem(tx, second!, deps);
  const waiting = (await tx.posterStudioBatchItem.findUnique({ where: { id: second!.itemId } }))!;
  t('a billing failure pauses the batch with its reason', outcome2.kind === 'paused' && (await tx.posterStudioBatch.findUnique({ where: { id: studio.batchId } }))!.pausedReason === 'The OpenAI account has run out of credit.');
  t('…and puts the row back in the queue, its attempt not counted', waiting.status === 'QUEUED' && waiting.attempts === 0 && waiting.error === null);
  t('a paused batch offers nothing to claim', (await batches.claimBatchItem(tx, clock, { batchId: studio.batchId })) === null);

  await batches.resumeStudioBatch(tx, studio.batchId, deps);
  failures.push({ ok: false, kind: 'rate-limit', error: 'Too many requests.' });
  const outcome3 = await batches.runNextBatchItem(tx, studio.batchId, deps);
  t('a rate limit sends the row back to the queue', outcome3?.kind === 'requeued' && (await tx.posterStudioBatchItem.findUnique({ where: { id: second!.itemId } }))!.status === 'QUEUED');

  failures.push({ ok: false, kind: 'moderation', error: 'The prompt was refused by the safety system.' });
  const outcome4 = await batches.runNextBatchItem(tx, studio.batchId, deps);
  const refused = (await tx.posterStudioBatchItem.findUnique({ where: { id: second!.itemId } }))!;
  t('any other failure fails just that row, with its message', outcome4?.kind === 'failed' && refused.status === 'FAILED' && /safety system/.test(refused.error ?? ''));

  const outcome5 = await batches.runNextBatchItem(tx, studio.batchId, deps);
  t('the customized row is made with its own settings', outcome5?.kind === 'succeeded' && requests.at(-1)!.aspectRatio === '16:9' && requests.at(-1)!.festival === null && requests.at(-1)!.quality === 'medium');
  t('with nothing left to make, the batch is DONE', (await batches.runNextBatchItem(tx, studio.batchId, deps)) === null && (await statusOf(studio.batchId)) === 'DONE');

  const retried = await batches.retryStudioBatch(tx, studio.batchId);
  t('retry queues only the failed row and runs the batch again', retried.queued === 1 && (await statusOf(studio.batchId)) === 'RUNNING');

  // Stale and lost claims.
  const claim = (await batches.claimBatchItem(tx, clock, { batchId: studio.batchId }))!;
  clock = new Date(clock.getTime() + STALE_GENERATION_MS + 60_000);
  const reclaim = await batches.claimBatchItem(tx, clock, { batchId: studio.batchId });
  t('a claim older than the stale limit is taken again', reclaim?.itemId === claim.itemId && reclaim.token.getTime() !== claim.token.getTime());
  const lost = await batches.processBatchItem(tx, claim, deps);
  t('the first worker finds its claim lost and records nothing', lost.kind === 'lost' && requests.length === 5, String(requests.length));
  const kept = await batches.processBatchItem(tx, reclaim!, deps);
  t('the reclaiming worker makes the row', kept.kind === 'succeeded' && (await statusOf(studio.batchId)) === 'DONE');

  // Customize after the run: a redo.
  items = await itemsOf(studio.batchId);
  const redo = await batches.customizeBatchItem(tx, items[0]!.id, { prompt: 'Checkup camp poster', aspectRatio: '4:5', festival: 'onam', textFree: false, quality: null }, deps);
  t('customizing a made row queues it again and reopens the batch', redo.requeued && (await statusOf(studio.batchId)) === 'RUNNING');
  await batches.runNextBatchItem(tx, studio.batchId, deps);
  const redone = (await tx.posterStudioBatchItem.findUnique({ where: { id: items[0]!.id }, include: { _count: { select: { images: true } } } }))!;
  t('…the redo is a second image on the row; the first is kept', redone._count.images === 2 && redone.generationId !== items[0]!.generationId);
  t('…made at the new format and festival', requests.at(-1)!.aspectRatio === '4:5' && requests.at(-1)!.festival === 'onam');

  const view = (await loadStudioBatchView(tx, studio.batchId))!;
  t('the view counts rows and flags customized ones', view.counts.SUCCEEDED === 3 && view.items[0]!.customized && view.items[0]!.imageCount === 2);

  // =======================================================================
  section('a CAMPAIGN batch: days resolved, saved as versions');
  // =======================================================================
  const { campaignId } = await createCampaign(tx, { clientId: client.id, name: 'Batch', startDate: tomorrow, timeZone: TZ });
  const day4 = (await tx.contentCalendar.findFirst({ where: { campaignId, dayNumber: 4 } }))!;
  await tx.contentCalendar.update({ where: { id: day4.id }, data: { scheduledDate: new Date(today.getTime() - 2 * 86_400_000) } });

  const campaign = await batches.createStudioBatch(
    tx,
    {
      name: 'Campaign run',
      target: 'CAMPAIGN',
      clientId: null,
      campaignId,
      defaults: { aspectRatio: '1:1', quality: null, textFree: false, festival: null },
      brandIdentity: false,
      fileName: null,
      rows: [
        row(1, '1', 'Day one poster', { aspectRatio: '16:9' }),
        row(2, 'Welcome', 'Not a number'),
        row(3, '2', 'Day two poster'),
        row(4, '2', 'Day two again'),
        row(5, '4', 'A past day'),
        row(6, '99', 'Beyond the campaign'),
      ],
    },
    deps,
  );
  const reasons = campaign.excluded.map((entry) => entry.reason).join(' | ');
  t('only days 1 and 2 are kept', campaign.created === 2, reasons);
  t('left out: a non-number, a repeat, a past day and a missing day, each with its reason', campaign.excluded.length === 4 && /day number/.test(reasons) && /appears earlier/.test(reasons) && /passed/.test(reasons) && /not in this campaign/.test(reasons), reasons);
  const campaignItems = await itemsOf(campaign.batchId);
  t('each row is fixed to its day’s shape, whatever the sheet said', campaignItems.every((item) => item.aspectRatio === '9:16' && item.calendarDayId !== null));
  t('the batch is the campaign client’s', (await tx.posterStudioBatch.findUnique({ where: { id: campaign.batchId } }))!.clientId === client.id);
  await expectBatchError('a campaign row cannot change shape', () =>
    batches.customizeBatchItem(tx, campaignItems[0]!.id, { prompt: 'Day one poster', aspectRatio: '1:1', festival: null, textFree: false, quality: null }, deps),
  );

  await batches.startStudioBatch(tx, campaign.batchId, deps);
  const saved = await batches.runNextBatchItem(tx, campaign.batchId, deps);
  const savedItem = (await tx.posterStudioBatchItem.findUnique({ where: { id: campaignItems[0]!.id } }))!;
  const version = savedItem.posterVersionId ? await tx.posterVersion.findUnique({ where: { id: savedItem.posterVersionId } }) : null;
  t('the image is saved to its day as a POSTER_STUDIO version', saved?.kind === 'succeeded' && saved.savedToDay && version?.source === 'POSTER_STUDIO' && version.calendarDayId === campaignItems[0]!.calendarDayId);
  t('…which becomes the day’s active poster, awaiting review', (await tx.contentCalendar.findUnique({ where: { id: campaignItems[0]!.calendarDayId! } }))!.activePosterVersionId === version?.id && version?.approvalStatus === 'PENDING', version?.approvalStatus);

  // The second day passes while its row waits: made, but not saved.
  await tx.contentCalendar.update({ where: { id: campaignItems[1]!.calendarDayId! }, data: { scheduledDate: new Date(today.getTime() - 86_400_000) } });
  const late = await batches.runNextBatchItem(tx, campaign.batchId, deps);
  const lateItem = (await tx.posterStudioBatchItem.findUnique({ where: { id: campaignItems[1]!.id } }))!;
  t('a day that passed in the meantime keeps the image but is not given it', late?.kind === 'failed' && lateItem.generationId !== null && lateItem.posterVersionId === null && /not saved to day 2/.test(lateItem.error ?? ''), lateItem.error ?? '');
  t('…and no version was added to that day', (await tx.posterVersion.count({ where: { calendarDayId: campaignItems[1]!.calendarDayId! } })) === 0);

  // =======================================================================
  section('stop, retry, discard, and the cron sweep');
  // =======================================================================
  const third = await batches.createStudioBatch(
    tx,
    { name: 'Third', target: 'STUDIO', clientId: null, campaignId: null, defaults: { aspectRatio: '9:16', quality: 'low', textFree: false, festival: null }, brandIdentity: true, fileName: null, rows: [row(1, 'a', 'One'), row(2, 'b', 'Two'), row(3, 'c', 'Three')] },
    deps,
  );
  t('no client means no branding, even when asked', (await tx.posterStudioBatch.findUnique({ where: { id: third.batchId } }))!.overlayElements.length === 0);
  await batches.startStudioBatch(tx, third.batchId, deps);
  const cancelled = await batches.cancelStudioBatch(tx, third.batchId, deps);
  t('stopping releases the queued rows', cancelled.released === 3 && (await statusOf(third.batchId)) === 'CANCELLED');
  t('a cancelled batch offers nothing to claim', (await batches.claimBatchItem(tx, clock)) === null);
  const again = await batches.retryStudioBatch(tx, third.batchId);
  t('retry on a stopped batch queues the unmade rows', again.queued === 3 && (await statusOf(third.batchId)) === 'RUNNING');

  const before = requests.length;
  const sweep = await batches.runQueuedStudioBatchItemsExclusively(tx, { budgetMs: 60_000, limit: 2, concurrency: 1 }, deps);
  t('the cron runner makes at most its limit', sweep.generated === 2 && requests.length - before === 2 && !sweep.lockHeld, JSON.stringify(sweep));
  const rest = await batches.runQueuedStudioBatchItemsExclusively(tx, { budgetMs: 60_000, limit: 5, concurrency: 2 }, deps);
  t('…and the next sweep finishes the batch', rest.generated === 1 && (await statusOf(third.batchId)) === 'DONE', JSON.stringify(rest));

  const draft = await batches.createStudioBatch(
    tx,
    { name: 'Draft', target: 'STUDIO', clientId: null, campaignId: null, defaults: { aspectRatio: '9:16', quality: null, textFree: false, festival: null }, brandIdentity: false, fileName: null, rows: [row(1, 'x', 'Only')] },
    deps,
  );
  await batches.deleteDraftStudioBatch(tx, draft.batchId);
  t('a draft can be discarded, rows and all', (await tx.posterStudioBatch.count({ where: { id: draft.batchId } })) === 0 && (await tx.posterStudioBatchItem.count({ where: { batchId: draft.batchId } })) === 0);
  await expectBatchError('a started batch cannot be discarded', () => batches.deleteDraftStudioBatch(tx, third.batchId), /draft/);

  const estimate = await batches.estimateStudioBatchCost(tx, 50);
  t('the estimate never invents a price', estimate.images === 50 && (estimate.pricingConfigured || estimate.totalMicros === null), JSON.stringify(estimate));

  t('zero network attempts', networkAttempts === 0, String(networkAttempts));
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tables = ['Client', 'Campaign', 'ContentCalendar', 'PosterVersion', 'PosterStudioGeneration', 'PosterStudioBatch', 'PosterStudioBatchItem', 'UsageEvent'] as const;
  const countAll = async (db: PrismaClient) =>
    Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [table, Number((await db.$queryRawUnsafe<[{ count: bigint }]>(`SELECT COUNT(*)::bigint AS count FROM "${table}"`))[0]!.count)] as const),
      ),
    );

  const before = await countAll(realPrisma);
  try {
    await realPrisma.$transaction(
      async (transaction) => {
        activeTx = transaction;
        await suite();
        throw new Rollback('rolling back the check transaction');
      },
      { timeout: 600_000, maxWait: 20_000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) {
      console.error('\nFAIL suite threw:', error);
      bad += 1;
    }
  } finally {
    activeTx = null;
  }
  const after = await countAll(realPrisma);
  t('the database is exactly as it was found', tables.every((table) => before[table] === after[table]), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);

  await realPrisma.$disconnect();
  console.log(`\n${bad === 0 ? 'All bulk studio database checks passed.' : `${bad} check(s) FAILED.`}`);
  process.exit(bad === 0 ? 0 : 1);
}

void main();
