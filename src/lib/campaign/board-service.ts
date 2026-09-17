import type {
  CampaignApprovalPolicy,
  CampaignDeliveryStatus,
  CampaignStatus,
  PosterApprovalStatus,
  PosterVersionSource,
  Prisma,
} from '@prisma/client';

import {
  BOARD_PAGE_SIZE,
  boardStatusOf,
  clampPage,
  countBoardStatuses,
  formatPageLabel,
  isFilteredQuery,
  matchesBoardSearch,
  pageCount,
  pageSlice,
  planPostMove,
  slotLockOf,
  todayPage,
  weekOf,
  type BoardCounts,
  type BoardDayActions,
  type BoardFilter,
  type BoardStatus,
  type PostMoveChange,
  type SlotLock,
} from '@/lib/campaign/board';
import { canRetryDelivery, evaluateDeliveryEligibility, isMissed, isValidRecipient } from '@/lib/campaign/delivery';
import {
  defaultDeliveryDeps,
  deliveryCandidateFrom,
  scheduleCampaignDeliveries,
  scheduledInstantFor,
  WITHDRAWING_REFUSALS,
  type DeliveryDeps,
} from '@/lib/campaign/delivery-service';
import { cancelQueuedGeneration } from '@/lib/campaign/generation-queue';
import { campaignAllowsChanges, isVersionCurrent } from '@/lib/campaign/model';
import {
  brandCanvasReadiness,
  derivePosterState,
  evaluatePosterEligibility,
  generationWindow,
  isGenerationInProgress,
  templateShapeOf,
  type PosterState,
} from '@/lib/campaign/poster-generation';
import { canApprove, canReject, parseRejectionNote } from '@/lib/campaign/review';
import {
  CampaignDomainError,
  changeCampaignStatus,
  runInCampaignTransaction,
  type CampaignDb,
} from '@/lib/campaign/service';
import {
  dayMappingState,
  diagnoseUnmapped,
  type DayMappingState,
  type MappingTarget,
  type MappingTemplate,
} from '@/lib/campaign/template-mapping';
import { studioImageUrl } from '@/lib/poster-studio/limits';
import { getAppTimeZone, startOfZonedDay } from '@/lib/time';
import { parseTextCheck, textCheckIssueCount } from '@/lib/types/template-elements';

/**
 * The one-screen campaign board — database operations.
 *
 * `loadCampaignBoard` replaces the six stacked sections of the campaign page
 * (health, review, delivery, poster generation, template mapping, content
 * calendar), which between them read the campaign five times, its days six
 * times and ran poster eligibility up to seven times per day on every render.
 * The board reads the campaign and every day **once**, narrowly, plus the
 * templates and — for the one page on screen — the active versions' text checks,
 * and derives everything else in memory with the phases' own pure rules:
 * `dayMappingState` (Phase 3), `evaluatePosterEligibility` and
 * `derivePosterState` (Phase 4), `canApprove`/`canReject` (Phase 5) and the
 * delivery gate `evaluateDeliveryEligibility` (Phase 6). No rule is copied.
 *
 * `moveCampaignPost` is the board's one new write: it re-orders posts across
 * day slots by id, in one transaction, keeping every post's content, versions,
 * approval and booking with it.
 */

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

const boardDaySelect = {
  id: true,
  dayNumber: true,
  scheduledDate: true,
  contentStatus: true,
  contentRevision: true,
  headline: true,
  posterTemplateId: true,
  suggestedTemplateId: true,
  generationStatus: true,
  posterGenerationStartedAt: true,
  errorMessage: true,
  activePosterVersion: {
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
    },
  },
  delivery: {
    select: {
      id: true,
      status: true,
      posterVersionId: true,
      scheduledFor: true,
      attempts: true,
      failureReason: true,
      failurePermanent: true,
      sendingStartedAt: true,
      sentAt: true,
    },
  },
} satisfies Prisma.ContentCalendarSelect;

export interface BoardDay {
  id: string;
  dayNumber: number;
  scheduledDate: Date;
  isToday: boolean;
  headline: string | null;
  /** The template the day's next poster is drawn from, or the active poster's. */
  template: { id: string; label: string; thumbnailUrl: string } | null;
  activeVersion: {
    id: string;
    versionNumber: number;
    approvalStatus: PosterApprovalStatus;
    current: boolean;
    source: PosterVersionSource;
    createdAt: Date;
    /** The studio row behind the poster; null for a manual upload. */
    generationId: string | null;
    /** The final poster through the protected image route, sized for a card. */
    imageUrl: string | null;
  } | null;
  /** Differences found by the clone text check on the active poster. */
  textCheckIssues: number;
  delivery: {
    status: CampaignDeliveryStatus;
    scheduledFor: Date;
    attempts: number;
    failureReason: string | null;
    failurePermanent: boolean;
    sentAt: Date | null;
    /** The booking carries the day's active poster. */
    pinnedToActive: boolean;
  } | null;
  lock: SlotLock | null;
  posterState: PosterState;
  status: BoardStatus;
  /** One sentence for the card: why it is blocked, what failed, or why it was rejected. */
  note: { tone: 'danger' | 'warning' | 'muted'; text: string } | null;
  actions: BoardDayActions;
}

