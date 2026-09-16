/**
 * Fixture suite for campaign review and approval (src/lib/campaign/review.ts).
 *
 * Pure: no database, no network, no provider. The database-backed half is
 * `check-campaign-review-db.ts`.
 *
 * Run: npm run check:campaign-review
 */
import type { CampaignStatus, PosterApprovalStatus } from '@prisma/client';

import type { PosterState } from '@/lib/campaign/poster-generation';
import {
  APPROVAL_REFUSAL_MESSAGES,
  approvalRefusal,
  buildRejectionNote,
  campaignReadiness,
  canApprove,
  canReject,
  describeReadiness,
  isRejectionReason,
  matchesFilter,
  MAX_REJECTION_DETAIL,
  needsAttention,
  parseRejectionNote,
  planBulkApproval,
  REJECTION_REASONS,
  REVIEW_FILTERS,
  summarizeReview,
  type ReviewFilter,
  type ReviewRow,
} from '@/lib/campaign/review';

let bad = 0;
const t = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) bad += 1;
};
const section = (title: string) => console.log(`\n--- ${title} ${'-'.repeat(Math.max(0, 58 - title.length))}`);

let counter = 0;
const row = (state: PosterState, overrides: Partial<ReviewRow> = {}): ReviewRow => {
  counter += 1;
  const approval: PosterApprovalStatus | null =
    state === 'approved' ? 'APPROVED' : state === 'rejected' ? 'REJECTED' : state === 'needs-approval' || state === 'outdated' ? 'PENDING' : null;
  return {
    dayId: `day-${counter}`,
    dayNumber: counter,
    state,
    unmapped: false,
    inWindow: true,
    contentReady: true,
    dayContentRevision: 3,
    activeVersion: approval ? { id: `v-${counter}`, contentRevision: state === 'outdated' ? 2 : 3, approvalStatus: approval } : null,
    ...overrides,
  };
};

// ===========================================================================
section('rejection reasons');
// ===========================================================================
t('the catalogue covers the brief’s reasons', REJECTION_REASONS.map((reason) => reason.label).join(', ') === 'Wrong layout, Content issue, Branding issue, Image quality, Template mismatch, Other');
t('a known reason is recognised; an unknown one is not', isRejectionReason('wrong-layout') && !isRejectionReason('nonsense'));
{
  const plain = buildRejectionNote({ reason: 'wrong-layout' });
  t('a reason alone is a valid note', plain.ok && plain.note === 'Wrong layout');
  const detailed = buildRejectionNote({ reason: 'branding-issue', detail: '  the logo   sits over the headline ' });
  t('a detail is appended and whitespace normalised', detailed.ok && detailed.note === 'Branding issue — the logo sits over the headline');
  t('an unknown reason is refused', !buildRejectionNote({ reason: '' }).ok && !buildRejectionNote({ reason: 'made-up' }).ok);
  t('"Other" without a detail is refused', !buildRejectionNote({ reason: 'other' }).ok);
  t('"Other" with a detail is accepted', buildRejectionNote({ reason: 'other', detail: 'client asked for a different photo' }).ok);
  t('an over-long detail is refused', !buildRejectionNote({ reason: 'other', detail: 'x'.repeat(MAX_REJECTION_DETAIL + 1) }).ok);
  const parsed = parseRejectionNote('Image quality — the photo is blurry');
  t('a stored note parses back into reason and detail', parsed?.label === 'Image quality' && parsed.detail === 'the photo is blurry');
  t('a note with no detail parses to the reason alone', parseRejectionNote('Wrong layout')?.detail === null);
  t('a free-text note still shows as a rejection', parseRejectionNote('anything else')?.label === 'Rejected');
  t('no note parses to null', parseRejectionNote(null) === null && parseRejectionNote('   ') === null);
}

