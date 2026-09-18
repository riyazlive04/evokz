/**
 * Database checks for clone mode's campaign services: clone into queue
 * (src/lib/campaign/clone-queue.ts), the element editor services
 * (src/lib/campaign/clone-editor.ts), their server actions
 * (src/app/admin/campaigns/clone-actions.ts), filling a new campaign on creation,
 * and the board's "template not read" warning.
 *
 * No model is called: the rewrite generator is injected, and the OpenAI key is
 * blanked so a missed injection fails loudly instead of spending.
 *
 * How it stays harmless (the `check:campaign-posters-db` technique): one
 * interactive transaction, always rolled back, with savepoints for nested
 * transactions; table row counts compared before and after; `fetch` stubbed and
 * counted; refuses anything but a local development database.
 *
 * Run: npm run check:campaign-clone-db
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
  throw new Error('network disabled by check:campaign-clone-db');
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

function fixtureDoc(headline: string) {
  return {
    version: 1,
    width: 1080,
    height: 1350,
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

async function suite(): Promise<void> {
  const tx = facade;
  const service = await import('@/lib/campaign/service');
  const cloneQueue = await import('@/lib/campaign/clone-queue');
  const editor = await import('@/lib/campaign/clone-editor');
  const board = await import('@/lib/campaign/board-service');
  const delivery = await import('@/lib/campaign/delivery-service');
  const templateChange = await import('@/lib/campaign/clone-template-change');
  const cloneActions = await import('@/app/admin/campaigns/clone-actions');
  const campaignActions = await import('@/app/admin/campaigns/actions');
  const { MissingEnvError } = await import('@/lib/env');
  const { parseDayPosterElements } = await import('@/lib/types/template-elements');
  const { addZonedDays, startOfZonedDay } = await import('@/lib/time');
  const { CampaignDomainError, addPosterVersion, changeCampaignStatus, createCampaign, selectDayTemplate } = service;
  type RewriteGenerator = import('@/lib/campaign/clone-editor').RewriteGenerator;

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

  // ---- Fixtures -----------------------------------------------------------------
  const plan = await tx.plan.create({ data: { name: 'check:clone 10', durationDays: 10 } });
  const vertical = await tx.category.create({ data: { name: 'check:clone Vertical' } });
  const emptyVertical = await tx.category.create({ data: { name: 'check:clone Unread vertical' } });
  let order = 0;
  const template = (label: string, data: Partial<Prisma.CategoryTemplateUncheckedCreateInput> = {}) =>
    tx.categoryTemplate.create({
      data: {
        categoryId: vertical.id,
        label: `check:clone ${label}`,
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
  // A festival design: active and readable, but out of the daily rotation and
  // keeping its own colours. Created after A, B and C, so if it ever leaked into
  // the cycle it would show up as a fourth letter in `sequence()`.
  const tFestival = await template('Festival', { autoAssign: false, paletteSource: 'template' });
  const tUnread = await template('Unread', { elements: Prisma.DbNull, elementsReadAt: null });
  await tx.categoryTemplate.create({
    data: { categoryId: emptyVertical.id, label: 'check:clone never read', gDriveFileId: 'fixture-template-x', gDriveViewUrl: 'https://drive.invalid/t', mimeType: 'image/png', width: 1080, height: 1350 },
  });

  const brand = { colors: [{ hex: '#0e7c86', role: 'primary' }, { hex: '#f6f7f9', role: 'background' }], typography: null, layoutDirectives: [], assets: [] };
  const makeClient = (name: string, data: Partial<Prisma.ClientUncheckedCreateInput> = {}) =>
    tx.client.create({
      data: {
        companyName: `Clone ${name}`,
        whatsappNumber: '919876500111',
        // Late, so today's slot is still open whenever the suite runs (a slot locks once its delivery time passes).
        cronTime: '23:59',
        displayPhone: '080 4000 1234',
        startDate: today,
        endDate: today,
        planId: plan.id,
        categoryId: vertical.id,
        isDemo: true,
        isActive: false,
        imageSizePreset: 'whatsapp-status',
        brandGuideline: brand,
        brandTagline: 'Smiles made simple',
        websiteUrl: 'https://clone-fixture.invalid/',
        gDriveFolderId: 'SECRET-CLONE-FOLDER',
        ...data,
      },
    });
  const client = await makeClient('Dental');
  const start = addZonedDays(today, -2, TZ);
  const { campaignId } = await createCampaign(tx, { clientId: client.id, name: 'Clone', startDate: start, timeZone: TZ });
  const rowAt = async (n: number) => (await service.findCampaignDay(tx, campaignId, n))!;
  const templateName = new Map([[tA.id, 'A'], [tB.id, 'B'], [tC.id, 'C']]);
  const sequence = async () => (await tx.contentCalendar.findMany({ where: { campaignId }, orderBy: { dayNumber: 'asc' } })).map((day) => (day.posterTemplateId ? (templateName.get(day.posterTemplateId) ?? '?') : '-')).join('');

  // =======================================================================
  section('clone into queue: a new campaign');
  // =======================================================================
  {
    const before = await tx.contentCalendar.findMany({ where: { campaignId }, orderBy: { dayNumber: 'asc' } });
    t('createCampaign itself still makes empty slots', before.every((day) => day.posterTemplateId === null && day.contentStatus === 'NOT_GENERATED'));
    const result = await cloneQueue.cloneTemplatesIntoCampaign(tx, campaignId, load);
    t('only active, read templates are used', result.templates === 3, String(result.templates));
    t('past days are left alone', snapshot(result.skipped.locked) === snapshot([1, 2]), snapshot(result.skipped));
    t('every other day is filled', snapshot(result.filled) === snapshot([3, 4, 5, 6, 7, 8, 9, 10]) && result.conflicts.length === 0, snapshot(result));
    const seq = await sequence();
    t('templates cycle in upload order, by day position', seq === '--CABCABCA', seq);
    t('no template on consecutive days', ![...seq].some((char, index) => char !== '-' && char === seq[index - 1]));
    const day3 = await rowAt(3);
    const stored = parseDayPosterElements(day3.posterElements);
    t('the day holds a fresh clone of its template', stored?.templateId === tC.id && stored.values.length === 12 && stored.values.every((value) => value.source === 'template'));
    t('the template’s business name is swapped for the client’s in its words', stored?.values.find((value) => value.id === 'e8')?.text === 'Choose Clone Dental.');
    t('identity carries no words; unbound identity is hidden', stored?.values.find((value) => value.id === 'e10')?.text === null && stored.values.find((value) => value.id === 'e12')?.removed === true);
    t('ready content: READY, no issues, no image prompt', day3.contentStatus === 'READY' && day3.contentIssues.length === 0 && day3.imagePrompt === '');
    t('headline, supporting text and CTA come from the elements', day3.headline === 'Headline of C' && day3.supportingText === 'Gentle care for the whole family.' && day3.cta === 'Book a visit');
    t('the revision moved once on each filled day', day3.contentRevision === 2 && result.revisionsBumped === 8);
    t('the template is the operator-style selection', day3.templateSelectedAt !== null && day3.suggestedTemplateId === null);

    const again = await cloneQueue.cloneTemplatesIntoCampaign(tx, campaignId, load);
    t('running it again fills nothing: every day is already cloned', again.filled.length === 0 && snapshot(again.skipped.alreadyCloned) === snapshot([3, 4, 5, 6, 7, 8, 9, 10]));
    t('…and moves no revision', (await rowAt(3)).contentRevision === 2);
  }

  // =======================================================================
  section('clone into queue: posters, edits, generation, revisions');
  // =======================================================================
  {
    // Day 4 gets a poster; day 5 an admin edit; day 6 is generating.
    const day4 = await rowAt(4);
    await addPosterVersion(tx, { calendarDayId: day4.id, source: 'MANUAL_UPLOAD', imageDriveFileId: 'fake-upload', imageMimeType: 'image/png', contentRevision: day4.contentRevision });
    await tx.contentCalendar.update({ where: { id: day4.id }, data: { posterElements: Prisma.DbNull } });
    const day6 = await rowAt(6);
    // A live generation claim. (A QUEUED day of a campaign that is not ACTIVE is not in progress: nothing takes it.)
    await tx.contentCalendar.update({ where: { id: day6.id }, data: { generationStatus: 'GENERATING', posterGenerationStartedAt: NOW, posterElements: Prisma.DbNull } });

    const result = await cloneQueue.cloneTemplatesIntoCampaign(tx, campaignId, load);
    t('a day with a poster keeps it and its template', snapshot(result.skipped.hasPoster) === snapshot([4]) && (await rowAt(4)).posterTemplateId === day4.posterTemplateId);
    t('a generating day is left alone', snapshot(result.skipped.generating) === snapshot([6]) && (await rowAt(6)).posterElements === null);

    // An existing campaign: AI content and a manual template, not cloned yet.
    const day7 = await rowAt(7);
    await tx.contentCalendar.update({ where: { id: day7.id }, data: { posterElements: Prisma.DbNull, headline: 'An AI headline', imagePrompt: 'A written image prompt', contentStatus: 'NEEDS_REVIEW', contentIssues: ['Headline repeats day 2'] } });
    const filled7 = await cloneQueue.cloneTemplatesIntoCampaign(tx, campaignId, load);
    const after7 = await rowAt(7);
    const stored7 = parseDayPosterElements(after7.posterElements);
    t('an uncloned day with AI content keeps it: the headline is seeded into the headline element, as the admin’s', snapshot(filled7.filled) === snapshot([7]) && after7.headline === 'An AI headline' && stored7?.values.find((value) => value.id === 'e3')?.text === 'An AI headline' && stored7.values.find((value) => value.id === 'e3')?.source === 'admin', snapshot([after7.headline, stored7?.values.find((value) => value.id === 'e3')]));
    t('…its image prompt is never cleared', after7.imagePrompt === 'A written image prompt', after7.imagePrompt);
    t('…content that already read as the template’s words stays the template’s; the day is READY', after7.supportingText === 'Gentle care for the whole family.' && stored7?.values.find((value) => value.id === 'e4')?.source === 'template' && after7.contentStatus === 'READY' && after7.contentIssues.length === 0);
    t('…keeping its template and bumping its revision', after7.posterTemplateId === day7.posterTemplateId && after7.contentRevision === day7.contentRevision + 1);

    // onlyEmpty false: posters too; identical clones do not move.
    await tx.contentCalendar.update({ where: { id: day6.id }, data: { generationStatus: 'NOT_REQUESTED', posterGenerationStartedAt: null } });
    const revisions = new Map((await tx.contentCalendar.findMany({ where: { campaignId } })).map((day) => [day.dayNumber, day.contentRevision]));
    const all = await cloneQueue.cloneTemplatesIntoCampaign(tx, campaignId, { ...load, onlyEmpty: false });
    t('onlyEmpty false re-clones the day with a poster and the uncloned day', all.filled.includes(4) && all.filled.includes(6), snapshot(all));
    t('…and leaves identical clones unchanged, revision untouched', all.unchanged.includes(3) && all.unchanged.includes(8) && (await rowAt(3)).contentRevision === revisions.get(3));
    t('…bumping only days whose inputs changed', (await rowAt(4)).contentRevision === revisions.get(4)! + 1 && (await rowAt(6)).contentRevision === revisions.get(6)! + 1);
    t('…and never consecutive templates', ![...(await sequence())].some((char, index, chars) => char !== '-' && char === chars[index - 1]), await sequence());

    await expectDomainError('a completed campaign is refused', 'campaign-closed', async () => {
      const other = await makeClient('Closed');
      const closed = await createCampaign(tx, { clientId: other.id, name: 'Closed', startDate: today, timeZone: TZ, durationDays: 3 });
      await changeCampaignStatus(tx, closed.campaignId, 'ACTIVE');
      await changeCampaignStatus(tx, closed.campaignId, 'COMPLETED');
      await cloneQueue.cloneTemplatesIntoCampaign(tx, closed.campaignId, load);
    });

    const unreadClient = await makeClient('Unread vertical', { categoryId: emptyVertical.id });
    const unreadCampaign = await createCampaign(tx, { clientId: unreadClient.id, name: 'Unread', startDate: today, timeZone: TZ, durationDays: 3 });
    const none = await cloneQueue.cloneTemplatesIntoCampaign(tx, unreadCampaign.campaignId, load);
    t('a vertical with no read template fills nothing and says so', none.templates === 0 && none.filled.length === 0 && (await tx.contentCalendar.count({ where: { campaignId: unreadCampaign.campaignId, posterTemplateId: { not: null } } })) === 0);
  }

  // =======================================================================
  section('a festival template: out of the rotation, assignable by hand');
  // =======================================================================
  {
    const festivalClient = await makeClient('Festival');
    const festival = await createCampaign(tx, { clientId: festivalClient.id, name: 'Festival', startDate: today, durationDays: 4, timeZone: TZ });
    const fDay = async (n: number) => (await service.findCampaignDay(tx, festival.campaignId, n))!;

    const filled = await cloneQueue.cloneTemplatesIntoCampaign(tx, festival.campaignId, load);
    const fRows = await tx.contentCalendar.findMany({ where: { campaignId: festival.campaignId }, orderBy: { dayNumber: 'asc' } });
    t('Fill empty days counts the rotation only', filled.templates === 3 && snapshot(filled.filled) === snapshot([1, 2, 3, 4]), snapshot(filled));
    t('…and never puts a template out of the rotation on a day', fRows.every((day) => day.posterTemplateId !== tFestival.id) && fRows.every((day) => [tA.id, tB.id, tC.id].includes(day.posterTemplateId ?? '')));

    // The picker offers it like any other template: choosing it for one day is
    // the whole reason the flag exists.
    const choices = await templateChange.listCampaignDayTemplateChoices(tx, (await fDay(3)).id);
    const festivalChoice = choices.find((choice) => choice.id === tFestival.id);
    t('the Change-template picker lists it, flagged, never filtered', festivalChoice !== undefined && festivalChoice.outOfRotation && festivalChoice.keepsOwnColours && festivalChoice.usable);
    t('…and an ordinary template carries neither flag', choices.find((choice) => choice.id === tA.id)?.outOfRotation === false && choices.find((choice) => choice.id === tA.id)?.keepsOwnColours === false);

    const before = await fDay(3);
    const changed = await templateChange.changeCampaignDayTemplate(tx, before.id, tFestival.id, { ...load, expectedRevision: before.contentRevision });
    const after = await fDay(3);
    const stored = parseDayPosterElements(after.posterElements);
    t('Change template accepts it by hand', changed.templateId === tFestival.id && changed.changed && after.posterTemplateId === tFestival.id);
    t('…and clones its words like any other template', stored?.templateId === tFestival.id && after.headline === 'Headline of Festival' && after.contentStatus === 'READY' && stored.values.every((value) => value.source === 'template'));

    // The re-run is the whole point: Diwali stays on the day it was put on.
    const again = await cloneQueue.cloneTemplatesIntoCampaign(tx, festival.campaignId, load);
    const rerun = await fDay(3);
    t('a re-run leaves the day holding it alone', snapshot(again.skipped.alreadyCloned) === snapshot([1, 2, 3, 4]) && again.filled.length === 0, snapshot(again));
    t('…with its template, words and revision untouched', rerun.posterTemplateId === tFestival.id && rerun.headline === 'Headline of Festival' && rerun.contentRevision === after.contentRevision);

    // The editor reads the flag: no brand swatches are offered for a day whose
    // template keeps its own colours, though the client has accent colours.
    const view = await editor.loadCampaignDayCloneEditor(tx, rerun.id);
    t('the editor shows the template’s own colours', view.colourMode === 'template' && view.brand.colors.length > 0);
    t('…and a day on an ordinary template still shows the brand’s', (await editor.loadCampaignDayCloneEditor(tx, (await fDay(2)).id)).colourMode === 'brand');
  }

  // =======================================================================
  section('actions: create fills, Fill empty days, queue by id');
  // =======================================================================
  {
    const fresh = await makeClient('Created from the form');
    await tx.client.update({ where: { id: fresh.id }, data: {} });
    const created = await asAction(() => campaignActions.createCampaignAction(fresh.id, { name: 'From the form', startDate: new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(today), durationDays: 5 }));
    t('creating a campaign fills its days with cloned templates', created.ok && created.data.filledDays === 5, snapshot(created));
    if (created.ok) {
      const days = await tx.contentCalendar.findMany({ where: { campaignId: created.data.campaignId } });
      t('…each READY with a template and its elements', days.every((day) => day.posterTemplateId !== null && day.contentStatus === 'READY' && parseDayPosterElements(day.posterElements) !== null));
    }
    const unreadClient = await makeClient('Unread create', { categoryId: emptyVertical.id });
    const unread = await asAction(() => campaignActions.createCampaignAction(unreadClient.id, { name: 'No templates', startDate: new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(today), durationDays: 3 }));
    t('a vertical with no read templates still creates the campaign', unread.ok && unread.data.filledDays === 0);

    const fill = await asAction(() => cloneActions.cloneTemplatesIntoCampaignAction(campaignId));
    t('Fill empty days action returns the counts', fill.ok && fill.data.templates === 3 && Array.isArray(fill.data.filled));

    await changeCampaignStatus(tx, campaignId, 'ACTIVE');
    const ids = [(await rowAt(8)).id, (await rowAt(9)).id, 'b0000000-0000-4000-8000-000000000000'];
    const queued = await asAction(() => cloneActions.queueCampaignDayPostersAction(campaignId, ids));
    t('the posts in view are queued by id; a foreign id is ignored', queued.ok && snapshot(queued.data.queued) === snapshot([8, 9]), snapshot(queued));
    await asAction(() => campaignActions.cancelQueuedGenerationAction(campaignId));
    t('…and withdrawn again', (await tx.contentCalendar.count({ where: { campaignId, generationStatus: 'QUEUED' } })) === 0);
  }

  // =======================================================================
  section('editor: load');
  // =======================================================================
  const day3Id = (await rowAt(3)).id;
  {
    const view = await editor.loadCampaignDayCloneEditor(tx, day3Id);
    t('the day, its campaign and client', view.day.dayNumber === 3 && view.day.campaignId === campaignId && view.day.companyName === 'Clone Dental' && view.day.contentRevision === (await rowAt(3)).contentRevision);
    t('the template with its read document and thumbnail', view.template?.id === tC.id && view.template.doc.elements.length === 12 && view.template.thumbnailUrl === `/api/templates/${tC.id}/thumbnail?w=640`);
    t('the elements and what they resolve to', view.elements?.templateId === tC.id && view.resolved.find((item) => item.element.id === 'e10')?.action.type === 'replace');
    t('brand values formatted like Brand Canvas; accent colours only', view.brand.website === 'clone-fixture.invalid' && view.brand.phone === '080 4000 1234' && snapshot(view.brand.colors) === snapshot([{ hex: '#0E7C86', role: 'primary' }]) && view.colourMode === 'brand' && view.brand.logoUrl === null && !view.brand.hasLogo);
    t('no poster yet; generation state included', view.activeVersion === null && view.generation.status !== undefined);
    t('no Drive id or folder in the view', !snapshot(view).includes('SECRET-CLONE-FOLDER') && !snapshot(view).includes('fixture-template-'));
    const pastDay = await editor.loadCampaignDayCloneEditor(tx, (await rowAt(1)).id);
    t('a day with no template has no template, elements or resolution', pastDay.template === null && pastDay.elements === null && pastDay.resolved.length === 0);
    const withPoster = await editor.loadCampaignDayCloneEditor(tx, (await rowAt(4)).id);
    t('a day with a poster shows its active version', withPoster.activeVersion?.versionNumber === 1 && withPoster.activeVersion.imageUrl === null);
    await expectDomainError('a missing day is not found', 'not-found', () => editor.loadCampaignDayCloneEditor(tx, 'b0000000-0000-4000-8000-000000000000'));
    const action = await asAction(() => cloneActions.loadCampaignDayCloneEditorAction(day3Id));
    t('the action serialises dates for the browser', action.ok && typeof action.data.day.scheduledDate === 'string');
  }

  // =======================================================================
  section('editor: update');
  // =======================================================================
  {
    const before = await rowAt(3);
    await expectDomainError('a stale revision is a conflict', 'conflict', () => editor.updateCampaignDayElements(tx, day3Id, { values: [{ id: 'e3', text: 'x' }] }, { expectedRevision: before.contentRevision - 1 }));
    await expectDomainError('an unknown element is refused', 'invalid-input', () => editor.updateCampaignDayElements(tx, day3Id, { values: [{ id: 'e40', text: 'x' }] }, { expectedRevision: before.contentRevision }), /not an element/);
    await expectDomainError('words on the phone are refused', 'invalid-input', () => editor.updateCampaignDayElements(tx, day3Id, { values: [{ id: 'e10', text: '999' }] }, { expectedRevision: before.contentRevision }), /Brand Canvas/);
    await expectDomainError('words on the photo are refused', 'invalid-input', () => editor.updateCampaignDayElements(tx, day3Id, { values: [{ id: 'e5', text: 'a nurse' }] }, { expectedRevision: before.contentRevision }), /photograph/);
    t('a refused edit writes nothing', snapshot(await rowAt(3)) === snapshot(before));

    const saved = await editor.updateCampaignDayElements(
      tx,
      day3Id,
      { values: [{ id: 'e3', text: '  Smiles   made simple  ' }, { id: 'e7', removed: true }, { id: 'e12', text: '5 New Street', removed: false }], imagePrompt: '  a hygienist with a teenager ' },
      { expectedRevision: before.contentRevision },
    );
    const after = await rowAt(3);
    const stored = parseDayPosterElements(after.posterElements)!;
    t('the edit is saved: trimmed words, a removal, an unbound address shown', stored.values.find((value) => value.id === 'e3')?.text === 'Smiles made simple' && stored.values.find((value) => value.id === 'e7')?.removed === true && stored.values.find((value) => value.id === 'e12')?.text === '5 New Street');
    t('the image prompt is saved, trimmed', after.imagePrompt === 'a hygienist with a teenager');
    t('the revision moves by one, and the result says so', saved.changed && saved.revisionBumped && after.contentRevision === before.contentRevision + 1 && saved.contentRevision === after.contentRevision);
    t('the headline follows the elements', after.headline === 'Smiles made simple' && after.contentStatus === 'READY');
    t('identity keeps no words', stored.values.find((value) => value.id === 'e10')?.text === null && stored.values.find((value) => value.id === 'e11')?.text === null);

    const noop = await editor.updateCampaignDayElements(tx, day3Id, { values: [{ id: 'e3', text: 'Smiles made simple' }], imagePrompt: 'a hygienist with a teenager' }, { expectedRevision: after.contentRevision });
    t('saving the same values changes nothing and moves no revision', !noop.changed && (await rowAt(3)).contentRevision === after.contentRevision);

    const action = await asAction(() => cloneActions.updateCampaignDayElementsAction(day3Id, { values: [{ id: 'e6', text: 'Gentle dental exams' }] }, after.contentRevision));
    t('the update action saves and returns the new revision', action.ok && action.data.changed && action.data.contentRevision === after.contentRevision + 1);
    const conflict = await asAction(() => cloneActions.updateCampaignDayElementsAction(day3Id, { values: [{ id: 'e6', text: 'Again' }] }, after.contentRevision));
    t('…and reports a stale revision as a conflict', !conflict.ok && /changed by someone else/.test(conflict.error));

    const day9 = await rowAt(9);
    await selectDayTemplate(tx, day9.id, tUnread.id);
    await expectDomainError('a day whose template is not read cannot be edited', 'invalid-transition', () => editor.updateCampaignDayElements(tx, day9.id, { values: [] }, { expectedRevision: day9.contentRevision + 1 }), /not read yet/);
    const view = await board.loadCampaignBoard(tx, campaignId, { ...load, q: '9' });
    t('the board warns about days on unread templates', view.warnings.some((warning) => /not read yet/.test(warning)), snapshot(view.warnings));
    t('…and the card says what to do', view.days[0]?.note?.text === 'Template not read yet — open the vertical and press Read now.', snapshot(view.days[0]?.note));
    await selectDayTemplate(tx, day9.id, tA.id);
    void tInactive;
  }

  // =======================================================================
  section('editor: rewrite with AI');
  // =======================================================================
  {
    const before = await rowAt(3);
    const storedBefore = parseDayPosterElements(before.posterElements)!;
    let request: Parameters<RewriteGenerator>[0] | null = null;
    const generator: RewriteGenerator = async (input) => {
      request = input;
      return [
        { id: 'e3', text: 'Bright smiles daily' }, // headline "Smiles made simple" template "Headline of C" (13) → 11–15: too long, cut
        { id: 'e4', text: 'Kind care for every family member.' },
        { id: 'e6', text: 'Tiny' }, // too short: kept
        { id: 'e8', text: 'Visit www.clone.com.' }, // invents a web address: kept
        { id: 'e10', text: '+91 00000 00000' }, // identity: never requested, ignored
      ];
    };
    const result = await editor.rewriteCampaignDayElements(tx, day3Id, { generator });
    const after = await rowAt(3);
    const stored = parseDayPosterElements(after.posterElements)!;
    const value = (id: string) => stored.values.find((entry) => entry.id === id)!;
    const captured = request as Parameters<RewriteGenerator>[0] | null;
    t('the request names the business, tagline and vertical', captured?.businessName === 'Clone Dental' && captured.tagline === 'Smiles made simple' && captured.verticalName === 'check:clone Vertical');
    t('only shown content elements are sent, with their template words and window', snapshot(captured?.items.map((item) => item.id)) === snapshot(['e3', 'e4', 'e6', 'e8', 'e9']) && captured?.items[0]?.templateText === 'Headline of C' && captured.items[0].maxLength === 15);
    t('usable rewrites are saved as the AI’s, clamped to the window', value('e4').text === 'Kind care for every family member.' && value('e4').source === 'ai' && (value('e3').text?.length ?? 0) <= 15 && value('e3').source === 'ai', snapshot([value('e3'), value('e4')]));
    t('unusable ones keep their words', value('e6').text === storedBefore.values.find((entry) => entry.id === 'e6')!.text && value('e8').text === 'Choose Clone Dental.' && value('e9').text === 'Book a visit');
    t('the result lists rewritten and kept elements', snapshot(result.rewritten) === snapshot(['e3', 'e4']) && snapshot(result.kept) === snapshot(['e6', 'e8', 'e9']));
    t('identity is untouched', snapshot([value('e10'), value('e11'), value('e1'), value('e5')]) === snapshot(['e10', 'e11', 'e1', 'e5'].map((id) => storedBefore.values.find((entry) => entry.id === id))));
    t('a hidden element stays hidden and unrewritten', value('e7').removed && value('e7').text === storedBefore.values.find((entry) => entry.id === 'e7')!.text);
    t('the revision moves, the headline follows', after.contentRevision === before.contentRevision + 1 && after.headline === value('e3').text);

    const drafts = await editor.rewriteDraftDays(tx, campaignId, [(await rowAt(8)).id, (await rowAt(4)).id, day3Id, 'b0000000-0000-4000-8000-000000000000'], {
      generator: async (input) => input.items.map((item) => ({ id: item.id, text: item.templateText.split('').reverse().join('') })),
    });
    t('rewrite all drafts: days without a poster are rewritten, in day order', snapshot(drafts.rewritten) === snapshot([3, 8]), snapshot(drafts));
    t('…a day with a poster is skipped with the reason; a foreign id is ignored', drafts.skipped.length === 1 && drafts.skipped[0]!.dayNumber === 4 && /poster/.test(drafts.skipped[0]!.reason));
    const stopped = await editor.rewriteDraftDays(tx, campaignId, [(await rowAt(8)).id, (await rowAt(10)).id], {
      generator: async () => {
        throw new MissingEnvError('OPENAI_API_KEY');
      },
    });
    t('missing credentials stop the run after the first day', stopped.stopped && stopped.failed.length === 1 && stopped.rewritten.length === 0);
    const unconfigured = await asAction(() => cloneActions.rewriteCampaignDayElementsAction(day3Id));
    t('the default generator refuses without an API key, and nothing is written', !unconfigured.ok && /OPENAI_API_KEY/.test(unconfigured.error) && networkAttempts === 0, unconfigured.ok ? '' : unconfigured.error);
  }

  // =======================================================================
  section('existing templates and AI content are kept');
  // =======================================================================
  {
    const aiClient = await makeClient('AI calendar');
    const aiCampaign = await createCampaign(tx, { clientId: aiClient.id, name: 'AI calendar', startDate: today, durationDays: 5, timeZone: TZ });
    const aiRows = await tx.contentCalendar.findMany({ where: { campaignId: aiCampaign.campaignId }, orderBy: { dayNumber: 'asc' } });
    for (const day of aiRows) {
      await tx.contentCalendar.update({
        where: { id: day.id },
        data: { headline: `AI headline ${day.dayNumber}`, supportingText: `AI support ${day.dayNumber}.`, cta: 'Call us today', imagePrompt: `Scene ${day.dayNumber}`, contentStatus: 'NEEDS_REVIEW', contentIssues: ['Repeats day 1'] },
      });
    }
    const aiDay = async (n: number) => (await service.findCampaignDay(tx, aiCampaign.campaignId, n))!;
    // Day 1: an operator's choice (C) that differs from the cycle's first template (A). Day 4: an unread template.
    await selectDayTemplate(tx, (await aiDay(1)).id, tC.id);
    await selectDayTemplate(tx, (await aiDay(4)).id, tUnread.id);

    // The editor, before any fill: a legacy day is shown seeded, and nothing is written by loading it.
    const legacyView = await editor.loadCampaignDayCloneEditor(tx, (await aiDay(1)).id);
    const shown = (id: string) => legacyView.elements?.values.find((value) => value.id === id);
    t('editor: a day with AI content and no elements shows that content in the elements', shown('e3')?.text === 'AI headline 1' && shown('e4')?.text === 'AI support 1.' && shown('e9')?.text === 'Call us today' && shown('e3')?.source === 'admin');
    t('…with the template’s words everywhere else, and loading writes nothing', shown('e6')?.text === 'Painless check-ups' && (await aiDay(1)).posterElements === null);

    const beforeFill = await aiDay(1);
    const filled = await cloneQueue.cloneTemplatesIntoCampaign(tx, aiCampaign.campaignId, load);
    const d1 = await aiDay(1);
    const d1Elements = parseDayPosterElements(d1.posterElements)!;
    const d1Value = (id: string) => d1Elements.values.find((value) => value.id === id)!;
    t('Fill: a day with an operator’s template is filled from it, not the cycle’s', filled.filled.includes(1) && d1.posterTemplateId === tC.id && d1Elements.templateId === tC.id, snapshot(filled));
    t('Fill: its AI headline, supporting text and CTA are seeded into the matching elements', d1Value('e3').text === 'AI headline 1' && d1Value('e4').text === 'AI support 1.' && d1Value('e9').text === 'Call us today' && [d1Value('e3'), d1Value('e4'), d1Value('e9')].every((value) => value.source === 'admin' && !value.removed));
    t('Fill: the day’s columns keep that content; its image prompt is kept; the day is READY', d1.headline === 'AI headline 1' && d1.supportingText === 'AI support 1.' && d1.cta === 'Call us today' && d1.imagePrompt === 'Scene 1' && d1.contentStatus === 'READY' && d1.contentIssues.length === 0);
    t('Fill: every seeded or cloned value records its element’s kind', d1Elements.values.every((value) => value.kind !== undefined));
    t('Fill: the revision moves once', d1.contentRevision === beforeFill.contentRevision + 1);
    const d2 = await aiDay(2);
    t('Fill: a day with no template gets the cycle’s, never repeating its kept neighbour', d2.posterTemplateId !== null && d2.posterTemplateId !== tC.id && parseDayPosterElements(d2.posterElements)?.values.find((value) => value.id === 'e3')?.text === 'AI headline 2');
    const d4 = await aiDay(4);
    t('Fill: a day whose template is unread is filled from the cycle', d4.posterTemplateId !== tUnread.id && [tA.id, tB.id, tC.id].includes(d4.posterTemplateId ?? ''));
    const again = await cloneQueue.cloneTemplatesIntoCampaign(tx, aiCampaign.campaignId, load);
    t('Fill again: nothing changes and the seeded words stay', again.filled.length === 0 && (await aiDay(1)).headline === 'AI headline 1');

    // AUTO mapping: a suggestion is the day's template.
    const autoClient = await makeClient('Auto suggestions');
    const autoCampaign = await createCampaign(tx, { clientId: autoClient.id, name: 'Auto', startDate: today, durationDays: 3, timeZone: TZ });
    await tx.campaign.update({ where: { id: autoCampaign.campaignId }, data: { templateMappingMode: 'AUTO' } });
    const autoDay1 = (await service.findCampaignDay(tx, autoCampaign.campaignId, 1))!;
    await tx.contentCalendar.update({ where: { id: autoDay1.id }, data: { suggestedTemplateId: tB.id, headline: 'Suggested headline' } });
    await cloneQueue.cloneTemplatesIntoCampaign(tx, autoCampaign.campaignId, load);
    const autoAfter = (await service.findCampaignDay(tx, autoCampaign.campaignId, 1))!;
    t('Fill: under AUTO, a day’s suggestion is its template and is cloned', autoAfter.posterTemplateId === tB.id && parseDayPosterElements(autoAfter.posterElements)?.templateId === tB.id && autoAfter.headline === 'Suggested headline');

    // Saving and rewriting a legacy day that was never filled.
    const legacyClient = await makeClient('Legacy editor');
    const legacyCampaign = await createCampaign(tx, { clientId: legacyClient.id, name: 'Legacy editor', startDate: today, durationDays: 3, timeZone: TZ });
    const l2 = (await service.findCampaignDay(tx, legacyCampaign.campaignId, 2))!;
    await selectDayTemplate(tx, l2.id, tA.id);
    const l2Selected = await tx.contentCalendar.update({ where: { id: l2.id }, data: { headline: 'Legacy AI headline', cta: 'Visit this week', imagePrompt: 'A calm waiting room' } });
    const saved = await editor.updateCampaignDayElements(tx, l2.id, { values: [{ id: 'e6', text: 'Gentle exams' }] }, { ...load, expectedRevision: l2Selected.contentRevision });
    const l2After = await tx.contentCalendar.findUniqueOrThrow({ where: { id: l2.id } });
    const l2Stored = parseDayPosterElements(l2After.posterElements)!;
    t('editor save on a legacy day: the edit and the day’s own headline and CTA are both saved', saved.revisionBumped && l2Stored.values.find((value) => value.id === 'e6')?.text === 'Gentle exams' && l2Stored.values.find((value) => value.id === 'e3')?.text === 'Legacy AI headline' && l2Stored.values.find((value) => value.id === 'e9')?.text === 'Visit this week');
    t('…and the columns keep them', l2After.headline === 'Legacy AI headline' && l2After.cta === 'Visit this week' && l2After.imagePrompt === 'A calm waiting room');

    const l3 = (await service.findCampaignDay(tx, legacyCampaign.campaignId, 3))!;
    await selectDayTemplate(tx, l3.id, tB.id);
    await tx.contentCalendar.update({ where: { id: l3.id }, data: { headline: 'Another AI headline', supportingText: 'Another AI supporting text.' } });
    const rewritten = await editor.rewriteCampaignDayElements(tx, l3.id, { ...load, generator: async (input) => input.items.filter((item) => item.id === 'e6').map((item) => ({ id: item.id, text: item.templateText.toUpperCase() })) });
    const l3After = await tx.contentCalendar.findUniqueOrThrow({ where: { id: l3.id } });
    t('rewrite on a legacy day: the rewrite is saved and the day’s own headline is kept', snapshot(rewritten.rewritten) === snapshot(['e6']) && l3After.headline === 'Another AI headline' && l3After.supportingText === 'Another AI supporting text.' && parseDayPosterElements(l3After.posterElements)?.values.find((value) => value.id === 'e6')?.text === 'PAINLESS CHECK-UPS');
  }

  // =======================================================================
  section('editor: locked and generating days');
  // =======================================================================
  {
    const lockClient = await makeClient('Locks');
    const lockCampaign = await createCampaign(tx, { clientId: lockClient.id, name: 'Locks', startDate: addZonedDays(today, -1, TZ), durationDays: 5, timeZone: TZ });
    await cloneQueue.cloneTemplatesIntoCampaign(tx, lockCampaign.campaignId, load);
    await changeCampaignStatus(tx, lockCampaign.campaignId, 'ACTIVE');
    const lockDay = async (n: number) => (await service.findCampaignDay(tx, lockCampaign.campaignId, n))!;

    // Day 1 is yesterday: give it a template so only the lock can refuse it.
    const past = await lockDay(1);
    await selectDayTemplate(tx, past.id, tA.id);
    const pastNow = await lockDay(1);
    await expectDomainError('a past day cannot be edited', 'invalid-transition', () => editor.updateCampaignDayElements(tx, pastNow.id, { values: [{ id: 'e3', text: 'Too late' }] }, { ...load, expectedRevision: pastNow.contentRevision }), /passed/);
    await expectDomainError('…nor rewritten', 'invalid-transition', () => editor.rewriteCampaignDayElements(tx, pastNow.id, { ...load, generator: async () => [] }), /passed/);

    // Today, after its delivery time (the client's 23:59): closed.
    const closing = await lockDay(2);
    const lateTonight = new Date(startOfZonedDay(NOW, TZ).getTime() + (23 * 60 + 59) * 60_000 + 30_000);
    await expectDomainError("today's day cannot be edited once its delivery time has passed", 'invalid-transition', () => editor.updateCampaignDayElements(tx, closing.id, { values: [{ id: 'e3', text: 'Late' }] }, { now: lateTonight, timeZone: TZ, expectedRevision: closing.contentRevision }), /delivery time/);

    // A sent day.
    const sentDay = await lockDay(3);
    const upload = await addPosterVersion(tx, { calendarDayId: sentDay.id, source: 'MANUAL_UPLOAD', imageDriveFileId: 'fake-sent', imageMimeType: 'image/png', contentRevision: sentDay.contentRevision });
    await tx.campaignDelivery.create({ data: { campaignId: lockCampaign.campaignId, calendarDayId: sentDay.id, posterVersionId: upload.versionId, scheduledFor: NOW, status: 'SENT', attempts: 1, sentAt: NOW } });
    await expectDomainError('a sent day cannot be edited', 'invalid-transition', () => editor.updateCampaignDayElements(tx, sentDay.id, { values: [{ id: 'e3', text: 'After the fact' }] }, { ...load, expectedRevision: sentDay.contentRevision }), /Sent/);

    // A day being generated, then a queued one.
    const busy = await lockDay(4);
    await tx.contentCalendar.update({ where: { id: busy.id }, data: { generationStatus: 'GENERATING', posterGenerationStartedAt: NOW } });
    await expectDomainError('a day being generated cannot be edited', 'invalid-transition', () => editor.updateCampaignDayElements(tx, busy.id, { values: [{ id: 'e3', text: 'Mid-render' }] }, { ...load, expectedRevision: busy.contentRevision }), /being generated/);
    await tx.contentCalendar.update({ where: { id: busy.id }, data: { generationStatus: 'QUEUED', posterGenerationStartedAt: null } });
    await expectDomainError('…nor a queued one', 'invalid-transition', () => editor.updateCampaignDayElements(tx, busy.id, { values: [{ id: 'e3', text: 'Queued' }] }, { ...load, expectedRevision: busy.contentRevision }), /being generated/);
    t('refused edits write nothing', (await lockDay(4)).contentRevision === busy.contentRevision && (await lockDay(1)).contentRevision === pastNow.contentRevision);

    let generatorCalls = 0;
    const drafts = await editor.rewriteDraftDays(tx, lockCampaign.campaignId, [pastNow.id, busy.id, (await lockDay(5)).id], {
      ...load,
      generator: async (input) => {
        generatorCalls += 1;
        return input.items.map((item) => ({ id: item.id, text: item.templateText }));
      },
    });
    t('rewrite all drafts skips a past day and a queued day with their reasons, before any model call', drafts.skipped.some((entry) => entry.dayNumber === 1 && /passed/.test(entry.reason)) && drafts.skipped.some((entry) => entry.dayNumber === 4 && /being generated/.test(entry.reason)) && generatorCalls === 1, snapshot(drafts));

    // Paused: nothing will take the queued day, so it is not "being generated" and may be edited.
    await changeCampaignStatus(tx, lockCampaign.campaignId, 'PAUSED');
    const pausedEdit = await editor.updateCampaignDayElements(tx, busy.id, { values: [{ id: 'e3', text: 'Edited while paused' }] }, { ...load, expectedRevision: busy.contentRevision });
    t('a queued day of a paused campaign can be edited', pausedEdit.changed && (await lockDay(4)).headline === 'Edited while paused');
    const pausedView = await board.loadCampaignBoard(tx, lockCampaign.campaignId, { ...load, q: '4' });
    t('…and the board does not show it as generating', pausedView.days[0]?.status !== 'generating', snapshot(pausedView.days[0]?.status));
  }

  // =======================================================================
  section('edits re-sync the day’s booking');
  // =======================================================================
  {
    const bookedClient = await makeClient('Booked', { isActive: true, isDemo: false });
    const bookedCampaign = await createCampaign(tx, { clientId: bookedClient.id, name: 'Booked', startDate: today, durationDays: 4, timeZone: TZ });
    await cloneQueue.cloneTemplatesIntoCampaign(tx, bookedCampaign.campaignId, load);
    await changeCampaignStatus(tx, bookedCampaign.campaignId, 'ACTIVE');
    const bookedDay = async (n: number) => (await service.findCampaignDay(tx, bookedCampaign.campaignId, n))!;
    const deliveryDeps = delivery.defaultDeliveryDeps({
      timeZone: TZ,
      now: () => NOW,
      whatsappConfigured: () => true,
      mediaConfigured: () => true,
      buildMediaUrl: async (versionId) => `https://console.invalid/api/campaign-media/${versionId}`,
      sendMedia: async () => {
        throw new Error('check:campaign-clone-db never sends');
      },
    });
    /** An approved poster on the day, booked for its slot. */
    const book = async (n: number) => {
      const day = await bookedDay(n);
      const version = await addPosterVersion(tx, { calendarDayId: day.id, source: 'MANUAL_UPLOAD', imageDriveFileId: `fake-booked-${n}`, imageMimeType: 'image/png', contentRevision: day.contentRevision });
      await tx.posterVersion.update({ where: { id: version.versionId }, data: { approvalStatus: 'APPROVED', reviewedAt: NOW } });
      const outcome = await delivery.bookCampaignDay(tx, day.id, { deps: deliveryDeps });
      return { day: await bookedDay(n), outcome };
    };
    const statusOf = async (n: number) => (await tx.campaignDelivery.findUnique({ where: { calendarDayId: (await bookedDay(n)).id } }))?.status ?? 'none';

    const { day: b2, outcome } = await book(2);
    t('fixture: an approved poster is booked', outcome.result === 'booked' && (await statusOf(2)) === 'SCHEDULED', snapshot(outcome));
    const same = await editor.updateCampaignDayElements(tx, b2.id, { values: [{ id: 'e3', text: parseDayPosterElements(b2.posterElements)!.values.find((value) => value.id === 'e3')!.text }] }, { ...load, expectedRevision: b2.contentRevision, deliveryDeps });
    t('a save that changes nothing leaves the booking alone', !same.revisionBumped && (await statusOf(2)) === 'SCHEDULED');
    await editor.updateCampaignDayElements(tx, b2.id, { values: [{ id: 'e3', text: 'A new headline' }] }, { ...load, expectedRevision: b2.contentRevision, deliveryDeps });
    t('an edit that outdates the booked poster withdraws its booking', (await statusOf(2)) === 'CANCELLED');

    const { day: b3 } = await book(3);
    await editor.rewriteCampaignDayElements(tx, b3.id, { ...load, deliveryDeps, generator: async (input) => input.items.map((item) => ({ id: item.id, text: item.templateText.toUpperCase() })) });
    t('a rewrite withdraws it too', (await statusOf(3)) === 'CANCELLED');

    // Day 4's words were edited before its poster was made and booked; re-cloning puts the template's words back.
    const b4 = await bookedDay(4);
    const b4Elements = parseDayPosterElements(b4.posterElements)!;
    await tx.contentCalendar.update({
      where: { id: b4.id },
      data: { headline: 'Edited before booking', posterElements: { ...b4Elements, values: b4Elements.values.map((value) => (value.id === 'e3' ? { ...value, text: 'Edited before booking', source: 'admin' } : value)) } as unknown as Prisma.InputJsonValue },
    });
    await book(4);
    t('fixture: day 4 is booked', (await statusOf(4)) === 'SCHEDULED');
    await cloneQueue.cloneTemplatesIntoCampaign(tx, bookedCampaign.campaignId, { ...load, onlyEmpty: false, deliveryDeps });
    t('re-cloning a booked day withdraws its booking', (await statusOf(4)) === 'CANCELLED');
  }

  // =======================================================================
  section('closed campaigns');
  // =======================================================================
  {
    await changeCampaignStatus(tx, campaignId, 'CANCELLED');
    const day = await rowAt(3);
    await expectDomainError('a cancelled campaign cannot be edited', 'campaign-closed', () => editor.updateCampaignDayElements(tx, day.id, { values: [{ id: 'e3', text: 'x' }] }, { expectedRevision: day.contentRevision }));
    await expectDomainError('…or filled', 'campaign-closed', () => cloneQueue.cloneTemplatesIntoCampaign(tx, campaignId, load));
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
  console.log(`\n${bad === 0 ? 'All campaign clone database checks passed.' : `${bad} check(s) FAILED.`}`);
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
