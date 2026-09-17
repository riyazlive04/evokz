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
  templateOutputSize,
  templateShapeOf,
  type PosterEligibilityInput,
} from '@/lib/campaign/poster-generation';
import { buildGeneratePrompt } from '@/lib/ai/studio-prompts';
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
const tpl = (overrides: Partial<MappingTemplate> = {}): MappingTemplate => ({ id: 't', label: 'T', categoryId: 'v', isActive: true, aspect: 9 / 16, ...overrides });
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
  mapping: mapped(tpl()),
  unmappedReason: null,
  template: { label: 'T', readable: true, width: 1080, height: 1920 },
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
t('a QUEUED day of a campaign that is not ACTIVE is not in progress (nothing will take it)', !isGenerationInProgress('QUEUED', null, NOW, 'PAUSED') && !isGenerationInProgress('QUEUED', null, NOW, 'DRAFT') && isGenerationInProgress('QUEUED', null, NOW, 'ACTIVE'));
t('…while a live GENERATING claim is in progress whatever the campaign status', isGenerationInProgress('GENERATING', new Date(NOW.getTime() - 60_000), NOW, 'PAUSED'));
t('Brand Canvas needs only a company name: no colours is available (template colours are kept)', brandCanvasReadiness({ companyName: 'Clinic' }).available && brandCanvasReadiness({ companyName: 'Clinic' }).reason === null);
t('Brand Canvas without a company name is unavailable, with the reason', !brandCanvasReadiness({ companyName: '  ' }).available && /company name/.test(brandCanvasReadiness({ companyName: '' }).reason ?? ''));
t('the clone size comes from the template shape, not the client preset', templateOutputSize({ width: 736, height: 920 })?.size === '1280x1600' && templateOutputSize(null) === null && templateOutputSize({ width: 100, height: 400 }) === null);
t('template shape: read elements and the read size when unmeasured', templateShapeOf({ label: 'L', width: null, height: null, elements: { version: 1, width: 736, height: 920, model: 'm', elements: [{ id: 'e1', kind: 'headline', text: 'H', box: { x: 0, y: 0, w: 0.5, h: 0.1 }, group: null, description: null }] } }).readable && templateShapeOf({ label: 'L', width: null, height: null, elements: { version: 1, width: 736, height: 920, model: 'm', elements: [] } }).width === 736 && !templateShapeOf({ label: 'L', width: 10, height: 10, elements: null }).readable);

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
{
  const none = evaluatePosterEligibility(base({ mapping: mapped(null), unmappedReason: { code: 'no-compatible-template', severity: 'action', title: 'No compatible template', detail: 'No template draws 9:16 posters.' } }));
  t('no template mapped → needs attention, with the Phase 3 reason', !none.eligible && none.reason === 'no-template' && none.attention && /draws 9:16/.test(none.message));
}
t('inactive template → template-inactive (attention)', reasonOf(base({ mapping: mapped(tpl({ isActive: false })) })) === 'template-inactive');
t('template from another vertical → unavailable', reasonOf(base({ mapping: mapped(tpl({ categoryId: 'other' })) })) === 'template-unavailable');
t('an AUTO mapping of another shape than the client output is eligible: a clone keeps its template shape', reasonOf(base({ mapping: mapped(tpl({ aspect: 1 })) })) === 'eligible:generate');
t('a MANUAL choice of another shape is eligible too', reasonOf(base({ mapping: mapped(tpl({ aspect: 1 }), 'MANUAL') })) === 'eligible:generate');
{
  const unread = evaluatePosterEligibility(base({ template: { label: 'T', readable: false, width: 1080, height: 1920 } }));
  t('a template not read yet → template-not-read (attention), with what to do', !unread.eligible && unread.reason === 'template-not-read' && unread.attention && unread.message === 'Template not read yet — open the vertical and press Read now.');
  const tooTall = evaluatePosterEligibility(base({ template: { label: 'Strip', readable: true, width: 300, height: 1200 } }));
  t('a template shape outside 1:3–3:1 → unsupported-aspect (attention), naming the template', !tooTall.eligible && tooTall.reason === 'unsupported-aspect' && tooTall.attention && /Strip/.test(tooTall.message) && /300×1200/.test(tooTall.message));
  t('an unmeasured template with a read size is eligible', reasonOf(base({ template: { label: 'T', readable: true, width: 736, height: 920 } })) === 'eligible:generate');
  t('a mapped template with no row → template-unavailable', reasonOf(base({ template: null })) === 'template-unavailable');
  t('4:5 and 2:3 templates are eligible whatever the client preset', reasonOf(base({ template: { label: '4:5', readable: true, width: 736, height: 920 } })) === 'eligible:generate' && reasonOf(base({ template: { label: '2:3', readable: true, width: 736, height: 1104 } })) === 'eligible:generate');
  t('a template not read is reported after a closed campaign or an existing poster', reasonOf(base({ campaignStatus: 'PAUSED', template: { label: 'T', readable: false, width: 1, height: 1 } })) === 'campaign-not-active' && reasonOf(base({ mode: 'missing', activeVersion: { contentRevision: 3 }, template: { label: 'T', readable: false, width: 1, height: 1 } })) === 'already-generated');
}
t('Brand Canvas unavailable → attention', reasonOf(base({ brandCanvas: { available: false, reason: 'the client has no company name' } })) === 'brand-canvas-unavailable');
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
t('a day whose poster was sent is never regenerated, explicit or not', reasonOf(base({ mode: 'regenerate', explicit: true, activeVersion: current, deliveryStatus: 'SENT' })) === 'day-locked' && reasonOf(base({ activeVersion: outdated, deliveryStatus: 'SENT' })) === 'day-locked');
t('…nor one being sent right now', reasonOf(base({ mode: 'regenerate', explicit: true, activeVersion: current, deliveryStatus: 'SENDING' })) === 'day-locked');
{
  const locked = evaluatePosterEligibility(base({ mode: 'regenerate', explicit: true, activeVersion: current, deliveryStatus: 'SENT' }));
  t('…with a clear message, and not as something to fix', !locked.eligible && /has been sent/.test(locked.message) && !locked.attention);
}
t('a sent day asked for missing posters still reads as already generated', reasonOf(base({ mode: 'missing', activeVersion: current, deliveryStatus: 'SENT' })) === 'already-generated');
t('a scheduled, failed or cancelled booking does not lock the poster', ['SCHEDULED', 'FAILED', 'CANCELLED', 'SKIPPED'].every((status) => reasonOf(base({ mode: 'regenerate', explicit: true, activeVersion: current, deliveryStatus: status as 'SCHEDULED' })) === 'eligible:regenerate'));
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

