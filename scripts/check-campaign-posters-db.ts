/**
 * Database checks for rolling campaign poster generation (Phase 4), in clone
 * mode (template clones, Phase 2 of the clone plan).
 *
 * Runs `src/lib/campaign/poster-generation-service.ts` — eligibility, batch
 * planning, claiming, clone generation, versioning, approval, Poster Studio saves
 * — and the Phase 4 server actions against the development database. The image
 * model, Google Drive, the logo download and the text read-back are replaced by
 * in-process fakes (`PosterGenerationDeps`); the element resolution, clone
 * prompt, template image preparation, decode check, logo compositing, usage
 * ledger, studio rows and versions are the real ones.
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

// ---- The fixture template's elements -------------------------------------------

type Kind = import('@/lib/types/template-elements').TemplateElementKind;
const element = (id: string, kind: Kind, text: string | null, box: [number, number, number, number], extra: { group?: string; description?: string } = {}) => ({
  id,
  kind,
  text,
  box: { x: box[0], y: box[1], w: box[2], h: box[3] },
  group: extra.group ?? null,
  description: extra.description ?? null,
});

/** A read template carrying another business's identity, the way the reader stores one. */
function fixtureDoc(width: number, height: number) {
  return {
    version: 1,
    width,
    height,
    model: 'fake-reader',
    elements: [
      element('e1', 'logo', null, [0.05, 0.03, 0.12, 0.07], { description: 'blue cross mark' }),
      element('e2', 'brandName', 'Old Clinic', [0.19, 0.04, 0.3, 0.04]),
      element('e3', 'headline', 'Care you can see', [0.05, 0.15, 0.6, 0.12]),
      element('e4', 'subheadline', 'Gentle care for the whole family.', [0.05, 0.3, 0.5, 0.05]),
      element('e5', 'photo', null, [0.45, 0.25, 0.55, 0.55], { description: 'dentist smiling at a child patient' }),
      element('e6', 'feature', 'Painless check-ups', [0.05, 0.45, 0.3, 0.03], { group: 'features' }),
      element('e7', 'feature', 'Weekend hours', [0.05, 0.5, 0.3, 0.03], { group: 'features' }),
      element('e8', 'text', 'Choose Old Clinic.', [0.05, 0.6, 0.3, 0.03]),
      element('e9', 'cta', 'Book a visit', [0.05, 0.84, 0.3, 0.04]),
      element('e10', 'phone', '+1 555 0100', [0.05, 0.89, 0.25, 0.03], { group: 'contact' }),
      element('e11', 'website', 'www.oldclinic.example', [0.35, 0.89, 0.3, 0.03], { group: 'contact' }),
      element('e12', 'text', 'Visit us at:', [0.05, 0.94, 0.12, 0.03], { group: 'contact' }),
      element('e13', 'address', '12 Old Road', [0.18, 0.94, 0.3, 0.03], { group: 'contact' }),
      element('e14', 'personName', 'Dr. Old Name', [0.6, 0.94, 0.3, 0.03]),
    ],
  };
}

// ---------------------------------------------------------------------------

