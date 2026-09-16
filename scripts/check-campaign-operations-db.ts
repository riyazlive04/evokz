/**
 * Database checks for campaign operations and reliability (Phase 7).
 *
 * Runs the server-side generation queue and its cron worker, the campaign
 * health/needs-attention read model, per-campaign cost accounting, the
 * deterministic delivery spread and the Phase 7 authorization scoping against
 * the development database.
 *
 * **No provider is reachable.** The image model, Drive and WhatsApp are all
 * in-process fakes and `fetch` is disabled and counted, so the suite asserts
 * zero network attempts.
 *
 * How it stays harmless (the `check:campaign-posters-db` technique):
 *   - `globalThis.prisma` is a facade over ONE interactive transaction that is
 *     always rolled back, with SAVEPOINTs for nested transactions; table row
 *     counts are compared before and after.
 *   - Provider credentials are blanked.
 *   - Refuses to run unless DATABASE_URL is a local development database.
 *
 * Run: npm run check:campaign-operations-db
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { Prisma, PrismaClient } from '@prisma/client';
import sharp from 'sharp';

(globalThis as unknown as { AsyncLocalStorage: typeof AsyncLocalStorage }).AsyncLocalStorage = AsyncLocalStorage;

for (const key of ['OPENAI_API_KEY', 'FAL_KEY', 'EVOLUTION_API_KEY', 'EVOLUTION_API_URL', 'GOOGLE_PRIVATE_KEY', 'GOOGLE_SERVICE_ACCOUNT_EMAIL']) {
  process.env[key] = '';
}
let networkAttempts = 0;
globalThis.fetch = (async () => {
  networkAttempts += 1;
  throw new Error('network disabled by check:campaign-operations-db');
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
const snapshot = (value: unknown) => JSON.stringify(value);

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

type AsyncStorage = { run<T>(store: object, fn: () => T): T };
let requestStore: AsyncStorage;
async function asAction<T>(work: () => Promise<T>): Promise<T> {
  return requestStore.run({ incrementalCache: {}, urlPathname: '/admin/check', isStaticGeneration: false }, work);
}

// ---------------------------------------------------------------------------

async function suite(): Promise<void> {
  const tx = facade;
  const { SAMPLE_LAYOUT_SPEC } = await import('@/lib/poster/sample-layout');
  const service = await import('@/lib/campaign/service');
  const mapping = await import('@/lib/campaign/template-mapping-service');
  const posters = await import('@/lib/campaign/poster-generation-service');
  const queue = await import('@/lib/campaign/generation-queue');
  const operations = await import('@/lib/campaign/operations');
  const delivery = await import('@/lib/campaign/delivery-service');
  const review = await import('@/lib/campaign/review-service');
  const campaignActions = await import('@/app/admin/campaigns/actions');
  const { StudioError } = await import('@/lib/poster-studio/errors');
  const { prepareStudioInputImage, readStudioImageSize } = await import('@/lib/poster-studio/images');
  const { recordOpenAiImageUsage } = await import('@/lib/usage');
  const { loadStudioBrandCanvas } = await import('@/lib/poster-studio/brand-context');
  const { startOfZonedDay } = await import('@/lib/time');
  const { deliveryInstant, deliverySpreadSeconds } = await import('@/lib/campaign/delivery');
  const { CampaignDomainError, changeCampaignStatus, createCampaign, updateCampaignDayContent } = service;
  type Deps = import('@/lib/campaign/poster-generation-service').PosterGenerationDeps;

  const TZ = 'Asia/Kolkata';
  const NOW = new Date();
  const today = startOfZonedDay(NOW, TZ);
  const noHtml = { htmlAspectFor: async () => null };
  const load = { ...noHtml, timeZone: TZ, now: NOW };

  async function expectDomainError(name: string, code: string, work: () => Promise<unknown>) {
    try {
      await work();
      t(name, false, 'succeeded but should have failed');
    } catch (error) {
      t(name, error instanceof CampaignDomainError && error.code === code, error instanceof Error ? error.message : String(error));
    }
  }

  // ---- Fakes -------------------------------------------------------------------
  const png = (width: number, height: number, color: string) => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
  const templatePng = await png(540, 960, '#3366aa');
  const drive = new Map<string, Buffer>();
  let fileCounter = 0;
  /** Every prompt the fake model was asked to render, newest last. */
  const prompts: string[] = [];
  /** Highest number of renders in flight at once, for the concurrency check. */
  let inFlight = 0;
  let peakInFlight = 0;
  let failNextRender: Error | null = null;

  const deps: Deps = {
    assertConfigured: () => undefined,
    loadBrandCanvas: loadStudioBrandCanvas,
    prepareOverlay: async (canvas, selection, aspectRatio) =>
      ({ preset: 'footer-band', aspectRatio, theme: null, fonts: [], logo: null, logoInk: null, name: canvas.companyName, tagline: canvas.tagline, website: canvas.website, phone: canvas.phone, footerBackground: selection.footerBackground, drawn: ['name', ...selection.elements] }) as unknown as Awaited<ReturnType<Deps['prepareOverlay']>>,
    compose: async (raw, plan) => ({ bytes: await sharp(raw).composite([{ input: await png(1152, 240, '#111111'), left: 0, top: 1808 }]).png().toBuffer(), mimeType: 'image/png', drawn: plan.drawn, footerTone: 'DARK' }),
    resolveFolder: async () => 'fixture-folder',
    readFile: async (fileId) => {
      if (!fileId.startsWith('fixture-template')) throw new StudioError('storage', 'Could not load the image from Google Drive.');
      return templatePng;
    },
    prepareReference: prepareStudioInputImage,
    render: async (request) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        // A beat, so overlapping workers genuinely overlap.
        await new Promise((resolve) => setTimeout(resolve, 12));
        if (failNextRender) {
          const failure = failNextRender;
          failNextRender = null;
          throw failure;
        }
        prompts.push(request.prompt);
        const [width, height] = request.size.split('x').map(Number) as [number, number];
        return { bytes: await png(width, height, '#88ccbb'), mimeType: 'image/png', model: 'gpt-image-2', quality: 'low', usage: { textInputTokens: 120, imageInputTokens: 880, outputTokens: 4200 } };
      } finally {
        inFlight -= 1;
      }
    },
    recordUsage: recordOpenAiImageUsage,
    readImageSize: readStudioImageSize,
    store: async ({ body }) => {
      const id = `fake-drive-${(fileCounter += 1)}`;
      drive.set(id, body);
      return id;
    },
    trash: async (ids) => {
      for (const id of ids) drive.delete(id);
    },
  };

  // ---- Fixtures ----------------------------------------------------------------
  const plan = await tx.plan.create({ data: { name: 'check:ops 20', durationDays: 20 } });
  const vertical = await tx.category.create({
    data: { name: 'check:ops Vertical', contentStrategy: { pillars: [{ key: 'educational', label: 'Educational', weight: 2, guidance: 'Teach.' }, { key: 'tips', label: 'Tips', weight: 1, guidance: 'Advise.' }] } },
  });
  const portrait = { ...SAMPLE_LAYOUT_SPEC, aspect: 9 / 16 } as unknown as Prisma.InputJsonValue;
  for (const [label, order] of [['A', 1], ['B', 2]] as const) {
    await tx.categoryTemplate.create({
      data: { categoryId: vertical.id, label: `check:ops ${label}`, gDriveFileId: `fixture-template-${label}`, gDriveViewUrl: 'https://drive.invalid/t', mimeType: 'image/png', width: 1080, height: 1920, layoutSpec: portrait, layoutApprovedAt: new Date(), createdAt: new Date(Date.parse('2026-01-01') + order * 1000) },
    });
  }

  const brand = { colors: [{ hex: '#0e7c86', role: 'primary' }], typography: null, layoutDirectives: [], assets: [] };
  const makeClient = (name: string, data: Partial<Prisma.ClientUncheckedCreateInput> = {}) =>
    tx.client.create({
      data: { companyName: `check:ops ${name}`, whatsappNumber: '919876500777', startDate: today, endDate: today, planId: plan.id, categoryId: vertical.id, isDemo: true, isActive: false, imageSizePreset: 'whatsapp-status', brandGuideline: brand, brandTagline: 'Care', websiteUrl: 'ops-fixture.invalid', gDriveFolderId: 'SECRET-OPS-FOLDER', ...data },
    });

  async function readyCampaign(clientId: string, options: { generationWindowDays?: number } = {}) {
    const { campaignId } = await createCampaign(tx, { clientId, name: 'Ops', startDate: today, timeZone: TZ });
    for (const day of await tx.contentCalendar.findMany({ where: { campaignId }, orderBy: { dayNumber: 'asc' } })) {
      await tx.contentCalendar.update({
        where: { id: day.id },
        data: { theme: `Topic ${day.dayNumber}`, contentType: day.dayNumber % 3 === 0 ? 'tips' : 'educational', headline: `Headline ${day.dayNumber}`, supportingText: `Supporting ${day.dayNumber}.`, cta: 'Book a visit', caption: 'Caption', hashtags: '#care', imagePrompt: `Scene ${day.dayNumber}.`, contentStatus: 'READY', contentRevision: { increment: 1 } },
      });
    }
    const preview = await mapping.previewAutoMap(tx, campaignId, noHtml);
    await mapping.applyAutoMap(tx, campaignId, { ...noHtml, fingerprint: preview.plan.fingerprint });
    if (options.generationWindowDays) {
      await tx.campaign.update({ where: { id: campaignId }, data: { generationWindowDays: options.generationWindowDays } });
    }
    await changeCampaignStatus(tx, campaignId, 'ACTIVE');
    return campaignId;
  }

  const clientA = await makeClient('Clinic');
  const campaignId = await readyCampaign(clientA.id, { generationWindowDays: 6 });
  const dayRow = async (n: number) => (await service.findCampaignDay(tx, campaignId, n))!;
  const statusOf = async (n: number) => (await dayRow(n)).generationStatus;

  // =======================================================================
  section('queueing is instant and spends nothing');
  // =======================================================================
  {
    const before = prompts.length;
    const outcome = await queue.queueCampaignPosters(tx, campaignId, { mode: 'upcoming' }, load);
    t('every eligible window day is queued', outcome.queued.length === 6, snapshot(outcome.queued));
    t('nothing was generated by queueing', prompts.length === before);
    t('the days are QUEUED in the database', (await tx.contentCalendar.count({ where: { campaignId, generationStatus: 'QUEUED' } })) === 6);
    t('no poster version exists yet', (await tx.posterVersion.count({ where: { calendarDay: { campaignId } } })) === 0);

    const again = await queue.queueCampaignPosters(tx, campaignId, { mode: 'upcoming' }, load);
    t('queueing twice queues nothing new', again.queued.length === 0);
    t('…and reports what is already waiting', again.alreadyQueued.length === 6);
    t('…and still leaves exactly six queued', (await tx.contentCalendar.count({ where: { campaignId, generationStatus: 'QUEUED' } })) === 6);

    // An interactive generate must leave a queued day to the queue.
    const queuedDay = await dayRow(1);
    const interactive = await posters.generateCampaignDayPoster(tx, campaignId, queuedDay.id, { ...load, mode: 'regenerate', explicit: true, deps });
    t('an interactive request will not steal a queued day', interactive.outcome === 'skipped' && interactive.reason === 'generating', snapshot(interactive));
  }

  // =======================================================================
  section('the worker drains the queue, bounded');
  // =======================================================================
  {
    const sweep = await queue.runQueuedCampaignGenerations(tx, { ...load, deps, limit: 3, concurrency: 1 });
    t('the sweep generates only up to its limit', sweep.generated.length === 3, snapshot(sweep.generated));
    t('…and claims exactly those', sweep.claimed === 3);
    t('generated days are SUCCEEDED', (await statusOf(1)) === 'SUCCEEDED');
    t('un-swept days stay QUEUED for the next tick', (await tx.contentCalendar.count({ where: { campaignId, generationStatus: 'QUEUED' } })) === 3);
    t('each generated day has exactly one version', (await tx.posterVersion.count({ where: { calendarDay: { campaignId } } })) === 3);

    peakInFlight = 0;
    const rest = await queue.runQueuedCampaignGenerations(tx, { ...load, deps, limit: 10, concurrency: 1 });
    t('a second sweep finishes the queue', rest.generated.length === 3);
    t('concurrency 1 runs one render at a time', peakInFlight === 1, String(peakInFlight));
    t('the queue is now empty', (await tx.contentCalendar.count({ where: { campaignId, generationStatus: 'QUEUED' } })) === 0);
    t('exactly six posters exist — no duplicates', (await tx.posterVersion.count({ where: { calendarDay: { campaignId } } })) === 6);

    const empty = await queue.runQueuedCampaignGenerations(tx, { ...load, deps });
    t('an empty queue does nothing and calls nothing', empty.claimed === 0 && empty.generated.length === 0);
  }

  // =======================================================================
  section('a second batch queues and drains without duplicating');
  // =======================================================================
  {
    /*
     * Concurrency itself is pinned in `check:campaign-operations`, not here:
     * this whole suite runs inside ONE Prisma interactive transaction, which
     * cannot serve two queries at once, so a concurrency above 1 would fail on
     * the harness rather than on the code. What matters at this level is that
     * a second batch re-queues cleanly and produces exactly one new version per
     * day.
     */
    const versionsBefore = await tx.posterVersion.count({ where: { calendarDay: { campaignId } } });
    const queued = await queue.queueCampaignPosters(tx, campaignId, { mode: 'regenerate', fromDay: 1, toDay: 4 }, load);
    t('an explicit range queues its days again', queued.queued.length === 4, snapshot(queued.queued));

    const sweep = await queue.runQueuedCampaignGenerations(tx, { ...load, deps, limit: 4, concurrency: 1 });
    t('the sweep regenerates all four', sweep.generated.length === 4, snapshot(sweep.generated));
    t('…adding exactly one version each', (await tx.posterVersion.count({ where: { calendarDay: { campaignId } } })) === versionsBefore + 4);

    await queue.cancelQueuedGeneration(tx, campaignId);
    t('cancelling withdraws the days no worker took', (await tx.contentCalendar.count({ where: { campaignId, generationStatus: 'QUEUED' } })) === 0);
  }

  // =======================================================================
  section('two workers cannot take the same day');
  // =======================================================================
  {
    const day = await dayRow(7);
    await tx.contentCalendar.update({ where: { id: day.id }, data: { generationStatus: 'QUEUED', errorMessage: null } });

    const before = prompts.length;
    /*
     * Two sweeps cannot literally race here — one Prisma interactive
     * transaction serialises its queries — so the race is reproduced the way it
     * actually resolves: the first worker takes the day, and the second meets
     * the row in the state the first left it in. That is exactly what the
     * conditional claim has to survive.
     */
    const first = await queue.runQueuedCampaignGenerations(tx, { ...load, deps, limit: 1, concurrency: 1 });
    t('the first worker takes the queued day', first.generated.some((entry) => entry.dayNumber === 7), snapshot(first.generated));

    const second = await queue.runQueuedCampaignGenerations(tx, { ...load, deps, limit: 5, concurrency: 1 });
    t('the second worker finds nothing left to claim', !second.generated.some((entry) => entry.dayNumber === 7));
    t('only one render was paid for', prompts.length === before + 1, `${prompts.length - before} renders`);
    t('…and the day has exactly one version', (await tx.posterVersion.count({ where: { calendarDayId: day.id } })) === 1);

    // And a worker meeting a day another worker is mid-way through is refused
    // by the claim itself, not by luck of timing.
    await tx.contentCalendar.update({ where: { id: day.id }, data: { generationStatus: 'GENERATING', posterGenerationStartedAt: NOW } });
    const contended = await posters.generateCampaignDayPoster(tx, campaignId, day.id, { ...load, mode: 'regenerate', explicit: true, acceptQueued: true, deps });
    t('a day held by a live claim is refused', contended.outcome === 'skipped', snapshot(contended));
    t('…and no extra render was paid for', prompts.length === before + 1);
    await tx.contentCalendar.update({ where: { id: day.id }, data: { generationStatus: 'SUCCEEDED', posterGenerationStartedAt: null } });
  }

  // =======================================================================
  section('a crashed attempt is recoverable');
  // =======================================================================
  {
    const day = await dayRow(8);
    // A worker that died mid-flight: GENERATING, claim older than the stale window.
    await tx.contentCalendar.update({
      where: { id: day.id },
      data: { generationStatus: 'GENERATING', posterGenerationStartedAt: new Date(NOW.getTime() - 20 * 60_000) },
    });

    const stranded = await queue.runQueuedCampaignGenerations(tx, { ...load, deps, limit: 5 });
    t('the stale claim is recovered and generated', stranded.generated.some((entry) => entry.dayNumber === 8), snapshot(stranded.generated));
    t('…and the day settles SUCCEEDED', (await statusOf(8)) === 'SUCCEEDED');

    // A fresh claim is left strictly alone.
    const live = await dayRow(9);
    await tx.contentCalendar.update({ where: { id: live.id }, data: { generationStatus: 'GENERATING', posterGenerationStartedAt: NOW } });
    const untouched = await queue.runQueuedCampaignGenerations(tx, { ...load, deps, limit: 5 });
    t('a live claim is never stolen', !untouched.generated.some((entry) => entry.dayNumber === 9));
    t('…and it is still GENERATING', (await statusOf(9)) === 'GENERATING');
    await tx.contentCalendar.update({ where: { id: live.id }, data: { generationStatus: 'NOT_REQUESTED', posterGenerationStartedAt: null } });
  }

  // =======================================================================
  section('pause stops the queue; resume continues it');
  // =======================================================================
  {
    await queue.queueCampaignPosters(tx, campaignId, { mode: 'regenerate', fromDay: 1, toDay: 5 }, load);
    const queuedCount = await tx.contentCalendar.count({ where: { campaignId, generationStatus: 'QUEUED' } });
    t('days are queued while active', queuedCount > 0, String(queuedCount));

    await changeCampaignStatus(tx, campaignId, 'PAUSED');
    const before = prompts.length;
    const paused = await queue.runQueuedCampaignGenerations(tx, { ...load, deps, limit: 5 });
    t('a paused campaign generates nothing', paused.generated.length === 0 && prompts.length === before);
    t('…and its queued days are untouched', (await tx.contentCalendar.count({ where: { campaignId, generationStatus: 'QUEUED' } })) === queuedCount);

    await expectDomainError('queueing is refused while paused', 'invalid-transition', () =>
      queue.queueCampaignPosters(tx, campaignId, { mode: 'upcoming' }, load),
    );

    await changeCampaignStatus(tx, campaignId, 'ACTIVE');
    const resumed = await queue.runQueuedCampaignGenerations(tx, { ...load, deps, limit: 2 });
    t('resuming lets the same queued days continue', resumed.generated.length === 2, snapshot(resumed.generated));
    t('…with no duplicate versions', (await tx.posterVersion.count({ where: { calendarDay: { campaignId }, versionNumber: { gt: 4 } } })) === 0);
    await queue.cancelQueuedGeneration(tx, campaignId);
  }

  // =======================================================================
  section('rejection context reaches the next attempt, and only that');
  // =======================================================================
  {
    const day = await dayRow(1);
    const versionId = day.activePosterVersionId!;
    await review.rejectCampaignDayPoster(tx, day.id, versionId, {
      reason: 'branding-issue',
      detail: 'the logo sits over the headline',
    });

    const before = prompts.length;
    const result = await posters.generateCampaignDayPoster(tx, campaignId, day.id, { ...load, mode: 'regenerate', explicit: true, deps });
    t('a rejected day regenerates', result.outcome === 'generated', snapshot(result));
    const prompt = prompts.at(-1)!;
    t('the new prompt carries the reviewer’s reason', /rejected in review/.test(prompt) && /logo sits over the headline/.test(prompt));
    t('…and tells the model not to repeat it', /do not repeat it/i.test(prompt));
    t('the day content is still in the prompt', /Headline 1/.test(prompt));
    t('no identifier leaked into the prompt', !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(prompt) && !/fake-drive|SECRET-OPS-FOLDER/.test(prompt));
    t('the rejected version is untouched', (await tx.posterVersion.findUniqueOrThrow({ where: { id: versionId } })).approvalStatus === 'REJECTED');
    t('the new version is pending, not auto-approved', (await tx.posterVersion.findUniqueOrThrow({ where: { id: (await dayRow(1)).activePosterVersionId! } })).approvalStatus === 'PENDING');
    void before;

    // A second regeneration of the now-pending poster must not resurface it.
    const second = await posters.generateCampaignDayPoster(tx, campaignId, day.id, { ...load, mode: 'regenerate', explicit: true, deps });
    t('regenerating a non-rejected poster carries no rejection text', second.outcome === 'generated' && !/rejected in review/.test(prompts.at(-1)!));

    // An approved poster's history is never sent either.
    const day2 = await dayRow(2);
    await posters.approveCampaignDayPoster(tx, day2.id, day2.activePosterVersionId!);
    await posters.generateCampaignDayPoster(tx, campaignId, day2.id, { ...load, mode: 'regenerate', explicit: true, deps });
    t('an approved poster contributes no rejection text', !/rejected in review/.test(prompts.at(-1)!));
  }

  // =======================================================================
  section('cost is attributed to the campaign');
  // =======================================================================
  {
    const usage = await operations.loadCampaignUsage(tx, campaignId);
    const generations = await tx.usageEvent.count({ where: { provider: 'OPENAI', calendarId: { in: (await tx.contentCalendar.findMany({ where: { campaignId }, select: { id: true } })).map((day) => day.id) } } });
    t('every generation is billed to a day of this campaign', usage.generations === generations && usage.generations > 0, `${usage.generations}`);
    t('token counts are recorded exactly', usage.inputTokens === usage.generations * 1000 && usage.outputTokens === usage.generations * 4200, snapshot({ input: usage.inputTokens, output: usage.outputTokens }));

    // With the image rates unset, a row is "not priced" — never silently free.
    t('image pricing is reported as unconfigured', usage.pricingConfigured === false);
    t('…and every generation is counted as unpriced', usage.unpriced === usage.generations, `${usage.unpriced} of ${usage.generations}`);
    t('…so the estimated cost is zero rather than invented', usage.costUsdMicros === 0);

    // Configure the rates and a new call prices itself at write time.
    process.env.PRICE_OPENAI_IMAGE_TEXT_INPUT_PER_MTOK = '5';
    process.env.PRICE_OPENAI_IMAGE_IMAGE_INPUT_PER_MTOK = '10';
    process.env.PRICE_OPENAI_IMAGE_OUTPUT_PER_MTOK = '40';
    const day = await dayRow(3);
    await posters.generateCampaignDayPoster(tx, campaignId, day.id, { ...load, mode: 'regenerate', explicit: true, deps });
    const priced = await operations.loadCampaignUsage(tx, campaignId);
    t('configuring the rates prices new calls', priced.costUsdMicros > 0, `${priced.costUsdMicros} micros`);
    t('…and pricing now reports as configured', priced.pricingConfigured === true);
    t('…while the earlier unpriced rows are still reported', priced.unpriced === usage.generations);

    // 120 text + 880 image + 4200 output at 5/10/40 per Mtok.
    const expected = Math.round(((120 / 1e6) * 5 + (880 / 1e6) * 10 + (4200 / 1e6) * 40) * 1e6);
    t('the priced amount matches the rate card exactly', priced.costUsdMicros === expected, `${priced.costUsdMicros} vs ${expected}`);

    delete process.env.PRICE_OPENAI_IMAGE_TEXT_INPUT_PER_MTOK;
    delete process.env.PRICE_OPENAI_IMAGE_IMAGE_INPUT_PER_MTOK;
    delete process.env.PRICE_OPENAI_IMAGE_OUTPUT_PER_MTOK;

    const otherCampaign = await readyCampaign((await makeClient('Neighbour')).id);
    const otherUsage = await operations.loadCampaignUsage(tx, otherCampaign);
    t("another campaign's usage is zero — attribution is per campaign", otherUsage.generations === 0 && otherUsage.costUsdMicros === 0);
  }

  // =======================================================================
  section('campaign health and the needs-attention queue');
  // =======================================================================
  {
    const health = await operations.loadCampaignHealth(tx, campaignId, { now: NOW, timeZone: TZ });
    t('content is counted across the whole campaign', health.content.done === 20 && health.content.total === 20, snapshot(health.content));
    t('templates are counted across the whole campaign', health.templates.total === 20 && health.templates.unmapped === 0);
    t('posters are counted across the window only', health.posters.total === 6, String(health.posters.total));
    t('the health numbers agree with the rows', health.posters.approved + health.posters.needsApproval + health.posters.rejected + health.posters.outdated <= health.posters.total);

    // Break one thing of each kind and confirm each is surfaced.
    // Inside the rolling window: a failure on a day nobody is generating yet is
    // not a blocker, which the pure suite pins separately.
    const failedDay = await dayRow(6);
    await tx.contentCalendar.update({
      where: { id: failedDay.id },
      data: { generationStatus: 'FAILED', errorMessage: 'The model refused it.', activePosterVersionId: null },
    });
    const outdatedDay = await dayRow(4);
    await updateCampaignDayContent(tx, outdatedDay.id, { headline: 'Changed after generation' });

    const after = await operations.loadCampaignHealth(tx, campaignId, { now: NOW, timeZone: TZ });
    const groups = new Set(after.attention.map((item) => item.group));
    t('a failed generation appears in the queue', after.attention.some((item) => item.group === 'POSTER' && item.dayNumber === 6), snapshot(after.attention.slice(0, 4)));
    t('…with its error as the detail', after.attention.find((item) => item.dayNumber === 6 && item.group === 'POSTER')?.detail === 'The model refused it.');
    t('an outdated poster appears in the queue', after.attention.some((item) => item.dayNumber === 4 && item.group === 'POSTER'));
    t('an unapproved poster appears as APPROVAL', groups.has('APPROVAL'));
    t('every item links into a filter on the page', after.attention.every((item) => item.href.startsWith('?review=') || item.href.startsWith('?delivery=')));
    t('the health payload carries no Drive id', !snapshot(after).includes('fake-drive-') && !snapshot(after).includes('SECRET-OPS-FOLDER'));

    // The client-page counts must agree with the queue they link to.
    const attention = await operations.loadClientCampaignAttention(tx, clientA.id, { now: NOW, timeZone: TZ });
    const summary = attention.get(campaignId)!;
    t('the client page counts the same failures', summary.failed === 1, snapshot(summary));
    t('…and the same outdated posters', summary.outdated === 1);
    t('…and its attention total is the sum of what needs doing', summary.attention >= summary.failed + summary.outdated + summary.rejected);
    t('every campaign of the client gets a summary', attention.size === 1 && attention.has(campaignId), String(attention.size));
  }

  // =======================================================================
  section('the delivery spread');
  // =======================================================================
  {
    // Approve a couple of days so they can be booked.
    for (const n of [2, 3]) {
      const day = await dayRow(n);
      if (day.activePosterVersionId) await posters.approveCampaignDayPoster(tx, day.id, day.activePosterVersionId);
    }
    await delivery.scheduleCampaignDeliveries(tx, campaignId, delivery.defaultDeliveryDeps({ timeZone: TZ, now: () => NOW, whatsappConfigured: () => true, mediaConfigured: () => true }));

    const booked = await tx.campaignDelivery.findMany({ where: { campaignId }, select: { calendarDayId: true, scheduledFor: true } });
    t('deliveries were booked', booked.length >= 2, String(booked.length));

    for (const row of booked) {
      const day = await tx.contentCalendar.findUniqueOrThrow({ where: { id: row.calendarDayId }, select: { scheduledDate: true } });
      const base = deliveryInstant(day.scheduledDate, '09:00', TZ);
      const offset = (row.scheduledFor.getTime() - base.getTime()) / 1000;
      t(`a booking is spread past its nominal time (${offset}s)`, offset >= 0 && offset < 600);
      t('…by exactly the deterministic offset for that day', offset === deliverySpreadSeconds(row.calendarDayId));
    }

    // Rebooking must not move an existing booking.
    const firstBooking = booked[0]!;
    await delivery.scheduleCampaignDeliveries(tx, campaignId, delivery.defaultDeliveryDeps({ timeZone: TZ, now: () => NOW, whatsappConfigured: () => true, mediaConfigured: () => true }));
    const rebooked = await tx.campaignDelivery.findUniqueOrThrow({ where: { calendarDayId: firstBooking.calendarDayId } });
    t('reconciling does not move a booking', rebooked.scheduledFor.getTime() === firstBooking.scheduledFor.getTime());
  }

  // =======================================================================
  section('authorization scoping (Phase 7)');
  // =======================================================================
  {
    const otherClient = await makeClient('Other tenant');
    const otherCampaign = await readyCampaign(otherClient.id);
    const otherDay = (await service.findCampaignDay(tx, otherCampaign, 1))!;
    const ourDay = await dayRow(5);

    const crossedSend = await asAction(() => campaignActions.sendCampaignDayNowAction(campaignId, otherDay.id));
    t("another campaign's day cannot be sent through this campaign", !crossedSend.ok && /not part of this campaign/i.test(crossedSend.ok ? '' : crossedSend.error));

    const crossedCancel = await asAction(() => campaignActions.cancelCampaignDeliveryAction(campaignId, otherDay.id));
    t('…nor cancelled through it', !crossedCancel.ok);

    const crossedRetry = await asAction(() => campaignActions.retryCampaignDeliveryAction(campaignId, otherDay.id));
    t('…nor rescheduled through it', !crossedRetry.ok);

    const ownDay = await asAction(() => campaignActions.cancelCampaignDeliveryAction(campaignId, ourDay.id));
    t('a day of this campaign is still accepted', ownDay.ok || /nothing to cancel/i.test(ownDay.ok ? '' : ownDay.error));

    const badCampaign = await asAction(() => campaignActions.sendCampaignDayNowAction('not-a-uuid', ourDay.id));
    t('a malformed campaign id is rejected', !badCampaign.ok);

    const queuedElsewhere = await asAction(() => campaignActions.queueCampaignPostersAction(otherCampaign, { mode: 'upcoming' }));
    t('queueing is scoped to the campaign it names', queuedElsewhere.ok);
    t("…and did not touch this campaign's days", (await tx.contentCalendar.count({ where: { campaignId, generationStatus: 'QUEUED' } })) === 0);
    await queue.cancelQueuedGeneration(tx, otherCampaign);
  }

  // =======================================================================
  section('isolation and hygiene');
  // =======================================================================
  {
    const { LEGACY_CALENDAR } = await import('@/lib/calendar-scope');
    t('legacy scope still excludes campaign days', (await tx.contentCalendar.count({ where: { ...LEGACY_CALENDAR, clientId: clientA.id } })) === 0);

    const legacyColumns = await tx.contentCalendar.findMany({
      where: { campaignId },
      select: { deliveryStatus: true, sendAfter: true, approvedAt: true, gDriveFileId: true },
    });
    t('the generation queue writes no legacy delivery column', legacyColumns.every((day) => day.deliveryStatus === 'PENDING' && day.sendAfter === null && day.approvedAt === null && day.gDriveFileId === null));

    t('zero network attempts (no OpenAI, no Evolution, no Drive)', networkAttempts === 0, String(networkAttempts));
    t('no WhatsApp message was recorded', (await tx.usageEvent.count({ where: { provider: 'EVOLUTION' } })) === 0);
    t('no prompt ever contained a credential or Drive reference', !prompts.some((prompt) => /SECRET-OPS-FOLDER|fake-drive|sk-|apikey/i.test(prompt)));
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { staticGenerationAsyncStorage } = await import(
    'next/dist/client/components/static-generation-async-storage.external.js'
  );
  requestStore = staticGenerationAsyncStorage as unknown as AsyncStorage;

  const tables = ['Client', 'Campaign', 'ContentCalendar', 'PosterVersion', 'PosterStudioGeneration', 'CampaignDelivery', 'UsageEvent'] as const;
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
      { timeout: 900_000, maxWait: 20_000 },
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
  const unchanged = tables.every((table) => before[table] === after[table]);
  t('the database is exactly as it was found', unchanged, `${snapshot(before)} → ${snapshot(after)}`);

  await realPrisma.$disconnect();
  console.log(`\n${bad === 0 ? 'All campaign operations database checks passed.' : `${bad} check(s) FAILED.`}`);
  process.exit(bad === 0 ? 0 : 1);
}

void main();
