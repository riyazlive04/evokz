import type { CampaignStatus, Prisma, PrismaClient, TemplateMappingMode } from '@prisma/client';

import { planContentTypes, resolveContentStrategy } from '@/lib/campaign/content-strategy';
import { campaignAllowsChanges, effectiveTemplateId } from '@/lib/campaign/model';
import { CampaignDomainError, type CampaignDb } from '@/lib/campaign/service';
import {
  aspectFit,
  describeAspect,
  describeDays,
  diagnoseUnmapped,
  dayMappingState,
  expandManualAssignment,
  planAutoMap,
  summarizeMapping,
  templateBlocker,
  type AutoMapPlan,
  type AutoMapScope,
  type DayMappingState,
  type ManualAssignment,
  type MappingDay,
  type MappingIssue,
  type MappingSummary,
  type MappingTarget,
  type MappingTemplate,
} from '@/lib/campaign/template-mapping';
import { optionalEnv } from '@/lib/env';
import { resolveImageSizePreset } from '@/lib/image-sizes';

/**
 * Campaign template mapping — database operations of Phase 3.
 *
 * The Auto Map and Manual Map screens are retired: a campaign's days are filled
 * with template clones (`clone-queue.ts`). What stays in use is
 * `loadMappingContext` (how a day resolves its template, read by poster
 * generation), the template status and delete guards, and the Auto Map /
 * manual mapping writers, which the campaign database checks use as fixtures
 * and which still resolve the one AUTO-mode campaign's suggestions.
 *
 * Loads a campaign's days and its vertical's templates into the shapes
 * `template-mapping.ts` plans over, and writes the results. Like `service.ts`,
 * every function takes `prisma` or a transaction client, writes only campaign
 * days (`campaignId` set), and turns a racing change into a `conflict` rather
 * than overwriting it. Nothing here renders a poster, touches a poster version,
 * or calls a provider.
 *
 * What is written, and nothing else:
 *   Auto Map      `suggestedTemplateId`, `templateSuggestedAt`, and the campaign's
 *                 mode when a MANUAL campaign is switched to AUTO.
 *   Manual map    `posterTemplateId`, `templateSelectedAt`.
 *   Both          `contentRevision + 1` on a day whose effective template changed,
 *                 which is how an existing poster becomes outdated (Phase 1).
 */

/** Template ids per `id IN (…)` statement. */
const WRITE_CHUNK = 500;

/** Like `service.ts`'s, with room for a 730-day campaign's writes. */
function withTransaction<T>(db: CampaignDb, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return '$transaction' in db ? (db as PrismaClient).$transaction(work, { timeout: 60_000, maxWait: 10_000 }) : work(db);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

// ---------------------------------------------------------------------------
// Template shape
// ---------------------------------------------------------------------------

interface TemplateRow {
  id: string;
  label: string;
  categoryId: string;
  isActive: boolean;
  width: number | null;
  height: number | null;
  createdAt: Date;
}

const templateSelect = {
  id: true,
  label: true,
  categoryId: true,
  isActive: true,
  width: true,
  height: true,
  createdAt: true,
} satisfies Prisma.CategoryTemplateSelect;

/**
 * A template as the mapper sees it. Its shape is the template image's own,
 * measured at upload — the image is what the poster is generated from — and 0
 * when the upload could not be measured.
 */
function toMappingTemplates(rows: readonly TemplateRow[]): Array<MappingTemplate & { createdAt: Date }> {
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    categoryId: row.categoryId,
    isActive: row.isActive,
    aspect: row.width && row.height && row.width > 0 && row.height > 0 ? row.width / row.height : 0,
    createdAt: row.createdAt,
  }));
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface MappingDayRow extends MappingDay {
  /** Where `contentType` came from. */
  contentTypeSource: 'stored' | 'planned' | 'none';
  contentRevision: number;
  templateSelectedAt: Date | null;
  templateSuggestedAt: Date | null;
}

export interface MappingContext {
  campaign: {
    id: string;
    clientId: string;
    name: string;
    status: CampaignStatus;
    mode: TemplateMappingMode;
    categoryId: string;
    durationDays: number;
  };
  target: MappingTarget;
  /** The vertical's templates in upload order, then any foreign template a day references. */
  templates: Array<MappingTemplate & { createdAt: Date }>;
  days: MappingDayRow[];
}

