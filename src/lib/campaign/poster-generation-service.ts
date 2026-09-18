import { Prisma } from '@prisma/client';
import type {
  CampaignApprovalPolicy,
  CampaignContentStatus,
  CampaignDeliveryStatus,
  CampaignStatus,
  PosterApprovalStatus,
  PosterGenerationStatus,
  PosterVersionSource,
} from '@prisma/client';

import { assertStudioImageConfigured, renderStudioImage, type StudioImageRequest, type StudioImageResult } from '@/lib/ai/openai-images';
import { buildClonePrompt, cloneAccentColors, parsePaletteSource } from '@/lib/ai/studio-prompts';
import { checkCloneText } from '@/lib/ai/text-check';
import { SLOT_LOCK_LABELS, slotLockOf } from '@/lib/campaign/board';
import { resolveContentStrategy } from '@/lib/campaign/content-strategy';
import { bookCampaignDayQuietly, type DayBookingOutcome, type DeliveryDeps } from '@/lib/campaign/delivery-service';
import { campaignAllowsChanges, isVersionCurrent } from '@/lib/campaign/model';
import {
  brandCanvasReadiness,
  buildCampaignPosterBrief,
  derivePosterState,
  evaluatePosterEligibility,
  generationWindow,
  isGenerationInProgress,
  isInWindow,
  rejectionGuidance,
  studioAspectFor,
  summarizePosterWindow,
  TEMPLATE_NOT_READ_MESSAGE,
  templateOutputSize,
  templateShapeOf,
  type BrandCanvasReadiness,
  type DayTemplateShape,
  type GenerationWindow,
  type PosterBlockReason,
  type PosterEligibility,
  type PosterRequestMode,
  type PosterState,
  type PosterWindowSummary,
} from '@/lib/campaign/poster-generation';
import {
  activatePosterVersion,
  addPosterVersion,
  CampaignDomainError,
  reviewPosterVersion,
  runInCampaignTransaction,
  type CampaignDb,
} from '@/lib/campaign/service';
import { dayMappingState, diagnoseUnmapped, type DayMappingState, type MappingIssue } from '@/lib/campaign/template-mapping';
import { loadMappingContext } from '@/lib/campaign/template-mapping-service';
import { MissingEnvError, optionalEnv } from '@/lib/env';
import { resolveImageSizePreset } from '@/lib/image-sizes';
import { hasBrandCanvasLogo, resolveStudioLogo, type ResolvedStudioLogo } from '@/lib/poster-studio/brand-logo';
import { loadStudioBrandCanvas, type StudioBrandCanvas } from '@/lib/poster-studio/brand-context';
import { composeCloneIdentity, type CloneIdentityInput } from '@/lib/poster-studio/clone-identity';
import { cloneSizeFor, type CloneSize } from '@/lib/poster-studio/clone-size';
import { StudioError, type StudioErrorKind } from '@/lib/poster-studio/errors';
import { prepareCloneTemplateImage, readStudioImageSize } from '@/lib/poster-studio/images';
import type { StudioAspectRatio } from '@/lib/poster-studio/limits';
import { readStudioFile, resolveStudioFolder, storeStudioFile, trashStudioFiles } from '@/lib/poster-studio/storage';
import { getAppTimeZone } from '@/lib/time';
import {
  legacyContentFields,
  materializeDayElements,
  parseDayPosterElements,
  parseTemplateElements,
  resolveDayElements,
  type CloneBrandValues,
  type TextCheckResult,
} from '@/lib/types/template-elements';
import { recordOpenAiImageUsage, type UsageContext } from '@/lib/usage';

/**
 * Rolling campaign poster generation — database operations of Phase 4, in clone
 * mode since the template-clone Phase 2.
 *
 * **A campaign poster is its template, cloned.** The day's template is attached
 * to an image edit and reproduced exactly, with only a numbered list of its
 * elements changed — the day's words, a new photograph, and the client's
 * identity in place of the template's:
 *
 *   Brand Canvas (`loadStudioBrandCanvas`, logo resolved before any spend)
 *   → Drive folder (`resolveStudioFolder`) → the template's read elements
 *   (`CategoryTemplate.elements`) and the day's values for them
 *   (`ContentCalendar.posterElements`; when absent, a fresh clone seeded with
 *   the day's existing headline, supporting text and CTA)
 *   → `resolveDayElements` → CLONE prompt (`buildClonePrompt`) → the template
 *   image at its own shape's size → gpt-image-2 at `high` (`renderStudioImage`)
 *   → usage → decode check → the client's exact logo composited into the
 *   template's logo box (`composeCloneIdentity`) → RAW and FINAL files in Drive
 *   → text read-back (`checkCloneText`) → a CLONE `PosterStudioGeneration` row
 *   and a `PosterVersion` (`addPosterVersion`), which becomes the day's active
 *   version → headline, supporting text and CTA synced from the elements.
 *
 * A day whose template has not been read is refused (`template-not-read`): the
 * old "template as inspiration" path is retired for campaigns.
 *
 * The studio row is the record of the artwork — raw file, final file, prompts,
 * model — so the raw/final separation, the protected image route and Poster
 * Studio history apply to campaign posters unchanged. The version is the
 * campaign's record: which image represents the day, from which content
 * revision and template, its text check and its approval.
 *
 * Nothing here sends a WhatsApp message or touches the legacy delivery columns.
 */

// ---------------------------------------------------------------------------
// Dependencies — the real pipeline by default, replaceable in tests
// ---------------------------------------------------------------------------

export interface PosterGenerationDeps {
  assertConfigured(): void;
  loadBrandCanvas(clientId: string): Promise<StudioBrandCanvas>;
  /** The client's Brand Canvas logo as a clone composites it; null when Brand Canvas has none. */
  resolveLogo(canvas: StudioBrandCanvas): Promise<ResolvedStudioLogo | null>;
  resolveFolder(companyName: string): Promise<string>;
  readFile(fileId: string): Promise<Buffer>;
  /** The template image as the edit request carries it, at the clone's output size. */
  prepareTemplate(bytes: Buffer, size: CloneSize): Promise<{ bytes: Buffer; mimeType: string }>;
  render(request: StudioImageRequest): Promise<StudioImageResult>;
  recordUsage(usage: StudioImageResult['usage'], model: string, context: UsageContext): Promise<void>;
  readImageSize(bytes: Buffer): Promise<{ width: number; height: number } | null>;
  composeIdentity(raw: Buffer, input: CloneIdentityInput): Promise<Buffer>;
  checkText(input: Parameters<typeof checkCloneText>[0]): Promise<TextCheckResult>;
  store(input: { folderId: string; fileName: string; body: Buffer; mimeType: string }): Promise<string>;
  trash(fileIds: readonly string[]): Promise<void>;
}

/** The logo a clone composites: Brand Canvas's own file, in the background mode Brand Canvas chose. */
export async function resolveCampaignCloneLogo(canvas: StudioBrandCanvas): Promise<ResolvedStudioLogo | null> {
  if (!hasBrandCanvasLogo(canvas.logo)) return null;
  return resolveStudioLogo(canvas.logo, canvas.logo.logoBackgroundRemoved ? 'REMOVED' : 'ORIGINAL');
}

