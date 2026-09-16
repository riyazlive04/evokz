/**
 * Database checks for campaign WhatsApp delivery (Phase 6).
 *
 * Runs `src/lib/campaign/delivery-service.ts`, the cron sweep's campaign phase
 * and the Phase 6 server actions against the development database. Posters are
 * produced by Phase 4's real generation service with in-process fakes; every
 * delivery decision, claim and record is the real one.
 *
 * **The provider is a fake, and `fetch` is disabled and counted.** Nothing in
 * this suite can reach Evolution, and the suite asserts zero network attempts —
 * so no WhatsApp message can escape even if a guard regressed.
 *
 * How it stays harmless (the `check:campaign-posters-db` technique):
 *   - `globalThis.prisma` is a facade over ONE interactive transaction that is
 *     always rolled back, with SAVEPOINTs for nested transactions; table row
 *     counts are compared before and after.
 *   - Provider credentials are blanked.
 *   - Refuses to run unless DATABASE_URL is a local development database.
 *
 * Run: npm run check:campaign-delivery-db
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
  throw new Error('network disabled by check:campaign-delivery-db');
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
  const delivery = await import('@/lib/campaign/delivery-service');
  const campaignActions = await import('@/app/admin/campaigns/actions');
  const { LEGACY_CALENDAR } = await import('@/lib/calendar-scope');
  const { StudioError } = await import('@/lib/poster-studio/errors');
  const { prepareStudioInputImage, readStudioImageSize } = await import('@/lib/poster-studio/images');
  const { recordOpenAiImageUsage } = await import('@/lib/usage');
  const { loadStudioBrandCanvas } = await import('@/lib/poster-studio/brand-context');
  const { startOfZonedDay } = await import('@/lib/time');
  const { WhatsAppError } = await import('@/lib/whatsapp');
  const { deliveryInstant, deliverySpreadSeconds } = await import('@/lib/campaign/delivery');
  const { CampaignDomainError, changeCampaignStatus, createCampaign, updateCampaignDayContent } = service;
  type Deps = import('@/lib/campaign/poster-generation-service').PosterGenerationDeps;
  type DeliveryDeps = import('@/lib/campaign/delivery-service').DeliveryDeps;

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

  // ---- The fake WhatsApp provider ----------------------------------------------
  interface SentMessage {
    number: string;
    mediaUrl: string;
    caption: string;
    fileName: string;
  }
  const sent: SentMessage[] = [];
  /** Set to make the next send fail in a specific way. */
  let nextFailure: Error | null = null;
  let clock = NOW;

  const deliveryDeps = (overrides: Partial<DeliveryDeps> = {}): DeliveryDeps =>
    delivery.defaultDeliveryDeps({
      timeZone: TZ,
      now: () => clock,
      whatsappConfigured: () => true,
      mediaConfigured: () => true,
      buildMediaUrl: async (posterVersionId) => `https://console.invalid/api/campaign-media/${posterVersionId}~9999999999~deadbeef`,
      sendMedia: async (input) => {
        if (nextFailure) {
          const failure = nextFailure;
          nextFailure = null;
          throw failure;
        }
        sent.push(input as SentMessage);
        return { providerMessageId: `wamid.FAKE${sent.length}` };
      },
      ...overrides,
    });

  // ---- Fixtures -----------------------------------------------------------------
  const plan = await tx.plan.create({ data: { name: 'check:delivery 20', durationDays: 20 } });
  const vertical = await tx.category.create({
    data: { name: 'check:delivery Vertical', contentStrategy: { pillars: [{ key: 'educational', label: 'Educational', weight: 2, guidance: 'Teach.' }, { key: 'tips', label: 'Tips', weight: 1, guidance: 'Advise.' }] } },
  });
  const portrait = { ...SAMPLE_LAYOUT_SPEC, aspect: 9 / 16 } as unknown as Prisma.InputJsonValue;
  const template = async (label: string, order: number) =>
    tx.categoryTemplate.create({
      data: { categoryId: vertical.id, label: `check:delivery ${label}`, gDriveFileId: `fixture-template-${label}`, gDriveViewUrl: 'https://drive.invalid/t', mimeType: 'image/png', width: 1080, height: 1920, layoutSpec: portrait, layoutApprovedAt: new Date(), createdAt: new Date(Date.parse('2026-01-01') + order * 1000) },
    });
  await template('A', 1);
  await template('B', 2);

  const brand = { colors: [{ hex: '#0e7c86', role: 'primary' }], typography: null, layoutDirectives: [], assets: [] };
  const makeClient = (name: string, data: Partial<Prisma.ClientUncheckedCreateInput> = {}) =>
    tx.client.create({
      data: { companyName: `check:delivery ${name}`, whatsappNumber: '919876500999', startDate: today, endDate: today, planId: plan.id, categoryId: vertical.id, isDemo: true, isActive: false, imageSizePreset: 'whatsapp-status', brandGuideline: brand, brandTagline: 'Care', websiteUrl: 'delivery-fixture.invalid', gDriveFolderId: 'SECRET-DELIVERY-FOLDER', ...data },
    });
  const clientA = await makeClient('Clinic');
  const legacy = await makeClient('Legacy');

  async function readyCampaign(clientId: string, options: { approvalPolicy?: 'AUTO_APPROVE'; deliveryTime?: string } = {}) {
    const { campaignId } = await createCampaign(tx, { clientId, name: 'Delivery', startDate: today, timeZone: TZ, ...options });
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
  const approve = async (n: number) => {
    const day = await dayRow(n);
    await posters.approveCampaignDayPoster(tx, day.id, day.activePosterVersionId!);
    return day;
  };
  const deliveryOf = async (n: number) =>
    tx.campaignDelivery.findUnique({ where: { calendarDayId: (await dayRow(n)).id } });

  await tx.contentCalendar.create({ data: { clientId: legacy.id, dayNumber: 1, scheduledDate: today, caption: 'Legacy', hashtags: '#l', imagePrompt: 'p' } });
  const legacyBefore = snapshot(await tx.contentCalendar.findMany({ where: { clientId: legacy.id } }));
  const campaignDaysBefore = snapshot(
    await tx.contentCalendar.findMany({ where: { campaignId }, select: { id: true, deliveryStatus: true, sendAfter: true, approvedAt: true, gDriveFileId: true, gDriveViewUrl: true }, orderBy: { dayNumber: 'asc' } }),
  );

  // Posters for days 1–6; approve 1–4 only.
  for (const n of [1, 2, 3, 4, 5, 6]) await generate((await dayRow(n)).id);
  for (const n of [1, 2, 3, 4]) await approve(n);

  // =======================================================================
  section('scheduling books only approved days');
  // =======================================================================
  {
    const outcome = await delivery.scheduleCampaignDeliveries(tx, campaignId, deliveryDeps());
    t('every approved day is booked', outcome.scheduled.length === 4 && outcome.scheduled.join(',') === '1,2,3,4', snapshot(outcome.scheduled));

    const reasons = Object.fromEntries(outcome.skipped.map((group) => [group.reason, group.dayNumbers.length]));
    t('unapproved posters are reported, not booked', reasons['awaiting-approval'] === 2, snapshot(reasons));
    t('days with no poster are reported', (reasons['no-poster'] ?? 0) === 14, snapshot(reasons));
    t('nothing was sent by scheduling', sent.length === 0);

    const first = await deliveryOf(1);
    t('a booking pins the exact approved version', first?.posterVersionId === (await dayRow(1)).activePosterVersionId);
    t('a booking starts SCHEDULED with no attempts', first?.status === 'SCHEDULED' && first.attempts === 0 && first.sentAt === null);

    /*
     * Day 1 is today; its moment is today's deliveryTime in the app timezone,
     * plus the deterministic per-day spread added in Phase 7 so a fleet sharing
     * one delivery minute does not burst.
     */
    const base = deliveryInstant((await dayRow(1)).scheduledDate, '09:00', TZ);
    const offset = (first!.scheduledFor.getTime() - base.getTime()) / 1000;
    t('the moment is the day at the campaign delivery time, in the app timezone', offset >= 0 && offset < 600, `${first?.scheduledFor.toISOString()} is base + ${offset}s`);
    t('…offset by exactly the deterministic spread for this day', offset === deliverySpreadSeconds(first!.calendarDayId));

    const again = await delivery.scheduleCampaignDeliveries(tx, campaignId, deliveryDeps());
    t('re-running books nothing new', again.scheduled.length === 0);
    t('…and creates no duplicate rows', (await tx.campaignDelivery.count({ where: { campaignId } })) === 4);
  }

  // =======================================================================
  section('the unique constraint is the idempotency mechanism');
  // =======================================================================
  {
    const day1 = await dayRow(1);
    let code = '';
    try {
      // Inside a nested transaction on purpose: a constraint violation aborts
      // the enclosing Postgres transaction, and the facade's SAVEPOINT is what
      // lets the rest of the suite carry on after it.
      await tx.$transaction(async (nested) => {
        await nested.campaignDelivery.create({
          data: { campaignId, calendarDayId: day1.id, posterVersionId: day1.activePosterVersionId!, scheduledFor: new Date(), status: 'SCHEDULED' },
        });
      });
    } catch (error) {
      code = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : 'other';
    }
    t('a second delivery row for the same day is impossible', code === 'P2002', code);
    t('…and the day still has exactly one delivery', (await tx.campaignDelivery.count({ where: { calendarDayId: day1.id } })) === 1);
  }

  // =======================================================================
  section('the approval gate refuses, without reaching the provider');
  // =======================================================================
  {
    const before = sent.length;

    const day5 = await dayRow(5); // generated, never approved
    const pending = await delivery.sendCampaignDelivery(tx, day5.id, deliveryDeps(), { manual: true });
    t('an unapproved poster is never sent', !pending.ok && pending.reason === 'awaiting-approval');

    const day7 = await dayRow(7); // no poster at all
    const noPoster = await delivery.sendCampaignDelivery(tx, day7.id, deliveryDeps(), { manual: true });
    t('a day with no poster is never sent', !noPoster.ok && noPoster.reason === 'no-poster');

    // Reject day 6's poster.
    const day6 = await dayRow(6);
    const review = await import('@/lib/campaign/review-service');
    await review.rejectCampaignDayPoster(tx, day6.id, day6.activePosterVersionId!, { reason: 'image-quality', detail: 'blurry' });
    const rejected = await delivery.sendCampaignDelivery(tx, day6.id, deliveryDeps(), { manual: true });
    t('a rejected poster is never sent', !rejected.ok && rejected.reason === 'poster-rejected');

    // Outdate day 4 by editing its content after approval.
    const day4 = await dayRow(4);
    await updateCampaignDayContent(tx, day4.id, { headline: 'Changed after approval' });
    const outdated = await delivery.sendCampaignDelivery(tx, day4.id, deliveryDeps(), { manual: true });
    t('an outdated poster is never sent', !outdated.ok && outdated.reason === 'poster-outdated');

    // A deliverable day whose client's number is unusable: the gate must stop at
    // the recipient, not at anything else.
    await tx.client.update({ where: { id: clientA.id }, data: { whatsappNumber: 'not-a-number' } });
    const badRecipient = await delivery.sendCampaignDelivery(tx, (await dayRow(1)).id, deliveryDeps(), { manual: true });
    t('an invalid recipient is never sent to', !badRecipient.ok && badRecipient.reason === 'invalid-recipient', snapshot(badRecipient));
    await tx.client.update({ where: { id: clientA.id }, data: { whatsappNumber: '919876500999' } });

    const unconfigured = await delivery.sendCampaignDelivery(tx, (await dayRow(1)).id, deliveryDeps({ whatsappConfigured: () => false }), { manual: true });
    t('unconfigured WhatsApp sends nothing', !unconfigured.ok && unconfigured.reason === 'whatsapp-not-configured');
    const noMedia = await delivery.sendCampaignDelivery(tx, (await dayRow(1)).id, deliveryDeps({ mediaConfigured: () => false }), { manual: true });
    t('a missing public base URL sends nothing', !noMedia.ok && noMedia.reason === 'whatsapp-not-configured');

    t('not one of those refusals reached the provider', sent.length === before, `${sent.length - before} call(s)`);
  }

  // =======================================================================
  section('a paused campaign delivers nothing');
  // =======================================================================
  {
    const before = sent.length;
    await changeCampaignStatus(tx, campaignId, 'PAUSED');
    const paused = await delivery.sendCampaignDelivery(tx, (await dayRow(1)).id, deliveryDeps(), { manual: true });
    t('Send Now is refused while paused', !paused.ok && paused.reason === 'campaign-not-active');

    clock = (await deliveryOf(1))!.scheduledFor;
    const sweep = await delivery.runDueCampaignDeliveries(tx, deliveryDeps());
    t('the sweep sends nothing for a paused campaign', sweep.sent.length === 0);
    t('no provider call was made while paused', sent.length === before);
    t('the bookings are still there, untouched', (await deliveryOf(1))?.status === 'SCHEDULED');

    await changeCampaignStatus(tx, campaignId, 'ACTIVE');
    t('resuming creates no duplicate bookings', (await tx.campaignDelivery.count({ where: { campaignId } })) === 4);
  }

  // =======================================================================
  section('a successful send');
  // =======================================================================
  {
    const usageBefore = await tx.usageEvent.count({ where: { provider: 'EVOLUTION' } });
    const day1 = await dayRow(1);
    clock = (await deliveryOf(1))!.scheduledFor;

    const result = await delivery.sendCampaignDelivery(tx, day1.id, deliveryDeps());
    t('the day is sent', result.ok && result.dayNumber === 1, snapshot(result));

    const row = await deliveryOf(1);
    t('it is recorded SENT, once, with when', row?.status === 'SENT' && row.attempts === 1 && row.sentAt !== null);
    t("the provider's message id is kept", row?.providerMessageId === 'wamid.FAKE1');
    t('the claim is released', row?.sendingStartedAt === null && row?.failureReason === null);

    const message = sent.at(-1)!;
    t("the recipient is the client's own WhatsApp number", message.number === '919876500999');
    t('the caption is the approved content', message.caption === 'Headline 1\n\nSupporting 1.\n\nBook a visit', snapshot(message.caption));
    t('the file name is the campaign day, with no identifier', message.fileName === 'Campaign_Day_001.png');
    t('the media URL names the approved version', message.mediaUrl.includes(row!.posterVersionId));
    t('the media URL carries no Drive id', !/fake-drive-/.test(message.mediaUrl));
    t('the media URL carries no Drive folder', !message.mediaUrl.includes('SECRET-DELIVERY-FOLDER'));

    const usageAfter = await tx.usageEvent.count({ where: { provider: 'EVOLUTION' } });
    t('exactly one WhatsApp usage row is billed', usageAfter === usageBefore + 1, `${usageBefore} → ${usageAfter}`);
  }

  // =======================================================================
  section('already delivered means never again');
  // =======================================================================
  {
    const before = sent.length;
    const day1 = await dayRow(1);

    const second = await delivery.sendCampaignDelivery(tx, day1.id, deliveryDeps(), { manual: true });
    t('a second Send Now is refused', !second.ok && second.reason === 'already-delivered');

    const sweep = await delivery.runDueCampaignDeliveries(tx, deliveryDeps());
    t('the sweep never picks a sent day back up', !sweep.sent.includes(1));
    t('no second provider call was made', sent.length === before, `${sent.length - before} extra call(s)`);
    t('the record still shows one attempt', (await deliveryOf(1))?.attempts === 1);

    await expectDomainError('rescheduling a delivered day is refused', 'invalid-transition', () =>
      delivery.rescheduleCampaignDelivery(tx, day1.id, deliveryDeps()),
    );
  }

  // =======================================================================
  section('the atomic claim');
  // =======================================================================
  {
    const before = sent.length;
    const day2 = await dayRow(2);
    const row = await deliveryOf(2);

    // Simulate a worker that has just claimed this row and is mid-flight.
    await tx.campaignDelivery.update({ where: { id: row!.id }, data: { status: 'SENDING', sendingStartedAt: clock, attempts: 1 } });
    const blocked = await delivery.sendCampaignDelivery(tx, day2.id, deliveryDeps(), { manual: true });
    t('a live claim blocks a second sender', !blocked.ok && blocked.reason === 'sending');
    t('the blocked sender made no provider call', sent.length === before);

    // An attempt that died leaves a stale claim, which is reclaimable.
    await tx.campaignDelivery.update({ where: { id: row!.id }, data: { sendingStartedAt: new Date(clock.getTime() - 11 * 60_000) } });
    const reclaimed = await delivery.sendCampaignDelivery(tx, day2.id, deliveryDeps(), { manual: true });
    t('a stale claim is recovered and sent', reclaimed.ok);
    t('…and the attempt count reflects both tries', (await deliveryOf(2))?.attempts === 2);
  }

  // =======================================================================
  section('provider failures, retries and permanent failures');
  // =======================================================================
  {
    const day3 = await dayRow(3);
    clock = (await deliveryOf(3))!.scheduledFor;

    nextFailure = new WhatsAppError('provider', 'evolution.invalid responded 503 Service Unavailable: busy', true, 503);
    const failed = await delivery.sendCampaignDelivery(tx, day3.id, deliveryDeps(), { manual: true });
    t('a transient provider failure is reported, not thrown', !failed.ok && failed.reason === 'provider-failed' && !failed.permanent);

    const row = await deliveryOf(3);
    t('it is recorded FAILED with the reason and the attempt', row?.status === 'FAILED' && row.attempts === 1 && /503/.test(row.failureReason ?? ''));
    t('a transient failure stays retryable', row?.failurePermanent === false);
    t('the claim was released', row?.sendingStartedAt === null);

    // The retry succeeds.
    const retried = await delivery.sendCampaignDelivery(tx, day3.id, deliveryDeps(), { manual: true });
    t('the retry succeeds and the day is sent', retried.ok);
    t('the record is SENT with both attempts counted', (await deliveryOf(3))?.status === 'SENT' && (await deliveryOf(3))?.attempts === 2);
    t('the failure text is cleared on success', (await deliveryOf(3))?.failureReason === null);

    // A permanent failure is not retried.
    const day2 = await dayRow(2);
    await tx.campaignDelivery.update({ where: { calendarDayId: day2.id }, data: { status: 'SCHEDULED', attempts: 0, sentAt: null, providerMessageId: null } });
    nextFailure = new WhatsAppError('auth', 'evolution.invalid responded 401 Unauthorized', false, 401);
    const permanent = await delivery.sendCampaignDelivery(tx, day2.id, deliveryDeps(), { manual: true });
    t('an authentication failure is permanent', !permanent.ok && permanent.permanent);
    t('…and is recorded as such', (await deliveryOf(2))?.failurePermanent === true);

    const blocked = await delivery.sendCampaignDelivery(tx, day2.id, deliveryDeps(), { manual: true });
    t('a permanent failure is not retried', !blocked.ok && blocked.reason === 'permanent-failure');

    const sweepBefore = sent.length;
    await delivery.runDueCampaignDeliveries(tx, deliveryDeps());
    t('the sweep does not retry a permanent failure either', sent.length === sweepBefore);

    // A timeout is ambiguous, so it is treated as permanent on purpose.
    const day4 = await dayRow(4);
    await updateCampaignDayContent(tx, day4.id, { headline: 'Headline 4' });
    await generate(day4.id, 'regenerate');
    await approve(4);
    await delivery.rescheduleCampaignDelivery(tx, day4.id, deliveryDeps());
    nextFailure = new WhatsAppError('timeout', 'Request to evolution.invalid timed out after 60000ms', false, null);
    const timedOut = await delivery.sendCampaignDelivery(tx, day4.id, deliveryDeps(), { manual: true });
    t('an ambiguous timeout is permanent — it may already have been queued', !timedOut.ok && timedOut.permanent);
    t('…and says so on the record', /timed out/.test((await deliveryOf(4))?.failureReason ?? ''));
  }

  // =======================================================================
  section('the exact approved version is what goes out');
  // =======================================================================
  {
    const day5 = await dayRow(5);
    await approve(5);
    await delivery.scheduleCampaignDeliveries(tx, campaignId, deliveryDeps());
    const booked = await deliveryOf(5);
    const pinned = booked!.posterVersionId;
    t('day 5 is booked against the version approved now', pinned === (await dayRow(5)).activePosterVersionId);

    // Regenerate: a new PENDING version becomes active.
    await generate(day5.id, 'regenerate');
    const afterRegen = await dayRow(5);
    t('the new version is active and not approved', afterRegen.activePosterVersionId !== pinned);

    const before = sent.length;
    clock = (await deliveryOf(5))?.scheduledFor ?? deliveryInstant(afterRegen.scheduledDate, '09:00', TZ);
    const result = await delivery.sendCampaignDelivery(tx, day5.id, deliveryDeps(), { manual: true });
    t('the stale booking refuses rather than sending either version', !result.ok && (result.reason === 'version-changed' || result.reason === 'awaiting-approval'), snapshot(result));
    t('nothing went out', sent.length === before);
    t('the old pinned version was never sent', !sent.some((message) => message.mediaUrl.includes(pinned)));

    const row = await deliveryOf(5);
    t('the booking is cancelled, not left armed', row?.status === 'CANCELLED' || row?.status === 'SCHEDULED');
  }

  // =======================================================================
  section('the scheduled sweep');
  // =======================================================================
  {
    // A fresh client and campaign, so the sweep has clean state to work with.
    // (A client may hold only one campaign's worth of calendar days.)
    const sweepClient = await makeClient('Sweep');
    const futureCampaign = await readyCampaign(sweepClient.id, { deliveryTime: '18:30' });
    const d1 = (await service.findCampaignDay(tx, futureCampaign, 1))!;
    const d2 = (await service.findCampaignDay(tx, futureCampaign, 2))!;
    for (const day of [d1, d2]) {
      // `generate` above is bound to the first campaign; this one has its own.
      await posters.generateCampaignDayPoster(tx, futureCampaign, day.id, { ...load, mode: 'missing', explicit: true, deps });
      const fresh = await tx.contentCalendar.findUniqueOrThrow({ where: { id: day.id } });
      await posters.approveCampaignDayPoster(tx, day.id, fresh.activePosterVersionId!);
    }
    // Earlier sections moved the clock days ahead; booking is relative to it, so
    // wind it back to this campaign's first day before scheduling.
    clock = new Date(deliveryInstant(d1.scheduledDate, '18:30', TZ).getTime() - 3_600_000);
    const booked = await delivery.scheduleCampaignDeliveries(tx, futureCampaign, deliveryDeps());
    t('both approved days are booked', booked.scheduled.length === 2, snapshot(booked.scheduled));

    const before = sent.length;
    // Just before day 1's moment: nothing is due.
    const d1Booking = await tx.campaignDelivery.findUniqueOrThrow({ where: { calendarDayId: d1.id } });
    clock = new Date(d1Booking.scheduledFor.getTime() - 60_000);
    const early = await delivery.runDueCampaignDeliveries(tx, deliveryDeps());
    t('nothing is sent before its moment', early.sent.length === 0 && sent.length === before);

    // At day 1's moment: exactly day 1 goes.
    clock = d1Booking.scheduledFor;
    const due = await delivery.runDueCampaignDeliveries(tx, deliveryDeps());
    t('the day whose moment arrived is sent', due.sent.includes(1), snapshot(due.sent));
    t('exactly one message went out', sent.length === before + 1);
    t("tomorrow's day is untouched", (await tx.campaignDelivery.findUniqueOrThrow({ where: { calendarDayId: d2.id } })).status === 'SCHEDULED');

    // Running again immediately sends nothing more.
    const again = await delivery.runDueCampaignDeliveries(tx, deliveryDeps());
    t('a second sweep in the same minute sends nothing', again.sent.length === 0 && sent.length === before + 1);

    // A day whose local date has passed is skipped, not sent late.
    clock = new Date((await tx.campaignDelivery.findUniqueOrThrow({ where: { calendarDayId: d2.id } })).scheduledFor.getTime() + 36 * 3_600_000);
    await delivery.scheduleCampaignDeliveries(tx, futureCampaign, deliveryDeps());
    const missed = await tx.campaignDelivery.findUniqueOrThrow({ where: { calendarDayId: d2.id } });
    t('a delivery whose day has passed is SKIPPED, not sent late', missed.status === 'SKIPPED', missed.status);
    t('…and nothing more went out', sent.length === before + 1);
  }

  // =======================================================================
  section('server actions use the same gate');
  // =======================================================================
  {
    const day6 = await dayRow(6); // still rejected
    const refused = await asAction(() => campaignActions.sendCampaignDayNowAction(campaignId, day6.id));
    t('the Send Now action refuses a rejected poster', refused.ok && !refused.data.ok && refused.data.reason === 'poster-rejected');

    const day3 = await dayRow(3); // already SENT
    const cancelled = await asAction(() => campaignActions.cancelCampaignDeliveryAction(campaignId, day3.id));
    t('cancelling a sent day is refused', !cancelled.ok);

    const scheduleResult = await asAction(() => campaignActions.scheduleCampaignDeliveriesAction(campaignId));
    t('the schedule action returns a plan and sends nothing', scheduleResult.ok);

    const badId = await asAction(() => campaignActions.sendCampaignDayNowAction(campaignId, 'not-a-uuid'));
    t('a malformed id is rejected by the action', !badId.ok);

    // Phase 7: a day from another campaign cannot be delivered through this one.
    const otherCampaign = await readyCampaign((await makeClient('Other tenant')).id);
    const otherDay = (await service.findCampaignDay(tx, otherCampaign, 1))!;
    const crossed = await asAction(() => campaignActions.sendCampaignDayNowAction(campaignId, otherDay.id));
    t("another campaign's day is refused by the send action", !crossed.ok && /not part of this campaign/i.test(crossed.ok ? '' : crossed.error));
    const crossedCancel = await asAction(() => campaignActions.cancelCampaignDeliveryAction(campaignId, otherDay.id));
    t("…and by the cancel action", !crossedCancel.ok);
  }

  // =======================================================================
  section('the dashboard');
  // =======================================================================
  {
    const overview = await delivery.loadCampaignDeliveryOverview(tx, campaignId, deliveryDeps());
    t('the overview covers every day of the campaign', overview.days.length === 20);
    t('it names the destination as the client’s own number', overview.recipient.number === '919876500999' && overview.recipient.valid);
    t('the summary counts what happened', overview.summary.sent >= 2, snapshot(overview.summary));
    t('a sent day offers no Send Now', overview.days.find((day) => day.dayNumber === 1)?.canSendNow === false);
    t('a sent day reports its provider message id', overview.days.find((day) => day.dayNumber === 1)?.providerMessageId === 'wamid.FAKE1');
    t('an ineligible day carries the reason', typeof overview.days.find((day) => day.dayNumber === 7)?.refusal === 'string');
    t('no Drive id is in the dashboard payload', !snapshot(overview).includes('fake-drive-'));
    t('no Drive folder is in the dashboard payload', !snapshot(overview).includes('SECRET-DELIVERY-FOLDER'));
  }

  // =======================================================================
  section('credentials never leak into what is stored');
  // =======================================================================
  {
    process.env.EVOLUTION_API_KEY = 'super-secret-instance-token';
    const day = await dayRow(6);
    const review = await import('@/lib/campaign/review-service');
    // Un-reject it so the send can reach the provider call.
    await generate(day.id, 'regenerate');
    const fresh = await dayRow(6);
    await posters.approveCampaignDayPoster(tx, fresh.id, fresh.activePosterVersionId!);
    await delivery.rescheduleCampaignDelivery(tx, fresh.id, deliveryDeps());

    nextFailure = new WhatsAppError('auth', 'evolution.invalid responded 401 Unauthorized: key super-secret-instance-token rejected', false, 401);
    await delivery.sendCampaignDelivery(tx, fresh.id, deliveryDeps(), { manual: true });
    const row = await deliveryOf(6);
    t('the API key is redacted out of the stored failure', !(row?.failureReason ?? '').includes('super-secret-instance-token'), row?.failureReason ?? '');
    t('…and the redaction is visible', /«redacted»/.test(row?.failureReason ?? ''));
    process.env.EVOLUTION_API_KEY = '';
    void review;
  }

  // =======================================================================
  section('isolation from the legacy calendar');
  // =======================================================================
  {
    t('legacy rows are byte-identical', snapshot(await tx.contentCalendar.findMany({ where: { clientId: legacy.id } })) === legacyBefore);
    t('legacy scope still excludes campaign days', (await tx.contentCalendar.count({ where: { ...LEGACY_CALENDAR, clientId: clientA.id } })) === 0);

    const after = snapshot(
      await tx.contentCalendar.findMany({ where: { campaignId }, select: { id: true, deliveryStatus: true, sendAfter: true, approvedAt: true, gDriveFileId: true, gDriveViewUrl: true }, orderBy: { dayNumber: 'asc' } }),
    );
    t('campaign delivery writes no legacy delivery column', after === campaignDaysBefore);

    const legacyDelivery = await tx.campaignDelivery.count({ where: { calendarDay: { campaignId: null } } });
    t('no delivery row was ever created for a legacy day', legacyDelivery === 0);
  }

  // =======================================================================
  section('no real provider was reached');
  // =======================================================================
  {
    t('zero network attempts (no OpenAI, no Evolution, no Drive)', networkAttempts === 0, String(networkAttempts));
    t('every message went to the fake provider only', sent.every((message) => message.number === '919876500999'));
    t('no message body contains a credential', !sent.some((message) => snapshot(message).includes('super-secret')));
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

  await realPrisma.$disconnect();
  console.log(`\n${bad === 0 ? 'All campaign delivery database checks passed.' : `${bad} check(s) FAILED.`}`);
  process.exit(bad === 0 ? 0 : 1);
}

void main();
