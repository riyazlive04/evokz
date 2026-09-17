/**
 * Fixture suite for campaign WhatsApp delivery (src/lib/campaign/delivery.ts
 * and src/lib/campaign/delivery-media.ts).
 *
 * Pure: no database, no network, no provider. The database-backed half —
 * claiming, sending, idempotency, retries — is `check-campaign-delivery-db.ts`.
 *
 * Run: npm run check:campaign-delivery
 */
import type { CampaignDeliveryStatus, CampaignStatus, PosterApprovalStatus } from '@prisma/client';

import {
  buildDeliveryCaption,
  buildDeliveryFileName,
  canRetryDelivery,
  DELIVERY_REFUSAL_MESSAGES,
  deliveryInstant,
  evaluateDeliveryEligibility,
  isDue,
  isMissed,
  isStaleClaim,
  isValidRecipient,
  MAX_CAPTION_LENGTH,
  MAX_DELIVERY_ATTEMPTS,
  matchesDeliveryFilter,
  parseDeliveryTime,
  retryDelayMs,
  STALE_SENDING_MS,
  summarizeDeliveries,
  type DeliveryCandidate,
  type DeliveryRefusal,
} from '@/lib/campaign/delivery';
import { mintMediaToken, verifyMediaToken } from '@/lib/campaign/delivery-media';

let bad = 0;
const t = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) bad += 1;
};
const section = (title: string) => console.log(`\n--- ${title} ${'-'.repeat(Math.max(0, 58 - title.length))}`);

const TZ = 'Asia/Kolkata';
const VERSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** A day that is fully deliverable. Each test spoils exactly one thing. */
function candidate(overrides: Partial<DeliveryCandidate> = {}): DeliveryCandidate {
  return {
    campaignId: 'campaign-1',
    campaignStatus: 'ACTIVE' as CampaignStatus,
    clientActive: true,
    contentReady: true,
    hasTemplate: true,
    dayContentRevision: 3,
    activeVersion: { id: VERSION_ID, contentRevision: 3, approvalStatus: 'APPROVED' as PosterApprovalStatus },
    recipient: '919876500123',
    whatsappConfigured: true,
    delivery: null,
    ...overrides,
  };
}

function refusalOf(input: Partial<DeliveryCandidate>, now = new Date()): DeliveryRefusal | 'eligible' {
  const result = evaluateDeliveryEligibility(candidate(input), now);
  return result.eligible ? 'eligible' : result.reason;
}

// ---------------------------------------------------------------------------
section('The approval gate');
// ---------------------------------------------------------------------------
{
  t('a fully approved, current, active day is deliverable', refusalOf({}) === 'eligible');

  t('a PENDING poster is never delivered', refusalOf({ activeVersion: { id: VERSION_ID, contentRevision: 3, approvalStatus: 'PENDING' } }) === 'awaiting-approval');
  t('a REJECTED poster is never delivered', refusalOf({ activeVersion: { id: VERSION_ID, contentRevision: 3, approvalStatus: 'REJECTED' } }) === 'poster-rejected');
  t('an outdated poster is never delivered, even though it is approved', refusalOf({ dayContentRevision: 5, activeVersion: { id: VERSION_ID, contentRevision: 3, approvalStatus: 'APPROVED' } }) === 'poster-outdated');
  t('a day with no poster is refused', refusalOf({ activeVersion: null }) === 'no-poster');

  for (const status of ['DRAFT', 'PAUSED', 'COMPLETED', 'CANCELLED'] as CampaignStatus[]) {
    t(`a ${status} campaign delivers nothing`, refusalOf({ campaignStatus: status }) === 'campaign-not-active');
  }

  t('a paused client delivers nothing, automatic or manual (the gate is the same)', refusalOf({ clientActive: false }) === 'client-paused');
  t('…a paused campaign is reported first', refusalOf({ clientActive: false, campaignStatus: 'PAUSED' }) === 'campaign-not-active');
  t('…and a paused client before any poster problem', refusalOf({ clientActive: false, contentReady: false, activeVersion: null }) === 'client-paused');
  t('the paused-client refusal says so plainly', /^Client is paused/.test(DELIVERY_REFUSAL_MESSAGES['client-paused']));
  t('content that is not ready blocks delivery', refusalOf({ contentReady: false }) === 'content-not-ready');
  t('a day with no template and no poster is refused', refusalOf({ hasTemplate: false, activeVersion: null }) === 'no-template');
  t('a poster already made keeps delivering after its mapping went away', refusalOf({ hasTemplate: false }) === 'eligible');
  t('a legacy calendar row can never enter campaign delivery', refusalOf({ campaignId: null }) === 'not-a-campaign-day');
}

