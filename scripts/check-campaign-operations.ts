/**
 * Fixture suite for campaign operations and reliability (Phase 7).
 *
 * Pure: no database, no network, no provider. Covers the rules added in Phase 7
 * — the rejection guidance carried into a regeneration, the deterministic
 * delivery spread, the queue's bounds, and the needs-attention queue's grouping.
 * The database-backed half is `check-campaign-operations-db.ts`.
 *
 * Run: npm run check:campaign-operations
 */
import type { CampaignDeliveryStatus, PosterApprovalStatus, PosterGenerationStatus, TemplateMappingMode } from '@prisma/client';

import {
  buildCampaignPosterBrief,
  MAX_REJECTION_GUIDANCE,
  rejectionGuidance,
} from '@/lib/campaign/poster-generation';
import { DELIVERY_SPREAD_SECONDS, deliverySpreadSeconds } from '@/lib/campaign/delivery';
import { generationBatchLimit, generationConcurrency, mapWithLimit } from '@/lib/campaign/generation-queue';
import { buildAttentionQueue, MAX_ATTENTION_ITEMS, type OperationsDay } from '@/lib/campaign/operations';

let bad = 0;
const t = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) bad += 1;
};
const section = (title: string) => console.log(`\n--- ${title} ${'-'.repeat(Math.max(0, 58 - title.length))}`);

// ---------------------------------------------------------------------------
section('rejection guidance reaching the model');
// ---------------------------------------------------------------------------
{
  const guidance = rejectionGuidance('Branding issue — the logo sits over the headline');
  t('a review note becomes one corrective instruction', guidance !== null && /logo sits over the headline/.test(guidance));
  t('…and says not to repeat it', guidance !== null && /do not repeat it/i.test(guidance));

  t('no note means no instruction', rejectionGuidance(null) === null);
  t('an empty note means no instruction', rejectionGuidance('   ') === null);
  t('punctuation alone is not a review comment', rejectionGuidance('?!  ...') === null);

  // Operator free text may carry anything they had to hand. None of it should
  // reach the image model.
  const withUuid = rejectionGuidance('Wrong layout — see day 3a7f1e64-2b9c-4d1e-9f3a-8c2b5d6e7f80 for the good one');
  t('a uuid is stripped from the guidance', withUuid !== null && !/3a7f1e64/.test(withUuid), withUuid ?? '');
  const withLink = rejectionGuidance('Image quality — compare https://drive.google.com/file/d/abc123/view please');
  t('a Drive link is stripped', withLink !== null && !/drive\.google|https?:/.test(withLink), withLink ?? '');
  const withPhone = rejectionGuidance('Branding issue — the number should be 919876500123 not this');
  t('a long digit run (phone/id) is stripped', withPhone !== null && !/919876500123/.test(withPhone), withPhone ?? '');
  const withEmail = rejectionGuidance('Content issue — ask ops@example.com about the wording');
  t('an email address is stripped', withEmail !== null && !/@example\.com/.test(withEmail), withEmail ?? '');

  const long = rejectionGuidance(`Content issue — ${'x'.repeat(1000)}`);
  t('an over-long note is capped', long !== null && long.length < MAX_REJECTION_GUIDANCE + 120, String(long?.length));
  t('…and ends with an ellipsis', long !== null && /…\. Fix that/.test(long));

  const newlines = rejectionGuidance('Wrong layout —\n\nthe headline\nwraps badly');
  t('newlines are flattened', newlines !== null && !/\n/.test(newlines));
}

// ---------------------------------------------------------------------------
section('the brief carries it, and only when it applies');
// ---------------------------------------------------------------------------
{
  const content = {
    theme: 'Cleaning',
    contentTypeLabel: 'Educational',
    headline: 'Free dental camp',
    supportingText: 'This Sunday only.',
    cta: 'Book now',
    imagePrompt: 'A bright clinic reception.',
  };

  const plain = buildCampaignPosterBrief(content);
  t('a first attempt carries no rejection text', !/rejected in review/.test(plain));

  const corrected = buildCampaignPosterBrief({ ...content, previousRejection: 'Branding issue — logo too close to the headline' });
  t('a regeneration after rejection carries the reason', /rejected in review/.test(corrected) && /logo too close/.test(corrected));
  t('…as the last instruction, after the wording rule', corrected.lastIndexOf('rejected in review') > corrected.indexOf('Use exactly the headline'));
  t('the day content is unchanged by it', corrected.includes('Headline: "Free dental camp"'));

  t('an explicitly null rejection adds nothing', buildCampaignPosterBrief({ ...content, previousRejection: null }) === plain);
  t('an unusable note adds nothing', buildCampaignPosterBrief({ ...content, previousRejection: '...' }) === plain);

  // The brief has never carried an identifier and still must not.
  t('no identifier of any kind is in the brief', !/[0-9a-f]{8}-[0-9a-f]{4}/.test(corrected) && !/drive|folder|whatsapp/i.test(corrected));
}

