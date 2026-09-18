/**
 * Database checks for Poster Studio's template poster editor services:
 *
 *   - `loadTemplateEditorScreen`      (src/lib/campaign/clone-editor-screen.ts)
 *   - `listCampaignDayTemplateChoices` / `changeCampaignDayTemplate`
 *                                      (src/lib/campaign/clone-template-change.ts)
 *   - `fixCampaignDayPosterText` / `editCampaignDayPoster`
 *                                      (src/lib/campaign/clone-fix.ts)
 *   - `setCampaignDayLogoPlacement`    (src/lib/campaign/clone-logo.ts)
 *   - their server actions             (src/app/admin/campaigns/clone-actions.ts)
 *
 * No model is called. The image model, Google Drive, the logo download and the
 * text read-back are in-process fakes (`PosterGenerationDeps`); the element
 * resolution, template image preparation, decode check, logo compositing, usage
 * ledger, studio rows, versions and claims are the real ones. The OpenAI key is
 * blanked, so an action that reaches the real pipeline refuses before any call.
 *
 * How it stays harmless (the `check:campaign-posters-db` technique): one
 * interactive transaction, always rolled back, with savepoints for nested
 * transactions; table row counts compared before and after; `fetch` stubbed and
 * counted; refuses anything but a local development database.
 *
 * Run: npm run check:campaign-clone-edit-db
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
  throw new Error('network disabled by check:campaign-clone-edit-db');
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

type Kind = import('@/lib/types/template-elements').TemplateElementKind;
const element = (id: string, kind: Kind, text: string | null, box: [number, number, number, number], extra: { group?: string; description?: string } = {}) => ({
  id,
  kind,
  text,
  box: { x: box[0], y: box[1], w: box[2], h: box[3] },
  group: extra.group ?? null,
  description: extra.description ?? null,
});

function fixtureDoc(headline: string, width = 1080, height = 1350) {
  return {
    version: 1,
    width,
    height,
    model: 'fake-reader',
    elements: [
      element('e1', 'logo', null, [0.05, 0.03, 0.12, 0.07], { description: 'cross mark' }),
      element('e2', 'brandName', 'Old Clinic', [0.19, 0.04, 0.3, 0.04]),
      element('e3', 'headline', headline, [0.05, 0.15, 0.6, 0.12]),
      element('e4', 'subheadline', 'Gentle care for the whole family.', [0.05, 0.3, 0.5, 0.05]),
      element('e5', 'photo', null, [0.45, 0.25, 0.55, 0.55], { description: 'dentist with a child' }),
      element('e6', 'feature', 'Painless check-ups', [0.05, 0.45, 0.3, 0.03], { group: 'features' }),
      element('e7', 'feature', 'Weekend opening hours', [0.05, 0.5, 0.3, 0.03], { group: 'features' }),
      element('e8', 'text', 'Choose Old Clinic.', [0.05, 0.6, 0.3, 0.03]),
      element('e9', 'cta', 'Book a visit', [0.05, 0.84, 0.3, 0.04]),
      element('e10', 'phone', '+1 555 0100', [0.05, 0.89, 0.25, 0.03], { group: 'contact' }),
      element('e11', 'website', 'www.oldclinic.example', [0.35, 0.89, 0.3, 0.03], { group: 'contact' }),
      element('e12', 'address', '12 Old Road', [0.18, 0.94, 0.3, 0.03], { group: 'contact' }),
    ],
  };
}

/** Whether any value in a structure is a Date — the browser view must carry none. */
function containsDate(value: unknown): boolean {
  if (value instanceof Date) return true;
  if (Array.isArray(value)) return value.some(containsDate);
  if (value && typeof value === 'object') return Object.values(value).some(containsDate);
  return false;
}

