/**
 * Database checks for the campaign automation foundation (Phase 1).
 *
 * Exercises the schema's constraints and `src/lib/campaign/service.ts` against a
 * real PostgreSQL. **Every fixture is written inside one transaction that is
 * always rolled back**, and the row counts of every touched table are compared
 * before and after, so the development database is left exactly as it was.
 * Expected constraint violations run under a savepoint so the transaction
 * survives them.
 *
 * Refuses to run unless DATABASE_URL points at a local development database.
 * No provider is called: no OpenAI, fal.ai, Drive or WhatsApp. Drive file ids
 * are fixture strings.
 *
 * Run: npm run check:campaign-db
 */
import { Prisma, PrismaClient } from '@prisma/client';

import { evaluateDeliveryReadiness } from '@/lib/campaign/model';
import {
  activatePosterVersion,
  addPosterVersion,
  CampaignDomainError,
  changeCampaignStatus,
  createCampaign,
  findCampaignDay,
  reviewPosterVersion,
  selectDayTemplate,
  suggestDayTemplate,
  transitionGenerationStatus,
  updateCampaignDayContent,
  type CampaignErrorCode,
} from '@/lib/campaign/service';
import { loadStudioHistory, studioHistorySelect, toStudioHistoryItem } from '@/lib/poster-studio/history';

// Belt and braces: nothing here calls a provider, and nothing could pay if it did.
process.env.OPENAI_API_KEY = '';
process.env.FAL_KEY = '';
process.env.EVOLUTION_API_KEY = '';

// ---------------------------------------------------------------------------
// Safety guard
// ---------------------------------------------------------------------------

