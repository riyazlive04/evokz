import { Prisma } from '@prisma/client';

import { cloneAccentColors } from '@/lib/ai/studio-prompts';
import { formatPhone, normalizeTagline, normalizeWebsite } from '@/lib/brand/identity-format';
import { slotLockOf } from '@/lib/campaign/board';
import { bookCampaignDayQuietly, type DeliveryDeps } from '@/lib/campaign/delivery-service';
import { campaignAllowsChanges, effectiveTemplateId } from '@/lib/campaign/model';
import { isGenerationInProgress } from '@/lib/campaign/poster-generation';
import { CampaignDomainError, type CampaignDb } from '@/lib/campaign/service';
import { hasBrandCanvasLogo } from '@/lib/poster-studio/brand-logo';
import { studioClientLogoUrl } from '@/lib/poster-studio/limits';
import { getAppTimeZone } from '@/lib/time';
import { parseBrandGuideline } from '@/lib/types/brand';
import {
  cloneTemplateElements,
  legacyContentFields,
  parseDayPosterElements,
  parseTemplateElements,
  resolveDayElements,
  sameDayElements,
  seedDayElementsFromLegacy,
  type CloneBrandValues,
  type TemplateElementsDoc,
} from '@/lib/types/template-elements';

/**
 * Clone into queue — the campaign's days filled with its vertical's templates.
 *
 * When a campaign is created, and whenever an admin presses "Fill empty days",
 * the vertical's active templates that have been read and are in the daily
 * rotation (`autoAssign`) are laid across the days in upload order, cycling.
 * Each filled day gets its template (`posterTemplateId`) and a fresh copy of the
 * template's words (`posterElements`, with the template's business name swapped
 * for the client's), so it is ready to generate: its content status is READY
 * because the template's words are ready content. No model is called and nothing is
 * generated here.
 *
 * **Existing content is kept.** A day that already has a usable template — one
 * an operator selected, or an Auto Map suggestion, whose elements have been read
 * — is filled from that template, not the cycle's; that includes a template out
 * of the rotation, which is how a festival day survives a later "Fill empty
 * days". A day with content but no elements yet (the AI content calendar's
 * headline, supporting text and CTA) has that content seeded into the matching
 * elements (`seedDayElementsFromLegacy`) instead of overwritten, and a day's
 * image prompt is never cleared.
 *
 * `planCloneQueue` is the pure planner; `cloneTemplatesIntoCampaign` loads,
 * plans and writes, each write a conditional update that restates what was read.
 */

// ---------------------------------------------------------------------------
// Planner — pure
// ---------------------------------------------------------------------------

export interface CloneQueueDay {
  id: string;
  dayNumber: number;
  /** The day's current effective template, or null. */
  templateId: string | null;
  /** The day may receive a clone now. A day that may not keeps its template. */
  eligible: boolean;
}

export interface CloneAssignment {
  dayId: string;
  dayNumber: number;
  templateId: string;
}

/**
 * Which template each eligible day gets.
 *
 * Templates cycle across **all** the campaign's days in day order: the day at
 * position k prefers template k mod n, so filling some days of a partly filled
 * campaign gives each the template it would have had anyway. When that template
 * would repeat the day before (whatever that day now holds) or the day after (a
 * day that keeps its template), the next template in the cycle that repeats
 * neither is taken; with only two templates and both neighbours taken, the one
 * that at least differs from the day before. One template repeats, necessarily.
 */
