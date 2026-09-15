/**
 * Fixture suite for the campaign automation rules (src/lib/campaign/model.ts).
 *
 * Pure: no database, no network, no provider. The database-backed half of the
 * foundation is `check-campaign-db.ts`.
 *
 * Run: npm run check:campaign
 */
import type { CampaignStatus, PosterApprovalStatus } from '@prisma/client';

import {
  CAMPAIGN_TRANSITIONS,
  campaignAllowsDelivery,
  campaignAllowsGeneration,
  canTransitionApproval,
  canTransitionCampaign,
  canTransitionGeneration,
  changedContentFields,
  effectiveTemplateId,
  evaluateDeliveryReadiness,
  initialApprovalStatus,
  isCampaignContentType,
  isVersionCurrent,
  planCampaignSlots,
  shouldAutoActivate,
  templateAspectRatio,
  templateAssignmentProblem,
  templateSuitsContentType,
  touchesPosterInputs,
  type CampaignDayContent,
} from '@/lib/campaign/model';
import { nthDeliveryDate } from '@/lib/time';

let bad = 0;
const t = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) bad += 1;
};

const TZ = 'Asia/Kolkata';

// ===========================================================================
console.log('\n--- campaign status ------------------------------------------');
// ===========================================================================

t('DRAFT → ACTIVE', canTransitionCampaign('DRAFT', 'ACTIVE'));
t('ACTIVE → PAUSED → ACTIVE', canTransitionCampaign('ACTIVE', 'PAUSED') && canTransitionCampaign('PAUSED', 'ACTIVE'));
t('DRAFT cannot jump to COMPLETED', !canTransitionCampaign('DRAFT', 'COMPLETED'));
t('PAUSED cannot complete without resuming', !canTransitionCampaign('PAUSED', 'COMPLETED'));
t(
  'COMPLETED and CANCELLED are terminal',
  CAMPAIGN_TRANSITIONS.COMPLETED.length === 0 && CAMPAIGN_TRANSITIONS.CANCELLED.length === 0,
);
{
  const statuses: CampaignStatus[] = ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'];
  t('no status transitions to itself', statuses.every((s) => !canTransitionCampaign(s, s)));
  t('only ACTIVE delivers', statuses.filter(campaignAllowsDelivery).join() === 'ACTIVE');
  t('DRAFT and ACTIVE may generate', statuses.filter(campaignAllowsGeneration).join() === 'DRAFT,ACTIVE');
}

// ===========================================================================
console.log('\n--- generation and approval status ---------------------------');
// ===========================================================================

t('NOT_REQUESTED → QUEUED → GENERATING → SUCCEEDED', canTransitionGeneration('NOT_REQUESTED', 'QUEUED') && canTransitionGeneration('QUEUED', 'GENERATING') && canTransitionGeneration('GENERATING', 'SUCCEEDED'));
t('a failed attempt is retried through QUEUED', canTransitionGeneration('FAILED', 'QUEUED') && !canTransitionGeneration('FAILED', 'GENERATING'));
t('regenerating a success goes through QUEUED', canTransitionGeneration('SUCCEEDED', 'QUEUED'));
t('an unclaimed request can be withdrawn', canTransitionGeneration('QUEUED', 'NOT_REQUESTED'));
t('an attempt cannot be skipped to SUCCEEDED', !canTransitionGeneration('QUEUED', 'SUCCEEDED'));

t('PENDING → APPROVED / REJECTED', canTransitionApproval('PENDING', 'APPROVED') && canTransitionApproval('PENDING', 'REJECTED'));
t('an approval is withdrawn through PENDING', canTransitionApproval('APPROVED', 'PENDING') && !canTransitionApproval('APPROVED', 'REJECTED'));
t('a rejection is reconsidered through PENDING', canTransitionApproval('REJECTED', 'PENDING') && !canTransitionApproval('REJECTED', 'APPROVED'));
t('MANUAL_REVIEW starts PENDING', initialApprovalStatus('MANUAL_REVIEW') === 'PENDING');
t('AUTO_APPROVE starts APPROVED', initialApprovalStatus('AUTO_APPROVE') === 'APPROVED');

// ===========================================================================
console.log('\n--- content edits --------------------------------------------');
// ===========================================================================

const content: CampaignDayContent = {
  theme: 'Monsoon dental care',
  contentType: 'educational',
  headline: 'Keep smiling this monsoon',
  supportingText: 'Three habits for healthy gums.',
  cta: 'Book a check-up',
  imagePrompt: 'A family brushing teeth together',
  backgroundPrompt: null,
  caption: 'Healthy gums start at home.',
  hashtags: '#dental #monsoon',
};

{
  const changed = changedContentFields(content, { headline: 'Smile through the rain' });
  t('a headline change is detected', changed.join() === 'headline');
  t('a headline change touches poster inputs', touchesPosterInputs(changed));
}
{
  const changed = changedContentFields(content, { caption: 'Healthy gums begin at home.', hashtags: '#dentist' });
  t('caption + hashtags are detected', changed.length === 2);
  t('caption + hashtags do NOT touch poster inputs', !touchesPosterInputs(changed));
}
{
  const changed = changedContentFields(content, { headline: content.headline, cta: undefined });
  t('an unchanged value and an absent field are not changes', changed.length === 0);
}
t('content type catalogue accepts known keys', isCampaignContentType('festival') && !isCampaignContentType('Festival'));