export interface CampaignBoard {
  campaign: {
    id: string;
    name: string;
    status: CampaignStatus;
    approvalPolicy: CampaignApprovalPolicy;
    startDate: Date;
    endDate: Date;
    durationDays: number;
    deliveryTime: string;
    deliveryDays: number[];
    categoryName: string;
    /** COMPLETED or CANCELLED: nothing may change. */
    closed: boolean;
  };
  client: { id: string; companyName: string };
  now: Date;
  timeZone: string;
  /** Per status across the whole campaign — the header's counters. */
  counts: BoardCounts;
  query: { status: BoardFilter; q: string };
  /** `week`: seven consecutive day slots. `filtered`: matching days across the campaign, seven at a time. */
  mode: 'week' | 'filtered';
  page: {
    index: number;
    count: number;
    /** "17–23 Sept" (week) or "1–7 of 23" (filtered). */
    label: string;
    /** The page "Today" opens, in week mode. */
    todayIndex: number;
    /** How many days match, in filtered mode; every day in week mode. */
    matching: number;
  };
  days: BoardDay[];
  totalDays: number;
  /** Campaign-wide reasons posters cannot be generated or delivered. */
  warnings: string[];
}

export interface BoardLoadOptions {
  week?: number | null;
  status?: BoardFilter;
  q?: string;
  now?: Date;
  timeZone?: string;
  deliveryDeps?: DeliveryDeps;
}

/** Reasons a day cannot be generated that are already said once for the whole campaign, or are no news. */
const QUIET_BLOCKS = new Set(['campaign-not-active', 'campaign-closed', 'brand-canvas-unavailable', 'already-generated', 'generating', 'in-the-past', 'day-locked']);

/**
 * Everything the campaign board shows, in one load.
 *
 * Counts cover the whole campaign; `days` is one page — seven consecutive day
 * slots in week mode, or seven matching days when a status filter or a search
 * is given. A week of `null` opens the page with today on it.
 */
