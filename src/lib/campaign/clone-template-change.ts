import { Prisma } from '@prisma/client';

import { SLOT_LOCK_LABELS, slotLockOf } from '@/lib/campaign/board';
import { loadCloneBrand } from '@/lib/campaign/clone-queue';
import { bookCampaignDayQuietly, type DeliveryDeps } from '@/lib/campaign/delivery-service';
import { campaignAllowsChanges, effectiveTemplateId, templateAssignmentProblem } from '@/lib/campaign/model';
import {
  isGenerationInProgress,
  TEMPLATE_NOT_READ_MESSAGE,
  templateOutputSize,
  templateShapeOf,
} from '@/lib/campaign/poster-generation';
import { CampaignDomainError, type CampaignDb } from '@/lib/campaign/service';
import { getAppTimeZone } from '@/lib/time';
import {
  cloneTemplateElements,
  legacyContentFields,
  parseDayPosterElements,
  parseTemplateElements,
  resolveDayElements,
  sameDayElements,
  summarizeTemplateElements,
} from '@/lib/types/template-elements';

/**
 * Changing the template of one campaign day — the editor's "Change template".
 *
 *   `listCampaignDayTemplateChoices`  the vertical's active, read templates
 *   `changeCampaignDayTemplate`       re-clone the day from another template
 *
 * A day's poster is its template, cloned, so choosing another template is not a
 * setting on the side: the day's words are replaced by a fresh clone of the new
 * template's (with the template's business name swapped for the client's, as
 * "Fill empty days" does), the headline, supporting text and CTA follow, and the
 * content revision moves — an existing poster becomes outdated and is not sent.
 * The day's image prompt is kept: it describes the photo the admin wants, which
 * no template choice changes.
 *
 * Refused for a day that can no longer change (sent, being sent, due, past, or
 * today after its delivery time — the board's `slotLockOf`), a day whose poster
 * is being generated, a closed campaign, a stale tab (`expectedRevision`), and a
 * template that is inactive, from another vertical, unread, or in a shape clones
 * cannot be made in. The write is one conditional update that restates what was
 * read, so a concurrent claim or edit makes it a conflict rather than an
 * overwrite. No model is called. A change that moves the revision re-syncs the
 * day's delivery booking afterwards (`bookCampaignDayQuietly`), so a booking of
 * the poster it outdated is withdrawn.
 */

// ---------------------------------------------------------------------------
// Choices
// ---------------------------------------------------------------------------

export interface TemplateChoice {
  id: string;
  label: string;
  thumbnailUrl: string;
  /** "Headline · 3 features · CTA · logo · phone". */
  summary: string;
  /** "4:5"; null when clones cannot be made in its shape. */
  aspectLabel: string | null;
  /** The day's current template. */
  current: boolean;
  /** Clones can be made from it (a measurable shape within 1:3–3:1). */
  usable: boolean;
}

/**
 * The templates a day may switch to: its vertical's active templates whose
 * elements have been read, in upload order — the same set "Fill empty days"
 * cycles through. Unusable shapes are listed but marked, so a template does not
 * silently go missing from the list.
 */
export async function listCampaignDayTemplateChoices(db: CampaignDb, dayId: string): Promise<TemplateChoice[]> {
  const day = await db.contentCalendar.findUnique({
    where: { id: dayId },
    select: { posterTemplateId: true, suggestedTemplateId: true, campaign: { select: { categoryId: true, templateMappingMode: true } } },
  });
  if (!day) throw new CampaignDomainError('not-found', 'Campaign day does not exist.');
  if (!day.campaign) throw new CampaignDomainError('not-a-campaign-day', 'This calendar row is not part of a campaign.');

  const current = effectiveTemplateId(day.campaign.templateMappingMode, day);
  const rows = await db.categoryTemplate.findMany({
    where: { categoryId: day.campaign.categoryId, isActive: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, label: true, width: true, height: true, elements: true },
  });

  const choices: TemplateChoice[] = [];
  for (const row of rows) {
    const doc = parseTemplateElements(row.elements);
    if (!doc) continue;
    const size = templateOutputSize(templateShapeOf(row));
    choices.push({
      id: row.id,
      label: row.label,
      thumbnailUrl: `/api/templates/${row.id}/thumbnail?w=320`,
      summary: summarizeTemplateElements(doc),
      aspectLabel: size?.aspectLabel ?? null,
      current: row.id === current,
      usable: size !== null,
    });
  }
  return choices;
}

// ---------------------------------------------------------------------------
// Change
// ---------------------------------------------------------------------------

export interface TemplateChangeResult {
  templateId: string;
  templateLabel: string;
  /** The template or the day's words changed. False when the day already held exactly this clone. */
  changed: boolean;
  revisionBumped: boolean;
  contentRevision: number;
}

export interface TemplateChangeOptions {
  /** The revision the editor was showing. Anything else is a conflict. */
  expectedRevision: number;
  now?: Date;
  timeZone?: string;
  /** Delivery dependencies for the booking re-sync after the change. */
  deliveryDeps?: DeliveryDeps;
}

