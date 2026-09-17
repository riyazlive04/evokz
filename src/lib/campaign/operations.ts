import type {
  CampaignDeliveryStatus,
  CampaignStatus,
  PosterApprovalStatus,
  PosterGenerationStatus,
  TemplateMappingMode,
} from '@prisma/client';

import { effectiveTemplateId } from '@/lib/campaign/model';
import { isGenerationInProgress, derivePosterState, type PosterState } from '@/lib/campaign/poster-generation';
import { generationWindow, isInWindow } from '@/lib/campaign/poster-generation';
import { type CampaignDb } from '@/lib/campaign/service';
import { getAppTimeZone } from '@/lib/time';

/**
 * Campaign operations — the health summary and the needs-attention queue
 * (Phase 7).
 *
 * **Why this exists rather than reusing the review overview.** Phases 4–6 each
 * built a rich overview (`loadPosterOverview`, `loadCampaignReview`,
 * `loadCampaignDeliveryOverview`) that reads every day, every active version,
 * the whole template set and the content strategy, then runs five eligibility
 * evaluations per day. That is the right shape for a page that renders all of
 * it, and the wrong shape for six integers — the client page was paying it once
 * per campaign, serially, to print a count.
 *
 * This module answers the counting questions with one narrow query and the same
 * derivation (`derivePosterState`), so a number here can never disagree with the
 * queue it links to. It writes nothing and calls no provider.
 */

// ---------------------------------------------------------------------------
// The shape of one day, as operations sees it
// ---------------------------------------------------------------------------

/** The smallest row that can answer every operational question about a day. */
const operationsDaySelect = {
  id: true,
  dayNumber: true,
  campaignId: true,
  scheduledDate: true,
  contentStatus: true,
  contentIssues: true,
  contentRevision: true,
  posterTemplateId: true,
  suggestedTemplateId: true,
  generationStatus: true,
  posterGenerationStartedAt: true,
  errorMessage: true,
  activePosterVersion: { select: { contentRevision: true, approvalStatus: true } },
  delivery: { select: { status: true, failureReason: true, failurePermanent: true, attempts: true } },
  campaign: { select: { templateMappingMode: true } },
} as const;

export interface OperationsDay {
  id: string;
  dayNumber: number;
  campaignId: string | null;
  scheduledDate: Date;
  contentStatus: string | null;
  contentIssues: string[];
  contentRevision: number;
  posterTemplateId: string | null;
  suggestedTemplateId: string | null;
  generationStatus: PosterGenerationStatus | null;
  posterGenerationStartedAt: Date | null;
  errorMessage: string | null;
  activePosterVersion: { contentRevision: number; approvalStatus: PosterApprovalStatus } | null;
  delivery: { status: CampaignDeliveryStatus; failureReason: string | null; failurePermanent: boolean; attempts: number } | null;
  /**
   * The owning campaign's mapping mode. It decides whether a stored AUTO
   * suggestion counts as the day's template (`effectiveTemplateId`): under
   * MANUAL a suggestion is only a hint, and the day is unmapped.
   */
  campaign: { templateMappingMode: TemplateMappingMode } | null;
}

/** Whether the day has a template its poster would be drawn from — model.ts's one rule. */
function hasEffectiveTemplate(day: OperationsDay): boolean {
  return effectiveTemplateId(day.campaign?.templateMappingMode ?? 'MANUAL', day) !== null;
}

function stateOf(day: OperationsDay, now: Date): PosterState {
  return derivePosterState({
    generating: isGenerationInProgress(day.generationStatus, day.posterGenerationStartedAt, now),
    lastAttemptFailed: day.generationStatus === 'FAILED',
    dayRevision: day.contentRevision,
    activeVersion: day.activePosterVersion,
    // Operations does not re-derive template compatibility (that is Phase 3's
    // job on the mapping page); an unmapped day is reported in its own bucket.
    attention: false,
  });
}

// ---------------------------------------------------------------------------
// Campaign health
// ---------------------------------------------------------------------------

export interface HealthCount {
  done: number;
  total: number;
}

