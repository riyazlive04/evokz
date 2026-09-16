import type {
  CampaignContentStatus,
  CampaignStatus,
  PosterApprovalStatus,
  PosterGenerationStatus,
} from '@prisma/client';

import { isVersionCurrent } from '@/lib/campaign/model';
import { ASPECT_TOLERANCE, needsAction, type DayMappingState, type MappingIssue } from '@/lib/campaign/template-mapping';
import {
  MAX_STUDIO_PROMPT_LENGTH,
  STUDIO_ASPECT_RATIO_KEYS,
  STUDIO_ASPECT_RATIOS,
  type StudioAspectRatio,
} from '@/lib/poster-studio/limits';
import { addZonedDays, startOfZonedDay } from '@/lib/time';

/**
 * Rolling campaign poster generation — the pure rules of Phase 4.
 *
 * Which campaign days may have a poster generated now, why the others may not,
 * what state each day's poster is in, and the brief the image model receives.
 * No database, no network: `poster-generation-service.ts` runs the Poster
 * Studio pipeline on the days these rules allow, and
 * `npm run check:campaign-posters` pins every rule here.
 *
 * Posters are produced for a rolling window of upcoming days (the campaign's
 * `generationWindowDays`, default 14), never for the whole campaign at once.
 * Every other day stays an editable content and template slot.
 */

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/** An attempt still GENERATING after this long was interrupted (the image request itself times out at 5 minutes). */
export const STALE_GENERATION_MS = 10 * 60_000;

export interface GenerationWindow {
  /** Local midnight today. */
  start: Date;
  /** Local midnight after the last day of the window (exclusive). */
  end: Date;
  days: number;
}

/** Today and the next `days - 1` days, in the app timezone. */
export function generationWindow(now: Date, days: number, timeZone: string): GenerationWindow {
  const start = startOfZonedDay(now, timeZone);
  return { start, end: addZonedDays(start, Math.max(1, days), timeZone), days: Math.max(1, days) };
}

export function isInWindow(scheduledDate: Date, window: GenerationWindow): boolean {
  return scheduledDate.getTime() >= window.start.getTime() && scheduledDate.getTime() < window.end.getTime();
}

/** A GENERATING claim that is still live, as opposed to one left behind by a crash. */
export function isGenerationInProgress(
  status: PosterGenerationStatus | null,
  startedAt: Date | null,
  now: Date,
): boolean {
  if (status === 'QUEUED') return true;
  if (status !== 'GENERATING') return false;
  return startedAt !== null && now.getTime() - startedAt.getTime() < STALE_GENERATION_MS;
}

// ---------------------------------------------------------------------------
// Format and Brand Canvas
// ---------------------------------------------------------------------------

/**
 * The Poster Studio format for a client's output shape, or null when there is
 * none: the studio renders 9:16, 1:1 and 16:9 only, and a poster must not be
 * delivered at a shape the client did not ask for.
 */
export function studioAspectFor(aspect: number): StudioAspectRatio | null {
  if (!Number.isFinite(aspect) || aspect <= 0) return null;
  return (
    STUDIO_ASPECT_RATIO_KEYS.find((key) => {
      const [width, height] = STUDIO_ASPECT_RATIOS[key].size.split('x').map(Number) as [number, number];
      return Math.abs(aspect / (width / height) - 1) <= ASPECT_TOLERANCE;
    }) ?? null
  );
}

export interface BrandCanvasReadiness {
  available: boolean;
  /** Why not, for the operator. */
  reason: string | null;
}

/**
 * Whether a client's Brand Canvas holds what a campaign poster is built from.
 *
 * The brand colours must have been extracted: without them the prompt carries no
 * brand direction and the identity footer falls back to generic colours, which
 * is an unbranded poster. The logo, tagline, website and phone are optional —
 * the footer prints the company name when there is no logo, exactly as Poster
 * Studio does. Whether the logo is actually readable is checked by the overlay
 * pre-flight at generation time, before anything is paid for.
 */
