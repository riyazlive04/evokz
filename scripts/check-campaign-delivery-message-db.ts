/**
 * Database checks for the campaign delivery message: the Caption and Link sent
 * with a ready-to-send poster, and the internal Notes that never are.
 *
 * Saving, editing and persistence (`saveCampaignDayMessage`), what the board
 * shows, and the exact payload the sender hands the WhatsApp provider — on a
 * first send, after an edit, and on a retry. Each day is sent on its own
 * (`sendCampaignDelivery`); the global sweep is never run, so other campaigns
 * in the database play no part.
 *
 * **No provider is reachable.** The image model, Drive and WhatsApp are
 * in-process fakes and `fetch` is disabled and counted.
 *
 * How it stays harmless (the `check:campaign-delivery-db` technique): a facade
 * over ONE interactive transaction that is always rolled back; table row counts
 * are compared before and after; refuses to run unless DATABASE_URL is a local
 * development database.
 *
 * Run: npm run check:campaign-delivery-message-db
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
  throw new Error('network disabled by check:campaign-delivery-message-db');
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
  const delivery = await import('@/lib/campaign/delivery-service');
  const board = await import('@/lib/campaign/board-service');
  const boardActions = await import('@/app/admin/campaigns/board-actions');
  const { StudioError } = await import('@/lib/poster-studio/errors');
  const { readStudioImageSize } = await import('@/lib/poster-studio/images');
  const { recordOpenAiImageUsage } = await import('@/lib/usage');
  const { loadStudioBrandCanvas } = await import('@/lib/poster-studio/brand-context');
  const { startOfZonedDay } = await import('@/lib/time');
  const { WhatsAppError } = await import('@/lib/whatsapp');
  const { CampaignDomainError, changeCampaignStatus, createCampaign } = service;
  type Deps = import('@/lib/campaign/poster-generation-service').PosterGenerationDeps;
  type DeliveryDeps = import('@/lib/campaign/delivery-service').DeliveryDeps;

  const TZ = 'Asia/Kolkata';
  const NOW = new Date();
  const today = startOfZonedDay(NOW, TZ);
  const load = { timeZone: TZ, now: NOW };

  async function expectDomainError(name: string, code: string, work: () => Promise<unknown>, pattern?: RegExp) {
    try {
      await work();
      t(name, false, 'succeeded but should have failed');
    } catch (error) {
      t(name, error instanceof CampaignDomainError && error.code === code && (!pattern || pattern.test(error.message)), error instanceof Error ? error.message : String(error));
    }
  }

  // ---- Fakes -------------------------------------------------------------------
  const png = (width: number, height: number, color: string) => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
  const templatePng = await png(540, 960, '#3366aa');
  let fileCounter = 0;
  const deps: Deps = {
    assertConfigured: () => undefined,
    loadBrandCanvas: loadStudioBrandCanvas,
    resolveLogo: async () => null,
    composeIdentity: async (raw) => raw,
    checkText: async () => ({ checkedAt: NOW.toISOString(), model: 'fake', ok: true, items: [], leftovers: [] }),
    prepareTemplate: async (bytes) => ({ bytes, mimeType: 'image/png' }),
    resolveFolder: async () => 'fixture-folder',
    readFile: async (fileId) => {
      if (!fileId.startsWith('fixture-template')) throw new StudioError('storage', 'Could not load the image from Google Drive.');
      return templatePng;
    },
    render: async (request) => {
      const [width, height] = request.size.split('x').map(Number) as [number, number];
      return { bytes: await png(width, height, '#88ccbb'), mimeType: 'image/png', model: 'gpt-image-2', quality: 'low', usage: { textInputTokens: 100, imageInputTokens: 900, outputTokens: 4000 } };
    },
    recordUsage: recordOpenAiImageUsage,
    readImageSize: readStudioImageSize,
    store: async () => `fake-drive-${(fileCounter += 1)}`,
    trash: async () => undefined,
  };

  interface SentMessage {
    number: string;
    mediaUrl: string;
    caption: string;
    fileName: string;
  }
  const sent: SentMessage[] = [];
  let nextFailure: Error | null = null;
  const deliveryDeps = (): DeliveryDeps =>
    delivery.defaultDeliveryDeps({
      timeZone: TZ,
      now: () => NOW,
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
        return { providerMessageId: `wamid.MSG${sent.length}` };
      },
    });

  // ---- Fixtures: an active campaign with approved posters ---------------------------
  const plan = await tx.plan.create({ data: { name: 'check:message 10', durationDays: 10 } });
  const vertical = await tx.category.create({
    data: { name: 'check:message Vertical', contentStrategy: { pillars: [{ key: 'educational', label: 'Educational', weight: 1, guidance: 'Teach.' }] } },
  });
  await tx.categoryTemplate.create({
    data: {
      categoryId: vertical.id,
      label: 'check:message A',
      gDriveFileId: 'fixture-template-A',
      gDriveViewUrl: 'https://drive.invalid/t',
      mimeType: 'image/png',
      width: 1080,
      height: 1920,
      elements: {
        version: 1,
        width: 1080,
        height: 1920,
        model: 'fake',
        elements: [
          { id: 'e1', kind: 'headline', text: 'Template headline', box: { x: 0.1, y: 0.1, w: 0.8, h: 0.1 }, group: null, description: null },
          { id: 'e3', kind: 'cta', text: 'Book a visit', box: { x: 0.1, y: 0.85, w: 0.4, h: 0.05 }, group: null, description: null },
        ],
      } as unknown as Prisma.InputJsonValue,
      elementsReadAt: new Date(),
    },
  });
  const client = await tx.client.create({
    data: { companyName: 'check:message Clinic', whatsappNumber: '919876500111', startDate: today, endDate: today, planId: plan.id, categoryId: vertical.id, isDemo: false, isActive: true, imageSizePreset: 'whatsapp-status', brandGuideline: { colors: [{ hex: '#0e7c86', role: 'primary' }], typography: null, layoutDirectives: [], assets: [] }, brandTagline: 'Care', websiteUrl: 'message-fixture.invalid', gDriveFolderId: 'SECRET-MESSAGE-FOLDER' },
  });
  const { campaignId } = await createCampaign(tx, { clientId: client.id, name: 'Message', startDate: today, timeZone: TZ });
  for (const day of await tx.contentCalendar.findMany({ where: { campaignId }, orderBy: { dayNumber: 'asc' } })) {
    await tx.contentCalendar.update({
      where: { id: day.id },
      data: { theme: `Topic ${day.dayNumber}`, contentType: 'educational', headline: `Headline ${day.dayNumber}`, supportingText: `Supporting ${day.dayNumber}.`, cta: 'Book a visit', caption: day.dayNumber === 3 ? '' : `Old caption ${day.dayNumber}`, hashtags: '#care', imagePrompt: `Scene ${day.dayNumber}.`, contentStatus: 'READY', contentRevision: { increment: 1 } },
    });
  }
  const preview = await mapping.previewAutoMap(tx, campaignId);
  await mapping.applyAutoMap(tx, campaignId, { fingerprint: preview.plan.fingerprint });
  await changeCampaignStatus(tx, campaignId, 'ACTIVE');

  const dayRow = async (n: number) => (await service.findCampaignDay(tx, campaignId, n))!;
  for (const n of [1, 2, 3, 4, 5]) {
    await posters.generateCampaignDayPoster(tx, campaignId, (await dayRow(n)).id, { ...load, mode: 'missing', explicit: true, deps });
  }
  for (const n of [1, 2, 3, 4]) {
    const day = await dayRow(n);
    await posters.approveCampaignDayPoster(tx, day.id, day.activePosterVersionId!);
  }
  // Day 2 is booked, as an approved day in a live campaign is.
  await tx.campaignDelivery.create({
    data: { campaignId, calendarDayId: (await dayRow(2)).id, posterVersionId: (await dayRow(2)).activePosterVersionId!, scheduledFor: new Date(NOW.getTime() + 86_400_000), status: 'SCHEDULED' },
  });
  const state = async (n: number) => {
    const day = await tx.contentCalendar.findUnique({
      where: { id: (await dayRow(n)).id },
      select: {
        caption: true,
        deliveryLink: true,
        internalNotes: true,
        contentRevision: true,
        contentStatus: true,
        activePosterVersionId: true,
        activePosterVersion: { select: { approvalStatus: true } },
        delivery: { select: { status: true, posterVersionId: true, scheduledFor: true } },
      },
    });
    return day!;
  };

  // =======================================================================
  section('saving and editing the message');
  // =======================================================================
  {
    const day2 = await dayRow(2);
    const before = await state(2);
    const saved = await delivery.saveCampaignDayMessage(tx, campaignId, day2.id, {
      caption: '  Free dental camp this Sunday.\r\nBring the family!  ',
      link: 'www.sirahdigital.in/camp',
      notes: 'Client asked for Sunday; confirm with Dr. Rao.',
    });
    t('the caption is saved trimmed, line breaks kept', saved.caption === 'Free dental camp this Sunday.\nBring the family!', snapshot(saved.caption));
    t('a bare web address is saved as https', saved.link === 'https://www.sirahdigital.in/camp');
    t('notes are saved', saved.notes === 'Client asked for Sunday; confirm with Dr. Rao.');
    const after = await state(2);
    t('the values persist on the campaign day', after.caption === saved.caption && after.deliveryLink === saved.link && after.internalNotes === saved.notes);
    t('the poster revision does not move — the approved poster stays current', after.contentRevision === before.contentRevision && after.activePosterVersionId === before.activePosterVersionId);
    t('the approval stays APPROVED', after.activePosterVersion?.approvalStatus === 'APPROVED');
    t('the booking is untouched: same status, version and moment', snapshot(after.delivery) === snapshot(before.delivery));
    t('the day stays READY', after.contentStatus === 'READY');

    const edited = await delivery.saveCampaignDayMessage(tx, campaignId, day2.id, { caption: 'Free dental camp on Sunday!', link: '', notes: null });
    const reread = await state(2);
    t('an edit replaces the caption; an empty link and notes are cleared', edited.caption === 'Free dental camp on Sunday!' && reread.deliveryLink === null && reread.internalNotes === null);
    t('…and still leaves the approval and booking alone', reread.activePosterVersion?.approvalStatus === 'APPROVED' && snapshot(reread.delivery) === snapshot(before.delivery));

    await expectDomainError('a non-web link is refused', 'invalid-input', () =>
      delivery.saveCampaignDayMessage(tx, campaignId, day2.id, { caption: 'x', link: 'javascript:alert(1)', notes: null }),
    );
    await expectDomainError('a link with spaces is refused', 'invalid-input', () =>
      delivery.saveCampaignDayMessage(tx, campaignId, day2.id, { caption: 'x', link: 'https://example.com/a b', notes: null }),
    );
    await expectDomainError('caption and link beyond WhatsApp’s limit are refused, not cut', 'invalid-input', () =>
      delivery.saveCampaignDayMessage(tx, campaignId, day2.id, { caption: 'y'.repeat(1010), link: 'https://example.com/offer', notes: null }),
      /1,024/,
    );
    t('a refused save changes nothing', (await state(2)).caption === 'Free dental camp on Sunday!');

    const otherClient = await tx.client.create({
      data: { companyName: 'check:message Other', whatsappNumber: '919876500222', startDate: today, endDate: today, planId: plan.id, categoryId: vertical.id, isDemo: false, isActive: true },
    });
    const other = await createCampaign(tx, { clientId: otherClient.id, name: 'Other', startDate: today, timeZone: TZ });
    await expectDomainError('a day is only saved through its own campaign', 'not-found', () =>
      delivery.saveCampaignDayMessage(tx, other.campaignId, day2.id, { caption: 'x', link: null, notes: null }),
    );

    const action = await asAction(() => boardActions.saveCampaignDayMessageAction(campaignId, day2.id, { caption: 'Saved through the board', link: 'https://sirahdigital.in', notes: 'Internal only' }));
    t('the board action saves and returns the stored values', action.ok && action.data.caption === 'Saved through the board' && action.data.link === 'https://sirahdigital.in');
    const badId = await asAction(() => boardActions.saveCampaignDayMessageAction(campaignId, 'not-a-uuid', { caption: 'x', link: null, notes: null }));
    t('the board action refuses a malformed id with operator copy', !badId.ok);
  }

  // =======================================================================
  section('the board shows it on ready-to-send posts');
  // =======================================================================
  {
    const view = await board.loadCampaignBoard(tx, campaignId, { now: NOW, timeZone: TZ, deliveryDeps: deliveryDeps() });
    const byNumber = (n: number) => view.days.find((day) => day.dayNumber === n)!;
    t('a scheduled post shows its saved caption, link and notes, editable', byNumber(2).message.shown && byNumber(2).message.editable && byNumber(2).message.caption === 'Saved through the board' && byNumber(2).message.notes === 'Internal only', snapshot(byNumber(2).message));
    t('an approved, unbooked post shows the fields too', byNumber(1).status === 'approved' && byNumber(1).message.shown, byNumber(1).status);
    t('a post still awaiting approval does not', byNumber(5).status === 'needs-approval' && !byNumber(5).message.shown, byNumber(5).status);
    t('an existing caption is shown pre-filled for review', byNumber(1).message.caption === 'Old caption 1');
  }

  // =======================================================================
  section('the WhatsApp payload');
  // =======================================================================
  {
    const day2 = await dayRow(2);
    const result = await delivery.sendCampaignDelivery(tx, day2.id, deliveryDeps(), { manual: true });
    const message = sent.at(-1)!;
    t('the day is sent', result.ok, snapshot(result));
    t('the payload is the saved caption, then the link on its own line', message.caption === 'Saved through the board\n\nhttps://sirahdigital.in', snapshot(message.caption));
    t('internal notes are not in the payload', !message.caption.includes('Internal only') && !JSON.stringify(message).includes('Internal only'));
    t('the poster and recipient are unchanged: the approved version to the client’s number', message.number === '919876500111' && message.mediaUrl.includes((await state(2)).activePosterVersionId!));

    await expectDomainError('once sent, the message can no longer change', 'invalid-transition', () =>
      delivery.saveCampaignDayMessage(tx, campaignId, day2.id, { caption: 'Too late', link: null, notes: null }),
      /has been sent/,
    );
    t('…and the stored message still matches what was sent', (await state(2)).caption === 'Saved through the board');
    const sentView = (await board.loadCampaignBoard(tx, campaignId, { now: NOW, timeZone: TZ, deliveryDeps: deliveryDeps() })).days.find((day) => day.dayNumber === 2)!;
    t('the board shows a sent message read-only', sentView.message.shown && !sentView.message.editable && /Sent/.test(sentView.message.lockedReason ?? ''));

    // A day with no caption keeps the message it always had.
    const day3 = await dayRow(3);
    await delivery.sendCampaignDelivery(tx, day3.id, deliveryDeps(), { manual: true });
    const words = await tx.contentCalendar.findUnique({ where: { id: day3.id }, select: { headline: true, supportingText: true, cta: true } });
    const { buildDeliveryCaption } = await import('@/lib/campaign/delivery');
    t('no caption: exactly the old message — the day’s headline, supporting text and CTA', sent.at(-1)!.caption === buildDeliveryCaption(words!) && sent.at(-1)!.caption.startsWith('Headline 3'), snapshot(sent.at(-1)!.caption));

    // No caption, but a link: the fallback words, then the link.
    const day4 = await dayRow(4);
    await delivery.saveCampaignDayMessage(tx, campaignId, day4.id, { caption: '', link: 'https://sirahdigital.in/book', notes: 'Never send this' });
    nextFailure = new WhatsAppError('provider', 'evolution.invalid responded 503 Service Unavailable', true, 503);
    const failed = await delivery.sendCampaignDelivery(tx, day4.id, deliveryDeps(), { manual: true });
    t('a transient failure leaves the delivery retryable', !failed.ok && !failed.permanent);
    const failedView = (await board.loadCampaignBoard(tx, campaignId, { now: NOW, timeZone: TZ, deliveryDeps: deliveryDeps() })).days.find((day) => day.dayNumber === 4)!;
    t('a failed delivery awaiting retry shows the fields, editable', failedView.status === 'failed' && failedView.message.shown && failedView.message.editable);

    // Edited between the failure and the retry: the retry sends the latest saved words.
    await delivery.saveCampaignDayMessage(tx, campaignId, day4.id, { caption: 'Book your check-up this week.', link: 'https://sirahdigital.in/book', notes: 'Never send this' });
    const retried = await delivery.sendCampaignDelivery(tx, day4.id, deliveryDeps(), { manual: true });
    t('the retry succeeds', retried.ok);
    t('…with the caption as saved at retry time, and the link', sent.at(-1)!.caption === 'Book your check-up this week.\n\nhttps://sirahdigital.in/book', snapshot(sent.at(-1)!.caption));
    t('notes never appear in any payload sent', sent.every((entry) => !/Never send this|Internal only/.test(JSON.stringify(entry))));
    const deliveryRow = await tx.campaignDelivery.findUnique({ where: { calendarDayId: day4.id } });
    t('the delivery row records the retry as usual', deliveryRow?.status === 'SENT' && deliveryRow.attempts === 2);
  }

  // =======================================================================
  section('a closed campaign');
  // =======================================================================
  {
    const day1 = await dayRow(1);
    await tx.campaign.update({ where: { id: campaignId }, data: { status: 'CANCELLED' } });
    await expectDomainError('a cancelled campaign’s messages cannot change', 'campaign-closed', () =>
      delivery.saveCampaignDayMessage(tx, campaignId, day1.id, { caption: 'x', link: null, notes: null }),
    );
  }

  t('zero network attempts (no OpenAI, no WhatsApp, no Drive)', networkAttempts === 0, String(networkAttempts));
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { staticGenerationAsyncStorage } = await import('next/dist/client/components/static-generation-async-storage.external.js');
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
  t('the database is exactly as it was found', tables.every((table) => before[table] === after[table]), `${snapshot(before)} → ${snapshot(after)}`);

  await realPrisma.$disconnect();
  console.log(`\n${bad === 0 ? 'All delivery message database checks passed.' : `${bad} check(s) FAILED.`}`);
  process.exit(bad === 0 ? 0 : 1);
}

void main();