export async function loadCampaignBoard(db: CampaignDb, campaignId: string, options: BoardLoadOptions = {}): Promise<CampaignBoard> {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? getAppTimeZone();
  const deps = options.deliveryDeps ?? defaultDeliveryDeps({ timeZone, now: () => now });

  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      name: true,
      status: true,
      approvalPolicy: true,
      startDate: true,
      endDate: true,
      durationDays: true,
      deliveryTime: true,
      deliveryDays: true,
      templateMappingMode: true,
      generationWindowDays: true,
      categoryId: true,
      category: { select: { name: true } },
      client: { select: { id: true, companyName: true, whatsappNumber: true, isActive: true } },
      days: { orderBy: { dayNumber: 'asc' }, select: boardDaySelect },
    },
  });
  if (!campaign) throw new CampaignDomainError('not-found', 'Campaign does not exist.');

  // ---- Templates: the vertical's, plus any a day or a poster references --------
  const referenced = new Set<string>();
  for (const day of campaign.days) {
    if (day.posterTemplateId) referenced.add(day.posterTemplateId);
    if (day.suggestedTemplateId) referenced.add(day.suggestedTemplateId);
    if (day.activePosterVersion?.templateId) referenced.add(day.activePosterVersion.templateId);
  }
  const templateRows = await db.categoryTemplate.findMany({
    where: { OR: [{ categoryId: campaign.categoryId }, { id: { in: [...referenced] } }] },
    select: { id: true, label: true, categoryId: true, isActive: true, width: true, height: true, elements: true },
  });
  const templates: MappingTemplate[] = templateRows.map((row) => ({
    id: row.id,
    label: row.label,
    categoryId: row.categoryId,
    isActive: row.isActive,
    aspect: row.width && row.height && row.width > 0 && row.height > 0 ? row.width / row.height : 0,
  }));
  const templatesById = new Map(templates.map((template) => [template.id, template]));
  // Clone facts per template: whether its elements were read, and its shape.
  const shapes = new Map(templateRows.map((row) => [row.id, templateShapeOf(row)]));

  // ---- Campaign-wide facts, decided once -----------------------------------------
  // A clone comes out in its template's shape, so a template's shape is never
  // checked against the client's output preset: target aspect 0 matches every one.
  const target: MappingTarget = { categoryId: campaign.categoryId, mode: campaign.templateMappingMode, aspect: 0, aspectLabel: 'template shape' };
  const unmappedReason = diagnoseUnmapped(templates, target);
  const window = generationWindow(now, campaign.generationWindowDays, timeZone);
  const brandCanvas = brandCanvasReadiness({ companyName: campaign.client.companyName });
  const closed = !campaignAllowsChanges(campaign.status);
  const whatsappReady = deps.whatsappConfigured() && deps.mediaConfigured();
  const recipientValid = isValidRecipient(campaign.client.whatsappNumber);
  const todayStart = startOfZonedDay(now, timeZone).getTime();

  // ---- Every day's status, from the phases' own rules ---------------------------
  const derived = campaign.days.map((day) => {
    const active = day.activePosterVersion;
    const mapping = dayMappingState(
      { id: day.id, dayNumber: day.dayNumber, contentType: null, posterTemplateId: day.posterTemplateId, suggestedTemplateId: day.suggestedTemplateId },
      templatesById,
      target,
    );
    const generating = isGenerationInProgress(day.generationStatus, day.posterGenerationStartedAt, now, campaign.status);
    const common = {
      explicit: true,
      now,
      window,
      campaignStatus: campaign.status,
      scheduledDate: day.scheduledDate,
      mapping,
      unmappedReason: mapping.templateId ? null : unmappedReason,
      template: mapping.templateId ? (shapes.get(mapping.templateId) ?? null) : null,
      brandCanvas,
      generationStatus: day.generationStatus,
      generationStartedAt: day.posterGenerationStartedAt,
      dayRevision: day.contentRevision,
      activeVersion: active,
      deliveryStatus: day.delivery?.status ?? null,
    } as const;
    const regenerate = evaluatePosterEligibility({ ...common, mode: 'regenerate' });
    const missing = active ? null : evaluatePosterEligibility({ ...common, mode: 'missing' });
    const posterState = derivePosterState({
      generating,
      lastAttemptFailed: day.generationStatus === 'FAILED',
      dayRevision: day.contentRevision,
      activeVersion: active,
      attention: !regenerate.eligible && regenerate.attention,
    });

    const delivery = day.delivery;
    const pinnedToActive = Boolean(delivery && active && delivery.posterVersionId === active.id);
    const status = boardStatusOf({
      posterState,
      activeVersionId: active?.id ?? null,
      delivery: delivery ? { status: delivery.status, posterVersionId: delivery.posterVersionId } : null,
    });
    return { day, mapping, regenerate, missing, posterState, pinnedToActive, status };
  });

  const counts = countBoardStatuses(derived.map((entry) => entry.status));

  // ---- The page -------------------------------------------------------------------
  const query = { status: options.status ?? 'all', q: options.q ?? '' } as const;
  const filtered = isFilteredQuery(query);
  let pageRows: typeof derived;
  let page: CampaignBoard['page'];
  const todayIndex = todayPage(campaign.days, now, timeZone);

  if (filtered) {
    const matching = derived.filter(
      (entry) => (query.status === 'all' || entry.status === query.status) && matchesBoardSearch(entry.day, query.q),
    );
    const count = pageCount(matching.length);
    const index = clampPage(options.week ?? 1, count);
    pageRows = pageSlice(matching, index);
    const first = (index - 1) * BOARD_PAGE_SIZE + 1;
    page = {
      index,
      count,
      label: matching.length === 0 ? 'No matches' : `${first}–${first + pageRows.length - 1} of ${matching.length}`,
      todayIndex,
      matching: matching.length,
    };
  } else {
    const count = pageCount(derived.length);
    const index = clampPage(options.week ?? todayIndex, count);
    pageRows = derived.filter((entry) => weekOf(entry.day.dayNumber) === index);
    const first = pageRows[0]?.day;
    const last = pageRows[pageRows.length - 1]?.day;
    page = {
      index,
      count,
      label: first && last ? formatPageLabel(first.scheduledDate, last.scheduledDate, timeZone) : 'No days',
      todayIndex,
      matching: derived.length,
    };
  }

  // Text checks only for the posters on screen: the JSON is not needed for counting.
  const pageVersionIds = pageRows.map((entry) => entry.day.activePosterVersion?.id).filter((id): id is string => Boolean(id));
  const textChecks = new Map<string, number>();
  if (pageVersionIds.length > 0) {
    const rows = await db.posterVersion.findMany({ where: { id: { in: pageVersionIds } }, select: { id: true, textCheck: true } });
    for (const row of rows) textChecks.set(row.id, textCheckIssueCount(parseTextCheck(row.textCheck)));
  }

  const days: BoardDay[] = pageRows.map(({ day, mapping, regenerate, missing, posterState, pinnedToActive, status }) => {
    const active = day.activePosterVersion;
    const delivery = day.delivery;

    // The delivery gate, asked exactly as the sender asks it.
    const candidate = deliveryCandidateFrom(
      {
        campaignId: campaign.id,
        contentStatus: day.contentStatus,
        contentRevision: day.contentRevision,
        posterTemplateId: day.posterTemplateId,
        suggestedTemplateId: day.suggestedTemplateId,
        activePosterVersion: active,
        client: { whatsappNumber: campaign.client.whatsappNumber, isActive: campaign.client.isActive },
        campaign: { status: campaign.status, templateMappingMode: campaign.templateMappingMode },
        delivery,
      },
      deps,
    );
    const eligibility = evaluateDeliveryEligibility(candidate, now);
    const rebookable = evaluateDeliveryEligibility({ ...candidate, delivery: null }, now);
    const lock = slotLockOf(day, now, timeZone, campaign.deliveryTime);
    const moment = scheduledInstantFor(day.id, day.scheduledDate, campaign.deliveryTime, timeZone);

    // A sent, sending or past day's poster is final (generation eligibility refuses
    // it too); a due or closed day may still be regenerated, which withdraws its booking.
    const posterFinal = lock === 'sent' || lock === 'sending' || lock === 'past';
    const actions: BoardDayActions = {
      canGenerate: !closed && !posterFinal && missing !== null && missing.eligible,
      canRegenerate: !closed && !posterFinal && active !== null && regenerate.eligible,
      canApprove: canApprove({ state: posterState }, campaign.status),
      canReject: canReject({ state: posterState, activeVersion: active }, campaign.status),
      // Only where the sender can claim the row: none yet (Send now books it),
      // a booking, or a failure that may be retried. A cancelled or skipped row
      // is Retry's, and a past day is never sent late.
      canSendNow:
        !closed &&
        eligibility.eligible &&
        lock !== 'past' &&
        (delivery === null || delivery.status === 'SCHEDULED' || (delivery.status === 'FAILED' && canRetryDelivery(delivery))),
      canRetry:
        !closed &&
        delivery !== null &&
        !isMissed(moment, now, timeZone) &&
        (delivery.status === 'FAILED'
          ? canRetryDelivery(delivery) && eligibility.eligible
          : (delivery.status === 'CANCELLED' || delivery.status === 'SKIPPED') && rebookable.eligible),
      canCancel: !closed && (delivery?.status === 'SCHEDULED' || delivery?.status === 'FAILED'),
      canMove: !closed && lock === null && campaign.days.length > 1,
    };

    const templateId = mapping.templateId ?? active?.templateId ?? null;
    const template = templateId ? templatesById.get(templateId) : undefined;

    return {
      id: day.id,
      dayNumber: day.dayNumber,
      scheduledDate: day.scheduledDate,
      isToday: day.scheduledDate.getTime() === todayStart,
      headline: day.headline,
      template: template ? { id: template.id, label: template.label, thumbnailUrl: `/api/templates/${template.id}/thumbnail?w=320` } : null,
      activeVersion: active
        ? {
            id: active.id,
            versionNumber: active.versionNumber,
            approvalStatus: active.approvalStatus,
            current: isVersionCurrent(active, day),
            source: active.source,
            createdAt: active.createdAt,
            generationId: active.studioGenerationId,
            imageUrl: active.studioGenerationId ? studioImageUrl(active.studioGenerationId, { width: 480 }) : null,
          }
        : null,
      textCheckIssues: active ? (textChecks.get(active.id) ?? 0) : 0,
      delivery: delivery
        ? {
            status: delivery.status,
            scheduledFor: delivery.scheduledFor,
            attempts: delivery.attempts,
            failureReason: delivery.failureReason,
            failurePermanent: delivery.failurePermanent,
            sentAt: delivery.sentAt,
            pinnedToActive,
          }
        : null,
      lock,
      posterState,
      status,
      note: noteFor({ day, mapping, status, posterState, missing, regenerate, pinnedToActive }),
      actions,
    };
  });

  // ---- Campaign-wide warnings -----------------------------------------------------
  const warnings: string[] = [];
  if (campaign.status === 'DRAFT') warnings.push('This campaign is a draft — activate it to generate posters and deliver them.');
  if (campaign.status === 'PAUSED') warnings.push('This campaign is paused — nothing is generated or sent until it is resumed. Bookings are kept.');
  if (!closed && !brandCanvas.available) warnings.push(`Brand Canvas unavailable — ${brandCanvas.reason}.`);
  if (!closed) {
    const unread = derived.filter(({ day, mapping }) => mapping.templateId !== null && !day.activePosterVersion && shapes.get(mapping.templateId)?.readable === false).length;
    if (unread > 0) {
      warnings.push(`${unread} day${unread === 1 ? ' uses a template' : 's use templates'} not read yet — open the vertical and press Read now before generating.`);
    }
  }
  if (!closed && !whatsappReady) warnings.push('WhatsApp delivery is not configured on this deployment — approved posters cannot be booked yet.');
  if (!closed && whatsappReady && !recipientValid) warnings.push("The client's WhatsApp number is missing or invalid — approved posters cannot be booked.");

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      approvalPolicy: campaign.approvalPolicy,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      durationDays: campaign.durationDays,
      deliveryTime: campaign.deliveryTime,
      deliveryDays: campaign.deliveryDays,
      categoryName: campaign.category.name,
      closed,
    },
    client: { id: campaign.client.id, companyName: campaign.client.companyName },
    now,
    timeZone,
    counts,
    query,
    mode: filtered ? 'filtered' : 'week',
    page,
    days,
    totalDays: campaign.days.length,
    warnings,
  };
}

