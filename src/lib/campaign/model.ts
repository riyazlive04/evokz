import type {
  CampaignApprovalPolicy,
  CampaignContentStatus,
  CampaignStatus,
  PosterApprovalStatus,
  PosterGenerationStatus,
  TemplateMappingMode,
} from '@prisma/client';

import { addZonedDays, normalizeDeliveryDays, zonedWeekday } from '@/lib/time';

/**
 * Campaign automation — the pure rules of the Phase 1 foundation.
 *
 * No database, no network: every decision about what a status may become, what
 * an edit invalidates, which template a day uses and whether a day could be
 * delivered is a function of plain values here, so it can be pinned by
 * `npm run check:campaign` without a database. `service.ts` applies these rules
 * to rows.
 *
 * The model, in one paragraph: a campaign is a set of independently editable
 * day slots (`ContentCalendar` rows with `campaignId`). A slot holds content and
 * a template choice and may exist long before any poster does. Posters are
 * immutable `PosterVersion` rows; the slot points at one active version. Each
 * version records the slot's `contentRevision` it was made from, which is how a
 * poster is known to be out of date without any status having to be reset.
 */

// ---------------------------------------------------------------------------
// Catalogues and limits
// ---------------------------------------------------------------------------

// Content types are pillar keys of the vertical's content strategy — see
// src/lib/campaign/content-strategy.ts. No catalogue of them lives here.

/** Two years of daily slots. A plan longer than this is a data error. */
export const MAX_CAMPAIGN_DAYS = 730;

// ---------------------------------------------------------------------------
// Status machines
// ---------------------------------------------------------------------------

