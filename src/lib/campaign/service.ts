import {
  Prisma,
  type CampaignStatus,
  type PosterApprovalStatus,
  type PosterGenerationStatus,
  type PrismaClient,
} from '@prisma/client';
import { z } from 'zod';

import {
  campaignAllowsChanges,
  canTransitionApproval,
  canTransitionCampaign,
  canTransitionGeneration,
  changedContentFields,
  effectiveTemplateId,
  GENERATION_CAMPAIGN_STATUSES,
  initialApprovalStatus,
  isCampaignContentType,
  MAX_CAMPAIGN_DAYS,
  planCampaignSlots,
  shouldAutoActivate,
  templateAssignmentProblem,
  touchesPosterInputs,
  type CampaignDayContent,
  type CampaignDayContentField,
  type CampaignSlot,
} from '@/lib/campaign/model';
import { getAppTimeZone, HH_MM_PATTERN, normalizeDeliveryDays } from '@/lib/time';

/**
 * Campaign automation — database operations of the Phase 1 foundation.
 *
 * Deliberately narrow: create a campaign with its day slots, edit one day, map
 * a template, store and activate a poster version, review a version, and move
 * the campaign and generation statuses. There is no generator, queue, dispatch
 * or UI here, and nothing in this module calls a provider.
 *
 * Every function takes the database handle as its first argument — the app's
 * `prisma`, or a transaction client — so a caller can compose several into one
 * transaction and the checks can run inside a transaction that is rolled back.
 *
 * Writes that race are conditional updates, the same pattern as the dispatch
 * sweep's claims (`cron-worker.ts`): the `where` restates the state that was
 * read, and a count of zero is reported as a conflict rather than silently
 * overwriting someone else's change.
 */

export type CampaignDb = PrismaClient | Prisma.TransactionClient;

export type CampaignErrorCode =
  | 'not-found'
  | 'invalid-input'
  | 'invalid-transition'
  | 'conflict'
  | 'calendar-occupied'
  | 'not-a-campaign-day'
  | 'campaign-closed'
  | 'template-not-assignable';

export class CampaignDomainError extends Error {
  constructor(
    readonly code: CampaignErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CampaignDomainError';
  }
}

function inTransaction<T>(
  db: CampaignDb,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return '$transaction' in db ? db.$transaction(work) : work(db);
}

function parseInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.') || 'input';
    throw new CampaignDomainError('invalid-input', `${path}: ${issue?.message ?? 'invalid'}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

const createCampaignSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  startDate: z.date(),
  /** Defaults to the client's plan. */
  planId: z.string().uuid().optional(),
  /** Defaults to the client's vertical. */
  categoryId: z.string().uuid().optional(),
  /** Defaults to the plan's duration. */
  durationDays: z.number().int().min(1).max(MAX_CAMPAIGN_DAYS).optional(),
  /** Defaults to the client's delivery weekdays. */
  deliveryDays: z.array(z.number().int().min(1).max(7)).optional(),
  /** Defaults to the client's delivery time. */
  deliveryTime: z.string().regex(HH_MM_PATTERN, 'must be HH:MM').optional(),
  templateMappingMode: z.enum(['AUTO', 'MANUAL']).optional(),
  approvalPolicy: z.enum(['MANUAL_REVIEW', 'AUTO_APPROVE']).optional(),
  generationWindowDays: z.number().int().min(1).max(MAX_CAMPAIGN_DAYS).optional(),
  timeZone: z.string().min(1).optional(),
});

export type CreateCampaignInput = z.input<typeof createCampaignSchema>;

export interface CreateCampaignResult {
  campaignId: string;
  dayCount: number;
  startDate: Date;
  endDate: Date;
}

/**
 * Creates a DRAFT campaign and all of its day slots, with no content and no
 * posters.
 *
 * Slots are empty on purpose: content is written later (by the future AI
 * calendar or by hand) and posters later still, a rolling window at a time.
 *
 * Refused when the client already has calendar rows in the campaign's day
 * range, because `ContentCalendar` is still unique on (client, day number) for
 * the legacy pipeline. One calendar per client until that constraint is
 * replaced — see AI_POSTER_HANDOFF.md §17.
 */
export async function createCampaign(
  db: CampaignDb,
  input: CreateCampaignInput,
): Promise<CreateCampaignResult> {
  const data = parseInput(createCampaignSchema, input);
  const timeZone = data.timeZone ?? getAppTimeZone();

  return inTransaction(db, async (tx) => {
    const client = await tx.client.findUnique({
      where: { id: data.clientId },
      select: { id: true, planId: true, categoryId: true, cronTime: true, deliveryDays: true },
    });
    if (!client) throw new CampaignDomainError('not-found', 'Client does not exist.');

    const plan = await tx.plan.findUnique({
      where: { id: data.planId ?? client.planId },
      select: { id: true, durationDays: true },
    });
    if (!plan) throw new CampaignDomainError('not-found', 'Plan does not exist.');

    const category = await tx.category.findUnique({
      where: { id: data.categoryId ?? client.categoryId },
      select: { id: true },
    });
    if (!category) throw new CampaignDomainError('not-found', 'Vertical does not exist.');

    const durationDays = data.durationDays ?? plan.durationDays;
    const deliveryDays = normalizeDeliveryDays(data.deliveryDays ?? client.deliveryDays);

    let slots: CampaignSlot[];
    try {
      slots = planCampaignSlots(data.startDate, durationDays, deliveryDays, timeZone);
    } catch (error) {
      throw new CampaignDomainError('invalid-input', (error as Error).message);
    }
    const first = slots[0]!;
    const last = slots[slots.length - 1]!;

    const occupied = await tx.contentCalendar.count({
      where: { clientId: client.id, dayNumber: { lte: durationDays } },
    });
    if (occupied > 0) {
      throw new CampaignDomainError(
        'calendar-occupied',
        `This client already has ${occupied} calendar day(s) in days 1–${durationDays}. ` +
          'A client can hold one calendar until the (client, day number) constraint is replaced.',
      );
    }

    const campaign = await tx.campaign.create({
      data: {
        clientId: client.id,
        planId: plan.id,
        categoryId: category.id,
        name: data.name,
        startDate: first.scheduledDate,
        durationDays,
        endDate: last.scheduledDate,
        deliveryTime: data.deliveryTime ?? client.cronTime,
        deliveryDays,
        templateMappingMode: data.templateMappingMode ?? 'AUTO',
        approvalPolicy: data.approvalPolicy ?? 'MANUAL_REVIEW',
        generationWindowDays: data.generationWindowDays ?? 14,
      },
      select: { id: true },
    });

    const created = await tx.contentCalendar.createMany({
      data: slots.map((slot) => ({
        clientId: client.id,
        campaignId: campaign.id,
        dayNumber: slot.dayNumber,
        scheduledDate: slot.scheduledDate,
        // NOT NULL legacy content columns: empty means "not written yet".
        caption: '',
        hashtags: '',
        imagePrompt: '',
        generationStatus: 'NOT_REQUESTED' as const,
      })),
    });

    return {
      campaignId: campaign.id,
      dayCount: created.count,
      startDate: first.scheduledDate,
      endDate: last.scheduledDate,
    };
  });
}

/** Moves a campaign along `CAMPAIGN_TRANSITIONS`. Pausing changes no day or version. */
export async function changeCampaignStatus(
  db: CampaignDb,
  campaignId: string,
  to: CampaignStatus,
): Promise<{ from: CampaignStatus; to: CampaignStatus }> {
  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true },
  });
  if (!campaign) throw new CampaignDomainError('not-found', 'Campaign does not exist.');

  if (!canTransitionCampaign(campaign.status, to)) {
    throw new CampaignDomainError(
      'invalid-transition',
      `A ${campaign.status} campaign cannot become ${to}.`,
    );
  }

  const updated = await db.campaign.updateMany({
    where: { id: campaignId, status: campaign.status },
    data: { status: to },
  });
  if (updated.count === 0) {
    throw new CampaignDomainError('conflict', 'The campaign status changed meanwhile.');
  }

  return { from: campaign.status, to };
}

// ---------------------------------------------------------------------------
// Campaign day
// ---------------------------------------------------------------------------

/** One slot by its address. Null when the campaign has no such day. */
export function findCampaignDay(db: CampaignDb, campaignId: string, dayNumber: number) {
  return db.contentCalendar.findUnique({
    where: { campaignId_dayNumber: { campaignId, dayNumber } },
  });
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === '' ? null : value));

const contentPatchSchema = z
  .object({
    theme: optionalText(200),
    contentType: z
      .string()
      .trim()
      .refine(isCampaignContentType, 'is not a known content type')
      .nullable()
      .optional(),
    headline: optionalText(200),
    supportingText: optionalText(1000),
    cta: optionalText(80),
    imagePrompt: z.string().trim().max(4000).optional(),
    backgroundPrompt: optionalText(4000),
    caption: z.string().trim().max(4000).optional(),
    hashtags: z.string().trim().max(1000).optional(),
  })
  .strict();

export type CampaignDayContentPatch = z.input<typeof contentPatchSchema>;

const contentSelect = {
  theme: true,
  contentType: true,
  headline: true,
  supportingText: true,
  cta: true,
  imagePrompt: true,
  backgroundPrompt: true,
  caption: true,
  hashtags: true,
} satisfies Prisma.ContentCalendarSelect;

export interface DayEditResult {
  changedFields: CampaignDayContentField[];
  /** True when the edit made existing posters of this day outdated. */
  revisionBumped: boolean;
  contentRevision: number;
}

/**
 * Edits one campaign day's content. Touches exactly one row.
 *
 * A change to any poster input bumps `contentRevision`, which makes every
 * existing version of this day outdated without modifying any of them. A
 * caption or hashtag change does not.
 *
 * @param options.expectedRevision Reject the edit if the day's revision has
 *   moved since the caller read it (an editor's stale form).
 */
export async function updateCampaignDayContent(
  db: CampaignDb,
  dayId: string,
  patch: CampaignDayContentPatch,
  options: { expectedRevision?: number } = {},
): Promise<DayEditResult> {
  const clean = parseInput(contentPatchSchema, patch) as Partial<CampaignDayContent>;

  const day = await db.contentCalendar.findUnique({
    where: { id: dayId },
    select: {
      ...contentSelect,
      campaignId: true,
      contentRevision: true,
      campaign: { select: { status: true } },
    },
  });
  if (!day) throw new CampaignDomainError('not-found', 'Campaign day does not exist.');
  if (!day.campaignId || !day.campaign) {
    throw new CampaignDomainError('not-a-campaign-day', 'This calendar row is not part of a campaign.');
  }
  if (!campaignAllowsChanges(day.campaign.status)) {
    throw new CampaignDomainError('campaign-closed', `The campaign is ${day.campaign.status}.`);
  }
  if (options.expectedRevision !== undefined && options.expectedRevision !== day.contentRevision) {
    throw new CampaignDomainError('conflict', 'This day was changed by someone else.');
  }

  const changedFields = changedContentFields(day, clean);
  if (changedFields.length === 0) {
    return { changedFields, revisionBumped: false, contentRevision: day.contentRevision };
  }

  const revisionBumped = touchesPosterInputs(changedFields);
  const data: Prisma.ContentCalendarUpdateManyMutationInput = {};
  for (const field of changedFields) {
    Object.assign(data, { [field]: clean[field] });
  }
  if (revisionBumped) data.contentRevision = { increment: 1 };

  const updated = await db.contentCalendar.updateMany({
    where: { id: dayId, contentRevision: day.contentRevision },
    data,
  });
  if (updated.count === 0) {
    throw new CampaignDomainError('conflict', 'This day was changed by someone else.');
  }

  return {
    changedFields,
    revisionBumped,
    contentRevision: day.contentRevision + (revisionBumped ? 1 : 0),
  };
}

export interface TemplateMappingResult {
  effectiveTemplateId: string | null;
  revisionBumped: boolean;
}

/** The operator's template for one day (MANUAL mapping, or an override under AUTO). */
export function selectDayTemplate(
  db: CampaignDb,
  dayId: string,
  templateId: string | null,
): Promise<TemplateMappingResult> {
  return mapDayTemplate(db, dayId, templateId, 'posterTemplateId');
}

/** The AUTO mapper's template for one day. Stored as a hint under MANUAL. */
export function suggestDayTemplate(
  db: CampaignDb,
  dayId: string,
  templateId: string | null,
): Promise<TemplateMappingResult> {
  return mapDayTemplate(db, dayId, templateId, 'suggestedTemplateId');
}

async function mapDayTemplate(
  db: CampaignDb,
  dayId: string,
  templateId: string | null,
  field: 'posterTemplateId' | 'suggestedTemplateId',
): Promise<TemplateMappingResult> {
  const day = await db.contentCalendar.findUnique({
    where: { id: dayId },
    select: {
      campaignId: true,
      contentRevision: true,
      posterTemplateId: true,
      suggestedTemplateId: true,
      campaign: { select: { status: true, categoryId: true, templateMappingMode: true } },
    },
  });
  if (!day) throw new CampaignDomainError('not-found', 'Campaign day does not exist.');
  if (!day.campaign) {
    throw new CampaignDomainError('not-a-campaign-day', 'This calendar row is not part of a campaign.');
  }
  if (!campaignAllowsChanges(day.campaign.status)) {
    throw new CampaignDomainError('campaign-closed', `The campaign is ${day.campaign.status}.`);
  }

  const mode = day.campaign.templateMappingMode;
  const before = effectiveTemplateId(mode, day);
  if (day[field] === templateId) return { effectiveTemplateId: before, revisionBumped: false };

  if (templateId !== null) {
    const template = await db.categoryTemplate.findUnique({
      where: { id: templateId },
      select: { categoryId: true, isActive: true },
    });
    if (!template) throw new CampaignDomainError('not-found', 'Template does not exist.');
    const problem = templateAssignmentProblem(template, day.campaign);
    if (problem) {
      throw new CampaignDomainError(
        'template-not-assignable',
        problem === 'wrong-vertical'
          ? "The template belongs to a different vertical from the campaign's."
          : 'The template is inactive.',
      );
    }
  }

  const next =
    field === 'posterTemplateId'
      ? { posterTemplateId: templateId, suggestedTemplateId: day.suggestedTemplateId }
      : { posterTemplateId: day.posterTemplateId, suggestedTemplateId: templateId };
  const after = effectiveTemplateId(mode, next);
  const revisionBumped = before !== after;

  // Restating both template columns and the revision makes a concurrent
  // mapping or content edit a conflict rather than a silent overwrite.
  const updated = await db.contentCalendar.updateMany({
    where: {
      id: dayId,
      contentRevision: day.contentRevision,
      posterTemplateId: day.posterTemplateId,
      suggestedTemplateId: day.suggestedTemplateId,
    },
    data: {
      ...next,
      ...(revisionBumped ? { contentRevision: { increment: 1 } } : {}),
    },
  });
  if (updated.count === 0) {
    throw new CampaignDomainError('conflict', 'This day was changed by someone else.');
  }

  return { effectiveTemplateId: after, revisionBumped };
}

/**
 * Claims a generation status change on one day: applied only if the day is
 * still in `from`. Returns false when another worker got there first.
 *
 * Moving to QUEUED also requires the campaign to allow generation. FAILED
 * records `errorMessage`; a new QUEUED clears it.
 */
export async function transitionGenerationStatus(
  db: CampaignDb,
  dayId: string,
  from: PosterGenerationStatus,
  to: PosterGenerationStatus,
  options: { errorMessage?: string } = {},
): Promise<boolean> {
  if (!canTransitionGeneration(from, to)) {
    throw new CampaignDomainError('invalid-transition', `Generation cannot go from ${from} to ${to}.`);
  }

  const updated = await db.contentCalendar.updateMany({
    where: {
      id: dayId,
      campaignId: { not: null },
      generationStatus: from,
      ...(to === 'QUEUED'
        ? { campaign: { status: { in: [...GENERATION_CAMPAIGN_STATUSES] } } }
        : {}),
    },
    data: {
      generationStatus: to,
      ...(to === 'FAILED' ? { errorMessage: options.errorMessage ?? 'Generation failed.' } : {}),
      ...(to === 'QUEUED' ? { errorMessage: null } : {}),
    },
  });
  return updated.count === 1;
}

// ---------------------------------------------------------------------------
// Poster versions
// ---------------------------------------------------------------------------

const addVersionSchema = z
  .object({
    calendarDayId: z.string().uuid(),
    source: z.enum(['PIPELINE', 'POSTER_STUDIO', 'MANUAL_UPLOAD']),
    // A Drive file id — never image bytes. Refuses a data URI outright.
    imageDriveFileId: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .refine((value) => !value.startsWith('data:'), 'must be a Drive file id, not image data'),
    imageMimeType: z.string().trim().min(1).max(100),
    width: z.number().int().positive().nullable().optional(),
    height: z.number().int().positive().nullable().optional(),
    contentRevision: z.number().int().min(1),
    templateId: z.string().uuid().nullable().optional(),
    parentVersionId: z.string().uuid().nullable().optional(),
    studioGenerationId: z.string().uuid().nullable().optional(),
    /** Default true. Subject to `shouldAutoActivate`. */
    activate: z.boolean().optional(),
  })
  .refine((value) => (value.source === 'POSTER_STUDIO') === Boolean(value.studioGenerationId), {
    message: 'studioGenerationId is required for POSTER_STUDIO versions and only for them',
    path: ['studioGenerationId'],
  });

export type AddPosterVersionInput = z.input<typeof addVersionSchema>;

export interface AddPosterVersionResult {
  versionId: string;
  versionNumber: number;
  approvalStatus: PosterApprovalStatus;
  activated: boolean;
}

/**
 * Stores a new poster version for one day. Earlier versions are never touched.
 *
 * The version number comes from incrementing the day's `lastPosterVersion`
 * inside the transaction, which also locks the day row, so two concurrent
 * versions cannot receive the same number.
 */
export async function addPosterVersion(
  db: CampaignDb,
  input: AddPosterVersionInput,
): Promise<AddPosterVersionResult> {
  const data = parseInput(addVersionSchema, input);

  return inTransaction(db, async (tx) => {
    let day;
    try {
      day = await tx.contentCalendar.update({
        where: { id: data.calendarDayId },
        data: { lastPosterVersion: { increment: 1 } },
        select: {
          lastPosterVersion: true,
          contentRevision: true,
          activePosterVersion: { select: { contentRevision: true } },
          campaign: { select: { status: true, approvalPolicy: true } },
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new CampaignDomainError('not-found', 'Campaign day does not exist.');
      }
      throw error;
    }

    if (!day.campaign) {
      throw new CampaignDomainError('not-a-campaign-day', 'This calendar row is not part of a campaign.');
    }
    if (!campaignAllowsChanges(day.campaign.status)) {
      throw new CampaignDomainError('campaign-closed', `The campaign is ${day.campaign.status}.`);
    }
    if (data.contentRevision > day.contentRevision) {
      throw new CampaignDomainError(
        'invalid-input',
        `contentRevision ${data.contentRevision} is newer than the day's ${day.contentRevision}.`,
      );
    }

    if (data.parentVersionId) {
      const parent = await tx.posterVersion.findUnique({
        where: { id: data.parentVersionId },
        select: { calendarDayId: true },
      });
      if (!parent || parent.calendarDayId !== data.calendarDayId) {
        throw new CampaignDomainError('invalid-input', 'The parent version belongs to a different day.');
      }
    }

    const approvalStatus = initialApprovalStatus(day.campaign.approvalPolicy);
    const version = await tx.posterVersion.create({
      data: {
        calendarDayId: data.calendarDayId,
        versionNumber: day.lastPosterVersion,
        source: data.source,
        imageDriveFileId: data.imageDriveFileId,
        imageMimeType: data.imageMimeType,
        width: data.width ?? null,
        height: data.height ?? null,
        contentRevision: data.contentRevision,
        templateId: data.templateId ?? null,
        parentVersionId: data.parentVersionId ?? null,
        studioGenerationId: data.studioGenerationId ?? null,
        approvalStatus,
        reviewedAt: approvalStatus === 'APPROVED' ? new Date() : null,
      },
      select: { id: true, versionNumber: true },
    });

    const activated =
      (data.activate ?? true) && shouldAutoActivate(data.contentRevision, day.activePosterVersion);
    if (activated) {
      await tx.contentCalendar.updateMany({
        where: { id: data.calendarDayId },
        data: { activePosterVersionId: version.id },
      });
    }

    return {
      versionId: version.id,
      versionNumber: version.versionNumber,
      approvalStatus,
      activated,
    };
  });
}