export interface CampaignHealth {
  campaignId: string;
  status: CampaignStatus;
  durationDays: number;
  /** Across the whole campaign. */
  content: HealthCount & { needsReview: number; missing: number };
  templates: HealthCount & { unmapped: number };
  /** Across the rolling generation window, which is all that is generated. */
  posters: HealthCount & {
    needsApproval: number;
    approved: number;
    rejected: number;
    outdated: number;
    failed: number;
    generating: number;
    queued: number;
  };
  delivery: { scheduled: number; sent: number; failed: number; skipped: number; total: number };
  usage: CampaignUsage;
  attention: AttentionItem[];
}

/**
 * One thing an operator has to do something about, and where to do it.
 *
 * `href` is a link into the queue that fixes it, so the dashboard is a way in
 * rather than a list to read — nobody should scroll 365 days to find day 17.
 */
export interface AttentionItem {
  group: 'CONTENT' | 'TEMPLATE' | 'POSTER' | 'APPROVAL' | 'DELIVERY';
  dayNumber: number;
  dayId: string;
  detail: string;
  /** A query string for the campaign page, e.g. `?review=failed`. */
  href: string;
}

export interface CampaignUsage {
  /** Image generations billed to this campaign's days. */
  generations: number;
  inputTokens: number;
  outputTokens: number;
  /** USD millionths, as recorded at the time of each call. */
  costUsdMicros: number;
  /**
   * Generations recorded with no price, because the image rates were unset when
   * they ran. Their token counts are still exact.
   */
  unpriced: number;
  /** Whether the three `PRICE_OPENAI_IMAGE_*` rates are configured now. */
  pricingConfigured: boolean;
  /** WhatsApp messages billed to this campaign. */
  messages: number;
}

/**
 * Everything the campaign dashboard's health panel shows, in three queries.
 *
 * Deliberately not built on the review overview: this is counting, and the
 * overview is rendering.
 */
export async function loadCampaignHealth(
  db: CampaignDb,
  campaignId: string,
  options: { now?: Date; timeZone?: string } = {},
): Promise<CampaignHealth> {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? getAppTimeZone();

  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, status: true, durationDays: true, generationWindowDays: true },
  });
  if (!campaign) throw new Error('Campaign does not exist.');

  const rows = (await db.contentCalendar.findMany({
    where: { campaignId },
    select: operationsDaySelect,
    orderBy: { dayNumber: 'asc' },
  })) as unknown as OperationsDay[];

  const window = generationWindow(now, campaign.generationWindowDays, timeZone);
  const inWindow = rows.filter((day) => isInWindow(day.scheduledDate, window));

  const health: CampaignHealth = {
    campaignId,
    status: campaign.status,
    durationDays: campaign.durationDays,
    content: {
      done: rows.filter((day) => day.contentStatus === 'READY').length,
      total: rows.length,
      needsReview: rows.filter((day) => day.contentStatus === 'NEEDS_REVIEW').length,
      missing: rows.filter((day) => day.contentStatus === 'NOT_GENERATED' || day.contentStatus === null).length,
    },
    templates: {
      done: rows.filter(hasEffectiveTemplate).length,
      total: rows.length,
      unmapped: rows.filter((day) => !hasEffectiveTemplate(day)).length,
    },
    posters: {
      done: inWindow.filter((day) => day.activePosterVersion !== null).length,
      total: inWindow.length,
      needsApproval: 0,
      approved: 0,
      rejected: 0,
      outdated: 0,
      failed: 0,
      generating: 0,
      queued: rows.filter((day) => day.generationStatus === 'QUEUED').length,
    },
    delivery: { scheduled: 0, sent: 0, failed: 0, skipped: 0, total: rows.filter((day) => day.delivery !== null).length },
    usage: await loadCampaignUsage(db, campaignId),
    attention: [],
  };

  for (const day of inWindow) {
    switch (stateOf(day, now)) {
      case 'needs-approval':
        health.posters.needsApproval += 1;
        break;
      case 'approved':
        health.posters.approved += 1;
        break;
      case 'rejected':
        health.posters.rejected += 1;
        break;
      case 'outdated':
        health.posters.outdated += 1;
        break;
      case 'failed':
        health.posters.failed += 1;
        break;
      case 'generating':
        health.posters.generating += 1;
        break;
      default:
        break;
    }
  }

  for (const day of rows) {
    switch (day.delivery?.status) {
      case 'SCHEDULED':
      case 'SENDING':
        health.delivery.scheduled += 1;
        break;
      case 'SENT':
        health.delivery.sent += 1;
        break;
      case 'FAILED':
        health.delivery.failed += 1;
        break;
      case 'CANCELLED':
      case 'SKIPPED':
        health.delivery.skipped += 1;
        break;
      default:
        break;
    }
  }

  health.attention = buildAttentionQueue(rows, inWindow, now);
  return health;
}

