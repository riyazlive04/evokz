import { generateStructured, LlmError } from '@/lib/ai/openai';
import {
  buildContentHistory,
  buildContentSchema,
  buildContentSystemPrompt,
  buildContentUserPrompt,
  chunkDays,
  CONTENT_CHUNK_DAYS,
  selectTargetDays,
  validateGeneratedChunk,
  type ContentBrief,
  type ContentGenerationMode,
  type ContentSlot,
  type RequestedDay,
} from '@/lib/campaign/content-plan';
import { pillarKeys, planContentTypes, resolveContentStrategy } from '@/lib/campaign/content-strategy';
import { campaignAllowsChanges, planCampaignSlots } from '@/lib/campaign/model';
import { CampaignDomainError, type CampaignDb } from '@/lib/campaign/service';
import { describeDeliveryDays, formatDisplayDate, getAppTimeZone } from '@/lib/time';
import { parseBrandGuideline } from '@/lib/types/brand';

/**
 * Campaign content generation — AI writes the CONTENT of campaign days.
 *
 * Content only. Nothing here renders, uploads, maps a template, touches a poster
 * version, calls an image model or sends a message. A generated day is written
 * into its existing slot (`ContentCalendar` with `campaignId`); its date, day
 * number, template choices and poster versions are never part of the write.
 *
 * - **Chunked.** At most `CONTENT_CHUNK_DAYS` (30) days per model request, run
 *   sequentially so later chunks read the stable system prompt from the cache
 *   and see what earlier chunks wrote. A failing chunk stops the run; everything
 *   before it is already saved, and a retry targets only what is left.
 * - **Idempotent.** `missing` mode writes only empty slots, so repeating a
 *   request never duplicates or replaces content; slots are unique per
 *   (campaign, day number), so no row is ever created twice. Replacing content
 *   takes `overwrite` mode, explicitly.
 * - **Safe against concurrent edits.** Each write is conditional on the day
 *   being exactly as it was read (`updatedAt` and `contentRevision`), so an
 *   operator's edit made while the model was writing is kept and reported.
 * - **Posters survive.** Rewriting a day bumps `contentRevision`, which marks an
 *   existing active poster outdated (derived, see `isVersionCurrent`) without
 *   deleting or changing it. The report lists those days.
 */

export interface ContentGenerationRequest {
  label: string;
  systemPrompt: string;
  userPrompt: string;
  schema: Record<string, unknown>;
  /** Billing attribution only; never sent to the model. */
  clientId: string;
}

/** Returns the model's parsed JSON. Injected by tests; the default calls OpenAI. */
export type ContentGenerator = (request: ContentGenerationRequest) => Promise<unknown>;

export const openAiContentGenerator: ContentGenerator = (request) =>
  generateStructured<unknown>({
    label: request.label,
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt,
    schema: request.schema,
    schemaName: 'campaign_content_chunk',
    // Varied copy across a long campaign; the history and validation do the rest.
    temperature: 0.9,
    // 30 days of captions and briefs; gpt-4o-mini's ceiling is 16,384.
    maxTokens: 16_000,
    bill: { clientId: request.clientId, operation: 'calendar' },
  });

export interface GenerateCampaignContentOptions {
  /** First day of the range, default 1. */
  fromDay?: number;
  /** Last day of the range, default the campaign's last day. */
  toDay?: number;
  /** Default `missing`. */
  mode?: ContentGenerationMode;
  /** Days per request, 1–30, default 30. */
  chunkSize?: number;
  /** Stop after this many chunks — the console runs one per request. */
  maxChunks?: number;
  generator?: ContentGenerator;
  timeZone?: string;
}

export interface ContentChunkReport {
  fromDay: number;
  toDay: number;
  requested: number;
  /** Days whose content was written. */
  written: number[];
  /** Written days flagged NEEDS_REVIEW. */
  needsReview: number[];
  /** Requested days with no usable entry. Untouched; generate again to fill them. */
  missing: number[];
  /** Days edited by someone while the model was writing. Their edit was kept. */
  changedMeanwhile: number[];
  /** Written days that already had an active poster, which is now outdated. */
  postersOutdated: number[];
  /** Model entries thrown away, with why. */
  rejected: string[];
  /** Set when a request failed. Days from `errorFromDay` on were not written. */
  error: string | null;
  errorFromDay: number | null;
}