export function planCloneQueue(days: readonly CloneQueueDay[], templateIds: readonly string[]): CloneAssignment[] {
  if (templateIds.length === 0) return [];
  const ordered = [...days].sort((a, b) => a.dayNumber - b.dayNumber);
  const assignments: CloneAssignment[] = [];
  const count = templateIds.length;
  let previous: string | null = null;

  ordered.forEach((day, position) => {
    if (!day.eligible) {
      previous = day.templateId;
      return;
    }
    const next = ordered[position + 1];
    const nextFixed = next && !next.eligible ? next.templateId : null;
    const candidates = Array.from({ length: count }, (_, offset) => templateIds[(position + offset) % count]!);
    const chosen =
      candidates.find((id) => id !== previous && id !== nextFixed) ?? candidates.find((id) => id !== previous) ?? candidates[0]!;
    assignments.push({ dayId: day.id, dayNumber: day.dayNumber, templateId: chosen });
    previous = chosen;
  });
  return assignments;
}

// ---------------------------------------------------------------------------
// Brand Canvas values, read through the caller's database handle
// ---------------------------------------------------------------------------

export interface CloneBrand {
  clientId: string;
  values: CloneBrandValues;
  /** Brand colours a clone recolours to — accent roles only; empty keeps the template's colours. */
  colors: Array<{ hex: string; role: string }>;
  /** The Brand Canvas logo through the protected route, or null when there is none. */
  logoUrl: string | null;
  /**
   * The same logo with its transparent padding cut away — the mark exactly as a
   * clone composites it. What a logo-placement preview must draw: the uploaded
   * file's own proportions are the padding's, not the mark's.
   */
  logoTrimmedUrl: string | null;
}

/**
 * A client's Brand Canvas values for clone mode, formatted exactly as
 * `loadStudioBrandCanvas` formats them, read with the caller's handle so it runs
 * inside a transaction. Reads no logo bytes: whether one exists is enough here.
 */