/**
 * The unified blockers list, grouped by what an operator would do about them.
 *
 * Ordered by group, then by day, and capped: a 365-day campaign with a
 * systematic problem would otherwise render hundreds of identical rows. The
 * counts in the health panel remain exact — only this list is trimmed.
 */
export const MAX_ATTENTION_ITEMS = 40;

export function buildAttentionQueue(
  rows: readonly OperationsDay[],
  inWindow: readonly OperationsDay[],
  now: Date,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const windowIds = new Set(inWindow.map((day) => day.id));

  for (const day of rows) {
    const base = { dayNumber: day.dayNumber, dayId: day.id };

    if (day.contentStatus === 'NEEDS_REVIEW') {
      items.push({ ...base, group: 'CONTENT', detail: day.contentIssues[0] ?? 'Content needs a look.', href: '?review=all' });
    }
    // An unmapped day only blocks once it is close enough to be generated.
    if (!hasEffectiveTemplate(day) && windowIds.has(day.id)) {
      items.push({ ...base, group: 'TEMPLATE', detail: 'No template is mapped to this day.', href: '?review=unmapped' });
    }

    if (windowIds.has(day.id)) {
      const state = stateOf(day, now);
      if (state === 'failed') {
        items.push({ ...base, group: 'POSTER', detail: day.errorMessage ?? 'Generation failed.', href: '?review=failed' });
      } else if (state === 'outdated') {
        items.push({ ...base, group: 'POSTER', detail: 'Content or template changed after this poster was made.', href: '?review=outdated' });
      } else if (state === 'rejected') {
        items.push({ ...base, group: 'APPROVAL', detail: 'Rejected — edit or regenerate it.', href: '?review=rejected' });
      } else if (state === 'needs-approval') {
        items.push({ ...base, group: 'APPROVAL', detail: 'Awaiting review.', href: '?review=needs-review' });
      }
    }

    if (day.delivery?.status === 'FAILED') {
      items.push({
        ...base,
        group: 'DELIVERY',
        detail: day.delivery.failurePermanent
          ? `Delivery failed and will not retry automatically. ${day.delivery.failureReason ?? ''}`.trim()
          : (day.delivery.failureReason ?? 'Delivery failed.'),
        href: '?delivery=failed',
      });
    }
  }

  const order: Record<AttentionItem['group'], number> = { CONTENT: 0, TEMPLATE: 1, POSTER: 2, APPROVAL: 3, DELIVERY: 4 };
  items.sort((a, b) => order[a.group] - order[b.group] || a.dayNumber - b.dayNumber);
  return items.slice(0, MAX_ATTENTION_ITEMS);
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/**
 * What this campaign has spent, from the existing ledger.
 *
 * No new column: `UsageEvent.calendarId` already carries the campaign day id on
 * every campaign poster render and every campaign delivery, and the day rows
 * carry the campaign. Two queries, both aggregates.
 *
 * **Estimated, never a bill.** `costUsdMicros` is whatever the rate card priced
 * the call at when it ran; image rows recorded before
 * `PRICE_OPENAI_IMAGE_*` were configured carry exact token counts and no price,
 * and are reported separately as `unpriced` rather than silently counted as
 * free. Nothing here reads a provider invoice, because the image API does not
 * return one.
 */
export async function loadCampaignUsage(db: CampaignDb, campaignId: string): Promise<CampaignUsage> {
  const { isOpenAiImagePricingConfigured, getRateCard } = await import('@/lib/pricing');

  const days = await db.contentCalendar.findMany({ where: { campaignId }, select: { id: true } });
  const dayIds = days.map((day) => day.id);

  const usage: CampaignUsage = {
    generations: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsdMicros: 0,
    unpriced: 0,
    pricingConfigured: isOpenAiImagePricingConfigured(getRateCard()),
    messages: 0,
  };
  if (dayIds.length === 0) return usage;

  const grouped = await db.usageEvent.groupBy({
    by: ['provider'],
    where: { calendarId: { in: dayIds } },
    _sum: { imageCount: true, inputTokens: true, outputTokens: true, costUsdMicros: true, messageCount: true },
  });

  for (const row of grouped) {
    if (row.provider === 'OPENAI') {
      usage.generations += row._sum.imageCount ?? 0;
      usage.inputTokens += row._sum.inputTokens ?? 0;
      usage.outputTokens += row._sum.outputTokens ?? 0;
    }
    if (row.provider === 'EVOLUTION') usage.messages += row._sum.messageCount ?? 0;
    usage.costUsdMicros += row._sum.costUsdMicros ?? 0;
  }

  // Zero money on an image row means "not priced", not "free".
  const unpriced = await db.usageEvent.aggregate({
    where: { calendarId: { in: dayIds }, provider: 'OPENAI', costUsdMicros: 0 },
    _sum: { imageCount: true },
  });
  usage.unpriced = unpriced._sum.imageCount ?? 0;

  return usage;
}

// ---------------------------------------------------------------------------
// The client page's per-campaign counts
// ---------------------------------------------------------------------------

export interface CampaignAttentionSummary {
  campaignId: string;
  needsReview: number;
  rejected: number;
  outdated: number;
  failed: number;
  unmapped: number;
  attention: number;
}

/**
 * Attention counts for every campaign of one client, in one query.
 *
 * Replaces a `for … await loadCampaignReview(…)` loop that ran a full poster
 * overview — all days, all active versions, the whole template set, five
 * eligibility evaluations per day — once per campaign, to print six integers.
 */
export async function loadClientCampaignAttention(
  db: CampaignDb,
  clientId: string,
  options: { now?: Date; timeZone?: string } = {},
): Promise<Map<string, CampaignAttentionSummary>> {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? getAppTimeZone();

  const campaigns = await db.campaign.findMany({
    where: { clientId },
    select: { id: true, generationWindowDays: true },
  });
  if (campaigns.length === 0) return new Map();

  const rows = (await db.contentCalendar.findMany({
    where: { campaignId: { in: campaigns.map((campaign) => campaign.id) } },
    select: operationsDaySelect,
    orderBy: { dayNumber: 'asc' },
  })) as unknown as OperationsDay[];

  const summaries = new Map<string, CampaignAttentionSummary>();
  for (const campaign of campaigns) {
    const window = generationWindow(now, campaign.generationWindowDays, timeZone);
    const days = rows.filter((day) => day.campaignId === campaign.id);
    const summary: CampaignAttentionSummary = {
      campaignId: campaign.id,
      needsReview: 0,
      rejected: 0,
      outdated: 0,
      failed: 0,
      unmapped: 0,
      attention: 0,
    };

    for (const day of days) {
      const unmapped = !hasEffectiveTemplate(day);
      const withinWindow = isInWindow(day.scheduledDate, window);
      const state = stateOf(day, now);

      if (state === 'needs-approval') summary.needsReview += 1;
      if (state === 'rejected') summary.rejected += 1;
      if (state === 'outdated') summary.outdated += 1;
      if (state === 'failed') summary.failed += 1;
      if (unmapped) summary.unmapped += 1;

      // The same rule Phase 5's `needsAttention` applies, on the same states.
      if (state === 'rejected' || state === 'outdated' || state === 'failed' || (unmapped && withinWindow)) {
        summary.attention += 1;
      }
    }

    summaries.set(campaign.id, summary);
  }

  return summaries;
}