async function suite(): Promise<void> {
  const tx = facade;
  const { isVersionCurrent } = await import('@/lib/campaign/model');
  const service = await import('@/lib/campaign/service');
  const mapping = await import('@/lib/campaign/template-mapping-service');
  const posters = await import('@/lib/campaign/poster-generation-service');
  const queue = await import('@/lib/campaign/generation-queue');
  const campaignActions = await import('@/app/admin/campaigns/actions');
  const studioActions = await import('@/app/admin/poster-studio/actions');
  const { StudioError } = await import('@/lib/poster-studio/errors');
  const { prepareCloneTemplateImage, readStudioImageSize } = await import('@/lib/poster-studio/images');
  const { composeCloneIdentity } = await import('@/lib/poster-studio/clone-identity');
  const { hasBrandCanvasLogo } = await import('@/lib/poster-studio/brand-logo');
  const { recordOpenAiImageUsage } = await import('@/lib/usage');
  const { loadStudioBrandCanvas } = await import('@/lib/poster-studio/brand-context');
  const { parseDayPosterElements, parseTextCheck } = await import('@/lib/types/template-elements');
  const { addZonedDays, startOfZonedDay } = await import('@/lib/time');
  const { CampaignDomainError, changeCampaignStatus, createCampaign, updateCampaignDayContent } = service;
  type Deps = import('@/lib/campaign/poster-generation-service').PosterGenerationDeps;

  const TZ = 'Asia/Kolkata';
  const NOW = new Date();
  const today = startOfZonedDay(NOW, TZ);
  const load = { timeZone: TZ, now: NOW };

  async function expectDomainError(name: string, code: string, work: () => Promise<unknown>) {
    try {
      await work();
      t(name, false, 'succeeded but should have failed');
    } catch (error) {
      t(name, error instanceof CampaignDomainError && error.code === code, error instanceof Error ? error.message : String(error));
    }
  }

  // ---- Fakes: image model, Drive, logo download, text check -----------------
  const png = (width: number, height: number, color: string) => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
  const pixelOf = async (bytes: Buffer, x: number, y: number) => {
    const { data } = await sharp(bytes).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return [data[0], data[1], data[2]];
  };
  const templatePng = await png(540, 960, '#3366aa');
  const logoPng = await png(200, 100, '#ff0000');
  const drive = new Map<string, { fileName: string; body: Buffer }>();
  const trashed: string[] = [];
  const renders: Array<{ prompt: string; size: string; quality: string | undefined; image: { width: number; height: number } | null }> = [];
  const textChecks: string[] = [];
  let renderMode: 'ok' | 'moderation' | 'auth' | 'garbage' = 'ok';
  let storeFailOn: RegExp | null = null;
  let composeFail = false;
  let logoFail = false;
  let textCheckFail = false;
  let onCompose: (() => Promise<void>) | null = null;
  let onCheck: (() => Promise<void>) | null = null;
  let fileCounter = 0;
  /** Requests the fake model refused: no image, so nothing billed or recorded. */
  let renderRefusals = 0;
  let configured = true;

  const deps: Deps = {
    assertConfigured: () => {
      if (!configured) throw new StudioError('config', 'OPENAI_API_KEY is not set on the server.');
    },
    loadBrandCanvas: loadStudioBrandCanvas,
    resolveLogo: async (canvas) => {
      if (!hasBrandCanvasLogo(canvas.logo)) return null;
      if (logoFail) throw new StudioError('logo', "The client's logo could not be read from Google Drive.");
      return { background: 'ORIGINAL', processing: 'as-uploaded', bytes: logoPng, mimeType: 'image/png', isSvg: false, width: 200, height: 100, inkLuminance: null };
    },
    resolveFolder: async () => 'fixture-folder',
    readFile: async (fileId) => {
      if (!fileId.startsWith('fixture-template')) throw new StudioError('storage', 'Could not load the selected image from Google Drive.');
      return templatePng;
    },
    prepareTemplate: prepareCloneTemplateImage,
    render: async (request) => {
      const meta = request.image ? await sharp(request.image.bytes).metadata() : null;
      renders.push({ prompt: request.prompt, size: request.size, quality: request.quality, image: meta ? { width: meta.width ?? 0, height: meta.height ?? 0 } : null });
      if (renderMode === 'moderation' || renderMode === 'auth') renderRefusals += 1;
      if (renderMode === 'moderation') throw new StudioError('moderation', 'OpenAI declined this request under its safety policy.');
      if (renderMode === 'auth') throw new StudioError('auth', 'OpenAI rejected the API key configured on the server.');
      const [width, height] = request.size.split('x').map(Number) as [number, number];
      const bytes = renderMode === 'garbage' ? Buffer.from('not an image at all') : await png(width, height, '#ffffff');
      return { bytes, mimeType: 'image/png', model: 'gpt-image-2', quality: request.quality ?? 'low', usage: { textInputTokens: 100, imageInputTokens: 900, outputTokens: 4000 } };
    },
    recordUsage: recordOpenAiImageUsage,
    readImageSize: readStudioImageSize,
    composeIdentity: async (raw, input) => {
      await onCompose?.();
      if (composeFail) throw new Error('fake compositing failure');
      return composeCloneIdentity(raw, input);
    },
    checkText: async (input) => {
      const hook = onCheck;
      onCheck = null;
      await hook?.();
      textChecks.push(input.resolved.map((item) => item.element.id).join(','));
      if (textCheckFail) throw new Error('fake text check failure');
      return {
        checkedAt: NOW.toISOString(),
        model: 'fake-reader',
        ok: false,
        items: [{ elementId: 'e3', label: 'Headline', expected: 'Care you can see', found: 'Care you can sea', match: false }],
        leftovers: [],
      };
    },
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
  let order = 0;
  const template = (label: string, data: Partial<Prisma.CategoryTemplateUncheckedCreateInput> = {}) =>
    tx.categoryTemplate.create({
      data: {
        categoryId: vertical.id,
        label: `check:posters ${label}`,
        gDriveFileId: `fixture-template-${label}`,
        gDriveViewUrl: 'https://drive.invalid/t',
        mimeType: 'image/png',
        width: 1080,
        height: 1920,
        elements: fixtureDoc(data.width ?? 1080, data.height ?? 1920) as unknown as Prisma.InputJsonValue,
        elementsReadAt: new Date(),
        createdAt: new Date(Date.parse('2026-01-01') + (order += 1) * 1000),
        ...data,
      },
    });
  const tA = await template('A');
  const tB = await template('B');

  const brand = { colors: [{ hex: '#0e7c86', role: 'primary' }, { hex: '#f4b942', role: 'accent' }, { hex: '#fafafa', role: 'background' }], typography: null, layoutDirectives: [], assets: [] };
  const start = addZonedDays(today, -2, TZ);
  const client = (name: string, data: Partial<Prisma.ClientUncheckedCreateInput> = {}) =>
    tx.client.create({
      data: {
        companyName: `check:posters ${name}`,
        whatsappNumber: '919876500321',
        displayPhone: '080 4000 1234',
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
        logoUrl: 'https://logo.invalid/clinic.png',
        gDriveFolderId: 'SECRET-CLIENT-FOLDER',
        ...data,
      },
    });
  const clientA = await client('Clinic A');
  const clientAuto = await client('Auto approve');
  const clientNoBrand = await client('No colours', { brandGuideline: Prisma.DbNull, logoUrl: null });
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
          imagePrompt: day.dayNumber === 3 ? 'a smiling hygienist with a teenage patient' : '',
          contentStatus: 'READY',
          contentRevision: { increment: 1 },
        },
      });
    }
    const preview = await mapping.previewAutoMap(tx, campaignId);
    await mapping.applyAutoMap(tx, campaignId, { fingerprint: preview.plan.fingerprint });
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
    t('each day knows its template’s clone size, from the template shape', view.days.every((day) => day.outputSize?.size === '1008x1792' && day.template?.readable === true));
  }

  // =======================================================================
  section('eligibility refusals');
  // =======================================================================
  {
    const d5 = await dayRow(campaignA, 5);
    await tx.contentCalendar.update({ where: { id: d5.id }, data: { contentStatus: 'NEEDS_REVIEW' } });
    const d6 = await dayRow(campaignA, 6);
    await tx.contentCalendar.update({ where: { id: d6.id }, data: { suggestedTemplateId: null } });
    const d7 = await dayRow(campaignA, 7);
    await mapping.assignManualTemplates(tx, campaignA, { kind: 'days', dayNumbers: [7], templateId: tB.id });
    await mapping.setTemplateActive(tx, tB.id, false);
    const tUnread = await template('Unread', { elements: Prisma.DbNull, elementsReadAt: null });
    const d8 = await dayRow(campaignA, 8);
    await mapping.assignManualTemplates(tx, campaignA, { kind: 'days', dayNumbers: [8], templateId: tUnread.id });

    const view = await overview(campaignA);
    const reasons = new Map(view.days.map((day) => [day.dayNumber, day.upcoming.eligible ? 'eligible' : day.upcoming.reason]));
    t('a clone day is READY content: a NEEDS_REVIEW status does not block it', reasons.get(5) === 'eligible');
    t('no template → no-template (Needs attention)', reasons.get(6) === 'no-template' && view.days[5]!.state === 'needs-attention');
    t('inactive template → template-inactive (Needs attention)', reasons.get(7) === 'template-inactive' && view.days[6]!.state === 'needs-attention');
    const unread = view.days[7]!;
    t(
      'a template not read yet → template-not-read (Needs attention), with what to do',
      !unread.upcoming.eligible && unread.upcoming.reason === 'template-not-read' && unread.upcoming.attention && /press Read now/.test(unread.upcoming.message) && unread.state === 'needs-attention',
      snapshot(unread.upcoming),
    );
    const before = renders.length;
    const results = await Promise.all([6, 7, 8].map(async (n) => generate(campaignA, (await dayRow(campaignA, n)).id, 'upcoming')));
    t('each refusal is returned with its reason, with no provider call', results.every((r) => r.outcome === 'skipped') && renders.length === before, snapshot(results.map((r) => r.outcome === 'skipped' && r.reason)));
    t('the inactive template is not silently remapped', (await dayRow(campaignA, 7)).posterTemplateId === tB.id && (await dayRow(campaignA, 7)).suggestedTemplateId === d7.suggestedTemplateId);
    const d8After = await dayRow(campaignA, 8);
    t('the unread day was not touched: no clone saved, no status, no version', d8After.posterElements === null && d8After.generationStatus === d8.generationStatus && d8After.activePosterVersionId === null);

    const noBrand = await readyCampaign(clientNoBrand.id);
    await changeCampaignStatus(tx, noBrand, 'ACTIVE');
    const noBrandDay = (await overview(noBrand)).days.find((day) => day.inWindow)!;
    t('Brand Canvas without colours is enough: the day is eligible (template colours kept)', noBrandDay.upcoming.eligible, snapshot(noBrandDay.upcoming));
    const nameless = await client('Nameless');
    await tx.client.update({ where: { id: nameless.id }, data: { companyName: '   ' } });
    const namelessCampaign = await readyCampaign(nameless.id);
    await changeCampaignStatus(tx, namelessCampaign, 'ACTIVE');
    const namelessDay = (await overview(namelessCampaign)).days.find((day) => day.inWindow)!;
    t('no company name → brand-canvas-unavailable (attention), no call', !namelessDay.upcoming.eligible && namelessDay.upcoming.reason === 'brand-canvas-unavailable' && (await generate(namelessCampaign, namelessDay.id, 'upcoming')).outcome === 'skipped' && renders.length === before);

    const fourFive = await readyCampaign(clientPortrait.id);
    // Auto Map still matches the client preset (it is retired with mapping); a clone day's template is set directly.
    await mapping.assignManualTemplates(tx, fourFive, { kind: 'range', fromDay: 1, toDay: 30, templateId: tA.id });
    await changeCampaignStatus(tx, fourFive, 'ACTIVE');
    const fourFiveView = await overview(fourFive);
    t('a 4:5 client output no longer blocks: the template shape decides', fourFiveView.days.filter((day) => day.inWindow).every((day) => day.upcoming.eligible), snapshot(fourFiveView.days.filter((day) => day.inWindow).map((day) => !day.upcoming.eligible && day.upcoming.reason)));

    // Put the refused days back for the batch below.
    await tx.contentCalendar.update({ where: { id: d6.id }, data: { suggestedTemplateId: tA.id } });
    await mapping.setTemplateActive(tx, tB.id, true);
    await mapping.assignManualTemplates(tx, campaignA, { kind: 'days', dayNumbers: [8], templateId: tA.id });
    await mapping.setTemplateActive(tx, tUnread.id, false);
  }

  // =======================================================================
  section('clone generation: day 3');
  // =======================================================================
  const d3 = await dayRow(campaignA, 3);
  {
    const revisionBefore = d3.contentRevision;
    const d3Template = (await overview(campaignA)).days.find((d) => d.id === d3.id)!.mapping.templateId!;
    const result = await generate(campaignA, d3.id, 'upcoming');
    t('day 3 generated as v1', result.outcome === 'generated' && result.versionNumber === 1, snapshot(result));
    if (result.outcome !== 'generated') throw new Error('cannot continue without a generated poster');
    const call = renders.at(-1)!;
    t('one image request at the template’s own size, quality high', renders.length === 1 && call.size === '1008x1792' && call.quality === 'high');
    t('the template is attached at exactly that size', call.image?.width === 1008 && call.image?.height === 1792, snapshot(call.image));

    const prompt = call.prompt;
    const company = 'check:posters Clinic A';
    t('the prompt asks for an exact recreation', prompt.startsWith('Recreate the attached poster exactly.') && prompt.includes('Output frame: vertical 9:16'));
    t('replacements: the brand name, phone and website from Brand Canvas', prompt.includes(`Business name (top centre): replace "Old Clinic" with "${company}".`) && prompt.includes('replace "+1 555 0100" with "080 4000 1234"') && prompt.includes('replace "www.oldclinic.example" with "clinic-fixture.invalid"'));
    t('the template’s business name is swapped inside its words', prompt.includes(`replace "Choose Old Clinic." with "Choose ${company}."`));
    t('removals: the address, its orphaned label, and the other person’s name', prompt.includes('erase "12 Old Road" together with its icon') && prompt.includes('erase "Visit us at:"') && prompt.includes('erase "Dr. Old Name"'));
    t('the photo takes the day’s image prompt and different people', prompt.includes('replace this photograph with a new one of a smiling hygienist with a teenage patient') && prompt.includes('nobody from the original is recognisable'));
    t('the logo area is cleared for the client’s logo', prompt.includes("the client's logo is placed there afterwards") && prompt.includes("The space left for the client's logo stays clean and empty"));
    t('the day’s own headline and supporting text replace the template’s; kept words are not listed', prompt.includes('replace "Care you can see" with "Headline for day 3"') && prompt.includes('replace "Gentle care for the whole family." with "Supporting text 3."') && !prompt.includes('Painless check-ups') && !prompt.includes('"Book a visit"'), prompt.split('\n').filter((line) => /Headline|Sub-headline/.test(line)).join(' | '));
    t('the old business identity is never a value to print', !/with "(Old Clinic|\+1 555 0100|www\.oldclinic\.example|12 Old Road|Dr\. Old Name)/.test(prompt));
    t('brand accent colours only — never the background colour', prompt.includes('primary #0E7C86, accent #F4B942') && !prompt.includes('#FAFAFA') && prompt.includes('Keep the lightness of every area'));
    const secrets = [d3.id, campaignA, clientA.id, tA.id, tA.gDriveFileId, 'SECRET-CLIENT-FOLDER', '919876500321', 'fixture-folder', 'logo.invalid'];
    t('no id, Drive id, folder, logo URL or WhatsApp number reaches the model', secrets.every((secret) => !prompt.includes(secret)), secrets.filter((secret) => prompt.includes(secret)).join());

    const version = await tx.posterVersion.findUniqueOrThrow({ where: { id: result.versionId } });
    const generation = await tx.posterStudioGeneration.findUniqueOrThrow({ where: { id: result.generationId } });
    const day = await dayRow(campaignA, 3);
    const raw = drive.get(generation.imageDriveFileId)!.body;
    const final = drive.get(generation.finalImageDriveFileId!)!.body;
    t('RAW and FINAL are separate Drive files', generation.imageDriveFileId !== generation.finalImageDriveFileId && drive.has(generation.imageDriveFileId) && drive.has(generation.finalImageDriveFileId!));
    // Logo box e1: x 0.05 y 0.03 w 0.12 h 0.07 of 1008x1792 → centre ≈ (111, 116).
    t('the client’s logo is composited into the template’s logo box on FINAL only', snapshot(await pixelOf(final, 111, 116)) === snapshot([255, 0, 0]) && snapshot(await pixelOf(raw, 111, 116)) === snapshot([255, 255, 255]));
    t('…and nowhere else', snapshot(await pixelOf(final, 700, 1500)) === snapshot([255, 255, 255]));
    t(
      'studio row: CLONE, source template, template shape and size, quality, logo recorded',
      generation.mode === 'CLONE' && generation.sourceTemplateId === d3Template && generation.aspectRatio === '9:16' && generation.size === '1008x1792' && generation.quality === 'high' && snapshot(generation.overlayElements) === snapshot(['logo']) && generation.sentPrompt === prompt && generation.clientId === clientA.id && generation.referenceDriveFileId === null,
      snapshot({ mode: generation.mode, aspect: generation.aspectRatio, size: generation.size, overlay: generation.overlayElements }),
    );
    t('PosterVersion: PIPELINE, final image, studio row, template, content revision', version.source === 'PIPELINE' && version.imageDriveFileId === generation.finalImageDriveFileId && version.studioGenerationId === generation.id && version.templateId === d3Template && version.contentRevision === day.contentRevision);
    const check = parseTextCheck(version.textCheck);
    t('the text check is stored on the version', check !== null && check.ok === false && check.items[0]?.found === 'Care you can sea' && textChecks.length === 1);
    t('v1 is the day’s active version; status SUCCEEDED', day.activePosterVersionId === version.id && day.generationStatus === 'SUCCEEDED' && day.errorMessage === null);
    const stored = parseDayPosterElements(day.posterElements);
    t('the day’s clone is saved with its template', stored?.templateId === d3Template && stored.values.find((value) => value.id === 'e8')?.text === `Choose ${company}.`);
    t('…seeded with the day’s existing content, as the admin’s — never the template’s words over it', stored?.values.find((value) => value.id === 'e3')?.text === 'Headline for day 3' && stored.values.find((value) => value.id === 'e3')?.source === 'admin' && stored.values.find((value) => value.id === 'e4')?.text === 'Supporting text 3.' && stored.values.find((value) => value.id === 'e9')?.source === 'template');
    t('headline, supporting text and CTA keep the day’s content; its image prompt is kept', day.headline === 'Headline for day 3' && day.supportingText === 'Supporting text 3.' && day.cta === 'Book a visit' && day.imagePrompt === 'a smiling hygienist with a teenage patient', snapshot([day.headline, day.supportingText, day.cta]));
    t('…without moving the content revision (the poster is current)', day.contentRevision === revisionBefore && isVersionCurrent(version, day));
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
      textCheckFail = entry.dayNumber === 7;
      const result = await generate(campaignA, entry.dayId, 'upcoming');
      outcomes.set(entry.dayNumber, result.outcome === 'failed' ? `failed:${result.kind}` : result.outcome);
    }
    renderMode = 'ok';
    storeFailOn = null;
    textCheckFail = false;
    t('the stale claim of day 4 was released and day 4 generated', outcomes.get(4) === 'generated' && (await dayRow(campaignA, 4)).generationStatus === 'SUCCEEDED');
    t('a moderation rejection fails day 6 only', outcomes.get(6) === 'failed:moderation' && ['generated'].includes(outcomes.get(5)!) && outcomes.get(7) === 'generated', snapshot([...outcomes]));
    const d7version = await tx.posterVersion.findFirstOrThrow({ where: { calendarDay: { campaignId: campaignA, dayNumber: 7 } } });
    t('a text check failure never fails the poster: it is stored unchecked', outcomes.get(7) === 'generated' && d7version.textCheck === null);
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
    t('a logo compositing failure after generation keeps nothing', composeFailure.outcome === 'failed' && composeFailure.kind === 'composition' && composeFailure.billed && (await dayRow(campaignA, 20)).activePosterVersionId === null, composeFailure.outcome === 'failed' ? composeFailure.message : '');
    logoFail = true;
    const rendersBeforeLogo = renders.length;
    const logoFailure = await generate(campaignA, d20.id, 'missing', true);
    logoFail = false;
    t('an unreadable client logo fails before any spend', logoFailure.outcome === 'failed' && logoFailure.kind === 'logo' && !logoFailure.billed && renders.length === rendersBeforeLogo);
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
    await mapping.assignManualTemplates(tx, campaignA, { kind: 'days', dayNumbers: [21], templateId: tBroken.id });
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
  section('template shape, brand colours and the queue');
  // =======================================================================
  {
    const t45 = await template('Four five', { width: 736, height: 920 });
    const noBrandCampaign = (await tx.campaign.findFirstOrThrow({ where: { clientId: clientNoBrand.id } })).id;
    const day = (await overview(noBrandCampaign)).days.find((candidate) => candidate.inWindow)!;
    await mapping.assignManualTemplates(tx, noBrandCampaign, { kind: 'days', dayNumbers: [day.dayNumber], templateId: t45.id });
    const result = await generate(noBrandCampaign, day.id, 'missing', true);
    const call = renders.at(-1)!;
    t('a 4:5 template renders at 1280x1600 whatever the client preset', result.outcome === 'generated' && call.size === '1280x1600' && call.image?.width === 1280 && call.image?.height === 1600, snapshot(call.size));
    const generation = result.outcome === 'generated' ? await tx.posterStudioGeneration.findUniqueOrThrow({ where: { id: result.generationId } }) : null;
    t('…recorded as a 4:5 clone of that template', generation?.aspectRatio === '4:5' && generation.size === '1280x1600' && generation.sourceTemplateId === t45.id);
    t('no brand colours: the template’s colours are kept', call.prompt.includes('Colours: keep every colour exactly as in the original.'));
    t('no Brand Canvas logo: the template logo is removed and nothing is composited', call.prompt.includes('remove this logo completely and leave clean background') && snapshot(generation?.overlayElements) === snapshot([]));

    // A queued day whose template became unreadable is released, not retried forever.
    const queued = (await overview(noBrandCampaign)).days.find((candidate) => candidate.inWindow && !candidate.activeVersion && candidate.id !== day.id)!;
    await mapping.assignManualTemplates(tx, noBrandCampaign, { kind: 'days', dayNumbers: [queued.dayNumber], templateId: t45.id });
    const queuedOutcome = await queue.queueCampaignPosters(tx, noBrandCampaign, { mode: 'missing', dayIds: [queued.id] }, load);
    t('days in view are queued by id', snapshot(queuedOutcome.queued) === snapshot([queued.dayNumber]), snapshot(queuedOutcome));
    await tx.categoryTemplate.update({ where: { id: t45.id }, data: { elements: Prisma.DbNull } });
    const rendersBefore = renders.length;
    const sweep = await queue.runQueuedCampaignGenerations(tx, { ...load, deps, campaignId: noBrandCampaign, limit: 1 });
    const released = await tx.contentCalendar.findUniqueOrThrow({ where: { id: queued.id } });
    t('the worker skips it with the reason and releases it from the queue', sweep.skipped[0]?.reason === 'template-not-read' && released.generationStatus === 'NOT_REQUESTED' && renders.length === rendersBefore, snapshot(sweep.skipped));
    const idle = await queue.runQueuedCampaignGenerations(tx, { ...load, deps, campaignId: noBrandCampaign, limit: 1 });
    t('…so the next run finds nothing', idle.claimed === 0 && idle.skipped.length === 0);
    await tx.categoryTemplate.update({ where: { id: t45.id }, data: { elements: fixtureDoc(736, 920) as unknown as Prisma.InputJsonValue } });
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
    await mapping.assignManualTemplates(tx, campaignA, { kind: 'days', dayNumbers: [10], templateId: other });
    t('template mapping change → outdated, no provider call', (await overview(campaignA)).days[9]!.state === 'outdated' && renders.length === rendersBefore);
    const regen = await generate(campaignA, d9.id, 'upcoming');
    const d9After = await dayRow(campaignA, 9);
    const versions = await tx.posterVersion.findMany({ where: { calendarDayId: d9.id }, orderBy: { versionNumber: 'asc' } });
    t('regenerating the outdated day: v2 current and active, v1 kept as outdated history', regen.outcome === 'generated' && versions.length === 2 && d9After.activePosterVersionId === versions[1]!.id && isVersionCurrent(versions[1]!, d9After) && !isVersionCurrent(versions[0]!, d9After));
    // Day 9's elements were saved (seeded with "Headline for day 9") at its first generation; the
    // headline edited through the old content path is not in them, so the columns follow the elements.
    t('…and the legacy headline follows the elements again', d9After.headline === 'Headline for day 9', String(d9After.headline));
  }

  // =======================================================================
  section('a claim lost before recording saves nothing');
  // =======================================================================
  {
    const d12 = await dayRow(campaignA, 12);
    const versionsBefore = await tx.posterVersion.count({ where: { calendarDayId: d12.id } });
    const studioRowsBefore = await tx.posterStudioGeneration.count();
    const counterBefore = fileCounter;
    const rendersBefore = renders.length;
    const otherClaim = new Date(NOW.getTime() + 60_000);
    // The attempt's text check outlives its claim: it goes stale and another run claims the day.
    onCheck = async () => {
      await tx.contentCalendar.update({ where: { id: d12.id }, data: { generationStatus: 'GENERATING', posterGenerationStartedAt: otherClaim } });
    };
    const lost = await generate(campaignA, d12.id, 'regenerate', true);
    const after = await dayRow(campaignA, 12);
    const storedThisRun = Array.from({ length: fileCounter - counterBefore }, (_, i) => `fake-drive-${counterBefore + i + 1}`);
    t('the attempt reports the lost claim: billed, nothing saved', lost.outcome === 'failed' && lost.billed && /another run took over this day/i.test(lost.message), snapshot(lost));
    t('…one image was paid for, no version and no studio row recorded', renders.length === rendersBefore + 1 && (await tx.posterVersion.count({ where: { calendarDayId: d12.id } })) === versionsBefore && (await tx.posterStudioGeneration.count()) === studioRowsBefore);
    t('…both files it stored were binned', storedThisRun.length === 2 && storedThisRun.every((id) => trashed.includes(id) && !drive.has(id)), snapshot(storedThisRun));
    t('…and the other run’s claim was left as it was, not marked FAILED', after.generationStatus === 'GENERATING' && after.posterGenerationStartedAt?.getTime() === otherClaim.getTime() && after.activePosterVersionId === d12.activePosterVersionId);
    await tx.contentCalendar.update({ where: { id: d12.id }, data: { generationStatus: 'SUCCEEDED', posterGenerationStartedAt: d12.posterGenerationStartedAt } });
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
    t('the edit becomes a new POSTER_STUDIO version, active, edited from the previous one', saved.ok && v?.source === 'POSTER_STUDIO' && v.parentVersionId === activeBefore.id && after.activePosterVersionId === v.id && v.imageDriveFileId === 'fake-edit-final', saved.ok ? '' : saved.error);
    t('the previous version is unchanged history', snapshot(await tx.posterVersion.findUniqueOrThrow({ where: { id: activeBefore.id } })) === snapshot(activeBefore));
    const again = await asAction(() => campaignActions.saveStudioPosterToCampaignDayAction(day.id, edit.id));
    t('saving the same studio poster twice creates no duplicate', again.ok && again.data.alreadySaved && (await tx.posterVersion.count({ where: { studioGenerationId: edit.id } })) === 1);
    const otherClient = await tx.posterStudioGeneration.create({ data: { mode: 'GENERATE', prompt: 'x', sentPrompt: 'x', aspectRatio: '9:16', size: '1152x2048', model: 'gpt-image-2', quality: 'low', imageDriveFileId: 'fake-other', imageMimeType: 'image/png', clientId: clientAuto.id } });
    const square = await tx.posterStudioGeneration.create({ data: { mode: 'GENERATE', prompt: 'x', sentPrompt: 'x', aspectRatio: '1:1', size: '1024x1024', model: 'gpt-image-2', quality: 'low', imageDriveFileId: 'fake-square', imageMimeType: 'image/png', clientId: clientA.id } });
    await expectDomainError('a poster made for another client is refused', 'invalid-input', () => posters.saveStudioPosterToCampaignDay(tx, day.id, otherClient.id));
    await expectDomainError('a poster in another shape than the day’s template is refused', 'invalid-input', () => posters.saveStudioPosterToCampaignDay(tx, day.id, square.id));

    // A 4:5 clone is accepted on a day whose template is 4:5, whatever the client preset.
    const t45 = await tx.categoryTemplate.findFirstOrThrow({ where: { label: 'check:posters Four five' } });
    const d11 = await dayRow(campaignA, 11);
    await mapping.assignManualTemplates(tx, campaignA, { kind: 'days', dayNumbers: [11], templateId: t45.id });
    const clone45 = await tx.posterStudioGeneration.create({ data: { mode: 'CLONE', prompt: 'x', sentPrompt: 'x', aspectRatio: '4:5', size: '1280x1600', model: 'gpt-image-2', quality: 'high', imageDriveFileId: 'fake-45', imageMimeType: 'image/png', clientId: clientA.id, sourceTemplateId: t45.id } });
    const saved45 = await posters.saveStudioPosterToCampaignDay(tx, d11.id, clone45.id);
    const v45 = await tx.posterVersion.findUniqueOrThrow({ where: { id: saved45.versionId } });
    t('a 4:5 clone saves to a day whose template is 4:5, keeping its source template', v45.templateId === t45.id);
    await expectDomainError('a 9:16 poster is refused on that 4:5 day', 'invalid-input', () => posters.saveStudioPosterToCampaignDay(tx, d11.id, edit.id));
    const context = await posters.loadCampaignDayStudioContext(tx, d11.id);
    t('the studio context gives the day’s poster shape; no studio format for 4:5', context?.posterAspect === '4:5' && context.aspectRatio === null, snapshot(context && { posterAspect: context.posterAspect, aspectRatio: context.aspectRatio }));
    const context3 = await posters.loadCampaignDayStudioContext(tx, day.id);
    t('a 9:16 template day maps to the studio 9:16 format', context3?.posterAspect === '9:16' && context3.aspectRatio === '9:16');

    // A day with no template: a Poster Studio poster saved to it makes the day READY, so it can be sent.
    const readyClient = await client('Studio only', { isActive: true, isDemo: false });
    const { campaignId: studioCampaign } = await createCampaign(tx, { clientId: readyClient.id, name: 'Studio only', startDate: today, durationDays: 3, timeZone: TZ });
    await changeCampaignStatus(tx, studioCampaign, 'ACTIVE');
    const bare = (await service.findCampaignDay(tx, studioCampaign, 2))!;
    t('fixture: the day has no template and its content is not ready', bare.posterTemplateId === null && bare.contentStatus !== 'READY', String(bare.contentStatus));
    const studioPoster = await tx.posterStudioGeneration.create({ data: { mode: 'GENERATE', prompt: 'x', sentPrompt: 'x', aspectRatio: '9:16', size: '1152x2048', model: 'gpt-image-2', quality: 'low', imageDriveFileId: 'fake-studio-only', imageMimeType: 'image/png', clientId: readyClient.id } });
    const savedBare = await posters.saveStudioPosterToCampaignDay(tx, bare.id, studioPoster.id);
    const bareAfter = await tx.contentCalendar.findUniqueOrThrow({ where: { id: bare.id } });
    t('saving a Poster Studio poster to it marks the day READY without moving its revision', bareAfter.contentStatus === 'READY' && bareAfter.contentIssues.length === 0 && bareAfter.contentRevision === bare.contentRevision && bareAfter.activePosterVersionId === savedBare.versionId);
    const studioDeliveryDeps = (await import('@/lib/campaign/delivery-service')).defaultDeliveryDeps({
      timeZone: TZ,
      now: () => NOW,
      whatsappConfigured: () => true,
      mediaConfigured: () => true,
      buildMediaUrl: async (versionId) => `https://console.invalid/api/campaign-media/${versionId}`,
      sendMedia: async () => {
        throw new Error('check:campaign-posters-db never sends');
      },
    });
    const approvedBare = await posters.approveCampaignDayPoster(tx, bare.id, savedBare.versionId, { deliveryDeps: studioDeliveryDeps });
    t('…so approving it books it, never refused as content-not-ready', approvedBare.booking?.result === 'booked' && approvedBare.booking.refusal === null, snapshot(approvedBare.booking));

    const deleted = await asAction(() => studioActions.deleteStudioGenerationAction(activeBefore.studioGenerationId!));
    t('Poster Studio refuses to delete a history item a campaign version uses', !deleted.ok && /campaign poster version/.test(deleted.ok ? '' : deleted.error) && (await tx.posterStudioGeneration.count({ where: { id: activeBefore.studioGenerationId! } })) === 1);
    const listing = await posters.listCampaignDayPosterVersions(tx, day.id);
    t('version history lists every version newest first, one active, no Drive ids', listing.versions.map((row) => row.versionNumber).join() === '3,2,1' && listing.versions.filter((row) => row.active).length === 1 && !snapshot(listing).includes('fake-drive-'));
  }

  // =======================================================================
  section('server actions');
  // =======================================================================
  {
    // The batch planner's action wrapper retired with the old generation panel;
    // the service still plans the board's bulk generation.
    const planned = posters.planPosterBatch(await overview(campaignA), { mode: 'missing' });
    t('planPosterBatch returns eligible count and grouped reasons', typeof planned.estimatedGenerations === 'number' && Array.isArray(planned.skipped));
    let invalidRefused = false;
    try {
      posters.planPosterBatch(await overview(campaignA), { mode: 'regenerate', fromDay: 9, toDay: 3 });
    } catch (error) {
      invalidRefused = error instanceof CampaignDomainError;
    }
    t('an invalid range is refused', invalidRefused);
    const status = await asAction(() => campaignActions.changeCampaignStatusAction(campaignA, 'PAUSED'));
    t('pausing the campaign blocks generation', status.ok && posters.planPosterBatch(await overview(campaignA), { mode: 'upcoming' }).estimatedGenerations === 0);
    await asAction(() => campaignActions.changeCampaignStatusAction(campaignA, 'ACTIVE'));
  }

  // =======================================================================
  section('isolation: legacy rows, WhatsApp, production');
  // =======================================================================
  t('legacy calendar rows are byte-identical', snapshot(await tx.contentCalendar.findMany({ where: { clientId: legacy.id } })) === legacyBefore);
  t('no calendar row of a campaign client is left without its campaign', (await tx.contentCalendar.count({ where: { clientId: clientA.id, campaignId: null } })) === 0);
  t('no WhatsApp usage and no delivery column on any campaign day', (await tx.usageEvent.count({ where: { provider: 'EVOLUTION' } })) === whatsappUsageBefore && (await tx.contentCalendar.count({ where: { campaignId: { not: null }, OR: [{ deliveryStatus: { not: 'PENDING' } }, { gDriveFileId: { not: null } }, { approvedAt: { not: null } }, { sendAfter: { not: null } }] } })) === 0);
  const imageUsageAdded = (await tx.usageEvent.count({ where: { provider: 'OPENAI' } })) - imageUsageBefore;
  t('only image usage rows were added, one per billed image', imageUsageAdded > 0 && (await tx.usageEvent.count()) - usageBefore === imageUsageAdded && imageUsageAdded === renders.length - renderRefusals, `${imageUsageAdded} rows, ${renders.length} requests, ${renderRefusals} refused`);
  t('ran against the local development database only', /evokz_ai_dev @ localhost/.test(databaseLabel), databaseLabel);
}

const TABLES = ['Client', 'Campaign', 'ContentCalendar', 'PosterVersion', 'PosterStudioGeneration', 'Category', 'CategoryTemplate', 'Plan', 'UsageEvent', 'CampaignDelivery'];
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
