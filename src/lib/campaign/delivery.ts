import type { CampaignDeliveryStatus, CampaignStatus, PosterApprovalStatus } from '@prisma/client';

import { evaluateDeliveryReadiness } from '@/lib/campaign/model';
import { getZonedParts, startOfZonedDay } from '@/lib/time';

/**
 * Campaign WhatsApp delivery — the pure rules of Phase 6.
 *
 * Whether a day may be sent, when it is due, what the message says, and what a
 * failure means. No database, no network, no provider: `delivery-service.ts`
 * applies these to rows and `npm run check:campaign-delivery` pins them.
 *
 * **Approval is not re-decided here.** `evaluateDeliveryEligibility` calls
 * Phase 1's `evaluateDeliveryReadiness` for the campaign/poster/approval part,
 * so there is exactly one definition of "this poster may go out" and the
 * delivery gate cannot drift from the review queue's.
 *
 * **The recipient is the client's own WhatsApp number.** This product has no
 * audience, contact or subscriber model: a campaign poster is delivered to the
 * business that ordered it, exactly as the legacy calendar sweep delivers.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Provider calls per delivery, including the first. Bounded — never a loop. */
export const MAX_DELIVERY_ATTEMPTS = 3;

/** A SENDING claim older than this belonged to an attempt that died. */
export const STALE_SENDING_MS = 10 * 60_000;

/** WhatsApp captions are capped well below the provider limit, to stay readable. */
export const MAX_CAPTION_LENGTH = 1024;

export const DELIVERY_STATUS_LABELS: Record<CampaignDeliveryStatus, string> = {
  SCHEDULED: 'Scheduled',
  SENDING: 'Sending',
  SENT: 'Sent',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  SKIPPED: 'Skipped',
};

// ---------------------------------------------------------------------------
// Eligibility — the hard gate
// ---------------------------------------------------------------------------

/**
 * Why a day may not be delivered. Every one of these is returned rather than
 * silently skipped, and the server checks them again immediately before the
 * provider call — never only in the UI.
 */
export type DeliveryRefusal =
  | 'not-a-campaign-day'
  | 'campaign-not-active'
  | 'client-paused'
  | 'already-delivered'
  | 'sending'
  | 'content-not-ready'
  | 'no-template'
  | 'no-poster'
  | 'poster-outdated'
  | 'poster-rejected'
  | 'awaiting-approval'
  | 'version-changed'
  | 'whatsapp-not-configured'
  | 'invalid-recipient'
  | 'not-due'
  | 'attempts-exhausted'
  | 'permanent-failure';

export const DELIVERY_REFUSAL_MESSAGES: Record<DeliveryRefusal, string> = {
  'not-a-campaign-day': 'This calendar row is not part of a campaign.',
  'campaign-not-active': 'The campaign is not active.',
  'client-paused': 'Client is paused. Resume the client to send its posters.',
  'already-delivered': 'Already delivered.',
  sending: 'This day is being sent right now.',
  'content-not-ready': 'The content for this day is not ready.',
  'no-template': 'No template is mapped to this day.',
  'no-poster': 'No poster has been generated for this day.',
  'poster-outdated': 'The poster is outdated — regenerate and approve it first.',
  'poster-rejected': 'The poster was rejected — fix it and approve it first.',
  'awaiting-approval': 'The poster still needs approval.',
  'version-changed': 'The approved poster was replaced — review the new one before sending.',
  'whatsapp-not-configured': 'WhatsApp is not configured on this deployment.',
  'invalid-recipient': "The client's WhatsApp number is missing or not a valid international number.",
  'not-due': 'Not due yet.',
  'attempts-exhausted': 'Every retry has been used. Check the error before trying again.',
  'permanent-failure': 'The last failure will repeat until something changes.',
};

