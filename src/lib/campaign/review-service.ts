import type { CampaignApprovalPolicy, CampaignStatus, PosterApprovalStatus, PosterVersionSource } from '@prisma/client';

import { campaignAllowsChanges, isVersionCurrent } from '@/lib/campaign/model';
import { POSTER_STATE_LABELS, type PosterState } from '@/lib/campaign/poster-generation';
import {
  approveCampaignDayPoster,
  eligibilityFor,
  loadPosterOverview,
  type PosterDay,
  type PosterLoadOptions,
  type PosterOverview,
} from '@/lib/campaign/poster-generation-service';
import {
  buildRejectionNote,
  campaignReadiness,
  canApprove,
  canReject,
  matchesFilter,
  parseRejectionNote,
  planBulkApproval,
  summarizeReview,
  type BulkApprovalPlan,
  type CampaignReadiness,
  type RejectionInput,
  type ReviewFilter,
  type ReviewRow,
  type ReviewSummary,
} from '@/lib/campaign/review';
import { CampaignDomainError, reviewPosterVersion, runInCampaignTransaction, type CampaignDb } from '@/lib/campaign/service';

/**
 * Campaign review and approval — database operations of Phase 5.
 *
 * The queue over a whole campaign, one day's detail, and the three review
 * writes: approve, reject (with a reason) and bulk approve. Every state it
 * shows comes from Phase 4's `loadPosterOverview`, and every write goes through
 * Phase 1's `reviewPosterVersion`, so there is one approval model and one state
 * derivation.
 *
 * Nothing here generates a poster, edits content, deletes a version or a Drive
 * file, or sends anything.
 */

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export interface ReviewDay extends ReviewRow {
  dateLabel: Date;
  headline: string | null;
  supportingText: string | null;
  cta: string | null;
  contentTypeLabel: string | null;
  templateLabel: string | null;
  templateSource: 'AUTO' | 'MANUAL' | null;
  stateLabel: string;
  versionNumber: number | null;
  versionCount: number;
  /** The studio row behind the active poster, for previews through the protected route. */
  generationId: string | null;
  /** On a rejected poster: the stored reason, split for display. */
  rejection: { label: string; detail: string | null } | null;
  /** The last generation failure, or the mapping problem behind "needs attention". */
  warning: string | null;
  canApprove: boolean;
  canReject: boolean;
  canRegenerate: boolean;
  canGenerate: boolean;
}

export interface CampaignReviewOverview {
  campaign: { id: string; clientId: string; name: string; status: CampaignStatus; approvalPolicy: CampaignApprovalPolicy; durationDays: number; windowDays: number };
  days: ReviewDay[];
  summary: ReviewSummary;
  readiness: CampaignReadiness;
}

function toReviewRow(day: PosterDay): ReviewRow {
  return {
    dayId: day.id,
    dayNumber: day.dayNumber,
    state: day.state,
    unmapped: day.mapping.templateId === null,
    inWindow: day.inWindow,
    contentReady: day.contentStatus === 'READY',
    dayContentRevision: day.contentRevision,
    activeVersion: day.activeVersion
      ? { id: day.activeVersion.id, contentRevision: day.activeVersion.contentRevision, approvalStatus: day.activeVersion.approvalStatus }
      : null,
  };
}

/** Everything the review queue and the readiness summary need, for the whole campaign. */
export async function loadCampaignReview(db: CampaignDb, campaignId: string, options: PosterLoadOptions = {}): Promise<CampaignReviewOverview> {
  const overview = await loadPosterOverview(db, campaignId, options);
  return buildReview(overview);
}

/** The same view from an overview already loaded, so a page never loads it twice. */
export function buildReview(overview: PosterOverview): CampaignReviewOverview {
  const status = overview.campaign.status;
  const days: ReviewDay[] = overview.days.map((day) => {
    const row = toReviewRow(day);
    const issue = day.mapping.issues.find((candidate) => candidate.severity === 'action');
    return {
      ...row,
      dateLabel: day.scheduledDate,
      headline: day.headline,
      supportingText: day.supportingText,
      cta: day.cta,
      contentTypeLabel: day.contentTypeLabel,
      templateLabel: day.templateLabel,
      templateSource: day.mapping.source,
      stateLabel: POSTER_STATE_LABELS[day.state],
      versionNumber: day.activeVersion?.versionNumber ?? null,
      versionCount: day.versionCount,
      generationId: day.activeVersion?.studioGenerationId ?? null,
      rejection: day.activeVersion?.approvalStatus === 'REJECTED' ? parseRejectionNote(day.activeVersion.reviewNote) : null,
      warning:
        day.state === 'failed' || (day.activeVersion && day.generationStatus === 'FAILED')
          ? day.errorMessage
          : (issue?.detail ?? day.unmappedReason?.detail ?? null),
      canApprove: canApprove(row, status),
      canReject: canReject(row, status),
      canRegenerate: Boolean(day.activeVersion) && eligibilityFor(overview, day, 'regenerate', true).eligible,
      canGenerate: !day.activeVersion && eligibilityFor(overview, day, 'missing', true).eligible,
    };
  });

  return {
    campaign: {
      id: overview.campaign.id,
      clientId: overview.campaign.clientId,
      name: overview.campaign.name,
      status,
      approvalPolicy: overview.campaign.approvalPolicy,
      durationDays: overview.campaign.durationDays,
      windowDays: overview.window.days,
    },
    days,
    summary: summarizeReview(days),
    readiness: campaignReadiness({ rows: days, campaignStatus: status, approvalPolicy: overview.campaign.approvalPolicy }),
  };
}