export async function changeCampaignDayTemplate(
  db: CampaignDb,
  dayId: string,
  templateId: string,
  options: TemplateChangeOptions,
): Promise<TemplateChangeResult> {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? getAppTimeZone();

  const day = await db.contentCalendar.findUnique({
    where: { id: dayId },
    select: {
      id: true,
      dayNumber: true,
      scheduledDate: true,
      clientId: true,
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
      campaign: { select: { status: true, categoryId: true, templateMappingMode: true, deliveryTime: true } },
      delivery: { select: { status: true, scheduledFor: true } },
    },
  });
  if (!day) throw new CampaignDomainError('not-found', 'Campaign day does not exist.');
  if (!day.campaign) throw new CampaignDomainError('not-a-campaign-day', 'This calendar row is not part of a campaign.');
  const campaign = day.campaign;
  if (!campaignAllowsChanges(campaign.status)) throw new CampaignDomainError('campaign-closed', `The campaign is ${campaign.status}.`);
  if (options.expectedRevision !== day.contentRevision) {
    throw new CampaignDomainError('conflict', 'This day was changed by someone else. Reload it and try again.');
  }

  const lock = slotLockOf(day, now, timeZone, campaign.deliveryTime);
  if (lock) throw new CampaignDomainError('invalid-transition', `${SLOT_LOCK_LABELS[lock]} Its template can no longer change.`);
  if (isGenerationInProgress(day.generationStatus, day.posterGenerationStartedAt, now, campaign.status)) {
    throw new CampaignDomainError('invalid-transition', 'A poster is being generated for this day. Change the template once it has finished.');
  }

  const template = await db.categoryTemplate.findUnique({
    where: { id: templateId },
    select: { id: true, label: true, categoryId: true, isActive: true, width: true, height: true, elements: true },
  });
  if (!template) throw new CampaignDomainError('not-found', 'That template no longer exists.');
  const problem = templateAssignmentProblem(template, { categoryId: campaign.categoryId });
  if (problem === 'wrong-vertical') {
    throw new CampaignDomainError('template-not-assignable', `Template “${template.label}” belongs to another vertical.`);
  }
  if (problem === 'inactive') {
    throw new CampaignDomainError('template-not-assignable', `Template “${template.label}” is inactive. Activate it on the vertical first.`);
  }
  const doc = parseTemplateElements(template.elements);
  if (!doc) throw new CampaignDomainError('invalid-transition', TEMPLATE_NOT_READ_MESSAGE);
  if (!templateOutputSize(templateShapeOf(template))) {
    throw new CampaignDomainError('invalid-transition', `Template “${template.label}” has a shape clones cannot be made in. Choose another.`);
  }

  const brand = await loadCloneBrand(db, day.clientId);
  const fresh = cloneTemplateElements(doc, template.id, { businessName: brand.values.companyName });
  const legacy = legacyContentFields(resolveDayElements(doc, fresh, brand.values, day.imagePrompt));

  const templateChanged = effectiveTemplateId(campaign.templateMappingMode, day) !== template.id;
  const changed =
    templateChanged ||
    !sameDayElements(parseDayPosterElements(day.posterElements), fresh) ||
    legacy.headline !== day.headline ||
    legacy.supportingText !== day.supportingText ||
    legacy.cta !== day.cta;
  const alreadySelected = day.posterTemplateId === template.id && day.contentStatus === 'READY' && day.contentIssues.length === 0;

  if (!changed && alreadySelected) {
    return { templateId: template.id, templateLabel: template.label, changed: false, revisionBumped: false, contentRevision: day.contentRevision };
  }

  const updated = await db.contentCalendar.updateMany({
    where: {
      id: day.id,
      contentRevision: day.contentRevision,
      posterTemplateId: day.posterTemplateId,
      suggestedTemplateId: day.suggestedTemplateId,
      generationStatus: day.generationStatus,
      activePosterVersionId: day.activePosterVersionId,
      campaign: { status: campaign.status },
    },
    data: {
      posterTemplateId: template.id,
      ...(day.posterTemplateId !== template.id ? { templateSelectedAt: now } : {}),
      posterElements: fresh as unknown as Prisma.InputJsonValue,
      headline: legacy.headline,
      supportingText: legacy.supportingText,
      cta: legacy.cta,
      contentStatus: 'READY',
      contentIssues: [],
      ...(changed ? { contentRevision: { increment: 1 } } : {}),
    },
  });
  if (updated.count === 0) throw new CampaignDomainError('conflict', 'This day was changed by someone else. Reload it and try again.');
  // The day's poster is outdated now: its booking follows, quietly, after the write.
  if (changed) await bookCampaignDayQuietly(db, day.id, { deps: options.deliveryDeps });

  return {
    templateId: template.id,
    templateLabel: template.label,
    changed,
    revisionBumped: changed,
    contentRevision: day.contentRevision + (changed ? 1 : 0),
  };
}
