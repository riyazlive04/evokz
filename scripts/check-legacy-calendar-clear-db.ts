/**
 * Database checks for `clearUnsentLegacyCalendarAction`
 * (src/app/admin/dashboard/actions.ts): clearing a client's unsent calendar
 * days from before campaigns, which otherwise block every new campaign.
 *
 * Proves that only rows with no campaign that are PENDING or FAILED are deleted
 * — never a campaign day, never a GENERATED or DELIVERED row, never another
 * client's row — that a Drive file a kept row still uses is not binned, that a
 * failed bin is counted but does not stop the delete, and that the cleared
 * client can then create a campaign.
 *
 * Drive is unconfigured here (its credentials are blanked), so every bin attempt
 * fails inside `trashDriveFile` without a network call — which is exactly the
 * "could not bin" path the action must survive and report.
 *
 * How it stays harmless (the `check:campaign-posters-db` technique): one
 * interactive transaction, always rolled back, with savepoints for nested
 * transactions; table row counts compared before and after; `fetch` stubbed and
 * counted; refuses anything but a local development database.
 *
 * Run: npm run check:legacy-calendar-clear-db
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { Prisma, PrismaClient, type DeliveryStatus } from '@prisma/client';

(globalThis as unknown as { AsyncLocalStorage: typeof AsyncLocalStorage }).AsyncLocalStorage = AsyncLocalStorage;

for (const key of ['OPENAI_API_KEY', 'FAL_KEY', 'EVOLUTION_API_KEY', 'EVOLUTION_API_URL', 'GOOGLE_PRIVATE_KEY', 'GOOGLE_SERVICE_ACCOUNT_EMAIL']) {
  process.env[key] = '';
}
let networkAttempts = 0;
globalThis.fetch = (async () => {
  networkAttempts += 1;
  throw new Error('network disabled by check:legacy-calendar-clear-db');
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

async function suite(): Promise<void> {
  const tx = facade;
  const { clearUnsentLegacyCalendarAction } = await import('@/app/admin/dashboard/actions');
  const { CampaignDomainError, createCampaign } = await import('@/lib/campaign/service');
  const { addZonedDays, startOfZonedDay } = await import('@/lib/time');

  const TZ = 'Asia/Kolkata';
  const today = startOfZonedDay(new Date(), TZ);

  async function expectOccupied(name: string, work: () => Promise<unknown>) {
    try {
      await work();
      t(name, false, 'succeeded but should have been refused');
    } catch (error) {
      t(name, error instanceof CampaignDomainError && error.code === 'calendar-occupied', error instanceof Error ? error.message : String(error));
    }
  }

  // ---- Fixtures -----------------------------------------------------------------------
  const plan = await tx.plan.create({ data: { name: 'check:legacy-clear 10', durationDays: 10 } });
  const vertical = await tx.category.create({ data: { name: 'check:legacy-clear Vertical' } });
  let phone = 0;
  const makeClient = (companyName: string) =>
    tx.client.create({
      data: {
        companyName,
        whatsappNumber: `9198765003${String((phone += 1)).padStart(2, '0')}`,
        cronTime: '23:59',
        startDate: today,
        endDate: today,
        planId: plan.id,
        categoryId: vertical.id,
        isDemo: true,
        isActive: false,
      },
    });
  const legacyDay = (clientId: string, dayNumber: number, deliveryStatus: DeliveryStatus, gDriveFileId: string | null = null) =>
    tx.contentCalendar.create({
      data: {
        clientId,
        dayNumber,
        scheduledDate: addZonedDays(today, dayNumber - 1, TZ),
        caption: `check:legacy-clear day ${dayNumber}`,
        hashtags: '#check',
        imagePrompt: 'check',
        deliveryStatus,
        gDriveFileId,
        gDriveViewUrl: gDriveFileId ? `https://drive.invalid/${gDriveFileId}` : null,
      },
      select: { id: true },
    });
  const rowsOf = (clientId: string) =>
    tx.contentCalendar.findMany({
      where: { clientId },
      orderBy: { dayNumber: 'asc' },
      select: { id: true, dayNumber: true, campaignId: true, deliveryStatus: true, gDriveFileId: true, updatedAt: true },
    });

  // Mixed: a campaign (days 1–3, one of them FAILED) plus older days 4–9.
  const mixed = await makeClient('Legacy Clear Mixed');
  const { campaignId } = await createCampaign(tx, { clientId: mixed.id, name: 'Legacy clear campaign', startDate: addZonedDays(today, 1, TZ), durationDays: 3, timeZone: TZ });
  const campaignDays = await tx.contentCalendar.findMany({ where: { campaignId }, orderBy: { dayNumber: 'asc' }, select: { id: true } });
  await tx.contentCalendar.update({ where: { id: campaignDays[0]!.id }, data: { deliveryStatus: 'FAILED' } });
  await legacyDay(mixed.id, 4, 'PENDING', 'chk-file-pending');
  await legacyDay(mixed.id, 5, 'FAILED', 'chk-file-failed');
  await legacyDay(mixed.id, 6, 'PENDING');
  const generated = await legacyDay(mixed.id, 7, 'GENERATED', 'chk-file-generated');
  const delivered = await legacyDay(mixed.id, 8, 'DELIVERED', 'chk-file-delivered');
  // Unsent, but its file is the delivered day's: the file must stay.
  await legacyDay(mixed.id, 9, 'FAILED', 'chk-file-delivered');

  // Unsent only: older days 1–3, which block a new campaign.
  const unsentOnly = await makeClient('Legacy Clear Unsent');
  await legacyDay(unsentOnly.id, 1, 'PENDING');
  await legacyDay(unsentOnly.id, 2, 'FAILED');
  await legacyDay(unsentOnly.id, 3, 'PENDING');

  // Kept history: a delivered day 3 stays, so only a campaign of up to 2 days fits.
  const history = await makeClient('Legacy Clear History');
  await legacyDay(history.id, 1, 'PENDING');
  await legacyDay(history.id, 3, 'DELIVERED');

  // Another client's unsent day, never touched by clearing someone else.
  const bystander = await makeClient('Legacy Clear Bystander');
  const bystanderRow = await legacyDay(bystander.id, 1, 'PENDING', 'chk-file-bystander');

  // =======================================================================
  section('refusals');
  // =======================================================================
  {
    const malformed = await asAction(() => clearUnsentLegacyCalendarAction('not-a-uuid'));
    t('a malformed client id is refused', !malformed.ok, snapshot(malformed));
    const missing = await asAction(() => clearUnsentLegacyCalendarAction('00000000-0000-4000-8000-000000000000'));
    t('an unknown client is refused', !missing.ok && /no longer exists/.test(missing.error), snapshot(missing));
  }

  // =======================================================================
  section('the problem: older days block a new campaign');
  // =======================================================================
  await expectOccupied('unsent older days 1–3 refuse a 10-day campaign', () =>
    createCampaign(tx, { clientId: unsentOnly.id, name: 'Blocked', startDate: addZonedDays(today, 1, TZ), timeZone: TZ }),
  );

  // =======================================================================
  section('clearing a client with a campaign and history');
  // =======================================================================
  {
    const before = await rowsOf(mixed.id);
    const bystanderBefore = await rowsOf(bystander.id);
    const result = await asAction(() => clearUnsentLegacyCalendarAction(mixed.id));
    t('succeeds', result.ok, snapshot(result));
    const after = await rowsOf(mixed.id);

    if (result.ok) {
      t('deletes the four unsent older days (4, 5, 6, 9)', result.data.deleted === 4, snapshot(result.data));
      t('reports the two older days it kept', result.data.kept === 2, snapshot(result.data));
      t(
        'tries to bin only the two files no kept row uses, and reports both as not binned (Drive unconfigured)',
        result.data.filesNotBinned === 2 && result.data.filesBinned === 0,
        snapshot(result.data),
      );
    }

    t('the older days left are exactly the generated and delivered ones',
      snapshot(after.filter((row) => row.campaignId === null).map((row) => [row.dayNumber, row.deliveryStatus])) === snapshot([[7, 'GENERATED'], [8, 'DELIVERED']]),
      snapshot(after.map((row) => [row.dayNumber, row.deliveryStatus])));
    t('…with their ids and Drive files unchanged',
      after.some((row) => row.id === generated.id && row.gDriveFileId === 'chk-file-generated') &&
        after.some((row) => row.id === delivered.id && row.gDriveFileId === 'chk-file-delivered'));
    const campaignBefore = before.filter((row) => row.campaignId !== null);
    const campaignAfter = after.filter((row) => row.campaignId !== null);
    t('every campaign day is untouched, including a FAILED one',
      campaignBefore.length === 3 && snapshot(campaignAfter) === snapshot(campaignBefore) && campaignAfter[0]?.deliveryStatus === 'FAILED',
      snapshot(campaignAfter.map((row) => [row.dayNumber, row.deliveryStatus])));
    t('the campaign itself still exists', (await tx.campaign.count({ where: { id: campaignId } })) === 1);
    t('another client’s unsent day is untouched',
      snapshot(await rowsOf(bystander.id)) === snapshot(bystanderBefore) && bystanderBefore[0]?.id === bystanderRow.id);

    const again = await asAction(() => clearUnsentLegacyCalendarAction(mixed.id));
    t('a second clear deletes nothing and still keeps the history',
      again.ok && again.data.deleted === 0 && again.data.kept === 2 && again.data.filesNotBinned === 0,
      snapshot(again));
    t('…and leaves the rows as they were', snapshot(await rowsOf(mixed.id)) === snapshot(after));
  }

  // =======================================================================
  section('clearing unblocks a new campaign');
  // =======================================================================
  {
    const result = await asAction(() => clearUnsentLegacyCalendarAction(unsentOnly.id));
    t('clears all three unsent older days, keeping none, binning nothing', result.ok && result.data.deleted === 3 && result.data.kept === 0 && result.data.filesNotBinned === 0 && result.data.filesBinned === 0, snapshot(result));
    const created = await createCampaign(tx, { clientId: unsentOnly.id, name: 'Unblocked', startDate: addZonedDays(today, 1, TZ), timeZone: TZ });
    t('a 10-day campaign can now be created', (await tx.contentCalendar.count({ where: { campaignId: created.campaignId } })) === 10);
  }

  // =======================================================================
  section('kept history still holds its day numbers');
  // =======================================================================
  {
    const result = await asAction(() => clearUnsentLegacyCalendarAction(history.id));
    t('clears the unsent day 1 and keeps the delivered day 3', result.ok && result.data.deleted === 1 && result.data.kept === 1, snapshot(result));
    await expectOccupied('a campaign reaching day 3 is still refused', () =>
      createCampaign(tx, { clientId: history.id, name: 'Too long', startDate: addZonedDays(today, 1, TZ), durationDays: 3, timeZone: TZ }),
    );
    const short = await createCampaign(tx, { clientId: history.id, name: 'Short enough', startDate: addZonedDays(today, 1, TZ), durationDays: 2, timeZone: TZ });
    t('a campaign of up to (first kept day − 1) = 2 days fits, as the client page says', (await tx.contentCalendar.count({ where: { campaignId: short.campaignId } })) === 2);
    t('the delivered day is still there', (await tx.contentCalendar.count({ where: { clientId: history.id, campaignId: null, deliveryStatus: 'DELIVERED' } })) === 1);
  }

  t('ran against the local development database only', /dev/i.test(databaseLabel), databaseLabel);
}

const TABLES = ['Client', 'Campaign', 'ContentCalendar', 'CampaignDelivery', 'PosterVersion', 'Category', 'Plan', 'UsageEvent'];
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
      { timeout: 120_000, maxWait: 10_000 },
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
  t('no network call was attempted (no OpenAI, no WhatsApp, no Drive)', networkAttempts === 0, String(networkAttempts));
  console.log(`\n${bad === 0 ? 'All legacy calendar clear database checks passed.' : `${bad} check(s) FAILED.`}`);
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
