import type {
  CampaignApprovalPolicy,
  CampaignContentStatus,
  CampaignStatus,
  PosterApprovalStatus,
  PosterGenerationStatus,
  PosterVersionSource,
} from '@prisma/client';

import { assertStudioImageConfigured, renderStudioImage, type StudioImageRequest, type StudioImageResult } from '@/lib/ai/openai-images';
import { buildGeneratePrompt } from '@/lib/ai/studio-prompts';
import { resolveContentStrategy } from '@/lib/campaign/content-strategy';
import { campaignAllowsChanges, isVersionCurrent } from '@/lib/campaign/model';
import {
  brandCanvasReadiness,
  buildCampaignPosterBrief,
  derivePosterState,
  evaluatePosterEligibility,
  generationWindow,
  isGenerationInProgress,
  isInWindow,
  studioAspectFor,
  summarizePosterWindow,
  type BrandCanvasReadiness,
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
import type { DayMappingState, MappingIssue } from '@/lib/campaign/template-mapping';
import {
  loadCampaignMappingOverview,
  type CampaignMappingOverview,
  type LoadOptions,
} from '@/lib/campaign/template-mapping-service';
import { MissingEnvError, optionalEnv } from '@/lib/env';
import { resolveImageSizePreset } from '@/lib/image-sizes';
import { hasBrandCanvasLogo } from '@/lib/poster-studio/brand-logo';
import { loadStudioBrandCanvas, type StudioBrandCanvas } from '@/lib/poster-studio/brand-context';
import { composeStudioPoster, prepareStudioOverlay, type ComposedPoster, type StudioOverlayPlan, type StudioOverlaySelection } from '@/lib/poster-studio/compose';
import { StudioError, type StudioErrorKind } from '@/lib/poster-studio/errors';
import { prepareStudioInputImage, readStudioImageSize, type PreparedStudioImage } from '@/lib/poster-studio/images';
import { identityBandFraction, STUDIO_ASPECT_RATIOS, type StudioAspectRatio, type StudioOverlayElement } from '@/lib/poster-studio/limits';
import { readStudioFile, resolveStudioFolder, storeStudioFile, trashStudioFiles } from '@/lib/poster-studio/storage';
import { getAppTimeZone } from '@/lib/time';
import { parseBrandGuideline } from '@/lib/types/brand';
import { recordOpenAiImageUsage, type UsageContext } from '@/lib/usage';

/**
 * Rolling campaign poster generation — database operations of Phase 4.
 *
 * **One image pipeline.** A campaign poster is made by the AI Poster Studio's own
 * pipeline, composed here exactly as `generateStudioPosterAction` composes it:
 *
 *   Brand Canvas (`loadStudioBrandCanvas`) → overlay pre-flight (`prepareStudioOverlay`)
 *   → Drive folder (`resolveStudioFolder`) → GENERATE prompt (`buildGeneratePrompt`)
 *   with the mapped template attached as the reference → gpt-image-2
 *   (`renderStudioImage`) → usage (`recordOpenAiImageUsage`) → decode check
 *   → identity footer (`composeStudioPoster`) → RAW and FINAL files in Drive
 *   (`storeStudioFile`) → a `PosterStudioGeneration` row → a `PosterVersion`
 *   (`addPosterVersion`), which becomes the day's active version.
 *
 * The studio row is the record of the artwork — raw file, final file, prompts,
 * model, overlay — so the raw/final separation, the protected image route and
 * Edit/Variation in Poster Studio all apply to campaign posters unchanged. The
 * version is the campaign's record: which image represents the day, from which
 * content revision and template, and its approval.
 *
 * Nothing here sends a WhatsApp message or touches the legacy delivery columns.
 */

// ---------------------------------------------------------------------------
// Dependencies — the real pipeline by default, replaceable in tests
// ---------------------------------------------------------------------------

export interface PosterGenerationDeps {
  assertConfigured(): void;
  loadBrandCanvas(clientId: string): Promise<StudioBrandCanvas>;
  prepareOverlay(canvas: StudioBrandCanvas, selection: StudioOverlaySelection, aspectRatio: StudioAspectRatio): Promise<StudioOverlayPlan>;
  compose(raw: Buffer, plan: StudioOverlayPlan): Promise<ComposedPoster>;
  resolveFolder(companyName: string): Promise<string>;
  readFile(fileId: string): Promise<Buffer>;
  prepareReference(bytes: Buffer, mimeType: string, name: string): Promise<PreparedStudioImage>;
  render(request: StudioImageRequest): Promise<StudioImageResult>;
  recordUsage(usage: StudioImageResult['usage'], model: string, context: UsageContext): Promise<void>;
  readImageSize(bytes: Buffer): Promise<{ width: number; height: number } | null>;
  store(input: { folderId: string; fileName: string; body: Buffer; mimeType: string }): Promise<string>;
  trash(fileIds: readonly string[]): Promise<void>;
}

export const defaultPosterGenerationDeps: PosterGenerationDeps = {
  assertConfigured: assertStudioImageConfigured,
  loadBrandCanvas: loadStudioBrandCanvas,
  prepareOverlay: prepareStudioOverlay,
  compose: composeStudioPoster,
  resolveFolder: resolveStudioFolder,
  readFile: readStudioFile,
  prepareReference: prepareStudioInputImage,
  render: renderStudioImage,
  recordUsage: recordOpenAiImageUsage,
  readImageSize: readStudioImageSize,
  store: storeStudioFile,
  trash: trashStudioFiles,
};

/**
 * Everything the client's Brand Canvas has, drawn exactly — the same defaults
 * the studio panel preselects: logo (in the background mode Brand Canvas
 * already chose), tagline, website and phone where present, AUTO footer tone.
 */
export function campaignOverlaySelection(canvas: StudioBrandCanvas): StudioOverlaySelection {
  const elements: StudioOverlayElement[] = [];
  if (hasBrandCanvasLogo(canvas.logo)) elements.push('logo');
  if (canvas.tagline) elements.push('tagline');
  if (canvas.website) elements.push('website');
  if (canvas.phone) elements.push('phone');
  return {
    elements,
    logoBackground: canvas.logo.logoBackgroundRemoved ? 'REMOVED' : 'ORIGINAL',
    footerBackground: 'AUTO',
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
  activeVersion: PosterVersionSummary | null;
  versionCount: number;
  mapping: DayMappingState;
  unmappedReason: MappingIssue | null;
  templateLabel: string | null;
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
  studioAspect: StudioAspectRatio | null;
  targetAspectLabel: string;
  brandCanvas: BrandCanvasReadiness;
  mapping: CampaignMappingOverview;
  days: PosterDay[];
  /** Over the days inside the rolling window. */
  summary: PosterWindowSummary;
}

export interface PosterLoadOptions extends LoadOptions {
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
      client: { select: { companyName: true, brandGuideline: true } },
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
          _count: { select: { posterVersions: true } },
          activePosterVersion: {
            select: { id: true, versionNumber: true, source: true, contentRevision: true, approvalStatus: true, reviewNote: true, studioGenerationId: true, templateId: true, createdAt: true },
          },
        },
      },
    },
  });
  if (!campaign) throw new CampaignDomainError('not-found', 'Campaign does not exist.');

  const mapping = await loadCampaignMappingOverview(db, campaignId, options);
  const window = generationWindow(now, campaign.generationWindowDays, timeZone);
  const studioAspect = studioAspectFor(mapping.context.target.aspect);
  const brandCanvas = brandCanvasReadiness({
    companyName: campaign.client.companyName,
    brandColorCount: parseBrandGuideline(campaign.client.brandGuideline).colors.length,
  });
  const { strategy } = resolveContentStrategy(campaign.category.contentStrategy);
  const labels = new Map(mapping.context.templates.map((template) => [template.id, template.label]));

  const days: PosterDay[] = campaign.days.map((day) => {
    const state = mapping.states.get(day.id)!;
    const unmappedReason = mapping.unmappedReasons.get(day.id) ?? null;
    const generating = isGenerationInProgress(day.generationStatus, day.posterGenerationStartedAt, now);
    const common = {
      explicit: false,
      now,
      window,
      campaignStatus: campaign.status,
      scheduledDate: day.scheduledDate,
      contentStatus: day.contentStatus ?? 'NOT_GENERATED',
      mapping: state,
      unmappedReason,
      studioAspect,
      targetAspectLabel: mapping.context.target.aspectLabel,
      brandCanvas,
      generationStatus: day.generationStatus,
      generationStartedAt: day.posterGenerationStartedAt,
      dayRevision: day.contentRevision,
      activeVersion: day.activePosterVersion,
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
      activeVersion: day.activePosterVersion,
      versionCount: day._count.posterVersions,
      mapping: state,
      unmappedReason,
      templateLabel: state.templateId ? (labels.get(state.templateId) ?? null) : null,
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
    studioAspect,
    targetAspectLabel: mapping.context.target.aspectLabel,
    brandCanvas,
    mapping,
    days,
    summary: summarizePosterWindow(days.filter((day) => day.inWindow).map((day) => ({ state: day.state, unmapped: day.mapping.templateId === null }))),
  };
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
    contentStatus: day.contentStatus,
    mapping: day.mapping,
    unmappedReason: day.unmappedReason,
    studioAspect: overview.studioAspect,
    targetAspectLabel: overview.targetAspectLabel,
    brandCanvas: overview.brandCanvas,
    generationStatus: day.generationStatus,
    generationStartedAt: day.posterGenerationStartedAt,
    dayRevision: day.contentRevision,
    activeVersion: day.activeVersion,
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
  const explicit = request.fromDay !== undefined || request.toDay !== undefined;
  const from = request.fromDay ?? 1;
  const to = request.toDay ?? overview.campaign.durationDays;
  if (explicit && (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > overview.campaign.durationDays || from > to)) {
    throw new CampaignDomainError('invalid-input', `Choose a range within days 1–${overview.campaign.durationDays}.`);
  }

  const scope = explicit
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
 * create a second active version.
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

  const aspectRatio = overview.studioAspect!;
  const format = STUDIO_ASPECT_RATIOS[aspectRatio];
  const written: string[] = [];
  let billed = false;

  try {
    // ---- Pre-flight: everything deterministic, before any spend ------------
    const canvas = await deps.loadBrandCanvas(overview.campaign.clientId);
    const overlay = await deps.prepareOverlay(canvas, campaignOverlaySelection(canvas), aspectRatio);
    const folderId = await deps.resolveFolder(canvas.companyName);

    const template = await db.categoryTemplate.findUnique({
      where: { id: day.mapping.templateId! },
      select: { id: true, label: true, gDriveFileId: true, mimeType: true },
    });
    if (!template) throw new StudioError('validation', 'The mapped template no longer exists. Map another template to this day.');
    let reference: PreparedStudioImage;
    try {
      reference = await deps.prepareReference(await deps.readFile(template.gDriveFileId), template.mimeType, `Template "${template.label}"`);
    } catch (error) {
      const cause = toStudioError(error);
      throw new StudioError(
        cause.kind === 'storage' ? 'storage' : 'invalid-image',
        `The mapped template "${template.label}" could not be loaded as a reference image, so nothing was generated. ${cause.message}`,
        { cause: error },
      );
    }

    /*
     * Regenerating a rejected poster carries the reviewer's reason into the new
     * attempt (Phase 7 §15) — but only when the version being replaced is the
     * one that was rejected, and only that note. An approved or merely outdated
     * poster contributes nothing, and no earlier rejection is ever resurfaced.
     */
    const brief = buildCampaignPosterBrief({
      ...day,
      previousRejection:
        day.activeVersion?.approvalStatus === 'REJECTED' ? day.activeVersion.reviewNote : null,
    });
    const sentPrompt = buildGeneratePrompt({
      brief,
      aspectRatio,
      textFree: false,
      brand: canvas.brand,
      hasReference: true,
      identityBandFraction: identityBandFraction(aspectRatio),
    });

    // ---- Spend ---------------------------------------------------------------
    const rendered = await deps.render({ prompt: sentPrompt, size: format.size, image: { bytes: reference.bytes, mimeType: reference.mimeType } });
    billed = true;
    await deps.recordUsage(rendered.usage, rendered.model, { clientId: overview.campaign.clientId, calendarId: day.id });

    const dimensions = await deps.readImageSize(rendered.bytes);
    if (!dimensions) {
      throw new StudioError('provider', 'OpenAI returned an image that could not be read. Nothing was saved — try again.');
    }

    let composed: ComposedPoster;
    try {
      composed = await deps.compose(rendered.bytes, overlay);
    } catch (error) {
      // Unlike a studio draft, a campaign poster without its exact identity is not
      // a poster the client can receive, so it is not kept as one.
      throw new StudioError('composition', 'The brand identity footer could not be drawn on the generated artwork, so nothing was saved.', { cause: error });
    }

    // ---- Storage: RAW and FINAL, separately ---------------------------------
    const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
    const base = `campaign-day-${day.dayNumber}-${stamp}`;
    const rawFileId = await deps.store({ folderId, fileName: `${base}-raw.${extensionFor(rendered.mimeType)}`, body: rendered.bytes, mimeType: rendered.mimeType });
    written.push(rawFileId);
    const finalFileId = await deps.store({ folderId, fileName: `${base}-final.png`, body: composed.bytes, mimeType: composed.mimeType });
    written.push(finalFileId);

    // ---- Record: studio row + immutable version + status, atomically --------
    const saved = await runInCampaignTransaction(db, async (tx) => {
      const generation = await tx.posterStudioGeneration.create({
        data: {
          mode: 'GENERATE',
          prompt: brief,
          sentPrompt,
          aspectRatio,
          size: format.size,
          model: rendered.model,
          quality: rendered.quality,
          textFree: false,
          imageDriveFileId: rawFileId,
          imageMimeType: rendered.mimeType,
          width: dimensions.width,
          height: dimensions.height,
          finalImageDriveFileId: finalFileId,
          finalImageMimeType: composed.mimeType,
          overlayElements: composed.drawn,
          overlayPreset: overlay.preset,
          logoBackground: overlay.logo ? overlay.logo.background : null,
          footerBackground: overlay.footerBackground,
          footerTone: composed.footerTone,
          clientId: overview.campaign.clientId,
        },
        select: { id: true },
      });
      const version = await addPosterVersion(tx, {
        calendarDayId: day.id,
        source: 'PIPELINE',
        imageDriveFileId: finalFileId,
        imageMimeType: composed.mimeType,
        width: dimensions.width,
        height: dimensions.height,
        contentRevision: day.contentRevision,
        templateId: template.id,
        studioGenerationId: generation.id,
      });
      await tx.contentCalendar.updateMany({
        where: { id: day.id, generationStatus: 'GENERATING', posterGenerationStartedAt: startedAt },
        data: { generationStatus: 'SUCCEEDED', errorMessage: null },
      });
      return { generationId: generation.id, version };
    });

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

    const message = billed
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
      return 'the brand identity footer could not be drawn.';
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

/**
 * Approves the day's active poster — the one version that represents the day.
 *
 * Refused for an outdated poster (its content no longer matches the day) and
 * for a rejected one (it was sent back; edit or regenerate first). Approving an
 * already approved poster changes nothing, so a bulk run is safe to repeat.
 */
export async function approveCampaignDayPoster(db: CampaignDb, dayId: string, versionId: string): Promise<void> {
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
  if (day.activePosterVersion.approvalStatus === 'APPROVED') return;
  if (day.activePosterVersion.approvalStatus === 'REJECTED') {
    throw new CampaignDomainError('invalid-transition', 'This poster was rejected — edit or regenerate it before approving.');
  }
  await reviewPosterVersion(db, versionId, 'APPROVED');
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
): Promise<{ versionId: string; versionNumber: number; alreadySaved: boolean }> {
  return runInCampaignTransaction(db, async (tx) => {
    const day = await tx.contentCalendar.findUnique({
      where: { id: dayId },
      select: {
        id: true,
        dayNumber: true,
        campaignId: true,
        clientId: true,
        contentRevision: true,
        activePosterVersion: { select: { id: true, templateId: true } },
        campaign: { select: { status: true } },
        client: { select: { imageSizePreset: true } },
      },
    });
    if (!day) throw new CampaignDomainError('not-found', 'Campaign day does not exist.');
    if (!day.campaignId || !day.campaign) throw new CampaignDomainError('not-a-campaign-day', 'This calendar row is not part of a campaign.');
    if (!campaignAllowsChanges(day.campaign.status)) throw new CampaignDomainError('campaign-closed', `The campaign is ${day.campaign.status}.`);

    const generation = await tx.posterStudioGeneration.findUnique({
      where: { id: generationId },
      select: { id: true, clientId: true, aspectRatio: true, imageDriveFileId: true, imageMimeType: true, finalImageDriveFileId: true, finalImageMimeType: true, width: true, height: true },
    });
    if (!generation) throw new CampaignDomainError('not-found', 'That Poster Studio poster no longer exists.');
    if (generation.clientId !== day.clientId) {
      throw new CampaignDomainError('invalid-input', "That poster was made for a different client from this campaign's.");
    }

    const existing = await tx.posterVersion.findFirst({ where: { calendarDayId: day.id, studioGenerationId: generation.id }, select: { id: true, versionNumber: true } });
    if (existing) return { versionId: existing.id, versionNumber: existing.versionNumber, alreadySaved: true };

    const preset = resolveImageSizePreset(day.client.imageSizePreset, optionalEnv('FAL_IMAGE_SIZE', ''));
    const expected = studioAspectFor(preset.width / preset.height);
    if (expected !== generation.aspectRatio) {
      throw new CampaignDomainError('invalid-input', `That poster is ${generation.aspectRatio}; this client's posters are ${expected ?? `${preset.ratio} (not a Poster Studio format)`}.`);
    }

    const version = await addPosterVersion(tx, {
      calendarDayId: day.id,
      source: 'POSTER_STUDIO',
      imageDriveFileId: generation.finalImageDriveFileId ?? generation.imageDriveFileId,
      imageMimeType: generation.finalImageMimeType ?? generation.imageMimeType,
      width: generation.width,
      height: generation.height,
      contentRevision: day.contentRevision,
      templateId: day.activePosterVersion?.templateId ?? null,
      parentVersionId: day.activePosterVersion?.id ?? null,
      studioGenerationId: generation.id,
    });
    if (!version.activated) await activatePosterVersion(tx, day.id, version.versionId);
    return { versionId: version.versionId, versionNumber: version.versionNumber, alreadySaved: false };
  });
}

export interface CampaignDayStudioContext {
  dayId: string;
  dayNumber: number;
  campaignId: string;
  campaignName: string;
  clientId: string;
  companyName: string;
  /** The Poster Studio format this campaign's posters use; null when unsupported. */
  aspectRatio: StudioAspectRatio | null;
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
      campaign: { select: { id: true, name: true, category: { select: { contentStrategy: true } } } },
      client: { select: { id: true, companyName: true, imageSizePreset: true } },
      activePosterVersion: { select: { versionNumber: true, studioGenerationId: true } },
    },
  });
  if (!day?.campaign) return null;

  const preset = resolveImageSizePreset(day.client.imageSizePreset, optionalEnv('FAL_IMAGE_SIZE', ''));
  const { strategy } = resolveContentStrategy(day.campaign.category.contentStrategy);
  return {
    dayId: day.id,
    dayNumber: day.dayNumber,
    campaignId: day.campaign.id,
    campaignName: day.campaign.name,
    clientId: day.client.id,
    companyName: day.client.companyName,
    aspectRatio: studioAspectFor(preset.width / preset.height),
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