/** COMPLETED and CANCELLED are terminal. */
export const CAMPAIGN_TRANSITIONS: Readonly<Record<CampaignStatus, readonly CampaignStatus[]>> = {
  DRAFT: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['PAUSED', 'COMPLETED', 'CANCELLED'],
  PAUSED: ['ACTIVE', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

/**
 * A day's generation attempt.
 *
 * `QUEUED → NOT_REQUESTED` withdraws a request nobody has claimed yet.
 * `GENERATING → FAILED` is also how a future reaper releases an attempt whose
 * worker died. A new attempt always starts from `QUEUED`, whatever the last
 * one's outcome.
 */
export const GENERATION_TRANSITIONS: Readonly<
  Record<PosterGenerationStatus, readonly PosterGenerationStatus[]>
> = {
  NOT_REQUESTED: ['QUEUED'],
  QUEUED: ['GENERATING', 'NOT_REQUESTED'],
  GENERATING: ['SUCCEEDED', 'FAILED'],
  SUCCEEDED: ['QUEUED'],
  FAILED: ['QUEUED'],
};

/**
 * A poster version's review. Withdrawing an approval and reconsidering a
 * rejection both go back through PENDING, so every decision is a fresh one.
 */
export const APPROVAL_TRANSITIONS: Readonly<
  Record<PosterApprovalStatus, readonly PosterApprovalStatus[]>
> = {
  PENDING: ['APPROVED', 'REJECTED'],
  APPROVED: ['PENDING'],
  REJECTED: ['PENDING'],
};

export function canTransitionCampaign(from: CampaignStatus, to: CampaignStatus): boolean {
  return CAMPAIGN_TRANSITIONS[from].includes(to);
}

export function canTransitionGeneration(
  from: PosterGenerationStatus,
  to: PosterGenerationStatus,
): boolean {
  return GENERATION_TRANSITIONS[from].includes(to);
}

export function canTransitionApproval(
  from: PosterApprovalStatus,
  to: PosterApprovalStatus,
): boolean {
  return APPROVAL_TRANSITIONS[from].includes(to);
}

/** Content, templates and posters of a finished or cancelled campaign are frozen. */
export function campaignAllowsChanges(status: CampaignStatus): boolean {
  return status !== 'COMPLETED' && status !== 'CANCELLED';
}

/**
 * Posters may be produced while a campaign is being prepared or running — not
 * while it is paused, finished or cancelled.
 */
export const GENERATION_CAMPAIGN_STATUSES: readonly CampaignStatus[] = ['DRAFT', 'ACTIVE'];

export function campaignAllowsGeneration(status: CampaignStatus): boolean {
  return GENERATION_CAMPAIGN_STATUSES.includes(status);
}

/** Only a running campaign delivers. Pausing needs no row to change. */
export function campaignAllowsDelivery(status: CampaignStatus): boolean {
  return status === 'ACTIVE';
}

// ---------------------------------------------------------------------------
// Content and poster inputs
// ---------------------------------------------------------------------------

/** The editable content of one campaign day, as stored on `ContentCalendar`. */
export interface CampaignDayContent {
  /** Content topic. The legacy column name is `theme`. */
  theme: string | null;
  contentType: string | null;
  headline: string | null;
  supportingText: string | null;
  cta: string | null;
  imagePrompt: string;
  backgroundPrompt: string | null;
  caption: string;
  hashtags: string;
}

export type CampaignDayContentField = keyof CampaignDayContent;

/**
 * Fields whose change makes an existing poster wrong.
 *
 * Caption and hashtags are deliberately absent: they are sent as the WhatsApp
 * message beside the image, never drawn into it, so correcting a typo in a
 * caption must not throw away an approved poster.
 */
export const POSTER_INPUT_FIELDS: readonly CampaignDayContentField[] = [
  'theme',
  'contentType',
  'headline',
  'supportingText',
  'cta',
  'imagePrompt',
  'backgroundPrompt',
];

/** Fields in `patch` whose value differs from `current`. Undefined means "not in the patch". */
export function changedContentFields(
  current: CampaignDayContent,
  patch: Partial<CampaignDayContent>,
): CampaignDayContentField[] {
  return (Object.keys(patch) as CampaignDayContentField[]).filter(
    (field) => patch[field] !== undefined && patch[field] !== current[field],
  );
}

export function touchesPosterInputs(fields: readonly CampaignDayContentField[]): boolean {
  return fields.some((field) => POSTER_INPUT_FIELDS.includes(field));
}

/** A campaign day has content once it has something to put on a poster. */
export function hasPosterContent(content: CampaignDayContent): boolean {
  return Boolean(content.headline?.trim() || content.imagePrompt.trim());
}

/** Any content at all — the difference between an empty slot and a written one. */
export function hasAnyContent(content: CampaignDayContent): boolean {
  return (Object.keys(content) as CampaignDayContentField[]).some((field) => {
    const value = content[field];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

/**
 * Content status after a person edits a day. Their edit is the review, so a
 * written day becomes READY and any validation findings are dropped; a day
 * edited back to nothing is an empty slot again.
 */
export function contentStatusAfterManualEdit(content: CampaignDayContent): CampaignContentStatus {
  return hasAnyContent(content) ? 'READY' : 'NOT_GENERATED';
}

// ---------------------------------------------------------------------------
// Template mapping
// ---------------------------------------------------------------------------

export interface DayTemplateChoice {
  /** The operator's selection (`ContentCalendar.posterTemplateId`). */
  posterTemplateId: string | null;
  /** The AUTO mapper's suggestion. */
  suggestedTemplateId: string | null;
}

/**
 * The one template a day's poster should be drawn from.
 *
 * An operator's selection always wins. Under AUTO the mapper's suggestion fills
 * a day nobody selected for; under MANUAL a suggestion is only a hint and the
 * day stays unmapped until somebody chooses.
 */
export function effectiveTemplateId(
  mode: TemplateMappingMode,
  day: DayTemplateChoice,
): string | null {
  if (day.posterTemplateId) return day.posterTemplateId;
  return mode === 'AUTO' ? day.suggestedTemplateId : null;
}

export type TemplateAssignmentProblem = 'wrong-vertical' | 'inactive';

/**
 * Why a template may not be newly assigned to a campaign's day, or null.
 *
 * Content-type fit is not a blocker: an operator pinning a festival template on
 * an educational day is a choice, not a data error. Use
 * `templateSuitsContentType` to rank or warn.
 */
export function templateAssignmentProblem(
  template: { categoryId: string; isActive: boolean },
  campaign: { categoryId: string },
): TemplateAssignmentProblem | null {
  if (template.categoryId !== campaign.categoryId) return 'wrong-vertical';
  if (!template.isActive) return 'inactive';
  return null;
}

/** An empty `contentTypes` list means the template suits any content. */
export function templateSuitsContentType(
  template: { contentTypes: readonly string[] },
  contentType: string | null,
): boolean {
  if (template.contentTypes.length === 0 || contentType === null) return true;
  return template.contentTypes.includes(contentType);
}

/**
 * A template's native aspect ratio, reduced — "9:16", "1:1", "4:5" — from the
 * measured dimensions already stored on `CategoryTemplate`. Null when unmeasured.
 */
export function templateAspectRatio(width: number | null, height: number | null): string | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(Math.round(width), Math.round(height));
  return `${Math.round(width) / divisor}:${Math.round(height) / divisor}`;
}

/** Template approval, from the existing review gates: an approved grid or plate. */
export function isTemplateLayoutApproved(template: {
  layoutApprovedAt: Date | null;
  plateApprovedAt: Date | null;
}): boolean {
  return template.layoutApprovedAt !== null || template.plateApprovedAt !== null;
}

// ---------------------------------------------------------------------------
// Poster versions
// ---------------------------------------------------------------------------

/** A version made from an older content revision no longer matches its day. */
export function isVersionCurrent(
  version: { contentRevision: number },
  day: { contentRevision: number },
): boolean {
  return version.contentRevision >= day.contentRevision;
}

/**
 * Whether a newly stored version should replace the day's active one.
 *
 * Generations can finish out of order: one queued before an edit may land after
 * one queued after it. The late, older one is kept in history but must not
 * displace a version made from newer content. An explicit operator choice
 * (`activatePosterVersion`) is not subject to this.
 */
export function shouldAutoActivate(
  newVersionRevision: number,
  currentActive: { contentRevision: number } | null,
): boolean {
  return currentActive === null || newVersionRevision >= currentActive.contentRevision;
}

export function initialApprovalStatus(policy: CampaignApprovalPolicy): PosterApprovalStatus {
  return policy === 'AUTO_APPROVE' ? 'APPROVED' : 'PENDING';
}

export type DeliveryReadiness =
  | 'ready'
  | 'campaign-not-active'
  | 'no-active-poster'
  | 'poster-outdated'
  | 'poster-rejected'
  | 'awaiting-approval';

/**
 * Whether a campaign day could enter the delivery queue, and if not, the first
 * reason why. The future queue must release only `ready` days, and must send
 * the active version's image — never another version of the same day.
 */
export function evaluateDeliveryReadiness(input: {
  campaignStatus: CampaignStatus;
  dayContentRevision: number;
  activeVersion: { contentRevision: number; approvalStatus: PosterApprovalStatus } | null;
}): DeliveryReadiness {
  if (!campaignAllowsDelivery(input.campaignStatus)) return 'campaign-not-active';
  if (!input.activeVersion) return 'no-active-poster';
  if (!isVersionCurrent(input.activeVersion, { contentRevision: input.dayContentRevision })) {
    return 'poster-outdated';
  }
  if (input.activeVersion.approvalStatus === 'REJECTED') return 'poster-rejected';
  if (input.activeVersion.approvalStatus !== 'APPROVED') return 'awaiting-approval';
  return 'ready';
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export interface CampaignSlot {
  dayNumber: number;
  /** Local midnight in the app timezone, as the dispatch sweep expects. */
  scheduledDate: Date;
}

/**
 * Every slot of a campaign, in order.
 *
 * Produces exactly the dates `nthDeliveryDate` would for each day number, in a
 * single walk: calling that per day restarts the weekday walk from the start
 * date every time, which is quadratic across a 365-day restricted campaign.
 */
export function planCampaignSlots(
  startDate: Date,
  durationDays: number,
  deliveryDays: readonly number[],
  timeZone: string,
): CampaignSlot[] {
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > MAX_CAMPAIGN_DAYS) {
    throw new Error(
      `A campaign needs between 1 and ${MAX_CAMPAIGN_DAYS} days, received ${durationDays}`,
    );
  }

  const allowed = normalizeDeliveryDays(deliveryDays);
  const unrestricted = allowed.length === 0 || allowed.length === 7;
  const slots: CampaignSlot[] = [];

  for (let offset = 0; slots.length < durationDays; offset += 1) {
    const candidate = addZonedDays(startDate, offset, timeZone);
    if (unrestricted || allowed.includes(zonedWeekday(candidate, timeZone))) {
      slots.push({ dayNumber: slots.length + 1, scheduledDate: candidate });
    }
  }

  return slots;
}