// ===========================================================================
section('queue filters and counts');
// ===========================================================================
{
  const rows: ReviewRow[] = [
    row('needs-approval'),
    row('needs-approval'),
    row('approved'),
    row('rejected'),
    row('outdated'),
    row('failed'),
    row('generating'),
    row('not-generated', { unmapped: true }),
    row('needs-attention', { unmapped: true, inWindow: false }),
    row('not-generated', { contentReady: false, inWindow: false }),
  ];
  const of = (filter: ReviewFilter) => rows.filter((candidate) => matchesFilter(candidate, filter)).length;
  t('every filter has a name', REVIEW_FILTERS.length === 8);
  t('All shows everything', of('all') === rows.length);
  t('filters select their own state', of('needs-review') === 2 && of('approved') === 1 && of('rejected') === 1 && of('outdated') === 1 && of('failed') === 1);
  t('Unmapped selects days with no template', of('unmapped') === 2);
  t('Needs attention = rejected, outdated, failed, blocked, and unmapped inside the window', of('attention') === 5, String(of('attention')));
  t('an unmapped day outside the window is not attention by itself', !needsAttention(row('not-generated', { unmapped: true, inWindow: false })));

  const summary = summarizeReview(rows);
  t('counts match the queue', summary.total === 10 && summary.needsReview === 2 && summary.approved === 1 && summary.rejected === 1 && summary.outdated === 1 && summary.failed === 1 && summary.generating === 1 && summary.unmapped === 2 && summary.attention === 5, JSON.stringify(summary));
}

// ===========================================================================
section('what may be approved or rejected');
// ===========================================================================
{
  const active: CampaignStatus = 'ACTIVE';
  t('a pending, current poster may be approved', canApprove(row('needs-approval'), active));
  t('an approved poster is reported as already approved', approvalRefusal(row('approved'), active) === 'already-approved');
  t('a rejected poster cannot be approved', approvalRefusal(row('rejected'), active) === 'rejected' && /edit or regenerate/.test(APPROVAL_REFUSAL_MESSAGES.rejected));
  t('an outdated poster cannot be approved', approvalRefusal(row('outdated'), active) === 'outdated');
  t('a generating poster cannot be approved', approvalRefusal(row('generating'), active) === 'generating');
  t('a failed or missing poster cannot be approved', approvalRefusal(row('failed'), active) === 'no-poster' && approvalRefusal(row('not-generated'), active) === 'no-poster' && approvalRefusal(row('needs-attention'), active) === 'no-poster');
  t('a closed campaign approves nothing', approvalRefusal(row('needs-approval'), 'COMPLETED') === 'campaign-closed' && approvalRefusal(row('needs-approval'), 'CANCELLED') === 'campaign-closed');
  t('pending, approved and outdated posters may be rejected', canReject(row('needs-approval'), active) && canReject(row('approved'), active) && canReject(row('outdated'), active));
  t('an already rejected, generating or missing poster may not', !canReject(row('rejected'), active) && !canReject(row('generating'), active) && !canReject(row('not-generated'), active));
  t('a closed campaign rejects nothing', !canReject(row('needs-approval'), 'COMPLETED'));
}

