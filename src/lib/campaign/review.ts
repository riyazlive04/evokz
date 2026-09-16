import type { CampaignApprovalPolicy, CampaignStatus, PosterApprovalStatus } from '@prisma/client';

import { evaluateDeliveryReadiness } from '@/lib/campaign/model';
import type { PosterState } from '@/lib/campaign/poster-generation';

/**
 * Campaign review and approval — the pure rules of Phase 5.
 *
 * What an operator may do to a day's poster, what a bulk approval would touch,
 * and how ready a campaign is. No database, no network: `review-service.ts`
 * applies these to rows and `npm run check:campaign-review` pins them.
 *
 * **No second approval system.** Approval stays where Phase 1 put it — on the
 * `PosterVersion` (`approvalStatus`, `reviewedAt`, `reviewNote`), moved only by
 * `reviewPosterVersion` along `APPROVAL_TRANSITIONS`, and read for delivery by
 * `evaluateDeliveryReadiness`. Phase 4's `derivePosterState` stays the single
 * derivation of a day's poster state; this module groups those states into the
 * operator's work queue and decides which actions are offered.
 */

// ---------------------------------------------------------------------------
// Rejection reasons
// ---------------------------------------------------------------------------

/**
 * Why a poster was sent back. Kept as a short catalogue so the queue can be
 * scanned, with free text for the detail. Stored in `PosterVersion.reviewNote`;
 * no new column.
 */
export const REJECTION_REASONS = [
  { key: 'wrong-layout', label: 'Wrong layout' },
  { key: 'content-issue', label: 'Content issue' },
  { key: 'branding-issue', label: 'Branding issue' },
  { key: 'image-quality', label: 'Image quality' },
  { key: 'template-mismatch', label: 'Template mismatch' },
  { key: 'other', label: 'Other' },
] as const;

export type RejectionReasonKey = (typeof REJECTION_REASONS)[number]['key'];

export const MAX_REJECTION_DETAIL = 500;

export function isRejectionReason(value: string): value is RejectionReasonKey {
  return REJECTION_REASONS.some((reason) => reason.key === value);
}

export function rejectionReasonLabel(key: RejectionReasonKey): string {
  return REJECTION_REASONS.find((reason) => reason.key === key)!.label;
}

export type RejectionInput = { reason: string; detail?: string | null };

export type RejectionNote = { ok: true; note: string } | { ok: false; error: string };

/**
 * The note stored on the rejected version: `"Wrong layout — the headline sits
 * over the logo"`. "Other" carries no information on its own, so it must say
 * what is wrong.
 */
export function buildRejectionNote(input: RejectionInput): RejectionNote {
  const reason = input.reason.trim();
  if (!isRejectionReason(reason)) return { ok: false, error: 'Choose a reason for sending this poster back.' };

  const detail = (input.detail ?? '').replace(/\s+/g, ' ').trim();
  if (detail.length > MAX_REJECTION_DETAIL) {
    return { ok: false, error: `Keep the note under ${MAX_REJECTION_DETAIL} characters.` };
  }
  if (reason === 'other' && detail.length < 3) {
    return { ok: false, error: 'Say what is wrong when the reason is "Other".' };
  }
  return { ok: true, note: detail ? `${rejectionReasonLabel(reason)} — ${detail}` : rejectionReasonLabel(reason) };
}

/** The stored note split back into its reason and detail, for display. */
export function parseRejectionNote(note: string | null): { label: string; detail: string | null } | null {
  if (!note?.trim()) return null;
  const [head, ...rest] = note.split(' — ');
  const label = head!.trim();
  const detail = rest.join(' — ').trim();
  return REJECTION_REASONS.some((reason) => reason.label === label)
    ? { label, detail: detail || null }
    : { label: 'Rejected', detail: note.trim() };
}

// ---------------------------------------------------------------------------
// The review queue
// ---------------------------------------------------------------------------

