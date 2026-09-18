import type {
  CampaignApprovalPolicy,
  CampaignDeliveryStatus,
  CampaignStatus,
  PosterApprovalStatus,
  PosterGenerationStatus,
  PosterVersionSource,
} from '@prisma/client';

import { BOARD_STATUS_LABELS, SLOT_LOCK_LABELS, weekOf, type BoardDayActions, type BoardStatus, type SlotLock } from '@/lib/campaign/board';
import { loadBoardDayDetails, loadCampaignBoard } from '@/lib/campaign/board-service';
import { loadCampaignDayCloneEditor, type CampaignDayCloneEditor } from '@/lib/campaign/clone-editor';
import { adjacentDays, brandCanvasHref, campaignBoardHref, templateEditorHref, type PosterChangeSummary } from '@/lib/campaign/clone-editor-view';
import { posterRevisionSummary } from '@/lib/campaign/clone-fix';
import { DELIVERY_STATUS_LABELS } from '@/lib/campaign/delivery';
import { effectiveTemplateId } from '@/lib/campaign/model';
import { isGenerationInProgress, templateOutputSize, type PosterState } from '@/lib/campaign/poster-generation';
import { studioImageUrl } from '@/lib/poster-studio/limits';
import { CampaignDomainError, type CampaignDb } from '@/lib/campaign/service';
import { formatDisplayDateTime, getAppTimeZone } from '@/lib/time';
import type { DayPosterElementsDoc, TemplateElementsDoc, TextCheckResult } from '@/lib/types/template-elements';

/**
 * Everything Poster Studio's template poster editor shows for one campaign day,
 * in one serializable object — for the server page's first render and for the
 * editor's reloads (after a save conflict, an action, or while polling a running
 * generation).
 *
 * Built from the services that already own each answer, never re-derived:
 *
 *   `loadCampaignDayCloneEditor`  the template, the day's elements, Brand Canvas,
 *                                 the active version and its text check
 *   `loadCampaignBoard`           the day's card — status, poster state, note,
 *                                 slot lock, delivery and the actions offered —
 *                                 from the week page that holds the day, so the
 *                                 editor and the board can never disagree
 *   `loadBoardDayDetails`         every version with its image and text check count
 *
 * plus the neighbouring days for the previous/next arrows. Dates are formatted
 * here, in the app timezone, as the board does. No Drive id reaches the browser:
 * images go through the protected routes.
 */

export interface TemplateEditorScreen {
  /** ISO instant this view was built. */
  loadedAt: string;
  day: {
    id: string;
    dayNumber: number;
    /** "Thu 17 Sept" */
    dateLabel: string;
    isToday: boolean;
    contentRevision: number;
    imagePrompt: string;
  };
  campaign: { id: string; name: string; status: CampaignStatus; approvalPolicy: CampaignApprovalPolicy; closed: boolean; totalDays: number };
  client: { id: string; companyName: string };
  links: { board: string; editor: string; brandCanvas: string };
  nav: {
    prev: { id: string; dayNumber: number; dateLabel: string } | null;
    next: { id: string; dayNumber: number; dateLabel: string } | null;
  };
  template: { id: string; label: string; thumbnailUrl: string; imageUrl: string; aspectLabel: string | null; doc: TemplateElementsDoc };
  /** The day's values, reconciled with the template (what the form starts from). */
  elements: DayPosterElementsDoc;
  brand: CampaignDayCloneEditor['brand'];
  colourMode: CampaignDayCloneEditor['colourMode'];
  activeVersion: {
    id: string;
    versionNumber: number;
    approvalStatus: PosterApprovalStatus;
    current: boolean;
    /** Null for an uploaded poster (no studio artwork). */
    imageUrl: string | null;
    fullImageUrl: string | null;
    /**
     * The artwork before the client's logo was composited onto it — what the
     * logo-placement preview draws under its own mark. Never the finished image:
     * that one already has a logo burned into it, and overlaying a second one is
     * the mistake this field exists to prevent.
     */
    rawImageUrl: string | null;
    textCheck: TextCheckResult | null;
  } | null;
  generation: {
    status: PosterGenerationStatus | null;
    /** ISO instant the running or last attempt started. */
    startedAt: string | null;
    errorMessage: string | null;
    /** A generation, fix or edit is queued or running now. */
    inProgress: boolean;
  };
  status: {
    board: BoardStatus;
    boardLabel: string;
    posterState: PosterState;
    note: { tone: 'danger' | 'warning' | 'muted'; text: string } | null;
    lock: SlotLock | null;
    lockLabel: string | null;
  };
  actions: BoardDayActions;
  delivery: { status: CampaignDeliveryStatus; statusLabel: string; whenLabel: string } | null;
  /** Newest first. */
  versions: Array<{
    id: string;
    versionNumber: number;
    source: PosterVersionSource;
    approvalStatus: PosterApprovalStatus;
    active: boolean;
    current: boolean;
    imageUrl: string | null;
    fullImageUrl: string | null;
    textCheckIssues: number;
    rejection: { label: string; detail: string | null } | null;
    templateLabel: string | null;
    /** "17 Sept, 09:04" */
    createdLabel: string;
    /**
     * What made this version (`posterRevisionSummary`) — the clone itself, an
     * admin's instruction, a text fix, a logo move, or an upload. Null only for a
     * version whose studio row has gone.
     */
    change?: PosterChangeSummary | null;
    /**
     * The version's artwork before the client's logo was composited onto it — what
     * a logo-placement preview overlays. Never the finished image, which already
     * has the mark burned in.
     */
    rawImageUrl?: string | null;
  }>;
}