export const defaultPosterGenerationDeps: PosterGenerationDeps = {
  assertConfigured: assertStudioImageConfigured,
  loadBrandCanvas: loadStudioBrandCanvas,
  resolveLogo: resolveCampaignCloneLogo,
  resolveFolder: resolveStudioFolder,
  readFile: readStudioFile,
  prepareTemplate: prepareCloneTemplateImage,
  render: renderStudioImage,
  recordUsage: recordOpenAiImageUsage,
  readImageSize: readStudioImageSize,
  composeIdentity: composeCloneIdentity,
  checkText: checkCloneText,
  store: storeStudioFile,
  trash: trashStudioFiles,
};

/** The Brand Canvas values a clone binds its identity elements to. */
export function cloneBrandValues(canvas: StudioBrandCanvas, hasLogo: boolean): CloneBrandValues {
  return {
    companyName: canvas.companyName,
    tagline: canvas.tagline,
    phone: canvas.phone,
    website: canvas.website,
    hasLogo,
    logoIncludesName: canvas.logoIncludesName,
  };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface PosterVersionSummary {
  id: string;
  versionNumber: number;
  source: PosterVersionSource;
  contentRevision: number;
  approvalStatus: PosterApprovalStatus;
  /** The review decision's note — Phase 5 stores the rejection reason here. */
  reviewNote: string | null;
  studioGenerationId: string | null;
  templateId: string | null;
  createdAt: Date;
}

export interface PosterDay {
  id: string;
  dayNumber: number;
  scheduledDate: Date;
  contentStatus: CampaignContentStatus;
  contentRevision: number;
  theme: string | null;
  contentType: string | null;
  contentTypeLabel: string | null;
  headline: string | null;
  supportingText: string | null;
  cta: string | null;
  imagePrompt: string;
  posterTemplateId: string | null;
  suggestedTemplateId: string | null;
  generationStatus: PosterGenerationStatus | null;
  posterGenerationStartedAt: Date | null;
  errorMessage: string | null;
  /** The day's delivery status, when it has a booking: a sent or sending day is never regenerated. */
  deliveryStatus: CampaignDeliveryStatus | null;
  activeVersion: PosterVersionSummary | null;
  versionCount: number;
  mapping: DayMappingState;
  unmappedReason: MappingIssue | null;
  templateLabel: string | null;
  /** The effective template's clone facts: read or not, and its measured shape. Null with no template row. */
  template: DayTemplateShape | null;
  /** The clone's output size, from the template's shape; null when it has none. */
  outputSize: CloneSize | null;
  inWindow: boolean;
  generating: boolean;
  state: PosterState;
  /** Rolling-window eligibility for the two batch requests. */
  upcoming: PosterEligibility;
  missing: PosterEligibility;
}

export interface PosterOverview {
  campaign: {
    id: string;
    clientId: string;
    name: string;
    status: CampaignStatus;
    approvalPolicy: CampaignApprovalPolicy;
    generationWindowDays: number;
    durationDays: number;
  };
  companyName: string;
  now: Date;
  window: GenerationWindow;
  brandCanvas: BrandCanvasReadiness;
  days: PosterDay[];
  /** Over the days inside the rolling window. */
  summary: PosterWindowSummary;
}

export interface PosterLoadOptions {
  now?: Date;
  timeZone?: string;
}

export async function loadPosterOverview(db: CampaignDb, campaignId: string, options: PosterLoadOptions = {}): Promise<PosterOverview> {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? getAppTimeZone();

  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      clientId: true,
      name: true,
      status: true,
      approvalPolicy: true,
      generationWindowDays: true,
      durationDays: true,
      client: { select: { companyName: true } },
      category: { select: { contentStrategy: true } },
      days: {
        orderBy: { dayNumber: 'asc' },
        select: {
          id: true,
          dayNumber: true,
          scheduledDate: true,
          contentStatus: true,
          contentRevision: true,
          theme: true,
          contentType: true,
          headline: true,
          supportingText: true,
          cta: true,
          imagePrompt: true,
          posterTemplateId: true,
          suggestedTemplateId: true,
          generationStatus: true,
          posterGenerationStartedAt: true,
          errorMessage: true,
          delivery: { select: { status: true } },
          _count: { select: { posterVersions: true } },
          activePosterVersion: {
            select: { id: true, versionNumber: true, source: true, contentRevision: true, approvalStatus: true, reviewNote: true, studioGenerationId: true, templateId: true, createdAt: true },
          },
        },
      },
    },
  });
  if (!campaign) throw new CampaignDomainError('not-found', 'Campaign does not exist.');

  // The mapping rules decide each day's template; its shape is no longer checked
  // against the client's output preset (target aspect 0 matches every shape),
  // because a clone comes out in its template's own shape.
  const context = await loadMappingContext(db, campaignId);
  const target = { ...context.target, aspect: 0, aspectLabel: 'template shape' };
  const templatesById = new Map(context.templates.map((template) => [template.id, template]));
  const contextDays = new Map(context.days.map((day) => [day.id, day]));
  const states = new Map(
    campaign.days.map((day) => [
      day.id,
      dayMappingState(
        contextDays.get(day.id) ?? { id: day.id, dayNumber: day.dayNumber, contentType: day.contentType, posterTemplateId: day.posterTemplateId, suggestedTemplateId: day.suggestedTemplateId },
        templatesById,
        target,
      ),
    ]),
  );
  const unmapped = diagnoseUnmapped(context.templates, target);
  const shapes = await loadTemplateShapes(db, [...new Set([...states.values()].map((state) => state.templateId).filter((id): id is string => id !== null))]);

  const window = generationWindow(now, campaign.generationWindowDays, timeZone);
  const brandCanvas = brandCanvasReadiness({ companyName: campaign.client.companyName });
  const { strategy } = resolveContentStrategy(campaign.category.contentStrategy);
  const labels = new Map(context.templates.map((template) => [template.id, template.label]));

  const days: PosterDay[] = campaign.days.map((day) => {
    const state = states.get(day.id)!;
    const unmappedReason = state.templateId ? null : unmapped;
    const template = state.templateId ? (shapes.get(state.templateId) ?? null) : null;
    const generating = isGenerationInProgress(day.generationStatus, day.posterGenerationStartedAt, now, campaign.status);
    const common = {
      explicit: false,
      now,
      window,
      campaignStatus: campaign.status,
      scheduledDate: day.scheduledDate,
      mapping: state,
      unmappedReason,
      template,
      brandCanvas,
      generationStatus: day.generationStatus,
      generationStartedAt: day.posterGenerationStartedAt,
      dayRevision: day.contentRevision,
      activeVersion: day.activePosterVersion,
      deliveryStatus: day.delivery?.status ?? null,
    } as const;
    const upcoming = evaluatePosterEligibility({ ...common, mode: 'upcoming' });
    const regenerate = evaluatePosterEligibility({ ...common, mode: 'regenerate', explicit: true });
    return {
      id: day.id,
      dayNumber: day.dayNumber,
      scheduledDate: day.scheduledDate,
      contentStatus: day.contentStatus ?? 'NOT_GENERATED',
      contentRevision: day.contentRevision,
      theme: day.theme,
      contentType: day.contentType,
      contentTypeLabel: day.contentType ? (strategy.pillars.find((pillar) => pillar.key === day.contentType)?.label ?? day.contentType) : null,
      headline: day.headline,
      supportingText: day.supportingText,
      cta: day.cta,
      imagePrompt: day.imagePrompt,
      posterTemplateId: day.posterTemplateId,
      suggestedTemplateId: day.suggestedTemplateId,
      generationStatus: day.generationStatus,
      posterGenerationStartedAt: day.posterGenerationStartedAt,
      errorMessage: day.errorMessage,
      deliveryStatus: day.delivery?.status ?? null,
      activeVersion: day.activePosterVersion,
      versionCount: day._count.posterVersions,
      mapping: state,
      unmappedReason,
      templateLabel: state.templateId ? (labels.get(state.templateId) ?? null) : null,
      template,
      outputSize: templateOutputSize(template),
      inWindow: isInWindow(day.scheduledDate, window),
      generating,
      state: derivePosterState({
        generating,
        lastAttemptFailed: day.generationStatus === 'FAILED',
        dayRevision: day.contentRevision,
        activeVersion: day.activePosterVersion,
        attention: !regenerate.eligible && regenerate.attention,
      }),
      upcoming,
      missing: evaluatePosterEligibility({ ...common, mode: 'missing' }),
    };
  });

  return {
    campaign: {
      id: campaign.id,
      clientId: campaign.clientId,
      name: campaign.name,
      status: campaign.status,
      approvalPolicy: campaign.approvalPolicy,
      generationWindowDays: campaign.generationWindowDays,
      durationDays: campaign.durationDays,
    },
    companyName: campaign.client.companyName,
    now,
    window,
    brandCanvas,
    days,
    summary: summarizePosterWindow(days.filter((day) => day.inWindow).map((day) => ({ state: day.state, unmapped: day.mapping.templateId === null }))),
  };
}

