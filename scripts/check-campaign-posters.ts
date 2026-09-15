/**
 * Fixture suite for rolling campaign poster generation (src/lib/campaign/poster-generation.ts).
 *
 * Pure: no database, no network, no provider. The database-backed half is
 * `check-campaign-posters-db.ts`.
 *
 * Run: npm run check:campaign-posters
 */
import {
  brandCanvasReadiness,
  buildCampaignPosterBrief,
  derivePosterState,
  evaluatePosterEligibility,
  generationWindow,
  isGenerationInProgress,
  isInWindow,
  STALE_GENERATION_MS,
  studioAspectFor,
  summarizePosterWindow,
  type PosterEligibilityInput,
} from '@/lib/campaign/poster-generation';
import { dayMappingState, type MappingTarget, type MappingTemplate } from '@/lib/campaign/template-mapping';
import { MAX_STUDIO_PROMPT_LENGTH } from '@/lib/poster-studio/limits';
import { addZonedDays } from '@/lib/time';

let bad = 0;
const t = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) bad += 1;
};
const section = (title: string) => console.log(`\n--- ${title} ${'-'.repeat(Math.max(0, 58 - title.length))}`);

const TZ = 'Asia/Kolkata';
const NOW = new Date('2026-11-10T15:30:00+05:30');
const WINDOW = generationWindow(NOW, 14, TZ);
const dayAt = (offset: number) => addZonedDays(WINDOW.start, offset, TZ);

const target: MappingTarget = { categoryId: 'v', mode: 'AUTO', aspect: 9 / 16, aspectLabel: '9:16' };
const tpl = (overrides: Partial<MappingTemplate> = {}): MappingTemplate => ({ id: 't', label: 'T', categoryId: 'v', isActive: true, approved: true, aspect: 9 / 16, contentTypes: [], ...overrides });
const mapped = (template: MappingTemplate | null, source: 'AUTO' | 'MANUAL' = 'AUTO', contentType = 'educational') =>
  dayMappingState(
    { id: 'd', dayNumber: 1, contentType, posterTemplateId: source === 'MANUAL' && template ? template.id : null, suggestedTemplateId: source === 'AUTO' && template ? template.id : null },
    new Map(template ? [[template.id, template]] : []),
    target,
  );

const base = (overrides: Partial<PosterEligibilityInput> = {}): PosterEligibilityInput => ({
  mode: 'upcoming',
  explicit: false,
  now: NOW,
  window: WINDOW,
  campaignStatus: 'ACTIVE',
  scheduledDate: dayAt(2),
  contentStatus: 'READY',
  mapping: mapped(tpl()),
  unmappedReason: null,
  studioAspect: '9:16',
  targetAspectLabel: '9:16',
  brandCanvas: { available: true, reason: null },
  generationStatus: 'NOT_REQUESTED',
  generationStartedAt: null,
  dayRevision: 3,
  activeVersion: null,
  ...overrides,
});
const reasonOf = (input: PosterEligibilityInput) => {
  const result = evaluatePosterEligibility(input);
  return result.eligible ? `eligible:${result.action}` : result.reason;
};

// ===========================================================================
section('rolling window');
// ===========================================================================
t('window starts at local midnight today', WINDOW.start.toISOString() === new Date('2026-11-10T00:00:00+05:30').toISOString(), WINDOW.start.toISOString());
t('window covers exactly 14 local days', WINDOW.end.toISOString() === new Date('2026-11-24T00:00:00+05:30').toISOString());
t('today is inside the window', isInWindow(dayAt(0), WINDOW));
t('day 14 (offset 13) is inside, offset 14 is outside', isInWindow(dayAt(13), WINDOW) && !isInWindow(dayAt(14), WINDOW));
t('yesterday is outside the window', !isInWindow(dayAt(-1), WINDOW));
t('a configurable window: 7 days', generationWindow(NOW, 7, TZ).end.toISOString() === dayAt(7).toISOString());