// ---------------------------------------------------------------------------
section('delivery spread');
// ---------------------------------------------------------------------------
{
  const keys = Array.from({ length: 400 }, (_, index) => `3a7f1e64-2b9c-4d1e-9f3a-8c2b5d6e${String(index).padStart(4, '0')}`);
  const values = keys.map((key) => deliverySpreadSeconds(key));

  t('every offset is inside the window', values.every((value) => value >= 0 && value < DELIVERY_SPREAD_SECONDS));
  t('the offset is deterministic', deliverySpreadSeconds(keys[0]!) === values[0] && deliverySpreadSeconds(keys[0]!) === values[0]);
  /*
   * 400 keys into 600 buckets collide by the birthday bound — roughly 290
   * distinct is the expected value, not 400. What matters is that the offsets
   * are spread, not that they are unique: two days sharing a second is
   * harmless, all of them sharing one is the thing being prevented.
   */
  t('offsets are spread rather than clustered', new Set(values).size > 220, `${new Set(values).size} distinct of 400`);

  // The point of the spread: a fleet on one delivery minute does not burst.
  const buckets = new Map<number, number>();
  for (const value of values) {
    const minute = Math.floor(value / 60);
    buckets.set(minute, (buckets.get(minute) ?? 0) + 1);
  }
  t('offsets land across the whole window, not one minute', buckets.size >= 9, `${buckets.size} minutes used`);
  const worst = Math.max(...buckets.values());
  t('no single minute takes most of the load', worst < values.length * 0.25, `${worst} in the busiest minute`);
  t('the window is ten minutes', DELIVERY_SPREAD_SECONDS === 600);
}

// ---------------------------------------------------------------------------
section('queue bounds');
// ---------------------------------------------------------------------------
{
  const original = { limit: process.env.CAMPAIGN_GENERATION_LIMIT, concurrency: process.env.CAMPAIGN_GENERATION_CONCURRENCY };

  delete process.env.CAMPAIGN_GENERATION_LIMIT;
  delete process.env.CAMPAIGN_GENERATION_CONCURRENCY;
  t('the default batch is small', generationBatchLimit() === 4, String(generationBatchLimit()));
  t('the default concurrency is conservative', generationConcurrency() === 1, String(generationConcurrency()));

  process.env.CAMPAIGN_GENERATION_CONCURRENCY = '3';
  t('concurrency is configurable', generationConcurrency() === 3);
  process.env.CAMPAIGN_GENERATION_CONCURRENCY = '99';
  t('…but capped, so one campaign cannot swamp the providers', generationConcurrency() === 4, String(generationConcurrency()));
  process.env.CAMPAIGN_GENERATION_CONCURRENCY = '0';
  t('…and never zero, which would stall the queue', generationConcurrency() === 1);
  process.env.CAMPAIGN_GENERATION_LIMIT = '0';
  t('the batch limit is never zero either', generationBatchLimit() === 1);

  if (original.limit === undefined) delete process.env.CAMPAIGN_GENERATION_LIMIT;
  else process.env.CAMPAIGN_GENERATION_LIMIT = original.limit;
  if (original.concurrency === undefined) delete process.env.CAMPAIGN_GENERATION_CONCURRENCY;
  else process.env.CAMPAIGN_GENERATION_CONCURRENCY = original.concurrency;
}

