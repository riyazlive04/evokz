/**
 * Regression checks: legacy calendar tooling must not touch campaign days.
 *
 * Runs the **real** dashboard server actions, sheet importer, manual upload,
 * AI seeder entry point, creative pipeline and dispatch sweep against fixture
 * clients whose calendars mix campaign days (`campaignId` set) with legacy days.
 * Every check asserts two things: the legacy rows still change exactly as they
 * did before, and every campaign row — and its poster versions — is
 * byte-identical afterwards.
 *
 * How it stays harmless:
 *   - The app's shared Prisma client (`globalThis.prisma`, see src/lib/prisma.ts)
 *     is replaced by a facade over ONE interactive transaction that is always
 *     rolled back; table row counts are compared before and after.
 *   - `fetch` is replaced with a stub that refuses and counts every call, and
 *     provider credentials are blanked. The suite asserts zero network attempts.
 *   - Fixtures that reach the creative pipeline belong to a client with no Drive
 *     folder, so the pipeline stops at its load stage before any provider.
 *   - Refuses to run unless DATABASE_URL is a local development database.
 *
 * Run: npm run check:calendar-scope
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { Prisma, PrismaClient } from '@prisma/client';

// ---- Isolation, before any app module loads ---------------------------------

// What Next's own server runtime installs before its request stores load.
(globalThis as unknown as { AsyncLocalStorage: typeof AsyncLocalStorage }).AsyncLocalStorage = AsyncLocalStorage;

for (const key of [
  'OPENAI_API_KEY',
  'FAL_KEY',
  'EVOLUTION_API_KEY',
  'EVOLUTION_API_URL',
  'GOOGLE_PRIVATE_KEY',
  'GOOGLE_SERVICE_ACCOUNT_EMAIL',
]) {
  process.env[key] = '';
}

let networkAttempts = 0;
globalThis.fetch = (async () => {
  networkAttempts += 1;
  throw new Error('network disabled by check:calendar-scope');
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
    console.error(
      `Refusing to run: DATABASE_URL must be a local development database (got host "${host || '?'}", database "${database || '?'}").`,
    );
    process.exit(2);
  }
  console.log(`database: ${database} @ ${host}`);
}

let bad = 0;
const t = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) bad += 1;
};
const section = (title: string) =>
  console.log(`\n--- ${title} ${'-'.repeat(Math.max(0, 58 - title.length))}`);
const snapshot = (value: unknown) => JSON.stringify(value);

class Rollback extends Error {}

// ---- Transaction facade ------------------------------------------------------

const realPrisma = new PrismaClient();
let activeTx: Prisma.TransactionClient | null = null;

/**
 * Stands in for the app's PrismaClient. Model calls go to the active
 * transaction; `$transaction` runs its batch or callback inside that same
 * transaction, which is what the actions under test expect of it.
 */
const facade: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    if (prop === '$transaction') {
      return async (arg: unknown) => {
        if (Array.isArray(arg)) {
          const results: unknown[] = [];
          for (const operation of arg) results.push(await operation);
          return results;
        }
        if (typeof arg === 'function') return (arg as (tx: PrismaClient) => unknown)(facade);
        throw new Error('Unsupported $transaction argument');
      };
    }
    if (!activeTx) throw new Error('No active check transaction');
    const value = Reflect.get(activeTx, prop) as unknown;
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(activeTx) : value;
  },
});
(globalThis as unknown as { prisma: PrismaClient }).prisma = facade;

// ---- Next request store, so `revalidatePath` in the actions is a no-op ------

type AsyncStorage = { run<T>(store: object, fn: () => T): T };
let requestStore: AsyncStorage;

async function asAction<T>(work: () => Promise<T>): Promise<T> {
  return requestStore.run(
    { incrementalCache: {}, urlPathname: '/admin/check', isStaticGeneration: false },
    work,
  );
}

// ---------------------------------------------------------------------------

