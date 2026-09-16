/**
 * Database checks for campaign review and approval (Phase 5).
 *
 * Runs `src/lib/campaign/review-service.ts` and the Phase 5 server actions —
 * approve, reject with a reason, bulk approval, the day detail and readiness —
 * against the development database. Posters are produced by Phase 4's real
 * generation service with in-process fakes for the image model, Drive and the
 * font-dependent overlay; every review write is the real one.
 *
 * How it stays harmless (the `check:campaign-posters-db` technique):
 *   - `globalThis.prisma` is a facade over ONE interactive transaction that is
 *     always rolled back, with SAVEPOINTs for nested transactions; table row
 *     counts are compared before and after.
 *   - `fetch` is stubbed and counted, provider credentials are blanked, and the
 *     suite asserts zero network attempts (so: no OpenAI, no WhatsApp).
 *   - Refuses to run unless DATABASE_URL is a local development database.
 *
 * Run: npm run check:campaign-review-db
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
  throw new Error('network disabled by check:campaign-review-db');
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
  const review = await import('@/lib/campaign/review-service');
  const { parseRejectionNote } = await import('@/lib/campaign/review');
  const campaignActions = await import('@/app/admin/campaigns/actions');
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

  // ---- Fakes: the image model, Drive and the overlay ---------------------------
  const png = (width: number, height: number, color: string) => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
  const templatePng = await png(540, 960, '#3366aa');
  const drive = new Map<string, Buffer>();
  let fileCounter = 0;
  let renders = 0;
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
      renders += 1;
      const [width, height] = request.size.split('x').map(Number) as [number, number];
      return { bytes: await png(width, height, '#88ccbb'), mimeType: 'image/png', model: 'gpt-image-2', quality: 'low', usage: { textInputTokens: 100, imageInputTokens: 900, outputTokens: 4000 } };
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

  // ---- Fixtures -----------------------------------------------------------------
  const plan = await tx.plan.create({ data: { name: 'check:review 20', durationDays: 20 } });
  const vertical = await tx.category.create({
    data: { name: 'check:review Vertical', contentStrategy: { pillars: [{ key: 'educational', label: 'Educational', weight: 2, guidance: 'Teach.' }, { key: 'tips', label: 'Tips', weight: 1, guidance: 'Advise.' }] } },
  });
  const portrait = { ...SAMPLE_LAYOUT_SPEC, aspect: 9 / 16 } as unknown as Prisma.InputJsonValue;
  const template = async (label: string, order: number) =>
    tx.categoryTemplate.create({
      data: { categoryId: vertical.id, label: `check:review ${label}`, gDriveFileId: `fixture-template-${label}`, gDriveViewUrl: 'https://drive.invalid/t', mimeType: 'image/png', width: 1080, height: 1920, layoutSpec: portrait, layoutApprovedAt: new Date(), createdAt: new Date(Date.parse('2026-01-01') + order * 1000) },
    });
  const tA = await template('A', 1);
  const tB = await template('B', 2);

  const brand = { colors: [{ hex: '#0e7c86', role: 'primary' }], typography: null, layoutDirectives: [], assets: [] };
  const start = today;
  const makeClient = (name: string, data: Partial<Prisma.ClientUncheckedCreateInput> = {}) =>
    tx.client.create({
      data: { companyName: `check:review ${name}`, whatsappNumber: '919876500999', startDate: start, endDate: start, planId: plan.id, categoryId: vertical.id, isDemo: true, isActive: false, imageSizePreset: 'whatsapp-status', brandGuideline: brand, brandTagline: 'Care', websiteUrl: 'review-fixture.invalid', gDriveFolderId: 'SECRET-REVIEW-FOLDER', ...data },
    });
  const clientA = await makeClient('Clinic');
  const clientAuto = await makeClient('Auto approve');
  const legacy = await makeClient('Legacy');

  async function readyCampaign(clientId: string, options: { approvalPolicy?: 'AUTO_APPROVE' } = {}) {
    const { campaignId } = await createCampaign(tx, { clientId, name: 'Review', startDate: start, timeZone: TZ, ...options });
    for (const day of await tx.contentCalendar.findMany({ where: { campaignId }, orderBy: { dayNumber: 'asc' } })) {
      await tx.contentCalendar.update({
        where: { id: day.id },
        data: { theme: `Topic ${day.dayNumber}`, contentType: day.dayNumber % 3 === 0 ? 'tips' : 'educational', headline: `Headline ${day.dayNumber}`, supportingText: `Supporting ${day.dayNumber}.`, cta: 'Book a visit', caption: 'Caption', hashtags: '#care', imagePrompt: `Scene ${day.dayNumber}.`, contentStatus: 'READY', contentRevision: { increment: 1 } },
      });
    }
    const preview = await mapping.previewAutoMap(tx, campaignId, noHtml);
    await mapping.applyAutoMap(tx, campaignId, { ...noHtml, fingerprint: preview.plan.fingerprint });
    await changeCampaignStatus(tx, campaignId, 'ACTIVE');
    return campaignId;
  }

  const campaignId = await readyCampaign(clientA.id);
  const dayRow = async (n: number) => (await service.findCampaignDay(tx, campaignId, n))!;
  const generate = (dayId: string, mode: 'missing' | 'regenerate' = 'missing') =>
    posters.generateCampaignDayPoster(tx, campaignId, dayId, { ...load, mode, explicit: true, deps });
  const reviewOf = () => review.loadCampaignReview(tx, campaignId, load);
  const dayView = async (n: number) => (await reviewOf()).days.find((day) => day.dayNumber === n)!;

  await tx.contentCalendar.create({ data: { clientId: legacy.id, dayNumber: 1, scheduledDate: today, caption: 'Legacy', hashtags: '#l', imagePrompt: 'p', posterTemplateId: tA.id } });
  const legacyBefore = snapshot(await tx.contentCalendar.findMany({ where: { clientId: legacy.id } }));

  // Posters for days 1–6.
  for (const n of [1, 2, 3, 4, 5, 6]) await generate((await dayRow(n)).id);

  // =======================================================================
  section('the review queue');
  // =======================================================================
  {
    const view = await reviewOf();
    t('every generated day needs review under MANUAL_REVIEW', view.summary.needsReview === 6 && view.summary.approved === 0, snapshot(view.summary));
    t('the queue covers the whole campaign, not just the window', view.days.length === 20);
    const day1 = view.days[0]!;
    t('a row carries what the operator needs to act', day1.headline === 'Headline 1' && day1.contentTypeLabel === 'Educational' && day1.templateLabel?.startsWith('check:review') === true && day1.versionNumber === 1 && day1.generationId !== null && day1.stateLabel === 'Needs approval');
    t('a row offers only valid actions', day1.canApprove && day1.canReject && day1.canRegenerate && !day1.canGenerate);
    const notGenerated = view.days.find((day) => day.dayNumber === 7)!;
    t('an ungenerated day cannot be approved or rejected', !notGenerated.canApprove && !notGenerated.canReject);
    t('no Drive id is in the queue payload', !snapshot(view).includes('fake-drive-'));
  }

  // =======================================================================
  section('approve');
  // =======================================================================
  {
    const day1 = await dayRow(1);
    const approved = await asAction(() => campaignActions.approveCampaignDayPosterAction(day1.id, day1.activePosterVersionId!));
    const version = await tx.posterVersion.findUniqueOrThrow({ where: { id: day1.activePosterVersionId! } });
    t('approving the active poster records APPROVED and when', approved.ok && version.approvalStatus === 'APPROVED' && version.reviewedAt !== null);
    t('the queue shows it approved', (await dayView(1)).state === 'approved');
    const v1 = await tx.posterVersion.findFirstOrThrow({ where: { calendarDayId: day1.id, versionNumber: 1 } });
    await generate(day1.id, 'regenerate');
    const after = await dayRow(1);
    t('a new version arrives needing approval again — approval is never copied', (await tx.posterVersion.findUniqueOrThrow({ where: { id: after.activePosterVersionId! } })).approvalStatus === 'PENDING' && after.activePosterVersionId !== v1.id);
    t('the approved older version keeps its own approval, untouched', snapshot(await tx.posterVersion.findUniqueOrThrow({ where: { id: v1.id } })) === snapshot(v1));
    await expectDomainError('approving an older version is refused', 'conflict', () => posters.approveCampaignDayPoster(tx, day1.id, v1.id));
    t('…and exactly one version is active', (await tx.contentCalendar.findUniqueOrThrow({ where: { id: day1.id } })).activePosterVersionId === after.activePosterVersionId);
  }

  // =======================================================================
  section('reject with a reason');
  // =======================================================================
  {
    const day2 = await dayRow(2);
    const versionId = day2.activePosterVersionId!;
    const before = snapshot(await tx.posterStudioGeneration.count());
    const rejected = await asAction(() => campaignActions.rejectCampaignDayPosterAction(day2.id, versionId, { reason: 'branding-issue', detail: 'the logo sits over the headline' }));
    const version = await tx.posterVersion.findUniqueOrThrow({ where: { id: versionId } });
    t('rejecting stores REJECTED with the reason', rejected.ok && version.approvalStatus === 'REJECTED' && version.reviewNote === 'Branding issue — the logo sits over the headline');
    t('the reason reads back as reason and detail', parseRejectionNote(version.reviewNote)?.label === 'Branding issue');
    const after = await dayRow(2);
    t('nothing is deleted: the version, its studio row and the active pointer stay', after.activePosterVersionId === versionId && snapshot(await tx.posterStudioGeneration.count()) === before && drive.size > 0);
    t('the queue shows it rejected, with the reason', (await dayView(2)).state === 'rejected' && (await dayView(2)).rejection?.detail === 'the logo sits over the headline');
    t('a rejected poster offers edit and regenerate, not approve', !(await dayView(2)).canApprove && (await dayView(2)).canRegenerate);
    await expectDomainError('approving a rejected poster is refused', 'invalid-transition', () => posters.approveCampaignDayPoster(tx, day2.id, versionId));
    await expectDomainError('rejecting it twice is refused', 'invalid-transition', () => review.rejectCampaignDayPoster(tx, day2.id, versionId, { reason: 'other', detail: 'again' }));

    const day3 = await dayRow(3);
    const bad1 = await asAction(() => campaignActions.rejectCampaignDayPosterAction(day3.id, day3.activePosterVersionId!, { reason: 'other' }));
    t('"Other" with no note is refused', !bad1.ok && /Say what is wrong/.test(bad1.ok ? '' : bad1.error));
    const bad2 = await asAction(() => campaignActions.rejectCampaignDayPosterAction(day3.id, day3.activePosterVersionId!, { reason: 'made-up' }));
    t('an unknown reason is refused', !bad2.ok);
    t('day 3 is untouched by the refusals', (await dayView(3)).state === 'needs-approval');

    // An approved poster can still be sent back: the approval is withdrawn first.
    const day4 = await dayRow(4);
    await posters.approveCampaignDayPoster(tx, day4.id, day4.activePosterVersionId!);
    await review.rejectCampaignDayPoster(tx, day4.id, day4.activePosterVersionId!, { reason: 'image-quality', detail: 'blurry' });
    t('an approved poster can be sent back (approval withdrawn first)', (await tx.posterVersion.findUniqueOrThrow({ where: { id: day4.activePosterVersionId! } })).approvalStatus === 'REJECTED');
  }

  // =======================================================================
  section('after rejection: edit and regenerate');
  // =======================================================================
  {
    const day2 = await dayRow(2);
    const rejectedVersion = snapshot(await tx.posterVersion.findUniqueOrThrow({ where: { id: day2.activePosterVersionId! } }));
    const edit = await tx.posterStudioGeneration.create({
      data: { mode: 'EDIT', prompt: 'Fix the logo', sentPrompt: 'Edit…', aspectRatio: '9:16', size: '1152x2048', model: 'gpt-image-2', quality: 'low', imageDriveFileId: 'fake-edit-raw', finalImageDriveFileId: 'fake-edit-final', imageMimeType: 'image/png', finalImageMimeType: 'image/png', clientId: clientA.id },
    });
    const saved = await posters.saveStudioPosterToCampaignDay(tx, day2.id, edit.id);
    const after = await dayRow(2);
    const newVersion = await tx.posterVersion.findUniqueOrThrow({ where: { id: saved.versionId } });
    t('editing a rejected poster creates a new version', saved.versionNumber === 2 && newVersion.source === 'POSTER_STUDIO');
    t('the new version is active and needs approval again', after.activePosterVersionId === saved.versionId && newVersion.approvalStatus === 'PENDING');
    t('the rejected version is unchanged history', snapshot(await tx.posterVersion.findUniqueOrThrow({ where: { id: JSON.parse(rejectedVersion).id } })) === rejectedVersion);
    t('exactly one active version remains', (await tx.posterVersion.count({ where: { calendarDayId: day2.id } })) === 2 && after.activePosterVersionId === saved.versionId);

    const day4 = await dayRow(4);
    const rejected4 = snapshot(await tx.posterVersion.findUniqueOrThrow({ where: { id: day4.activePosterVersionId! } }));
    const regenerated = await generate(day4.id, 'regenerate');
    const after4 = await dayRow(4);
    t('regenerating a rejected poster creates a new version', regenerated.outcome === 'generated' && regenerated.versionNumber === 2, snapshot(regenerated));
    t('the new version is active and PENDING again', (await tx.posterVersion.findUniqueOrThrow({ where: { id: after4.activePosterVersionId! } })).approvalStatus === 'PENDING');
    t('the rejected version remains, immutable', snapshot(await tx.posterVersion.findUniqueOrThrow({ where: { id: JSON.parse(rejected4).id } })) === rejected4);
  }

  // =======================================================================
  section('outdated posters');
  // =======================================================================
  {
    const day5 = await dayRow(5);
    await updateCampaignDayContent(tx, day5.id, { headline: 'A changed headline' });
    const view = await dayView(5);
    t('a content change makes the poster outdated', view.state === 'outdated');
    t('an outdated poster cannot be approved, and offers regenerate', !view.canApprove && view.canRegenerate);
    await expectDomainError('approving an outdated poster is refused', 'invalid-transition', () => posters.approveCampaignDayPoster(tx, day5.id, day5.activePosterVersionId!));
    t('an outdated poster may still be sent back', view.canReject);

    const day6 = await dayRow(6);
    const other = (day6.posterTemplateId ?? day6.suggestedTemplateId) === tA.id ? tB.id : tA.id;
    await mapping.assignManualTemplates(tx, campaignId, { kind: 'days', dayNumbers: [6], templateId: other }, noHtml);
    t('a template change makes the poster outdated too', (await dayView(6)).state === 'outdated');
    t('neither was regenerated automatically', (await tx.posterVersion.count({ where: { calendarDayId: day5.id } })) === 1 && (await tx.posterVersion.count({ where: { calendarDayId: day6.id } })) === 1);
  }

  // =======================================================================
  section('bulk approval');
  // =======================================================================
  {
    // Generate day 7 so the selection includes a fresh, approvable day.
    await generate((await dayRow(7)).id);
    const view = await reviewOf();
    const ids = view.days.map((day) => day.dayId);
    const rendersBefore = renders;
    // Days 1, 2, 3, 4 and 7 hold a pending, current poster by now (2 and 4 were
    // edited and regenerated after rejection); 5 and 6 are outdated, the rest empty.
    const pendingBefore = view.days.filter((day) => day.state === 'needs-approval').map((day) => day.dayNumber);
    const result = await asAction(() => campaignActions.approveCampaignPostersAction(campaignId, ids));
    t('bulk approval approves exactly the pending, current posters', result.ok && result.data.approved.join() === pendingBefore.join(), `${result.ok ? snapshot(result.data.approved) : ''} vs ${snapshot(pendingBefore)}`);
    if (!result.ok) throw new Error('bulk approval failed');
    const reasons = result.data.skipped.map((group) => group.reason).sort().join(',');
    t('everything else is reported by reason, never approved', reasons === 'no-poster,outdated', reasons);
    t('selected, approved and skipped add up', result.data.selected === 20 && result.data.approved.length + result.data.skippedCount === 20);
    t('no generation was triggered by approving', renders === rendersBefore);
    const states = await reviewOf();
    const rejectedHistory = await tx.posterVersion.count({ where: { calendarDay: { campaignId }, approvalStatus: 'REJECTED' } });
    t('outdated and missing days kept their state, and rejected history is intact', states.days.find((d) => d.dayNumber === 5)!.state === 'outdated' && states.days.find((d) => d.dayNumber === 6)!.state === 'outdated' && states.days.find((d) => d.dayNumber === 8)!.state === 'not-generated' && rejectedHistory === 2, `${rejectedHistory} rejected versions`);
    const again = await asAction(() => campaignActions.approveCampaignPostersAction(campaignId, ids));
    t('running it again approves nothing new', again.ok && again.data.approved.length === 0);
    const empty = await asAction(() => campaignActions.approveCampaignPostersAction(campaignId, []));
    t('an empty selection is refused', !empty.ok);
    const foreign = await asAction(() => campaignActions.approveCampaignPostersAction(campaignId, ['b0000000-0000-4000-8000-000000000000']));
    t('a day from another campaign is refused', !foreign.ok);
  }

  // =======================================================================
  section('day detail');
  // =======================================================================
  {
    const day2 = await dayRow(2);
    const detail = await asAction(() => campaignActions.loadCampaignDayReviewAction(day2.id));
    t('the detail carries content, template, poster and versions', detail.ok && detail.data.content.headline === 'Headline 2' && detail.data.template.label !== null && detail.data.versions.length === 2);
    if (!detail.ok) throw new Error('detail failed');
    t('versions are newest first, one active, and the rejection reason is kept', detail.data.versions[0]!.versionNumber === 2 && detail.data.versions[0]!.active && detail.data.versions[1]!.rejection?.label === 'Branding issue');
    // Day 2's active v2 was approved by the bulk run: it may be sent back or
    // regenerated, but not approved again, and there is nothing to generate.
    t('only valid actions are offered for the current state', !detail.data.actions.canApprove && detail.data.actions.canReject && detail.data.actions.canRegenerate && !detail.data.actions.canGenerate, snapshot(detail.data.actions));
    t('the detail exposes no Drive id', !snapshot(detail.data).includes('fake-drive-') && !snapshot(detail.data).includes('fake-edit-'));
  }

  // =======================================================================
  section('readiness and policy');
  // =======================================================================
  {
    const view = await reviewOf();
    t('readiness counts content and templates across the campaign', view.readiness.content.done === 20 && view.readiness.templates.done === 20);
    t('readiness counts posters and approvals across the window', view.readiness.posters.total === view.days.filter((day) => day.inWindow).length);
    t('a campaign with unresolved days is not ready, and says why', !view.readiness.windowReady && view.readiness.blockers.length > 0, view.readiness.blockers.join(' · '));
    t('delivery-ready counts only active, current, approved days', view.readiness.deliveryReady === view.days.filter((day) => day.inWindow && day.state === 'approved').length);

    const autoCampaign = await readyCampaign(clientAuto.id, { approvalPolicy: 'AUTO_APPROVE' });
    const autoDay = (await posters.loadPosterOverview(tx, autoCampaign, load)).days.find((day) => day.inWindow)!;
    await posters.generateCampaignDayPoster(tx, autoCampaign, autoDay.id, { ...load, mode: 'missing', explicit: true, deps });
    const autoView = await review.loadCampaignReview(tx, autoCampaign, load);
    t('AUTO_APPROVE: a generated poster is already approved, nothing to review', autoView.summary.approved === 1 && autoView.summary.needsReview === 0);
    t('…and the policy is unchanged by review', (await tx.campaign.findUniqueOrThrow({ where: { id: autoCampaign } })).approvalPolicy === 'AUTO_APPROVE');

    await changeCampaignStatus(tx, campaignId, 'PAUSED');
    const paused = await reviewOf();
    t('a paused campaign is not ready and delivers nothing', !paused.readiness.windowReady && paused.readiness.deliveryReady === 0);
    await changeCampaignStatus(tx, campaignId, 'ACTIVE');
    await changeCampaignStatus(tx, campaignId, 'COMPLETED');
    const closed = await reviewOf();
    t('a closed campaign offers no review actions', closed.days.every((day) => !day.canApprove && !day.canReject && !day.canRegenerate));
    await expectDomainError('…and refuses an approval', 'campaign-closed', async () => posters.approveCampaignDayPoster(tx, (await dayRow(3)).id, (await dayRow(3)).activePosterVersionId!));
  }

  // =======================================================================
  section('isolation');
  // =======================================================================
  t('legacy calendar rows are byte-identical', snapshot(await tx.contentCalendar.findMany({ where: { clientId: legacy.id } })) === legacyBefore);
  t('legacy scope still excludes campaign days', (await tx.contentCalendar.count({ where: { clientId: clientA.id, ...LEGACY_CALENDAR } })) === 0);
  t('no WhatsApp usage row was written', (await tx.usageEvent.count({ where: { provider: 'EVOLUTION' } })) === 0);
  t('no delivery column was written by review', (await tx.contentCalendar.count({ where: { campaignId, OR: [{ deliveryStatus: { not: 'PENDING' } }, { gDriveFileId: { not: null } }, { approvedAt: { not: null } }, { sendAfter: { not: null } }] } })) === 0);
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
  console.log(`\n${bad === 0 ? 'All campaign review database checks passed.' : `${bad} check(s) FAILED.`}`);
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