// ---------------------------------------------------------------------------
section('Recipient and configuration');
// ---------------------------------------------------------------------------
{
  t('a valid Indian number passes', isValidRecipient('919876500123'));
  t('10 digits is the minimum', isValidRecipient('9876500123'));
  t('a leading zero is rejected', !isValidRecipient('0919876500123'));
  t('punctuation is rejected — the stored value must already be normalised', !isValidRecipient('+91 98765 00123'));
  t('too short is rejected', !isValidRecipient('91987'));
  t('too long is rejected', !isValidRecipient('9198765001234567'));
  t('null is rejected', !isValidRecipient(null));
  t('an empty string is rejected', !isValidRecipient(''));

  t('a missing number refuses delivery', refusalOf({ recipient: null }) === 'invalid-recipient');
  t('a malformed number refuses delivery', refusalOf({ recipient: 'not-a-number' }) === 'invalid-recipient');
  t('unconfigured WhatsApp refuses delivery', refusalOf({ whatsappConfigured: false }) === 'whatsapp-not-configured');
  t('every refusal has operator copy', (Object.keys(DELIVERY_REFUSAL_MESSAGES) as DeliveryRefusal[]).every((key) => DELIVERY_REFUSAL_MESSAGES[key].length > 8));
}

// ---------------------------------------------------------------------------
section('Duplicate protection and the version pin');
// ---------------------------------------------------------------------------
{
  const sent = { status: 'SENT' as CampaignDeliveryStatus, posterVersionId: VERSION_ID, attempts: 1, failurePermanent: false, sendingStartedAt: null };
  t('an already sent day is never sent again', refusalOf({ delivery: sent }) === 'already-delivered');
  t('already-delivered wins over every other problem', refusalOf({ delivery: sent, campaignStatus: 'CANCELLED', contentReady: false }) === 'already-delivered');

  const now = new Date('2026-09-20T09:00:00.000Z');
  const fresh = { status: 'SENDING' as CampaignDeliveryStatus, posterVersionId: VERSION_ID, attempts: 1, failurePermanent: false, sendingStartedAt: new Date(now.getTime() - 60_000) };
  t('a live SENDING claim blocks a second sender', refusalOf({ delivery: fresh }, now) === 'sending');
  const stale = { ...fresh, sendingStartedAt: new Date(now.getTime() - STALE_SENDING_MS - 1_000) };
  t('a stale SENDING claim is reclaimable', refusalOf({ delivery: stale }, now) === 'eligible');
  t('isStaleClaim treats a null claim as stale', isStaleClaim(null, now));
  t('isStaleClaim respects the window', !isStaleClaim(new Date(now.getTime() - STALE_SENDING_MS + 1_000), now));

  const replaced = { status: 'SCHEDULED' as CampaignDeliveryStatus, posterVersionId: 'a-different-version', attempts: 0, failurePermanent: false, sendingStartedAt: null };
  t('a booking pinned to a replaced version is refused, not silently re-aimed', refusalOf({ delivery: replaced }) === 'version-changed');

  const exhausted = { status: 'FAILED' as CampaignDeliveryStatus, posterVersionId: VERSION_ID, attempts: MAX_DELIVERY_ATTEMPTS, failurePermanent: false, sendingStartedAt: null };
  t('a delivery out of attempts stops', refusalOf({ delivery: exhausted }) === 'attempts-exhausted');
  const permanent = { status: 'FAILED' as CampaignDeliveryStatus, posterVersionId: VERSION_ID, attempts: 1, failurePermanent: true, sendingStartedAt: null };
  t('a permanent failure is not retried', refusalOf({ delivery: permanent }) === 'permanent-failure');
}