/**
 * Clone facts for templates by id: label, whether the elements were read, and
 * the measured size (the read's own size when the upload was not measured).
 */
export async function loadTemplateShapes(db: CampaignDb, templateIds: readonly string[]): Promise<Map<string, DayTemplateShape>> {
  if (templateIds.length === 0) return new Map();
  const rows = await db.categoryTemplate.findMany({
    where: { id: { in: [...templateIds] } },
    select: { id: true, label: true, width: true, height: true, elements: true },
  });
  return new Map(rows.map((row) => [row.id, templateShapeOf(row)]));
}


/** One day's eligibility under one request — what a per-day Generate or Regenerate button would do. */
export function eligibilityFor(
  overview: PosterOverview,
  day: PosterDay,
  mode: PosterRequestMode,
  explicit: boolean,
  options: { acceptQueued?: boolean } = {},
): PosterEligibility {
  return evaluatePosterEligibility({
    mode,
    explicit,
    acceptQueued: options.acceptQueued,
    now: overview.now,
    window: overview.window,
    campaignStatus: overview.campaign.status,
    scheduledDate: day.scheduledDate,
    mapping: day.mapping,
    unmappedReason: day.unmappedReason,
    template: day.template,
    brandCanvas: overview.brandCanvas,
    generationStatus: day.generationStatus,
    generationStartedAt: day.posterGenerationStartedAt,
    dayRevision: day.contentRevision,
    activeVersion: day.activeVersion,
    deliveryStatus: day.deliveryStatus,
  });
}

// ---------------------------------------------------------------------------
// Batch planning
// ---------------------------------------------------------------------------

export interface PosterBatchRequest {
  mode: PosterRequestMode;
  /** An explicit day-number range; without one the rolling window is used. */
  fromDay?: number;
  toDay?: number;
  /**
   * Explicit days by id — the posts in view on the board. Takes precedence over
   * a range; ids that are not days of this campaign are ignored.
   */
  dayIds?: readonly string[];
}

export interface PosterBatchPlan {
  mode: PosterRequestMode;
  explicit: boolean;
  /** In day order. One generation each. */
  days: Array<{ dayId: string; dayNumber: number; action: 'generate' | 'regenerate'; retry: boolean }>;
  estimatedGenerations: number;
  /** Days in scope that will not be generated, grouped by reason. */
  skipped: Array<{ reason: PosterBlockReason; message: string; attention: boolean; dayNumbers: number[] }>;
}

/**
 * The days one batch request would generate, and why every other day in scope
 * would not. Writes nothing and calls nothing: this is what the confirmation
 * shows before any money is spent.
 */
export function planPosterBatch(overview: PosterOverview, request: PosterBatchRequest): PosterBatchPlan {
  const byIds = request.dayIds !== undefined;
  const explicit = byIds || request.fromDay !== undefined || request.toDay !== undefined;
  const from = request.fromDay ?? 1;
  const to = request.toDay ?? overview.campaign.durationDays;
  if (!byIds && explicit && (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > overview.campaign.durationDays || from > to)) {
    throw new CampaignDomainError('invalid-input', `Choose a range within days 1–${overview.campaign.durationDays}.`);
  }

  const wanted = byIds ? new Set(request.dayIds) : null;
  const scope = wanted
    ? overview.days.filter((day) => wanted.has(day.id))
    : explicit
      ? overview.days.filter((day) => day.dayNumber >= from && day.dayNumber <= to)
      : overview.days.filter((day) => day.inWindow);

  const plan: PosterBatchPlan = { mode: request.mode, explicit, days: [], estimatedGenerations: 0, skipped: [] };
  const groups = new Map<string, PosterBatchPlan['skipped'][number]>();
  for (const day of scope) {
    const result = eligibilityFor(overview, day, request.mode, explicit);
    if (result.eligible) {
      plan.days.push({ dayId: day.id, dayNumber: day.dayNumber, action: result.action, retry: result.retry });
    } else {
      const key = `${result.reason}|${result.message}`;
      const group = groups.get(key) ?? { reason: result.reason, message: result.message, attention: result.attention, dayNumbers: [] };
      group.dayNumbers.push(day.dayNumber);
      groups.set(key, group);
    }
  }
  plan.estimatedGenerations = plan.days.length;
  plan.skipped = [...groups.values()];
  return plan;
}

// ---------------------------------------------------------------------------
// Generation of one day
// ---------------------------------------------------------------------------

export type GenerateDayPosterResult =
  | { outcome: 'generated'; dayNumber: number; versionId: string; versionNumber: number; generationId: string; approvalStatus: PosterApprovalStatus; message: string }
  | { outcome: 'skipped'; dayNumber: number; reason: PosterBlockReason | 'conflict'; message: string }
  | {
      outcome: 'failed';
      dayNumber: number;
      kind: StudioErrorKind | 'campaign';
      message: string;
      /** Credentials, configuration or billing: every later day would fail the same way, so a batch stops. */
      stopBatch: boolean;
      /** The image was generated (and billed) before the failure. */
      billed: boolean;
    };

const STOP_BATCH_KINDS: ReadonlySet<StudioErrorKind | 'campaign'> = new Set(['config', 'auth', 'access', 'model', 'quota']);

/**
 * Why a finished poster was not saved: its attempt's claim was released as stale
 * and another run claimed the day before the poster could be recorded. Shared
 * with Fix text and Small change (`clone-fix.ts`).
 */