export interface DeliveryCandidate {
  /** Null means a legacy calendar row, which this path never touches. */
  campaignId: string | null;
  campaignStatus: CampaignStatus;
  /**
   * The client is active (`Client.isActive`). Pausing a client stops every
   * WhatsApp send of its campaigns — automatic and manual — and leaves their
   * bookings exactly where they are, as pausing a campaign does.
   */
  clientActive: boolean;
  contentReady: boolean;
  /** The effective template (selection wins over suggestion), from Phase 3. */
  hasTemplate: boolean;
  dayContentRevision: number;
  activeVersion: { id: string; contentRevision: number; approvalStatus: PosterApprovalStatus } | null;
  /** The client's own WhatsApp number, as stored. */
  recipient: string | null;
  /** Both Evolution environment variables are set. */
  whatsappConfigured: boolean;
  /** The day's existing delivery record, when there is one. */
  delivery: {
    status: CampaignDeliveryStatus;
    posterVersionId: string;
    attempts: number;
    failurePermanent: boolean;
    sendingStartedAt: Date | null;
  } | null;
}

export type DeliveryEligibility =
  | { eligible: true }
  | { eligible: false; reason: DeliveryRefusal; message: string };

function refuse(reason: DeliveryRefusal): DeliveryEligibility {
  return { eligible: false, reason, message: DELIVERY_REFUSAL_MESSAGES[reason] };
}

/**
 * Whether this day's approved poster may be sent to the client now.
 *
 * Ordered so the most fundamental refusal wins: a cancelled campaign is
 * reported as such even if its poster is also unapproved. `now` is only
 * consulted for the stale-claim window; whether the moment has arrived is a
 * separate question (`isDue`), because a manual Send Now deliberately ignores it
 * while every other gate still applies.
 */
export function evaluateDeliveryEligibility(input: DeliveryCandidate, now: Date = new Date()): DeliveryEligibility {
  if (!input.campaignId) return refuse('not-a-campaign-day');

  const delivery = input.delivery;
  // Terminal first: a sent day is never sent again, whatever else changed.
  if (delivery?.status === 'SENT') return refuse('already-delivered');
  if (delivery?.status === 'SENDING' && !isStaleClaim(delivery.sendingStartedAt, now)) return refuse('sending');
  if (delivery && delivery.attempts >= MAX_DELIVERY_ATTEMPTS && delivery.status !== 'SCHEDULED') {
    return refuse('attempts-exhausted');
  }
  if (delivery?.failurePermanent && delivery.status === 'FAILED') return refuse('permanent-failure');

  if (input.campaignStatus !== 'ACTIVE') return refuse('campaign-not-active');
  if (!input.clientActive) return refuse('client-paused');
  if (!input.contentReady) return refuse('content-not-ready');
  // Only meaningful while there is no poster: an existing poster was already
  // drawn from a template, so a mapping changed afterwards is not a send-blocker.
  if (!input.hasTemplate && !input.activeVersion) return refuse('no-template');

  // Phase 1's rule, unmodified: poster exists, is current, and is approved.
  const readiness = evaluateDeliveryReadiness({
    campaignStatus: input.campaignStatus,
    dayContentRevision: input.dayContentRevision,
    activeVersion: input.activeVersion,
  });
  if (readiness !== 'ready') {
    // Phase 1's vocabulary, translated once. 'campaign-not-active' is already
    // handled above and can only reappear here if that check ever moves.
    const mapped: Record<Exclude<typeof readiness, 'ready'>, DeliveryRefusal> = {
      'campaign-not-active': 'campaign-not-active',
      'no-active-poster': 'no-poster',
      'poster-outdated': 'poster-outdated',
      'poster-rejected': 'poster-rejected',
      'awaiting-approval': 'awaiting-approval',
    };
    return refuse(mapped[readiness]);
  }

  /*
   * The pinned version must still be the day's active one. A poster
   * regenerated after the delivery was booked arrives PENDING, so sending the
   * booked version would deliver something the operator did not approve last,
   * and sending the new one would deliver something unapproved. Neither is
   * acceptable, so the delivery is refused and cancelled instead.
   */
  if (delivery && input.activeVersion && delivery.posterVersionId !== input.activeVersion.id) {
    return refuse('version-changed');
  }

  if (!input.whatsappConfigured) return refuse('whatsapp-not-configured');
  if (!isValidRecipient(input.recipient)) return refuse('invalid-recipient');

  return { eligible: true };
}