export function filterReviewDays(days: readonly ReviewDay[], filter: ReviewFilter): ReviewDay[] {
  return days.filter((day) => matchesFilter(day, filter));
}

// ---------------------------------------------------------------------------
// One day's detail
// ---------------------------------------------------------------------------

export interface ReviewVersion {
  id: string;
  versionNumber: number;
  source: PosterVersionSource;
  approvalStatus: PosterApprovalStatus;
  reviewedAt: Date | null;
  rejection: { label: string; detail: string | null } | null;
  contentRevision: number;
  current: boolean;
  active: boolean;
  generationId: string | null;
  templateLabel: string | null;
  createdAt: Date;
}

export interface CampaignDayReview {
  dayId: string;
  campaignId: string;
  dayNumber: number;
  scheduledDate: Date;
  campaignStatus: CampaignStatus;
  approvalPolicy: CampaignApprovalPolicy;
  content: { contentStatus: string; contentTypeLabel: string | null; theme: string | null; headline: string | null; supportingText: string | null; cta: string | null; contentRevision: number };
  template: { label: string | null; source: 'AUTO' | 'MANUAL' | null; issue: string | null };
  poster: { state: PosterState; stateLabel: string; generationStatus: string | null; warning: string | null; activeVersionId: string | null };
  versions: ReviewVersion[];
  actions: { canApprove: boolean; canReject: boolean; canRegenerate: boolean; canGenerate: boolean };
}

/**
 * One day, with its content, template, poster and every version — the day
 * detail the review queue opens. Read-only, and carries no Drive id: previews
 * go through the studio row's protected route.
 */
export async function loadCampaignDayReview(db: CampaignDb, dayId: string, options: PosterLoadOptions = {}): Promise<CampaignDayReview> {
  const day = await db.contentCalendar.findUnique({ where: { id: dayId }, select: { campaignId: true } });
  if (!day?.campaignId) throw new CampaignDomainError('not-a-campaign-day', 'This calendar row is not part of a campaign.');

  const overview = await loadPosterOverview(db, day.campaignId, options);
  const posterDay = overview.days.find((candidate) => candidate.id === dayId);
  if (!posterDay) throw new CampaignDomainError('not-found', 'Campaign day does not exist.');
  const review = buildReview(overview).days.find((candidate) => candidate.dayId === dayId)!;

  const versions = await db.posterVersion.findMany({
    where: { calendarDayId: dayId },
    orderBy: { versionNumber: 'desc' },
    select: {
      id: true,
      versionNumber: true,
      source: true,
      approvalStatus: true,
      reviewedAt: true,
      reviewNote: true,
      contentRevision: true,
      studioGenerationId: true,
      createdAt: true,
      template: { select: { label: true } },
    },
  });

  return {
    dayId,
    campaignId: day.campaignId,
    dayNumber: posterDay.dayNumber,
    scheduledDate: posterDay.scheduledDate,
    campaignStatus: overview.campaign.status,
    approvalPolicy: overview.campaign.approvalPolicy,
    content: {
      contentStatus: posterDay.contentStatus,
      contentTypeLabel: posterDay.contentTypeLabel,
      theme: posterDay.theme,
      headline: posterDay.headline,
      supportingText: posterDay.supportingText,
      cta: posterDay.cta,
      contentRevision: posterDay.contentRevision,
    },
    template: { label: posterDay.templateLabel, source: posterDay.mapping.source, issue: posterDay.mapping.issues.find((issue) => issue.severity === 'action')?.detail ?? posterDay.unmappedReason?.detail ?? null },
    poster: {
      state: posterDay.state,
      stateLabel: POSTER_STATE_LABELS[posterDay.state],
      generationStatus: posterDay.generationStatus,
      warning: review.warning,
      activeVersionId: posterDay.activeVersion?.id ?? null,
    },
    versions: versions.map((version) => ({
      id: version.id,
      versionNumber: version.versionNumber,
      source: version.source,
      approvalStatus: version.approvalStatus,
      reviewedAt: version.reviewedAt,
      rejection: version.approvalStatus === 'REJECTED' ? parseRejectionNote(version.reviewNote) : null,
      contentRevision: version.contentRevision,
      current: isVersionCurrent(version, posterDay),
      active: version.id === posterDay.activeVersion?.id,
      generationId: version.studioGenerationId,
      templateLabel: version.template?.label ?? null,
      createdAt: version.createdAt,
    })),
    actions: { canApprove: review.canApprove, canReject: review.canReject, canRegenerate: review.canRegenerate, canGenerate: review.canGenerate },
  };
}

