/**
 * Database checks for the one-screen campaign board.
 *
 * Runs `src/lib/campaign/board-service.ts` (the board load, moving a post, the
 * approval-policy switch, activation with bookings), the automatic booking of
 * approved posters (`bookCampaignDay` from approval, bulk approval, AUTO_APPROVE
 * generation, rejection and the cron sweep's `syncActiveCampaignBookings`), and
 * the one-template-source fix, against the development database. Posters come
 * from Phase 4's real generation service with in-process fakes.
 *
 * **Nothing can be sent.** The WhatsApp provider is a fake that fails the suite
 * if it is ever called, `fetch` is disabled and counted, and provider
 * credentials are blanked.
 *
 * How it stays harmless (the `check:campaign-posters-db` technique):
 *   - `globalThis.prisma` is a facade over ONE interactive transaction that is
 *     always rolled back, with SAVEPOINTs for nested transactions; table row
 *     counts are compared before and after.
 *   - Refuses to run unless DATABASE_URL is a local development database.
 *
 * Not covered here, by construction: real concurrency. Prisma serialises one
 * interactive transaction, so two moves (or a move racing a send) cannot overlap
 * inside this facade; the move's campaign-row lock and its conditional writes
 * are what guard that in production.
 *
 * Run: npm run check:campaign-board-db
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
  throw new Error('network disabled by check:campaign-board-db');
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
  const service = await import('@/lib/campaign/service');
  const mapping = await import('@/lib/campaign/template-mapping-service');
  const posters = await import('@/lib/campaign/poster-generation-service');
  const review = await import('@/lib/campaign/review-service');
  const delivery = await import('@/lib/campaign/delivery-service');
  const board = await import('@/lib/campaign/board-service');
  const { loadCampaignHealth } = await import('@/lib/campaign/operations');
  const boardActions = await import('@/app/admin/campaigns/board-actions');
  const campaignActions = await import('@/app/admin/campaigns/actions');
  const { formatPageLabel } = await import('@/lib/campaign/board');
  const { StudioError } = await import('@/lib/poster-studio/errors');
  const { readStudioImageSize } = await import('@/lib/poster-studio/images');
  const { recordOpenAiImageUsage } = await import('@/lib/usage');
  const { loadStudioBrandCanvas } = await import('@/lib/poster-studio/brand-context');
  const { addZonedDays, startOfZonedDay } = await import('@/lib/time');
  const { CampaignDomainError, changeCampaignStatus, createCampaign } = service;
  type Deps = import('@/lib/campaign/poster-generation-service').PosterGenerationDeps;
  type DeliveryDeps = import('@/lib/campaign/delivery-service').DeliveryDeps;

  const TZ = 'Asia/Kolkata';
  // 10:00 in Kolkata today: before the fixtures' 23:30 delivery time whenever the suite runs.
  const today = startOfZonedDay(new Date(), TZ);
  const NOW = new Date(today.getTime() + 10 * 3_600_000);
  const load = { timeZone: TZ, now: NOW };
  const DELIVERY_TIME = '23:30';

  async function expectDomainError(name: string, code: string, work: () => Promise<unknown>, pattern?: RegExp) {
    try {
      await work();
      t(name, false, 'succeeded but should have failed');
    } catch (error) {
      const ok = error instanceof CampaignDomainError && error.code === code && (!pattern || pattern.test(error.message));
      t(name, ok, error instanceof Error ? `${(error as { code?: string }).code ?? ''} ${error.message}` : String(error));
    }
  }

  // ---- Fakes: the image model, Drive and the overlay ---------------------------
  const png = (width: number, height: number, color: string) => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
  const templatePng = await png(540, 960, '#3366aa');
  let fileCounter = 0;
  const deps: Deps = {
    assertConfigured: () => undefined,
    loadBrandCanvas: loadStudioBrandCanvas,
    resolveLogo: async () => null,
    resolveFolder: async () => 'fixture-folder',
    readFile: async (fileId) => {
      if (!fileId.startsWith('fixture-template')) throw new StudioError('storage', 'Could not load the image from Google Drive.');
      return templatePng;
    },
    prepareTemplate: async (bytes) => ({ bytes, mimeType: 'image/png' }),
    composeIdentity: async (raw) => raw,
    checkText: async () => ({ checkedAt: NOW.toISOString(), model: 'fake', ok: true, items: [], leftovers: [] }),
    render: async (request) => {
      const [width, height] = request.size.split('x').map(Number) as [number, number];
      return { bytes: await png(width, height, '#88ccbb'), mimeType: 'image/png', model: 'gpt-image-2', quality: 'low', usage: { textInputTokens: 100, imageInputTokens: 900, outputTokens: 4000 } };
    },
    recordUsage: recordOpenAiImageUsage,
    readImageSize: readStudioImageSize,
    store: async () => `fake-drive-${(fileCounter += 1)}`,
    trash: async () => undefined,
  };

  // ---- Delivery: a provider that must never be called ---------------------------
  let providerCalls = 0;
  let clock = NOW;
  const deliveryDeps = (overrides: Partial<DeliveryDeps> = {}): DeliveryDeps =>
    delivery.defaultDeliveryDeps({
      timeZone: TZ,
      now: () => clock,
      whatsappConfigured: () => true,
      mediaConfigured: () => true,
      buildMediaUrl: async (posterVersionId) => `https://console.invalid/api/campaign-media/${posterVersionId}`,
      sendMedia: async () => {
        providerCalls += 1;
        throw new Error('check:campaign-board-db never sends');
      },
      ...overrides,
    });

  // ---- Fixtures -----------------------------------------------------------------
  const plan = await tx.plan.create({ data: { name: 'check:board 20', durationDays: 20 } });
  const vertical = await tx.category.create({
    data: { name: 'check:board Vertical', contentStrategy: { pillars: [{ key: 'educational', label: 'Educational', weight: 1, guidance: 'Teach.' }] } },
  });
  const elementsDoc = (label: string) =>
    ({ version: 1, width: 1080, height: 1920, model: 'fake', elements: [{ id: 'e1', kind: 'headline', text: `Template ${label} headline`, box: { x: 0.1, y: 0.1, w: 0.8, h: 0.1 }, group: null, description: null }] }) as unknown as Prisma.InputJsonValue;
  const template = async (label: string, order: number) =>
    tx.categoryTemplate.create({
      data: { categoryId: vertical.id, label: `check:board ${label}`, gDriveFileId: `fixture-template-${label}`, gDriveViewUrl: 'https://drive.invalid/t', mimeType: 'image/png', width: 1080, height: 1920, createdAt: new Date(Date.parse('2026-01-01') + order * 1000), elements: elementsDoc(label), elementsReadAt: new Date() },
    });
  const tA = await template('A', 1);
  const tB = await template('B', 2);

  const brand = { colors: [{ hex: '#0e7c86', role: 'primary' }], typography: null, layoutDirectives: [], assets: [] };
  const makeClient = (name: string) =>
    tx.client.create({
      data: { companyName: `check:board ${name}`, whatsappNumber: '919876500777', startDate: today, endDate: today, planId: plan.id, categoryId: vertical.id, isDemo: false, isActive: true, imageSizePreset: 'whatsapp-status', brandGuideline: brand, brandTagline: 'Care', websiteUrl: 'board-fixture.invalid', gDriveFolderId: 'SECRET-BOARD-FOLDER' },
    });

  const client = await makeClient('Clinic');
  const { campaignId } = await createCampaign(tx, { clientId: client.id, name: 'Board', startDate: today, deliveryTime: DELIVERY_TIME, timeZone: TZ });
  for (const day of await tx.contentCalendar.findMany({ where: { campaignId }, orderBy: { dayNumber: 'asc' } })) {
    await tx.contentCalendar.update({
      where: { id: day.id },
      data: { theme: `Topic ${day.dayNumber}`, contentType: 'educational', headline: `Headline ${day.dayNumber}`, supportingText: `Supporting ${day.dayNumber}.`, cta: 'Book a visit', caption: 'Caption', hashtags: '#care', imagePrompt: `Scene ${day.dayNumber}.`, contentStatus: 'READY', contentRevision: { increment: 1 } },
    });
  }
  await mapping.assignManualTemplates(tx, campaignId, { kind: 'pattern', fromDay: 1, toDay: 20, templateIds: [tA.id, tB.id] });
  await changeCampaignStatus(tx, campaignId, 'ACTIVE');

  const rowById = (id: string) => tx.contentCalendar.findUniqueOrThrow({ where: { id }, include: { delivery: true } });
  const rowAt = async (n: number) => (await service.findCampaignDay(tx, campaignId, n))!;
  const deliveryOfId = (id: string) => tx.campaignDelivery.findUnique({ where: { calendarDayId: id } });
  const generate = async (id: string, mode: 'missing' | 'regenerate' = 'missing', options: { deliveryDeps?: DeliveryDeps } = { deliveryDeps: deliveryDeps() }) => {
    const result = await posters.generateCampaignDayPoster(tx, campaignId, id, { ...load, mode, explicit: true, deps, ...options });
    if (result.outcome !== 'generated') throw new Error(`fixture generation failed: ${result.message}`);
    return result;
  };
  const approve = async (id: string, withDeps: DeliveryDeps | null = deliveryDeps()) => {
    const row = await rowById(id);
    return (await posters.approveCampaignDayPoster(tx, id, row.activePosterVersionId!, withDeps ? { deliveryDeps: withDeps } : {})).booking;
  };
  const instantFor = (id: string, date: Date) => delivery.scheduledInstantFor(id, date, DELIVERY_TIME, TZ);

  // Stable handles: rows are posts, addressed by id; day numbers move.
  const ids = new Map<number, string>();
  for (const day of await tx.contentCalendar.findMany({ where: { campaignId }, orderBy: { dayNumber: 'asc' } })) ids.set(day.dayNumber, day.id);
  const id = (n: number) => ids.get(n)!;
  const originalDates = new Map((await tx.contentCalendar.findMany({ where: { campaignId }, select: { dayNumber: true, scheduledDate: true } })).map((row) => [row.dayNumber, row.scheduledDate]));

  // =======================================================================
  section('one template source');
  // =======================================================================
  {
    const created = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    t('a new campaign defaults to MANUAL mapping', created.templateMappingMode === 'MANUAL');

    const other = await makeClient('Suggestions');
    const small = await createCampaign(tx, { clientId: other.id, name: 'Suggested', startDate: today, durationDays: 5, timeZone: TZ });
    const first = (await service.findCampaignDay(tx, small.campaignId, 1))!;
    await tx.contentCalendar.update({ where: { id: first.id }, data: { suggestedTemplateId: tA.id } });
    const manualHealth = await loadCampaignHealth(tx, small.campaignId, load);
    t('health: under MANUAL a suggestion alone does not map a day', manualHealth.templates.done === 0 && manualHealth.templates.unmapped === 5, snapshot(manualHealth.templates));
    await tx.campaign.update({ where: { id: small.campaignId }, data: { templateMappingMode: 'AUTO' } });
    const autoHealth = await loadCampaignHealth(tx, small.campaignId, load);
    t('health: under AUTO the same suggestion maps it', autoHealth.templates.done === 1, snapshot(autoHealth.templates));

    const candidate = (mode: 'AUTO' | 'MANUAL') =>
      delivery.deliveryCandidateFrom(
        { campaignId: small.campaignId, contentStatus: 'READY', contentRevision: 1, posterTemplateId: null, suggestedTemplateId: tA.id, activePosterVersion: null, client: { whatsappNumber: '919876500777', isActive: true }, campaign: { status: 'ACTIVE', templateMappingMode: mode }, delivery: null },
        deliveryDeps(),
      );
    t('delivery gate: a suggestion is no template under MANUAL', candidate('MANUAL').hasTemplate === false);
    t('delivery gate: …and is one under AUTO', candidate('AUTO').hasTemplate === true);
  }

  // =======================================================================
  section('approving books the day');
  // =======================================================================
  {
    await generate(id(3));
    t('a generated, unapproved poster is not booked', (await deliveryOfId(id(3))) === null);
    const outcome = await approve(id(3));
    const row = await rowById(id(3));
    const booking = await deliveryOfId(id(3));
    t('approval returns what the booking did, and when it goes out', outcome?.result === 'booked' && outcome.scheduledFor?.getTime() === booking?.scheduledFor.getTime(), snapshot(outcome));
    t('approval in an ACTIVE campaign books the day', booking?.status === 'SCHEDULED', booking?.status ?? 'none');
    t('…pinned to the approved active version', booking?.posterVersionId === row.activePosterVersionId);
    t('…at its day, delivery time and spread', booking?.scheduledFor.getTime() === instantFor(row.id, row.scheduledDate).getTime());
    await posters.approveCampaignDayPoster(tx, id(3), row.activePosterVersionId!, { deliveryDeps: deliveryDeps() });
    t('approving again books nothing twice', (await tx.campaignDelivery.count({ where: { calendarDayId: id(3) } })) === 1);

    await generate(id(4));
    const day4 = await rowById(id(4));
    const viaAction = await asAction(() => campaignActions.approveCampaignDayPosterAction(day4.id, day4.activePosterVersionId!));
    t('the approve action approves', viaAction.ok && (await tx.posterVersion.findUniqueOrThrow({ where: { id: day4.activePosterVersionId! } })).approvalStatus === 'APPROVED');
    t('…but the delivery gate still decides: unconfigured WhatsApp books nothing', (await deliveryOfId(id(4))) === null);
    t('…and the action says why it was not booked', viaAction.ok && viaAction.data.booking?.result === 'not-bookable' && /WhatsApp/.test(viaAction.data.booking.refusal ?? ''), snapshot(viaAction));

    await generate(id(18));
    const bulk = await review.approveCampaignDayPosters(tx, campaignId, [id(18)], { ...load, deliveryDeps: deliveryDeps() });
    const bulkBooking = await deliveryOfId(id(18));
    t('bulk approval books each approved day too', bulk.approved.includes(18) && bulkBooking?.status === 'SCHEDULED' && bulkBooking.posterVersionId === (await rowById(id(18))).activePosterVersionId);
    t('…and reports each booking', bulk.bookings.length === 1 && bulk.bookings[0]?.result === 'booked' && bulk.bookings[0].dayNumber === 18);
  }

  // =======================================================================
  section('paused campaigns book nothing; activation books');
  // =======================================================================
  {
    await generate(id(5));
    await changeCampaignStatus(tx, campaignId, 'PAUSED');
    await approve(id(5));
    t('approval in a PAUSED campaign books nothing', (await deliveryOfId(id(5))) === null);
    const booking3 = await deliveryOfId(id(3));

    const resumed = await board.changeCampaignStatusWithBookings(tx, campaignId, 'ACTIVE', { deliveryDeps: deliveryDeps() });
    t('resuming books every approved day', resumed.booked === 2 && (await deliveryOfId(id(4)))?.status === 'SCHEDULED' && (await deliveryOfId(id(5)))?.status === 'SCHEDULED', snapshot(resumed));
    t('…and leaves an existing booking exactly as it was', snapshot(await deliveryOfId(id(3))) === snapshot(booking3));

    const before = snapshot(await tx.campaignDelivery.findMany({ where: { campaignId }, orderBy: { calendarDayId: 'asc' } }));
    await board.changeCampaignStatusWithBookings(tx, campaignId, 'PAUSED', { deliveryDeps: deliveryDeps() });
    t('pausing touches no booking', snapshot(await tx.campaignDelivery.findMany({ where: { campaignId }, orderBy: { calendarDayId: 'asc' } })) === before);
    await board.changeCampaignStatusWithBookings(tx, campaignId, 'ACTIVE', { deliveryDeps: deliveryDeps() });
    t('resuming again duplicates nothing', snapshot(await tx.campaignDelivery.findMany({ where: { campaignId }, orderBy: { calendarDayId: 'asc' } })) === before);

    // Pausing releases the campaign's generation queue: nothing would take it, and a queued day looks in progress.
    await tx.contentCalendar.updateMany({ where: { id: { in: [id(8), id(9)] } }, data: { generationStatus: 'QUEUED' } });
    await board.changeCampaignStatusWithBookings(tx, campaignId, 'PAUSED', { deliveryDeps: deliveryDeps() });
    t('pausing releases the campaign’s queued days', (await tx.contentCalendar.count({ where: { campaignId, generationStatus: 'QUEUED' } })) === 0 && (await rowById(id(8))).generationStatus === 'NOT_REQUESTED');
    t('…and still touches no booking', snapshot(await tx.campaignDelivery.findMany({ where: { campaignId }, orderBy: { calendarDayId: 'asc' } })) === before);
    await tx.contentCalendar.update({ where: { id: id(9) }, data: { generationStatus: 'QUEUED' } });
    const pausedBoard = await board.loadCampaignBoard(tx, campaignId, { ...load, deliveryDeps: deliveryDeps(), week: 2 });
    t('a queued day of a paused campaign is not shown as generating', pausedBoard.days.find((entry) => entry.id === id(9))?.status !== 'generating');
    await tx.contentCalendar.update({ where: { id: id(9) }, data: { generationStatus: 'NOT_REQUESTED' } });
    await board.changeCampaignStatusWithBookings(tx, campaignId, 'ACTIVE', { deliveryDeps: deliveryDeps() });
  }

  // =======================================================================
  section('auto-approve');
  // =======================================================================
  {
    const waiting = await generate(id(13));
    const on = await board.setCampaignApprovalPolicy(tx, campaignId, 'AUTO_APPROVE');
    t('the policy switches on', on.changed && (await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } })).approvalPolicy === 'AUTO_APPROVE');
    t('switching to the same policy changes nothing', !(await board.setCampaignApprovalPolicy(tx, campaignId, 'AUTO_APPROVE')).changed);
    t('a poster already waiting is not approved retroactively', waiting.approvalStatus === 'PENDING' && (await tx.posterVersion.findUniqueOrThrow({ where: { id: waiting.versionId } })).approvalStatus === 'PENDING');

    const first = await generate(id(6));
    const booking = await deliveryOfId(id(6));
    t('AUTO_APPROVE: a generated poster is approved', first.approvalStatus === 'APPROVED');
    t('…and booked straight away', booking?.status === 'SCHEDULED' && booking.posterVersionId === first.versionId);

    const second = await generate(id(6), 'regenerate');
    const repinned = await deliveryOfId(id(6));
    t('regenerating under AUTO_APPROVE re-pins the same booking to the new version', repinned?.id === booking?.id && repinned?.status === 'SCHEDULED' && repinned.posterVersionId === second.versionId);

    await board.setCampaignApprovalPolicy(tx, campaignId, 'MANUAL_REVIEW');
    const third = await generate(id(6), 'regenerate');
    const withdrawn = await deliveryOfId(id(6));
    t('regenerating under manual review arrives PENDING', third.approvalStatus === 'PENDING');
    t('…and cancels the booking rather than send either poster', withdrawn?.status === 'CANCELLED' && withdrawn.posterVersionId === second.versionId);
    await approve(id(6));
    const rebooked = await deliveryOfId(id(6));
    t('approving the new poster books the same row again, pinned to it', rebooked?.id === booking?.id && rebooked?.status === 'SCHEDULED' && rebooked.posterVersionId === third.versionId && rebooked.attempts === 0);

    const closedClient = await makeClient('Closed');
    const closed = await createCampaign(tx, { clientId: closedClient.id, name: 'Closed', startDate: today, durationDays: 3, timeZone: TZ });
    await changeCampaignStatus(tx, closed.campaignId, 'CANCELLED');
    await expectDomainError('a closed campaign\'s policy cannot change', 'campaign-closed', () => board.setCampaignApprovalPolicy(tx, closed.campaignId, 'AUTO_APPROVE'));
    const badId = await asAction(() => boardActions.setCampaignApprovalPolicyAction('not-a-uuid', 'AUTO_APPROVE'));
    t('the policy action refuses a malformed id', !badId.ok);
    const viaAction = await asAction(() => boardActions.setCampaignApprovalPolicyAction(campaignId, 'MANUAL_REVIEW'));
    t('the policy action works', viaAction.ok && !viaAction.data.changed);
  }

  // =======================================================================
  section('rejecting withdraws the booking');
  // =======================================================================
  {
    const row = await rowById(id(3));
    await review.rejectCampaignDayPoster(tx, id(3), row.activePosterVersionId!, { reason: 'image-quality', detail: 'blurry' }, { deliveryDeps: deliveryDeps() });
    const booking = await deliveryOfId(id(3));
    t('a rejected poster\'s booking is cancelled', booking?.status === 'CANCELLED' && /rejected/i.test(booking.failureReason ?? ''), booking?.failureReason ?? '');
    t('…and the poster keeps its rejection', (await tx.posterVersion.findUniqueOrThrow({ where: { id: row.activePosterVersionId! } })).approvalStatus === 'REJECTED');

    // A delivery that reached the provider, failed ambiguously and was cancelled
    // by an operator may have been delivered: approving a new poster must not
    // quietly send that day again.
    await tx.campaignDelivery.update({ where: { calendarDayId: id(5) }, data: { status: 'FAILED', attempts: 1, failureReason: 'Timed out.', failurePermanent: true } });
    await asAction(() => campaignActions.cancelCampaignDeliveryAction(campaignId, id(5)));
    await generate(id(5), 'regenerate');
    await approve(id(5));
    const attempted = await deliveryOfId(id(5));
    t('an attempted, cancelled delivery is not re-booked automatically', attempted?.status === 'CANCELLED' && attempted.attempts === 1, snapshot({ status: attempted?.status, attempts: attempted?.attempts }));
    const card = (await board.loadCampaignBoard(tx, campaignId, { now: NOW, timeZone: TZ, deliveryDeps: deliveryDeps() })).days.find((day) => day.id === id(5));
    t('…the operator can still Retry it explicitly', card?.actions.canRetry === true && card.status === 'approved');
    t('…but Send now is not offered on a cancelled delivery, where it always fails', card?.actions.canSendNow === false);
    await expectDomainError('Retry of an attempted, cancelled delivery needs confirmation', 'invalid-transition', () => delivery.rescheduleCampaignDelivery(tx, id(5), deliveryDeps()), /may already have reached WhatsApp/);
    const unconfirmed = await asAction(() => campaignActions.retryCampaignDeliveryAction(campaignId, id(5)));
    t('…through the action too', !unconfirmed.ok && /may already have reached WhatsApp/.test(unconfirmed.ok ? '' : unconfirmed.error));
    t('…and nothing changed', (await deliveryOfId(id(5)))?.status === 'CANCELLED');
    await delivery.rescheduleCampaignDelivery(tx, id(5), deliveryDeps(), { confirmAttempted: true });
    const confirmed = await deliveryOfId(id(5));
    t('a confirmed Retry books it again', confirmed?.status === 'SCHEDULED' && confirmed.attempts === 0 && confirmed.posterVersionId === (await rowById(id(5))).activePosterVersionId);
  }

  // =======================================================================
  section('moving a post');
  // =======================================================================
  const move = (dayId: string, target: number, options: { now?: Date; deliveryDeps?: DeliveryDeps } = {}) =>
    board.moveCampaignPost(tx, campaignId, dayId, target, { now: NOW, timeZone: TZ, deliveryDeps: deliveryDeps(), ...options });
  const layout = async () => snapshot(await tx.contentCalendar.findMany({ where: { campaignId }, orderBy: { dayNumber: 'asc' }, select: { id: true, dayNumber: true, scheduledDate: true } }));
  {
    // Day 7 approved and booked; day 8 approved with a retryable failed delivery;
    // days 2 and 12 already sent.
    for (const n of [7, 8, 2, 12]) {
      await generate(id(n));
      await approve(id(n));
    }
    await tx.campaignDelivery.update({ where: { calendarDayId: id(8) }, data: { status: 'FAILED', attempts: 1, lastAttemptAt: NOW, failureReason: 'Gateway said 503.', failurePermanent: false } });
    for (const n of [2, 12]) {
      await tx.campaignDelivery.update({ where: { calendarDayId: id(n) }, data: { status: 'SENT', attempts: 1, sentAt: NOW, providerMessageId: `wamid.${n}` } });
    }

    const before7 = await rowById(id(7));
    const version7 = await tx.posterVersion.findUniqueOrThrow({ where: { id: before7.activePosterVersionId! } });
    const before12 = snapshot(await rowById(id(12)));

    const result = await move(id(7), 10);
    const after7 = await rowById(id(7));
    t('the moved post lands on the target day', after7.dayNumber === 10);
    t('…with the target slot\'s date', after7.scheduledDate.getTime() === originalDates.get(10)!.getTime());
    t('the posts in between shift one day earlier', (await rowById(id(8))).dayNumber === 7 && (await rowById(id(9))).dayNumber === 8 && (await rowById(id(10))).dayNumber === 9);
    t('…taking their new slots\' dates', (await rowById(id(8))).scheduledDate.getTime() === originalDates.get(7)!.getTime() && (await rowById(id(10))).scheduledDate.getTime() === originalDates.get(9)!.getTime());
    t('the result lists exactly the rows that changed', result.moves.length === 4 && result.moves.map((m) => m.toDayNumber).sort((a, b) => a - b).join(',') === '7,8,9,10', snapshot(result.moves.map((m) => [m.fromDayNumber, m.toDayNumber])));
    t('contentRevision is unchanged — the date is not part of the poster', after7.contentRevision === before7.contentRevision);
    t('the active version is unchanged', after7.activePosterVersionId === before7.activePosterVersionId);
    t('its approval survives', (await tx.posterVersion.findUniqueOrThrow({ where: { id: version7.id } })).approvalStatus === 'APPROVED');
    t('the booking moved with the post (same row, same pin)', after7.delivery?.id === before7.delivery?.id && after7.delivery?.posterVersionId === before7.delivery?.posterVersionId && after7.delivery?.status === 'SCHEDULED');
    t('…and its moment follows the new date', after7.delivery?.scheduledFor.getTime() === instantFor(after7.id, after7.scheduledDate).getTime() && after7.delivery.scheduledFor.getTime() !== before7.delivery?.scheduledFor.getTime());
    t('the result reports the rescheduled booking', result.rescheduled.includes(10));

    const after8 = await rowById(id(8));
    t('a retryable FAILED booking follows its post as SCHEDULED', after8.delivery?.status === 'SCHEDULED', snapshot(after8.delivery));
    t('…keeping its attempts, so retries stay bounded', after8.delivery?.attempts === 1);
    t('…at the new date\'s moment, so the retry sweep cannot send it on its old slot', after8.delivery?.scheduledFor.getTime() === instantFor(after8.id, after8.scheduledDate).getTime());
    t('…and reported', result.rebooked.includes(7));

    const rows = await tx.contentCalendar.findMany({ where: { campaignId }, orderBy: { dayNumber: 'asc' } });
    t('day numbers stay 1–20, each once', rows.map((row) => row.dayNumber).join(',') === Array.from({ length: 20 }, (_, index) => index + 1).join(','));
    t('dates still rise with the day number', rows.every((row, index) => index === 0 || row.scheduledDate.getTime() > rows[index - 1]!.scheduledDate.getTime()));
    t('the sent day was not touched', snapshot(await rowById(id(12))) === before12);

    const unchanged = await layout();
    await expectDomainError('a sent post cannot be moved', 'invalid-transition', () => move(id(2), 5), /no longer be moved/);
    await expectDomainError('nothing can be moved onto a sent day', 'invalid-transition', () => move(id(5), 2), /can no longer change/);
    await expectDomainError('a day outside the campaign is refused', 'invalid-input', () => move(id(5), 21));
    await expectDomainError('moving a post onto its own day is refused', 'invalid-transition', () => move(id(5), 5));
    t('a refused move changes nothing', (await layout()) === unchanged);

    // Day 11 → 13 steps over the sent day 12.
    const stepped = await move(id(11), 13);
    t('a move steps over a locked day', (await rowById(id(11))).dayNumber === 13 && (await rowById(id(13))).dayNumber === 11 && (await rowById(id(12))).dayNumber === 12 && stepped.moves.length === 2);

    // Three days on, days 1–3 have passed and are locked.
    const later = new Date(addZonedDays(today, 3, TZ).getTime() + 6 * 3_600_000);
    await expectDomainError('a past day cannot receive a post', 'invalid-transition', () => move(id(15), 3, { now: later }), /can no longer change/);
    await expectDomainError('a past day\'s post cannot be moved', 'invalid-transition', () => move(id(1), 15, { now: later }), /no longer be moved/);

    // Configuration and pausing never withdraw a failed delivery on a move.
    await generate(id(14));
    await approve(id(14));
    await tx.campaignDelivery.update({ where: { calendarDayId: id(14) }, data: { status: 'FAILED', attempts: 2, failureReason: 'Gateway said 503.', failurePermanent: false } });
    const unconfigured = await move(id(14), 15, { deliveryDeps: deliveryDeps({ whatsappConfigured: () => false }) });
    const after14 = await rowById(id(14));
    t('with WhatsApp unconfigured a FAILED booking still follows its post, attempts kept', after14.delivery?.status === 'SCHEDULED' && after14.delivery.attempts === 2 && unconfigured.rebooked.includes(15) && unconfigured.cancelled.length === 0, snapshot(after14.delivery));
    await tx.campaignDelivery.update({ where: { calendarDayId: id(14) }, data: { status: 'FAILED' } });
    await changeCampaignStatus(tx, campaignId, 'PAUSED');
    await move(id(14), 16);
    t('in a PAUSED campaign it follows its post too', (await deliveryOfId(id(14)))?.status === 'SCHEDULED' && (await deliveryOfId(id(14)))?.attempts === 2);
    await changeCampaignStatus(tx, campaignId, 'ACTIVE');
    // …but a poster that may no longer go out withdraws it.
    await tx.campaignDelivery.update({ where: { calendarDayId: id(14) }, data: { status: 'FAILED' } });
    await review.rejectCampaignDayPoster(tx, id(14), (await rowById(id(14))).activePosterVersionId!, { reason: 'image-quality', detail: 'blurry' }, { deliveryDeps: deliveryDeps() });
    const withdrawnMove = await move(id(14), 15);
    const rejected14 = await rowById(id(14));
    t('a FAILED booking whose poster was rejected is withdrawn by a move', rejected14.delivery?.status === 'CANCELLED' && /Moved to day 15/.test(rejected14.delivery.failureReason ?? '') && withdrawnMove.cancelled.includes(15), rejected14.delivery?.failureReason ?? '');

    // A permanent failure is left exactly as it is.
    await tx.campaignDelivery.update({ where: { calendarDayId: id(14) }, data: { status: 'FAILED', attempts: 3, failureReason: 'Timed out.', failurePermanent: true } });
    const permanentBefore = snapshot(await deliveryOfId(id(14)));
    await move(id(14), 16);
    t('a permanent failure is not re-booked or withdrawn by a move', snapshot(await deliveryOfId(id(14))) === permanentBefore);

    // Today closes once today's delivery time (23:30) has come.
    const lateTonight = new Date(today.getTime() + 23 * 3_600_000 + 45 * 60_000);
    await expectDomainError("nothing moves into today after today's delivery time", 'invalid-transition', () => move(id(15), 1, { now: lateTonight }), /can no longer change/);
    await expectDomainError("today's post cannot be moved out after its delivery time", 'invalid-transition', () => move(id(1), 15, { now: lateTonight }), /no longer be moved/);
    const lateBoard = await board.loadCampaignBoard(tx, campaignId, { now: lateTonight, timeZone: TZ, deliveryDeps: deliveryDeps() });
    t("the board shows today closed and not movable", lateBoard.days[0]?.lock === 'closed' && lateBoard.days[0].actions.canMove === false, snapshot(lateBoard.days[0]?.lock));

    // A sync after a move computes from the new date, even over a stale write.
    const moved7 = await rowById(id(7));
    await tx.campaignDelivery.update({ where: { calendarDayId: id(7) }, data: { scheduledFor: instantFor(id(7), originalDates.get(7)!) } });
    const resynced = await delivery.bookCampaignDay(tx, id(7), { deps: deliveryDeps() });
    t('a booking sync after a move uses the new date', resynced.result === 'rescheduled' && (await deliveryOfId(id(7)))?.scheduledFor.getTime() === instantFor(id(7), moved7.scheduledDate).getTime(), snapshot(resynced));
    await delivery.scheduleCampaignDeliveries(tx, campaignId, deliveryDeps());
    t('…and a campaign-wide sync keeps it there', (await deliveryOfId(id(7)))?.scheduledFor.getTime() === instantFor(id(7), moved7.scheduledDate).getTime());

    // Actions address days by id and campaign.
    const otherClient = await makeClient('Other tenant');
    const otherCampaign = await createCampaign(tx, { clientId: otherClient.id, name: 'Other', startDate: today, durationDays: 3, timeZone: TZ });
    const foreignDay = (await service.findCampaignDay(tx, otherCampaign.campaignId, 1))!;
    const crossed = await asAction(() => boardActions.moveCampaignPostAction(campaignId, foreignDay.id, 3));
    t("another campaign's day cannot be moved through this one", !crossed.ok && /not part of this campaign/i.test(crossed.ok ? '' : crossed.error));
    const malformed = await asAction(() => boardActions.moveCampaignPostAction(campaignId, 'not-a-uuid', 3));
    t('a malformed id is refused by the action', !malformed.ok);
    const fractional = await asAction(() => boardActions.moveCampaignPostAction(campaignId, id(17), 2.5));
    t('a fractional day is refused by the action', !fractional.ok);
    const viaAction = await asAction(() => boardActions.moveCampaignPostAction(campaignId, id(17), 18));
    t('the move action moves', viaAction.ok && viaAction.data.moves.length === 2 && (await rowById(id(17))).dayNumber === 18);
  }

  // =======================================================================
  section('the cron sweep keeps bookings in line');
  // =======================================================================
  {
    const sweep = () => delivery.syncActiveCampaignBookings(tx, deliveryDeps(), { limit: 5000 });

    // An approval made while WhatsApp was not configured.
    await generate(id(19), 'missing', {});
    await approve(id(19), null);
    t('(an approval with WhatsApp unconfigured books nothing)', (await deliveryOfId(id(19))) === null);
    const skipped = await delivery.syncActiveCampaignBookings(tx, deliveryDeps({ whatsappConfigured: () => false }), { limit: 5000 });
    t('the sync does not try to book while WhatsApp is unconfigured', (await deliveryOfId(id(19))) === null && skipped.booked >= 0);
    await sweep();
    const healed = await deliveryOfId(id(19));
    t('the sync books an approved day nobody booked', healed?.status === 'SCHEDULED' && healed.posterVersionId === (await rowById(id(19))).activePosterVersionId);

    // A poster replaced without going through a hook.
    const day20 = await rowById(id(20));
    await generate(id(20));
    await approve(id(20));
    const stale = await service.addPosterVersion(tx, { calendarDayId: day20.id, source: 'MANUAL_UPLOAD', imageDriveFileId: 'fake-drive-manual', imageMimeType: 'image/png', contentRevision: (await rowById(id(20))).contentRevision });
    t('(a new pending version became active without a booking sync)', stale.activated && (await deliveryOfId(id(20)))?.status === 'SCHEDULED');

    await changeCampaignStatus(tx, campaignId, 'PAUSED');
    await sweep();
    t('a paused campaign\'s bookings are left alone by the sync', (await deliveryOfId(id(20)))?.status === 'SCHEDULED');
    await changeCampaignStatus(tx, campaignId, 'ACTIVE');
    await sweep();
    const cancelled = await deliveryOfId(id(20));
    t('the sync withdraws a booking whose poster was replaced by an unapproved one', cancelled?.status === 'CANCELLED', cancelled?.status ?? 'none');

    // A campaign whose client has no usable number is not considered at all.
    const numberless = await makeClient('Numberless');
    const other = await createCampaign(tx, { clientId: numberless.id, name: 'Numberless', startDate: today, durationDays: 3, deliveryTime: DELIVERY_TIME, timeZone: TZ });
    await mapping.assignManualTemplates(tx, other.campaignId, { kind: 'range', fromDay: 1, toDay: 3, templateId: tA.id });
    await changeCampaignStatus(tx, other.campaignId, 'ACTIVE');
    const numberlessDays = await tx.contentCalendar.findMany({ where: { campaignId: other.campaignId }, orderBy: { dayNumber: 'asc' } });
    for (const day of numberlessDays) {
      await posters.generateCampaignDayPoster(tx, other.campaignId, day.id, { ...load, mode: 'missing', explicit: true, deps });
      const fresh = await tx.contentCalendar.findUniqueOrThrow({ where: { id: day.id } });
      await posters.approveCampaignDayPoster(tx, day.id, fresh.activePosterVersionId!);
    }
    await tx.client.update({ where: { id: numberless.id }, data: { whatsappNumber: 'not-a-number' } });
    await sweep();
    const withoutNumber = await sweep();
    await tx.client.update({ where: { id: numberless.id }, data: { whatsappNumber: '919876500778' } });
    const withNumber = await sweep();
    t('the unbooked pass skips campaigns whose client has no valid number', withNumber.considered === withoutNumber.considered + 3 && withNumber.booked === 3, `${withoutNumber.considered} → ${withNumber.considered}, booked ${withNumber.booked}`);

    // Days the gate keeps refusing cannot starve the days behind them.
    const starved = await makeClient('Starved');
    const third = await createCampaign(tx, { clientId: starved.id, name: 'Starved', startDate: today, durationDays: 2, deliveryTime: DELIVERY_TIME, timeZone: TZ });
    await mapping.assignManualTemplates(tx, third.campaignId, { kind: 'range', fromDay: 1, toDay: 2, templateId: tA.id });
    await changeCampaignStatus(tx, third.campaignId, 'ACTIVE');
    const [blocker, waiting] = await tx.contentCalendar.findMany({ where: { campaignId: third.campaignId }, orderBy: { dayNumber: 'asc' } });
    for (const day of [blocker!, waiting!]) {
      await posters.generateCampaignDayPoster(tx, third.campaignId, day.id, { ...load, mode: 'missing', explicit: true, deps });
      const fresh = await tx.contentCalendar.findUniqueOrThrow({ where: { id: day.id } });
      await posters.approveCampaignDayPoster(tx, day.id, fresh.activePosterVersionId!);
    }
    // Outdated after approval: still APPROVED, so the query keeps finding it, and the gate keeps refusing it.
    await tx.contentCalendar.update({ where: { id: blocker!.id }, data: { contentRevision: { increment: 1 } } });
    delivery.resetBookingSyncCursor();
    let ticks = 0;
    while (ticks < 200 && !(await deliveryOfId(waiting!.id))) {
      ticks += 1;
      await delivery.syncActiveCampaignBookings(tx, deliveryDeps(), { limit: 1 });
    }
    t('with one day per tick, a day behind a refused one is still booked', (await deliveryOfId(waiting!.id))?.status === 'SCHEDULED', `${ticks} tick(s)`);
    t('…and the refused day is not', (await deliveryOfId(blocker!.id)) === null);
    delivery.resetBookingSyncCursor();

    // A paused client: nothing automatic books, withdraws or sends for it, until it is resumed.
    const pausedClient = await makeClient('Paused client');
    const pausedCampaign = await createCampaign(tx, { clientId: pausedClient.id, name: 'Paused client', startDate: today, durationDays: 2, deliveryTime: DELIVERY_TIME, timeZone: TZ });
    await mapping.assignManualTemplates(tx, pausedCampaign.campaignId, { kind: 'range', fromDay: 1, toDay: 2, templateId: tA.id });
    await changeCampaignStatus(tx, pausedCampaign.campaignId, 'ACTIVE');
    const [kept, unbooked] = await tx.contentCalendar.findMany({ where: { campaignId: pausedCampaign.campaignId }, orderBy: { dayNumber: 'asc' } });
    for (const day of [kept!, unbooked!]) await posters.generateCampaignDayPoster(tx, pausedCampaign.campaignId, day.id, { ...load, mode: 'missing', explicit: true, deps });
    const keptFresh = await rowById(kept!.id);
    const keptBooking = await posters.approveCampaignDayPoster(tx, kept!.id, keptFresh.activePosterVersionId!, { deliveryDeps: deliveryDeps() });
    t('(an active client’s approval books the day)', keptBooking.booking?.result === 'booked');
    await tx.client.update({ where: { id: pausedClient.id }, data: { isActive: false } });
    const unbookedFresh = await rowById(unbooked!.id);
    const refusedBooking = await posters.approveCampaignDayPoster(tx, unbooked!.id, unbookedFresh.activePosterVersionId!, { deliveryDeps: deliveryDeps() });
    t('approving a paused client’s poster books nothing, and says the client is paused', refusedBooking.booking?.result === 'not-bookable' && refusedBooking.booking.refusal?.reason === 'client-paused', snapshot(refusedBooking.booking));
    // Its kept booking's poster is replaced by a pending one without a sync.
    await service.addPosterVersion(tx, { calendarDayId: kept!.id, source: 'MANUAL_UPLOAD', imageDriveFileId: 'fake-drive-paused', imageMimeType: 'image/png', contentRevision: keptFresh.contentRevision });
    delivery.resetBookingSyncCursor();
    await sweep();
    t('the sync books nothing for a paused client', (await deliveryOfId(unbooked!.id)) === null);
    t('…and leaves its bookings exactly as they are', (await deliveryOfId(kept!.id))?.status === 'SCHEDULED');
    const pausedCard = (await board.loadCampaignBoard(tx, pausedCampaign.campaignId, { ...load, deliveryDeps: deliveryDeps() })).days.find((day) => day.id === unbooked!.id);
    t('the board offers no Send now for a paused client', pausedCard?.actions.canSendNow === false);
    await tx.client.update({ where: { id: pausedClient.id }, data: { isActive: true } });
    delivery.resetBookingSyncCursor();
    await sweep();
    delivery.resetBookingSyncCursor();
    t('resuming the client: the next sync books the approved day', (await deliveryOfId(unbooked!.id))?.status === 'SCHEDULED');
    t('…and withdraws the booking whose poster was replaced', (await deliveryOfId(kept!.id))?.status === 'CANCELLED');
    const demoClient = await makeClient('Demo client');
    await tx.client.update({ where: { id: demoClient.id }, data: { isDemo: true } });
    const demoCampaign = await createCampaign(tx, { clientId: demoClient.id, name: 'Demo', startDate: today, durationDays: 1, deliveryTime: DELIVERY_TIME, timeZone: TZ });
    await mapping.assignManualTemplates(tx, demoCampaign.campaignId, { kind: 'range', fromDay: 1, toDay: 1, templateId: tA.id });
    await changeCampaignStatus(tx, demoCampaign.campaignId, 'ACTIVE');
    const demoDay = (await tx.contentCalendar.findFirstOrThrow({ where: { campaignId: demoCampaign.campaignId } }));
    await posters.generateCampaignDayPoster(tx, demoCampaign.campaignId, demoDay.id, { ...load, mode: 'missing', explicit: true, deps });
    await posters.approveCampaignDayPoster(tx, demoDay.id, (await rowById(demoDay.id)).activePosterVersionId!);
    await sweep();
    delivery.resetBookingSyncCursor();
    t('a demo client’s campaigns are not swept automatically', (await deliveryOfId(demoDay.id)) === null);
    t('nothing was sent by any booking path', providerCalls === 0);
  }

  // =======================================================================
  section('the board load');
  // =======================================================================
  {
    // A text check on day 6's poster (whatever day number it is on now).
    const day6 = await rowById(id(6));
    await tx.posterVersion.update({
      where: { id: day6.activePosterVersionId! },
      data: { textCheck: { checkedAt: NOW.toISOString(), model: 'fake', ok: false, items: [{ elementId: 'e1', label: 'Headline', expected: 'Care', found: 'Car', match: false }, { elementId: 'e2', label: 'CTA', expected: 'Book', found: 'Book', match: true }], leftovers: ['Old Clinic'] } },
    });

    const opts = { now: NOW, timeZone: TZ, deliveryDeps: deliveryDeps() };
    const week = await board.loadCampaignBoard(tx, campaignId, opts);
    const rows = await tx.contentCalendar.findMany({ where: { campaignId }, include: { delivery: true }, orderBy: { dayNumber: 'asc' } });
    const sum = Object.entries(week.counts).filter(([key]) => key !== 'all').reduce((total, [, value]) => total + value, 0);
    t('counts cover the whole campaign', week.counts.all === 20 && sum === 20, snapshot(week.counts));
    t('sent days are counted', week.counts.sent === rows.filter((row) => row.delivery?.status === 'SENT').length && week.counts.sent === 2);
    t('scheduled days are counted', week.counts.scheduled === rows.filter((row) => row.delivery?.status === 'SCHEDULED').length, `${week.counts.scheduled}`);
    t('week view opens on the page with today', week.mode === 'week' && week.page.index === 1 && week.page.todayIndex === 1 && week.page.count === 3);
    t('a week page is seven consecutive days', week.days.map((day) => day.dayNumber).join(',') === '1,2,3,4,5,6,7');
    t('its label is the slots\' dates', week.page.label === formatPageLabel(week.days[0]!.scheduledDate, week.days[6]!.scheduledDate, TZ), week.page.label);
    t('today is marked', week.days[0]!.isToday && !week.days[1]!.isToday);

    const second = await board.loadCampaignBoard(tx, campaignId, { ...opts, week: 2 });
    t('week 2 is days 8–14', second.days.map((day) => day.dayNumber).join(',') === '8,9,10,11,12,13,14');
    const clamped = await board.loadCampaignBoard(tx, campaignId, { ...opts, week: 99 });
    t('a week past the end opens the last page', clamped.page.index === 3 && clamped.days.map((day) => day.dayNumber).join(',') === '15,16,17,18,19,20');

    const onBoard = (await board.loadCampaignBoard(tx, campaignId, { ...opts, week: 1 })).days.concat(second.days, clamped.days);
    const at = (dayId: string) => onBoard.find((day) => day.id === dayId)!;
    const sent = at(id(2));
    t('a sent day is locked and offers no move or send', sent.status === 'sent' && sent.lock === 'sent' && !sent.actions.canMove && !sent.actions.canSendNow);
    t('…and no Regenerate: a sent poster is final', !sent.actions.canRegenerate && !sent.actions.canGenerate);
    const textChecked = at(id(6));
    t('the text check badge counts differences and leftovers', textChecked.textCheckIssues === 2, String(textChecked.textCheckIssues));
    const scheduled = at(id(7));
    t('a booked day is scheduled and can be cancelled', scheduled.status === 'scheduled' && scheduled.actions.canCancel && scheduled.delivery?.pinnedToActive === true);
    const draft = onBoard.find((day) => day.status === 'draft' && day.lock === null)!;
    t('a draft with content and a template can be generated', draft.actions.canGenerate && !draft.actions.canApprove && draft.template?.thumbnailUrl === `/api/templates/${draft.template?.id}/thumbnail?w=320`, snapshot(draft.actions));
    const rejected = at(id(3));
    t('a rejected poster needs attention and can be regenerated', rejected.status === 'attention' && rejected.actions.canRegenerate && rejected.note?.tone === 'danger', snapshot({ status: rejected.status, note: rejected.note }));
    const replaced = at(id(20));
    t('a poster awaiting approval can be approved and rejected', replaced.status === 'needs-approval' && replaced.actions.canApprove && replaced.actions.canReject);
    t('poster images go through the protected studio route', scheduled.activeVersion?.imageUrl?.startsWith('/api/poster-studio/') === true);
    t('no Drive id or folder is in the board payload', !snapshot(onBoard).includes('fake-drive-') && !snapshot(week).includes('SECRET-BOARD-FOLDER'));
    t('no campaign warnings when everything is configured', week.warnings.length === 0, snapshot(week.warnings));
    const unconfigured = await board.loadCampaignBoard(tx, campaignId, { ...opts, deliveryDeps: deliveryDeps({ whatsappConfigured: () => false }) });
    t('an unconfigured WhatsApp is a campaign warning', unconfigured.warnings.some((warning) => /WhatsApp/.test(warning)));

    const sentOnly = await board.loadCampaignBoard(tx, campaignId, { ...opts, status: 'sent' });
    t('a status filter lists matching days across the campaign', sentOnly.mode === 'filtered' && sentOnly.days.length === 2 && sentOnly.days.every((day) => day.status === 'sent') && sentOnly.page.matching === 2 && sentOnly.page.label === '1–2 of 2');
    t('…and keeps the whole campaign\'s counts', sentOnly.counts.all === 20);
    const drafts = await board.loadCampaignBoard(tx, campaignId, { ...opts, status: 'draft' });
    t('filtered results are paged seven at a time', drafts.days.length === Math.min(7, drafts.counts.draft) && drafts.page.count === Math.max(1, Math.ceil(drafts.counts.draft / 7)));
    const byHeadline = await board.loadCampaignBoard(tx, campaignId, { ...opts, q: 'headline 9' });
    t('search finds a headline wherever the post now is', byHeadline.days.length === 1 && byHeadline.days[0]!.id === id(9), snapshot(byHeadline.days.map((day) => day.headline)));
    const byNumber = await board.loadCampaignBoard(tx, campaignId, { ...opts, q: 'day 12' });
    t('search finds a day number', byNumber.days.some((day) => day.dayNumber === 12));
    const none = await board.loadCampaignBoard(tx, campaignId, { ...opts, status: 'failed', q: 'nothing like this' });
    t('an empty result is a page, not an error', none.days.length === 0 && none.page.label === 'No matches' && none.page.count === 1);

    const details = await board.loadBoardDayDetails(tx, campaignId, id(6));
    t('the drawer lists every version, newest first', details.versions.length === 3 && details.versions[0]!.versionNumber === 3 && details.versions[0]!.active);
    t('…with the delivery record and its pinned version', details.delivery?.status === 'SCHEDULED' && details.delivery.pinnedVersionNumber === 3);
    t('…and the text check per version', details.versions[0]!.textCheckIssues === 2);
    const foreign = await tx.contentCalendar.findFirstOrThrow({ where: { campaignId: { not: campaignId }, client: { companyName: { startsWith: 'check:board' } } } });
    await expectDomainError("the drawer refuses another campaign's day", 'not-found', () => board.loadBoardDayDetails(tx, campaignId, foreign.id));
    // Send now is never offered for a past day, even with a stale booking on it.
    const dayFour = await rowById(id(4));
    const afterDayFour = new Date(addZonedDays(dayFour.scheduledDate, 1, TZ).getTime() + 10 * 3_600_000);
    const pastBoard = await board.loadCampaignBoard(tx, campaignId, { now: afterDayFour, timeZone: TZ, deliveryDeps: deliveryDeps({ now: () => afterDayFour }) });
    const pastFour = pastBoard.days.find((day) => day.id === id(4));
    t('a past day with a stale booking is locked past and offers no Send now', pastFour?.lock === 'past' && pastFour.delivery?.status === 'SCHEDULED' && pastFour.actions.canSendNow === false, snapshot({ lock: pastFour?.lock, delivery: pastFour?.delivery?.status, actions: pastFour?.actions }));
    const bookedNow = at(id(7));
    t('a booked, approved day offers Send now', bookedNow.actions.canSendNow === true);

    // No usable template: the card says what to do.
    const noTemplate = await makeClient('No template');
    const bare = await createCampaign(tx, { clientId: noTemplate.id, name: 'Bare', startDate: today, durationDays: 2, timeZone: TZ });
    const inactive = await tx.categoryTemplate.create({ data: { categoryId: vertical.id, label: 'check:board Retired', gDriveFileId: 'fixture-template-retired', gDriveViewUrl: 'https://drive.invalid/t', mimeType: 'image/png', width: 1080, height: 1920, isActive: false } });
    const bareDays = await tx.contentCalendar.findMany({ where: { campaignId: bare.campaignId }, orderBy: { dayNumber: 'asc' } });
    await tx.contentCalendar.update({ where: { id: bareDays[1]!.id }, data: { posterTemplateId: inactive.id } });
    const bareBoard = await board.loadCampaignBoard(tx, bare.campaignId, opts);
    t('a day with no template says to fill it or pick one', bareBoard.days[0]?.note?.text === board.NO_TEMPLATE_NOTE && bareBoard.days[0].note.tone === 'warning', snapshot(bareBoard.days[0]?.note));
    t('a day whose template is inactive says so, and what to do', /^Template inactive — use Fill empty days or pick one in Poster Studio$/.test(bareBoard.days[1]?.note?.text ?? ''), snapshot(bareBoard.days[1]?.note));

    const detailsAction = await asAction(() => boardActions.loadBoardDayDetailsAction(campaignId, id(6)));
    t('the drawer action formats dates on the server', detailsAction.ok && typeof detailsAction.data.versions[0]?.createdLabel === 'string' && !snapshot(detailsAction.data).includes('fake-drive-'));
  }

  // =======================================================================
  section('no real provider was reached');
  // =======================================================================
  t('zero network attempts (no OpenAI, no Evolution, no Drive)', networkAttempts === 0, String(networkAttempts));
  t('the WhatsApp provider was never called', providerCalls === 0, String(providerCalls));
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { staticGenerationAsyncStorage } = await import(
    'next/dist/client/components/static-generation-async-storage.external.js'
  );
  requestStore = staticGenerationAsyncStorage as unknown as AsyncStorage;

  const tables = ['Client', 'Campaign', 'ContentCalendar', 'PosterVersion', 'PosterStudioGeneration', 'CampaignDelivery', 'UsageEvent', 'Category', 'CategoryTemplate', 'Plan'] as const;
  const countAll = async (db: PrismaClient) =>
    Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [table, Number((await db.$queryRawUnsafe<[{ count: bigint }]>(`SELECT COUNT(*)::bigint AS count FROM "${table}"`))[0]!.count)] as const),
      ),
    );
  const deliverySnapshot = async (db: PrismaClient) => snapshot(await db.campaignDelivery.findMany({ orderBy: { id: 'asc' } }));

  const before = await countAll(realPrisma);
  const deliveriesBefore = await deliverySnapshot(realPrisma);

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
  const unchanged = tables.every((table) => before[table] === after[table]);
  t('the database is exactly as it was found', unchanged, `${snapshot(before)} → ${snapshot(after)}`);
  t('every existing delivery row is byte-identical', (await deliverySnapshot(realPrisma)) === deliveriesBefore);

  await realPrisma.$disconnect();
  console.log(`\n${bad === 0 ? 'All campaign board database checks passed.' : `${bad} check(s) FAILED.`}`);
  process.exit(bad === 0 ? 0 : 1);
}

void main();