type BoardRow = Prisma.ContentCalendarGetPayload<{ select: typeof boardDaySelect }>;

/** What to do about a day with no usable template, now that the mapping screen is gone. */
const TEMPLATE_REMEDY = 'use Fill empty days or pick one in Poster Studio';
export const NO_TEMPLATE_NOTE = `No template — ${TEMPLATE_REMEDY}`;

const UNUSABLE_TEMPLATE_CODES = new Set(['template-inactive', 'template-missing', 'template-wrong-vertical']);

function noteFor(input: {
  day: BoardRow;
  mapping: DayMappingState;
  status: BoardStatus;
  posterState: PosterState;
  missing: ReturnType<typeof evaluatePosterEligibility> | null;
  regenerate: ReturnType<typeof evaluatePosterEligibility>;
  pinnedToActive: boolean;
}): BoardDay['note'] {
  const { day, posterState } = input;
  const active = day.activePosterVersion;

  if (input.status === 'failed' && input.pinnedToActive && day.delivery?.failureReason) {
    return { tone: 'danger', text: day.delivery.failurePermanent ? `Delivery failed and will not retry: ${day.delivery.failureReason}` : `Delivery failed: ${day.delivery.failureReason}` };
  }
  if (posterState === 'failed' && day.errorMessage) return { tone: 'danger', text: day.errorMessage };
  if (posterState === 'rejected') {
    const rejection = parseRejectionNote(active?.reviewNote ?? null);
    return { tone: 'danger', text: rejection ? `Rejected: ${rejection.label}${rejection.detail ? ` — ${rejection.detail}` : ''}` : 'Rejected.' };
  }
  if (posterState === 'outdated') return { tone: 'warning', text: 'Content or template changed after this poster was made.' };
  if (active && day.generationStatus === 'FAILED' && day.errorMessage) return { tone: 'warning', text: `Last regeneration failed: ${day.errorMessage}` };
  // A day with nothing to generate from says what to do, whatever else is true
  // of it (a draft campaign, content still to write) — never a silent card.
  if (!active && posterState !== 'generating') {
    const unusable = input.mapping.issues.find((issue) => UNUSABLE_TEMPLATE_CODES.has(issue.code));
    if (!input.mapping.templateId) return { tone: 'warning', text: NO_TEMPLATE_NOTE };
    if (unusable) return { tone: 'warning', text: `${unusable.title.replace(/ — action required$/, '')} — ${TEMPLATE_REMEDY}` };
  }
  if (!active && input.missing && !input.missing.eligible && !QUIET_BLOCKS.has(input.missing.reason)) {
    return { tone: input.missing.attention ? 'warning' : 'muted', text: input.missing.message };
  }
  if (posterState === 'needs-attention' && !input.regenerate.eligible) return { tone: 'warning', text: input.regenerate.message };
  if (day.delivery?.status === 'SKIPPED' && input.pinnedToActive) return { tone: 'muted', text: 'Missed — its delivery day passed before it was sent.' };
  if (day.delivery?.status === 'CANCELLED' && input.pinnedToActive) return { tone: 'muted', text: 'Delivery cancelled.' };
  return null;
}