export const CLAIM_LOST_MESSAGE = 'Another run took over this day while its poster was being made, so this poster was not saved.';

export interface GenerateDayPosterOptions extends PosterLoadOptions {
  mode: PosterRequestMode;
  /** The operator named this day or its range; the rolling window does not apply. */
  explicit?: boolean;
  deps?: PosterGenerationDeps;
  /**
   * Take a day that is already QUEUED (Phase 7). Set only by the background
   * worker: an interactive caller must leave a queued day to the queue.
   */
  acceptQueued?: boolean;
  /**
   * Delivery dependencies for the booking sync that follows a new version
   * (`bookCampaignDay`). Defaults to the real ones; tests inject fakes.
   */
  deliveryDeps?: DeliveryDeps;
}

/**
 * Generates one campaign day's poster, if and only if the day is eligible now.
 *
 * Idempotent by construction: eligibility is re-evaluated from fresh rows, and
 * the day is claimed with a conditional update that restates everything the
 * decision was based on (generation status, content revision, active version,
 * both template columns, campaign ACTIVE). A day that already has its poster,
 * or that another run has claimed, is skipped before any provider call — so
 * running a batch twice, double-clicking, or two tabs cannot pay twice or
 * create a second active version. The poster is recorded only while this
 * attempt still holds its claim: if a slow attempt's claim went stale and
 * another run took the day, nothing is recorded (see `CLAIM_LOST_MESSAGE`).
 *
 * A failure leaves the day recoverable: its status is FAILED with the reason,
 * any Drive file written for it is binned, and its previous active poster (if
 * any) is untouched. Nothing is ever retried automatically.
 */