export interface GenerateCampaignContentResult {
  campaignId: string;
  mode: ContentGenerationMode;
  fromDay: number;
  toDay: number;
  chunks: ContentChunkReport[];
  /** Days of the range still to process after this call. */
  remaining: number;
  /**
   * Where to continue: the `fromDay` for the next call, or null when the range
   * is done. In `overwrite` mode it moves past processed chunks, so a follow-up
   * call never rewrites what this one just wrote.
   */
  nextFromDay: number | null;
}

type Slot = ContentSlot & { activePosterVersionId: string | null };

const slotSelect = {
  id: true,
  dayNumber: true,
  scheduledDate: true,
  contentStatus: true,
  contentRevision: true,
  updatedAt: true,
  contentType: true,
  theme: true,
  headline: true,
  cta: true,
  activePosterVersionId: true,
} as const;

export async function generateCampaignContent(
  db: CampaignDb,
  campaignId: string,
  options: GenerateCampaignContentOptions = {},
): Promise<GenerateCampaignContentResult> {
  const generator = options.generator ?? openAiContentGenerator;
  const mode = options.mode ?? 'missing';
  const timeZone = options.timeZone ?? getAppTimeZone();

  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      clientId: true,
      name: true,
      status: true,
      startDate: true,
      durationDays: true,
      deliveryDays: true,
      plan: { select: { name: true } },
      category: { select: { name: true, contentStrategy: true } },
      client: { select: { companyName: true, brandTagline: true, brandGuideline: true } },
    },
  });
  if (!campaign) throw new CampaignDomainError('not-found', 'Campaign does not exist.');
  if (!campaignAllowsChanges(campaign.status)) {
    throw new CampaignDomainError('campaign-closed', `The campaign is ${campaign.status}.`);
  }

  const fromDay = options.fromDay ?? 1;
  const toDay = options.toDay ?? campaign.durationDays;
  if (
    !Number.isInteger(fromDay) ||
    !Number.isInteger(toDay) ||
    fromDay < 1 ||
    toDay > campaign.durationDays ||
    fromDay > toDay
  ) {
    throw new CampaignDomainError(
      'invalid-input',
      `The range must lie within days 1–${campaign.durationDays}, with the first day no later than the last.`,
    );
  }
  const chunkSize = Math.min(CONTENT_CHUNK_DAYS, Math.max(1, Math.floor(options.chunkSize ?? CONTENT_CHUNK_DAYS)));

  const slots = await loadSlots(db, campaign, timeZone);

  const { strategy } = resolveContentStrategy(campaign.category.contentStrategy);
  const keys = pillarKeys(strategy);
  const planned = planContentTypes(strategy, campaign.durationDays);
  const guideline = parseBrandGuideline(campaign.client.brandGuideline);

  const brief: ContentBrief = {
    companyName: campaign.client.companyName,
    verticalName: campaign.category.name,
    planName: campaign.plan.name,
    durationDays: campaign.durationDays,
    startDateLabel: formatDisplayDate(campaign.startDate, timeZone),
    deliveryDaysLabel: describeDeliveryDays(campaign.deliveryDays).toLowerCase(),
    brandTagline: campaign.client.brandTagline?.trim() || null,
    brandVoice: guideline.typography?.vibeClassification ?? null,
    strategy,
  };
  const systemPrompt = buildContentSystemPrompt(brief);
  const schema = buildContentSchema(keys);
  const dateFormat = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone,
  });

  const byDay = new Map(slots.map((slot) => [slot.dayNumber, slot]));

  async function runChunk(chunk: Slot[]): Promise<ContentChunkReport> {
    const first = chunk[0]!.dayNumber;
    const last = chunk[chunk.length - 1]!.dayNumber;
    const report: ContentChunkReport = {
      fromDay: first,
      toDay: last,
      requested: chunk.length,
      written: [],
      needsReview: [],
      missing: [],
      changedMeanwhile: [],
      postersOutdated: [],
      rejected: [],
      error: null,
      errorFromDay: null,
    };

    const requested: RequestedDay[] = chunk.map((slot) => ({
      dayNumber: slot.dayNumber,
      dateLabel: dateFormat.format(slot.scheduledDate),
      // A day being rewritten keeps a content type someone chose for it.
      contentType:
        mode === 'overwrite' && slot.contentType && keys.includes(slot.contentType)
          ? slot.contentType
          : planned[slot.dayNumber - 1]!,
    }));

    let output: unknown;
    try {
      output = await generator({
        label: `campaign-content:${campaign!.name}:days ${first}-${last}`,
        systemPrompt,
        userPrompt: buildContentUserPrompt(
          requested,
          buildContentHistory([...byDay.values()], requested.map((day) => day.dayNumber)),
        ),
        schema,
        clientId: campaign!.clientId,
      });
    } catch (error) {
      // A response cut off at the token cap is the one failure a smaller
      // request fixes, so it is split rather than reported.
      if (error instanceof LlmError && error.kind === 'truncated' && chunk.length > 1) {
        const middle = Math.ceil(chunk.length / 2);
        const left = await runChunk(chunk.slice(0, middle));
        if (left.error) return mergeReports(left, emptyReport(chunk.slice(middle)), first, last);
        return mergeReports(left, await runChunk(chunk.slice(middle)), first, last);
      }
      report.error = error instanceof Error ? error.message : 'Content generation failed.';
      report.errorFromDay = first;
      report.missing = chunk.map((slot) => slot.dayNumber);
      return report;
    }

    const entries = Array.isArray((output as { days?: unknown } | null)?.days)
      ? ((output as { days: unknown[] }).days)
      : [];
    const validation = validateGeneratedChunk({
      requested,
      output: entries,
      existing: [...byDay.values()],
      contentTypeKeys: keys,
    });
    report.rejected = validation.rejected;
    report.missing = validation.missingDayNumbers;

    for (const day of validation.accepted) {
      const slot = byDay.get(day.dayNumber)!;
      const updated = await db.contentCalendar.updateMany({
        where: {
          id: slot.id,
          campaignId: campaign!.id,
          updatedAt: slot.updatedAt,
          contentRevision: slot.contentRevision,
          ...(mode === 'missing' ? { contentStatus: slot.contentStatus } : {}),
        },
        data: {
          theme: day.theme,
          contentType: day.contentType,
          headline: day.headline,
          supportingText: day.supportingText,
          cta: day.cta,
          caption: day.caption,
          hashtags: day.hashtags,
          imagePrompt: day.imagePrompt,
          suggestedTemplateType: day.suggestedTemplateType,
          contentStatus: day.contentStatus,
          contentIssues: day.contentIssues,
          contentRevision: { increment: 1 },
        },
      });

      if (updated.count === 0) {
        report.changedMeanwhile.push(day.dayNumber);
        continue;
      }

      report.written.push(day.dayNumber);
      if (day.contentStatus === 'NEEDS_REVIEW') report.needsReview.push(day.dayNumber);
      if (slot.activePosterVersionId) report.postersOutdated.push(day.dayNumber);
      // Later chunks compare against, and are told about, what this one wrote.
      byDay.set(day.dayNumber, {
        ...slot,
        theme: day.theme,
        headline: day.headline,
        cta: day.cta,
        contentType: day.contentType,
        contentStatus: day.contentStatus,
        contentRevision: slot.contentRevision + 1,
      });
    }

    return report;
  }

  const targets = selectTargetDays(slots, { fromDay, toDay, mode });
  const chunks = chunkDays(targets, chunkSize);
  const limit = Math.max(0, options.maxChunks ?? chunks.length);

  const reports: ContentChunkReport[] = [];
  let resumeFrom: number | null = null;
  for (const chunk of chunks.slice(0, limit)) {
    const report = await runChunk(chunk);
    reports.push(report);
    if (report.error) {
      resumeFrom = report.errorFromDay ?? chunk[0]!.dayNumber;
      break;
    }
  }

  let nextFromDay: number | null;
  let remaining: number;
  if (mode === 'missing') {
    // Repeating the same range picks up whatever is still empty.
    remaining = selectTargetDays([...byDay.values()], { fromDay, toDay, mode }).length;
    nextFromDay = remaining > 0 ? fromDay : null;
  } else {
    const processedUpTo = resumeFrom !== null ? resumeFrom - 1 : (reports.at(-1)?.toDay ?? fromDay - 1);
    nextFromDay = processedUpTo < toDay ? Math.max(fromDay, processedUpTo + 1) : null;
    remaining = nextFromDay === null ? 0 : toDay - nextFromDay + 1;
  }

  return { campaignId, mode, fromDay, toDay, chunks: reports, remaining, nextFromDay };
}