/** One campaign day, as the review queue sees it. */
export interface ReviewRow {
  dayId: string;
  dayNumber: number;
  state: PosterState;
  /** No effective template (Phase 3). */
  unmapped: boolean;
  /** Inside the rolling generation window (Phase 4). */
  inWindow: boolean;
  contentReady: boolean;
  /** The day's current content revision, for Phase 1's delivery check. */
  dayContentRevision: number;
  /** The version that represents the day, if any. Approval belongs to it. */
  activeVersion: { id: string; contentRevision: number; approvalStatus: PosterApprovalStatus } | null;
}

/**
 * The queue's buckets. `all` shows everything; the rest are the filters the
 * counts link to.
 */
export const REVIEW_FILTERS = ['all', 'needs-review', 'approved', 'rejected', 'outdated', 'failed', 'unmapped', 'attention'] as const;
export type ReviewFilter = (typeof REVIEW_FILTERS)[number];

export const REVIEW_FILTER_LABELS: Record<ReviewFilter, string> = {
  all: 'All',
  'needs-review': 'Needs review',
  approved: 'Approved',
  rejected: 'Rejected',
  outdated: 'Outdated',
  failed: 'Failed',
  unmapped: 'Unmapped',
  attention: 'Needs attention',
};

export function isReviewFilter(value: string): value is ReviewFilter {
  return (REVIEW_FILTERS as readonly string[]).includes(value);
}

/** Narrow on purpose: the queue's client component filters view rows with the same rule. */
export type FilterableRow = Pick<ReviewRow, 'state' | 'unmapped' | 'inWindow'>;

export function matchesFilter(row: FilterableRow, filter: ReviewFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'needs-review':
      return row.state === 'needs-approval';
    case 'approved':
      return row.state === 'approved';
    case 'rejected':
      return row.state === 'rejected';
    case 'outdated':
      return row.state === 'outdated';
    case 'failed':
      return row.state === 'failed';
    case 'unmapped':
      return row.unmapped;
    case 'attention':
      return needsAttention(row);
  }
}

/** Unresolved work: anything an operator must act on before these days could ever be delivered. */
export function needsAttention(row: FilterableRow): boolean {
  return (
    row.state === 'rejected' ||
    row.state === 'outdated' ||
    row.state === 'failed' ||
    row.state === 'needs-attention' ||
    (row.unmapped && row.inWindow)
  );
}

export interface ReviewSummary {
  total: number;
  needsReview: number;
  approved: number;
  rejected: number;
  outdated: number;
  failed: number;
  unmapped: number;
  notGenerated: number;
  generating: number;
  /** Days with something to fix — the dashboard's "Needs attention". */
  attention: number;
}

