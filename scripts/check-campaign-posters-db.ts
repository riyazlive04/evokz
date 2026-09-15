/**
 * Database checks for rolling campaign poster generation (Phase 4).
 *
 * Runs `src/lib/campaign/poster-generation-service.ts` — eligibility, batch
 * planning, claiming, generation, versioning, approval, Poster Studio saves — and
 * the Phase 4 server actions against the development database. The image model,
 * Google Drive and the font-dependent overlay are replaced by in-process fakes
 * (`PosterGenerationDeps`); the prompt builder, reference preparation, decode
 * check, usage ledger, studio rows and versions are the real ones.
 *
 * How it stays harmless (the `check:calendar-scope` technique, plus savepoints):
 *   - `globalThis.prisma` is a facade over ONE interactive transaction that is
 *     always rolled back; table row counts are compared before and after. Nested
 *     `$transaction` calls run inside a SAVEPOINT, so a failure mid-way rolls
 *     back exactly as it would in production.
 *   - `fetch` is stubbed and counted, provider credentials are blanked, and the
 *     suite asserts zero network attempts (so: no OpenAI, no WhatsApp).
 *   - Refuses to run unless DATABASE_URL is a local development database.
 *
 * Run: npm run check:campaign-posters-db
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
  throw new Error('network disabled by check:campaign-posters-db');
}) as typeof fetch;

let databaseLabel = '';
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
  databaseLabel = `${database} @ ${host}`;
  console.log(`database: ${databaseLabel}`);
}

let bad = 0;
const t = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) bad += 1;
};
const section = (title: string) => console.log(`\n--- ${title} ${'-'.repeat(Math.max(0, 58 - title.length))}`);
const snapshot = (value: unknown) => JSON.stringify(value);

class Rollback extends Error {}

// ---- Transaction facade with savepoints --------------------------------------

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
  const { isVersionCurrent } = await import('@/lib/campaign/model');
  const service = await import('@/lib/campaign/service');
  const mapping = await import('@/lib/campaign/template-mapping-service');
  const posters = await import('@/lib/campaign/poster-generation-service');
  const campaignActions = await import('@/app/admin/campaigns/actions');
  const studioActions = await import('@/app/admin/poster-studio/actions');
  const { LEGACY_CALENDAR } = await import('@/lib/calendar-scope');
  const { StudioError } = await import('@/lib/poster-studio/errors');
  const { prepareStudioInputImage, readStudioImageSize } = await import('@/lib/poster-studio/images');
  const { recordOpenAiImageUsage } = await import('@/lib/usage');
  const { loadStudioBrandCanvas } = await import('@/lib/poster-studio/brand-context');
  const { addZonedDays, startOfZonedDay } = await import('@/lib/time');
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

  // ---- Fakes: image model, Drive, overlay ------------------------------------
  const png = (width: number, height: number, color: string) => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
  const templatePng = await png(540, 960, '#3366aa');
  const drive = new Map<string, { fileName: string; body: Buffer }>();
  const trashed: string[] = [];
  const renders: Array<{ prompt: string; size: string; hasImage: boolean }> = [];
  let renderMode: 'ok' | 'moderation' | 'auth' | 'garbage' = 'ok';
  let storeFailOn: RegExp | null = null;
  let composeFail = false;
  let onCompose: (() => Promise<void>) | null = null;
  let fileCounter = 0;
  /** Requests the fake model refused: no image, so nothing billed or recorded. */
  let renderRefusals = 0;
  let configured = true;

  const deps: Deps = {
    assertConfigured: () => {
      if (!configured) throw new StudioError('config', 'OPENAI_API_KEY is not set on the server.');
    },
    loadBrandCanvas: loadStudioBrandCanvas,
    prepareOverlay: async (canvas, selection, aspectRatio) =>
      ({
        preset: 'footer-band',
        aspectRatio,
        theme: null,
        fonts: [],
        logo: null,
        logoInk: null,
        name: canvas.companyName,
        tagline: canvas.tagline,
        website: canvas.website,
        phone: canvas.phone,
        footerBackground: selection.footerBackground,
        drawn: ['name', ...selection.elements],
      }) as unknown as Awaited<ReturnType<Deps['prepareOverlay']>>,
    compose: async (raw, plan) => {
      await onCompose?.();
      if (composeFail) throw new Error('fake footer failure');
      const bytes = await sharp(raw).composite([{ input: await png(1152, 240, '#111111'), left: 0, top: 1808 }]).png().toBuffer();
      return { bytes, mimeType: 'image/png', drawn: plan.drawn, footerTone: 'DARK' };
    },
    resolveFolder: async () => 'fixture-folder',
    readFile: async (fileId) => {
      if (!fileId.startsWith('fixture-template')) throw new StudioError('storage', 'Could not load the selected image from Google Drive.');
      return templatePng;
    },
    prepareReference: prepareStudioInputImage,
    render: async (request) => {
      renders.push({ prompt: request.prompt, size: request.size, hasImage: Boolean(request.image) });
      if (renderMode === 'moderation' || renderMode === 'auth') renderRefusals += 1;
      if (renderMode === 'moderation') throw new StudioError('moderation', 'OpenAI declined this request under its safety policy.');
      if (renderMode === 'auth') throw new StudioError('auth', 'OpenAI rejected the API key configured on the server.');
      const [width, height] = request.size.split('x').map(Number) as [number, number];
      const bytes = renderMode === 'garbage' ? Buffer.from('not an image at all') : await png(width, height, '#88ccbb');
      return { bytes, mimeType: 'image/png', model: 'gpt-image-2', quality: 'low', usage: { textInputTokens: 100, imageInputTokens: 900, outputTokens: 4000 } };
    },
    recordUsage: recordOpenAiImageUsage,
    readImageSize: readStudioImageSize,
    store: async ({ fileName, body }) => {
      if (storeFailOn?.test(fileName)) throw new StudioError('storage', 'Google Drive did not accept the upload.');
      const id = `fake-drive-${(fileCounter += 1)}`;
      drive.set(id, { fileName, body });
      return id;
    },
    trash: async (ids) => {
      for (const id of ids) {
        trashed.push(id);
        drive.delete(id);
      }
    },
  };

  // ---- Fixtures ----------------------------------------------------------------
  const plan = await tx.plan.create({ data: { name: 'check:posters 30', durationDays: 30 } });
  const vertical = await tx.category.create({
    data: {
      name: 'check:posters Vertical',
      contentStrategy: { pillars: [{ key: 'educational', label: 'Educational', weight: 2, guidance: 'Teach.' }, { key: 'tips', label: 'Tips', weight: 1, guidance: 'Advise.' }] },
    },
  });
  const portrait = { ...SAMPLE_LAYOUT_SPEC, aspect: 9 / 16 } as unknown as Prisma.InputJsonValue;
  let order = 0;
  const template = (label: string, data: Partial<Prisma.CategoryTemplateUncheckedCreateInput> = {}) =>
    tx.categoryTemplate.create({
      data: { categoryId: vertical.id, label: `check:posters ${label}`, gDriveFileId: `fixture-template-${label}`, gDriveViewUrl: 'https://drive.invalid/t', mimeType: 'image/png', width: 1080, height: 1920, layoutSpec: portrait, layoutApprovedAt: new Date(), createdAt: new Date(Date.parse('2026-01-01') + (order += 1) * 1000), ...data },
    });
  const tA = await template('A');
  const tB = await template('B');

  const brand = { colors: [{ hex: '#0e7c86', role: 'primary' }, { hex: '#f4b942', role: 'accent' }], typography: null, layoutDirectives: [], assets: [] };
  const start = addZonedDays(today, -2, TZ);
  const client = (name: string, data: Partial<Prisma.ClientUncheckedCreateInput> = {}) =>
    tx.client.create({
      data: {
        companyName: `check:posters ${name}`,
        whatsappNumber: '919876500321',
        startDate: start,
        endDate: start,
        planId: plan.id,
        categoryId: vertical.id,
        isDemo: true,
        isActive: false,
        imageSizePreset: 'whatsapp-status',
        brandGuideline: brand,
        brandTagline: 'Care you can see',
        websiteUrl: 'clinic-fixture.invalid',
        gDriveFolderId: 'SECRET-CLIENT-FOLDER',
        ...data,
      },
    });
  const clientA = await client('Clinic A');
  const clientAuto = await client('Auto approve');
  const clientNoBrand = await client('No brand', { brandGuideline: Prisma.DbNull });
  const clientPortrait = await client('Four five', { imageSizePreset: 'instagram-portrait' });
  const legacy = await client('Legacy');

  async function readyCampaign(clientId: string, options: { approvalPolicy?: 'AUTO_APPROVE' } = {}) {
    const { campaignId } = await createCampaign(tx, { clientId, name: 'Posters', startDate: start, timeZone: TZ, ...options });
    const days = await tx.contentCalendar.findMany({ where: { campaignId }, orderBy: { dayNumber: 'asc' } });
    for (const day of days) {
      await tx.contentCalendar.update({
        where: { id: day.id },
        data: {
          theme: `Topic ${day.dayNumber}`,
          contentType: day.dayNumber % 3 === 0 ? 'tips' : 'educational',
          headline: `Headline for day ${day.dayNumber}`,
          supportingText: `Supporting text ${day.dayNumber}.`,
          cta: 'Book a visit',
          caption: 'Caption',
          hashtags: '#care',
          imagePrompt: `A bright scene for day ${day.dayNumber}.`,
          contentStatus: 'READY',
          contentRevision: { increment: 1 },
        },
      });
    }
    const preview = await mapping.previewAutoMap(tx, campaignId, noHtml);
    await mapping.applyAutoMap(tx, campaignId, { ...noHtml, fingerprint: preview.plan.fingerprint });
    return campaignId;
  }
  const campaignA = await readyCampaign(clientA.id);
  const dayRow = async (campaignId: string, n: number) => (await service.findCampaignDay(tx, campaignId, n))!;
  const overview = (campaignId: string) => posters.loadPosterOverview(tx, campaignId, load);
  const generate = (campaignId: string, dayId: string, mode: 'missing' | 'upcoming' | 'regenerate', explicit = false) =>
    posters.generateCampaignDayPoster(tx, campaignId, dayId, { ...load, mode, explicit, deps });

  await tx.contentCalendar.create({ data: { clientId: legacy.id, dayNumber: 1, scheduledDate: today, caption: 'Legacy', hashtags: '#l', imagePrompt: 'p', posterTemplateId: tA.id } });
  const legacyBefore = snapshot(await tx.contentCalendar.findMany({ where: { clientId: legacy.id } }));
  const usageBefore = await tx.usageEvent.count();
  const whatsappUsageBefore = await tx.usageEvent.count({ where: { provider: 'EVOLUTION' } });
  const imageUsageBefore = await tx.usageEvent.count({ where: { provider: 'OPENAI' } });

  // =======================================================================
  section('rolling window and a DRAFT campaign');
  // =======================================================================
  {
    const view = await overview(campaignA);
    const inWindow = view.days.filter((day) => day.inWindow).map((day) => day.dayNumber);
    t('window = today → today + 13: days 3–16 of a campaign that started 2 days ago', inWindow.join() === Array.from({ length: 14 }, (_, i) => i + 3).join(), inWindow.join());
    const draftPlan = posters.planPosterBatch(view, { mode: 'upcoming' });
    t('a DRAFT campaign has nothing eligible, and says why', draftPlan.estimatedGenerations === 0 && draftPlan.skipped.some((group) => group.reason === 'campaign-not-active' && group.dayNumbers.length === 14));
    const refused = await generate(campaignA, (await dayRow(campaignA, 3)).id, 'upcoming');
    t('generating a day of a DRAFT campaign is skipped before any provider call', refused.outcome === 'skipped' && refused.reason === 'campaign-not-active' && renders.length === 0);
    await changeCampaignStatus(tx, campaignA, 'ACTIVE');
    const activePlan = posters.planPosterBatch(await overview(campaignA), { mode: 'upcoming' });
    t('an ACTIVE campaign: 14 eligible days, 14 estimated generations — never all 30', activePlan.estimatedGenerations === 14 && activePlan.days.every((day) => day.dayNumber >= 3 && day.dayNumber <= 16), snapshot(activePlan.days.map((d) => d.dayNumber)));
    t('past days are not generated; future days stay editable slots', (await tx.posterVersion.count({ where: { calendarDay: { campaignId: campaignA } } })) === 0);
  }

  // =======================================================================
  section('eligibility refusals');
  // =======================================================================
  {
    const d5 = await dayRow(campaignA, 5);
    await tx.contentCalendar.update({ where: { id: d5.id }, data: { contentStatus: 'NOT_GENERATED' } });
    const d6 = await dayRow(campaignA, 6);
    await tx.contentCalendar.update({ where: { id: d6.id }, data: { suggestedTemplateId: null } });
    const d7 = await dayRow(campaignA, 7);
    await mapping.assignManualTemplates(tx, campaignA, { kind: 'days', dayNumbers: [7], templateId: tB.id }, noHtml);
    await mapping.setTemplateActive(tx, tB.id, false);

    const view = await overview(campaignA);
    const reasons = new Map(view.days.map((day) => [day.dayNumber, day.upcoming.eligible ? 'eligible' : day.upcoming.reason]));
    t('missing content → content-not-generated', reasons.get(5) === 'content-not-generated');
    t('no template → no-template (Needs attention)', reasons.get(6) === 'no-template' && view.days[5]!.state === 'needs-attention');
    t('inactive template → template-inactive (Needs attention)', reasons.get(7) === 'template-inactive' && view.days[6]!.state === 'needs-attention');
    const before = renders.length;
    const results = await Promise.all([5, 6, 7].map(async (n) => generate(campaignA, (await dayRow(campaignA, n)).id, 'upcoming')));
    t('each refusal is returned with its reason, with no provider call', results.every((r) => r.outcome === 'skipped') && renders.length === before, snapshot(results.map((r) => r.outcome === 'skipped' && r.reason)));
    t('the inactive template is not silently remapped', (await dayRow(campaignA, 7)).posterTemplateId === tB.id && (await dayRow(campaignA, 7)).suggestedTemplateId === d7.suggestedTemplateId);

    const noBrand = await readyCampaign(clientNoBrand.id);
    await changeCampaignStatus(tx, noBrand, 'ACTIVE');
    const noBrandView = await overview(noBrand);
    const noBrandDay = noBrandView.days.find((day) => day.inWindow)!;
    t('missing Brand Canvas → brand-canvas-unavailable (attention), no call', !noBrandDay.upcoming.eligible && noBrandDay.upcoming.reason === 'brand-canvas-unavailable' && (await generate(noBrand, noBrandDay.id, 'upcoming')).outcome === 'skipped' && renders.length === before);

    const fourFive = await readyCampaign(clientPortrait.id);
    await changeCampaignStatus(tx, fourFive, 'ACTIVE');
    const fourFiveView = await overview(fourFive);
    t('a 4:5 client output is an unsupported aspect ratio (attention)', fourFiveView.days.filter((day) => day.inWindow).every((day) => !day.upcoming.eligible && (day.upcoming.reason === 'unsupported-aspect' || day.upcoming.reason === 'no-template')));

    // Put the refused days back for the batch below.
    await tx.contentCalendar.update({ where: { id: d5.id }, data: { contentStatus: 'READY' } });
    await tx.contentCalendar.update({ where: { id: d6.id }, data: { suggestedTemplateId: tA.id } });
    await mapping.setTemplateActive(tx, tB.id, true);
  }

  // =======================================================================
  section('successful generation: day 3');
  // =======================================================================
  const d3 = await dayRow(campaignA, 3);
  {
    const result = await generate(campaignA, d3.id, 'upcoming');
    t('day 3 generated as v1', result.outcome === 'generated' && result.versionNumber === 1, snapshot(result));
    if (result.outcome !== 'generated') throw new Error('cannot continue without a generated poster');
    const call = renders.at(-1)!;
    t('one image request, 9:16 size, mapped template attached as the reference', renders.length === 1 && call.size === '1152x2048' && call.hasImage);
    t('the prompt carries the day content and the no-invented-branding rule', call.prompt.includes('Headline: "Headline for day 3"') && call.prompt.includes('No invented branding') && call.prompt.includes('Reference image:'));
    const secrets = [d3.id, campaignA, clientA.id, tA.id, tA.gDriveFileId, 'SECRET-CLIENT-FOLDER', '919876500321', 'fixture-folder'];
    t('no id, Drive id, folder or WhatsApp number reaches the model', secrets.every((secret) => !call.prompt.includes(secret)), secrets.filter((secret) => call.prompt.includes(secret)).join());

    const version = await tx.posterVersion.findUniqueOrThrow({ where: { id: result.versionId } });
    const generation = await tx.posterStudioGeneration.findUniqueOrThrow({ where: { id: result.generationId } });
    const day = await dayRow(campaignA, 3);
    t('RAW and FINAL are separate Drive files', generation.imageDriveFileId !== generation.finalImageDriveFileId && drive.has(generation.imageDriveFileId) && drive.has(generation.finalImageDriveFileId!));
    t('RAW is exactly the model output; FINAL carries the identity footer', drive.get(generation.imageDriveFileId)!.fileName.endsWith('-raw.png') && !drive.get(generation.imageDriveFileId)!.body.equals(drive.get(generation.finalImageDriveFileId!)!.body));
    t('studio row records prompts, model, format, client and overlay', generation.mode === 'GENERATE' && generation.sentPrompt === call.prompt && generation.aspectRatio === '9:16' && generation.clientId === clientA.id && generation.overlayElements.includes('name'));
    t('PosterVersion: PIPELINE, final image, studio row, template, content revision', version.source === 'PIPELINE' && version.imageDriveFileId === generation.finalImageDriveFileId && version.studioGenerationId === generation.id && version.templateId === tA.id && version.contentRevision === day.contentRevision);
    t('v1 is the day’s active version; status SUCCEEDED', day.activePosterVersionId === version.id && day.generationStatus === 'SUCCEEDED' && day.errorMessage === null);
    t('MANUAL_REVIEW policy: the poster needs approval', version.approvalStatus === 'PENDING' && (await overview(campaignA)).days[2]!.state === 'needs-approval');
    t('usage recorded against the client and day', (await tx.usageEvent.count({ where: { clientId: clientA.id, calendarId: d3.id } })) === 1);
    t('no delivery column is written', day.deliveryStatus === 'PENDING' && day.gDriveFileId === null && day.approvedAt === null && day.sendAfter === null);
  }

  // =======================================================================
  section('idempotency and duplicate prevention');
  // =======================================================================
  {
    const before = renders.length;
    const again = await generate(campaignA, d3.id, 'upcoming');
    const missing = await generate(campaignA, d3.id, 'missing');
    t('generating day 3 again is skipped (already generated), no provider call', again.outcome === 'skipped' && again.reason === 'already-generated' && missing.outcome === 'skipped' && renders.length === before);
    t('still exactly one version for day 3', (await tx.posterVersion.count({ where: { calendarDayId: d3.id } })) === 1);

    // A competing claim: the day is QUEUED by another run.
    const d4 = await dayRow(campaignA, 4);
    await tx.contentCalendar.update({ where: { id: d4.id }, data: { generationStatus: 'QUEUED' } });
    const raced = await generate(campaignA, d4.id, 'upcoming');
    t('a day another run has claimed is skipped (generating)', raced.outcome === 'skipped' && raced.reason === 'generating' && renders.length === before);
    await tx.contentCalendar.update({ where: { id: d4.id }, data: { generationStatus: 'NOT_REQUESTED' } });

    // A stale GENERATING claim, left by a crash 20 minutes ago.
    await tx.contentCalendar.update({ where: { id: d4.id }, data: { generationStatus: 'GENERATING', posterGenerationStartedAt: new Date(NOW.getTime() - 20 * 60_000) } });
    t('a stale claim is shown as not generating', !(await overview(campaignA)).days[3]!.generating);
  }

  // =======================================================================
  section('batch: partial failure, stop, resume, retry');
  // =======================================================================
  {
    const batch = posters.planPosterBatch(await overview(campaignA), { mode: 'upcoming' });
    t('batch plan: the 13 remaining window days (day 3 already done)', batch.estimatedGenerations === 13 && !batch.days.some((day) => day.dayNumber === 3) && batch.skipped.some((group) => group.reason === 'already-generated' && group.dayNumbers.join() === '3'));

    const outcomes = new Map<number, string>();
    // "Stop after 6": the operator presses Stop; the rest stays for another run.
    for (const entry of batch.days.slice(0, 6)) {
      renderMode = entry.dayNumber === 6 ? 'moderation' : 'ok';
      storeFailOn = entry.dayNumber === 8 ? /-final\.png$/ : null;
      const result = await generate(campaignA, entry.dayId, 'upcoming');
      outcomes.set(entry.dayNumber, result.outcome === 'failed' ? `failed:${result.kind}` : result.outcome);
    }
    renderMode = 'ok';
    storeFailOn = null;
    t('the stale claim of day 4 was released and day 4 generated', outcomes.get(4) === 'generated' && (await dayRow(campaignA, 4)).generationStatus === 'SUCCEEDED');
    t('a moderation rejection fails day 6 only', outcomes.get(6) === 'failed:moderation' && ['generated'].includes(outcomes.get(5)!) && outcomes.get(7) === 'generated', snapshot([...outcomes]));
    const d6 = await dayRow(campaignA, 6);
    t('day 6 is FAILED with the reason and no version', d6.generationStatus === 'FAILED' && /safety policy/.test(d6.errorMessage ?? '') && d6.activePosterVersionId === null);
    const d8 = await dayRow(campaignA, 8);
    t('a Drive failure on day 8 is a failure, not a success', outcomes.get(8) === 'failed:storage' && d8.activePosterVersionId === null && /billed.*Google Drive/.test(d8.errorMessage ?? ''), d8.errorMessage ?? '');
    t('…its already-uploaded RAW file was binned, nothing is left in Drive for it', ![...drive.values()].some((file) => file.fileName.startsWith('campaign-day-8-')) && trashed.length >= 1);
    t('…usage is still recorded (the image was billed)', (await tx.usageEvent.count({ where: { calendarId: d8.id } })) === 1);
    t('earlier successes are intact', (await dayRow(campaignA, 3)).activePosterVersionId !== null && (await dayRow(campaignA, 5)).activePosterVersionId !== null);

    const resume = posters.planPosterBatch(await overview(campaignA), { mode: 'upcoming' });
    const resumeDays = resume.days.map((day) => day.dayNumber);
    t('resume plan: only unfinished days, failures included as retries', resumeDays.includes(6) && resumeDays.includes(8) && !resumeDays.some((n) => [3, 4, 5, 7].includes(n)) && resume.days.find((d) => d.dayNumber === 6)!.retry, resumeDays.join());
    for (const entry of resume.days) await generate(campaignA, entry.dayId, 'upcoming');
    t('retry succeeds; FAILED cleared', (await dayRow(campaignA, 6)).generationStatus === 'SUCCEEDED' && (await dayRow(campaignA, 6)).errorMessage === null);
    const finished = posters.planPosterBatch(await overview(campaignA), { mode: 'upcoming' });
    const rendersBefore = renders.length;
    for (const entry of finished.days) await generate(campaignA, entry.dayId, 'upcoming');
    t('running the batch again: 0 eligible, 0 provider calls', finished.estimatedGenerations === 0 && renders.length === rendersBefore);
    const perDay = await tx.posterVersion.groupBy({ by: ['calendarDayId'], where: { calendarDay: { campaignId: campaignA } }, _count: { _all: true } });
    t('no duplicate versions: each of the 14 window days has exactly one', perDay.length === 14 && perDay.every((row) => row._count._all === 1));
    t('days outside the window still have no poster', (await tx.posterVersion.count({ where: { calendarDay: { campaignId: campaignA, dayNumber: { gt: 16 } } } })) === 0);

    renderMode = 'auth';
    const d20 = await dayRow(campaignA, 20);
    const authFail = await generate(campaignA, d20.id, 'missing', true);
    t('an OpenAI 401 stops the batch (stopBatch) and leaves the day recoverable', authFail.outcome === 'failed' && authFail.stopBatch && !authFail.billed && (await dayRow(campaignA, 20)).generationStatus === 'FAILED');
    renderMode = 'garbage';
    const garbage = await generate(campaignA, d20.id, 'missing', true);
    t('an unreadable generated image fails, billed, nothing stored', garbage.outcome === 'failed' && garbage.billed && /could not be read/.test(garbage.message) && ![...drive.values()].some((file) => file.fileName.startsWith('campaign-day-20-')));
    renderMode = 'ok';
    composeFail = true;
    const composeFailure = await generate(campaignA, d20.id, 'missing', true);
    composeFail = false;
    t('an identity footer failure after generation keeps nothing', composeFailure.outcome === 'failed' && composeFailure.kind === 'composition' && (await dayRow(campaignA, 20)).activePosterVersionId === null);
    configured = false;
    const before = renders.length;
    const noKey = await generate(campaignA, d20.id, 'missing', true);
    configured = true;
    t('a missing API key is refused before the claim and before any call', noKey.outcome === 'failed' && noKey.kind === 'config' && noKey.stopBatch && renders.length === before && (await dayRow(campaignA, 20)).generationStatus === 'FAILED');
    const explicit = await generate(campaignA, d20.id, 'missing', true);
    t('an explicit day outside the window can be generated', explicit.outcome === 'generated');

    // Created only now, so no earlier Auto Map run spread days onto it.
    const tBroken = await template('Broken file', { gDriveFileId: 'missing-drive-file' });
    const brokenDay = await dayRow(campaignA, 21);
    await mapping.assignManualTemplates(tx, campaignA, { kind: 'days', dayNumbers: [21], templateId: tBroken.id }, noHtml);
    const rendersBeforeBroken = renders.length;
    const brokenTemplate = await generate(campaignA, brokenDay.id, 'missing', true);
    t('an unreadable template file fails before any spend', brokenTemplate.outcome === 'failed' && brokenTemplate.kind === 'storage' && !brokenTemplate.billed && renders.length === rendersBeforeBroken, brokenTemplate.message);
    await mapping.setTemplateActive(tx, tBroken.id, false);

    // A database failure after the files were stored: the campaign is cancelled mid-generation.
    const campaignB = await readyCampaign((await client('Cancelled mid-run')).id);
    await changeCampaignStatus(tx, campaignB, 'ACTIVE');
    const bDay = (await overview(campaignB)).days.find((day) => day.inWindow)!;
    const generationsBefore = await tx.posterStudioGeneration.count();
    const counterBefore = fileCounter;
    onCompose = async () => {
      await changeCampaignStatus(tx, campaignB, 'CANCELLED');
    };
    const midRun = await generate(campaignB, bDay.id, 'upcoming');
    onCompose = null;
    const storedThisRun = Array.from({ length: fileCounter - counterBefore }, (_, i) => `fake-drive-${counterBefore + i + 1}`);
    t('a record failure after storage is reported as a failure', midRun.outcome === 'failed' && midRun.billed && /CANCELLED/.test(midRun.message), midRun.outcome === 'failed' ? midRun.message : midRun.outcome);
    t('…the studio row written in that transaction was rolled back', (await tx.posterStudioGeneration.count()) === generationsBefore, `${await tx.posterStudioGeneration.count()} vs ${generationsBefore}`);
    t('…no version exists for the day', (await tx.posterVersion.count({ where: { calendarDayId: bDay.id } })) === 0);
    t('…both files it stored (RAW and FINAL) were binned', storedThisRun.length === 2 && storedThisRun.every((id) => trashed.includes(id) && !drive.has(id)), snapshot(storedThisRun));
  }

  // =======================================================================
  section('regeneration and immutable history');
  // =======================================================================
  {
    const v1 = await tx.posterVersion.findFirstOrThrow({ where: { calendarDayId: d3.id, versionNumber: 1 } });
    const v1Before = snapshot(v1);
    const regenerated = await generate(campaignA, d3.id, 'regenerate', true);
    const day = await dayRow(campaignA, 3);
    t('explicit regeneration creates v2', regenerated.outcome === 'generated' && regenerated.versionNumber === 2);
    t('v2 is active; exactly one active pointer', regenerated.outcome === 'generated' && day.activePosterVersionId === regenerated.versionId);
    t('v1 remains, byte-identical', snapshot(await tx.posterVersion.findUniqueOrThrow({ where: { id: v1.id } })) === v1Before);
  }

  // =======================================================================
  section('content and template changes make a poster outdated');
  // =======================================================================
  {
    const d9 = await dayRow(campaignA, 9);
    const rendersBefore = renders.length;
    await updateCampaignDayContent(tx, d9.id, { headline: 'A changed headline' });
    const view = await overview(campaignA);
    t('content edit → "Outdated — regeneration required", no provider call', view.days[8]!.state === 'outdated' && renders.length === rendersBefore);
    const missingPlan = posters.planPosterBatch(view, { mode: 'missing' });
    t('Generate missing never regenerates it (reason: outdated)', !missingPlan.days.some((day) => day.dayNumber === 9) && missingPlan.skipped.some((group) => group.reason === 'outdated' && group.dayNumbers.includes(9)));
    const upcomingPlan = posters.planPosterBatch(view, { mode: 'upcoming' });
    t('Generate upcoming lists it as a regeneration for the operator to confirm', upcomingPlan.days.some((day) => day.dayNumber === 9 && day.action === 'regenerate'));

    const d10 = await dayRow(campaignA, 10);
    const other = (d10.posterTemplateId ?? d10.suggestedTemplateId) === tA.id ? tB.id : tA.id;
    await mapping.assignManualTemplates(tx, campaignA, { kind: 'days', dayNumbers: [10], templateId: other }, noHtml);
    t('template mapping change → outdated, no provider call', (await overview(campaignA)).days[9]!.state === 'outdated' && renders.length === rendersBefore);
    const regen = await generate(campaignA, d9.id, 'upcoming');
    const d9After = await dayRow(campaignA, 9);
    const versions = await tx.posterVersion.findMany({ where: { calendarDayId: d9.id }, orderBy: { versionNumber: 'asc' } });
    t('regenerating the outdated day: v2 current and active, v1 kept as outdated history', regen.outcome === 'generated' && versions.length === 2 && d9After.activePosterVersionId === versions[1]!.id && isVersionCurrent(versions[1]!, d9After) && !isVersionCurrent(versions[0]!, d9After));
  }

  // =======================================================================
  section('approval policy');
  // =======================================================================
  {
    const day = await dayRow(campaignA, 3);
    const refusedAction = await asAction(() => campaignActions.approveCampaignDayPosterAction(day.id, 'b0000000-0000-4000-8000-000000000000'));
    t('approving a version that is not the active one is refused', !refusedAction.ok);
    const approved = await asAction(() => campaignActions.approveCampaignDayPosterAction(day.id, day.activePosterVersionId!));
    t('approving the active current poster → APPROVED', approved.ok && (await tx.posterVersion.findUniqueOrThrow({ where: { id: day.activePosterVersionId! } })).approvalStatus === 'APPROVED');
    const d10 = await dayRow(campaignA, 10);
    await expectDomainError('approving an outdated poster is refused', 'invalid-transition', () => posters.approveCampaignDayPoster(tx, d10.id, d10.activePosterVersionId!));

    const autoCampaign = await readyCampaign(clientAuto.id, { approvalPolicy: 'AUTO_APPROVE' });
    await changeCampaignStatus(tx, autoCampaign, 'ACTIVE');
    const autoDay = (await overview(autoCampaign)).days.find((candidate) => candidate.inWindow)!;
    const autoResult = await generate(autoCampaign, autoDay.id, 'upcoming');
    t('AUTO_APPROVE policy: the generated poster is APPROVED', autoResult.outcome === 'generated' && autoResult.approvalStatus === 'APPROVED');
  }

  // =======================================================================
  section('Poster Studio: edit saved to the campaign day');
  // =======================================================================
  {
    const day = await dayRow(campaignA, 3);
    const activeBefore = await tx.posterVersion.findUniqueOrThrow({ where: { id: day.activePosterVersionId! } });
    const edit = await tx.posterStudioGeneration.create({
      data: { mode: 'EDIT', prompt: 'Brighter background', sentPrompt: 'Edit the attached image…', aspectRatio: '9:16', size: '1152x2048', model: 'gpt-image-2', quality: 'low', imageDriveFileId: 'fake-edit-raw', finalImageDriveFileId: 'fake-edit-final', imageMimeType: 'image/png', finalImageMimeType: 'image/png', parentGenerationId: activeBefore.studioGenerationId, clientId: clientA.id },
    });
    const saved = await asAction(() => campaignActions.saveStudioPosterToCampaignDayAction(day.id, edit.id));
    const after = await dayRow(campaignA, 3);
    const v = saved.ok ? await tx.posterVersion.findUniqueOrThrow({ where: { id: saved.data.versionId } }) : null;
    t('the edit becomes a new POSTER_STUDIO version, active, edited from the previous one', saved.ok && v?.source === 'POSTER_STUDIO' && v.parentVersionId === activeBefore.id && after.activePosterVersionId === v.id && v.imageDriveFileId === 'fake-edit-final');
    t('the previous version is unchanged history', snapshot(await tx.posterVersion.findUniqueOrThrow({ where: { id: activeBefore.id } })) === snapshot(activeBefore));
    const again = await asAction(() => campaignActions.saveStudioPosterToCampaignDayAction(day.id, edit.id));
    t('saving the same studio poster twice creates no duplicate', again.ok && again.data.alreadySaved && (await tx.posterVersion.count({ where: { studioGenerationId: edit.id } })) === 1);
    const otherClient = await tx.posterStudioGeneration.create({ data: { mode: 'GENERATE', prompt: 'x', sentPrompt: 'x', aspectRatio: '9:16', size: '1152x2048', model: 'gpt-image-2', quality: 'low', imageDriveFileId: 'fake-other', imageMimeType: 'image/png', clientId: clientAuto.id } });
    const square = await tx.posterStudioGeneration.create({ data: { mode: 'GENERATE', prompt: 'x', sentPrompt: 'x', aspectRatio: '1:1', size: '1024x1024', model: 'gpt-image-2', quality: 'low', imageDriveFileId: 'fake-square', imageMimeType: 'image/png', clientId: clientA.id } });
    await expectDomainError('a poster made for another client is refused', 'invalid-input', () => posters.saveStudioPosterToCampaignDay(tx, day.id, otherClient.id));
    await expectDomainError('a poster in another format is refused', 'invalid-input', () => posters.saveStudioPosterToCampaignDay(tx, day.id, square.id));

    const deleted = await asAction(() => studioActions.deleteStudioGenerationAction(activeBefore.studioGenerationId!));
    t('Poster Studio refuses to delete a history item a campaign version uses', !deleted.ok && /campaign poster version/.test(deleted.ok ? '' : deleted.error) && (await tx.posterStudioGeneration.count({ where: { id: activeBefore.studioGenerationId! } })) === 1);
    const listing = await posters.listCampaignDayPosterVersions(tx, day.id);
    t('version history lists every version newest first, one active, no Drive ids', listing.versions.map((row) => row.versionNumber).join() === '3,2,1' && listing.versions.filter((row) => row.active).length === 1 && !snapshot(listing).includes('fake-drive-'));
  }

  // =======================================================================
  section('server actions');
  // =======================================================================
  {
    const planned = await asAction(() => campaignActions.planPosterBatchAction(campaignA, { mode: 'missing' }));
    t('planPosterBatchAction returns eligible count and grouped reasons', planned.ok && typeof planned.data.estimatedGenerations === 'number' && Array.isArray(planned.data.skipped));
    const invalid = await asAction(() => campaignActions.planPosterBatchAction(campaignA, { mode: 'regenerate', fromDay: 9, toDay: 3 }));
    t('an invalid range is refused', !invalid.ok);
    const status = await asAction(() => campaignActions.changeCampaignStatusAction(campaignA, 'PAUSED'));
    t('pausing the campaign blocks generation', status.ok && posters.planPosterBatch(await overview(campaignA), { mode: 'upcoming' }).estimatedGenerations === 0);
    await asAction(() => campaignActions.changeCampaignStatusAction(campaignA, 'ACTIVE'));
  }

  // =======================================================================
  section('isolation: legacy rows, WhatsApp, production');
  // =======================================================================
  t('legacy calendar rows are byte-identical', snapshot(await tx.contentCalendar.findMany({ where: { clientId: legacy.id } })) === legacyBefore);
  t('legacy calendar scope still excludes every campaign day', (await tx.contentCalendar.count({ where: { clientId: clientA.id, ...LEGACY_CALENDAR } })) === 0);
  t('no WhatsApp usage and no delivery column on any campaign day', (await tx.usageEvent.count({ where: { provider: 'EVOLUTION' } })) === whatsappUsageBefore && (await tx.contentCalendar.count({ where: { campaignId: { not: null }, OR: [{ deliveryStatus: { not: 'PENDING' } }, { gDriveFileId: { not: null } }, { approvedAt: { not: null } }, { sendAfter: { not: null } }] } })) === 0);
  const imageUsageAdded = (await tx.usageEvent.count({ where: { provider: 'OPENAI' } })) - imageUsageBefore;
  t('only image usage rows were added, one per billed image', imageUsageAdded > 0 && (await tx.usageEvent.count()) - usageBefore === imageUsageAdded && imageUsageAdded === renders.length - renderRefusals, `${imageUsageAdded} rows, ${renders.length} requests, ${renderRefusals} refused`);
  t('ran against the local development database only', /evokz_ai_dev @ localhost/.test(databaseLabel), databaseLabel);
}