// ===========================================================================
section('bulk approval');
// ===========================================================================
{
  const rows: ReviewRow[] = [row('needs-approval'), row('needs-approval'), row('needs-approval'), row('outdated'), row('rejected'), row('failed'), row('generating'), row('not-generated'), row('approved'), row('not-generated', { unmapped: true })];
  const plan = planBulkApproval(rows, rows.map((candidate) => candidate.dayId), 'ACTIVE');
  t('only pending, current posters are approved', plan.approve.length === 3 && plan.approve.every((entry) => entry.versionId.startsWith('v-')));
  t('selected, can approve and skipped add up', plan.selected === 10 && plan.approve.length + plan.skippedCount === 10, JSON.stringify({ selected: plan.selected, approve: plan.approve.length, skipped: plan.skippedCount }));
  const reasons = plan.skipped.map((group) => group.reason).sort().join(',');
  t('every skipped day is reported with its reason', reasons === 'already-approved,generating,no-poster,outdated,rejected', reasons);
  t('outdated, rejected, failed, generating, missing and unmapped are never bulk approved', plan.skipped.flatMap((group) => group.dayNumbers).length === 7);
  t('unselected days are untouched', planBulkApproval(rows, [rows[0]!.dayId], 'ACTIVE').selected === 1);
  t('approval order is day order', planBulkApproval(rows, rows.map((r) => r.dayId), 'ACTIVE').approve.map((entry) => entry.dayNumber).join() === plan.approve.map((entry) => entry.dayNumber).sort((a, b) => a - b).join());
  const closed = planBulkApproval(rows, rows.map((candidate) => candidate.dayId), 'CANCELLED');
  t('a closed campaign approves nothing in bulk', closed.approve.length === 0 && closed.skipped[0]?.reason === 'campaign-closed');
}

// ===========================================================================
section('campaign readiness');
// ===========================================================================
{
  const windowRows = [row('approved'), row('approved'), row('needs-approval'), row('outdated'), row('failed')];
  const futureRows = [row('not-generated', { inWindow: false }), row('not-generated', { inWindow: false, contentReady: false, unmapped: true })];
  const readiness = campaignReadiness({ rows: [...windowRows, ...futureRows], campaignStatus: 'ACTIVE', approvalPolicy: 'MANUAL_REVIEW' });
  t('content and templates are counted across the campaign', readiness.content.done === 6 && readiness.content.total === 7 && readiness.templates.done === 6 && readiness.templates.total === 7, JSON.stringify(readiness.content));
  t('posters and approvals are counted across the window', readiness.posters.done === 4 && readiness.posters.total === 5 && readiness.approved.done === 2 && readiness.approved.total === 5, JSON.stringify({ posters: readiness.posters, approved: readiness.approved }));
  t('delivery-ready counts only active, current, approved days', readiness.deliveryReady === 2);
  // The outdated and failed window days; the future unmapped day is not attention yet.
  t('attention counts unresolved work', readiness.attention === 2, String(readiness.attention));
  t('a campaign with unresolved days is not ready', !readiness.windowReady && readiness.blockers.length > 0, readiness.blockers.join(' · '));
  t('the description never claims more than the window', /Not ready for the next 14 days/.test(describeReadiness(readiness, 14)));

  const allApproved = campaignReadiness({ rows: [row('approved'), row('approved')], campaignStatus: 'ACTIVE', approvalPolicy: 'MANUAL_REVIEW' });
  t('a fully approved window is ready, and says delivery is not implemented', allApproved.windowReady && allApproved.deliveryReady === 2 && /Ready for the next 7 days/.test(describeReadiness(allApproved, 7)) && /not implemented/.test(describeReadiness(allApproved, 7)));
  const paused = campaignReadiness({ rows: [row('approved'), row('approved')], campaignStatus: 'PAUSED', approvalPolicy: 'MANUAL_REVIEW' });
  t('a paused campaign is never ready and delivers nothing', !paused.windowReady && paused.deliveryReady === 0 && paused.blockers[0] === 'the campaign is paused');
  const auto = campaignReadiness({ rows: [row('approved')], campaignStatus: 'ACTIVE', approvalPolicy: 'AUTO_APPROVE' });
  t('AUTO_APPROVE changes no readiness rule', auto.windowReady && auto.approved.done === 1);
  const empty = campaignReadiness({ rows: [row('approved', { inWindow: false })], campaignStatus: 'ACTIVE', approvalPolicy: 'MANUAL_REVIEW' });
  t('a window with no days is not called ready', !empty.windowReady);
}

console.log(`\n${bad === 0 ? 'All campaign review checks passed.' : `${bad} check(s) FAILED.`}`);
process.exit(bad === 0 ? 0 : 1);