// ---------------------------------------------------------------------------
// One day's details (the drawer)
// ---------------------------------------------------------------------------

export interface BoardDayDetails {
  dayId: string;
  dayNumber: number;
  scheduledDate: Date;
  content: { headline: string | null; supportingText: string | null; cta: string | null; contentStatus: string };
  versions: Array<{
    id: string;
    versionNumber: number;
    source: PosterVersionSource;
    approvalStatus: PosterApprovalStatus;
    active: boolean;
    current: boolean;
    rejection: { label: string; detail: string | null } | null;
    templateLabel: string | null;
    imageUrl: string | null;
    fullImageUrl: string | null;
    textCheckIssues: number;
    createdAt: Date;
    reviewedAt: Date | null;
  }>;
  delivery: {
    status: CampaignDeliveryStatus;
    scheduledFor: Date;
    attempts: number;
    lastAttemptAt: Date | null;
    sentAt: Date | null;
    failureReason: string | null;
    failurePermanent: boolean;
    pinnedVersionNumber: number | null;
  } | null;
}

/**
 * The drawer's detail for one day: every version (newest first) and the
 * delivery record. Read-only; carries no Drive id — images go through the
 * protected studio image route. The day must belong to the named campaign.
 */
export async function loadBoardDayDetails(db: CampaignDb, campaignId: string, dayId: string): Promise<BoardDayDetails> {
  const day = await db.contentCalendar.findFirst({
    where: { id: dayId, campaignId },
    select: {
      id: true,
      dayNumber: true,
      scheduledDate: true,
      headline: true,
      supportingText: true,
      cta: true,
      contentStatus: true,
      contentRevision: true,
      activePosterVersionId: true,
      posterVersions: {
        orderBy: { versionNumber: 'desc' },
        select: {
          id: true,
          versionNumber: true,
          source: true,
          approvalStatus: true,
          reviewNote: true,
          reviewedAt: true,
          contentRevision: true,
          studioGenerationId: true,
          textCheck: true,
          createdAt: true,
          template: { select: { label: true } },
        },
      },
      delivery: {
        select: { status: true, scheduledFor: true, attempts: true, lastAttemptAt: true, sentAt: true, failureReason: true, failurePermanent: true, posterVersionId: true },
      },
    },
  });
  if (!day) throw new CampaignDomainError('not-found', 'That day is not part of this campaign.');

  const numbers = new Map(day.posterVersions.map((version) => [version.id, version.versionNumber]));
  return {
    dayId: day.id,
    dayNumber: day.dayNumber,
    scheduledDate: day.scheduledDate,
    content: { headline: day.headline, supportingText: day.supportingText, cta: day.cta, contentStatus: day.contentStatus ?? 'NOT_GENERATED' },
    versions: day.posterVersions.map((version) => ({
      id: version.id,
      versionNumber: version.versionNumber,
      source: version.source,
      approvalStatus: version.approvalStatus,
      active: version.id === day.activePosterVersionId,
      current: isVersionCurrent(version, day),
      rejection: version.approvalStatus === 'REJECTED' ? parseRejectionNote(version.reviewNote) : null,
      templateLabel: version.template?.label ?? null,
      imageUrl: version.studioGenerationId ? studioImageUrl(version.studioGenerationId, { width: 640 }) : null,
      fullImageUrl: version.studioGenerationId ? studioImageUrl(version.studioGenerationId, { width: 2048 }) : null,
      textCheckIssues: textCheckIssueCount(parseTextCheck(version.textCheck)),
      createdAt: version.createdAt,
      reviewedAt: version.reviewedAt,
    })),
    delivery: day.delivery
      ? {
          status: day.delivery.status,
          scheduledFor: day.delivery.scheduledFor,
          attempts: day.delivery.attempts,
          lastAttemptAt: day.delivery.lastAttemptAt,
          sentAt: day.delivery.sentAt,
          failureReason: day.delivery.failureReason,
          failurePermanent: day.delivery.failurePermanent,
          pinnedVersionNumber: numbers.get(day.delivery.posterVersionId) ?? null,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Moving a post
// ---------------------------------------------------------------------------

export interface MovePostResult {
  /** Every row whose slot changed, in new day order. */
  moves: PostMoveChange[];
  /** Moved days whose SCHEDULED booking now follows their new date. */
  rescheduled: number[];
  /** Moved days whose retryable FAILED booking was booked again for the new date (attempts kept). */
  rebooked: number[];
  /** Moved days whose retryable FAILED booking was withdrawn because its poster may no longer go out. */
  cancelled: number[];
}

/**
 * Moves one post to another day of its campaign: INSERT-AND-SHIFT, by id.
 *
 * One transaction, in this order:
 * 1. **Serialise.** The campaign row is locked `FOR NO KEY UPDATE`, so two moves
 *    on one campaign run one after the other, and every booking write
 *    (`lockCampaignForBooking`, `FOR SHARE`) waits for the move and then reads
 *    the moved dates.
 * 2. **Re-read and re-plan.** Every day and its delivery are read inside the
 *    transaction and `planPostMove` decides the permutation from those rows —
 *    never from what the browser saw — with today's slot closed once today's
 *    delivery time has come. A refusal (locked source or target, out of range,
 *    no-op) is a domain error and nothing is written.
 * 3. **Plan the bookings before writing anything.** A SCHEDULED delivery gets
 *    the moment of its new date (`deliveryInstant + deliverySpreadSeconds(day
 *    id)`, the booking rule). A retryable FAILED one either follows its post as
 *    SCHEDULED at the new moment — its attempts kept, so retries stay bounded,
 *    and the sweep and sender still re-check everything — or, when its poster may
 *    no longer go out at all (`WITHDRAWING_REFUSALS`), is withdrawn. A paused
 *    campaign or missing configuration never withdraws it. If any booking would
 *    be due the instant it is written, the whole move is refused: a move must
 *    never be a way to send now.
 * 4. **Park, then place.** `(campaignId, dayNumber)` and `(clientId, dayNumber)`
 *    are unique and not deferrable, so a permutation cannot be written in
 *    place: every moving row is first parked on a temporary negative day
 *    number, then given its final number and date. Each write restates the
 *    number it read, so a row changed meanwhile is a conflict.
 * 5. **Write the bookings**, each restating the status it read; a row claimed
 *    for sending meanwhile rolls the whole move back. SENT and SENDING rows
 *    cannot move (their slots are locked).
 *
 * `contentRevision` is never touched: the date is not part of the poster, so
 * approval survives the move. Content, versions, approval and the delivery row
 * all stay on the row, which is the post.
 */
export async function moveCampaignPost(
  db: CampaignDb,
  campaignId: string,
  dayId: string,
  targetDayNumber: number,
  options: { now?: Date; timeZone?: string; deliveryDeps?: DeliveryDeps } = {},
): Promise<MovePostResult> {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? getAppTimeZone();
  const deps = options.deliveryDeps ?? defaultDeliveryDeps({ timeZone, now: () => now });

  return runInCampaignTransaction(db, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${campaignId} FOR NO KEY UPDATE`;
    const campaign = await tx.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, status: true, deliveryTime: true, templateMappingMode: true, client: { select: { whatsappNumber: true, isActive: true } } },
    });
    if (!campaign) throw new CampaignDomainError('not-found', 'Campaign does not exist.');
    if (!campaignAllowsChanges(campaign.status)) throw new CampaignDomainError('campaign-closed', `The campaign is ${campaign.status}.`);

    const days = await tx.contentCalendar.findMany({
      where: { campaignId },
      orderBy: { dayNumber: 'asc' },
      select: {
        id: true,
        dayNumber: true,
        scheduledDate: true,
        contentStatus: true,
        contentRevision: true,
        posterTemplateId: true,
        suggestedTemplateId: true,
        activePosterVersion: { select: { id: true, contentRevision: true, approvalStatus: true } },
        delivery: { select: { id: true, status: true, posterVersionId: true, scheduledFor: true, attempts: true, failurePermanent: true, sendingStartedAt: true } },
      },
    });

    const plan = planPostMove(days, dayId, targetDayNumber, now, timeZone, campaign.deliveryTime);
    if (!plan.ok) {
      throw new CampaignDomainError(plan.reason === 'not-found' ? 'not-found' : plan.reason === 'out-of-range' ? 'invalid-input' : 'invalid-transition', plan.message);
    }

    // ---- Decide every booking first; refuse before any write ------------------
    type BookingStep =
      | { kind: 'reschedule'; move: PostMoveChange; deliveryId: string; scheduledFor: Date }
      | { kind: 'rebook'; move: PostMoveChange; deliveryId: string; scheduledFor: Date; posterVersionId: string }
      | { kind: 'withdraw'; move: PostMoveChange; deliveryId: string; reason: string };
    const steps: BookingStep[] = [];
    const byId = new Map(days.map((day) => [day.id, day]));
    for (const move of plan.moves) {
      const day = byId.get(move.dayId)!;
      const delivery = day.delivery;
      if (!delivery) continue;
      const scheduledFor = scheduledInstantFor(day.id, move.scheduledDate, campaign.deliveryTime, timeZone);

      if (delivery.status === 'SCHEDULED') {
        steps.push({ kind: 'reschedule', move, deliveryId: delivery.id, scheduledFor });
      } else if (delivery.status === 'FAILED' && canRetryDelivery(delivery)) {
        // The poster's own verdict: campaign status, a paused client,
        // configuration and the recipient are set aside, because those never
        // withdraw a delivery.
        const poster = evaluateDeliveryEligibility(
          {
            ...deliveryCandidateFrom(
              {
                campaignId,
                contentStatus: day.contentStatus,
                contentRevision: day.contentRevision,
                posterTemplateId: day.posterTemplateId,
                suggestedTemplateId: day.suggestedTemplateId,
                activePosterVersion: day.activePosterVersion,
                client: campaign.client,
                campaign: { status: campaign.status, templateMappingMode: campaign.templateMappingMode },
                delivery,
              },
              deps,
            ),
            campaignStatus: 'ACTIVE',
            clientActive: true,
            whatsappConfigured: true,
            delivery: null,
          },
          now,
        );
        if (!poster.eligible && WITHDRAWING_REFUSALS.has(poster.reason)) {
          steps.push({ kind: 'withdraw', move, deliveryId: delivery.id, reason: poster.message });
        } else {
          steps.push({ kind: 'rebook', move, deliveryId: delivery.id, scheduledFor, posterVersionId: day.activePosterVersion?.id ?? delivery.posterVersionId });
        }
      }
    }
    for (const step of steps) {
      if (step.kind !== 'withdraw' && step.scheduledFor.getTime() <= now.getTime()) {
        throw new CampaignDomainError('invalid-transition', `Day ${step.move.toDayNumber} would be sent immediately — use Send now instead.`);
      }
    }

    // ---- Park every moving row on a temporary negative number ----------------
    for (const move of plan.moves) {
      const parked = await tx.contentCalendar.updateMany({
        where: { id: move.dayId, campaignId, dayNumber: move.fromDayNumber },
        data: { dayNumber: -move.toDayNumber },
      });
      if (parked.count !== 1) throw new CampaignDomainError('conflict', 'The campaign changed while moving. Refresh and try again.');
    }
    // ---- …then give each its final slot ---------------------------------------
    for (const move of plan.moves) {
      await tx.contentCalendar.updateMany({
        where: { id: move.dayId, campaignId, dayNumber: -move.toDayNumber },
        data: { dayNumber: move.toDayNumber, scheduledDate: move.scheduledDate },
      });
    }

    // ---- Bookings follow their post -------------------------------------------
    const result: MovePostResult = { moves: plan.moves, rescheduled: [], rebooked: [], cancelled: [] };
    for (const step of steps) {
      if (step.kind === 'reschedule') {
        const moved = await tx.campaignDelivery.updateMany({
          where: { id: step.deliveryId, status: 'SCHEDULED' },
          data: { scheduledFor: step.scheduledFor },
        });
        // It was claimed for sending while we worked: roll the whole move back.
        if (moved.count !== 1) throw new CampaignDomainError('conflict', `Day ${step.move.fromDayNumber} started sending while moving. Nothing was moved.`);
        result.rescheduled.push(step.move.toDayNumber);
      } else if (step.kind === 'rebook') {
        const rebooked = await tx.campaignDelivery.updateMany({
          where: { id: step.deliveryId, status: 'FAILED', failurePermanent: false },
          // `attempts` is deliberately not reset: a moved post keeps its retry budget.
          data: { status: 'SCHEDULED', posterVersionId: step.posterVersionId, scheduledFor: step.scheduledFor, sendingStartedAt: null },
        });
        if (rebooked.count !== 1) throw new CampaignDomainError('conflict', `Day ${step.move.fromDayNumber} is being retried right now. Nothing was moved.`);
        result.rebooked.push(step.move.toDayNumber);
      } else {
        const withdrawn = await tx.campaignDelivery.updateMany({
          where: { id: step.deliveryId, status: 'FAILED', failurePermanent: false },
          data: {
            status: 'CANCELLED',
            failureReason: `Moved to day ${step.move.toDayNumber}; the failed delivery was withdrawn: ${step.reason}`,
            sendingStartedAt: null,
          },
        });
        if (withdrawn.count !== 1) throw new CampaignDomainError('conflict', `Day ${step.move.fromDayNumber} is being retried right now. Nothing was moved.`);
        result.cancelled.push(step.move.toDayNumber);
      }
    }

    return result;
  });
}

// ---------------------------------------------------------------------------
// Campaign settings from the board header
// ---------------------------------------------------------------------------

/**
 * Turns auto-approval on or off for a campaign.
 *
 * Only posters made from now on are affected — `addPosterVersion` reads the
 * policy when it stores a version. Posters already waiting keep their review
 * state: switching the policy on never approves anything retroactively.
 */
export async function setCampaignApprovalPolicy(
  db: CampaignDb,
  campaignId: string,
  policy: CampaignApprovalPolicy,
): Promise<{ changed: boolean; policy: CampaignApprovalPolicy }> {
  const campaign = await db.campaign.findUnique({ where: { id: campaignId }, select: { status: true, approvalPolicy: true } });
  if (!campaign) throw new CampaignDomainError('not-found', 'Campaign does not exist.');
  if (!campaignAllowsChanges(campaign.status)) throw new CampaignDomainError('campaign-closed', `The campaign is ${campaign.status}.`);
  if (campaign.approvalPolicy === policy) return { changed: false, policy };

  const updated = await db.campaign.updateMany({
    where: { id: campaignId, approvalPolicy: campaign.approvalPolicy },
    data: { approvalPolicy: policy },
  });
  if (updated.count === 0) throw new CampaignDomainError('conflict', 'The approval setting changed meanwhile. Refresh and try again.');
  return { changed: true, policy };
}

/**
 * Activates, pauses or resumes a campaign — Phase 1's `changeCampaignStatus` —
 * and, when it becomes ACTIVE, books every approved day at once
 * (`scheduleCampaignDeliveries`). Pausing touches no booking.
 *
 * The booking runs after the status change and never undoes it; a failure is
 * logged and left to the cron sweep's sync.
 */
export async function changeCampaignStatusWithBookings(
  db: CampaignDb,
  campaignId: string,
  to: CampaignStatus,
  options: { deliveryDeps?: DeliveryDeps } = {},
): Promise<{ from: CampaignStatus; to: CampaignStatus; booked: number }> {
  const result = await changeCampaignStatus(db, campaignId, to);
  if (to !== 'ACTIVE') {
    // Nothing takes a paused campaign's queued days; release them now rather than
    // leave them looking "being generated" (and locked) until the next cron tick.
    try {
      await cancelQueuedGeneration(db, campaignId);
    } catch (error) {
      console.error(`[campaign:board] releasing the queue after pausing failed for campaign=${campaignId}:`, error instanceof Error ? error.message : error);
    }
  }
  let booked = 0;
  if (to === 'ACTIVE') {
    try {
      const outcome = await scheduleCampaignDeliveries(db, campaignId, options.deliveryDeps ?? defaultDeliveryDeps());
      booked = outcome.scheduled.length + outcome.repinned.length;
    } catch (error) {
      console.error(`[campaign:board] booking after activation failed for campaign=${campaignId}:`, error instanceof Error ? error.message : error);
    }
  }
  return { ...result, booked };
}