// ---------------------------------------------------------------------------
// The fan-out checks are async, and this file compiles to CJS, so they run
// inside a function rather than at the top level.
// ---------------------------------------------------------------------------
async function fanOutChecks(): Promise<void> {
  section('the bounded fan-out');
  /*
   * Pinned here rather than in the database suite: that one runs inside a
   * single Prisma interactive transaction, which cannot serve two queries at
   * once, so real overlap is only observable away from the database.
   */
  async function runWith(limit: number, items: number): Promise<{ peak: number; done: number[] }> {
    let inFlight = 0;
    let peak = 0;
    const done: number[] = [];
    await mapWithLimit(Array.from({ length: items }, (_, index) => index), limit, async (index) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      done.push(index);
      inFlight -= 1;
    });
    return { peak, done };
  }

  const serial = await runWith(1, 6);
  t('concurrency 1 runs strictly one at a time', serial.peak === 1, String(serial.peak));
  t('…and still does all the work', serial.done.length === 6);
  t('…in order', serial.done.join(',') === '0,1,2,3,4,5');

  const parallel = await runWith(3, 9);
  t('concurrency 3 overlaps three at a time', parallel.peak === 3, String(parallel.peak));
  t('…never more', parallel.peak <= 3);
  t('…and does all the work', parallel.done.length === 9 && new Set(parallel.done).size === 9);

  const fewer = await runWith(5, 2);
  t('a limit above the work does not over-spawn', fewer.peak === 2, String(fewer.peak));
  const none = await runWith(3, 0);
  t('an empty queue does nothing', none.done.length === 0 && none.peak === 0);
}