const TABLES = ['Client', 'Campaign', 'ContentCalendar', 'PosterVersion', 'Category', 'CategoryTemplate', 'Plan', 'UsageEvent'];

async function tableCounts(): Promise<string> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const rows = await realPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "${table}"`);
    counts[table] = Number(rows[0]?.n ?? -1);
  }
  return snapshot(counts);
}

async function suite(): Promise<void> {
  const tx = facade;

  const actions = await import('@/app/admin/dashboard/actions');
  const { executeIntervalDispatch } = await import('@/lib/cron-worker');
  const { addPosterVersion, createCampaign } = await import('@/lib/campaign/service');
  const { CAMPAIGN_DAY_REFUSAL, LEGACY_CALENDAR } = await import('@/lib/calendar-scope');
  const { getAppTimeZone, nthDeliveryDate, startOfZonedDay, toTimeString } = await import('@/lib/time');

  const timeZone = getAppTimeZone();
  const now = new Date();
  const today = startOfZonedDay(now, timeZone);
  const DAY = 86_400_000;
  const refusedAsCampaign = (message: string | undefined) => (message ?? '').includes('campaign');

  t('LEGACY_CALENDAR selects rows with no campaign', snapshot(LEGACY_CALENDAR) === '{"campaignId":null}');

  // ---- Fixtures ------------------------------------------------------------
  const plan30 = await tx.plan.create({ data: { name: 'check:calendar-scope 30', durationDays: 30 } });
  const plan5 = await tx.plan.create({ data: { name: 'check:calendar-scope 5', durationDays: 5 } });
  const vertical = await tx.category.create({ data: { name: 'check:calendar-scope Dental' } });
  const otherVertical = await tx.category.create({ data: { name: 'check:calendar-scope Retail' } });
  const template = await tx.categoryTemplate.create({
    data: {
      categoryId: vertical.id,
      label: 'Scope Fixture A',
      gDriveFileId: 'fixture-scope-template',
      gDriveViewUrl: 'https://drive.invalid/scope-template',
      mimeType: 'image/png',
      width: 1080,
      height: 1920,
      layoutApprovedAt: now,
    },
  });

  const makeClient = (name: string, data: Partial<Prisma.ClientUncheckedCreateInput>) =>
    tx.client.create({
      data: {
        companyName: `check:calendar-scope ${name}`,
        whatsappNumber: '910000000000',
        startDate: new Date(today.getTime() - DAY),
        endDate: new Date(today.getTime() + 60 * DAY),
        planId: plan30.id,
        categoryId: vertical.id,
        isDemo: true,
        isActive: false,
        ...data,
      },
    });

  const legacyRow = (clientId: string, dayNumber: number, data: Partial<Prisma.ContentCalendarUncheckedCreateInput> = {}) =>
    tx.contentCalendar.create({
      data: {
        clientId,
        dayNumber,
        scheduledDate: new Date(today.getTime() + dayNumber * DAY),
        caption: `Legacy caption ${dayNumber}`,
        hashtags: '#legacy',
        imagePrompt: 'legacy prompt',
        ...data,
      },
    });

  const setDay = async (campaignId: string, dayNumber: number, data: Prisma.ContentCalendarUncheckedUpdateManyInput) =>
    tx.contentCalendar.updateMany({ where: { campaignId, dayNumber }, data });
  const ageRow = (id: string) =>
    tx.$executeRawUnsafe(`UPDATE "ContentCalendar" SET "updatedAt" = $1 WHERE "id" = $2`, new Date(now.getTime() - 3_600_000), id);

  const campaignState = async (clientId: string) => {
    const days = await tx.contentCalendar.findMany({
      where: { clientId, campaignId: { not: null } },
      orderBy: { dayNumber: 'asc' },
    });
    const versions = await tx.posterVersion.findMany({
      where: { calendarDayId: { in: days.map((day) => day.id) } },
      orderBy: [{ calendarDayId: 'asc' }, { versionNumber: 'asc' }],
    });
    return snapshot({ days, versions });
  };
  const legacyDay = (clientId: string, dayNumber: number) =>
    tx.contentCalendar.findUniqueOrThrow({ where: { clientId_dayNumber: { clientId, dayNumber } } });

  // ---- Mixed client M: campaign days 1–10, legacy days 11–15 ----------------
  // Inactive, so the dispatch sweep below can never reach it.
  const mixed = await makeClient('Mixed', { gDriveFolderId: 'fixture-scope-folder' });
  const mixedCampaign = await createCampaign(tx, {
    clientId: mixed.id,
    name: 'Scope campaign',
    startDate: today,
    durationDays: 10,
    templateMappingMode: 'MANUAL',
    timeZone,
  });
  // Campaign days dressed as every state a legacy filter looks for.
  await setDay(mixedCampaign.campaignId, 1, { deliveryStatus: 'FAILED', posterTemplateId: template.id });
  await setDay(mixedCampaign.campaignId, 2, { deliveryStatus: 'GENERATED', gDriveFileId: 'fixture-c2' });
  await setDay(mixedCampaign.campaignId, 3, { deliveryStatus: 'GENERATED', gDriveFileId: 'fixture-c3', approvedAt: now });
  await setDay(mixedCampaign.campaignId, 4, { posterTemplateId: template.id });
  const day6 = await tx.contentCalendar.findFirstOrThrow({ where: { campaignId: mixedCampaign.campaignId, dayNumber: 6 } });
  await addPosterVersion(tx, { calendarDayId: day6.id, source: 'PIPELINE', imageDriveFileId: 'fixture-scope-v1', imageMimeType: 'image/png', contentRevision: 1 });

  await legacyRow(mixed.id, 11, { posterTemplateId: template.id });
  await legacyRow(mixed.id, 12, { deliveryStatus: 'FAILED', posterTemplateId: template.id });
  await legacyRow(mixed.id, 13, { deliveryStatus: 'GENERATED', gDriveFileId: 'fixture-l13' });
  await legacyRow(mixed.id, 14, { deliveryStatus: 'GENERATED', gDriveFileId: 'fixture-l14', approvedAt: now });
  await legacyRow(mixed.id, 15);

  const campaignDayId = async (dayNumber: number) =>
    (await tx.contentCalendar.findFirstOrThrow({ where: { campaignId: mixedCampaign.campaignId, dayNumber } })).id;
  const mixedBefore = await campaignState(mixed.id);

  // =========================================================================
  section('queue all');
  // =========================================================================
  {
    const result = await asAction(() => actions.queueCampaignGeneration(mixed.id));
    t('legacy PENDING days are queued (11, 15)', result.ok && result.data.queued === 2 && result.data.alreadyQueued === 0, snapshot(result));
    t('…and carry the queue mark', (await legacyDay(mixed.id, 11)).generationQueuedAt !== null && (await legacyDay(mixed.id, 15)).generationQueuedAt !== null);
    t('no campaign day is queued', (await tx.contentCalendar.count({ where: { clientId: mixed.id, campaignId: { not: null }, generationQueuedAt: { not: null } } })) === 0);
  }

  // =========================================================================
  section('changing delivery days');
  // =========================================================================
  {
    const result = await asAction(() => actions.updateClientDeliveryDays(mixed.id, [1, 3, 5]));
    t('legacy PENDING days are rescheduled (2) and legacy others kept (3)', result.ok && result.data.rescheduled === 2 && result.data.kept === 3, snapshot(result));
    t(
      '…to the new weekday placement',
      (await legacyDay(mixed.id, 15)).scheduledDate.getTime() === nthDeliveryDate(mixed.startDate, 15, [1, 3, 5], timeZone).getTime(),
    );
    t('client delivery days updated', snapshot((await tx.client.findUniqueOrThrow({ where: { id: mixed.id } })).deliveryDays) === '[1,3,5]');
  }

  // =========================================================================
  section('changing vertical');
  // =========================================================================
  {
    const result = await asAction(() => actions.updateClientCategory(mixed.id, otherVertical.id));
    t('legacy pinned PENDING/FAILED days are unpinned (11, 12)', result.ok && result.data.unpinnedDays === 2, snapshot(result));
    t('…their pins are cleared', (await legacyDay(mixed.id, 11)).posterTemplateId === null && (await legacyDay(mixed.id, 12)).posterTemplateId === null);
    t('campaign days keep their template', (await tx.contentCalendar.count({ where: { campaignId: mixedCampaign.campaignId, posterTemplateId: template.id } })) === 2);
  }

  // =========================================================================
  section('approval actions');
  // =========================================================================
  {
    const all = await asAction(() => actions.approveAllCreatives(mixed.id));
    t('approve all approves the legacy waiting poster only (13)', all.ok && all.data.approved === 1, snapshot(all));
    t('…legacy day 13 approved', (await legacyDay(mixed.id, 13)).approvedAt !== null);

    const approveCampaign = await asAction(async () => actions.approveCreative(await campaignDayId(2)));
    t('approving a campaign day is refused', !approveCampaign.ok && approveCampaign.error === CAMPAIGN_DAY_REFUSAL, snapshot(approveCampaign));

    const unapproveLegacy = await asAction(async () => actions.unapproveCreative((await legacyDay(mixed.id, 14)).id));
    t('withdrawing a legacy approval still works (14)', unapproveLegacy.ok && (await legacyDay(mixed.id, 14)).approvedAt === null, snapshot(unapproveLegacy));
    const unapproveCampaign = await asAction(async () => actions.unapproveCreative(await campaignDayId(3)));
    t('withdrawing a campaign day approval is refused', !unapproveCampaign.ok && unapproveCampaign.error === CAMPAIGN_DAY_REFUSAL, snapshot(unapproveCampaign));

    const approveLegacy = await asAction(async () => actions.approveCreative((await legacyDay(mixed.id, 14)).id));
    t('approving a legacy poster still works (14, future day, no send booked)', approveLegacy.ok && !approveLegacy.data.sendsNow, snapshot(approveLegacy));
  }

  // =========================================================================
  section('per-day pipeline and delete actions');
  // =========================================================================
  {
    const regenerate = await asAction(async () => actions.regenerateCreative(await campaignDayId(3)));
    t('regenerating a campaign day is refused', !regenerate.ok && regenerate.error === CAMPAIGN_DAY_REFUSAL, snapshot(regenerate));

    const resend = await asAction(async () => actions.forceResendCreative(await campaignDayId(3)));
    t('send now on a campaign day is refused by the pipeline', !resend.ok && resend.error.includes(CAMPAIGN_DAY_REFUSAL), snapshot(resend));

    const deleteCampaign = await asAction(async () => actions.deleteCalendarEntry(await campaignDayId(5)));
    t('deleting a campaign day is refused', !deleteCampaign.ok && deleteCampaign.error === CAMPAIGN_DAY_REFUSAL, snapshot(deleteCampaign));
    const deleteLegacy = await asAction(async () => actions.deleteCalendarEntry((await legacyDay(mixed.id, 12)).id));
    t('deleting a legacy FAILED day still works (12)', deleteLegacy.ok && deleteLegacy.data.dayNumber === 12, snapshot(deleteLegacy));

    const retry = await asAction(() => actions.retryFailedDeliveries(mixed.id));
    t('retry ignores the FAILED campaign day (no legacy failures left)', !retry.ok && retry.error === 'No failed deliveries to retry.', snapshot(retry));
  }

  // =========================================================================
  section('changing plan');
  // =========================================================================
  {
    const mixedPlan = await asAction(() => actions.updateClientPlan(mixed.id, plan5.id));
    t(
      'stranded-day refusal counts legacy days only (11, 13, 14, 15)',
      !mixedPlan.ok && mixedPlan.error.startsWith('4 calendar day(s)'),
      snapshot(mixedPlan),
    );

    const campaignOnly = await makeClient('Campaign only', {});
    await createCampaign(tx, { clientId: campaignOnly.id, name: 'Ten days', startDate: today, durationDays: 10, timeZone });
    const campaignOnlyBefore = await campaignState(campaignOnly.id);
    const shortened = await asAction(() => actions.updateClientPlan(campaignOnly.id, plan5.id));
    t('campaign days beyond the client plan do not block a plan change', shortened.ok, snapshot(shortened));
    t('…and are not touched by it', (await campaignState(campaignOnly.id)) === campaignOnlyBefore);
  }

  // =========================================================================
  section('legacy calendar writers refuse a campaign calendar');
  // =========================================================================
  {
    const seed = await asAction(() => actions.seedContentCalendar(mixed.id, 1));
    t('AI seeding is refused before any model call', !seed.ok && refusedAsCampaign(seed.error), snapshot(seed));

    const importInput = {
      mode: 'overwrite' as const,
      rows: [
        { dayNumber: 4, templateName: template.label, caption: 'Imported caption for day four.', hashtags: '#import', imagePrompt: 'An imported image prompt', backgroundPrompt: null, poster: null },
      ],
    };
    const imported = await asAction(() => actions.importCalendarEntries(mixed.id, importInput));
    t('sheet import (overwrite) is refused', !imported.ok && refusedAsCampaign(imported.error), snapshot(imported));

    const form = new FormData();
    form.set('poster', new File([Buffer.from('not really a png')], 'day-3.png', { type: 'image/png' }));
    form.set('day', '3');
    form.set('caption', 'Caption for day 3 written by the operator.');
    form.set('link', '');
    const upload = await asAction(() => actions.uploadManualPoster(mixed.id, form));
    t(
      'manual upload is refused per file, before Drive',
      upload.ok && !upload.data.ok && refusedAsCampaign(upload.data.refused),
      snapshot(upload),
    );

    const legacyOnly = await makeClient('Legacy only', {});
    const legacyImport = await asAction(() =>
      actions.importCalendarEntries(legacyOnly.id, { ...importInput, mode: 'skip', rows: [{ ...importInput.rows[0]!, dayNumber: 1 }] }),
    );
    t('sheet import still writes a client without campaign days', legacyImport.ok && legacyImport.data.created === 1, snapshot(legacyImport));
  }

  // =========================================================================
  section('clear calendar');
  // =========================================================================
  {
    const cleared = await asAction(() => actions.clearClientCalendar(mixed.id));
    t('clears legacy PENDING/FAILED days (11, 15) and keeps legacy generated (13, 14)', cleared.ok && cleared.data.deleted === 2 && cleared.data.kept === 2, snapshot(cleared));
    t('every campaign day still exists', (await tx.contentCalendar.count({ where: { campaignId: mixedCampaign.campaignId } })) === 10);
  }

  t('MIXED CLIENT: campaign days and versions byte-identical after every legacy action', (await campaignState(mixed.id)) === mixedBefore);

  // =========================================================================
  section('dispatch sweep');
  // =========================================================================
  {
    const cronTime = toTimeString(now, timeZone);
    // Active, due this minute, and no Drive folder: legacy rows that reach the
    // pipeline stop at its load stage, before any provider.
    const sweepClient = await makeClient('Sweep', { isActive: true, isDemo: false, cronTime, gDriveFolderId: null });
    const sweepCampaign = await createCampaign(tx, { clientId: sweepClient.id, name: 'Sweep campaign', startDate: today, durationDays: 5, timeZone });

    await setDay(sweepCampaign.campaignId, 1, { approvedAt: now }); // phase 2: mark for generation
    await setDay(sweepCampaign.campaignId, 2, { deliveryStatus: 'GENERATED', gDriveFileId: 'fixture-s2', gDriveViewUrl: 'https://drive.invalid/s2', approvedAt: now, sendAfter: new Date(now.getTime() - 600_000) }); // phase 1: send
    await setDay(sweepCampaign.campaignId, 3, { generationQueuedAt: new Date(now.getTime() - 3_600_000) }); // phase 3: backlog
    await setDay(sweepCampaign.campaignId, 4, { deliveryStatus: 'GENERATED', gDriveFileId: 'fixture-s4', gDriveViewUrl: 'https://drive.invalid/s4', approvedAt: now, scheduledDate: today }); // phase 2: release
    await setDay(sweepCampaign.campaignId, 5, { deliveryStatus: 'FAILED' }); // retry
    await ageRow((await tx.contentCalendar.findFirstOrThrow({ where: { campaignId: sweepCampaign.campaignId, dayNumber: 4 } })).id);

    const release = await legacyRow(sweepClient.id, 6, { deliveryStatus: 'GENERATED', gDriveFileId: 'fixture-l6', gDriveViewUrl: 'https://drive.invalid/l6', approvedAt: now, scheduledDate: today });
    await ageRow(release.id);
    await legacyRow(sweepClient.id, 7, { approvedAt: now, scheduledDate: today });
    await legacyRow(sweepClient.id, 8, { deliveryStatus: 'GENERATED', gDriveFileId: 'fixture-l8', gDriveViewUrl: 'https://drive.invalid/l8', approvedAt: now, sendAfter: new Date(now.getTime() - 600_000) });
    await legacyRow(sweepClient.id, 9, { deliveryStatus: 'FAILED' });

    const sweepBefore = await campaignState(sweepClient.id);
    const campaignIds = (await tx.contentCalendar.findMany({ where: { campaignId: sweepCampaign.campaignId }, select: { id: true } })).map((row) => row.id);

    const retry = await asAction(() => actions.retryFailedDeliveries(sweepClient.id));
    t('retry attempts the legacy FAILED day only (9)', retry.ok && retry.data.attempted === 1, snapshot(retry));

    // Other rows the fleet-wide phases would pick up would make this unsafe to run.
    const foreign = await tx.contentCalendar.count({
      where: {
        clientId: { not: sweepClient.id },
        client: { isActive: true, isDemo: false },
        OR: [
          { deliveryStatus: 'GENERATED', sendAfter: { not: null } },
          { deliveryStatus: 'PENDING', generationQueuedAt: { not: null } },
        ],
      },
    });
    if (foreign > 0) {
      t('dispatch sweep check can run safely', false, `${foreign} non-fixture row(s) are sweepable in this database`);
    } else {
      const summary = await asAction(() => executeIntervalDispatch(now));
      const touched = summary.items.map((item) => item.calendarId);
      t('sweep outcomes never name a campaign day', !touched.some((id) => campaignIds.includes(id)), snapshot(touched));
      t('legacy approved day is released (6: send booked)', (await legacyDay(sweepClient.id, 6)).sendAfter !== null);
      const marked = await legacyDay(sweepClient.id, 7);
      t('legacy approved PENDING day is marked and rendered (7: claimed, failed at load)', marked.generationQueuedAt === null && marked.deliveryStatus === 'FAILED' && (marked.errorMessage ?? '').startsWith('[load]'), marked.errorMessage ?? '');
      const sent = await legacyDay(sweepClient.id, 8);
      t('legacy due send is claimed (8: send cleared, failed at load)', sent.sendAfter === null && sent.deliveryStatus === 'FAILED');
      t('SWEEP CLIENT: campaign days byte-identical after retry and sweep', (await campaignState(sweepClient.id)) === sweepBefore);
    }
  }
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
      { timeout: 180_000, maxWait: 10_000 },
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
  t('no network call was attempted', networkAttempts === 0, String(networkAttempts));

  console.log(`\n${bad === 0 ? 'All calendar scope checks passed.' : `${bad} check(s) FAILED.`}`);
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