// ===========================================================================
section('formats, claims and Brand Canvas');
// ===========================================================================
t('9:16, 1:1 and 16:9 outputs map to Poster Studio formats', studioAspectFor(1080 / 1920) === '9:16' && studioAspectFor(1) === '1:1' && studioAspectFor(1920 / 1080) === '16:9');
t('4:5 and 3:4 outputs are unsupported', studioAspectFor(0.8) === null && studioAspectFor(0.75) === null && studioAspectFor(0) === null);
t('QUEUED and a fresh GENERATING claim are in progress', isGenerationInProgress('QUEUED', null, NOW) && isGenerationInProgress('GENERATING', new Date(NOW.getTime() - 60_000), NOW));
t('a GENERATING claim older than the stale limit is not', !isGenerationInProgress('GENERATING', new Date(NOW.getTime() - STALE_GENERATION_MS - 1), NOW) && !isGenerationInProgress('GENERATING', null, NOW));
t('SUCCEEDED / FAILED are not in progress', !isGenerationInProgress('SUCCEEDED', NOW, NOW) && !isGenerationInProgress('FAILED', NOW, NOW));
t('Brand Canvas without extracted colours is unavailable, with the reason', !brandCanvasReadiness({ companyName: 'Clinic', brandColorCount: 0 }).available && /brand colours/.test(brandCanvasReadiness({ companyName: 'Clinic', brandColorCount: 0 }).reason ?? ''));
t('Brand Canvas with colours is available', brandCanvasReadiness({ companyName: 'Clinic', brandColorCount: 3 }).available);

// ===========================================================================
section('eligibility');
// ===========================================================================
t('a ready, mapped day in the window is eligible to generate', reasonOf(base()) === 'eligible:generate');
t('campaign DRAFT → not active', reasonOf(base({ campaignStatus: 'DRAFT' })) === 'campaign-not-active');
t('campaign PAUSED → not active', reasonOf(base({ campaignStatus: 'PAUSED' })) === 'campaign-not-active');
t('campaign CANCELLED → closed', reasonOf(base({ campaignStatus: 'CANCELLED' })) === 'campaign-closed');
t('outside the window → skipped by a batch', reasonOf(base({ scheduledDate: dayAt(20) })) === 'outside-window');
t('…but an explicit request for that day is allowed', reasonOf(base({ scheduledDate: dayAt(20), explicit: true })) === 'eligible:generate');
t('a past day is refused even when explicit', reasonOf(base({ scheduledDate: dayAt(-1), explicit: true })) === 'in-the-past');
t('content not generated → not ready', reasonOf(base({ contentStatus: 'NOT_GENERATED' })) === 'content-not-generated');
t('content needing review → not ready', reasonOf(base({ contentStatus: 'NEEDS_REVIEW' })) === 'content-needs-review');
{
  const none = evaluatePosterEligibility(base({ mapping: mapped(null), unmappedReason: { code: 'no-compatible-template', severity: 'action', title: 'No compatible template', detail: 'No template draws 9:16 posters.' } }));
  t('no template mapped → needs attention, with the Phase 3 reason', !none.eligible && none.reason === 'no-template' && none.attention && /draws 9:16/.test(none.message));
}
t('inactive template → template-inactive (attention)', reasonOf(base({ mapping: mapped(tpl({ isActive: false })) })) === 'template-inactive');
t('unapproved template → template-unapproved', reasonOf(base({ mapping: mapped(tpl({ approved: false })) })) === 'template-unapproved');
t('template from another vertical → unavailable', reasonOf(base({ mapping: mapped(tpl({ categoryId: 'other' })) })) === 'template-unavailable');
t('AUTO mapping of the wrong shape → incompatible', reasonOf(base({ mapping: mapped(tpl({ aspect: 1 })) })) === 'template-incompatible');
t('MANUAL choice of another shape is a deliberate warning → eligible', reasonOf(base({ mapping: mapped(tpl({ aspect: 1 }), 'MANUAL') })) === 'eligible:generate');
t('unsupported client format → attention', reasonOf(base({ studioAspect: null, targetAspectLabel: '4:5' })) === 'unsupported-aspect');
t('Brand Canvas unavailable → attention', reasonOf(base({ brandCanvas: { available: false, reason: 'no colours' } })) === 'brand-canvas-unavailable');
t('a live generation → skipped as generating', reasonOf(base({ generationStatus: 'GENERATING', generationStartedAt: new Date(NOW.getTime() - 30_000) })) === 'generating');
t('a stale GENERATING claim → eligible again', reasonOf(base({ generationStatus: 'GENERATING', generationStartedAt: new Date(NOW.getTime() - STALE_GENERATION_MS - 5_000) })) === 'eligible:generate');
{
  const retry = evaluatePosterEligibility(base({ generationStatus: 'FAILED' }));
  t('a failed day is eligible as a retry', retry.eligible && retry.retry);
}
const current = { contentRevision: 3 };
const outdated = { contentRevision: 2 };
t('missing: a current poster → already generated', reasonOf(base({ mode: 'missing', activeVersion: current })) === 'already-generated');
t('missing: an outdated poster is not silently regenerated', reasonOf(base({ mode: 'missing', activeVersion: outdated })) === 'outdated');
t('upcoming: a current poster → already generated (no second active version)', reasonOf(base({ activeVersion: current })) === 'already-generated');
t('upcoming: an outdated poster → regenerate', reasonOf(base({ activeVersion: outdated })) === 'eligible:regenerate');
t('regenerate: a current poster → regenerate (explicit)', reasonOf(base({ mode: 'regenerate', explicit: true, activeVersion: current })) === 'eligible:regenerate');
t('a generated day is reported generated even if its template is now inactive', reasonOf(base({ mode: 'missing', activeVersion: current, mapping: mapped(tpl({ isActive: false })) })) === 'already-generated');
t('regenerating with an inactive template is refused (never silently remapped)', reasonOf(base({ mode: 'regenerate', explicit: true, activeVersion: outdated, mapping: mapped(tpl({ isActive: false })) })) === 'template-inactive');