// ---------------------------------------------------------------------------
// Review writes
// ---------------------------------------------------------------------------

/** The version the day's review acts on, with the guards every write shares. */
async function loadActiveForReview(db: CampaignDb, dayId: string, versionId: string) {
  const day = await db.contentCalendar.findUnique({
    where: { id: dayId },
    select: {
      contentRevision: true,
      activePosterVersionId: true,
      campaign: { select: { status: true } },
      activePosterVersion: { select: { id: true, contentRevision: true, approvalStatus: true } },
    },
  });
  if (!day?.campaign) throw new CampaignDomainError('not-found', 'Campaign day does not exist.');
  if (!campaignAllowsChanges(day.campaign.status)) throw new CampaignDomainError('campaign-closed', `The campaign is ${day.campaign.status}.`);
  // Approval belongs to the version that represents the day: an older version
  // opened from history can never be reviewed into the day's approval.
  if (day.activePosterVersionId !== versionId || !day.activePosterVersion) {
    throw new CampaignDomainError('conflict', 'That poster is no longer the active one for this day. Refresh and review again.');
  }
  return day;
}

/**
 * Sends the day's active poster back, with a reason.
 *
 * Nothing is deleted: the version, its Drive files and every earlier version
 * stay exactly as they are, and the day keeps this poster as its active one so
 * it can be edited or regenerated. An approved poster is withdrawn first
 * (APPROVED → PENDING → REJECTED), because Phase 1 allows no direct move.
 */
export async function rejectCampaignDayPoster(db: CampaignDb, dayId: string, versionId: string, input: RejectionInput): Promise<{ note: string }> {
  const note = buildRejectionNote(input);
  if (!note.ok) throw new CampaignDomainError('invalid-input', note.error);

  return runInCampaignTransaction(db, async (tx) => {
    const day = await loadActiveForReview(tx, dayId, versionId);
    const current = day.activePosterVersion!.approvalStatus;
    if (current === 'REJECTED') throw new CampaignDomainError('invalid-transition', 'This poster is already rejected.');
    if (current === 'APPROVED') await reviewPosterVersion(tx, versionId, 'PENDING');
    await reviewPosterVersion(tx, versionId, 'REJECTED', note.note);
    return { note: note.note };
  });
}

export interface BulkApprovalResult extends BulkApprovalPlan {
  approved: number[];
  /** Days that were eligible when planned but changed before the write. */
  conflicts: number[];
}

/**
 * Approves the active poster of every selected day that may be approved, and
 * reports the rest by reason. Each day is re-checked at the moment it is
 * written, so a day that changed meanwhile is reported rather than approved.
 */
export async function approveCampaignDayPosters(db: CampaignDb, campaignId: string, dayIds: readonly string[], options: PosterLoadOptions = {}): Promise<BulkApprovalResult> {
  const overview = await loadPosterOverview(db, campaignId, options);
  if (!campaignAllowsChanges(overview.campaign.status)) {
    throw new CampaignDomainError('campaign-closed', `The campaign is ${overview.campaign.status}.`);
  }
  const known = new Set(overview.days.map((day) => day.id));
  const unknown = dayIds.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new CampaignDomainError('not-found', 'Some of those days are not part of this campaign.');

  const plan = planBulkApproval(overview.days.map(toReviewRow), dayIds, overview.campaign.status);
  const approved: number[] = [];
  const conflicts: number[] = [];

  for (const entry of plan.approve) {
    try {
      // Phase 4's own approval, so one rule decides every approval.
      await approveCampaignDayPoster(db, entry.dayId, entry.versionId);
      approved.push(entry.dayNumber);
    } catch (error) {
      if (error instanceof CampaignDomainError) {
        conflicts.push(entry.dayNumber);
        continue;
      }
      throw error;
    }
  }

  return { ...plan, approved, conflicts };
}