export async function loadCloneBrand(db: CampaignDb, clientId: string): Promise<CloneBrand> {
  const client = await db.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      companyName: true,
      brandTagline: true,
      brandGuideline: true,
      websiteUrl: true,
      displayPhone: true,
      whatsappNumber: true,
      logoUrl: true,
      logoDriveFileId: true,
      logoOriginalUrl: true,
      logoOriginalDriveFileId: true,
      logoBackgroundRemoved: true,
      logoIncludesName: true,
    },
  });
  if (!client) throw new CampaignDomainError('not-found', 'Client does not exist.');
  const hasLogo = hasBrandCanvasLogo(client);
  const colors = parseBrandGuideline(client.brandGuideline).colors.map((color) => ({ hex: color.hex.toUpperCase(), role: color.role.trim().toLowerCase() }));
  return {
    clientId: client.id,
    values: {
      companyName: client.companyName,
      tagline: normalizeTagline(client.brandTagline),
      phone: formatPhone(client.displayPhone, client.whatsappNumber) || null,
      website: normalizeWebsite(client.websiteUrl),
      hasLogo,
      logoIncludesName: client.logoIncludesName,
    },
    colors: cloneAccentColors(colors),
    logoUrl: hasLogo ? studioClientLogoUrl(client.id, client.logoBackgroundRemoved ? 'REMOVED' : 'ORIGINAL') : null,
    logoTrimmedUrl: hasLogo ? studioClientLogoUrl(client.id, client.logoBackgroundRemoved ? 'REMOVED' : 'ORIGINAL', 480, { trim: true }) : null,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface CloneIntoQueueOptions {
  /**
   * Default true: only days with no poster that have not been cloned for their
   * current template yet. A day an admin already edited keeps its words. False
   * re-clones every day that may change, posters or not.
   */
  onlyEmpty?: boolean;
  now?: Date;
  timeZone?: string;
  /** Delivery dependencies for the booking re-sync of a re-cloned day that had a poster. */
  deliveryDeps?: DeliveryDeps;
}

export interface CloneIntoQueueResult {
  /** Active, read templates the days were filled from. */
  templates: number;
  /** Days given a fresh clone. */
  filled: number[];
  /** Eligible days that already held exactly that clone. */
  unchanged: number[];
  /** Filled days whose content revision moved (template or words changed). */
  revisionsBumped: number;
  skipped: {
    /** Days with a poster (only when `onlyEmpty`). */
    hasPoster: number[];
    /** Days already cloned for their template (only when `onlyEmpty`). */
    alreadyCloned: number[];
    /** Sent, sending, due, past or closed days. */
    locked: number[];
    /** Days with a generation queued or running. */
    generating: number[];
  };
  /** Days that changed while filling and were left alone. */
  conflicts: number[];
}

/**
 * Fills a campaign's days with cloned templates. Best-effort by day: a day that
 * changed meanwhile is reported as a conflict and left alone.
 *
 * Refused for a completed or cancelled campaign. A vertical with no read, active
 * template in the rotation fills nothing and says so (`templates: 0`).
 */
export async function cloneTemplatesIntoCampaign(
  db: CampaignDb,
  campaignId: string,
  options: CloneIntoQueueOptions = {},
): Promise<CloneIntoQueueResult> {
  const onlyEmpty = options.onlyEmpty ?? true;
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? getAppTimeZone();

  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      status: true,
      categoryId: true,
      clientId: true,
      deliveryTime: true,
      templateMappingMode: true,
      days: {
        orderBy: { dayNumber: 'asc' },
        select: {
          id: true,
          dayNumber: true,
          scheduledDate: true,
          contentRevision: true,
          contentStatus: true,
          contentIssues: true,
          posterTemplateId: true,
          suggestedTemplateId: true,
          posterElements: true,
          imagePrompt: true,
          headline: true,
          supportingText: true,
          cta: true,
          generationStatus: true,
          posterGenerationStartedAt: true,
          activePosterVersionId: true,
          delivery: { select: { status: true, scheduledFor: true } },
        },
      },
    },
  });
  if (!campaign) throw new CampaignDomainError('not-found', 'Campaign does not exist.');
  if (!campaignAllowsChanges(campaign.status)) throw new CampaignDomainError('campaign-closed', `The campaign is ${campaign.status}.`);

  const result: CloneIntoQueueResult = {
    templates: 0,
    filled: [],
    unchanged: [],
    revisionsBumped: 0,
    skipped: { hasPoster: [], alreadyCloned: [], locked: [], generating: [] },
    conflicts: [],
  };

  const rows = await db.categoryTemplate.findMany({
    where: { categoryId: campaign.categoryId, isActive: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, elements: true, autoAssign: true },
  });
  /*
   * Two sets, and the difference matters.
   *
   * `docs` is every readable template of the vertical — what a day may already
   * hold, and what its words are cloned from. `rotation` is the subset the cycle
   * may choose from: `autoAssign: false` takes a template out of it without
   * retiring it, so a festival design is chosen by hand on its day and never
   * cycled onto an ordinary one.
   *
   * Filtering the query itself would be worse than useless: a day pinned to a
   * festival design would then look like a day with no usable template, and this
   * very run would clone an ordinary one over it.
   */
  const docs = new Map<string, TemplateElementsDoc>();
  const rotation: string[] = [];
  for (const row of rows) {
    const doc = parseTemplateElements(row.elements);
    if (!doc) continue;
    docs.set(row.id, doc);
    if (row.autoAssign) rotation.push(row.id);
  }
  // What fills empty days: a vertical whose every template is out of the rotation
  // fills nothing, exactly as one with no read template does.
  result.templates = rotation.length;
  if (rotation.length === 0) return result;

  const brand = await loadCloneBrand(db, campaign.clientId);

  const planned: CloneQueueDay[] = [];
  /** Eligible days that already have a usable template: filled from it, never from the cycle's. */
  const ownTemplate: CloneAssignment[] = [];
  for (const day of campaign.days) {
    const templateId = effectiveTemplateId(campaign.templateMappingMode, day);
    let eligible = true;
    if (slotLockOf(day, now, timeZone, campaign.deliveryTime) !== null) {
      result.skipped.locked.push(day.dayNumber);
      eligible = false;
    } else if (isGenerationInProgress(day.generationStatus, day.posterGenerationStartedAt, now, campaign.status)) {
      result.skipped.generating.push(day.dayNumber);
      eligible = false;
    } else if (onlyEmpty && day.activePosterVersionId) {
      result.skipped.hasPoster.push(day.dayNumber);
      eligible = false;
    } else if (onlyEmpty && templateId && docs.has(templateId) && parseDayPosterElements(day.posterElements)?.templateId === templateId) {
      result.skipped.alreadyCloned.push(day.dayNumber);
      eligible = false;
    }
    if (eligible && templateId && docs.has(templateId)) {
      // To the planner it is a day that keeps its template, so its neighbours avoid repeating it.
      ownTemplate.push({ dayId: day.id, dayNumber: day.dayNumber, templateId });
      planned.push({ id: day.id, dayNumber: day.dayNumber, templateId, eligible: false });
    } else {
      planned.push({ id: day.id, dayNumber: day.dayNumber, templateId, eligible });
    }
  }

  const byId = new Map(campaign.days.map((day) => [day.id, day]));
  const assignments = [...planCloneQueue(planned, rotation), ...ownTemplate].sort((a, b) => a.dayNumber - b.dayNumber);
  for (const assignment of assignments) {
    const day = byId.get(assignment.dayId)!;
    const doc = docs.get(assignment.templateId)!;
    const stored = parseDayPosterElements(day.posterElements);
    const cloneOptions = { businessName: brand.values.companyName };
    // A day with no elements yet keeps its content, seeded into the elements; a
    // day that has elements (for another template, or re-cloned on purpose)
    // starts again from the template's words.
    const next = stored
      ? cloneTemplateElements(doc, assignment.templateId, cloneOptions)
      : seedDayElementsFromLegacy(doc, assignment.templateId, day, cloneOptions);
    const legacy = legacyContentFields(resolveDayElements(doc, next, brand.values, day.imagePrompt));

    const templateChanged = effectiveTemplateId(campaign.templateMappingMode, day) !== assignment.templateId;
    const inputsChanged =
      !sameDayElements(stored, next) ||
      day.headline !== legacy.headline ||
      day.supportingText !== legacy.supportingText ||
      day.cta !== legacy.cta;
    const bump = templateChanged || inputsChanged;

    if (!bump && day.posterTemplateId === assignment.templateId && day.contentStatus === 'READY' && day.contentIssues.length === 0) {
      result.unchanged.push(day.dayNumber);
      continue;
    }

    const updated = await db.contentCalendar.updateMany({
      where: {
        id: day.id,
        campaignId,
        contentRevision: day.contentRevision,
        posterTemplateId: day.posterTemplateId,
        suggestedTemplateId: day.suggestedTemplateId,
        activePosterVersionId: day.activePosterVersionId,
        generationStatus: day.generationStatus,
      },
      data: {
        posterTemplateId: assignment.templateId,
        ...(day.posterTemplateId !== assignment.templateId ? { templateSelectedAt: now } : {}),
        posterElements: next as unknown as Prisma.InputJsonValue,
        headline: legacy.headline,
        supportingText: legacy.supportingText,
        cta: legacy.cta,
        contentStatus: 'READY',
        contentIssues: [],
        ...(bump ? { contentRevision: { increment: 1 } } : {}),
      },
    });
    if (updated.count === 0) {
      result.conflicts.push(day.dayNumber);
      continue;
    }
    result.filled.push(day.dayNumber);
    if (bump) {
      result.revisionsBumped += 1;
      // A re-cloned day's poster is now outdated: its booking follows, quietly,
      // after the write. A day with neither a poster nor a booking has none to sync.
      if (day.activePosterVersionId || day.delivery) await bookCampaignDayQuietly(db, day.id, { deps: options.deliveryDeps });
    }
  }

  return result;
}