// ===========================================================================
section('poster state');
// ===========================================================================
const state = (overrides: Partial<Parameters<typeof derivePosterState>[0]>) =>
  derivePosterState({ generating: false, lastAttemptFailed: false, dayRevision: 3, activeVersion: null, attention: false, ...overrides });
t('nothing yet → Not generated', state({}) === 'not-generated');
t('generating → Generating', state({ generating: true, activeVersion: { contentRevision: 3, approvalStatus: 'APPROVED' } }) === 'generating');
t('failed with no poster → Failed', state({ lastAttemptFailed: true }) === 'failed');
t('blocked with no poster → Needs attention', state({ attention: true }) === 'needs-attention');
t('current pending → Needs approval', state({ activeVersion: { contentRevision: 3, approvalStatus: 'PENDING' } }) === 'needs-approval');
t('current approved → Approved', state({ activeVersion: { contentRevision: 3, approvalStatus: 'APPROVED' } }) === 'approved');
t('current rejected → Rejected', state({ activeVersion: { contentRevision: 3, approvalStatus: 'REJECTED' } }) === 'rejected');
t('content changed after the poster → Outdated', state({ activeVersion: { contentRevision: 2, approvalStatus: 'APPROVED' } }) === 'outdated');
t('a failed regeneration never hides the existing poster', state({ lastAttemptFailed: true, activeVersion: { contentRevision: 3, approvalStatus: 'PENDING' } }) === 'needs-approval');
{
  const summary = summarizePosterWindow([
    { state: 'approved', unmapped: false },
    { state: 'needs-approval', unmapped: false },
    { state: 'needs-approval', unmapped: false },
    { state: 'outdated', unmapped: false },
    { state: 'failed', unmapped: false },
    { state: 'needs-attention', unmapped: true },
    { state: 'not-generated', unmapped: false },
  ]);
  t('window summary counts each state', summary.days === 7 && summary.generated === 3 && summary.needsApproval === 2 && summary.approved === 1 && summary.outdated === 1 && summary.failed === 1 && summary.needsAttention === 1 && summary.unmapped === 1 && summary.notGenerated === 1, JSON.stringify(summary));
}

// ===========================================================================
section('brief');
// ===========================================================================
{
  const brief = buildCampaignPosterBrief({
    theme: 'Gum health basics',
    contentTypeLabel: 'Myth vs fact',
    headline: '5 Signs You Shouldn’t Ignore',
    supportingText: 'Bleeding gums are  not normal.',
    cta: 'Book a check-up',
    imagePrompt: 'A calm clinic scene, subject right.',
  });
  t('brief carries the headline, supporting text and CTA as exact wording', brief.includes('Headline: "5 Signs You Shouldn’t Ignore"') && brief.includes('Supporting text: "Bleeding gums are not normal."') && brief.includes('Call to action: "Book a check-up"'));
  t('brief carries the content type, topic and visual direction', brief.includes('Content type: Myth vs fact') && brief.includes('Topic: Gum health basics') && brief.includes('Visual direction: A calm clinic scene'));
  t('brief names no identifier, Drive id, phone or URL', !/[0-9a-f]{8}-[0-9a-f]{4}|drive|https?:|\+?\d{10}/i.test(brief), brief);
  const long = buildCampaignPosterBrief({ theme: null, contentTypeLabel: null, headline: 'H', supportingText: 'x'.repeat(5000), cta: null, imagePrompt: '' });
  t('brief never exceeds the studio prompt limit', long.length <= MAX_STUDIO_PROMPT_LENGTH);
  const empty = buildCampaignPosterBrief({ theme: null, contentTypeLabel: null, headline: null, supportingText: null, cta: null, imagePrompt: '' });
  t('empty content leaves out the wording rule', !empty.includes('Use exactly'));
}

console.log(`\n${bad === 0 ? 'All campaign poster checks passed.' : `${bad} check(s) FAILED.`}`);
process.exit(bad === 0 ? 0 : 1);
