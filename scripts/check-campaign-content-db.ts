/**
 * Database checks for campaign content generation (Phase 2).
 *
 * Runs `src/lib/campaign/content-generation.ts` and the content-editing service
 * against the development database with a **fake generator** — no model is ever
 * called. Everything happens inside one transaction that is always rolled back;
 * row counts are compared before and after. `fetch` is stubbed and provider keys
 * are blanked, and the suite asserts zero network attempts.
 *
 * Refuses to run unless DATABASE_URL is a local development database.
 *
 * Run: npm run check:campaign-content-db
 */
import { Prisma, PrismaClient } from '@prisma/client';

import { LlmError } from '@/lib/ai/openai';
import {
  generateCampaignContent,
  regenerateCampaignDayContent,
  type ContentGenerationRequest,
  type ContentGenerator,
} from '@/lib/campaign/content-generation';
import { isVersionCurrent } from '@/lib/campaign/model';
import {
  addPosterVersion,
  CampaignDomainError,
  changeCampaignStatus,
  createCampaign,
  findCampaignDay,
  markCampaignDayContentReviewed,
  selectDayTemplate,
  suggestDayTemplate,
  updateCampaignDayContent,
  type CampaignErrorCode,
} from '@/lib/campaign/service';

for (const key of ['OPENAI_API_KEY', 'FAL_KEY', 'EVOLUTION_API_KEY', 'EVOLUTION_API_URL', 'GOOGLE_PRIVATE_KEY']) {
  process.env[key] = '';
}
let networkAttempts = 0;
globalThis.fetch = (async () => {
  networkAttempts += 1;
  throw new Error('network disabled by check:campaign-content-db');
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
const prisma = new PrismaClient();
type Tx = Prisma.TransactionClient;

// ---- Fake generator ----------------------------------------------------------

const calls: ContentGenerationRequest[] = [];

interface FakeOptions {
  version: string;
  omit?: ReadonlySet<number>;
  failOnDay?: number;
  truncateAbove?: number;
  headlineFor?: ReadonlyMap<number, string>;
  beforeReturn?: () => Promise<void>;
}

/** Reads the requested days from the prompt and answers for them, like a model would. */
function fake(options: FakeOptions): ContentGenerator {
  return async (request) => {
    calls.push(request);
    const days = [...request.userPrompt.matchAll(/^(\d+) · .+ · ([a-z0-9-]+)$/gm)].map((match) => ({
      dayNumber: Number(match[1]),
      contentType: match[2]!,
    }));
    if (options.truncateAbove !== undefined && days.length > options.truncateAbove) {
      throw new LlmError('fake: response hit the token cap', 'truncated');
    }
    if (options.failOnDay !== undefined && days.some((day) => day.dayNumber === options.failOnDay)) {
      throw new LlmError('fake: could not reach the OpenAI API', 'transport');
    }
    await options.beforeReturn?.();
    return {
      days: days
        .filter((day) => !options.omit?.has(day.dayNumber))
        .map((day) => ({
          dayNumber: day.dayNumber,
          topic: `Topic ${day.dayNumber} ${options.version}`,
          contentType: day.contentType,
          headline: options.headlineFor?.get(day.dayNumber) ?? `Headline ${day.dayNumber} ${options.version}`,
          supportingText: `Supporting text for day ${day.dayNumber}, ${options.version}.`,
          cta: `Action ${day.dayNumber} ${options.version}`,
          caption: `Caption for day ${day.dayNumber} ${options.version}.`,
          hashtags: '#one #two, three',
          imagePrompt: `Photo brief for day ${day.dayNumber} ${options.version}.`,
          suggestedTemplateType: 'tips-list',
        })),
    };
  };
}

async function expectDomainError(name: string, code: CampaignErrorCode, work: () => Promise<unknown>) {
  try {
    await work();
    t(name, false, 'succeeded but should have failed');
  } catch (error) {
    t(name, error instanceof CampaignDomainError && error.code === code, error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------

async function suite(tx: Tx): Promise<void> {
  const TZ = 'Asia/Kolkata';
  const start = new Date('2026-10-01T00:00:00+05:30');

  const plan = await tx.plan.create({ data: { name: 'check:content 365', durationDays: 365 } });
  const shortPlan = await tx.plan.create({ data: { name: 'check:content 40', durationDays: 40 } });
  const vertical = await tx.category.create({
    data: {
      name: 'check:content Dental',
      contentStrategy: {
        pillars: [
          { key: 'preventive-care', label: 'Preventive care', weight: 3, guidance: 'Habits that prevent dental problems.' },
          { key: 'myth-vs-fact', label: 'Myth vs fact', weight: 2, guidance: 'Correct a dental myth.' },
          { key: 'gum-health', label: 'Gum health', weight: 2, guidance: 'Gum care.' },
          { key: 'book-a-visit', label: 'Book a visit', weight: 1, guidance: 'Invite a booking.', promotional: true },
        ],
      },
    },
  });
  const template = await tx.categoryTemplate.create({
    data: { categoryId: vertical.id, label: 'Content Fixture', gDriveFileId: 'fixture-content-template', gDriveViewUrl: 'https://drive.invalid/t', mimeType: 'image/png', width: 1080, height: 1920 },
  });
  const client = await tx.client.create({
    data: {
      companyName: 'check:content ABC Dental Clinic',
      whatsappNumber: '919999000111',
      startDate: start,
      endDate: start,
      planId: plan.id,
      categoryId: vertical.id,
      isDemo: true,
      isActive: false,
      brandTagline: 'Smiles that last',
      gDriveFolderId: 'SECRET-DRIVE-FOLDER-ID',
      logoUrl: 'https://drive.invalid/SECRET-LOGO-URL',
      logoDriveFileId: 'SECRET-DRIVE-LOGO-ID',
      websiteUrl: 'secret-website.invalid',
    },
  });
  const campaign = await createCampaign(tx, { clientId: client.id, name: 'ABC 365', startDate: start, timeZone: TZ });
  const dayRow = async (n: number) => (await findCampaignDay(tx, campaign.campaignId, n))!;
  const days = (from: number, to: number) =>
    tx.contentCalendar.findMany({ where: { campaignId: campaign.campaignId, dayNumber: { gte: from, lte: to } }, orderBy: { dayNumber: 'asc' } });
  const statusCount = (status: 'NOT_GENERATED' | 'READY' | 'NEEDS_REVIEW') =>
    tx.contentCalendar.count({ where: { campaignId: campaign.campaignId, contentStatus: status } });

  // Legacy neighbour: must never be touched by campaign content generation.
  const legacyClient = await tx.client.create({
    data: { companyName: 'check:content Legacy', whatsappNumber: '910000000009', startDate: start, endDate: start, planId: shortPlan.id, categoryId: vertical.id, isDemo: true, isActive: false },
  });
  await tx.contentCalendar.create({ data: { clientId: legacyClient.id, dayNumber: 1, scheduledDate: start, caption: 'Legacy caption', hashtags: '#legacy', imagePrompt: 'legacy prompt' } });
  const legacyBefore = snapshot(await tx.contentCalendar.findMany({ where: { clientId: legacyClient.id } }));

  // =======================================================================
  section('new campaign slots');
  // =======================================================================
  t('365 slots start NOT_GENERATED', (await statusCount('NOT_GENERATED')) === 365);

  // =======================================================================
  section('chunked generation: days 1–30');
  // =======================================================================
  {
    const result = await generateCampaignContent(tx, campaign.campaignId, { maxChunks: 1, generator: fake({ version: 'v1' }), timeZone: TZ });
    const chunk = result.chunks[0]!;
    t('one request covers days 1–30', calls.length === 1 && chunk.fromDay === 1 && chunk.toDay === 30 && chunk.requested === 30, snapshot({ calls: calls.length, chunk: [chunk.fromDay, chunk.toDay] }));
    t('30 days written READY', chunk.written.length === 30 && (await statusCount('READY')) === 30);
    t('remaining 335, continue from day 1 (missing mode)', result.remaining === 335 && result.nextFromDay === 1, snapshot({ remaining: result.remaining, next: result.nextFromDay }));
    const day1 = await dayRow(1);
    t('content lands in existing columns (topic → theme)', day1.theme === 'Topic 1 v1' && day1.headline === 'Headline 1 v1' && day1.supportingText !== null && day1.cta === 'Action 1 v1' && day1.caption.startsWith('Caption') && day1.imagePrompt.startsWith('Photo brief'));
    t('hashtags normalised, template type stored', day1.hashtags === '#one #two #three' && day1.suggestedTemplateType === 'tips-list', day1.hashtags);
    t('content type comes from the vertical strategy', ['preventive-care', 'myth-vs-fact', 'gum-health', 'book-a-visit'].includes(day1.contentType ?? ''), String(day1.contentType));
    t('writing content bumps the revision', day1.contentRevision === 2);
    t('no poster, no template, no generation request', day1.activePosterVersionId === null && day1.posterTemplateId === null && day1.suggestedTemplateId === null && day1.generationStatus === 'NOT_REQUESTED' && day1.gDriveFileId === null);
  }

  // =======================================================================
  section('prompt privacy and context');
  // =======================================================================
  {
    const sent = snapshot(calls);
    t('no Drive id, logo URL, WhatsApp number or website reaches the model', !/SECRET-DRIVE|SECRET-LOGO|919999000111|secret-website/.test(sent));
    const request = calls[0]!;
    t('business, vertical, duration, tagline and strategy are sent', request.systemPrompt.includes('check:content ABC Dental Clinic') && request.systemPrompt.includes('Industry: check:content Dental') && request.systemPrompt.includes('365 content days') && request.systemPrompt.includes('Smiles that last') && request.systemPrompt.includes('preventive-care'));
    t('the schema restricts content type to the vertical strategy', snapshot(request.schema).includes('"enum":["preventive-care","myth-vs-fact","gum-health","book-a-visit"]'));
  }

  // =======================================================================
  section('idempotent retry of days 1–30');
  // =======================================================================
  {
    const before = snapshot(await days(1, 30));
    const callsBefore = calls.length;
    const retry = await generateCampaignContent(tx, campaign.campaignId, { fromDay: 1, toDay: 30, generator: fake({ version: 'RETRY' }), timeZone: TZ });
    t('"Generate days 1–30" again makes no model request', calls.length === callsBefore && retry.chunks.length === 0 && retry.remaining === 0 && retry.nextFromDay === null);
    t('…and does not overwrite existing content', snapshot(await days(1, 30)) === before);
    t('…and creates no duplicate days', (await tx.contentCalendar.count({ where: { campaignId: campaign.campaignId } })) === 365);
  }

  // =======================================================================
  section('range 91–120');
  // =======================================================================
  {
    const callsBefore = calls.length;
    const result = await generateCampaignContent(tx, campaign.campaignId, { fromDay: 91, toDay: 120, generator: fake({ version: 'v1' }), timeZone: TZ });
    t('one request, days 91–120 written', calls.length === callsBefore + 1 && result.chunks[0]?.written.length === 30 && result.chunks[0]?.fromDay === 91);
    t('days 31–90 still empty', (await tx.contentCalendar.count({ where: { campaignId: campaign.campaignId, dayNumber: { gte: 31, lte: 90 }, contentStatus: 'NOT_GENERATED' } })) === 60);
  }

  // =======================================================================
  section('a failing chunk, then resume');
  // =======================================================================
  {
    const callsBefore = calls.length;
    const failing = await generateCampaignContent(tx, campaign.campaignId, { generator: fake({ version: 'v1', failOnDay: 61 }), timeZone: TZ });
    t('days 31–60 saved, the run stops at the failing chunk 61–90', failing.chunks.length === 2 && failing.chunks[0]?.written.length === 30 && failing.chunks[1]?.error?.includes('could not reach') === true && calls.length === callsBefore + 2, snapshot(failing.chunks.map((c) => [c.fromDay, c.toDay, c.written.length, c.error])));
    t('the failed chunk wrote nothing', (await tx.contentCalendar.count({ where: { campaignId: campaign.campaignId, dayNumber: { gte: 61, lte: 90 }, contentStatus: 'NOT_GENERATED' } })) === 30);

    const written = snapshot(await tx.contentCalendar.findMany({ where: { campaignId: campaign.campaignId, contentStatus: { not: 'NOT_GENERATED' } }, orderBy: { dayNumber: 'asc' } }));
    const day1Headline = (await dayRow(1)).headline!;
    const resume = await generateCampaignContent(tx, campaign.campaignId, {
      generator: fake({ version: 'v1', omit: new Set([200]), headlineFor: new Map([[150, day1Headline]]) }),
      timeZone: TZ,
    });
    t('resume starts with the failed chunk (61–90)', resume.chunks[0]?.fromDay === 61 && resume.chunks[0]?.toDay === 90);
    t('resume covers the rest in chunks of at most 30', resume.chunks.every((chunk) => chunk.requested <= 30) && resume.chunks.at(-1)?.toDay === 365);
    t('previously written days are not rewritten by the resume', snapshot(await tx.contentCalendar.findMany({ where: { campaignId: campaign.campaignId, id: { in: JSON.parse(written).map((row: { id: string }) => row.id) } }, orderBy: { dayNumber: 'asc' } })) === written);
    t('an omitted day is reported and left empty', resume.chunks.some((chunk) => chunk.missing.includes(200)) && (await dayRow(200)).contentStatus === 'NOT_GENERATED');
    const day150 = await dayRow(150);
    t('a duplicate headline is written but flagged NEEDS_REVIEW', day150.contentStatus === 'NEEDS_REVIEW' && day150.contentIssues.some((issue) => issue === 'Headline repeats day 1.'), snapshot(day150.contentIssues));

    const callsBeforeFill = calls.length;
    const fill = await generateCampaignContent(tx, campaign.campaignId, { generator: fake({ version: 'v1' }), timeZone: TZ });
    t('the next run requests only the omitted day', calls.length === callsBeforeFill + 1 && fill.chunks[0]?.requested === 1 && fill.chunks[0]?.fromDay === 200);
    t('all 365 days now have content, none duplicated', (await statusCount('NOT_GENERATED')) === 0 && (await tx.contentCalendar.count({ where: { campaignId: campaign.campaignId } })) === 365);
  }

  // =======================================================================
  section('regenerate range 101–130');
  // =======================================================================
  {
    await changeCampaignStatus(tx, campaign.campaignId, 'ACTIVE');
    const day110 = await dayRow(110);
    await selectDayTemplate(tx, day110.id, template.id);
    await suggestDayTemplate(tx, (await dayRow(115)).id, template.id);
    const version = await addPosterVersion(tx, { calendarDayId: day110.id, source: 'PIPELINE', imageDriveFileId: 'fixture-content-v1', imageMimeType: 'image/png', contentRevision: (await dayRow(110)).contentRevision });

    const outside = snapshot([await dayRow(100), await dayRow(131)]);
    const versionsBefore = snapshot(await tx.posterVersion.findMany({ where: { calendarDay: { campaignId: campaign.campaignId } }, orderBy: { id: 'asc' } }));
    const rangeBefore = await days(101, 130);

    const callsBefore = calls.length;
    const result = await generateCampaignContent(tx, campaign.campaignId, { fromDay: 101, toDay: 130, mode: 'overwrite', generator: fake({ version: 'v2' }), timeZone: TZ });
    const rangeAfter = await days(101, 130);
    t('one request rewrites days 101–130', calls.length === callsBefore + 1 && result.chunks[0]?.written.length === 30 && result.nextFromDay === null);
    t('content replaced, revision bumped once', rangeAfter.every((row, i) => row.headline?.endsWith('v2') && row.contentRevision === rangeBefore[i]!.contentRevision + 1));
    t('dates and day numbers preserved', rangeAfter.every((row, i) => row.scheduledDate.getTime() === rangeBefore[i]!.scheduledDate.getTime() && row.dayNumber === rangeBefore[i]!.dayNumber));
    t('template mappings preserved', (await dayRow(110)).posterTemplateId === template.id && (await dayRow(115)).suggestedTemplateId === template.id);
    t('days outside the range unchanged (100, 131)', snapshot([await dayRow(100), await dayRow(131)]) === outside);
    t('poster versions not deleted or changed', snapshot(await tx.posterVersion.findMany({ where: { calendarDay: { campaignId: campaign.campaignId } }, orderBy: { id: 'asc' } })) === versionsBefore);
    const after110 = await dayRow(110);
    const active = await tx.posterVersion.findUniqueOrThrow({ where: { id: version.versionId } });
    t('the active poster stays active…', after110.activePosterVersionId === version.versionId);
    t('…and is now marked outdated (needs poster regeneration)', !isVersionCurrent(active, after110) && result.chunks[0]?.postersOutdated.join() === '110', snapshot(result.chunks[0]?.postersOutdated));
    t('content types chosen for those days are kept', rangeAfter.every((row, i) => row.contentType === rangeBefore[i]!.contentType));
  }

  // =======================================================================
  section('overwrite continues without rewriting twice');
  // =======================================================================
  {
    const revision = async (n: number) => (await dayRow(n)).contentRevision;
    const r131 = await revision(131);
    const r161 = await revision(161);
    const first = await generateCampaignContent(tx, campaign.campaignId, { fromDay: 131, toDay: 190, mode: 'overwrite', maxChunks: 1, generator: fake({ version: 'v3' }), timeZone: TZ });
    t('first call: 131–160, continue from 161, 30 remaining', first.chunks[0]?.toDay === 160 && first.nextFromDay === 161 && first.remaining === 30, snapshot({ next: first.nextFromDay, remaining: first.remaining }));
    const second = await generateCampaignContent(tx, campaign.campaignId, { fromDay: first.nextFromDay!, toDay: 190, mode: 'overwrite', maxChunks: 1, generator: fake({ version: 'v3' }), timeZone: TZ });
    t('second call: 161–190, done', second.chunks[0]?.fromDay === 161 && second.nextFromDay === null && second.remaining === 0);
    t('each day rewritten exactly once', (await revision(131)) === r131 + 1 && (await revision(161)) === r161 + 1);
  }

  // =======================================================================
  section('regenerate day 127');
  // =======================================================================
  {
    const day127 = await dayRow(127);
    await selectDayTemplate(tx, day127.id, template.id);
    const v = await addPosterVersion(tx, { calendarDayId: day127.id, source: 'PIPELINE', imageDriveFileId: 'fixture-127', imageMimeType: 'image/png', contentRevision: (await dayRow(127)).contentRevision });
    const before = await dayRow(127);
    const neighbours = snapshot([await dayRow(126), await dayRow(128)]);
    const versions = snapshot(await tx.posterVersion.findMany({ where: { calendarDayId: day127.id } }));
    const usageBefore = await tx.usageEvent.count();

    const callsBefore = calls.length;
    const report = await regenerateCampaignDayContent(tx, day127.id, { generator: fake({ version: 'v4' }), timeZone: TZ });
    const after = await dayRow(127);
    t('one request for exactly one day', calls.length === callsBefore + 1 && report.requested === 1 && report.written.join() === '127');
    t('content replaced', after.headline === 'Headline 127 v4' && after.theme === 'Topic 127 v4');
    t('date and day number preserved', after.dayNumber === 127 && after.scheduledDate.getTime() === before.scheduledDate.getTime());
    t('contentRevision incremented', after.contentRevision === before.contentRevision + 1);
    t('template mapping unchanged', after.posterTemplateId === template.id && after.suggestedTemplateId === before.suggestedTemplateId);
    t('poster versions and active pointer unchanged', snapshot(await tx.posterVersion.findMany({ where: { calendarDayId: day127.id } })) === versions && after.activePosterVersionId === v.versionId);
    t('no poster generation, no delivery fields touched', after.generationStatus === before.generationStatus && after.deliveryStatus === before.deliveryStatus && after.approvedAt === null && after.sendAfter === null && after.gDriveFileId === null);
    t('days 126 and 128 unchanged', snapshot([await dayRow(126), await dayRow(128)]) === neighbours);
    t('no usage or WhatsApp row written by a content write', (await tx.usageEvent.count()) === usageBefore);
    t('the poster is reported outdated', report.postersOutdated.join() === '127');
  }

  // =======================================================================
  section('manual editing and review');
  // =======================================================================
  {
    const day150 = await dayRow(150);
    const neighbours = snapshot([await dayRow(149), await dayRow(151)]);
    const callsBefore = calls.length;
    const edit = await updateCampaignDayContent(tx, day150.id, {
      theme: 'Gum disease signs',
      contentType: 'gum-health',
      headline: '5 Signs You Shouldn’t Ignore',
      supportingText: 'Bleeding, swelling and more.',
      cta: 'Book a consultation',
      caption: 'Your gums talk. Listen early.',
      hashtags: '#gums #dental',
      imagePrompt: 'Close-up of a smiling patient.',
    }, { expectedRevision: day150.contentRevision });
    const after = await dayRow(150);
    t('admin edit changes day 150', after.headline === '5 Signs You Shouldn’t Ignore' && edit.revisionBumped);
    t('no model request for a manual edit', calls.length === callsBefore);
    t('edit is the review: READY, findings cleared', after.contentStatus === 'READY' && after.contentIssues.length === 0);
    t('days 149 and 151 unchanged', snapshot([await dayRow(149), await dayRow(151)]) === neighbours);
    await expectDomainError('a content type outside the vertical strategy is refused', 'invalid-input', () => updateCampaignDayContent(tx, day150.id, { contentType: 'educational' }));

    // A day flagged NEEDS_REVIEW, accepted as is.
    const flagged = await dayRow(20);
    await tx.contentCalendar.update({ where: { id: flagged.id }, data: { contentStatus: 'NEEDS_REVIEW', contentIssues: ['Topic repeats day 3.'] } });
    await markCampaignDayContentReviewed(tx, flagged.id);
    const reviewed = await dayRow(20);
    t('mark reviewed: NEEDS_REVIEW → READY, content untouched', reviewed.contentStatus === 'READY' && reviewed.contentIssues.length === 0 && reviewed.headline === flagged.headline && reviewed.contentRevision === flagged.contentRevision);
    await expectDomainError('a READY day cannot be marked reviewed', 'invalid-transition', () => markCampaignDayContentReviewed(tx, flagged.id));
  }

  // =======================================================================
  section('an operator edit during generation wins');
  // =======================================================================
  {
    const day302 = await dayRow(302);
    const result = await generateCampaignContent(tx, campaign.campaignId, {
      fromDay: 300,
      toDay: 305,
      mode: 'overwrite',
      generator: fake({ version: 'v5', beforeReturn: async () => { await updateCampaignDayContent(tx, day302.id, { headline: 'Operator headline' }); } }),
      timeZone: TZ,
    });
    t('the edited day is skipped and reported', result.chunks[0]?.changedMeanwhile.join() === '302' && result.chunks[0]?.written.length === 5, snapshot(result.chunks[0]));
    t('the operator\'s headline is kept', (await dayRow(302)).headline === 'Operator headline');
  }

  // =======================================================================
  section('truncated response splits the chunk');
  // =======================================================================
  {
    const small = await tx.client.create({
      data: { companyName: 'check:content Small', whatsappNumber: '910000000010', startDate: start, endDate: start, planId: shortPlan.id, categoryId: vertical.id, isDemo: true, isActive: false },
    });
    const smallCampaign = await createCampaign(tx, { clientId: small.id, name: 'Forty', startDate: start, timeZone: TZ });
    const callsBefore = calls.length;
    const result = await generateCampaignContent(tx, smallCampaign.campaignId, { generator: fake({ version: 'v1', truncateAbove: 20 }), timeZone: TZ });
    t('days 1–30 split into 1–15 and 16–30 after truncation; all 40 written', calls.length === callsBefore + 4 && result.chunks.length === 2 && result.chunks.every((chunk) => chunk.error === null) && (await tx.contentCalendar.count({ where: { campaignId: smallCampaign.campaignId, contentStatus: 'READY' } })) === 40, snapshot({ calls: calls.length - callsBefore, chunks: result.chunks.map((c) => [c.fromDay, c.toDay, c.written.length]) }));

    await expectDomainError('a range past the campaign is refused', 'invalid-input', () => generateCampaignContent(tx, smallCampaign.campaignId, { fromDay: 1, toDay: 41, generator: fake({ version: 'x' }) }));
    await changeCampaignStatus(tx, smallCampaign.campaignId, 'CANCELLED');
    const callsBeforeClosed = calls.length;
    await expectDomainError('a cancelled campaign is refused before any request', 'campaign-closed', () => generateCampaignContent(tx, smallCampaign.campaignId, { mode: 'overwrite', generator: fake({ version: 'x' }) }));
    t('…with no request made', calls.length === callsBeforeClosed);
  }

  // =======================================================================
  section('legacy rows');
  // =======================================================================
  t('legacy calendar rows untouched by campaign generation', snapshot(await tx.contentCalendar.findMany({ where: { clientId: legacyClient.id } })) === legacyBefore);
  await expectDomainError('a legacy row cannot be regenerated as a campaign day', 'not-a-campaign-day', async () =>
    regenerateCampaignDayContent(tx, (await tx.contentCalendar.findFirstOrThrow({ where: { clientId: legacyClient.id } })).id, { generator: fake({ version: 'x' }) }),
  );
}

const TABLES = ['Client', 'Campaign', 'ContentCalendar', 'PosterVersion', 'Category', 'CategoryTemplate', 'Plan', 'UsageEvent'];
async function tableCounts(): Promise<string> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "${table}"`);
    counts[table] = Number(rows[0]?.n ?? -1);
  }
  return snapshot(counts);
}

async function main(): Promise<void> {
  const before = await tableCounts();
  try {
    await prisma.$transaction(
      async (tx) => {
        await suite(tx);
        throw new Rollback();
      },
      { timeout: 300_000, maxWait: 10_000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) {
      console.error('\nSuite aborted:', error);
      bad += 1;
    }
  }

  section('after rollback');
  const after = await tableCounts();
  t('every table has exactly its original row count', before === after, after);
  t('no network call was attempted', networkAttempts === 0, String(networkAttempts));
  console.log(`\n${bad === 0 ? 'All campaign content database checks passed.' : `${bad} check(s) FAILED.`}`);
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