export function brandCanvasReadiness(client: { companyName: string; brandColorCount: number }): BrandCanvasReadiness {
  if (!client.companyName.trim()) return { available: false, reason: 'the client has no company name' };
  if (client.brandColorCount === 0) {
    return { available: false, reason: 'no brand colours have been extracted — run Brand Canvas extraction for this client' };
  }
  return { available: true, reason: null };
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * `missing`    days with no poster yet (a failed attempt is retried)
 * `upcoming`   missing days, and days whose poster is outdated
 * `regenerate` any day — an explicit operator request for a new version
 */
export type PosterRequestMode = 'missing' | 'upcoming' | 'regenerate';

export type PosterBlockReason =
  | 'campaign-closed'
  | 'campaign-not-active'
  | 'generating'
  | 'in-the-past'
  | 'outside-window'
  | 'already-generated'
  | 'outdated'
  | 'content-not-generated'
  | 'content-needs-review'
  | 'no-template'
  | 'template-inactive'
  | 'template-unapproved'
  | 'template-unavailable'
  | 'template-incompatible'
  | 'unsupported-aspect'
  | 'brand-canvas-unavailable';

/** Reasons that need a person to fix something before a poster can exist. */
const ATTENTION_REASONS: ReadonlySet<PosterBlockReason> = new Set([
  'no-template',
  'template-inactive',
  'template-unapproved',
  'template-unavailable',
  'template-incompatible',
  'unsupported-aspect',
  'brand-canvas-unavailable',
]);

export interface PosterEligibilityInput {
  mode: PosterRequestMode;
  /** An operator named this day (single day or range): the rolling window does not apply. */
  explicit: boolean;
  now: Date;
  window: GenerationWindow;
  campaignStatus: CampaignStatus;
  scheduledDate: Date;
  contentStatus: CampaignContentStatus;
  /** Phase 3: the day's effective template and what is wrong with it. */
  mapping: DayMappingState;
  /** Phase 3: why no template could be mapped, when none is. */
  unmappedReason: MappingIssue | null;
  studioAspect: StudioAspectRatio | null;
  /** "9:16" — for the message. */
  targetAspectLabel: string;
  brandCanvas: BrandCanvasReadiness;
  generationStatus: PosterGenerationStatus | null;
  generationStartedAt: Date | null;
  dayRevision: number;
  activeVersion: { contentRevision: number } | null;
  /**
   * The caller is the background worker draining the queue (Phase 7), so a day
   * sitting in QUEUED is work to pick up rather than work in progress.
   *
   * Only relaxes the QUEUED case: a live GENERATING claim still blocks, which is
   * what stops two workers taking the same day. Default false, so every
   * interactive path behaves exactly as before.
   */
  acceptQueued?: boolean;
}

export type PosterEligibility =
  | {
      eligible: true;
      /** `regenerate` when the day already has a poster: a new version replaces it as active. */
      action: 'generate' | 'regenerate';
      /** The last attempt failed. */
      retry: boolean;
    }
  | {
      eligible: false;
      reason: PosterBlockReason;
      message: string;
      /** Something must be fixed; not merely "nothing to do". */
      attention: boolean;
    };

function blocked(reason: PosterBlockReason, message: string): PosterEligibility {
  return { eligible: false, reason, message, attention: ATTENTION_REASONS.has(reason) };
}

/**
 * Whether a poster may be generated for one day under one request, and if not,
 * the first reason. Never silent: every refusal names what to do about it.
 *
 * Order matters only for the message: a closed campaign is reported before an
 * empty slot, and a day that already has its poster is reported as generated
 * rather than as needing attention for a template it no longer needs.
 */
export function evaluatePosterEligibility(input: PosterEligibilityInput): PosterEligibility {
  if (input.campaignStatus === 'COMPLETED' || input.campaignStatus === 'CANCELLED') {
    return blocked('campaign-closed', `The campaign is ${input.campaignStatus.toLowerCase()}.`);
  }
  if (input.campaignStatus !== 'ACTIVE') {
    return blocked('campaign-not-active', `The campaign is ${input.campaignStatus.toLowerCase()} — activate it to generate posters.`);
  }
  const queuedForThisWorker = input.acceptQueued === true && input.generationStatus === 'QUEUED';
  if (!queuedForThisWorker && isGenerationInProgress(input.generationStatus, input.generationStartedAt, input.now)) {
    return blocked('generating', 'A poster is being generated for this day.');
  }
  if (input.scheduledDate.getTime() < input.window.start.getTime()) {
    return blocked('in-the-past', "This day's date has passed.");
  }
  if (!input.explicit && !isInWindow(input.scheduledDate, input.window)) {
    return blocked('outside-window', `Outside the next ${input.window.days} days — generate it by day number if needed.`);
  }

  const hasPoster = input.activeVersion !== null;
  const outdated = hasPoster && !isVersionCurrent(input.activeVersion!, { contentRevision: input.dayRevision });
  if (hasPoster && input.mode === 'missing') {
    return outdated
      ? blocked('outdated', 'Poster outdated — regeneration required.')
      : blocked('already-generated', 'Already generated.');
  }
  if (hasPoster && input.mode === 'upcoming' && !outdated) {
    return blocked('already-generated', 'Already generated.');
  }

  if (input.contentStatus === 'NOT_GENERATED') {
    return blocked('content-not-generated', 'Content not ready — no content has been written for this day.');
  }
  if (input.contentStatus !== 'READY') {
    return blocked('content-needs-review', 'Content not ready — it needs review first.');
  }

  if (!input.mapping.templateId) {
    return blocked('no-template', `No template mapped${input.unmappedReason ? ` — ${input.unmappedReason.detail}` : '.'}`);
  }
  if (needsAction(input.mapping)) {
    const issue = input.mapping.issues.find((candidate) => candidate.severity === 'action')!;
    const reason: PosterBlockReason =
      issue.code === 'template-inactive'
        ? 'template-inactive'
        : issue.code === 'template-unapproved'
          ? 'template-unapproved'
          : issue.code === 'template-missing' || issue.code === 'template-wrong-vertical'
            ? 'template-unavailable'
            : 'template-incompatible';
    return blocked(reason, `${issue.title}: ${issue.detail}`);
  }

  if (!input.studioAspect) {
    return blocked(
      'unsupported-aspect',
      `This client's ${input.targetAspectLabel} output is not a Poster Studio format (9:16, 1:1 or 16:9). Change the client's output size.`,
    );
  }
  if (!input.brandCanvas.available) {
    return blocked('brand-canvas-unavailable', `Brand Canvas unavailable — ${input.brandCanvas.reason}.`);
  }

  return { eligible: true, action: hasPoster ? 'regenerate' : 'generate', retry: input.generationStatus === 'FAILED' };
}

// ---------------------------------------------------------------------------
// Poster state
// ---------------------------------------------------------------------------

export type PosterState =
  | 'not-generated'
  | 'generating'
  | 'failed'
  | 'needs-approval'
  | 'approved'
  | 'rejected'
  | 'outdated'
  | 'needs-attention';

export const POSTER_STATE_LABELS: Record<PosterState, string> = {
  'not-generated': 'Not generated',
  generating: 'Generating',
  failed: 'Failed',
  'needs-approval': 'Needs approval',
  approved: 'Approved',
  rejected: 'Rejected',
  outdated: 'Outdated — regeneration required',
  'needs-attention': 'Needs attention',
};

/**
 * A day's poster state, derived — never stored. Built from Phase 1's columns:
 * the generation claim, the active version pointer, the version's content
 * revision and its approval.
 *
 * A day with a poster shows that poster's state even if a later regeneration
 * failed (`lastAttemptFailed` is reported beside it), so a failed retry never
 * hides a usable poster.
 */
export function derivePosterState(input: {
  generating: boolean;
  lastAttemptFailed: boolean;
  dayRevision: number;
  activeVersion: { contentRevision: number; approvalStatus: PosterApprovalStatus } | null;
  /** The day cannot be generated until something is fixed. */
  attention: boolean;
}): PosterState {
  if (input.generating) return 'generating';
  if (input.activeVersion) {
    if (!isVersionCurrent(input.activeVersion, { contentRevision: input.dayRevision })) return 'outdated';
    if (input.activeVersion.approvalStatus === 'REJECTED') return 'rejected';
    return input.activeVersion.approvalStatus === 'APPROVED' ? 'approved' : 'needs-approval';
  }
  if (input.lastAttemptFailed) return 'failed';
  return input.attention ? 'needs-attention' : 'not-generated';
}

export interface PosterWindowSummary {
  days: number;
  /** Days with a current active poster (approved, awaiting approval or rejected). */
  generated: number;
  needsApproval: number;
  approved: number;
  outdated: number;
  failed: number;
  generating: number;
  notGenerated: number;
  needsAttention: number;
  /** Days in the window with no effective template. */
  unmapped: number;
}

export function summarizePosterWindow(rows: ReadonlyArray<{ state: PosterState; unmapped: boolean }>): PosterWindowSummary {
  const summary: PosterWindowSummary = {
    days: rows.length,
    generated: 0,
    needsApproval: 0,
    approved: 0,
    outdated: 0,
    failed: 0,
    generating: 0,
    notGenerated: 0,
    needsAttention: 0,
    unmapped: 0,
  };
  for (const row of rows) {
    if (row.unmapped) summary.unmapped += 1;
    switch (row.state) {
      case 'needs-approval':
        summary.generated += 1;
        summary.needsApproval += 1;
        break;
      case 'approved':
        summary.generated += 1;
        summary.approved += 1;
        break;
      case 'rejected':
        summary.generated += 1;
        break;
      case 'outdated':
        summary.outdated += 1;
        break;
      case 'failed':
        summary.failed += 1;
        break;
      case 'generating':
        summary.generating += 1;
        break;
      case 'needs-attention':
        summary.needsAttention += 1;
        break;
      case 'not-generated':
        summary.notGenerated += 1;
        break;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

export interface CampaignPosterContent {
  theme: string | null;
  contentTypeLabel: string | null;
  headline: string | null;
  supportingText: string | null;
  cta: string | null;
  imagePrompt: string;
  /**
   * The review note on the poster this one replaces, when that poster was
   * rejected (Phase 7 §15). Only the note being fixed — never a history.
   */
  previousRejection?: string | null;
}

/** The longest rejection guidance that may reach the model. */
export const MAX_REJECTION_GUIDANCE = 200;

/**
 * Turns an operator's rejection note into one instruction for the next attempt,
 * or null when there is nothing safe or useful to say.
 *
 * **Sanitised on the way out, because this is free text an operator typed.** A
 * note may contain anything they had to hand — a Drive link, a day id pasted
 * from a URL, a phone number — and none of that belongs in a prompt. Identifiers
 * and links are stripped rather than the note rejected, so a useful comment with
 * a stray id still helps.
 *
 * Only the note on the version being replaced is ever used: not earlier
 * rejections, not the approval history, not who reviewed it.
 */
export function rejectionGuidance(note: string | null | undefined): string | null {
  if (!note) return null;

  const cleaned = note
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '') // uuids
    .replace(/https?:\/\/\S+/gi, '') // links, including Drive
    .replace(/\b[\w.-]+@[\w.-]+\.\w+\b/g, '') // email addresses
    .replace(/\b\d{7,}\b/g, '') // phone numbers and long id runs
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Punctuation alone is not a review comment.
  if (cleaned.replace(/[^\p{L}\p{N}]/gu, '').length < 3) return null;

  const trimmed =
    cleaned.length <= MAX_REJECTION_GUIDANCE ? cleaned : `${cleaned.slice(0, MAX_REJECTION_GUIDANCE - 1).trimEnd()}…`;
  return `The previous version of this poster was rejected in review for: ${trimmed}. Fix that specifically, and do not repeat it.`;
}

/**
 * The brief a campaign day's poster is generated from — the `brief` of Poster
 * Studio's GENERATE prompt (`buildGeneratePrompt`), which adds the format, the
 * Brand Canvas guidance, the mapped template as the attached reference, the
 * identity band and the no-invented-branding rule around it.
 *
 * **Only the day's content.** No identifier of any kind — not the day, campaign,
 * client or template id, not a Drive id, not the WhatsApp number — ever reaches
 * the image model; the brand facts it needs come from the Brand Canvas block.
 */
export function buildCampaignPosterBrief(content: CampaignPosterContent): string {
  const clean = (value: string | null | undefined) => value?.replace(/\s+/g, ' ').trim() || null;
  const headline = clean(content.headline);
  const supporting = clean(content.supportingText);
  const cta = clean(content.cta);

  const lines = [
    'A social media marketing poster for one day of a content campaign.',
    clean(content.contentTypeLabel) && `Content type: ${clean(content.contentTypeLabel)}`,
    clean(content.theme) && `Topic: ${clean(content.theme)}`,
    headline && `Headline: "${headline}"`,
    supporting && `Supporting text: "${supporting}"`,
    cta && `Call to action: "${cta}"`,
    clean(content.imagePrompt) && `Visual direction: ${clean(content.imagePrompt)}`,
    headline || supporting || cta
      ? 'Use exactly the headline, supporting text and call to action above as the poster’s wording, and no other text.'
      : null,
    // Last, so it reads as a correction to everything above it.
    rejectionGuidance(content.previousRejection),
  ].filter((line): line is string => Boolean(line));

  const brief = lines.join('\n');
  return brief.length <= MAX_STUDIO_PROMPT_LENGTH ? brief : `${brief.slice(0, MAX_STUDIO_PROMPT_LENGTH - 1)}…`;
}