{
  const raw = process.env.DATABASE_URL ?? '';
  let host = '';
  let database = '';
  try {
    const url = new URL(raw);
    host = url.hostname;
    database = url.pathname.replace(/^\//, '');
  } catch {
    // Falls through to the refusal below.
  }
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
  if (!local || !/dev/i.test(database)) {
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
const section = (title: string) => console.log(`\n--- ${title} ${'-'.repeat(Math.max(0, 58 - title.length))}`);

class Rollback extends Error {}

const prisma = new PrismaClient();
type Tx = Prisma.TransactionClient;

/** Runs `work`, which must fail, under a savepoint so the transaction survives. */
async function expectFailure(
  tx: Tx,
  name: string,
  work: () => Promise<unknown>,
  /** `prisma`: P2002 unique violation, P2003 foreign key violation. */
  expected: { domain?: CampaignErrorCode; prisma?: 'P2002' | 'P2003' },
): Promise<void> {
  await tx.$executeRawUnsafe('SAVEPOINT expect_failure');
  try {
    await work();
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT expect_failure');
    t(name, false, 'succeeded but should have failed');
  } catch (error) {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT expect_failure');
    if (expected.domain) {
      const ok = error instanceof CampaignDomainError && error.code === expected.domain;
      t(name, ok, error instanceof Error ? error.message : String(error));
    } else {
      const code = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null;
      t(name, code === expected.prisma, code ?? String(error));
    }
  }
}

const TABLES = [
  'Plan',
  'Category',
  'CategoryTemplate',
  'Client',
  'Campaign',
  'ContentCalendar',
  'PosterVersion',
  'PosterStudioGeneration',
  'UsageEvent',
] as const;

async function tableCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "${table}"`,
    );
    counts[table] = Number(rows[0]?.n ?? -1);
  }
  return counts;
}

const snapshot = (value: unknown) => JSON.stringify(value);

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

async function suite(tx: Tx): Promise<void> {
  const TZ = 'Asia/Kolkata';
  const start = new Date('2026-10-01T00:00:00+05:30');

  // ---- Fixtures ----------------------------------------------------------
  const plan = await tx.plan.create({ data: { name: 'check:campaign-db 365', durationDays: 365 } });
  const shortPlan = await tx.plan.create({ data: { name: 'check:campaign-db 30', durationDays: 30 } });
  const vertical = await tx.category.create({ data: { name: 'check:campaign-db Dental' } });
  const otherVertical = await tx.category.create({ data: { name: 'check:campaign-db Real Estate' } });

  const template = (label: string, categoryId: string, extra: Partial<Prisma.CategoryTemplateUncheckedCreateInput> = {}) =>
    tx.categoryTemplate.create({
      data: {
        categoryId,
        label,
        gDriveFileId: `fixture-${label}`,
        gDriveViewUrl: `https://drive.invalid/${label}`,
        mimeType: 'image/png',
        width: 1080,
        height: 1920,
        ...extra,
      },
    });
  const templateA = await template('A', vertical.id);
  const templateB = await template('B', vertical.id, { contentTypes: ['festival'] });
  const templateC = await template('C', vertical.id);
  const inactiveTemplate = await template('Retired', vertical.id, { isActive: false });
  const foreignTemplate = await template('Foreign', otherVertical.id);

  // Inactive demo tenants: even a leaked row could never be dispatched.
  const client = (companyName: string, planId: string, whatsappNumber: string) =>
    tx.client.create({
      data: {
        companyName,
        whatsappNumber,
        startDate: start,
        endDate: start,
        planId,
        categoryId: vertical.id,
        isActive: false,
        isDemo: true,
        brandTagline: 'Fixture tagline',
      },
    });
  const manualClient = await client('check:campaign-db Manual Client', plan.id, '910000000001');
  const autoClient = await client('check:campaign-db Auto Client', shortPlan.id, '910000000002');
  const legacyClient = await client('check:campaign-db Legacy Client', shortPlan.id, '910000000003');

  // =======================================================================
  section('1. campaign belongs to client');
  // =======================================================================
  const manual = await createCampaign(tx, {
    clientId: manualClient.id,
    name: '365-Day Scale',
    startDate: start,
    // No mode given: new campaigns default to MANUAL (campaign board — one template source).
    timeZone: TZ,
  });
  const manualCampaign = await tx.campaign.findUniqueOrThrow({
    where: { id: manual.campaignId },
    include: { client: true, plan: true, category: true },
  });
  t('campaign.clientId is the client', manualCampaign.clientId === manualClient.id);
  t('client.campaigns contains it', (await tx.client.findUniqueOrThrow({ where: { id: manualClient.id }, include: { campaigns: true } })).campaigns.some((c) => c.id === manual.campaignId));
  t('plan and vertical default from the client', manualCampaign.planId === plan.id && manualCampaign.categoryId === vertical.id);
  t('new campaign is DRAFT', manualCampaign.status === 'DRAFT');
  t('delivery config defaults from the client', manualCampaign.deliveryTime === manualClient.cronTime && manualCampaign.deliveryDays.length === 0);
  t('no Brand Canvas copied onto the campaign', !('brandTagline' in manualCampaign) && !('logoUrl' in manualCampaign));
  await expectFailure(
    tx,
    "DB refuses a day whose campaign belongs to another client",
    () =>
      tx.contentCalendar.create({
        data: { clientId: autoClient.id, campaignId: manual.campaignId, dayNumber: 999, scheduledDate: start, caption: '', hashtags: '', imagePrompt: '' },
      }),
    { prisma: 'P2003' },
  );

  // =======================================================================
  section('2. campaign holds 365 days');
  // =======================================================================
  const days = await tx.contentCalendar.findMany({
    where: { campaignId: manual.campaignId },
    orderBy: { dayNumber: 'asc' },
    select: { id: true, dayNumber: true, scheduledDate: true },
  });
  t('365 day rows created', manual.dayCount === 365 && days.length === 365, String(days.length));
  t('day numbers 1..365', days.every((day, index) => day.dayNumber === index + 1));
  t('endDate is day 365', manualCampaign.endDate.getTime() === days[364]?.scheduledDate.getTime());
  await expectFailure(
    tx,
    'a second calendar for the same client is refused (legacy unique key)',
    () => createCampaign(tx, { clientId: manualClient.id, name: 'Again', startDate: start, timeZone: TZ }),
    { domain: 'calendar-occupied' },
  );

  // =======================================================================
  section('3. a day exists without a poster');
  // =======================================================================
  {
    const day = await findCampaignDay(tx, manual.campaignId, 1);
    t('no active version', day?.activePosterVersionId === null);
    t('no versions', (await tx.posterVersion.count({ where: { calendarDayId: day!.id } })) === 0);
    t('generation NOT_REQUESTED', day?.generationStatus === 'NOT_REQUESTED');
    t('legacy delivery columns untouched (PENDING, unapproved, unqueued, no file)', day?.deliveryStatus === 'PENDING' && day.approvedAt === null && day.generationQueuedAt === null && day.gDriveFileId === null);
  }

  // =======================================================================
  section('4. days are independently addressable');
  // =======================================================================
  {
    const [d1, d127, d365] = await Promise.all([1, 127, 365].map((n) => findCampaignDay(tx, manual.campaignId, n)));
    t('(campaign, day number) resolves one row each', Boolean(d1 && d127 && d365) && new Set([d1!.id, d127!.id, d365!.id]).size === 3);
    t('day 127 is the 127th date', d127?.scheduledDate.getTime() === days[126]?.scheduledDate.getTime());
    t('a missing day number resolves to null', (await findCampaignDay(tx, manual.campaignId, 366)) === null);
    const window = await tx.contentCalendar.findMany({
      where: { campaignId: manual.campaignId, scheduledDate: { gte: days[0]!.scheduledDate, lt: days[14]!.scheduledDate } },
    });
    t('rolling window: next 14 days are selectable and have no posters', window.length === 14 && window.every((day) => day.activePosterVersionId === null));
  }

  // =======================================================================
  section('5–6. template mapping (MANUAL)');
  // =======================================================================
  const day = async (n: number) => (await findCampaignDay(tx, manual.campaignId, n))!;
  {
    await selectDayTemplate(tx, (await day(2)).id, templateA.id);
    await selectDayTemplate(tx, (await day(5)).id, templateB.id);
    await selectDayTemplate(tx, (await day(17)).id, templateC.id);
    await selectDayTemplate(tx, (await day(40)).id, templateA.id);
    t('Template A → Day 2, B → Day 5, C → Day 17', (await day(2)).posterTemplateId === templateA.id && (await day(5)).posterTemplateId === templateB.id && (await day(17)).posterTemplateId === templateC.id);
    t('the same template on several days', (await tx.contentCalendar.count({ where: { campaignId: manual.campaignId, posterTemplateId: templateA.id } })) === 2);

    const reselect = await selectDayTemplate(tx, (await day(5)).id, templateC.id);
    t('reselecting replaces the one selected template', (await day(5)).posterTemplateId === templateC.id && reselect.effectiveTemplateId === templateC.id);
    t('reselecting day 5 left day 2 and day 17 alone', (await day(2)).posterTemplateId === templateA.id && (await day(17)).posterTemplateId === templateC.id);

    const hint = await suggestDayTemplate(tx, (await day(9)).id, templateB.id);
    t('MANUAL: a suggestion does not map the day', hint.effectiveTemplateId === null && !hint.revisionBumped);
    const chosen = await selectDayTemplate(tx, (await day(9)).id, templateB.id);
    t('MANUAL: a selection maps the day and bumps its revision', chosen.effectiveTemplateId === templateB.id && chosen.revisionBumped);

    await expectFailure(tx, 'a template from another vertical is refused', async () => selectDayTemplate(tx, (await day(3)).id, foreignTemplate.id), { domain: 'template-not-assignable' });
    await expectFailure(tx, 'an inactive template is refused', async () => selectDayTemplate(tx, (await day(3)).id, inactiveTemplate.id), { domain: 'template-not-assignable' });
  }

  // =======================================================================
  section('7–9. poster versions on day 127');
  // =======================================================================
  const neighboursBefore = snapshot([await day(126), await day(128)]);
  const day127 = await day(127);
  {
    const edit = await updateCampaignDayContent(tx, day127.id, {
      theme: 'Monsoon gum care',
      contentType: 'educational',
      headline: 'Keep smiling this monsoon',
      supportingText: 'Three habits for healthy gums.',
      cta: 'Book a check-up',
      imagePrompt: 'A family brushing teeth together in a bright bathroom',
      caption: 'Healthy gums start at home.',
      hashtags: '#dental #monsoon',
    });
    t('writing content bumps the revision', edit.revisionBumped && edit.contentRevision === 2);
    await selectDayTemplate(tx, day127.id, templateA.id);
    const revision = (await day(127)).contentRevision;
    t('content + template on a day with no poster', revision === 3 && (await day(127)).activePosterVersionId === null);

    t('generation: request queued', await transitionGenerationStatus(tx, day127.id, 'NOT_REQUESTED', 'QUEUED'));
    t('generation: first worker claims it', await transitionGenerationStatus(tx, day127.id, 'QUEUED', 'GENERATING'));
    t('generation: second worker loses the claim', !(await transitionGenerationStatus(tx, day127.id, 'QUEUED', 'GENERATING')));

    const v1 = await addPosterVersion(tx, {
      calendarDayId: day127.id,
      source: 'PIPELINE',
      imageDriveFileId: 'fixture-drive-v1',
      imageMimeType: 'image/png',
      width: 1080,
      height: 1920,
      contentRevision: revision,
      templateId: templateA.id,
    });
    await transitionGenerationStatus(tx, day127.id, 'GENERATING', 'SUCCEEDED');
    const v1Row = snapshot(await tx.posterVersion.findUnique({ where: { id: v1.versionId } }));
    t('v1: generated, active, PENDING under MANUAL_REVIEW', v1.versionNumber === 1 && v1.activated && v1.approvalStatus === 'PENDING');

    const studioParent = await tx.posterStudioGeneration.create({
      data: { mode: 'GENERATE', prompt: 'fixture', sentPrompt: 'fixture', aspectRatio: '9:16', size: '1152x2048', model: 'gpt-image-2', quality: 'low', imageDriveFileId: 'fixture-studio-parent', imageMimeType: 'image/png', clientId: manualClient.id },
    });
    const studioEdit = await tx.posterStudioGeneration.create({
      data: { mode: 'EDIT', prompt: 'fixture edit', sentPrompt: 'fixture edit', aspectRatio: '9:16', size: '1152x2048', model: 'gpt-image-2', quality: 'low', imageDriveFileId: 'fixture-studio-edit-raw', finalImageDriveFileId: 'fixture-studio-edit-final', imageMimeType: 'image/png', parentGenerationId: studioParent.id, clientId: manualClient.id },
    });
    const studioEditBefore = snapshot(await tx.posterStudioGeneration.findUnique({ where: { id: studioEdit.id } }));

    const v2 = await addPosterVersion(tx, {
      calendarDayId: day127.id,
      source: 'POSTER_STUDIO',
      imageDriveFileId: 'fixture-studio-edit-final',
      imageMimeType: 'image/png',
      contentRevision: revision,
      parentVersionId: v1.versionId,
      studioGenerationId: studioEdit.id,
    });
    const v3 = await addPosterVersion(tx, {
      calendarDayId: day127.id,
      source: 'POSTER_STUDIO',
      imageDriveFileId: 'fixture-studio-edit-final-2',
      imageMimeType: 'image/png',
      contentRevision: revision,
      parentVersionId: v2.versionId,
      studioGenerationId: studioEdit.id,
    });
    const versions = await tx.posterVersion.findMany({ where: { calendarDayId: day127.id }, orderBy: { versionNumber: 'asc' } });
    t('7. one day holds several versions (1, 2, 3)', versions.map((v) => v.versionNumber).join() === '1,2,3');
    t('7. earlier versions are not overwritten', snapshot(versions[0]) === v1Row);
    t('7. edit lineage v1 → v2 → v3', versions[1]?.parentVersionId === v1.versionId && versions[2]?.parentVersionId === v2.versionId);

    t('8. the day points at v3 only', (await day(127)).activePosterVersionId === v3.versionId);
    t('8. no other day points at any of these versions', (await tx.contentCalendar.count({ where: { activePosterVersionId: { in: versions.map((v) => v.id) } } })) === 1);
    await activatePosterVersion(tx, day127.id, v1.versionId);
    t('8. activating v1 moves the single pointer', (await day(127)).activePosterVersionId === v1.versionId);
    await activatePosterVersion(tx, day127.id, v3.versionId);
    // v1 is not active anywhere, so only the composite key can refuse this one.
    await expectFailure(tx, "8. DB refuses pointing day 126 at day 127's (inactive) version — composite key", async () => tx.contentCalendar.updateMany({ where: { id: (await day(126)).id }, data: { activePosterVersionId: v1.versionId } }), { prisma: 'P2003' });
    await expectFailure(tx, "8. DB refuses a second day sharing day 127's active version — unique pointer", async () => tx.contentCalendar.updateMany({ where: { id: (await day(126)).id }, data: { activePosterVersionId: v3.versionId } }), { prisma: 'P2002' });
    await expectFailure(tx, '8. service refuses a version from another day', async () => activatePosterVersion(tx, (await day(126)).id, v3.versionId), { domain: 'invalid-input' });
    await expectFailure(tx, '8. the active version cannot be deleted', () => tx.posterVersion.delete({ where: { id: v3.versionId } }), { prisma: 'P2003' });
    await expectFailure(tx, 'a parent version from another day is refused', async () => addPosterVersion(tx, { calendarDayId: (await day(128)).id, source: 'PIPELINE', imageDriveFileId: 'x', imageMimeType: 'image/png', contentRevision: 1, parentVersionId: v1.versionId }), { domain: 'invalid-input' });
    await expectFailure(tx, 'image bytes are refused as a file id', () => addPosterVersion(tx, { calendarDayId: day127.id, source: 'PIPELINE', imageDriveFileId: 'data:image/png;base64,iVBORw0KGgo=', imageMimeType: 'image/png', contentRevision: revision }), { domain: 'invalid-input' });

    // ---- Status effects -------------------------------------------------
    const readiness = async () => {
      const row = await tx.contentCalendar.findUniqueOrThrow({
        where: { id: day127.id },
        select: { contentRevision: true, campaign: { select: { status: true } }, activePosterVersion: { select: { contentRevision: true, approvalStatus: true } } },
      });
      return evaluateDeliveryReadiness({ campaignStatus: row.campaign!.status, dayContentRevision: row.contentRevision, activeVersion: row.activePosterVersion });
    };
    t('DRAFT campaign is not deliverable', (await readiness()) === 'campaign-not-active');
    await changeCampaignStatus(tx, manual.campaignId, 'ACTIVE');
    t('ACTIVE + PENDING poster awaits approval', (await readiness()) === 'awaiting-approval');
    await reviewPosterVersion(tx, v3.versionId, 'APPROVED');
    t('approved → ready', (await readiness()) === 'ready');

    const captionEdit = await updateCampaignDayContent(tx, day127.id, { caption: 'Healthy gums begin at home.' });
    t('caption edit keeps the approved poster current', !captionEdit.revisionBumped && (await readiness()) === 'ready');

    const headlineEdit = await updateCampaignDayContent(tx, day127.id, { headline: 'Smile through the rain' });
    t('headline edit makes the poster outdated', headlineEdit.revisionBumped && (await readiness()) === 'poster-outdated');
    t('…without rewriting the version\'s approval', (await tx.posterVersion.findUniqueOrThrow({ where: { id: v3.versionId } })).approvalStatus === 'APPROVED');
    await expectFailure(tx, 'a stale editor form is a conflict', () => updateCampaignDayContent(tx, day127.id, { cta: 'Call us' }, { expectedRevision: revision }), { domain: 'conflict' });

    const late = await addPosterVersion(tx, { calendarDayId: day127.id, source: 'PIPELINE', imageDriveFileId: 'fixture-drive-late', imageMimeType: 'image/png', contentRevision: revision - 1 });
    t('a late version from older content is kept but not activated', late.versionNumber === 4 && !late.activated && (await day(127)).activePosterVersionId === v3.versionId);

    const regenerated = await addPosterVersion(tx, { calendarDayId: day127.id, source: 'PIPELINE', imageDriveFileId: 'fixture-drive-v5', imageMimeType: 'image/png', contentRevision: headlineEdit.contentRevision });
    t('regeneration: new current version is active and needs approval', regenerated.activated && (await readiness()) === 'awaiting-approval');
    await reviewPosterVersion(tx, regenerated.versionId, 'REJECTED', 'Headline crowds the face');
    t('rejected poster is not deliverable', (await readiness()) === 'poster-rejected');
    await expectFailure(tx, 'a rejection cannot flip straight to approved', () => reviewPosterVersion(tx, regenerated.versionId, 'APPROVED'), { domain: 'invalid-transition' });

    const beforePause = snapshot([await day(127), await tx.posterVersion.findMany({ where: { calendarDayId: day127.id }, orderBy: { versionNumber: 'asc' } })]);
    await changeCampaignStatus(tx, manual.campaignId, 'PAUSED');
    t('pause: campaign not deliverable', (await readiness()) === 'campaign-not-active');
    t('pause: no day or version row changed', snapshot([await day(127), await tx.posterVersion.findMany({ where: { calendarDayId: day127.id }, orderBy: { versionNumber: 'asc' } })]) === beforePause);
    t('pause: generation cannot be queued', !(await transitionGenerationStatus(tx, (await day(128)).id, 'NOT_REQUESTED', 'QUEUED')));
    await changeCampaignStatus(tx, manual.campaignId, 'ACTIVE');

    t('9. days 126 and 128 are byte-identical after every change to day 127', snapshot([await day(126), await day(128)]) === neighboursBefore);

    // =====================================================================
    section('13. Poster Studio keeps working');
    // =====================================================================
    t('linked studio row is unchanged', snapshot(await tx.posterStudioGeneration.findUnique({ where: { id: studioEdit.id } })) === studioEditBefore);
    const history = (await tx.posterStudioGeneration.findMany({ where: { id: { in: [studioParent.id, studioEdit.id] } }, select: studioHistorySelect, orderBy: { createdAt: 'asc' } })).map(toStudioHistoryItem);
    t('studio history projection still maps rows', history.length === 2 && history.some((item) => item.parentGenerationId === studioParent.id && item.hasFinal));
    await expectFailure(tx, 'a studio row used by a campaign version cannot be deleted (its file is shared)', () => tx.posterStudioGeneration.delete({ where: { id: studioEdit.id } }), { prisma: 'P2003' });
    await tx.posterStudioGeneration.delete({ where: { id: studioParent.id } });
    t('deleting an unlinked studio parent still SetNulls its child', (await tx.posterStudioGeneration.findUniqueOrThrow({ where: { id: studioEdit.id } })).parentGenerationId === null);
  }

  // =======================================================================
  section('4b. regenerate "from day 101 onward" is addressable');
  // =======================================================================
  {
    const day100 = snapshot(await day(100));
    const touched = await tx.contentCalendar.updateMany({
      where: { campaignId: manual.campaignId, dayNumber: { gte: 101 } },
      data: { generationStatus: 'QUEUED' },
    });
    t('days 101–365 selected (265 rows)', touched.count === 265, String(touched.count));
    t('day 100 untouched', snapshot(await day(100)) === day100);
    t('days 1–100 still NOT_REQUESTED', (await tx.contentCalendar.count({ where: { campaignId: manual.campaignId, dayNumber: { lte: 100 }, generationStatus: 'QUEUED' } })) === 0);
  }

  // =======================================================================
  section('10–12. AUTO campaign, zero posters');
  // =======================================================================
  const auto = await createCampaign(tx, {
    clientId: autoClient.id,
    name: '30-Day Blitz',
    startDate: start,
    deliveryDays: [1, 3, 5],
    approvalPolicy: 'AUTO_APPROVE',
    // AUTO is still accepted when asked for explicitly.
    templateMappingMode: 'AUTO',
    timeZone: TZ,
  });
  {
    const autoCampaign = await tx.campaign.findUniqueOrThrow({ where: { id: auto.campaignId } });
    t('10. campaign exists with zero poster versions', (await tx.posterVersion.count({ where: { calendarDay: { campaignId: auto.campaignId } } })) === 0 && auto.dayCount === 30);
    t('11. AUTO mode is stored when asked for', autoCampaign.templateMappingMode === 'AUTO');
    t('12. mapping mode defaults to MANUAL', manualCampaign.templateMappingMode === 'MANUAL');
    t('weekday-restricted campaign spans more calendar days', autoCampaign.endDate.getTime() - autoCampaign.startDate.getTime() > 29 * 86_400_000);

    const autoDay = (await findCampaignDay(tx, auto.campaignId, 3))!;
    const suggested = await suggestDayTemplate(tx, autoDay.id, templateB.id);
    t('11. AUTO: suggestion maps the day', suggested.effectiveTemplateId === templateB.id && suggested.revisionBumped);
    const override = await selectDayTemplate(tx, autoDay.id, templateA.id);
    t('11. AUTO: operator selection overrides', override.effectiveTemplateId === templateA.id && override.revisionBumped);
    const cleared = await selectDayTemplate(tx, autoDay.id, null);
    t('11. AUTO: clearing the selection falls back to the suggestion', cleared.effectiveTemplateId === templateB.id);

    const autoVersion = await addPosterVersion(tx, { calendarDayId: autoDay.id, source: 'MANUAL_UPLOAD', imageDriveFileId: 'fixture-upload', imageMimeType: 'image/jpeg', contentRevision: (await findCampaignDay(tx, auto.campaignId, 3))!.contentRevision });
    t('AUTO_APPROVE: new version starts APPROVED', autoVersion.approvalStatus === 'APPROVED');
  }

  // =======================================================================
  section('14. existing client / vertical / template behaviour');
  // =======================================================================
  {
    const legacy = await tx.contentCalendar.create({
      data: { clientId: legacyClient.id, dayNumber: 1, scheduledDate: start, caption: 'Legacy caption', hashtags: '#legacy', imagePrompt: 'legacy prompt', posterTemplateId: templateC.id },
    });
    t('legacy calendar row needs no campaign', legacy.campaignId === null && legacy.generationStatus === null && legacy.contentRevision === 1 && legacy.lastPosterVersion === 0 && legacy.activePosterVersionId === null);
    await expectFailure(tx, 'legacy (client, day number) uniqueness still holds', () => tx.contentCalendar.create({ data: { clientId: legacyClient.id, dayNumber: 1, scheduledDate: start, caption: '', hashtags: '', imagePrompt: '' } }), { prisma: 'P2002' });
    await expectFailure(tx, 'campaign service refuses a legacy row', () => updateCampaignDayContent(tx, legacy.id, { headline: 'x' }), { domain: 'not-a-campaign-day' });

    t('templates default to active with no content types', templateA.isActive && templateA.contentTypes.length === 0);
    t('client still reads its vertical and plan', (await tx.client.findUniqueOrThrow({ where: { id: legacyClient.id }, include: { category: true, plan: true } })).category.name === vertical.name);

    // Campaign days never carry the retired daily poster maker's delivery state.
    const sweepable = await tx.contentCalendar.count({
      where: {
        campaignId: { not: null },
        OR: [
          { approvedAt: { not: null } },
          { generationQueuedAt: { not: null } },
          { deliveryStatus: 'GENERATED', sendAfter: { not: null } },
        ],
      },
    });
    t('no campaign day matches any legacy dispatch phase', sweepable === 0);

    const pinnedC = await tx.contentCalendar.count({ where: { posterTemplateId: templateC.id } });
    const versionsOnA = await tx.posterVersion.count({ where: { templateId: templateA.id } });
    await tx.categoryTemplate.delete({ where: { id: templateC.id } });
    t('deleting a template still SetNulls selected days (legacy and campaign)', pinnedC >= 3 && (await tx.contentCalendar.count({ where: { posterTemplateId: templateC.id } })) === 0);
    await tx.categoryTemplate.delete({ where: { id: templateB.id } });
    t('…and suggested days', (await tx.contentCalendar.count({ where: { suggestedTemplateId: templateB.id } })) === 0);
    await tx.categoryTemplate.delete({ where: { id: templateA.id } });
    t(
      '…and keeps poster versions, clearing their template',
      versionsOnA >= 1 &&
        (await tx.posterVersion.count({ where: { calendarDayId: day127.id } })) === 5 &&
        (await tx.posterVersion.count({ where: { calendarDayId: day127.id, templateId: { not: null } } })) === 0,
    );

    // A vertical referenced only by a campaign — no client, no template of its own that matters.
    await tx.campaign.create({
      data: { clientId: legacyClient.id, planId: shortPlan.id, categoryId: otherVertical.id, name: 'Bare campaign', startDate: start, durationDays: 1, endDate: start },
    });
    await expectFailure(tx, 'a vertical used by a campaign cannot be deleted (Restrict)', () => tx.category.delete({ where: { id: otherVertical.id } }), { prisma: 'P2003' });
  }

  // =======================================================================
  section('cascades');
  // =======================================================================
  {
    const target = await day(127);
    await tx.contentCalendar.delete({ where: { id: target.id } });
    t('deleting a day with an active version removes the day and its versions', (await tx.posterVersion.count({ where: { calendarDayId: target.id } })) === 0);
    await tx.client.delete({ where: { id: autoClient.id } });
    t('deleting a client removes its campaign and days', (await tx.campaign.count({ where: { id: auto.campaignId } })) === 0 && (await tx.contentCalendar.count({ where: { campaignId: auto.campaignId } })) === 0);
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const before = await tableCounts();

  try {
    await prisma.$transaction(
      async (tx) => {
        await suite(tx);
        throw new Rollback();
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) {
      console.error('\nSuite aborted:', error);
      bad += 1;
    }
  }

  section('after rollback');
  const after = await tableCounts();
  t('every table has exactly its original row count', snapshot(before) === snapshot(after), snapshot(after));

  const studio = await loadStudioHistory();
  t('Poster Studio history loads against the migrated schema', Array.isArray(studio), `${studio.length} item(s)`);

  console.log(`\n${bad === 0 ? 'All campaign database checks passed.' : `${bad} check(s) FAILED.`}`);
}

main()
  .catch((error) => {
    console.error(error);
    bad += 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(bad === 0 ? 0 : 1);
  });