/**
 * Regenerates one day's content: same date, same day number, same template
 * choices and poster versions; new content and a bumped revision. Other days
 * are not read for writing and cannot change.
 */
export async function regenerateCampaignDayContent(
  db: CampaignDb,
  dayId: string,
  options: Pick<GenerateCampaignContentOptions, 'generator' | 'timeZone'> = {},
): Promise<ContentChunkReport> {
  const day = await db.contentCalendar.findUnique({
    where: { id: dayId },
    select: { campaignId: true, dayNumber: true },
  });
  if (!day) throw new CampaignDomainError('not-found', 'Campaign day does not exist.');
  if (!day.campaignId) {
    throw new CampaignDomainError('not-a-campaign-day', 'This calendar row is not part of a campaign.');
  }

  const result = await generateCampaignContent(db, day.campaignId, {
    ...options,
    fromDay: day.dayNumber,
    toDay: day.dayNumber,
    mode: 'overwrite',
    maxChunks: 1,
  });
  return result.chunks[0]!;
}

/**
 * Every slot of the campaign, recreating any that are missing. Phase 1 creates
 * all of them with the campaign; this only repairs a campaign whose rows were
 * removed by hand, and `skipDuplicates` keeps it a no-op otherwise.
 */
async function loadSlots(
  db: CampaignDb,
  campaign: { id: string; clientId: string; startDate: Date; durationDays: number; deliveryDays: number[] },
  timeZone: string,
): Promise<Slot[]> {
  const read = () =>
    db.contentCalendar.findMany({
      where: { campaignId: campaign.id },
      orderBy: { dayNumber: 'asc' },
      select: slotSelect,
    });

  let slots = await read();
  if (slots.length < campaign.durationDays) {
    const present = new Set(slots.map((slot) => slot.dayNumber));
    const missing = planCampaignSlots(campaign.startDate, campaign.durationDays, campaign.deliveryDays, timeZone).filter(
      (slot) => !present.has(slot.dayNumber),
    );
    await db.contentCalendar.createMany({
      data: missing.map((slot) => ({
        clientId: campaign.clientId,
        campaignId: campaign.id,
        dayNumber: slot.dayNumber,
        scheduledDate: slot.scheduledDate,
        caption: '',
        hashtags: '',
        imagePrompt: '',
        contentStatus: 'NOT_GENERATED' as const,
        generationStatus: 'NOT_REQUESTED' as const,
      })),
      skipDuplicates: true,
    });
    slots = await read();
  }
  return slots;
}

function emptyReport(chunk: Slot[]): ContentChunkReport {
  return {
    fromDay: chunk[0]!.dayNumber,
    toDay: chunk[chunk.length - 1]!.dayNumber,
    requested: chunk.length,
    written: [],
    needsReview: [],
    missing: chunk.map((slot) => slot.dayNumber),
    changedMeanwhile: [],
    postersOutdated: [],
    rejected: [],
    error: null,
    errorFromDay: null,
  };
}

function mergeReports(a: ContentChunkReport, b: ContentChunkReport, fromDay: number, toDay: number): ContentChunkReport {
  return {
    fromDay,
    toDay,
    requested: a.requested + b.requested,
    written: [...a.written, ...b.written],
    needsReview: [...a.needsReview, ...b.needsReview],
    missing: [...a.missing, ...b.missing],
    changedMeanwhile: [...a.changedMeanwhile, ...b.changedMeanwhile],
    postersOutdated: [...a.postersOutdated, ...b.postersOutdated],
    rejected: [...a.rejected, ...b.rejected],
    error: a.error ?? b.error,
    errorFromDay: a.errorFromDay ?? b.errorFromDay,
  };
}