// ===========================================================================
section('template prompt');
// ===========================================================================
{
  const common = { brief: 'Brief.', aspectRatio: '9:16' as const, textFree: false, brand: null };
  const withPrompt = buildGeneratePrompt({ ...common, hasReference: true, templatePrompt: '  Keep the curved blue footer.  ' });
  t('the template prompt follows the reference guidance', withPrompt.includes('Template instructions from the admin') && withPrompt.indexOf('Keep the curved blue footer.') > withPrompt.indexOf('Reference image:'));
  t('the template prompt is trimmed', withPrompt.includes('\nKeep the curved blue footer.\n'));
  t('the no-invented-branding rule still comes after it', withPrompt.indexOf('No invented branding') > withPrompt.indexOf('Keep the curved blue footer.'));
  const blank = buildGeneratePrompt({ ...common, hasReference: true, templatePrompt: '   ' });
  t('a blank template prompt adds nothing', !blank.includes('Template instructions') && blank === buildGeneratePrompt({ ...common, hasReference: true }));
  t('no reference, no template prompt', !buildGeneratePrompt({ ...common, hasReference: false, templatePrompt: 'Keep it' }).includes('Keep it'));
}

console.log(`\n${bad === 0 ? 'All campaign poster checks passed.' : `${bad} check(s) FAILED.`}`);
process.exit(bad === 0 ? 0 : 1);