// ---------------------------------------------------------------------------
section('Retry bounds');
// ---------------------------------------------------------------------------
{
  t('a transient failure with attempts left may retry', canRetryDelivery({ status: 'FAILED', attempts: 1, failurePermanent: false }));
  t('a permanent failure never retries', !canRetryDelivery({ status: 'FAILED', attempts: 1, failurePermanent: true }));
  t('retries stop at the cap', !canRetryDelivery({ status: 'FAILED', attempts: MAX_DELIVERY_ATTEMPTS, failurePermanent: false }));
  t('a sent delivery is not a retry candidate', !canRetryDelivery({ status: 'SENT', attempts: 1, failurePermanent: false }));
  t('a scheduled delivery is not a retry candidate', !canRetryDelivery({ status: 'SCHEDULED', attempts: 0, failurePermanent: false }));
  t('backoff grows and is bounded', retryDelayMs(1) === 60_000 && retryDelayMs(2) === 300_000 && retryDelayMs(9) === 300_000);
  t('the attempt cap is small enough to never look like a loop', MAX_DELIVERY_ATTEMPTS <= 3);
}

// ---------------------------------------------------------------------------
section('Scheduling in the app timezone');
// ---------------------------------------------------------------------------
{
  t('"09:00" parses', parseDeliveryTime('09:00') === 540);
  t('"23:59" parses', parseDeliveryTime('23:59') === 1439);
  t('"00:00" parses', parseDeliveryTime('00:00') === 0);
  t('an out-of-range hour is rejected', parseDeliveryTime('24:00') === null);
  t('an out-of-range minute is rejected', parseDeliveryTime('09:60') === null);
  t('nonsense is rejected', parseDeliveryTime('morning') === null);

  // 18 Sept 2026 local midnight in Asia/Kolkata is 17 Sept 18:30 UTC.
  const localMidnight = new Date('2026-09-17T18:30:00.000Z');
  const at0900 = deliveryInstant(localMidnight, '09:00', TZ);
  t('09:00 IST resolves to 03:30 UTC', at0900.toISOString() === '2026-09-18T03:30:00.000Z', at0900.toISOString());
  const at1830 = deliveryInstant(localMidnight, '18:30', TZ);
  t('18:30 IST resolves to 13:00 UTC', at1830.toISOString() === '2026-09-18T13:00:00.000Z', at1830.toISOString());
  t('an instant midway through the local day still resolves to that day', deliveryInstant(new Date('2026-09-18T09:00:00.000Z'), '09:00', TZ).toISOString() === '2026-09-18T03:30:00.000Z');
  t('a malformed delivery time falls back to local midnight, never to UTC', deliveryInstant(localMidnight, 'oops', TZ).toISOString() === '2026-09-17T18:30:00.000Z');

  const now = new Date('2026-09-18T04:00:00.000Z');
  t('a past moment is due', isDue(at0900, now));
  t('a future moment is not due', !isDue(at1830, now));
  t('the exact moment is due', isDue(now, now));

  t('a day still in progress is not missed', !isMissed(at0900, now, TZ));
  t("yesterday's delivery is missed", isMissed(at0900, new Date('2026-09-19T04:00:00.000Z'), TZ));
  t('late on the same local day is late, not missed', !isMissed(at0900, new Date('2026-09-18T18:00:00.000Z'), TZ));
  t('just after local midnight the previous day is missed', isMissed(at0900, new Date('2026-09-18T18:31:00.000Z'), TZ));
}

// ---------------------------------------------------------------------------
section('The message');
// ---------------------------------------------------------------------------
{
  const caption = buildDeliveryCaption({ headline: 'Free dental camp', supportingText: 'This Sunday only.', cta: 'Book now' });
  t('the caption is the approved words, in order', caption === 'Free dental camp\n\nThis Sunday only.\n\nBook now', JSON.stringify(caption));
  t('missing parts are dropped, not left blank', buildDeliveryCaption({ headline: 'Only this', supportingText: null, cta: '' }) === 'Only this');
  t('an entirely empty day still produces a valid caption', buildDeliveryCaption({ headline: null, supportingText: null, cta: null }) === '');
  t('inner whitespace is tidied', buildDeliveryCaption({ headline: '  Spaced    out  ', supportingText: null, cta: null }) === 'Spaced out');

  const long = buildDeliveryCaption({ headline: 'x'.repeat(2000), supportingText: null, cta: null });
  t('an over-long caption is truncated with an ellipsis', long.length === MAX_CAPTION_LENGTH && long.endsWith('…'), String(long.length));

  t('the file name is day-numbered and padded', buildDeliveryFileName(7, 'image/png') === 'Campaign_Day_007.png');
  t('the extension follows the mime type', buildDeliveryFileName(12, 'image/jpeg') === 'Campaign_Day_012.jpg');
  t('an unknown mime type falls back to png', buildDeliveryFileName(1, 'application/octet-stream') === 'Campaign_Day_001.png');
  t('the file name leaks no identifier', !/[0-9a-f]{8}-[0-9a-f]{4}/.test(buildDeliveryFileName(3, 'image/png')));
}