export function summarizeReview(rows: readonly ReviewRow[]): ReviewSummary {
  const summary: ReviewSummary = { total: rows.length, needsReview: 0, approved: 0, rejected: 0, outdated: 0, failed: 0, unmapped: 0, notGenerated: 0, generating: 0, attention: 0 };
  for (const row of rows) {
    if (row.state === 'needs-approval') summary.needsReview += 1;
    if (row.state === 'approved') summary.approved += 1;
    if (row.state === 'rejected') summary.rejected += 1;
    if (row.state === 'outdated') summary.outdated += 1;
    if (row.state === 'failed') summary.failed += 1;
    if (row.state === 'not-generated' || row.state === 'needs-attention') summary.notGenerated += 1;
    if (row.state === 'generating') summary.generating += 1;
    if (row.unmapped) summary.unmapped += 1;
    if (needsAttention(row)) summary.attention += 1;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// What may be approved
// ---------------------------------------------------------------------------

export type ApprovalRefusal =
  | 'campaign-closed'
  | 'already-approved'
  | 'rejected'
  | 'outdated'
  | 'generating'
  | 'no-poster';

export const APPROVAL_REFUSAL_MESSAGES: Record<ApprovalRefusal, string> = {
  'campaign-closed': 'The campaign is closed.',
  'already-approved': 'Already approved.',
  rejected: 'Rejected — edit or regenerate it before approving.',
  outdated: 'Outdated — regenerate it before approving.',
  generating: 'A poster is being generated for this day.',
  'no-poster': 'No poster to approve yet.',
};

/**
 * Whether the day's **active** poster may be approved now, or why not.
 *
 * Only a current, pending, active version qualifies: an outdated or rejected
 * poster is never approved, and an older version is never approved through the
 * queue — approval belongs to the version that represents the day.
 */
export function approvalRefusal(row: Pick<ReviewRow, 'state'>, campaignStatus: CampaignStatus): ApprovalRefusal | null {
  if (campaignStatus === 'COMPLETED' || campaignStatus === 'CANCELLED') return 'campaign-closed';
  switch (row.state) {
    case 'needs-approval':
      return null;
    case 'approved':
      return 'already-approved';
    case 'rejected':
      return 'rejected';
    case 'outdated':
      return 'outdated';
    case 'generating':
      return 'generating';
    default:
      return 'no-poster';
  }
}

export function canApprove(row: Pick<ReviewRow, 'state'>, campaignStatus: CampaignStatus): boolean {
  return approvalRefusal(row, campaignStatus) === null;
}

/**
 * Whether the day's active poster may be sent back.
 *
 * Anything a person can still see as the day's poster can be rejected — a
 * pending one, an approved one (its approval is withdrawn first) and an
 * outdated one, so the reason is recorded where the operator noticed it. A
 * poster that is already rejected, still generating or does not exist cannot.
 */
export function canReject(row: Pick<ReviewRow, 'state' | 'activeVersion'>, campaignStatus: CampaignStatus): boolean {
  if (campaignStatus === 'COMPLETED' || campaignStatus === 'CANCELLED') return false;
  if (!row.activeVersion) return false;
  return row.state === 'needs-approval' || row.state === 'approved' || row.state === 'outdated';
}

// ---------------------------------------------------------------------------
// Bulk approval
// ---------------------------------------------------------------------------

export interface BulkApprovalPlan {
  selected: number;
  /** Days whose active poster will be approved, in day order. */
  approve: Array<{ dayId: string; dayNumber: number; versionId: string }>;
  /** Everything else, grouped by why it was left out. */
  skipped: Array<{ reason: ApprovalRefusal; message: string; dayNumbers: number[] }>;
  skippedCount: number;
}

/**
 * What "Approve selected" would do. Outdated, rejected, failed, generating,
 * missing and unmapped days are never approved in bulk — they are reported,
 * so nothing invalid is approved silently.
 */
export function planBulkApproval(
  rows: readonly ReviewRow[],
  selectedDayIds: readonly string[],
  campaignStatus: CampaignStatus,
): BulkApprovalPlan {
  const selected = new Set(selectedDayIds);
  const plan: BulkApprovalPlan = { selected: selected.size, approve: [], skipped: [], skippedCount: 0 };
  const groups = new Map<ApprovalRefusal, { reason: ApprovalRefusal; message: string; dayNumbers: number[] }>();

  for (const row of [...rows].sort((a, b) => a.dayNumber - b.dayNumber)) {
    if (!selected.has(row.dayId)) continue;
    const refusal = approvalRefusal(row, campaignStatus);
    if (refusal === null && row.activeVersion) {
      plan.approve.push({ dayId: row.dayId, dayNumber: row.dayNumber, versionId: row.activeVersion.id });
      continue;
    }
    const reason = refusal ?? 'no-poster';
    const group = groups.get(reason) ?? { reason, message: APPROVAL_REFUSAL_MESSAGES[reason], dayNumbers: [] };
    group.dayNumbers.push(row.dayNumber);
    groups.set(reason, group);
  }

  plan.skipped = [...groups.values()];
  plan.skippedCount = plan.skipped.reduce((sum, group) => sum + group.dayNumbers.length, 0);
  return plan;
}

// ---------------------------------------------------------------------------
// Campaign readiness
// ---------------------------------------------------------------------------

export interface ReadinessCount {
  done: number;
  total: number;
}

export interface CampaignReadiness {
  /** Across the whole campaign. */
  content: ReadinessCount;
  templates: ReadinessCount;
  /** Across the rolling generation window, which is all that is generated yet. */
  posters: ReadinessCount;
  approved: ReadinessCount;
  attention: number;
  /**
   * Days that would pass Phase 1's `evaluateDeliveryReadiness` — active,
   * current and approved, in an ACTIVE campaign. Phase 6 will deliver these;
   * nothing here sends anything.
   */
  deliveryReady: number;
  /** Every window day is delivery-ready and nothing needs attention. */
  windowReady: boolean;
  /** Why not, for the operator. */
  blockers: string[];
}

/**
 * A deterministic readiness summary.
 *
 * Deliberately scoped: content and templates are counted across the campaign,
 * posters and approvals across the rolling window, because only the window is
 * ever generated. `windowReady` is the honest claim — the next N days are
 * approved and nothing is unresolved — and it is false whenever anything is.
 */
export function campaignReadiness(input: {
  rows: readonly ReviewRow[];
  campaignStatus: CampaignStatus;
  /** Phase 1's policy. It decides whether generated posters arrive PENDING or APPROVED, not what counts as ready. */
  approvalPolicy: CampaignApprovalPolicy;
}): CampaignReadiness {
  const windowRows = input.rows.filter((row) => row.inWindow);
  const readiness: CampaignReadiness = {
    content: { done: input.rows.filter((row) => row.contentReady).length, total: input.rows.length },
    templates: { done: input.rows.filter((row) => !row.unmapped).length, total: input.rows.length },
    // A poster exists for the day, whatever its review state.
    posters: { done: windowRows.filter((row) => row.activeVersion !== null).length, total: windowRows.length },
    approved: { done: windowRows.filter((row) => row.state === 'approved').length, total: windowRows.length },
    attention: input.rows.filter((row) => needsAttention(row)).length,
    // Phase 1's own rule, on the real revisions: active, current and approved.
    deliveryReady: windowRows.filter(
      (row) =>
        evaluateDeliveryReadiness({
          campaignStatus: input.campaignStatus,
          dayContentRevision: row.dayContentRevision,
          activeVersion: row.activeVersion,
        }) === 'ready',
    ).length,
    windowReady: false,
    blockers: [],
  };

  const windowSummary = summarizeReview(windowRows);
  const blockers: string[] = [];
  if (input.campaignStatus !== 'ACTIVE') blockers.push(`the campaign is ${input.campaignStatus.toLowerCase()}`);
  if (windowSummary.needsReview > 0) blockers.push(`${windowSummary.needsReview} poster(s) need review`);
  if (windowSummary.rejected > 0) blockers.push(`${windowSummary.rejected} rejected`);
  if (windowSummary.outdated > 0) blockers.push(`${windowSummary.outdated} outdated`);
  if (windowSummary.failed > 0) blockers.push(`${windowSummary.failed} failed`);
  if (windowSummary.notGenerated > 0) blockers.push(`${windowSummary.notGenerated} not generated`);
  if (windowSummary.generating > 0) blockers.push(`${windowSummary.generating} still generating`);
  if (windowSummary.unmapped > 0) blockers.push(`${windowSummary.unmapped} day(s) with no template`);

  readiness.blockers = blockers;
  readiness.windowReady = windowRows.length > 0 && blockers.length === 0;
  return readiness;
}

/** "Ready for the next 14 days" / what is missing. Never claims more than the window. */
export function describeReadiness(readiness: CampaignReadiness, windowDays: number): string {
  if (readiness.windowReady) {
    return `Ready for the next ${windowDays} days: ${readiness.approved.done} of ${readiness.approved.total} posters approved. Delivery is not implemented yet.`;
  }
  return readiness.blockers.length > 0
    ? `Not ready for the next ${windowDays} days — ${readiness.blockers.join(', ')}.`
    : `Not ready for the next ${windowDays} days.`;
}