// ===========================================================================
console.log('\n--- template mapping -----------------------------------------');
// ===========================================================================

t('AUTO: suggestion fills an unselected day', effectiveTemplateId('AUTO', { posterTemplateId: null, suggestedTemplateId: 'S' }) === 'S');
t('AUTO: selection overrides suggestion', effectiveTemplateId('AUTO', { posterTemplateId: 'A', suggestedTemplateId: 'S' }) === 'A');
t('MANUAL: suggestion is only a hint', effectiveTemplateId('MANUAL', { posterTemplateId: null, suggestedTemplateId: 'S' }) === null);
t('MANUAL: selection is used', effectiveTemplateId('MANUAL', { posterTemplateId: 'A', suggestedTemplateId: 'S' }) === 'A');
t('template from another vertical is refused', templateAssignmentProblem({ categoryId: 'x', isActive: true }, { categoryId: 'y' }) === 'wrong-vertical');
t('inactive template is refused', templateAssignmentProblem({ categoryId: 'x', isActive: false }, { categoryId: 'x' }) === 'inactive');
t('active same-vertical template is fine', templateAssignmentProblem({ categoryId: 'x', isActive: true }, { categoryId: 'x' }) === null);
t('empty contentTypes suits anything', templateSuitsContentType({ contentTypes: [] }, 'festival'));
t('tagged template suits only its types', templateSuitsContentType({ contentTypes: ['festival'] }, 'festival') && !templateSuitsContentType({ contentTypes: ['festival'] }, 'educational'));
t('aspect ratio 1080×1920 → 9:16', templateAspectRatio(1080, 1920) === '9:16', String(templateAspectRatio(1080, 1920)));
t('aspect ratio 1080×1350 → 4:5', templateAspectRatio(1080, 1350) === '4:5');
t('unmeasured template has no aspect', templateAspectRatio(null, 1920) === null);

// ===========================================================================
console.log('\n--- poster versions and delivery readiness -------------------');
// ===========================================================================

t('a version from the current revision is current', isVersionCurrent({ contentRevision: 3 }, { contentRevision: 3 }));
t('a version from an older revision is outdated', !isVersionCurrent({ contentRevision: 2 }, { contentRevision: 3 }));
t('first version auto-activates', shouldAutoActivate(1, null));
t('a newer-revision version replaces the active one', shouldAutoActivate(4, { contentRevision: 3 }));
t('a same-revision regeneration replaces the active one', shouldAutoActivate(3, { contentRevision: 3 }));
t('a late older-revision version does not displace a newer one', !shouldAutoActivate(2, { contentRevision: 3 }));

{
  const ready = (approvalStatus: PosterApprovalStatus, versionRevision = 2, campaignStatus: CampaignStatus = 'ACTIVE') =>
    evaluateDeliveryReadiness({
      campaignStatus,
      dayContentRevision: 2,
      activeVersion: { contentRevision: versionRevision, approvalStatus },
    });
  t('approved + current + ACTIVE is ready', ready('APPROVED') === 'ready');
  t('pending is awaiting approval', ready('PENDING') === 'awaiting-approval');
  t('rejected is not deliverable', ready('REJECTED') === 'poster-rejected');
  t('approved but outdated is not deliverable', ready('APPROVED', 1) === 'poster-outdated');
  t('paused campaign is not deliverable', ready('APPROVED', 2, 'PAUSED') === 'campaign-not-active');
  t(
    'a day without a poster is not deliverable',
    evaluateDeliveryReadiness({ campaignStatus: 'ACTIVE', dayContentRevision: 1, activeVersion: null }) === 'no-active-poster',
  );
}

// ===========================================================================
console.log('\n--- schedule -------------------------------------------------');
// ===========================================================================

{
  const start = new Date('2026-10-01T05:30:00Z');
  const slots = planCampaignSlots(start, 365, [], TZ);
  t('365 slots', slots.length === 365);
  t('day numbers are 1..365 in order', slots.every((slot, index) => slot.dayNumber === index + 1));
  t('dates strictly increase', slots.every((slot, index) => index === 0 || slot.scheduledDate > slots[index - 1]!.scheduledDate));
  const sample = [1, 2, 126, 127, 128, 365];
  t(
    'unrestricted dates match nthDeliveryDate',
    sample.every((n) => slots[n - 1]!.scheduledDate.getTime() === nthDeliveryDate(start, n, [], TZ).getTime()),
  );

  const weekdays = [1, 3, 5];
  const restricted = planCampaignSlots(start, 365, weekdays, TZ);
  t(
    'weekday-restricted dates match nthDeliveryDate',
    sample.every((n) => restricted[n - 1]!.scheduledDate.getTime() === nthDeliveryDate(start, n, weekdays, TZ).getTime()),
  );
}
{
  let threw = false;
  try {
    planCampaignSlots(new Date(), 0, [], TZ);
  } catch {
    threw = true;
  }
  t('zero-day campaign is refused', threw);
}

console.log(`\n${bad === 0 ? 'All campaign model checks passed.' : `${bad} check(s) FAILED.`}`);
process.exit(bad === 0 ? 0 : 1);