// ---------------------------------------------------------------------------
section('The dashboard');
// ---------------------------------------------------------------------------
{
  const now = new Date('2026-09-18T12:00:00.000Z');
  const rows = [
    { status: 'SENT' as CampaignDeliveryStatus, scheduledFor: new Date('2026-09-18T03:30:00.000Z') },
    { status: 'SCHEDULED' as CampaignDeliveryStatus, scheduledFor: new Date('2026-09-18T03:30:00.000Z') },
    { status: 'SCHEDULED' as CampaignDeliveryStatus, scheduledFor: new Date('2026-09-19T03:30:00.000Z') },
    { status: 'FAILED' as CampaignDeliveryStatus, scheduledFor: new Date('2026-09-18T03:30:00.000Z') },
    { status: 'SKIPPED' as CampaignDeliveryStatus, scheduledFor: new Date('2026-09-17T03:30:00.000Z') },
    { status: null, scheduledFor: null },
  ];
  const summary = summarizeDeliveries(rows, now);
  t('the summary counts every state', summary.total === 6 && summary.sent === 1 && summary.scheduled === 2 && summary.failed === 1 && summary.skipped === 1 && summary.notScheduled === 1, JSON.stringify(summary));
  t('only a scheduled row whose moment has passed is due now', summary.dueNow === 1);

  t('"all" matches everything', rows.every((row) => matchesDeliveryFilter(row, 'all')));
  t('"sent" matches only sent', rows.filter((row) => matchesDeliveryFilter(row, 'sent')).length === 1);
  t('"scheduled" includes an in-flight send', matchesDeliveryFilter({ status: 'SENDING' }, 'scheduled'));
  t('"skipped" includes cancelled', matchesDeliveryFilter({ status: 'CANCELLED' }, 'skipped'));
  t('"not-scheduled" matches the absence of a delivery', matchesDeliveryFilter({ status: null }, 'not-scheduled'));
}

// ---------------------------------------------------------------------------
// The media-link checks are async (Web Crypto), and this file compiles to CJS,
// so they run inside a function rather than at the top level.
// ---------------------------------------------------------------------------
async function mediaLinkChecks(): Promise<void> {
  section('Signed media links');

  const secret = 'a-test-secret-value-long-enough';
  const now = 1_800_000_000;

  const token = await mintMediaToken(VERSION_ID, secret, now);
  const good = await verifyMediaToken(token, secret, now + 60);
  t('a fresh token verifies and names its poster', good.ok && good.posterVersionId === VERSION_ID);

  const expired = await verifyMediaToken(token, secret, now + 60 * 60);
  t('an expired token is refused', !expired.ok && expired.reason === 'expired');

  const wrongSecret = await verifyMediaToken(token, 'a-different-secret-value-here', now + 60);
  t('a token signed with another secret is refused', !wrongSecret.ok && wrongSecret.reason === 'bad-signature');

  const tampered = token.replace(VERSION_ID, 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee');
  t('swapping the poster id invalidates the signature', !(await verifyMediaToken(tampered, secret, now + 60)).ok);

  const extended = token.split('~').map((part, index) => (index === 1 ? String(now + 999_999) : part)).join('~');
  t('extending the expiry invalidates the signature', !(await verifyMediaToken(extended, secret, now + 60)).ok);

  t('a malformed token is refused', !(await verifyMediaToken('nonsense', secret, now)).ok);
  t('a non-uuid subject is refused', !(await verifyMediaToken(`not-a-uuid~${now + 60}~abcd`, secret, now)).ok);
  const unset = await verifyMediaToken(token, '', now + 60);
  t('an unset secret fails closed', !unset.ok && unset.reason === 'unconfigured');

  t('the token carries no Drive id and no credential', !token.includes(secret) && token.split('~').length === 3);
  const other = await mintMediaToken('bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', secret, now);
  t('different posters get different signatures', other !== token);
}

mediaLinkChecks()
  .then(() => {
    console.log(`\n${bad === 0 ? 'All campaign delivery checks passed.' : `${bad} check(s) FAILED.`}`);
    process.exit(bad === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error('FAIL suite threw', error);
    process.exit(1);
  });