/**
 * Makes an existing version the day's active one — an operator's explicit
 * choice, e.g. going back to v1. The previously active version is unchanged
 * and stays in history. Also enforced by the database: the composite key
 * rejects a version from another day.
 */
export async function activatePosterVersion(
  db: CampaignDb,
  dayId: string,
  versionId: string,
): Promise<void> {
  await inTransaction(db, async (tx) => {
    const version = await tx.posterVersion.findUnique({
      where: { id: versionId },
      select: {
        calendarDayId: true,
        calendarDay: { select: { campaign: { select: { status: true } } } },
      },
    });
    if (!version) throw new CampaignDomainError('not-found', 'Poster version does not exist.');
    if (version.calendarDayId !== dayId) {
      throw new CampaignDomainError('invalid-input', 'The poster version belongs to a different day.');
    }
    const status = version.calendarDay.campaign?.status;
    if (!status) {
      throw new CampaignDomainError('not-a-campaign-day', 'This calendar row is not part of a campaign.');
    }
    if (!campaignAllowsChanges(status)) {
      throw new CampaignDomainError('campaign-closed', `The campaign is ${status}.`);
    }

    await tx.contentCalendar.updateMany({
      where: { id: dayId },
      data: { activePosterVersionId: versionId },
    });
  });
}

/**
 * Records a review decision on one version along `APPROVAL_TRANSITIONS`.
 * Approval belongs to the exact image: a later version starts PENDING again
 * under MANUAL_REVIEW.
 */
export async function reviewPosterVersion(
  db: CampaignDb,
  versionId: string,
  decision: PosterApprovalStatus,
  note?: string,
): Promise<void> {
  const version = await db.posterVersion.findUnique({
    where: { id: versionId },
    select: { approvalStatus: true },
  });
  if (!version) throw new CampaignDomainError('not-found', 'Poster version does not exist.');

  if (!canTransitionApproval(version.approvalStatus, decision)) {
    throw new CampaignDomainError(
      'invalid-transition',
      `A ${version.approvalStatus} version cannot become ${decision}.`,
    );
  }

  const updated = await db.posterVersion.updateMany({
    where: { id: versionId, approvalStatus: version.approvalStatus },
    data: {
      approvalStatus: decision,
      reviewedAt: decision === 'PENDING' ? null : new Date(),
      reviewNote: note?.trim() || null,
    },
  });
  if (updated.count === 0) {
    throw new CampaignDomainError('conflict', 'The version was reviewed by someone else meanwhile.');
  }
}