export async function loadMappingContext(db: CampaignDb, campaignId: string): Promise<MappingContext> {
  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      clientId: true,
      name: true,
      status: true,
      templateMappingMode: true,
      categoryId: true,
      durationDays: true,
      client: { select: { imageSizePreset: true } },
      category: { select: { contentStrategy: true } },
      days: {
        orderBy: { dayNumber: 'asc' },
        select: {
          id: true,
          dayNumber: true,
          contentType: true,
          posterTemplateId: true,
          suggestedTemplateId: true,
          contentRevision: true,
          templateSelectedAt: true,
          templateSuggestedAt: true,
        },
      },
    },
  });
  if (!campaign) throw new CampaignDomainError('not-found', 'Campaign does not exist.');

  const { strategy } = resolveContentStrategy(campaign.category.contentStrategy);
  const planned = planContentTypes(strategy, campaign.durationDays);

  const verticalRows = await db.categoryTemplate.findMany({
    where: { categoryId: campaign.categoryId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: templateSelect,
  });
  const known = new Set(verticalRows.map((row) => row.id));
  const referenced = [
    ...new Set(
      campaign.days.flatMap((day) => [day.posterTemplateId, day.suggestedTemplateId]).filter((id): id is string => id !== null && !known.has(id)),
    ),
  ];
  const foreignRows = referenced.length
    ? await db.categoryTemplate.findMany({ where: { id: { in: referenced } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: templateSelect })
    : [];

  const preset = resolveImageSizePreset(campaign.client.imageSizePreset, optionalEnv('FAL_IMAGE_SIZE', ''));
  const presetAspect = preset.width / preset.height;

  return {
    campaign: {
      id: campaign.id,
      clientId: campaign.clientId,
      name: campaign.name,
      status: campaign.status,
      mode: campaign.templateMappingMode,
      categoryId: campaign.categoryId,
      durationDays: campaign.durationDays,
    },
    target: {
      categoryId: campaign.categoryId,
      mode: campaign.templateMappingMode,
      aspect: presetAspect,
      aspectLabel: describeAspect(presetAspect),
    },
    templates: toMappingTemplates([...verticalRows, ...foreignRows]),
    days: campaign.days.map((day) => {
      const plannedType = planned[day.dayNumber - 1] ?? null;
      return {
        ...day,
        contentType: day.contentType ?? plannedType,
        contentTypeSource: day.contentType ? 'stored' : plannedType ? 'planned' : 'none',
      };
    }),
  };
}

export interface CampaignMappingOverview {
  context: MappingContext;
  states: Map<string, DayMappingState>;
  /** For unmapped days with no compatible template: why. */
  unmappedReasons: Map<string, MappingIssue>;
  summary: MappingSummary;
  /** Open-campaign days per template id, counting only effective mappings. */
  usage: Map<string, { auto: number; manual: number }>;
}

/** The campaign's mapping as it stands: every day's state, the attention list and counts. */
export async function loadCampaignMappingOverview(db: CampaignDb, campaignId: string): Promise<CampaignMappingOverview> {
  const context = await loadMappingContext(db, campaignId);
  const byId = new Map(context.templates.map((template) => [template.id, template]));
  const states = new Map<string, DayMappingState>();
  const unmappedReasons = new Map<string, MappingIssue>();
  const usage = new Map<string, { auto: number; manual: number }>();

  const rows = context.days.map((day) => {
    const state = dayMappingState(day, byId, context.target);
    states.set(day.id, state);
    const reason = state.templateId ? null : diagnoseUnmapped(context.templates, context.target);
    if (reason) unmappedReasons.set(day.id, reason);
    if (state.templateId) {
      const counts = usage.get(state.templateId) ?? { auto: 0, manual: 0 };
      if (state.source === 'MANUAL') counts.manual += 1;
      else counts.auto += 1;
      usage.set(state.templateId, counts);
    }
    return { dayNumber: day.dayNumber, state, unmappedReason: reason };
  });

  return { context, states, unmappedReasons, summary: summarizeMapping(rows), usage };
}

function assertOpen(context: MappingContext): void {
  if (!campaignAllowsChanges(context.campaign.status)) {
    throw new CampaignDomainError('campaign-closed', `The campaign is ${context.campaign.status}.`);
  }
}

// ---------------------------------------------------------------------------
// Auto Map
// ---------------------------------------------------------------------------

export async function previewAutoMap(
  db: CampaignDb,
  campaignId: string,
  options: { scope?: AutoMapScope } = {},
): Promise<{ context: MappingContext; plan: AutoMapPlan }> {
  const context = await loadMappingContext(db, campaignId);
  return {
    context,
    plan: planAutoMap({ days: context.days, templates: context.templates, target: context.target, scope: options.scope }),
  };
}

export interface ApplyAutoMapResult {
  plan: AutoMapPlan;
  /** Rows written (suggestion and/or revision). */
  daysWritten: number;
  /** Days whose effective template changed. */
  revisionsBumped: number;
  switchedToAuto: boolean;
}

/**
 * Applies exactly the plan the operator previewed.
 *
 * The plan is recomputed from fresh rows inside the transaction and must match
 * the preview's fingerprint; anything that changed meanwhile (a manual
 * selection, a template deactivated, new content) is a `conflict` and nothing
 * is written. Every row update also restates the template columns it read, so
 * a manual selection made between the read and the write cannot be overwritten.
 */
export async function applyAutoMap(
  db: CampaignDb,
  campaignId: string,
  input: { scope?: AutoMapScope; fingerprint: string; now?: Date },
): Promise<ApplyAutoMapResult> {
  const now = input.now ?? new Date();

  return withTransaction(db, async (tx) => {
    const context = await loadMappingContext(tx, campaignId);
    assertOpen(context);
    const plan = planAutoMap({ days: context.days, templates: context.templates, target: context.target, scope: input.scope });
    if (plan.fingerprint !== input.fingerprint) {
      throw new CampaignDomainError('conflict', 'The campaign changed since this preview. Preview Auto Map again.');
    }

    if (plan.switchesMode) {
      const switched = await tx.campaign.updateMany({
        where: { id: campaignId, templateMappingMode: 'MANUAL' },
        data: { templateMappingMode: 'AUTO' },
      });
      if (switched.count === 0) throw new CampaignDomainError('conflict', 'The mapping mode changed meanwhile.');
    }

    const daysById = new Map(context.days.map((day) => [day.id, day]));
    const groups = new Map<string, { from: string | null; to: string | null; write: boolean; bump: boolean; ids: string[] }>();
    for (const entry of plan.entries) {
      if (entry.outcome === 'manual' || (!entry.writesSuggestion && !entry.effectiveChanges)) continue;
      const from = daysById.get(entry.dayId)!.suggestedTemplateId;
      const key = `${from}|${entry.suggestedTemplateId}|${entry.writesSuggestion}|${entry.effectiveChanges}`;
      const group = groups.get(key) ?? { from, to: entry.suggestedTemplateId, write: entry.writesSuggestion, bump: entry.effectiveChanges, ids: [] };
      group.ids.push(entry.dayId);
      groups.set(key, group);
    }

    let daysWritten = 0;
    let revisionsBumped = 0;
    for (const group of groups.values()) {
      for (const ids of chunks(group.ids, WRITE_CHUNK)) {
        const updated = await tx.contentCalendar.updateMany({
          where: { id: { in: ids }, campaignId, posterTemplateId: null, suggestedTemplateId: group.from },
          data: {
            ...(group.write ? { suggestedTemplateId: group.to, templateSuggestedAt: group.to ? now : null } : {}),
            ...(group.bump ? { contentRevision: { increment: 1 } } : {}),
          },
        });
        if (updated.count !== ids.length) {
          throw new CampaignDomainError('conflict', 'Some days were mapped by someone else meanwhile. Preview Auto Map again.');
        }
        daysWritten += updated.count;
        if (group.bump) revisionsBumped += updated.count;
      }
    }

    return { plan, daysWritten, revisionsBumped, switchedToAuto: plan.switchesMode };
  });
}

// ---------------------------------------------------------------------------
// Manual and bulk mapping
// ---------------------------------------------------------------------------

export interface ManualMappingResult {
  /** Days whose selection changed, in day order. */
  changedDays: number[];
  /** Days that already had exactly this selection. */
  unchanged: number;
  /** Days left alone because they already had a manual template (`skipManual`). */
  skippedManual: number;
  revisionsBumped: number;
  /** Deliberate but notable choices: a template of a different shape. */
  warnings: string[];
}

/**
 * Sets (or clears) the operator's template on one or many days — a single day,
 * a selection, a range or a repeating pattern. Replaces a manual selection on
 * the days named; `skipManual` leaves days that already have one alone.
 *
 * Refused as a whole, before any write, when a template is from another
 * vertical or inactive. A different shape is allowed and reported as a warning:
 * a person choosing it is a decision.
 */
export async function assignManualTemplates(
  db: CampaignDb,
  campaignId: string,
  assignment: ManualAssignment,
  options: { skipManual?: boolean; now?: Date } = {},
): Promise<ManualMappingResult> {
  const now = options.now ?? new Date();

  return withTransaction(db, async (tx) => {
    const context = await loadMappingContext(tx, campaignId);
    assertOpen(context);

    const expanded = expandManualAssignment(assignment, context.campaign.durationDays);
    if (!expanded.ok) throw new CampaignDomainError('invalid-input', expanded.error);

    const templatesById = new Map(context.templates.map((template) => [template.id, template]));
    const requested = [...new Set(expanded.items.map((item) => item.templateId).filter((id): id is string => id !== null))];
    const missing = requested.filter((id) => !templatesById.has(id));
    if (missing.length > 0) {
      const found = await tx.categoryTemplate.findMany({ where: { id: { in: missing } }, select: templateSelect });
      if (found.length !== missing.length) throw new CampaignDomainError('not-found', 'Template does not exist.');
      for (const template of toMappingTemplates(found)) {
        templatesById.set(template.id, template);
      }
    }
    for (const id of requested) {
      const template = templatesById.get(id)!;
      const blocker = templateBlocker(template, context.target);
      if (blocker) {
        throw new CampaignDomainError(
          'template-not-assignable',
          blocker === 'wrong-vertical'
            ? `“${template.label}” belongs to a different vertical from the campaign's.`
            : `“${template.label}” is inactive.`,
        );
      }
    }

    const daysByNumber = new Map(context.days.map((day) => [day.dayNumber, day]));
    const mode = context.campaign.mode;
    const groups = new Map<string, { from: string | null; to: string | null; bump: boolean; ids: string[] }>();
    const changedDays: number[] = [];
    const warnings = new Map<string, number[]>();
    let unchanged = 0;
    let skippedManual = 0;

    for (const item of expanded.items) {
      const day = daysByNumber.get(item.dayNumber);
      if (!day) throw new CampaignDomainError('not-found', `Day ${item.dayNumber} does not exist in this campaign.`);
      if (day.posterTemplateId === item.templateId) {
        unchanged += 1;
        continue;
      }
      if (options.skipManual && day.posterTemplateId && item.templateId !== null) {
        skippedManual += 1;
        continue;
      }

      const bump =
        effectiveTemplateId(mode, day) !==
        effectiveTemplateId(mode, { posterTemplateId: item.templateId, suggestedTemplateId: day.suggestedTemplateId });
      const key = `${day.posterTemplateId}|${item.templateId}|${bump}`;
      const group = groups.get(key) ?? { from: day.posterTemplateId, to: item.templateId, bump, ids: [] };
      group.ids.push(day.id);
      groups.set(key, group);
      changedDays.push(day.dayNumber);

      if (item.templateId) {
        const template = templatesById.get(item.templateId)!;
        if (aspectFit(template.aspect, context.target.aspect) === 'mismatch') {
          const note = `“${template.label}” is ${describeAspect(template.aspect)}, not ${context.target.aspectLabel}`;
          warnings.set(note, [...(warnings.get(note) ?? []), day.dayNumber]);
        }
      }
    }

    let revisionsBumped = 0;
    for (const group of groups.values()) {
      for (const ids of chunks(group.ids, WRITE_CHUNK)) {
        const updated = await tx.contentCalendar.updateMany({
          where: { id: { in: ids }, campaignId, posterTemplateId: group.from },
          data: {
            posterTemplateId: group.to,
            templateSelectedAt: group.to ? now : null,
            ...(group.bump ? { contentRevision: { increment: 1 } } : {}),
          },
        });
        if (updated.count !== ids.length) {
          throw new CampaignDomainError('conflict', 'Some days were mapped by someone else meanwhile. Reload and try again.');
        }
        if (group.bump) revisionsBumped += updated.count;
      }
    }

    return {
      changedDays: changedDays.sort((a, b) => a - b),
      unchanged,
      skippedManual,
      revisionsBumped,
      warnings: [...warnings].map(([note, dayNumbers]) => `${note} (${describeDays(dayNumbers)}).`),
    };
  });
}

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

/**
 * AUTO ⇄ MANUAL. Stored suggestions are kept either way; under MANUAL they stop
 * counting, so days with a suggestion and no selection change their effective
 * template, and their revision moves exactly as a mapping change would.
 */
export async function changeTemplateMappingMode(
  db: CampaignDb,
  campaignId: string,
  mode: TemplateMappingMode,
): Promise<{ changed: boolean; daysAffected: number }> {
  return withTransaction(db, async (tx) => {
    const campaign = await tx.campaign.findUnique({ where: { id: campaignId }, select: { status: true, templateMappingMode: true } });
    if (!campaign) throw new CampaignDomainError('not-found', 'Campaign does not exist.');
    if (!campaignAllowsChanges(campaign.status)) throw new CampaignDomainError('campaign-closed', `The campaign is ${campaign.status}.`);
    if (campaign.templateMappingMode === mode) return { changed: false, daysAffected: 0 };

    const switched = await tx.campaign.updateMany({
      where: { id: campaignId, templateMappingMode: campaign.templateMappingMode },
      data: { templateMappingMode: mode },
    });
    if (switched.count === 0) throw new CampaignDomainError('conflict', 'The mapping mode changed meanwhile.');

    const affected = await tx.contentCalendar.updateMany({
      where: { campaignId, posterTemplateId: null, suggestedTemplateId: { not: null } },
      data: { contentRevision: { increment: 1 } },
    });
    return { changed: true, daysAffected: affected.count };
  });
}

// ---------------------------------------------------------------------------
// Template metadata
// ---------------------------------------------------------------------------

const OPEN_CAMPAIGN_STATUSES: CampaignStatus[] = ['DRAFT', 'ACTIVE', 'PAUSED'];

/** Days of open campaigns whose effective template is this one. */
export function countOpenCampaignDaysUsingTemplate(db: CampaignDb, templateId: string): Promise<number> {
  return db.contentCalendar.count({
    where: {
      campaign: { status: { in: OPEN_CAMPAIGN_STATUSES } },
      OR: [
        { posterTemplateId: templateId },
        { posterTemplateId: null, suggestedTemplateId: templateId, campaign: { templateMappingMode: 'AUTO' } },
      ],
    },
  });
}

/**
 * Days of open campaigns that reference this template at all, as a selection or
 * a suggestion. Deleting the template would SetNull every one of them — silently
 * discarding mappings — so deletion is refused while this is non-zero.
 */
export function countOpenCampaignDaysReferencingTemplate(db: CampaignDb, templateId: string): Promise<number> {
  return db.contentCalendar.count({
    where: {
      campaign: { status: { in: OPEN_CAMPAIGN_STATUSES } },
      OR: [{ posterTemplateId: templateId }, { suggestedTemplateId: templateId }],
    },
  });
}

/**
 * Activates or deactivates a template. Changes the template row only: every
 * campaign day using it keeps it, and is flagged until someone replaces it.
 */
export async function setTemplateActive(
  db: CampaignDb,
  templateId: string,
  active: boolean,
): Promise<{ active: boolean; campaignDaysAffected: number }> {
  const updated = await db.categoryTemplate.updateMany({ where: { id: templateId }, data: { isActive: active } });
  if (updated.count === 0) throw new CampaignDomainError('not-found', 'Template does not exist.');
  return { active, campaignDaysAffected: await countOpenCampaignDaysUsingTemplate(db, templateId) };
}