async function suite(): Promise<void> {
  const tx = facade;
  const service = await import('@/lib/campaign/service');
  const cloneQueue = await import('@/lib/campaign/clone-queue');
  const editor = await import('@/lib/campaign/clone-editor');
  const screenModule = await import('@/lib/campaign/clone-editor-screen');
  const change = await import('@/lib/campaign/clone-template-change');
  const fixModule = await import('@/lib/campaign/clone-fix');
  const logoModule = await import('@/lib/campaign/clone-logo');
  const posters = await import('@/lib/campaign/poster-generation-service');
  const cloneActions = await import('@/app/admin/campaigns/clone-actions');
  const delivery = await import('@/lib/campaign/delivery-service');
  const { StudioError } = await import('@/lib/poster-studio/errors');
  const { prepareCloneTemplateImage, readStudioImageSize } = await import('@/lib/poster-studio/images');
  const { composeCloneIdentity } = await import('@/lib/poster-studio/clone-identity');
  const { hasBrandCanvasLogo } = await import('@/lib/poster-studio/brand-logo');
  const { recordOpenAiImageUsage } = await import('@/lib/usage');
  const { loadStudioBrandCanvas } = await import('@/lib/poster-studio/brand-context');
  const { parseDayPosterElements, parseTextCheck } = await import('@/lib/types/template-elements');
  const { addZonedDays, startOfZonedDay } = await import('@/lib/time');
  const { CampaignDomainError, addPosterVersion, changeCampaignStatus, createCampaign, selectDayTemplate } = service;
  type Deps = import('@/lib/campaign/poster-generation-service').PosterGenerationDeps;
  type TextCheckResult = import('@/lib/types/template-elements').TextCheckResult;

  const TZ = 'Asia/Kolkata';
  const NOW = new Date();
  const today = startOfZonedDay(NOW, TZ);
  const load = { timeZone: TZ, now: NOW };

  async function expectDomainError(name: string, code: string, work: () => Promise<unknown>, pattern?: RegExp) {
    try {
      await work();
      t(name, false, 'succeeded but should have failed');
    } catch (error) {
      t(name, error instanceof CampaignDomainError && error.code === code && (!pattern || pattern.test(error.message)), error instanceof Error ? `${(error as { code?: string }).code ?? ''} ${error.message}` : String(error));
    }
  }

  // ---- Fakes: image model, Drive, logo, text check ----------------------------------
  const png = (width: number, height: number, color: string) => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
  const pixelOf = async (bytes: Buffer, x: number, y: number) => {
    const { data } = await sharp(bytes).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return [data[0], data[1], data[2]];
  };
  const templatePng = await png(1080, 1350, '#3366aa');
  const logoPng = await png(200, 100, '#ff0000');
  const drive = new Map<string, { fileName: string; body: Buffer }>();
  const readFiles: string[] = [];
  const renders: Array<{ prompt: string; size: string; quality: string | undefined; image: Buffer | null }> = [];
  const textChecks: Array<{ bytes: Buffer; ids: string[] }> = [];
  let renderMode: 'ok' | 'moderation' = 'ok';
  let checkMode: 'issues' | 'ok' | 'throw' = 'issues';
  let configured = true;
  let usageCalls = 0;
  let fileCounter = 0;
  let onCompose: (() => Promise<void>) | null = null;
  let onCheck: (() => Promise<void>) | null = null;

  const fakeCheck = (input: Parameters<Deps['checkText']>[0]): TextCheckResult => {
    const headline = input.resolved.find((item) => item.element.id === 'e3');
    const expected = headline?.action.type === 'replace' ? headline.action.text : (headline?.element.text ?? '');
    return checkMode === 'ok'
      ? { checkedAt: NOW.toISOString(), model: 'fake-reader', ok: true, items: [{ elementId: 'e3', label: 'Headline', expected, found: expected, match: true }], leftovers: [] }
      : {
          checkedAt: NOW.toISOString(),
          model: 'fake-reader',
          ok: false,
          items: [{ elementId: 'e3', label: 'Headline', expected, found: expected.replace('Headline', 'Headlne'), match: false }],
          leftovers: ['Old Clinic'],
        };
  };

  const deps: Deps = {
    assertConfigured: () => {
      if (!configured) throw new StudioError('config', 'OPENAI_API_KEY is not set on the server.');
    },
    loadBrandCanvas: loadStudioBrandCanvas,
    resolveLogo: async (canvas) =>
      hasBrandCanvasLogo(canvas.logo)
        ? { background: 'ORIGINAL', processing: 'as-uploaded', bytes: logoPng, mimeType: 'image/png', isSvg: false, width: 200, height: 100, inkLuminance: null }
        : null,
    resolveFolder: async () => 'fixture-folder',
    readFile: async (fileId) => {
      readFiles.push(fileId);
      if (fileId.startsWith('fixture-template')) return templatePng;
      const file = drive.get(fileId);
      if (!file) throw new StudioError('storage', 'Could not load the selected image from Google Drive.');
      return file.body;
    },
    prepareTemplate: prepareCloneTemplateImage,
    render: async (request) => {
      renders.push({ prompt: request.prompt, size: request.size, quality: request.quality, image: request.image?.bytes ?? null });
      if (renderMode === 'moderation') throw new StudioError('moderation', 'OpenAI declined this request under its safety policy.');
      const [width, height] = request.size.split('x').map(Number) as [number, number];
      return { bytes: await png(width, height, '#ffffff'), mimeType: 'image/png', model: 'gpt-image-2', quality: request.quality ?? 'low', usage: { textInputTokens: 100, imageInputTokens: 900, outputTokens: 4000 } };
    },
    recordUsage: async (...args) => {
      usageCalls += 1;
      await recordOpenAiImageUsage(...args);
    },
    readImageSize: readStudioImageSize,
    composeIdentity: async (raw, input) => {
      const hook = onCompose;
      onCompose = null;
      await hook?.();
      return composeCloneIdentity(raw, input);
    },
    checkText: async (input) => {
      const hook = onCheck;
      onCheck = null;
      await hook?.();
      textChecks.push({ bytes: input.bytes, ids: input.resolved.map((item) => item.element.id) });
      if (checkMode === 'throw') throw new Error('fake text check failure');
      return fakeCheck(input);
    },
    store: async ({ fileName, body }) => {
      const id = `fake-drive-${(fileCounter += 1)}`;
      drive.set(id, { fileName, body });
      return id;
    },
    trash: async (ids) => {
      for (const id of ids) drive.delete(id);
    },
  };

  // ---- Fixtures -----------------------------------------------------------------------
  const plan = await tx.plan.create({ data: { name: 'check:clone-edit 10', durationDays: 10 } });
  const vertical = await tx.category.create({ data: { name: 'check:clone-edit Vertical' } });
  const otherVertical = await tx.category.create({ data: { name: 'check:clone-edit Other vertical' } });
  let order = 0;
  const template = (label: string, data: Partial<Prisma.CategoryTemplateUncheckedCreateInput> = {}) =>
    tx.categoryTemplate.create({
      data: {
        categoryId: vertical.id,
        label: `check:clone-edit ${label}`,
        gDriveFileId: `fixture-template-${label}`,
        gDriveViewUrl: 'https://drive.invalid/t',
        mimeType: 'image/png',
        width: 1080,
        height: 1350,
        elements: fixtureDoc(`Headline of ${label}`) as unknown as Prisma.InputJsonValue,
        elementsReadAt: new Date(),
        createdAt: new Date(Date.parse('2026-01-01') + (order += 1) * 1000),
        ...data,
      },
    });
  const tA = await template('A');
  const tB = await template('B');
  const tC = await template('C');
  const tInactive = await template('Inactive', { isActive: false });
  const tUnread = await template('Unread', { elements: Prisma.DbNull, elementsReadAt: null });
  const tOther = await template('Other', { categoryId: otherVertical.id });

  const client = await tx.client.create({
    data: {
      companyName: 'Clone Dental',
      whatsappNumber: '919876500222',
      cronTime: '23:59',
      displayPhone: '080 4000 1234',
      startDate: today,
      endDate: today,
      planId: plan.id,
      categoryId: vertical.id,
      isDemo: true,
      isActive: false,
      imageSizePreset: 'whatsapp-status',
      brandGuideline: { colors: [{ hex: '#0e7c86', role: 'primary' }], typography: null, layoutDirectives: [], assets: [] },
      brandTagline: 'Smiles made simple',
      websiteUrl: 'https://clone-edit-fixture.invalid/',
      logoUrl: 'https://logo.invalid/clinic.png',
      gDriveFolderId: 'SECRET-CLONE-EDIT-FOLDER',
    },
  });
  const { campaignId } = await createCampaign(tx, { clientId: client.id, name: 'Clone edit', startDate: addZonedDays(today, -2, TZ), timeZone: TZ });
  await cloneQueue.cloneTemplatesIntoCampaign(tx, campaignId, load);
  const rowAt = async (n: number) => (await service.findCampaignDay(tx, campaignId, n))!;
  const day = async (n: number) => tx.contentCalendar.findUniqueOrThrow({ where: { id: (await rowAt(n)).id } });
  const generate = (dayId: string) => posters.generateCampaignDayPoster(tx, campaignId, dayId, { ...load, mode: 'missing', explicit: true, deps });

  // =======================================================================
  section('editor screen: load');
  // =======================================================================
  {
    const d3 = await rowAt(3);
    const loaded = await screenModule.loadTemplateEditorScreen(tx, d3.id, load);
    t('a filled day opens the editor', loaded.kind === 'editor');
    if (loaded.kind === 'editor') {
      const screen = loaded.screen;
      t('its template, read document and elements', screen.template.id === tC.id && screen.template.doc.elements.length === 12 && screen.elements.templateId === tC.id && screen.template.aspectLabel === '4:5');
      t('the day, campaign and client', screen.day.dayNumber === 3 && screen.day.contentRevision === d3.contentRevision && screen.campaign.id === campaignId && screen.campaign.status === 'DRAFT' && screen.campaign.totalDays === 10 && screen.client.companyName === 'Clone Dental');
      t('the board’s status and actions for the day (a draft campaign cannot generate)', screen.status.board === 'draft' && screen.actions.canGenerate === false && screen.activeVersion === null && screen.versions.length === 0);
      t('previous and next day', screen.nav.prev?.dayNumber === 2 && screen.nav.next?.dayNumber === 4 && screen.nav.next.id === (await rowAt(4)).id);
      t('links: the board on week 1, Brand Canvas back to this editor', screen.links.board === `/admin/clients/${client.id}/campaigns/${campaignId}?week=1` && screen.links.brandCanvas === `/admin/clients/${client.id}/brand?return=${encodeURIComponent(`/admin/poster-studio?campaignDay=${d3.id}`)}`);
      t('Brand Canvas values and colours', screen.brand.companyName === 'Clone Dental' && screen.brand.hasLogo && screen.colourMode === 'brand' && screen.brand.logoUrl !== null);
      t('serializable: no Date anywhere', !containsDate(screen));
      t('no Drive id, folder or WhatsApp number in the view', !['SECRET-CLONE-EDIT-FOLDER', 'fixture-template-', '919876500222'].some((secret) => snapshot(screen).includes(secret)));
    }
    const past = await screenModule.loadTemplateEditorScreen(tx, (await rowAt(1)).id, load);
    t('a day with no template: no editor, and says so', past.kind === 'no-template' && past.dayNumber === 1);
    const d9 = await rowAt(9);
    await selectDayTemplate(tx, d9.id, tUnread.id);
    const unread = await screenModule.loadTemplateEditorScreen(tx, d9.id, load);
    t('a day on a template not read yet: no editor, the template is named', unread.kind === 'unread' && unread.templateLabel === 'check:clone-edit Unread', snapshot(unread));
    await selectDayTemplate(tx, d9.id, tA.id);
    await expectDomainError('a missing day is not found', 'not-found', () => screenModule.loadTemplateEditorScreen(tx, 'b0000000-0000-4000-8000-000000000000', load));
    const action = await asAction(() => cloneActions.loadTemplateEditorScreenAction(d3.id));
    t('the load action returns the editor view', action.ok && action.data.kind === 'editor' && action.data.screen.day.id === d3.id);
    const refused = await asAction(() => cloneActions.loadTemplateEditorScreenAction('not-a-uuid'));
    t('…and refuses a malformed id', !refused.ok);
  }

  // =======================================================================
  section('template choices');
  // =======================================================================
  const tWide = await template('Wide', { width: 2000, height: 400, elements: fixtureDoc('Headline of Wide', 2000, 400) as unknown as Prisma.InputJsonValue });
  {
    const choices = await change.listCampaignDayTemplateChoices(tx, (await rowAt(3)).id);
    t('the vertical’s active, read templates in upload order', snapshot(choices.map((choice) => choice.id)) === snapshot([tA.id, tB.id, tC.id, tWide.id]), snapshot(choices.map((choice) => choice.label)));
    t('the day’s own template is marked current', choices.find((choice) => choice.current)?.id === tC.id && choices.filter((choice) => choice.current).length === 1);
    t('each has a summary and thumbnail; a shape clones cannot use is marked', choices[0]!.summary.includes('headline') && choices[0]!.thumbnailUrl === `/api/templates/${tA.id}/thumbnail?w=320` && choices[0]!.aspectLabel === '4:5' && choices[3]!.usable === false && choices[0]!.usable);
    const action = await asAction(async () => cloneActions.listCampaignDayTemplateChoicesAction((await rowAt(3)).id));
    t('the choices action', action.ok && action.data.length === 4);
  }

  // =======================================================================
  section('change template');
  // =======================================================================
  {
    const d4 = await rowAt(4);
    t('fixture: day 4 holds template A', d4.posterTemplateId === tA.id);
    const edited = await editor.updateCampaignDayElements(tx, d4.id, { values: [{ id: 'e3', text: 'My own headline' }, { id: 'e7', removed: true }], imagePrompt: 'a hygienist with a teenager' }, { expectedRevision: d4.contentRevision });
    const before = await day(4);

    await expectDomainError('a stale revision is a conflict', 'conflict', () => change.changeCampaignDayTemplate(tx, d4.id, tB.id, { ...load, expectedRevision: edited.contentRevision - 1 }));
    await expectDomainError('an inactive template is refused', 'template-not-assignable', () => change.changeCampaignDayTemplate(tx, d4.id, tInactive.id, { ...load, expectedRevision: edited.contentRevision }), /inactive/);
    await expectDomainError('another vertical’s template is refused', 'template-not-assignable', () => change.changeCampaignDayTemplate(tx, d4.id, tOther.id, { ...load, expectedRevision: edited.contentRevision }), /another vertical/);
    await expectDomainError('a template not read yet is refused', 'invalid-transition', () => change.changeCampaignDayTemplate(tx, d4.id, tUnread.id, { ...load, expectedRevision: edited.contentRevision }), /not read yet/);
    await expectDomainError('a shape clones cannot be made in is refused', 'invalid-transition', () => change.changeCampaignDayTemplate(tx, d4.id, tWide.id, { ...load, expectedRevision: edited.contentRevision }), /shape/);
    t('refusals write nothing', snapshot(await day(4)) === snapshot(before));

    const result = await change.changeCampaignDayTemplate(tx, d4.id, tB.id, { ...load, expectedRevision: edited.contentRevision });
    const after = await day(4);
    const stored = parseDayPosterElements(after.posterElements)!;
    const value = (id: string) => stored.values.find((entry) => entry.id === id)!;
    t('the day now uses the new template', after.posterTemplateId === tB.id && after.templateSelectedAt !== null && result.templateId === tB.id && result.templateLabel === 'check:clone-edit B');
    t('its elements are a fresh clone of it: edits gone, removals reset', stored.templateId === tB.id && value('e3').text === 'Headline of B' && value('e7').removed === false && stored.values.every((entry) => entry.source === 'template'));
    t('the template’s business name is swapped for the client’s; unbound identity hidden', value('e8').text === 'Choose Clone Dental.' && value('e12').removed === true && value('e10').text === null);
    t('headline follows; content READY; the image prompt is kept', after.headline === 'Headline of B' && after.contentStatus === 'READY' && after.imagePrompt === 'a hygienist with a teenager');
    t('the revision moves by one, and the result says so', result.changed && result.revisionBumped && after.contentRevision === before.contentRevision + 1 && result.contentRevision === after.contentRevision);

    const same = await change.changeCampaignDayTemplate(tx, d4.id, tB.id, { ...load, expectedRevision: after.contentRevision });
    t('choosing the same template on an untouched clone changes nothing', !same.changed && (await day(4)).contentRevision === after.contentRevision);

    const d5 = await rowAt(5);
    await tx.contentCalendar.update({ where: { id: d5.id }, data: { generationStatus: 'GENERATING', posterGenerationStartedAt: new Date() } });
    await expectDomainError('a day being generated is refused', 'invalid-transition', () => change.changeCampaignDayTemplate(tx, d5.id, tA.id, { ...load, expectedRevision: d5.contentRevision }), /being generated/);
    await tx.contentCalendar.update({ where: { id: d5.id }, data: { generationStatus: 'NOT_REQUESTED', posterGenerationStartedAt: null } });
    t('…with nothing written', (await day(5)).posterTemplateId === d5.posterTemplateId && (await day(5)).contentRevision === d5.contentRevision);

    const d2 = await rowAt(2);
    await expectDomainError('a past (locked) day is refused', 'invalid-transition', () => change.changeCampaignDayTemplate(tx, d2.id, tA.id, { ...load, expectedRevision: d2.contentRevision }), /passed/);

    const action = await asAction(() => cloneActions.changeCampaignDayTemplateAction(d4.id, tC.id, after.contentRevision));
    t('the change action re-clones and returns the new revision', action.ok && action.data.templateId === tC.id && action.data.contentRevision === after.contentRevision + 1 && (await day(4)).posterTemplateId === tC.id);
    const stale = await asAction(() => cloneActions.changeCampaignDayTemplateAction(d4.id, tA.id, after.contentRevision));
    t('…and reports a stale tab as a conflict', !stale.ok && /changed by someone else/.test(stale.error));
  }

  // =======================================================================
  section('fix text: refusals before any spend');
  // =======================================================================
  await changeCampaignStatus(tx, campaignId, 'ACTIVE');
  {
    // Only an ACTIVE campaign's queued day is waiting for a worker; that one is refused.
    const d7 = await rowAt(7);
    await tx.contentCalendar.update({ where: { id: d7.id }, data: { generationStatus: 'QUEUED' } });
    await expectDomainError('a queued day of an active campaign cannot change template', 'invalid-transition', () => change.changeCampaignDayTemplate(tx, d7.id, tA.id, { ...load, expectedRevision: d7.contentRevision }), /being generated/);
    await tx.contentCalendar.update({ where: { id: d7.id }, data: { generationStatus: 'NOT_REQUESTED' } });
    t('…with nothing written', (await day(7)).contentRevision === d7.contentRevision && (await day(7)).posterTemplateId === d7.posterTemplateId);
  }
  const d6 = await rowAt(6);
  const d8 = await rowAt(8);
  const d10 = await rowAt(10);
  {
    checkMode = 'issues';
    const g6 = await generate(d6.id);
    checkMode = 'throw';
    const g8 = await generate(d8.id);
    checkMode = 'ok';
    const g10 = await generate(d10.id);
    t('fixture: days 6, 8 and 10 generated (with differences, unchecked, correct)', g6.outcome === 'generated' && g8.outcome === 'generated' && g10.outcome === 'generated', snapshot([g6.outcome, g8.outcome, g10.outcome]));

    const rendersBefore = renders.length;
    await expectDomainError('no poster yet is refused', 'invalid-transition', async () => fixModule.fixCampaignDayPosterText(tx, (await rowAt(7)).id, { deps }), /no poster/);
    await expectDomainError('a poster never text-checked is refused', 'invalid-transition', () => fixModule.fixCampaignDayPosterText(tx, d8.id, { deps }), /no text check/);
    await expectDomainError('a poster whose text check found nothing is refused', 'invalid-transition', () => fixModule.fixCampaignDayPosterText(tx, d10.id, { deps }), /no differences/);

    const d5 = await rowAt(5);
    await addPosterVersion(tx, { calendarDayId: d5.id, source: 'MANUAL_UPLOAD', imageDriveFileId: 'fake-upload', imageMimeType: 'image/png', contentRevision: d5.contentRevision });
    await expectDomainError('an uploaded poster is refused', 'invalid-transition', () => fixModule.fixCampaignDayPosterText(tx, d5.id, { deps }), /uploaded/);

    await tx.contentCalendar.update({ where: { id: d6.id }, data: { generationStatus: 'GENERATING', posterGenerationStartedAt: new Date() } });
    await expectDomainError('a day holding a live generation claim is refused', 'conflict', () => fixModule.fixCampaignDayPosterText(tx, d6.id, { deps }), /being generated/);
    await tx.contentCalendar.update({ where: { id: d6.id }, data: { generationStatus: 'QUEUED' } });
    await expectDomainError('…and a queued day', 'conflict', () => fixModule.fixCampaignDayPosterText(tx, d6.id, { deps }));
    await tx.contentCalendar.update({ where: { id: d6.id }, data: { generationStatus: 'SUCCEEDED' } });

    await changeCampaignStatus(tx, campaignId, 'PAUSED');
    await expectDomainError('a paused campaign is refused', 'invalid-transition', () => fixModule.fixCampaignDayPosterText(tx, d6.id, { deps }), /activate/);
    await changeCampaignStatus(tx, campaignId, 'ACTIVE');

    configured = false;
    const noKey = await fixModule.fixCampaignDayPosterText(tx, d6.id, { deps });
    configured = true;
    t('without an API key: failed before the claim, the day untouched', noKey.outcome === 'failed' && noKey.kind === 'config' && (await day(6)).generationStatus === 'SUCCEEDED');
    t('no refusal reached the image model', renders.length === rendersBefore);
  }

  // =======================================================================
  section('fix text');
  // =======================================================================
  {
    const before = await day(6);
    const v1 = await tx.posterVersion.findUniqueOrThrow({ where: { id: before.activePosterVersionId! }, include: { studioGeneration: true } });
    const v1Generation = v1.studioGeneration!;
    const v1Check = parseTextCheck(v1.textCheck)!;
    const rendersBefore = renders.length;
    const checksBefore = textChecks.length;
    const usageBefore = usageCalls;
    readFiles.length = 0;

    // Mid-pipeline, after the image came back: a generation and a second fix try the same day.
    let raced: Awaited<ReturnType<typeof generate>> | null = null;
    let secondFix: unknown = null;
    onCompose = async () => {
      raced = await posters.generateCampaignDayPoster(tx, campaignId, d6.id, { ...load, now: new Date(), mode: 'regenerate', explicit: true, deps });
      try {
        await fixModule.fixCampaignDayPosterText(tx, d6.id, { deps });
      } catch (error) {
        secondFix = error;
      }
    };
    checkMode = 'ok';
    const result = await fixModule.fixCampaignDayPosterText(tx, d6.id, { deps });
    const racedOutcome = raced as Awaited<ReturnType<typeof generate>> | null;
    t('the fix produced a new version', result.outcome === 'revised' && result.versionNumber === 2 && result.approvalStatus === 'PENDING', snapshot(result));
    t('while it ran, a generation of the same day was skipped (generating)', racedOutcome?.outcome === 'skipped' && racedOutcome.reason === 'generating', snapshot(racedOutcome));
    t('…and a second fix was refused as a conflict', secondFix instanceof CampaignDomainError && secondFix.code === 'conflict');
    t('exactly one image call', renders.length === rendersBefore + 1);

    const request = renders[renders.length - 1]!;
    t('rendered at the clone’s own size, at high quality', request.size === '1280x1600' && request.quality === 'high' && request.size === v1Generation.size);
    const sent = await sharp(request.image!).metadata();
    t('the image sent is at that size', sent.width === 1280 && sent.height === 1600);
    // Logo box e1: x 0.05 y 0.03 w 0.12 h 0.07 of 1280x1600 → centre ≈ (141, 104).
    const rawV1 = drive.get(v1Generation.imageDriveFileId)!.body;
    const finalV1 = drive.get(v1Generation.finalImageDriveFileId!)!.body;
    t('the image sent is the RAW artwork (no logo), never the final poster', snapshot(await pixelOf(request.image!, 141, 104)) === snapshot([255, 255, 255]) && snapshot(await pixelOf(finalV1, 141, 104)) === snapshot([255, 0, 0]) && rawV1.length > 0);
    t('…read from the source version’s raw file only', readFiles.includes(v1Generation.imageDriveFileId) && !readFiles.includes(v1Generation.finalImageDriveFileId!));
    const found = v1Check.items[0]!.found!;
    t('the prompt corrects exactly the text check’s differences', request.prompt.includes(`change the text "${found}" to exactly "Headline of C"`) && request.prompt.includes('Erase "Old Clinic"') && /keep everything else exactly as it is/.test(request.prompt), request.prompt.split('\n\n')[1]);
    t('…and names no identity it should not', !request.prompt.includes('SECRET') && !request.prompt.includes(client.id));

    const after = await day(6);
    const v2 = await tx.posterVersion.findUniqueOrThrow({ where: { id: result.outcome === 'revised' ? result.versionId : '' }, include: { studioGeneration: true } });
    const g2 = v2.studioGeneration!;
    t('v2 is active; the day’s status SUCCEEDED', after.activePosterVersionId === v2.id && after.generationStatus === 'SUCCEEDED' && after.errorMessage === null);
    t('v2: POSTER_STUDIO, edited from v1, same template and content revision', v2.source === 'POSTER_STUDIO' && v2.parentVersionId === v1.id && v2.templateId === tC.id && v2.contentRevision === v1.contentRevision && v2.contentRevision === after.contentRevision);
    t('studio row: EDIT of the source row, the source’s raw file as input, the template kept', g2.mode === 'EDIT' && g2.parentGenerationId === v1Generation.id && g2.referenceDriveFileId === v1Generation.imageDriveFileId && g2.sourceTemplateId === tC.id && g2.size === '1280x1600' && g2.aspectRatio === v1Generation.aspectRatio && g2.sentPrompt === request.prompt);
    t('…RAW and FINAL stored separately, the logo composited on FINAL', g2.imageDriveFileId !== g2.finalImageDriveFileId && snapshot(g2.overlayElements) === snapshot(['logo']) && snapshot(await pixelOf(drive.get(g2.finalImageDriveFileId!)!.body, 141, 104)) === snapshot([255, 0, 0]) && /text-fix/.test(drive.get(g2.imageDriveFileId)!.fileName));
    t('the text check ran again, on the new final poster', textChecks.length === checksBefore + 1 && textChecks[textChecks.length - 1]!.bytes.equals(drive.get(g2.finalImageDriveFileId!)!.body));
    t('…and its result is stored on v2', parseTextCheck(v2.textCheck)?.ok === true && result.outcome === 'revised' && result.textCheckIssues === 0);
    t('usage recorded once', usageCalls === usageBefore + 1 && (await tx.usageEvent.count({ where: { calendarId: d6.id } })) === 2);
    t('v1 is kept, unchanged', (await tx.posterVersion.count({ where: { calendarDayId: d6.id } })) === 2 && (await tx.posterVersion.findUniqueOrThrow({ where: { id: v1.id } })).imageDriveFileId === v1.imageDriveFileId);

    await expectDomainError('a fixed poster with nothing left to fix is refused', 'invalid-transition', () => fixModule.fixCampaignDayPosterText(tx, d6.id, { deps }), /no differences/);

    // The day's words change: its poster is outdated, and fixing the old words would be wrong.
    const edited = await editor.updateCampaignDayElements(tx, d6.id, { values: [{ id: 'e4', text: 'A new sub-headline for the day.' }] }, { expectedRevision: after.contentRevision });
    await tx.posterVersion.update({ where: { id: v2.id }, data: { textCheck: v1.textCheck as Prisma.InputJsonValue } });
    await expectDomainError('an outdated poster is refused', 'invalid-transition', () => fixModule.fixCampaignDayPosterText(tx, d6.id, { deps }), /outdated/);
    t('fixture: the edit moved the revision', edited.revisionBumped);
  }

  // =======================================================================
  section('small change');
  // =======================================================================
  {
    await expectDomainError('an instruction that says nothing is refused', 'invalid-input', () => fixModule.editCampaignDayPoster(tx, d10.id, '  ok ', { deps }));
    await expectDomainError('a day with no poster is refused', 'invalid-transition', async () => fixModule.editCampaignDayPoster(tx, (await rowAt(7)).id, 'make the background lighter', { deps }), /no poster/);

    const before = await day(10);
    const v1 = await tx.posterVersion.findUniqueOrThrow({ where: { id: before.activePosterVersionId! }, include: { studioGeneration: true } });
    const rendersBefore = renders.length;
    const checksBefore = textChecks.length;
    checkMode = 'issues';
    const result = await fixModule.editCampaignDayPoster(tx, d10.id, '  make the   background lighter ', { deps });
    const request = renders[renders.length - 1]!;
    t('the change produced a new version', result.outcome === 'revised' && result.versionNumber === 2, snapshot(result));
    t('one image call with the instruction, at the clone size and high quality', renders.length === rendersBefore + 1 && request.prompt.includes('Make this change:\n\nmake the background lighter') && /change nothing else/.test(request.prompt) && request.size === '1280x1600' && request.quality === 'high');
    t('the image sent is the source version’s raw artwork', snapshot(await pixelOf(request.image!, 141, 104)) === snapshot([255, 255, 255]));
    const v2 = await tx.posterVersion.findUniqueOrThrow({ where: { id: result.outcome === 'revised' ? result.versionId : '' }, include: { studioGeneration: true } });
    t('v2: POSTER_STUDIO from v1; the studio row records the instruction', v2.source === 'POSTER_STUDIO' && v2.parentVersionId === v1.id && v2.studioGeneration?.mode === 'EDIT' && v2.studioGeneration.prompt === 'make the background lighter' && v2.studioGeneration.parentGenerationId === v1.studioGenerationId && /-edit-/.test(drive.get(v2.studioGeneration.imageDriveFileId)!.fileName));
    t('the text check ran on it and its differences are reported', textChecks.length === checksBefore + 1 && result.outcome === 'revised' && result.textCheckIssues === 2 && parseTextCheck(v2.textCheck)?.ok === false);
    t('v2 is active', (await day(10)).activePosterVersionId === v2.id);

    // A refused render: nothing saved, the day recoverable, the poster unchanged.
    renderMode = 'moderation';
    const filesBefore = drive.size;
    const failed = await fixModule.editCampaignDayPoster(tx, d10.id, 'add a cartoon mascot', { deps });
    renderMode = 'ok';
    const afterFailure = await day(10);
    t('a refused render fails the change, not billed', failed.outcome === 'failed' && failed.kind === 'moderation' && !failed.billed, snapshot(failed));
    t('…the day is FAILED with the reason, its poster still v2, nothing stored', afterFailure.generationStatus === 'FAILED' && /safety policy/.test(afterFailure.errorMessage ?? '') && afterFailure.activePosterVersionId === v2.id && drive.size === filesBefore && (await tx.posterVersion.count({ where: { calendarDayId: d10.id } })) === 2);
    const retried = await fixModule.fixCampaignDayPosterText(tx, d10.id, { deps });
    t('…and can be tried again (a fix after the failure runs)', retried.outcome === 'revised' && (await day(10)).generationStatus === 'SUCCEEDED');
  }

  // =======================================================================
  section('logo placement: free, no model, no usage');
  // =======================================================================
  {
    // Logo box e1 is x 0.05 y 0.03 w 0.12 h 0.07 of a 1280×1600 clone, so the mark
    // is fitted into pixels 64..218 × 48..160, inset by 7. The fake logo is 200×100,
    // which fits to 140×70: centred by default at y 69..139, and pushed to the
    // bottom-right corner at y 83..153. One probe in each band therefore says
    // exactly where the mark landed, with no tolerance to argue about.
    const placement = { scale: 1, anchor: 'right', vAnchor: 'bottom' } as const;
    const RED = snapshot([255, 0, 0]);
    const WHITE = snapshot([255, 255, 255]);
    const marked = async (bytes: Buffer) => snapshot([await pixelOf(bytes, 100, 150), await pixelOf(bytes, 100, 75)]);
    const PLACED = snapshot([[255, 0, 0], [255, 255, 255]]);
    const CENTRED = snapshot([[255, 255, 255], [255, 0, 0]]);

    const before = await day(10);
    const v3 = await tx.posterVersion.findUniqueOrThrow({ where: { id: before.activePosterVersionId! }, include: { studioGeneration: true } });
    const parent = v3.studioGeneration!;
    t('fixture: the poster on day 10 has the mark where code put it', (await marked(drive.get(parent.finalImageDriveFileId!)!.body)) === CENTRED);

    const rendersBefore = renders.length;
    const checksBefore = textChecks.length;
    const usageBefore = usageCalls;
    const usageRowsBefore = await tx.usageEvent.count({ where: { calendarId: d10.id } });
    readFiles.length = 0;

    const result = await logoModule.setCampaignDayLogoPlacement(tx, d10.id, placement, { deps, ...load });
    t('placing the logo made a new version', result.outcome === 'placed' && result.versionNumber === 4 && /No AI, nothing billed/.test(result.message), snapshot(result));

    const after = await day(10);
    const v4 = await tx.posterVersion.findUniqueOrThrow({ where: { id: result.outcome === 'placed' ? result.versionId : '' }, include: { studioGeneration: true } });
    const g4 = v4.studioGeneration!;
    t('no image model call, no usage recorded, no text check run', renders.length === rendersBefore && usageCalls === usageBefore && (await tx.usageEvent.count({ where: { calendarId: d10.id } })) === usageRowsBefore && textChecks.length === checksBefore);
    t('the mark is exactly where the controls said it would be', (await marked(drive.get(g4.finalImageDriveFileId!)!.body)) === PLACED);
    t('…composited onto the RAW artwork, read from the parent’s own file', readFiles.includes(parent.imageDriveFileId) && !readFiles.includes(parent.finalImageDriveFileId!));
    t('v4: POSTER_STUDIO from v3, the same template and — deliberately — the same content revision', v4.source === 'POSTER_STUDIO' && v4.parentVersionId === v3.id && v4.templateId === v3.templateId && v4.contentRevision === v3.contentRevision);
    t('the day’s content revision did not move, so a current poster stays current', after.contentRevision === before.contentRevision && after.activePosterVersionId === v4.id && after.generationStatus === 'SUCCEEDED');
    t('studio row: an EDIT with no model and no prompt sent', g4.mode === 'EDIT' && g4.model === 'none' && g4.quality === 'none' && g4.prompt === `${fixModule.POSTER_LOGO_PROMPT_PREFIX}1.0× at bottom right` && /no image model call/.test(g4.sentPrompt));
    t('…the parent’s raw file is shared, not copied, and only the FINAL is new', g4.imageDriveFileId === parent.imageDriveFileId && g4.parentGenerationId === parent.id && g4.finalImageDriveFileId !== parent.finalImageDriveFileId && /-logo-/.test(drive.get(g4.finalImageDriveFileId!)!.fileName));
    t('the previous version’s text check is carried over verbatim — not one glyph moved', snapshot(parseTextCheck(v4.textCheck)) === snapshot(parseTextCheck(v3.textCheck)) && parseTextCheck(v4.textCheck) !== null);
    t('the placement is stored on the day', snapshot(parseDayPosterElements(after.posterElements)?.logo) === snapshot(placement));
    t('the history reads it back as a logo move, not as an admin’s instruction', snapshot(fixModule.posterRevisionSummary(g4.mode, g4.prompt)) === snapshot({ kind: 'logo', text: '1.0× at bottom right' }));

    const screen = await screenModule.loadTemplateEditorScreen(tx, d10.id, load);
    if (screen.kind === 'editor') {
      const versions = screen.screen.versions;
      t('the editor view says what each version did and carries its raw artwork', snapshot(versions.map((version) => version.change?.kind)) === snapshot(['logo', 'fix', 'edit', 'clone']) && versions.every((version) => (version.rawImageUrl ?? '').includes('variant=raw')));
      t('…and the active version’s raw artwork, for the placement preview', (screen.screen.activeVersion?.rawImageUrl ?? '').includes('variant=raw') && screen.screen.activeVersion?.imageUrl !== screen.screen.activeVersion?.rawImageUrl);
      t('…with the trimmed Brand Canvas logo the preview draws', (screen.screen.brand.logoTrimmedUrl ?? '').includes('trim=1'));
    } else {
      t('the editor view loads after a logo placement', false, screen.kind);
    }

    // The placement lives on the day, so the next full generation reads it too.
    checkMode = 'ok';
    const regenerated = await posters.generateCampaignDayPoster(tx, campaignId, d10.id, { ...load, mode: 'regenerate', explicit: true, deps });
    const v5 = await tx.posterVersion.findFirstOrThrow({ where: { calendarDayId: d10.id }, orderBy: { versionNumber: 'desc' }, include: { studioGeneration: true } });
    t('a regeneration afterwards still honours the placement', regenerated.outcome === 'generated' && (await marked(drive.get(v5.studioGeneration!.finalImageDriveFileId!)!.body)) === PLACED, snapshot(regenerated));

    // Put it back: no stored placement means the compositor decides again.
    const reset = await logoModule.setCampaignDayLogoPlacement(tx, d10.id, null, { deps, ...load });
    const cleared = await day(10);
    t('resetting removes the placement and re-centres the mark', reset.outcome === 'placed' && parseDayPosterElements(cleared.posterElements)?.logo === undefined, snapshot(reset));
    const v6 = await tx.posterVersion.findFirstOrThrow({ where: { calendarDayId: d10.id }, orderBy: { versionNumber: 'desc' }, include: { studioGeneration: true } });
    t('…and its history row says so', (await marked(drive.get(v6.studioGeneration!.finalImageDriveFileId!)!.body)) === CENTRED && v6.studioGeneration!.prompt === `${fixModule.POSTER_LOGO_PROMPT_PREFIX}back to the template’s own position`);
    t('still no image model call for any of it', renders.length === rendersBefore + 1 && RED !== WHITE);
  }

  // =======================================================================
  section('logo placement: refusals');
  // =======================================================================
  {
    const rendersBefore = renders.length;
    const d5 = await rowAt(5);
    await expectDomainError('an uploaded poster has no artwork to re-composite', 'invalid-transition', () => logoModule.setCampaignDayLogoPlacement(tx, d5.id, { scale: 1.2 }, { deps, ...load }), /no artwork to re-composite/);
    await expectDomainError('a day with no poster is refused', 'invalid-transition', async () => logoModule.setCampaignDayLogoPlacement(tx, (await rowAt(7)).id, { scale: 1.2 }, { deps, ...load }), /no poster/);

    // Unlike Fix text and the chat, an outdated poster is allowed: moving the mark
    // redraws no words. Day 6's poster was outdated by an edit further up.
    const d6row = await day(6);
    const outdated = await logoModule.setCampaignDayLogoPlacement(tx, d6row.id, { scale: 1.2, anchor: 'left', vAnchor: 'top' }, { deps, ...load });
    t('an outdated poster can still have its logo put right', outdated.outcome === 'placed' && (await day(6)).contentRevision === d6row.contentRevision, snapshot(outdated));

    const booking = await tx.campaignDelivery.create({ data: { campaignId, calendarDayId: d10.id, posterVersionId: (await day(10)).activePosterVersionId!, scheduledFor: NOW, status: 'SENT', attempts: 1, sentAt: NOW } });
    await expectDomainError('a sent poster’s logo cannot be moved', 'invalid-transition', () => logoModule.setCampaignDayLogoPlacement(tx, d10.id, { scale: 1.2 }, { deps, ...load }), /Sent/);
    await tx.campaignDelivery.update({ where: { id: booking.id }, data: { status: 'SENDING', sendingStartedAt: NOW } });
    await expectDomainError('…nor one being sent', 'invalid-transition', () => logoModule.setCampaignDayLogoPlacement(tx, d10.id, { scale: 1.2 }, { deps, ...load }), /Being sent/);
    await tx.campaignDelivery.delete({ where: { id: booking.id } });
    const later = addZonedDays(today, 30, TZ);
    await expectDomainError('…nor a past day’s', 'invalid-transition', () => logoModule.setCampaignDayLogoPlacement(tx, d10.id, { scale: 1.2 }, { deps, now: later, timeZone: TZ }), /passed/);

    await tx.contentCalendar.update({ where: { id: d10.id }, data: { generationStatus: 'GENERATING', posterGenerationStartedAt: new Date() } });
    await expectDomainError('…nor a day already being generated', 'conflict', () => logoModule.setCampaignDayLogoPlacement(tx, d10.id, { scale: 1.2 }, { deps, ...load }), /being generated/);
    await tx.contentCalendar.update({ where: { id: d10.id }, data: { generationStatus: 'SUCCEEDED', posterGenerationStartedAt: null } });

    await changeCampaignStatus(tx, campaignId, 'PAUSED');
    await expectDomainError('…nor a paused campaign’s', 'invalid-transition', () => logoModule.setCampaignDayLogoPlacement(tx, d10.id, { scale: 1.2 }, { deps, ...load }), /activate/);
    await changeCampaignStatus(tx, campaignId, 'ACTIVE');
    t('no refusal reached the image model', renders.length === rendersBefore);

    // The action runs the real pipeline, whose logo resolver would fetch the
    // client's logo — which this check forbids — so it is exercised on a day the
    // service refuses before it reads anything. Its successful path is the
    // service's own, above, with the fakes.
    const action = await asAction(async () => cloneActions.setCampaignDayLogoPlacementAction((await rowAt(7)).id, { scale: 1.4, anchor: 'left', vAnchor: 'top' }));
    t('the placement action reports a refusal, without an API key and without spending', !action.ok && /no poster/.test(action.error) && renders.length === rendersBefore, snapshot(action));
    const malformed = await asAction(() => cloneActions.setCampaignDayLogoPlacementAction(d10.id, { scale: 99 } as never));
    t('…and refuses a scale outside the stored window', !malformed.ok, snapshot(malformed));
  }

  // =======================================================================
  section('logo placement: a lost claim saves nothing');
  // =======================================================================
  {
    const d8row = await day(8);
    const versionsBefore = await tx.posterVersion.count({ where: { calendarDayId: d8.id } });
    const studioRowsBefore = await tx.posterStudioGeneration.count();
    const filesBefore = drive.size;
    const otherClaim = new Date(Date.now() + 60_000);
    // The claim goes stale while the mark is being composited: another run has the day.
    onCompose = async () => {
      await tx.contentCalendar.update({ where: { id: d8.id }, data: { generationStatus: 'GENERATING', posterGenerationStartedAt: otherClaim } });
    };
    const lost = await logoModule.setCampaignDayLogoPlacement(tx, d8.id, { scale: 1.5 }, { deps, ...load });
    const after = await day(8);
    t('the placement reports the lost claim and saves nothing', lost.outcome === 'failed' && /another run took over this day/i.test(lost.message), snapshot(lost));
    t('…no version, no studio row, and the file it stored was binned', (await tx.posterVersion.count({ where: { calendarDayId: d8.id } })) === versionsBefore && (await tx.posterStudioGeneration.count()) === studioRowsBefore && drive.size === filesBefore);
    t('…the placement was not written to the day either', parseDayPosterElements((await day(8)).posterElements)?.logo === undefined && after.activePosterVersionId === d8row.activePosterVersionId);
    t('…and the other run’s claim was not marked FAILED over', after.generationStatus === 'GENERATING' && after.posterGenerationStartedAt?.getTime() === otherClaim.getTime());
    await tx.contentCalendar.update({ where: { id: d8.id }, data: { generationStatus: 'SUCCEEDED', posterGenerationStartedAt: d8row.posterGenerationStartedAt } });
  }

  // =======================================================================
  section('fix text and small change: a lost claim saves nothing');
  // =======================================================================
  {
    checkMode = 'issues';
    const d4 = await rowAt(4);
    const g4 = await generate(d4.id);
    t('fixture: day 4 generated with differences', g4.outcome === 'generated');
    const before = await day(4);
    const versionsBefore = await tx.posterVersion.count({ where: { calendarDayId: d4.id } });
    const studioRowsBefore = await tx.posterStudioGeneration.count();
    const filesBefore = drive.size;
    const rendersBefore = renders.length;
    const otherClaim = new Date(Date.now() + 60_000);
    // The fix's claim goes stale while its text check runs, and another run claims the day.
    onCheck = async () => {
      await tx.contentCalendar.update({ where: { id: d4.id }, data: { generationStatus: 'GENERATING', posterGenerationStartedAt: otherClaim } });
    };
    checkMode = 'ok';
    const lost = await fixModule.fixCampaignDayPosterText(tx, d4.id, { deps });
    const after = await day(4);
    t('the fix reports the lost claim, billed, nothing saved', lost.outcome === 'failed' && lost.billed && /another run took over this day/i.test(lost.message), snapshot(lost));
    t('…one image was paid for, but no version or studio row was recorded', renders.length === rendersBefore + 1 && (await tx.posterVersion.count({ where: { calendarDayId: d4.id } })) === versionsBefore && (await tx.posterStudioGeneration.count()) === studioRowsBefore);
    t('…the active poster is unchanged', after.activePosterVersionId === before.activePosterVersionId);
    t('…the RAW and FINAL files it stored were binned', drive.size === filesBefore);
    t('…and the other run’s claim was not marked FAILED over', after.generationStatus === 'GENERATING' && after.posterGenerationStartedAt?.getTime() === otherClaim.getTime() && after.errorMessage === before.errorMessage);
    await tx.contentCalendar.update({ where: { id: d4.id }, data: { generationStatus: 'SUCCEEDED', posterGenerationStartedAt: before.posterGenerationStartedAt } });
  }

  // =======================================================================
  section('fix text and small change: sent, sending and past days');
  // =======================================================================
  {
    checkMode = 'issues';
    const d4 = await day(4);
    const rendersBefore = renders.length;
    const booking = await tx.campaignDelivery.create({ data: { campaignId, calendarDayId: d4.id, posterVersionId: d4.activePosterVersionId!, scheduledFor: NOW, status: 'SENT', attempts: 1, sentAt: NOW } });
    await expectDomainError('a sent poster cannot be fixed', 'invalid-transition', () => fixModule.fixCampaignDayPosterText(tx, d4.id, { deps }), /Sent/);
    await expectDomainError('…nor changed', 'invalid-transition', () => fixModule.editCampaignDayPoster(tx, d4.id, 'make the background lighter', { deps }), /Sent/);
    await tx.campaignDelivery.update({ where: { id: booking.id }, data: { status: 'SENDING', sendingStartedAt: NOW } });
    await expectDomainError('a poster being sent cannot be fixed', 'invalid-transition', () => fixModule.fixCampaignDayPosterText(tx, d4.id, { deps }), /Being sent/);
    await tx.campaignDelivery.delete({ where: { id: booking.id } });
    const later = addZonedDays(today, 30, TZ);
    await expectDomainError('a past day’s poster cannot be changed', 'invalid-transition', () => fixModule.editCampaignDayPoster(tx, d4.id, 'make the background lighter', { deps, now: later, timeZone: TZ }), /passed/);
    const regenerate = await posters.generateCampaignDayPoster(tx, campaignId, d4.id, { ...load, mode: 'regenerate', explicit: true, deps });
    t('fixture: with the booking gone the day can be regenerated again', regenerate.outcome === 'generated');
    await tx.campaignDelivery.create({ data: { campaignId, calendarDayId: d4.id, posterVersionId: (await day(4)).activePosterVersionId!, scheduledFor: NOW, status: 'SENT', attempts: 1, sentAt: NOW } });
    const refused = await posters.generateCampaignDayPoster(tx, campaignId, d4.id, { ...load, mode: 'regenerate', explicit: true, deps });
    t('regenerating a sent day is refused before any spend (day-locked)', refused.outcome === 'skipped' && refused.reason === 'day-locked' && /has been sent/.test(refused.message), snapshot(refused));
    const screen = await screenModule.loadTemplateEditorScreen(tx, d4.id, load);
    t('the editor offers no Generate or Regenerate on a sent day', screen.kind === 'editor' && !screen.screen.actions.canRegenerate && !screen.screen.actions.canGenerate && screen.screen.status.lock === 'sent');
    t('no refusal reached the image model', renders.length === rendersBefore + 1);
  }

  // =======================================================================
  section('change template re-syncs the booking');
  // =======================================================================
  {
    const activeClient = await tx.client.create({
      data: {
        companyName: 'Clone Booked Dental',
        whatsappNumber: '919876500223',
        cronTime: '23:59',
        displayPhone: '080 4000 1234',
        startDate: today,
        endDate: today,
        planId: plan.id,
        categoryId: vertical.id,
        isDemo: false,
        isActive: true,
        imageSizePreset: 'whatsapp-status',
        brandTagline: 'Smiles made simple',
        websiteUrl: 'https://clone-edit-fixture.invalid/',
        gDriveFolderId: 'SECRET-CLONE-EDIT-FOLDER',
      },
    });
    const booked = await createCampaign(tx, { clientId: activeClient.id, name: 'Booked', startDate: today, durationDays: 3, timeZone: TZ });
    await cloneQueue.cloneTemplatesIntoCampaign(tx, booked.campaignId, load);
    await changeCampaignStatus(tx, booked.campaignId, 'ACTIVE');
    const b2 = (await service.findCampaignDay(tx, booked.campaignId, 2))!;
    const version = await addPosterVersion(tx, { calendarDayId: b2.id, source: 'MANUAL_UPLOAD', imageDriveFileId: 'fake-booked', imageMimeType: 'image/png', contentRevision: b2.contentRevision });
    await tx.posterVersion.update({ where: { id: version.versionId }, data: { approvalStatus: 'APPROVED', reviewedAt: NOW } });
    const deliveryDeps = delivery.defaultDeliveryDeps({
      timeZone: TZ,
      now: () => NOW,
      whatsappConfigured: () => true,
      mediaConfigured: () => true,
      buildMediaUrl: async (versionId) => `https://console.invalid/api/campaign-media/${versionId}`,
      sendMedia: async () => {
        throw new Error('check:campaign-clone-edit-db never sends');
      },
    });
    const bookedOutcome = await delivery.bookCampaignDay(tx, b2.id, { deps: deliveryDeps });
    t('fixture: the approved poster is booked', bookedOutcome.result === 'booked', snapshot(bookedOutcome));
    const other = b2.posterTemplateId === tA.id ? tB.id : tA.id;
    await change.changeCampaignDayTemplate(tx, b2.id, other, { ...load, expectedRevision: b2.contentRevision, deliveryDeps });
    t('changing the template withdraws the booking of the poster it outdated', (await tx.campaignDelivery.findUnique({ where: { calendarDayId: b2.id } }))?.status === 'CANCELLED');
  }

  // =======================================================================
  section('actions with the real pipeline');
  // =======================================================================
  {
    const d9 = await rowAt(9);
    checkMode = 'issues';
    const g9 = await generate(d9.id);
    t('fixture: day 9 generated with differences', g9.outcome === 'generated');
    const rendersBefore = renders.length;
    const fix = await asAction(() => cloneActions.fixCampaignDayPosterTextAction(d9.id));
    t('the fix action refuses without an API key, before any claim or call', fix.ok && fix.data.outcome === 'failed' && fix.data.kind === 'config' && (await day(9)).generationStatus === 'SUCCEEDED' && renders.length === rendersBefore, snapshot(fix));
    const edit = await asAction(() => cloneActions.editCampaignDayPosterAction(d9.id, 'make the background lighter'));
    t('…and so does the small-change action', edit.ok && edit.data.outcome === 'failed' && edit.data.kind === 'config');
    const short = await asAction(() => cloneActions.editCampaignDayPosterAction(d9.id, 'x'));
    t('the small-change action reports a refused instruction', !short.ok && /few words/.test(short.error));
    const noPoster = await asAction(async () => cloneActions.fixCampaignDayPosterTextAction((await rowAt(7)).id));
    t('the fix action reports a refusal', !noPoster.ok && /no poster/.test(noPoster.error));
    const screen = await asAction(() => cloneActions.loadTemplateEditorScreenAction(d9.id));
    t('the editor view shows the poster, its text check and versions', screen.ok && screen.data.kind === 'editor' && screen.data.screen.activeVersion?.textCheck?.ok === false && screen.data.screen.versions.length === 1 && screen.data.screen.status.board === 'needs-approval' && screen.data.screen.actions.canApprove);
  }

  // =======================================================================
  section('closed campaigns');
  // =======================================================================
  {
    await changeCampaignStatus(tx, campaignId, 'CANCELLED');
    const d3 = await day(3);
    await expectDomainError('a cancelled campaign’s template cannot change', 'campaign-closed', () => change.changeCampaignDayTemplate(tx, d3.id, tA.id, { ...load, expectedRevision: d3.contentRevision }));
    await expectDomainError('…nor its posters be fixed', 'campaign-closed', () => fixModule.fixCampaignDayPosterText(tx, d6.id, { deps }));
    const closed = await screenModule.loadTemplateEditorScreen(tx, d3.id, load);
    t('its editor still opens, marked closed', closed.kind === 'editor' && closed.screen.campaign.closed);
    t('ran against the local development database only', /evokz_ai_dev @ localhost/.test(databaseLabel), databaseLabel);
  }
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
  console.log(`\n${bad === 0 ? 'All template poster editor database checks passed.' : `${bad} check(s) FAILED.`}`);
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