export async function generateCampaignDayPoster(
  db: CampaignDb,
  campaignId: string,
  dayId: string,
  options: GenerateDayPosterOptions,
): Promise<GenerateDayPosterResult> {
  const deps = options.deps ?? defaultPosterGenerationDeps;
  const overview = await loadPosterOverview(db, campaignId, options);
  const day = overview.days.find((candidate) => candidate.id === dayId);
  if (!day) throw new CampaignDomainError('not-found', 'That day is not part of this campaign.');

  const eligibility = eligibilityFor(overview, day, options.mode, options.explicit ?? false, {
    acceptQueued: options.acceptQueued,
  });
  if (!eligibility.eligible) {
    return { outcome: 'skipped', dayNumber: day.dayNumber, reason: eligibility.reason, message: eligibility.message };
  }

  // Cheapest check first, before the claim: without a key nothing can run, and
  // marking every day of a batch FAILED for it would bury the real state.
  try {
    deps.assertConfigured();
  } catch (error) {
    const failure = toStudioError(error);
    return { outcome: 'failed', dayNumber: day.dayNumber, kind: failure.kind, message: failure.message, stopBatch: true, billed: false };
  }

  const startedAt = options.now ?? new Date();
  if (!(await claimDay(db, campaignId, day, startedAt, { acceptQueued: options.acceptQueued }))) {
    return { outcome: 'skipped', dayNumber: day.dayNumber, reason: 'conflict', message: 'This day changed or started generating meanwhile. Refresh and try again.' };
  }

  const written: string[] = [];
  let billed = false;

  try {
    // ---- Pre-flight: everything deterministic, before any spend ------------
    const canvas = await deps.loadBrandCanvas(overview.campaign.clientId);
    const logo = await deps.resolveLogo(canvas);
    const folderId = await deps.resolveFolder(canvas.companyName);

    const template = await db.categoryTemplate.findUnique({
      where: { id: day.mapping.templateId! },
      select: { id: true, label: true, gDriveFileId: true, width: true, height: true, elements: true, paletteSource: true },
    });
    if (!template) throw new StudioError('validation', 'The mapped template no longer exists. Map another template to this day.');
    const doc = parseTemplateElements(template.elements);
    if (!doc) throw new StudioError('validation', TEMPLATE_NOT_READ_MESSAGE);
    const output = templateOutputSize(templateShapeOf(template));
    if (!output) throw new StudioError('validation', `Template “${template.label}” has a shape clones cannot be made in. Use another template.`);

    // The day's values for the template's elements: reconciled when stored; when
    // it has none yet, a fresh clone seeded with the day's existing headline,
    // supporting text and CTA — never the template's words over them; and a
    // fresh clone when they were cloned from another template.
    const dayRow = await db.contentCalendar.findUnique({
      where: { id: day.id },
      select: { posterElements: true, imagePrompt: true, contentStatus: true, headline: true, supportingText: true, cta: true },
    });
    if (!dayRow) throw new CampaignDomainError('not-found', 'Campaign day does not exist.');
    const stored = parseDayPosterElements(dayRow.posterElements);
    const elements = materializeDayElements(doc, stored, template.id, dayRow, { businessName: canvas.companyName });
    const resolved = resolveDayElements(doc, elements, cloneBrandValues(canvas, logo !== null), dayRow.imagePrompt);
    const legacy = legacyContentFields(resolved);

    /*
     * Regenerating a rejected poster carries the reviewer's reason into the new
     * attempt (Phase 7 §15) — but only when the version being replaced is the
     * one that was rejected, and only that note. An approved or merely outdated
     * poster contributes nothing, and no earlier rejection is ever resurfaced.
     */
    const sentPrompt = buildClonePrompt({
      resolved,
      brandColors: cloneAccentColors(canvas.brand.colors),
      // A festival template keeps its own palette; everything else recolours to the brand.
      paletteSource: parsePaletteSource(template.paletteSource),
      identity: 'ai',
      orientation: output.orientation,
      correction: rejectionGuidance(day.activeVersion?.approvalStatus === 'REJECTED' ? day.activeVersion.reviewNote : null),
    });

    let templateImage: { bytes: Buffer; mimeType: string };
    try {
      templateImage = await deps.prepareTemplate(await deps.readFile(template.gDriveFileId), output);
    } catch (error) {
      const cause = toStudioError(error);
      throw new StudioError(
        cause.kind === 'storage' ? 'storage' : 'invalid-image',
        `The template "${template.label}" could not be loaded, so nothing was generated. ${cause.message}`,
        { cause: error },
      );
    }

    // Materialise the day's clone before spending, restating the revision so a
    // concurrent edit is never overwritten. A clone's content is ready content.
    if (JSON.stringify(stored) !== JSON.stringify(elements) || dayRow.contentStatus !== 'READY') {
      await db.contentCalendar.updateMany({
        where: { id: day.id, contentRevision: day.contentRevision },
        data: { posterElements: elements as unknown as Prisma.InputJsonValue, contentStatus: 'READY', contentIssues: [] },
      });
    }

    // ---- Spend ---------------------------------------------------------------
    const rendered = await deps.render({ prompt: sentPrompt, size: output.size, image: templateImage, quality: 'high' });
    billed = true;
    await deps.recordUsage(rendered.usage, rendered.model, { clientId: overview.campaign.clientId, calendarId: day.id });

    const dimensions = await deps.readImageSize(rendered.bytes);
    if (!dimensions) {
      throw new StudioError('provider', 'OpenAI returned an image that could not be read. Nothing was saved — try again.');
    }

    let finalBytes: Buffer;
    try {
      // The day's own logo placement, so a regeneration keeps where the admin put the mark.
      finalBytes = await deps.composeIdentity(rendered.bytes, { resolved, logo, drawIdentityText: false, placement: elements.logo ?? null });
    } catch (error) {
      // A campaign poster without the client's exact logo is not a poster the
      // client can receive, so it is not kept as one.
      throw new StudioError('composition', "The client's logo could not be placed on the cloned poster, so nothing was saved.", { cause: error });
    }
    const logoPlaced = logo !== null && resolved.some((item) => item.action.type === 'logo');

    // ---- Storage: RAW and FINAL, separately ---------------------------------
    const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
    const base = `campaign-day-${day.dayNumber}-${stamp}`;
    const rawFileId = await deps.store({ folderId, fileName: `${base}-raw.${extensionFor(rendered.mimeType)}`, body: rendered.bytes, mimeType: rendered.mimeType });
    written.push(rawFileId);
    const finalFileId = await deps.store({ folderId, fileName: `${base}-final.png`, body: finalBytes, mimeType: 'image/png' });
    written.push(finalFileId);

    // ---- Text check: a read-back of the finished poster ------------------------
    // Advisory. A failed check never fails the poster: it is stored unchecked.
    let textCheck: TextCheckResult | null = null;
    try {
      textCheck = await deps.checkText({
        bytes: finalBytes,
        mimeType: 'image/png',
        resolved,
        templateDoc: doc,
        bill: { clientId: overview.campaign.clientId, calendarId: day.id },
      });
    } catch (error) {
      console.error(
        `[campaign:posters] text check failed for day ${day.dayNumber}; the poster is saved unchecked:`,
        error instanceof Error ? error.message : error,
      );
    }

    // ---- Record: studio row + immutable version + status, atomically --------
    const saved = await runInCampaignTransaction(db, async (tx) => {
      /*
       * The claim is settled FIRST, restating this attempt's token. A slow step
       * (the render, the text check) can outlast the claim: another run may then
       * have released it as stale and claimed the day itself. That run owns the
       * day now, so this poster must not become a version beside its own — the
       * transaction is abandoned before anything is written, the catch below
       * bins this attempt's files, and its FAILED update (guarded by the same
       * token) leaves the other run's claim alone.
       */
      const settled = await tx.contentCalendar.updateMany({
        where: { id: day.id, generationStatus: 'GENERATING', posterGenerationStartedAt: startedAt },
        data: { generationStatus: 'SUCCEEDED', errorMessage: null },
      });
      if (settled.count === 0) throw new CampaignDomainError('conflict', CLAIM_LOST_MESSAGE);

      const generation = await tx.posterStudioGeneration.create({
        data: {
          mode: 'CLONE',
          prompt: `Clone of template “${template.label}”${dayRow.imagePrompt.trim() ? ` — photo: ${dayRow.imagePrompt.trim()}` : ''}`.slice(0, 4_000),
          sentPrompt,
          aspectRatio: output.aspectLabel,
          size: output.size,
          model: rendered.model,
          quality: rendered.quality,
          textFree: false,
          imageDriveFileId: rawFileId,
          imageMimeType: rendered.mimeType,
          width: dimensions.width,
          height: dimensions.height,
          finalImageDriveFileId: finalFileId,
          finalImageMimeType: 'image/png',
          overlayElements: logoPlaced ? ['logo'] : [],
          overlayPreset: logoPlaced ? 'clone-identity' : null,
          logoBackground: logoPlaced && logo ? logo.background : null,
          clientId: overview.campaign.clientId,
          sourceTemplateId: template.id,
        },
        select: { id: true },
      });
      const version = await addPosterVersion(tx, {
        calendarDayId: day.id,
        source: 'PIPELINE',
        imageDriveFileId: finalFileId,
        imageMimeType: 'image/png',
        width: dimensions.width,
        height: dimensions.height,
        contentRevision: day.contentRevision,
        templateId: template.id,
        studioGenerationId: generation.id,
        textCheck,
      });
      // The day's headline, supporting text and CTA follow its elements, so
      // review, captions and search keep working. Not a content edit: the poster
      // just made is made from exactly these, so the revision does not move.
      if (legacy.headline !== dayRow.headline || legacy.supportingText !== dayRow.supportingText || legacy.cta !== dayRow.cta) {
        await tx.contentCalendar.updateMany({
          where: { id: day.id, contentRevision: day.contentRevision },
          data: { headline: legacy.headline, supportingText: legacy.supportingText, cta: legacy.cta },
        });
      }
      return { generationId: generation.id, version };
    });

    /*
     * The day's poster changed, so its booking follows: an AUTO_APPROVE version
     * of an ACTIVE campaign is booked (or takes over the old booking), and a
     * PENDING one withdraws a booking pinned to the poster it replaced. After
     * the transaction, and quietly — the poster is saved whatever happens here.
     */
    await bookCampaignDayQuietly(db, day.id, { deps: options.deliveryDeps });

    return {
      outcome: 'generated',
      dayNumber: day.dayNumber,
      versionId: saved.version.versionId,
      versionNumber: saved.version.versionNumber,
      generationId: saved.generationId,
      approvalStatus: saved.version.approvalStatus,
      message: `Day ${day.dayNumber}: v${saved.version.versionNumber} generated${saved.version.approvalStatus === 'APPROVED' ? ' and approved by policy' : ' — needs approval'}.`,
    };
  } catch (error) {
    const failure = error instanceof CampaignDomainError ? new StudioError('validation', error.message, { cause: error }) : toStudioError(error);
    if (failure.kind !== 'validation') console.error(`[campaign:posters] day ${day.dayNumber} failed (${failure.kind}):`, failure.cause ?? failure.message);
    await deps.trash(written);

    // A lost claim belongs to the run that took the day over: this attempt's
    // files are binned above, and the FAILED update below cannot match its claim.
    const claimLost = error instanceof CampaignDomainError && error.code === 'conflict' && error.message === CLAIM_LOST_MESSAGE;
    const message = claimLost
      ? `The image was generated and billed, but ${CLAIM_LOST_MESSAGE.charAt(0).toLowerCase()}${CLAIM_LOST_MESSAGE.slice(1)}`
      : billed
        ? `The image was generated and billed, but ${describeLateFailure(failure)} Nothing was saved; the day can be retried. (${failure.message})`
        : failure.message;
    try {
      await db.contentCalendar.updateMany({
        where: { id: day.id, generationStatus: 'GENERATING', posterGenerationStartedAt: startedAt },
        data: { generationStatus: 'FAILED', errorMessage: message.slice(0, 2000) },
      });
    } catch (statusError) {
      // The claim then goes stale and is released by the next run.
      console.error(`[campaign:posters] could not record the failure of day ${day.dayNumber}:`, statusError);
    }
    return { outcome: 'failed', dayNumber: day.dayNumber, kind: failure.kind, message, stopBatch: STOP_BATCH_KINDS.has(failure.kind), billed };
  }
}