export type TemplateEditorLoad =
  | { kind: 'editor'; screen: TemplateEditorScreen }
  /** The day's effective template exists but its elements have not been read (or cannot be parsed). */
  | { kind: 'unread'; dayNumber: number; templateLabel: string }
  /** The day has no template at all. */
  | { kind: 'no-template'; dayNumber: number };

export interface TemplateEditorLoadOptions {
  now?: Date;
  timeZone?: string;
}

/**
 * The editor for one campaign day, or why the day cannot use it. Throws
 * `CampaignDomainError` (`not-found`, `not-a-campaign-day`) for a row that is not
 * a campaign day.
 */
export async function loadTemplateEditorScreen(
  db: CampaignDb,
  dayId: string,
  options: TemplateEditorLoadOptions = {},
): Promise<TemplateEditorLoad> {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? getAppTimeZone();

  const editor = await loadCampaignDayCloneEditor(db, dayId);
  if (!editor.template || !editor.elements) {
    const row = await db.contentCalendar.findUnique({
      where: { id: dayId },
      select: { posterTemplateId: true, suggestedTemplateId: true, campaign: { select: { templateMappingMode: true } } },
    });
    const templateId = row?.campaign ? effectiveTemplateId(row.campaign.templateMappingMode, row) : null;
    const template = templateId ? await db.categoryTemplate.findUnique({ where: { id: templateId }, select: { label: true } }) : null;
    return template
      ? { kind: 'unread', dayNumber: editor.day.dayNumber, templateLabel: template.label }
      : { kind: 'no-template', dayNumber: editor.day.dayNumber };
  }

  const { day } = editor;
  // One after another: `db` may be a transaction client, which runs one query at a time.
  const board = await loadCampaignBoard(db, day.campaignId, { week: weekOf(day.dayNumber), now, timeZone });
  const neighbours = await db.contentCalendar.findMany({
    where: { campaignId: day.campaignId, dayNumber: { in: [day.dayNumber - 1, day.dayNumber + 1] } },
    select: { id: true, dayNumber: true, scheduledDate: true },
  });
  const details = await loadBoardDayDetails(db, day.campaignId, day.id);
  // What made each version, and its raw artwork. The board's details carry
  // neither: the drawer shows a poster, while the editor has to say "this one
  // added a footer you asked for" and to draw a logo preview over the artwork
  // before any mark was on it. One small read rather than widening the board's
  // own view with two fields only this screen uses.
  const studioRows = await db.posterVersion.findMany({
    where: { calendarDayId: day.id },
    select: { id: true, studioGenerationId: true, studioGeneration: { select: { mode: true, prompt: true } } },
  });
  const studio = new Map(studioRows.map((row) => [row.id, row]));
  const card = board.days.find((candidate) => candidate.id === day.id);
  if (!card) throw new CampaignDomainError('not-found', 'That day is not part of its campaign any more. Reload the campaign.');

  const dateFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone });
  const { prev, next } = adjacentDays(neighbours, day.dayNumber);
  const editorHref = templateEditorHref(day.id);
  const active = editor.activeVersion;
  const activeDetails = active ? details.versions.find((version) => version.id === active.id) : undefined;
  const size = templateOutputSize({ width: editor.template.width ?? editor.template.doc.width, height: editor.template.height ?? editor.template.doc.height });

  const screen: TemplateEditorScreen = {
    loadedAt: now.toISOString(),
    day: {
      id: day.id,
      dayNumber: day.dayNumber,
      dateLabel: dateFormat.format(day.scheduledDate),
      isToday: card.isToday,
      contentRevision: day.contentRevision,
      imagePrompt: day.imagePrompt,
    },
    campaign: {
      id: board.campaign.id,
      name: board.campaign.name,
      status: board.campaign.status,
      approvalPolicy: board.campaign.approvalPolicy,
      closed: board.campaign.closed,
      totalDays: board.totalDays,
    },
    client: { id: day.clientId, companyName: day.companyName },
    links: {
      board: campaignBoardHref(day.clientId, day.campaignId, day.dayNumber),
      editor: editorHref,
      brandCanvas: brandCanvasHref(day.clientId, editorHref),
    },
    nav: {
      prev: prev ? { id: prev.id, dayNumber: prev.dayNumber, dateLabel: dateFormat.format(prev.scheduledDate) } : null,
      next: next ? { id: next.id, dayNumber: next.dayNumber, dateLabel: dateFormat.format(next.scheduledDate) } : null,
    },
    template: {
      id: editor.template.id,
      label: editor.template.label,
      thumbnailUrl: `/api/templates/${editor.template.id}/thumbnail?w=320`,
      imageUrl: `/api/templates/${editor.template.id}/thumbnail?w=1080`,
      aspectLabel: size?.aspectLabel ?? null,
      doc: editor.template.doc,
    },
    elements: editor.elements,
    brand: editor.brand,
    colourMode: editor.colourMode,
    activeVersion: active
      ? {
          id: active.id,
          versionNumber: active.versionNumber,
          approvalStatus: active.approvalStatus,
          current: active.current,
          imageUrl: active.imageUrl,
          fullImageUrl: activeDetails?.fullImageUrl ?? null,
          rawImageUrl: rawImageUrlOf(active.id),
          textCheck: active.textCheck,
        }
      : null,
    generation: {
      status: editor.generation.status,
      startedAt: editor.generation.startedAt?.toISOString() ?? null,
      errorMessage: editor.generation.errorMessage,
      inProgress: card.status === 'generating' || isGenerationInProgress(editor.generation.status, editor.generation.startedAt, now, board.campaign.status),
    },
    status: {
      board: card.status,
      boardLabel: BOARD_STATUS_LABELS[card.status],
      posterState: card.posterState,
      note: card.note,
      lock: card.lock,
      lockLabel: card.lock ? SLOT_LOCK_LABELS[card.lock] : null,
    },
    actions: card.actions,
    delivery: card.delivery
      ? {
          status: card.delivery.status,
          statusLabel: DELIVERY_STATUS_LABELS[card.delivery.status],
          whenLabel: formatDisplayDateTime(card.delivery.sentAt ?? card.delivery.scheduledFor, timeZone),
        }
      : null,
    versions: details.versions.map((version) => ({
      id: version.id,
      versionNumber: version.versionNumber,
      source: version.source,
      approvalStatus: version.approvalStatus,
      active: version.active,
      current: version.current,
      imageUrl: version.imageUrl,
      fullImageUrl: version.fullImageUrl,
      textCheckIssues: version.textCheckIssues,
      rejection: version.rejection,
      templateLabel: version.templateLabel,
      createdLabel: formatDisplayDateTime(version.createdAt, timeZone),
      change: changeOf(version.id),
      rawImageUrl: rawImageUrlOf(version.id),
    })),
  };
  return { kind: 'editor', screen };

  /** What one version did to the poster, read from its studio row by the one reader that owns it. */
  function changeOf(versionId: string): PosterChangeSummary | null {
    const row = studio.get(versionId);
    if (!row) return null;
    return posterRevisionSummary(row.studioGeneration?.mode ?? null, row.studioGeneration?.prompt ?? null);
  }

  /** One version's artwork before its logo was composited on, or null for an upload. */
  function rawImageUrlOf(versionId: string): string | null {
    const id = studio.get(versionId)?.studioGenerationId;
    return id ? studioImageUrl(id, { variant: 'raw', width: 1024 }) : null;
  }
}