const TABLES = ['Client', 'Campaign', 'ContentCalendar', 'PosterVersion', 'PosterStudioGeneration', 'Category', 'CategoryTemplate', 'Plan', 'UsageEvent'];
async function tableCounts(): Promise<string> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const rows = await realPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "${table}"`);
    counts[table] = Number(rows[0]?.n ?? -1);
  }
  return snapshot(counts);
}

async function main(): Promise<void> {
  const external = (await import(
    'next/dist/client/components/static-generation-async-storage.external.js'
  )) as unknown as { staticGenerationAsyncStorage: AsyncStorage };
  requestStore = external.staticGenerationAsyncStorage;

  const before = await tableCounts();
  try {
    await realPrisma.$transaction(
      async (tx) => {
        activeTx = tx;
        await suite();
        throw new Rollback();
      },
      { timeout: 600_000, maxWait: 10_000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) {
      console.error('\nSuite aborted:', error);
      bad += 1;
    }
  } finally {
    activeTx = null;
  }

  section('after rollback');
  const after = await tableCounts();
  t('every table has exactly its original row count', before === after, after);
  t('no network call was attempted (no OpenAI, no WhatsApp)', networkAttempts === 0, String(networkAttempts));
  console.log(`\n${bad === 0 ? 'All campaign poster database checks passed.' : `${bad} check(s) FAILED.`}`);
}

main()
  .catch((error) => {
    console.error(error);
    bad += 1;
  })
  .finally(async () => {
    await realPrisma.$disconnect();
    process.exit(bad === 0 ? 0 : 1);
  });