/** A SENDING claim this old belonged to an attempt that died mid-flight. */
export function isStaleClaim(sendingStartedAt: Date | null, now: Date = new Date()): boolean {
  if (!sendingStartedAt) return true;
  return now.getTime() - sendingStartedAt.getTime() > STALE_SENDING_MS;
}

/**
 * 10–15 digits, no punctuation, no leading zero — the shape
 * `normalizeWhatsappNumber` produces and `Client.whatsappNumber` documents.
 * Validated again here because delivery must never hand the provider something
 * that was written before that normaliser existed.
 */
export function isValidRecipient(number: string | null | undefined): boolean {
  return typeof number === 'string' && /^[1-9]\d{9,14}$/.test(number.trim());
}

// ---------------------------------------------------------------------------
// When a day is due
// ---------------------------------------------------------------------------

/** "HH:MM" → minutes past local midnight, or null when malformed. */
export function parseDeliveryTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number.parseInt(match[1]!, 10);
  const minutes = Number.parseInt(match[2]!, 10);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * The instant a day should go out: its local date at the campaign's
 * `deliveryTime`, resolved in the app timezone.
 *
 * Built from `startOfZonedDay` rather than by adding to the stored timestamp,
 * so the local date is the one an operator sees. A zone whose offset changes
 * between midnight and the delivery time would land an hour out; no delivery
 * time in use is near a transition, and the app zone (Asia/Kolkata) has none.
 */
export function deliveryInstant(scheduledDate: Date, deliveryTime: string, timeZone: string): Date {
  const midnight = startOfZonedDay(scheduledDate, timeZone);
  const minutes = parseDeliveryTime(deliveryTime) ?? 0;
  return new Date(midnight.getTime() + minutes * 60_000);
}

/**
 * How far past its nominal time a delivery may be spread. Ten minutes.
 *
 * Campaigns configure a delivery time by hand, and operators pick round numbers:
 * a fleet on "09:00" would otherwise hand the provider every message in the same
 * second. The legacy sweep solves the same problem with a random
 * `WHATSAPP_SEND_DELAY_*` jitter; campaigns cannot use a random one, because a
 * booking is a stored instant that must not move every time the page reloads.
 */
export const DELIVERY_SPREAD_SECONDS = 10 * 60;

/**
 * A stable offset in [0, DELIVERY_SPREAD_SECONDS) for one delivery.
 *
 * Derived from the day's id, so it is the same on every run — rescheduling,
 * reconciling or reloading never moves a booking — and effectively uniform
 * across days, so one campaign's days and several campaigns on the same minute
 * both spread out. FNV-1a: not a hash for security, just for distribution.
 */
export function deliverySpreadSeconds(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % DELIVERY_SPREAD_SECONDS;
}

/** Whether the moment has arrived. Past days are due — they are simply late. */
export function isDue(scheduledFor: Date, now: Date = new Date()): boolean {
  return scheduledFor.getTime() <= now.getTime();
}

/**
 * Whether a due-but-unsent day has been missed for good.
 *
 * A delivery still sitting SCHEDULED a full local day after its moment is not
 * sent late — a poster for last Tuesday is worthless on Thursday. It is marked
 * SKIPPED so the queue stays honest rather than retrying forever.
 */
export function isMissed(scheduledFor: Date, now: Date, timeZone: string): boolean {
  const scheduledDay = startOfZonedDay(scheduledFor, timeZone).getTime();
  const today = startOfZonedDay(now, timeZone).getTime();
  return today > scheduledDay;
}