// ---------------------------------------------------------------------------
section('the needs-attention queue');
// ---------------------------------------------------------------------------
{
  const NOW = new Date('2026-09-20T09:00:00.000Z');
  let counter = 0;
  const day = (overrides: Partial<OperationsDay> = {}): OperationsDay => {
    counter += 1;
    return {
      id: `day-${counter}`,
      dayNumber: counter,
      campaignId: 'campaign-1',
      scheduledDate: NOW,
      contentStatus: 'READY',
      contentIssues: [],
      contentRevision: 3,
      posterTemplateId: 'template-1',
      suggestedTemplateId: null,
      generationStatus: 'SUCCEEDED' as PosterGenerationStatus,
      posterGenerationStartedAt: null,
      errorMessage: null,
      activePosterVersion: { contentRevision: 3, approvalStatus: 'APPROVED' as PosterApprovalStatus },
      delivery: null,
      // Campaign board: the day's campaign mode decides whether a suggestion counts.
      campaign: { templateMappingMode: 'AUTO' as TemplateMappingMode },
      ...overrides,
    };
  };

  const healthy = day();
  t('a healthy day raises nothing', buildAttentionQueue([healthy], [healthy], NOW).length === 0);

  const failedDay = day({ generationStatus: 'FAILED', activePosterVersion: null, errorMessage: 'The model refused it.' });
  const failed = buildAttentionQueue([failedDay], [failedDay], NOW);
  t('a failed generation is a POSTER blocker', failed[0]?.group === 'POSTER' && failed[0].detail === 'The model refused it.');
  t('…linking to the failed filter', failed[0]?.href === '?review=failed');

  const pendingDay = day({ activePosterVersion: { contentRevision: 3, approvalStatus: 'PENDING' } });
  const pending = buildAttentionQueue([pendingDay], [pendingDay], NOW);
  t('an unapproved poster is an APPROVAL blocker', pending[0]?.group === 'APPROVAL' && pending[0].href === '?review=needs-review');

  const rejectedDay = day({ activePosterVersion: { contentRevision: 3, approvalStatus: 'REJECTED' } });
  t('a rejected poster is an APPROVAL blocker', buildAttentionQueue([rejectedDay], [rejectedDay], NOW)[0]?.group === 'APPROVAL');

  const outdatedDay = day({ contentRevision: 9 });
  t('an outdated poster is a POSTER blocker', buildAttentionQueue([outdatedDay], [outdatedDay], NOW)[0]?.group === 'POSTER');

  const unmappedDay = day({ posterTemplateId: null, suggestedTemplateId: null, activePosterVersion: null, generationStatus: 'NOT_REQUESTED' });
  const unmapped = buildAttentionQueue([unmappedDay], [unmappedDay], NOW);
  t('an unmapped window day is a TEMPLATE blocker', unmapped.some((item) => item.group === 'TEMPLATE' && item.href === '?review=unmapped'));
  t('an unmapped day outside the window is not a blocker yet', buildAttentionQueue([unmappedDay], [], NOW).every((item) => item.group !== 'TEMPLATE'));

  // One template source (campaign board): a stored AUTO suggestion only counts
  // under AUTO — `effectiveTemplateId`, not `posterTemplateId ?? suggestedTemplateId`.
  const suggestedOnly = { posterTemplateId: null, suggestedTemplateId: 'template-2', activePosterVersion: null, generationStatus: 'NOT_REQUESTED' as PosterGenerationStatus };
  const autoSuggested = day({ ...suggestedOnly, campaign: { templateMappingMode: 'AUTO' } });
  const manualSuggested = day({ ...suggestedOnly, campaign: { templateMappingMode: 'MANUAL' } });
  t('under AUTO a suggestion maps the day', buildAttentionQueue([autoSuggested], [autoSuggested], NOW).every((item) => item.group !== 'TEMPLATE'));
  t('under MANUAL a suggestion alone leaves the day unmapped', buildAttentionQueue([manualSuggested], [manualSuggested], NOW).some((item) => item.group === 'TEMPLATE'));

  const contentDay = day({ contentStatus: 'NEEDS_REVIEW', contentIssues: ['Headline repeats day 12'] });
  const content = buildAttentionQueue([contentDay], [contentDay], NOW);
  t('flagged content is a CONTENT blocker with its finding', content[0]?.group === 'CONTENT' && content[0].detail === 'Headline repeats day 12');
  t('…and content is reported even outside the window', buildAttentionQueue([contentDay], [], NOW).some((item) => item.group === 'CONTENT'));

  const deliveryDay = day({ delivery: { status: 'FAILED' as CampaignDeliveryStatus, failureReason: 'Gateway said 503.', failurePermanent: false, attempts: 1 } });
  const delivery = buildAttentionQueue([deliveryDay], [deliveryDay], NOW);
  t('a failed delivery is a DELIVERY blocker', delivery[0]?.group === 'DELIVERY' && delivery[0].href === '?delivery=failed');
  const permanentDay = day({ delivery: { status: 'FAILED' as CampaignDeliveryStatus, failureReason: 'Bad number.', failurePermanent: true, attempts: 3 } });
  t('a permanent delivery failure says it will not retry', /will not retry/i.test(buildAttentionQueue([permanentDay], [permanentDay], NOW)[0]?.detail ?? ''));
  const sentDay = day({ delivery: { status: 'SENT' as CampaignDeliveryStatus, failureReason: null, failurePermanent: false, attempts: 1 } });
  t('a delivered day raises nothing', buildAttentionQueue([sentDay], [sentDay], NOW).length === 0);

  // Grouping and ordering, so the list reads as work rather than noise.
  const mixed = [deliveryDay, contentDay, failedDay, unmappedDay];
  const ordered = buildAttentionQueue(mixed, mixed, NOW);
  const groups = ordered.map((item) => item.group);
  t('blockers are grouped in workflow order', groups.indexOf('CONTENT') < groups.indexOf('TEMPLATE') && groups.indexOf('TEMPLATE') < groups.indexOf('POSTER'));
  t('…and DELIVERY comes last', groups.lastIndexOf('DELIVERY') === groups.length - 1);

  // A systematic problem must not render hundreds of identical rows.
  const many = Array.from({ length: 120 }, () => day({ activePosterVersion: { contentRevision: 3, approvalStatus: 'PENDING' } }));
  const capped = buildAttentionQueue(many, many, NOW);
  t('the list is capped', capped.length === MAX_ATTENTION_ITEMS, String(capped.length));
  t('…and the cap is a readable size', MAX_ATTENTION_ITEMS <= 50);

  const generatingDay = day({ generationStatus: 'GENERATING', posterGenerationStartedAt: NOW, activePosterVersion: null });
  t('a day being generated is not a blocker', buildAttentionQueue([generatingDay], [generatingDay], NOW).length === 0);
  const queuedDay = day({ generationStatus: 'QUEUED', activePosterVersion: null });
  t('a queued day is not a blocker either', buildAttentionQueue([queuedDay], [queuedDay], NOW).length === 0);
}

console.log(`\n${bad === 0 ? 'All campaign operations checks passed.' : `${bad} check(s) FAILED.`}`);
process.exit(bad === 0 ? 0 : 1);