/**
 * Claims one day for one attempt: releases a stale GENERATING claim first, then
 * moves NOT_REQUESTED / SUCCEEDED / FAILED → QUEUED → GENERATING along Phase 1's
 * transition table. The first update restates what eligibility was decided on,
 * so a concurrent change or claim makes it match no row.
 */
async function claimDay(
  db: CampaignDb,
  campaignId: string,
  day: PosterDay,
  startedAt: Date,
  options: { acceptQueued?: boolean } = {},
): Promise<boolean> {
  let from: PosterGenerationStatus = day.generationStatus ?? 'NOT_REQUESTED';
  /*
   * The worker takes only work that is still waiting: a day QUEUED now, or a
   * GENERATING claim left stale by a worker that died. A day it listed earlier
   * that another worker (or the board's own runner) has since finished is
   * SUCCEEDED or FAILED by the time it gets here, and `regenerate` would happily
   * make it again — a second billed render and a new PENDING version replacing
   * an approved one. That is a conflict, never a claim.
   */
  if (options.acceptQueued && from !== 'QUEUED' && from !== 'GENERATING') return false;
  if (from === 'GENERATING') {
    const released = await db.contentCalendar.updateMany({
      where: { id: day.id, generationStatus: 'GENERATING', posterGenerationStartedAt: day.posterGenerationStartedAt },
      data: { generationStatus: 'FAILED', errorMessage: 'The previous attempt was interrupted before it finished.' },
    });
    if (released.count === 0) return false;
    from = 'FAILED';
  }
  if (from === 'QUEUED') {
    /*
     * A day already QUEUED is a request waiting for a worker (Phase 7). Only the
     * background worker may take it — `acceptQueued` is how it says so — and it
     * takes it with the same conditional update everything else uses, so two
     * workers still cannot claim the same day. An interactive caller refuses, as
     * it always has, because the queue is about to run it anyway.
     */
    if (!options.acceptQueued) return false;
    const claimed = await db.contentCalendar.updateMany({
      where: { id: day.id, campaignId, generationStatus: 'QUEUED', campaign: { status: 'ACTIVE' } },
      data: { generationStatus: 'GENERATING', posterGenerationStartedAt: startedAt },
    });
    return claimed.count === 1;
  }

  const queued = await db.contentCalendar.updateMany({
    where: {
      id: day.id,
      campaignId,
      generationStatus: from,
      contentRevision: day.contentRevision,
      activePosterVersionId: day.activeVersion?.id ?? null,
      posterTemplateId: day.posterTemplateId,
      suggestedTemplateId: day.suggestedTemplateId,
      campaign: { status: 'ACTIVE' },
    },
    data: { generationStatus: 'QUEUED', errorMessage: null },
  });
  if (queued.count === 0) return false;

  const generating = await db.contentCalendar.updateMany({
    where: { id: day.id, generationStatus: 'QUEUED' },
    data: { generationStatus: 'GENERATING', posterGenerationStartedAt: startedAt },
  });
  return generating.count === 1;
}

function toStudioError(error: unknown): StudioError {
  if (error instanceof StudioError) return error;
  if (error instanceof MissingEnvError) {
    return new StudioError('config', `The server is missing required configuration (${error.key}).`, { cause: error });
  }
  return new StudioError('provider', 'Something went wrong. The details are in the server log.', { cause: error });
}

function describeLateFailure(failure: StudioError): string {
  switch (failure.kind) {
    case 'storage':
      return 'it could not be saved to Google Drive.';
    case 'database':
      return 'it could not be recorded in the database.';
    case 'composition':
      return "the client's logo could not be placed.";
    default:
      return 'a later step failed.';
  }
}