/** "HH:MM" of an instant in the app zone — for the dashboard, not for matching. */
export function deliveryClock(instant: Date, timeZone: string): string {
  const { hour, minute } = getZonedParts(instant, timeZone);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

export interface DeliveryContent {
  headline: string | null;
  supportingText: string | null;
  cta: string | null;
}

/**
 * The caption sent with the poster: the day's approved words, nothing new.
 *
 * No model is called at delivery time and no text is invented — this is purely
 * the content an operator already reviewed, joined and trimmed. An empty
 * caption is valid: the poster itself carries the message.
 */
export function buildDeliveryCaption(content: DeliveryContent): string {
  const blocks = [content.headline, content.supportingText, content.cta]
    .map((part) => (part ?? '').replace(/[ \t]+/g, ' ').trim())
    .filter((part) => part.length > 0);

  const caption = blocks.join('\n\n');
  return caption.length > MAX_CAPTION_LENGTH ? `${caption.slice(0, MAX_CAPTION_LENGTH - 1).trimEnd()}…` : caption;
}

export interface DeliveryMessageContent extends DeliveryContent {
  /** The day's saved caption (`ContentCalendar.caption`). */
  caption: string | null;
  /** The day's saved link (`ContentCalendar.deliveryLink`). */
  link: string | null;
}

function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * The WhatsApp caption sent with the poster: the day's saved Caption, then its
 * Link on its own line.
 *
 * A day with no caption keeps the message it has always had — headline,
 * supporting text and CTA (`buildDeliveryCaption`) — so a day nobody wrote a
 * caption for is not sent bare. Internal notes are not an input here at all:
 * they can never reach a recipient.
 *
 * The link is never cut: when the whole message would pass WhatsApp's caption
 * limit, the caption is shortened instead. Line breaks the admin typed are kept;
 * runs of spaces and of blank lines are tidied.
 */
export function buildDeliveryMessage(content: DeliveryMessageContent): string {
  const caption = (content.caption ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const body = caption || buildDeliveryCaption(content);
  const link = (content.link ?? '').trim();
  if (!link) return truncate(body, MAX_CAPTION_LENGTH);
  const room = MAX_CAPTION_LENGTH - link.length - 2;
  const shortened = truncate(body, room);
  return shortened ? `${shortened}\n\n${link}` : link.slice(0, MAX_CAPTION_LENGTH);
}

/** Longest link a day may carry; far below the caption limit so a caption always fits beside it. */
export const MAX_DELIVERY_LINK_LENGTH = 500;

/**
 * An admin-typed link, cleaned for sending: `www.example.com/offer` becomes
 * `https://www.example.com/offer`. Null for an empty value. Throws a message
 * for anything that is not a plain http(s) web address — no other scheme
 * (`javascript:`, `mailto:`, …) and no spaces.
 */
export function normalizeDeliveryLink(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (value.length > MAX_DELIVERY_LINK_LENGTH) throw new Error(`Keep the link under ${MAX_DELIVERY_LINK_LENGTH} characters.`);
  if (/\s/.test(value)) throw new Error('A link cannot contain spaces.');
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(value);
  if (hasScheme && !/^https?:\/\//i.test(value)) throw new Error('Use a web link that starts with https:// or http://.');
  let url: URL;
  try {
    url = new URL(hasScheme ? value : `https://${value}`);
  } catch {
    throw new Error('That is not a valid web link.');
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.') || url.username || url.password) {
    throw new Error('That is not a valid web link.');
  }
  return hasScheme ? value : `https://${value}`;
}

/** `Campaign_Day_007.png` — the file name the recipient sees. */
export function buildDeliveryFileName(dayNumber: number, mimeType: string): string {
  const extension =
    {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/webp': 'webp',
      'image/avif': 'avif',
    }[mimeType.toLowerCase().split(';')[0]?.trim() ?? ''] ?? 'png';
  return `Campaign_Day_${String(dayNumber).padStart(3, '0')}.${extension}`;
}

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

export interface RetryableDelivery {
  status: CampaignDeliveryStatus;
  attempts: number;
  failurePermanent: boolean;
}

/**
 * Whether another automatic attempt is allowed.
 *
 * Bounded twice: a permanent failure (bad number, bad credentials, bad config,
 * or an ambiguous timeout that may already have been sent) is never retried at
 * all, and a transient one only while attempts remain.
 */
export function canRetryDelivery(delivery: RetryableDelivery): boolean {
  if (delivery.status !== 'FAILED') return false;
  if (delivery.failurePermanent) return false;
  return delivery.attempts < MAX_DELIVERY_ATTEMPTS;
}

/** Exponential backoff between automatic attempts: 1 min, then 5. */
export function retryDelayMs(attempts: number): number {
  return attempts <= 1 ? 60_000 : 5 * 60_000;
}

// ---------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------

export const DELIVERY_FILTERS = ['all', 'scheduled', 'sent', 'failed', 'skipped', 'not-scheduled'] as const;
export type DeliveryFilter = (typeof DELIVERY_FILTERS)[number];

export const DELIVERY_FILTER_LABELS: Record<DeliveryFilter, string> = {
  all: 'All',
  scheduled: 'Scheduled',
  sent: 'Sent',
  failed: 'Failed',
  skipped: 'Skipped',
  'not-scheduled': 'Not scheduled',
};

export function isDeliveryFilter(value: string): value is DeliveryFilter {
  return (DELIVERY_FILTERS as readonly string[]).includes(value);
}

/** A day as the delivery dashboard sees it: its delivery, or the lack of one. */
export interface DeliveryRow {
  status: CampaignDeliveryStatus | null;
}

export function matchesDeliveryFilter(row: DeliveryRow, filter: DeliveryFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'scheduled':
      return row.status === 'SCHEDULED' || row.status === 'SENDING';
    case 'sent':
      return row.status === 'SENT';
    case 'failed':
      return row.status === 'FAILED';
    case 'skipped':
      return row.status === 'SKIPPED' || row.status === 'CANCELLED';
    case 'not-scheduled':
      return row.status === null;
  }
}

export interface DeliverySummary {
  total: number;
  scheduled: number;
  sending: number;
  sent: number;
  failed: number;
  cancelled: number;
  skipped: number;
  notScheduled: number;
  /** Scheduled and already due — waiting only for the next sweep. */
  dueNow: number;
}

export function summarizeDeliveries(
  rows: readonly { status: CampaignDeliveryStatus | null; scheduledFor: Date | null }[],
  now: Date = new Date(),
): DeliverySummary {
  const summary: DeliverySummary = {
    total: rows.length,
    scheduled: 0,
    sending: 0,
    sent: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    notScheduled: 0,
    dueNow: 0,
  };

  for (const row of rows) {
    switch (row.status) {
      case 'SCHEDULED':
        summary.scheduled += 1;
        if (row.scheduledFor && isDue(row.scheduledFor, now)) summary.dueNow += 1;
        break;
      case 'SENDING':
        summary.sending += 1;
        break;
      case 'SENT':
        summary.sent += 1;
        break;
      case 'FAILED':
        summary.failed += 1;
        break;
      case 'CANCELLED':
        summary.cancelled += 1;
        break;
      case 'SKIPPED':
        summary.skipped += 1;
        break;
      default:
        summary.notScheduled += 1;
    }
  }

  return summary;
}

/** One line for the campaign header: what delivery is doing right now. */
export function describeDelivery(summary: DeliverySummary): string {
  if (summary.total === 0) return 'No days to deliver yet.';
  const parts: string[] = [];
  if (summary.sent > 0) parts.push(`${summary.sent} sent`);
  if (summary.scheduled > 0) parts.push(`${summary.scheduled} scheduled`);
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`);
  if (parts.length === 0) return 'Nothing scheduled for delivery.';
  return `${parts.join(' · ')}. Posters go to the client's own WhatsApp number.`;
}