function extensionFor(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

// ---------------------------------------------------------------------------
// Versions, approval and Poster Studio edits
// ---------------------------------------------------------------------------

export interface CampaignDayPosterVersions {
  dayId: string;
  dayNumber: number;
  campaignId: string;
  clientId: string;
  contentRevision: number;
  activeVersionId: string | null;
  versions: Array<PosterVersionSummary & { active: boolean; current: boolean; hasFinal: boolean; templateLabel: string | null }>;
}

/** Every version of one day, newest first. No Drive ids: images are reached through the studio row. */
export async function listCampaignDayPosterVersions(db: CampaignDb, dayId: string): Promise<CampaignDayPosterVersions> {
  const day = await db.contentCalendar.findUnique({
    where: { id: dayId },
    select: {
      id: true,
      dayNumber: true,
      campaignId: true,
      clientId: true,
      contentRevision: true,
      activePosterVersionId: true,
      posterVersions: {
        orderBy: { versionNumber: 'desc' },
        select: {
          id: true,
          versionNumber: true,
          source: true,
          contentRevision: true,
          approvalStatus: true,
          reviewNote: true,
          studioGenerationId: true,
          templateId: true,
          createdAt: true,
          template: { select: { label: true } },
          studioGeneration: { select: { finalImageDriveFileId: true } },
        },
      },
    },
  });
  if (!day) throw new CampaignDomainError('not-found', 'Campaign day does not exist.');
  if (!day.campaignId) throw new CampaignDomainError('not-a-campaign-day', 'This calendar row is not part of a campaign.');

  return {
    dayId: day.id,
    dayNumber: day.dayNumber,
    campaignId: day.campaignId,
    clientId: day.clientId,
    contentRevision: day.contentRevision,
    activeVersionId: day.activePosterVersionId,
    versions: day.posterVersions.map(({ template, studioGeneration, ...version }) => ({
      ...version,
      active: version.id === day.activePosterVersionId,
      current: isVersionCurrent(version, day),
      hasFinal: Boolean(studioGeneration?.finalImageDriveFileId),
      templateLabel: template?.label ?? null,
    })),
  };
}

export interface PosterVersionActivation {
  /** False when it was already the day's active version and nothing was written. */
  changed: boolean;
  versionNumber: number;
  /** What the re-booking did; null for a no-op, or when the booking itself failed. */
  booking: DayBookingOutcome | null;
}

/**
 * Makes one of the day's existing versions its **active** poster — the version
 * that represents the day, that the board shows and that delivery sends.
 *
 * This is how an admin goes back: three regenerations leave v1, v2 and v3, and
 * choosing v1 here makes v1 the poster again without paying for a fourth image.
 * Nothing is generated, nothing is billed and no version is changed — only the
 * day's pointer moves.
 *
 * Refused for a version of another day, a version with no artwork, a day whose
 * poster is final (sent, sending or past), a day with a generation queued or
 * running, an outdated version (its content no longer matches the day) and a
 * rejected one — a poster that was sent back must be edited or regenerated
 * first, and switching to it would leave the day on a poster nobody may approve.
 *
 * **The already-active version returns cleanly, before any of those refusals.**
 * Approving the day's own poster is allowed on a past day and has never asked
 * about the generation queue, so a no-op that refused would change what Approve
 * does today.
 *
 * The write is guarded on the day's `contentRevision` **and** its current active
 * pointer, so a generation that landed between the read and the write is a
 * conflict rather than something this call silently overwrites. Afterwards the
 * day is re-booked (`bookCampaignDayQuietly`) so delivery re-pins to the version
 * now on show; a booking problem never undoes the switch.
 */
export async function activateCampaignDayPosterVersion(
  db: CampaignDb,
  dayId: string,
  versionId: string,
  options: { deliveryDeps?: DeliveryDeps; now?: Date; timeZone?: string } = {},
): Promise<PosterVersionActivation> {
  const now = options.now ?? new Date();
  const day = await db.contentCalendar.findUnique({
    where: { id: dayId },
    select: {
      id: true,
      dayNumber: true,
      scheduledDate: true,
      contentRevision: true,
      activePosterVersionId: true,
      generationStatus: true,
      posterGenerationStartedAt: true,
      campaign: { select: { status: true, deliveryTime: true } },
      delivery: { select: { status: true, scheduledFor: true } },
      // The version is read through the day, so "belongs to THIS day" is answered
      // by the same query rather than by a second read and a comparison.
      posterVersions: {
        where: { id: versionId },
        select: { id: true, versionNumber: true, contentRevision: true, approvalStatus: true, imageDriveFileId: true },
      },
    },
  });
  if (!day) throw new CampaignDomainError('not-found', 'Campaign day does not exist.');
  if (!day.campaign) throw new CampaignDomainError('not-a-campaign-day', 'This calendar row is not part of a campaign.');
  if (!campaignAllowsChanges(day.campaign.status)) throw new CampaignDomainError('campaign-closed', `The campaign is ${day.campaign.status}.`);

  const version = day.posterVersions[0];
  if (!version) throw new CampaignDomainError('not-found', 'That poster version is not part of this day.');
  if (!version.imageDriveFileId) throw new CampaignDomainError('invalid-transition', 'That version has no artwork to send.');

  // Nothing to do, and deliberately before the refusals below: see the note above.
  if (day.activePosterVersionId === version.id) return { changed: false, versionNumber: version.versionNumber, booking: null };

  const lock = slotLockOf(day, now, options.timeZone ?? getAppTimeZone(), day.campaign.deliveryTime);
  if (lock === 'sent' || lock === 'sending' || lock === 'past') {
    throw new CampaignDomainError('invalid-transition', `${SLOT_LOCK_LABELS[lock]} Its poster can no longer change.`);
  }
  if (day.generationStatus === 'QUEUED' || isGenerationInProgress(day.generationStatus, day.posterGenerationStartedAt, now)) {
    throw new CampaignDomainError('conflict', 'A poster is being generated for this day. Wait for it to finish, then try again.');
  }
  if (!isVersionCurrent(version, day)) {
    throw new CampaignDomainError('invalid-transition', 'This poster is outdated — regenerate it before using it.');
  }
  if (version.approvalStatus === 'REJECTED') {
    throw new CampaignDomainError('invalid-transition', 'This poster was sent back — edit or regenerate it before using it.');
  }

  await runInCampaignTransaction(db, async (tx) => {
    const switched = await tx.contentCalendar.updateMany({
      where: { id: day.id, contentRevision: day.contentRevision, activePosterVersionId: day.activePosterVersionId },
      data: { activePosterVersionId: version.id },
    });
    if (switched.count === 0) throw new CampaignDomainError('conflict', 'This day was changed by someone else. Reload it and try again.');
  });

  return {
    changed: true,
    versionNumber: version.versionNumber,
    booking: await bookCampaignDayQuietly(db, day.id, { deps: options.deliveryDeps }),
  };
}

/**
 * Approves the day's active poster — the one version that represents the day.
 *
 * Refused for an outdated poster (its content no longer matches the day) and
 * for a rejected one (it was sent back; edit or regenerate first). Approving an
 * already approved poster changes nothing, so a bulk run is safe to repeat.
 *
 * **Approving books the day.** In an ACTIVE campaign the approved poster is
 * booked for delivery straight away (`bookCampaignDay`, through the full
 * delivery gate), so nobody has to press Schedule. The booking runs after the
 * approval is recorded and never undoes it: a paused campaign, missing WhatsApp
 * configuration or a booking error leave the poster approved and unbooked, and
 * the cron sweep's sync books it once it can.
 *
 * Returns what the booking did (null when the poster was already approved, or
 * the booking itself failed), so the caller can say when the poster goes out.
 */
export async function approveCampaignDayPoster(
  db: CampaignDb,
  dayId: string,
  versionId: string,
  options: { deliveryDeps?: DeliveryDeps } = {},
): Promise<{ booking: DayBookingOutcome | null }> {
  const day = await db.contentCalendar.findUnique({
    where: { id: dayId },
    select: {
      contentRevision: true,
      activePosterVersionId: true,
      campaign: { select: { status: true } },
      activePosterVersion: { select: { contentRevision: true, approvalStatus: true } },
    },
  });
  if (!day?.campaign) throw new CampaignDomainError('not-found', 'Campaign day does not exist.');
  if (!campaignAllowsChanges(day.campaign.status)) throw new CampaignDomainError('campaign-closed', `The campaign is ${day.campaign.status}.`);
  if (day.activePosterVersionId !== versionId || !day.activePosterVersion) {
    throw new CampaignDomainError('conflict', 'That poster is no longer the active one for this day. Refresh and review again.');
  }
  if (!isVersionCurrent(day.activePosterVersion, day)) {
    throw new CampaignDomainError('invalid-transition', 'This poster is outdated — regenerate it before approving.');
  }
  if (day.activePosterVersion.approvalStatus === 'APPROVED') return { booking: null };
  if (day.activePosterVersion.approvalStatus === 'REJECTED') {
    throw new CampaignDomainError('invalid-transition', 'This poster was rejected — edit or regenerate it before approving.');
  }
  await reviewPosterVersion(db, versionId, 'APPROVED');
  return { booking: await bookCampaignDayQuietly(db, dayId, { deps: options.deliveryDeps, reapproved: true }) };
}

/**
 * Saves a Poster Studio poster — typically an Edit of the day's active poster —
 * to a campaign day as a new POSTER_STUDIO version, which becomes active.
 *
 * Refused for a poster made for a different client or in a different format from
 * the campaign's. Saving the same studio poster twice returns the version it
 * already created rather than a duplicate.
 */
export async function saveStudioPosterToCampaignDay(
  db: CampaignDb,
  dayId: string,
  generationId: string,
  options: { deliveryDeps?: DeliveryDeps } = {},
): Promise<{ versionId: string; versionNumber: number; alreadySaved: boolean }> {
  const saved = await runInCampaignTransaction(db, async (tx) => {
    const day = await tx.contentCalendar.findUnique({
      where: { id: dayId },
      select: {
        id: true,
        dayNumber: true,
        campaignId: true,
        clientId: true,
        contentRevision: true,
        contentStatus: true,
        contentIssues: true,
        posterTemplateId: true,
        suggestedTemplateId: true,
        activePosterVersion: { select: { id: true, templateId: true } },
        campaign: { select: { status: true, templateMappingMode: true } },
        client: { select: { imageSizePreset: true } },
      },
    });
    if (!day) throw new CampaignDomainError('not-found', 'Campaign day does not exist.');
    if (!day.campaignId || !day.campaign) throw new CampaignDomainError('not-a-campaign-day', 'This calendar row is not part of a campaign.');
    if (!campaignAllowsChanges(day.campaign.status)) throw new CampaignDomainError('campaign-closed', `The campaign is ${day.campaign.status}.`);

    const generation = await tx.posterStudioGeneration.findUnique({
      where: { id: generationId },
      select: { id: true, clientId: true, aspectRatio: true, imageDriveFileId: true, imageMimeType: true, finalImageDriveFileId: true, finalImageMimeType: true, width: true, height: true, sourceTemplateId: true },
    });
    if (!generation) throw new CampaignDomainError('not-found', 'That Poster Studio poster no longer exists.');
    if (generation.clientId !== day.clientId) {
      throw new CampaignDomainError('invalid-input', "That poster was made for a different client from this campaign's.");
    }

    const existing = await tx.posterVersion.findFirst({ where: { calendarDayId: day.id, studioGenerationId: generation.id }, select: { id: true, versionNumber: true } });
    if (existing) return { versionId: existing.id, versionNumber: existing.versionNumber, alreadySaved: true };

    // The day's posters are its template's shape; a day with no template keeps
    // the client's Poster Studio format.
    const shape = await dayPosterShape(tx, day, day.campaign.templateMappingMode, day.client.imageSizePreset);
    if (shape.aspect !== generation.aspectRatio) {
      throw new CampaignDomainError(
        'invalid-input',
        `That poster is ${generation.aspectRatio}; this day's posters are ${shape.aspect ?? `${shape.describe} (not a format posters can be made in)`}.`,
      );
    }

    const version = await addPosterVersion(tx, {
      calendarDayId: day.id,
      source: 'POSTER_STUDIO',
      imageDriveFileId: generation.finalImageDriveFileId ?? generation.imageDriveFileId,
      imageMimeType: generation.finalImageMimeType ?? generation.imageMimeType,
      width: generation.width,
      height: generation.height,
      contentRevision: day.contentRevision,
      templateId: generation.sourceTemplateId ?? day.activePosterVersion?.templateId ?? null,
      parentVersionId: day.activePosterVersion?.id ?? null,
      studioGenerationId: generation.id,
    });
    if (!version.activated) await activatePosterVersion(tx, day.id, version.versionId);
    /*
     * The saved poster is the day's content now, so the day is READY — without
     * moving the revision, which would outdate the very poster just saved. A day
     * with no template, or one never read, has nothing else that marks it READY,
     * and the delivery gate and booking sync refuse a day that is not: without
     * this its approved poster could never be sent.
     */
    if (day.contentStatus !== 'READY' || day.contentIssues.length > 0) {
      await tx.contentCalendar.updateMany({
        where: { id: day.id, contentRevision: day.contentRevision },
        data: { contentStatus: 'READY', contentIssues: [] },
      });
    }
    return { versionId: version.versionId, versionNumber: version.versionNumber, alreadySaved: false };
  });

  // A new active poster: its booking follows it (re-pinned when AUTO_APPROVE
  // approved it, withdrawn when it awaits review). Quietly, after the save.
  if (!saved.alreadySaved) await bookCampaignDayQuietly(db, dayId, { deps: options.deliveryDeps });
  return saved;
}

/**
 * The shape one day's posters are: its effective template's clone shape ("4:5"),
 * or — for a day with no template — the client's Poster Studio format. `aspect`
 * is null when neither gives a shape posters can be made in.
 */
async function dayPosterShape(
  db: CampaignDb,
  day: { posterTemplateId: string | null; suggestedTemplateId: string | null },
  mode: 'AUTO' | 'MANUAL',
  imageSizePreset: string | null,
): Promise<{ aspect: string | null; describe: string; fromTemplate: boolean }> {
  const templateId = mode === 'AUTO' ? (day.posterTemplateId ?? day.suggestedTemplateId) : day.posterTemplateId;
  if (templateId) {
    const shape = (await loadTemplateShapes(db, [templateId])).get(templateId) ?? null;
    if (shape) {
      const size = templateOutputSize(shape);
      return { aspect: size?.aspectLabel ?? null, describe: shape.width && shape.height ? `${shape.width}×${shape.height}` : 'unmeasured', fromTemplate: true };
    }
  }
  const preset = resolveImageSizePreset(imageSizePreset, optionalEnv('FAL_IMAGE_SIZE', ''));
  return { aspect: studioAspectFor(preset.width / preset.height), describe: preset.ratio, fromTemplate: false };
}

export interface CampaignDayStudioContext {
  dayId: string;
  dayNumber: number;
  campaignId: string;
  campaignName: string;
  clientId: string;
  companyName: string;
  /**
   * The Poster Studio format (9:16, 1:1, 16:9) matching this day's poster shape,
   * for the studio's Generate form; null when the shape is not one of those.
   */
  aspectRatio: StudioAspectRatio | null;
  /**
   * The shape this day's posters are — its template's ("4:5") or, with no
   * template, the client's studio format. What Save to Day checks a poster
   * against. Null when neither gives one.
   */
  posterAspect: string | null;
  /** The studio row behind the day's active poster, for Edit and Variation. */
  activeGenerationId: string | null;
  activeVersionNumber: number | null;
  /** The day's content as a Generate brief, for a day with no poster yet. */
  brief: string;
}

/** What Poster Studio needs to open a campaign day's poster. Null for a missing or non-campaign row. */
export async function loadCampaignDayStudioContext(db: CampaignDb, dayId: string): Promise<CampaignDayStudioContext | null> {
  const day = await db.contentCalendar.findUnique({
    where: { id: dayId },
    select: {
      id: true,
      dayNumber: true,
      theme: true,
      contentType: true,
      headline: true,
      supportingText: true,
      cta: true,
      imagePrompt: true,
      posterTemplateId: true,
      suggestedTemplateId: true,
      campaign: { select: { id: true, name: true, templateMappingMode: true, category: { select: { contentStrategy: true } } } },
      client: { select: { id: true, companyName: true, imageSizePreset: true } },
      activePosterVersion: { select: { versionNumber: true, studioGenerationId: true } },
    },
  });
  if (!day?.campaign) return null;

  const shape = await dayPosterShape(db, day, day.campaign.templateMappingMode, day.client.imageSizePreset);
  const studioFormats: readonly string[] = ['9:16', '1:1', '16:9'];
  const { strategy } = resolveContentStrategy(day.campaign.category.contentStrategy);
  return {
    dayId: day.id,
    dayNumber: day.dayNumber,
    campaignId: day.campaign.id,
    campaignName: day.campaign.name,
    clientId: day.client.id,
    companyName: day.client.companyName,
    aspectRatio: shape.aspect && studioFormats.includes(shape.aspect) ? (shape.aspect as StudioAspectRatio) : null,
    posterAspect: shape.aspect,
    activeGenerationId: day.activePosterVersion?.studioGenerationId ?? null,
    activeVersionNumber: day.activePosterVersion?.versionNumber ?? null,
    brief: buildCampaignPosterBrief({
      ...day,
      contentTypeLabel: day.contentType ? (strategy.pillars.find((pillar) => pillar.key === day.contentType)?.label ?? null) : null,
    }),
  };
}

/** Days of any campaign whose poster versions use this studio row; its deletion would break them. */
export function countCampaignVersionsUsingStudioGeneration(db: CampaignDb, generationId: string): Promise<number> {
  return db.posterVersion.count({ where: { studioGenerationId: generationId } });
}
