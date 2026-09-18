import { Prisma, type PosterApprovalStatus, type PosterGenerationStatus } from '@prisma/client';

import { generateStructured, getModel, LlmError } from '@/lib/ai/openai';
import { parsePaletteSource, type PaletteSource } from '@/lib/ai/studio-prompts';
import { SLOT_LOCK_LABELS, slotLockOf } from '@/lib/campaign/board';
import { loadCloneBrand, type CloneBrand } from '@/lib/campaign/clone-queue';
import { bookCampaignDayQuietly, type DeliveryDeps } from '@/lib/campaign/delivery-service';
import { campaignAllowsChanges, effectiveTemplateId, isVersionCurrent } from '@/lib/campaign/model';
import { isGenerationInProgress, TEMPLATE_NOT_READ_MESSAGE } from '@/lib/campaign/poster-generation';
import { CampaignDomainError, type CampaignDb } from '@/lib/campaign/service';
import { MissingEnvError } from '@/lib/env';
import { studioImageUrl } from '@/lib/poster-studio/limits';
import { getAppTimeZone } from '@/lib/time';
import {
  CONTENT_KINDS,
  elementLabel,
  IMAGE_KINDS,
  legacyContentFields,
  LONG_NUMBER,
  materializeDayElements,
  MAX_ELEMENT_TEXT,
  parseDayPosterElements,
  parseTemplateElements,
  parseTextCheck,
  resolveDayElements,
  sameDayElements,
  templateBindings,
  URL_OR_EMAIL,
  type CloneBrandValues,
  type DayPosterElementsDoc,
  type PosterElementValue,
  type ResolvedElement,
  type TemplateElementKind,
  type TemplateElementsDoc,
  type TextCheckResult,
} from '@/lib/types/template-elements';

/**
 * Editing a cloned campaign poster's elements — the services behind Poster
 * Studio's template editor and the board's "Rewrite all drafts".
 *
 *   `loadCampaignDayCloneEditor`   everything the editor shows for one day
 *   `updateCampaignDayElements`    the admin's words, removals and image prompt
 *   `rewriteCampaignDayElements`   fresh wording from one cheap text call
 *   `rewriteDraftDays`             the same for several days without a poster
 *
 * Identity is never edited here: the business name, tagline, phone, website and
 * logo — and the person name or credential a template binds to them — come from
 * Brand Canvas at generation time (`templateBindings`). A save bumps the day's
 * `contentRevision` only when its words, removals or image prompt changed, which
 * is how an existing poster becomes outdated; headline, supporting text and CTA
 * follow the elements so review, captions and search keep working.
 *
 * A day with content but no elements yet (the AI content calendar's) is shown
 * and saved as a clone seeded with that content (`materializeDayElements`), never
 * with the template's words over it. A save that moves the revision re-syncs the
 * day's delivery booking afterwards, so a booking of the poster it outdated is
 * withdrawn. Saves are refused, as a template change is, on a day that can no
 * longer change (sent, sending, due, past, or today after its delivery time) and
 * on a day whose poster is queued or being generated.
 */

/** Longest image prompt a day stores, matching `updateCampaignDayContent`. */
export const MAX_IMAGE_PROMPT = 4_000;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface CampaignDayCloneEditor {
  day: {
    id: string;
    dayNumber: number;
    scheduledDate: Date;
    campaignId: string;
    campaignName: string;
    clientId: string;
    companyName: string;
    contentRevision: number;
    imagePrompt: string;
  };
  /** The day's template, when it has one whose elements have been read. */
  template: { id: string; label: string; width: number | null; height: number | null; thumbnailUrl: string; doc: TemplateElementsDoc } | null;
  /** The day's values for the template's elements, reconciled (not yet saved when the day has none). */
  elements: DayPosterElementsDoc | null;
  resolved: ResolvedElement[];
  brand: CloneBrandValues & { colors: Array<{ hex: string; role: string }>; logoUrl: string | null; logoTrimmedUrl: string | null };
  /**
   * `brand` when the clone recolours to brand accent colours; `template` keeps the
   * template's own — either because the client has no accent colours, or because
   * the template is set to keep its palette (`CategoryTemplate.paletteSource`).
   */
  colourMode: 'brand' | 'template';
  activeVersion: {
    id: string;
    versionNumber: number;
    approvalStatus: PosterApprovalStatus;
    current: boolean;
    imageUrl: string | null;
    textCheck: TextCheckResult | null;
  } | null;
  generation: { status: PosterGenerationStatus | null; startedAt: Date | null; errorMessage: string | null };
}

const editorDaySelect = {
  id: true,
  dayNumber: true,
  scheduledDate: true,
  clientId: true,
  contentRevision: true,
  contentStatus: true,
  imagePrompt: true,
  headline: true,
  supportingText: true,
  cta: true,
  posterElements: true,
  posterTemplateId: true,
  suggestedTemplateId: true,
  generationStatus: true,
  posterGenerationStartedAt: true,
  errorMessage: true,
  delivery: { select: { status: true, scheduledFor: true } },
  campaign: { select: { id: true, name: true, status: true, templateMappingMode: true, deliveryTime: true, category: { select: { name: true } } } },
  client: { select: { companyName: true } },
  activePosterVersion: {
    select: { id: true, versionNumber: true, approvalStatus: true, contentRevision: true, studioGenerationId: true, textCheck: true },
  },
} satisfies Prisma.ContentCalendarSelect;

type EditorDayRow = Prisma.ContentCalendarGetPayload<{ select: typeof editorDaySelect }>;

interface EditorContext {
  row: EditorDayRow & { campaign: NonNullable<EditorDayRow['campaign']> };
  templateRow: { id: string; label: string; width: number | null; height: number | null; paletteSource: PaletteSource } | null;
  doc: TemplateElementsDoc | null;
  brand: CloneBrand;
}

async function loadEditorContext(db: CampaignDb, dayId: string): Promise<EditorContext> {
  const row = await db.contentCalendar.findUnique({ where: { id: dayId }, select: editorDaySelect });
  if (!row) throw new CampaignDomainError('not-found', 'Campaign day does not exist.');
  if (!row.campaign) throw new CampaignDomainError('not-a-campaign-day', 'This calendar row is not part of a campaign.');

  const templateId = effectiveTemplateId(row.campaign.templateMappingMode, row);
  const template = templateId
    ? await db.categoryTemplate.findUnique({ where: { id: templateId }, select: { id: true, label: true, width: true, height: true, elements: true, paletteSource: true } })
    : null;
  const brand = await loadCloneBrand(db, row.clientId);
  return {
    row: row as EditorContext['row'],
    templateRow: template
      ? { id: template.id, label: template.label, width: template.width, height: template.height, paletteSource: parsePaletteSource(template.paletteSource) }
      : null,
    doc: template ? parseTemplateElements(template.elements) : null,
    brand,
  };
}

/**
 * The day's values for its template as the editor works on them: the stored copy
 * reconciled, or — for a day with none yet — a clone seeded with the day's
 * existing headline, supporting text and CTA.
 */
function currentElements(context: EditorContext, templateId: string, doc: TemplateElementsDoc): DayPosterElementsDoc {
  const { row, brand } = context;
  return materializeDayElements(doc, parseDayPosterElements(row.posterElements), templateId, row, { businessName: brand.values.companyName });
}

/** Everything Poster Studio's template editor shows for one campaign day. */
export async function loadCampaignDayCloneEditor(db: CampaignDb, dayId: string): Promise<CampaignDayCloneEditor> {
  const context = await loadEditorContext(db, dayId);
  const { row, templateRow, doc, brand } = context;
  const elements = templateRow && doc ? currentElements(context, templateRow.id, doc) : null;
  const active = row.activePosterVersion;

  return {
    day: {
      id: row.id,
      dayNumber: row.dayNumber,
      scheduledDate: row.scheduledDate,
      campaignId: row.campaign.id,
      campaignName: row.campaign.name,
      clientId: row.clientId,
      companyName: row.client.companyName,
      contentRevision: row.contentRevision,
      imagePrompt: row.imagePrompt,
    },
    template:
      templateRow && doc
        ? {
            id: templateRow.id,
            label: templateRow.label,
            width: templateRow.width,
            height: templateRow.height,
            thumbnailUrl: `/api/templates/${templateRow.id}/thumbnail?w=640`,
            doc,
          }
        : null,
    elements,
    resolved: doc && elements ? resolveDayElements(doc, elements, brand.values, row.imagePrompt) : [],
    brand: { ...brand.values, colors: brand.colors, logoUrl: brand.logoUrl, logoTrimmedUrl: brand.logoTrimmedUrl },
    // Template-first: a template that keeps its own palette says so whatever the
    // client's Brand Canvas holds, because its clones are never recoloured.
    colourMode: templateRow?.paletteSource === 'template' || brand.colors.length === 0 ? 'template' : 'brand',
    activeVersion: active
      ? {
          id: active.id,
          versionNumber: active.versionNumber,
          approvalStatus: active.approvalStatus,
          current: isVersionCurrent(active, row),
          imageUrl: active.studioGenerationId ? studioImageUrl(active.studioGenerationId, { width: 1024 }) : null,
          textCheck: parseTextCheck(active.textCheck),
        }
      : null,
    generation: { status: row.generationStatus, startedAt: row.posterGenerationStartedAt, errorMessage: row.errorMessage },
  };
}

// ---------------------------------------------------------------------------
// Saving — pure
// ---------------------------------------------------------------------------

export interface ElementValueInput {
  id: string;
  /** New words. Omit to leave them; null or empty clears them (the element is erased). */
  text?: string | null;
  /** Hide or show the element on this day's poster. Omit to leave it. */
  removed?: boolean;
}

export interface UpdateElementsInput {
  values?: readonly ElementValueInput[];
  /** The day's photo description. Omit to leave it; empty lets the model choose. */
  imagePrompt?: string;
}

function squash(value: string, max: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

/**
 * The day's element values after an edit, validated against the template:
 * every id must be one of its elements, once; words may only be set on elements
 * that print words of their own (content, and unbound identity such as an
 * address) — never on a photo, a logo, or an element bound to Brand Canvas.
 * Text is trimmed, whitespace collapsed, capped at `MAX_ELEMENT_TEXT`; a changed
 * text is marked as the admin's.
 */
export function applyElementEdits(
  doc: TemplateElementsDoc,
  current: DayPosterElementsDoc,
  edits: readonly ElementValueInput[],
  source: PosterElementValue['source'] = 'admin',
): DayPosterElementsDoc {
  const elements = new Map(doc.elements.map((element) => [element.id, element]));
  const bindings = templateBindings(doc);
  const seen = new Set<string>();
  const values = new Map(current.values.map((value) => [value.id, { ...value }]));

  for (const edit of edits) {
    const element = elements.get(edit.id);
    if (!element) throw new CampaignDomainError('invalid-input', `values: "${edit.id}" is not an element of this template.`);
    if (seen.has(edit.id)) throw new CampaignDomainError('invalid-input', `values: "${edit.id}" is listed twice.`);
    seen.add(edit.id);
    const value: PosterElementValue = values.get(edit.id) ?? { id: edit.id, text: null, removed: false, source: 'template', kind: element.kind };
    value.kind = element.kind;

    if (edit.text !== undefined) {
      const label = elementLabel(doc, element);
      if (IMAGE_KINDS.has(element.kind)) {
        if (edit.text !== null && edit.text.trim()) {
          throw new CampaignDomainError('invalid-input', `${label} is ${element.kind === 'photo' ? 'a photograph, described by the image prompt' : 'the Brand Canvas logo'}; it has no words to edit.`);
        }
      } else if (bindings.has(edit.id)) {
        if (edit.text !== null && edit.text.trim()) {
          throw new CampaignDomainError('invalid-input', `${label} comes from Brand Canvas; edit it there.`);
        }
      } else {
        const text = edit.text === null ? null : squash(edit.text, MAX_ELEMENT_TEXT) || null;
        if (text !== value.text) {
          value.text = text;
          value.source = source;
        }
      }
    }
    if (edit.removed !== undefined) value.removed = edit.removed;
    values.set(edit.id, value);
  }

  return { ...current, values: current.values.map((value) => values.get(value.id) ?? value) };
}

// ---------------------------------------------------------------------------
// Saving — database
// ---------------------------------------------------------------------------

export interface ElementsSaveResult {
  /** Words, removals or the image prompt changed. */
  changed: boolean;
  revisionBumped: boolean;
  contentRevision: number;
  elements: DayPosterElementsDoc;
}

export interface EditOptions {
  now?: Date;
  timeZone?: string;
  /** Delivery dependencies for the booking re-sync after a save that moved the revision. */
  deliveryDeps?: DeliveryDeps;
}

/**
 * Refuses an edit exactly where `changeCampaignDayTemplate` refuses a template
 * change: a closed campaign, a day that can no longer change (`slotLockOf` with
 * the campaign's delivery time, as the board computes it), a day whose poster is
 * queued or being generated, and a day with no read template.
 */
function requireEditable(context: EditorContext, options: EditOptions = {}): { templateId: string; doc: TemplateElementsDoc } {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? getAppTimeZone();
  if (!campaignAllowsChanges(context.row.campaign.status)) {
    throw new CampaignDomainError('campaign-closed', `The campaign is ${context.row.campaign.status}.`);
  }
  const lock = slotLockOf(context.row, now, timeZone, context.row.campaign.deliveryTime);
  if (lock) throw new CampaignDomainError('invalid-transition', `${SLOT_LOCK_LABELS[lock]} Its poster can no longer change.`);
  if (isGenerationInProgress(context.row.generationStatus, context.row.posterGenerationStartedAt, now, context.row.campaign.status)) {
    throw new CampaignDomainError('invalid-transition', 'A poster is being generated for this day. Edit it once it has finished.');
  }
  if (!context.templateRow) throw new CampaignDomainError('invalid-transition', 'This day has no template. Fill it with a template first.');
  if (!context.doc) throw new CampaignDomainError('invalid-transition', TEMPLATE_NOT_READ_MESSAGE);
  return { templateId: context.templateRow.id, doc: context.doc };
}

async function persistElements(
  db: CampaignDb,
  context: EditorContext,
  doc: TemplateElementsDoc,
  current: DayPosterElementsDoc,
  next: DayPosterElementsDoc,
  imagePrompt: string,
): Promise<ElementsSaveResult> {
  const { row, brand } = context;
  const changed = !sameDayElements(current, next) || imagePrompt !== row.imagePrompt;
  const legacy = legacyContentFields(resolveDayElements(doc, next, brand.values, imagePrompt));
  const stored = parseDayPosterElements(row.posterElements);
  const needsWrite =
    changed ||
    JSON.stringify(stored) !== JSON.stringify(next) ||
    row.contentStatus !== 'READY' ||
    legacy.headline !== row.headline ||
    legacy.supportingText !== row.supportingText ||
    legacy.cta !== row.cta;

  if (needsWrite) {
    const updated = await db.contentCalendar.updateMany({
      // The generation status is restated too: a generation claimed after this
      // day was read makes the save a conflict instead of changing words mid-render.
      where: { id: row.id, contentRevision: row.contentRevision, posterTemplateId: row.posterTemplateId, suggestedTemplateId: row.suggestedTemplateId, generationStatus: row.generationStatus },
      data: {
        posterElements: next as unknown as Prisma.InputJsonValue,
        imagePrompt,
        headline: legacy.headline,
        supportingText: legacy.supportingText,
        cta: legacy.cta,
        contentStatus: 'READY',
        contentIssues: [],
        ...(changed ? { contentRevision: { increment: 1 } } : {}),
      },
    });
    if (updated.count === 0) throw new CampaignDomainError('conflict', 'This day was changed by someone else.');
  }
  return { changed, revisionBumped: changed, contentRevision: row.contentRevision + (changed ? 1 : 0), elements: next };
}

/**
 * Saves the admin's edits to one day's elements and image prompt.
 *
 * Refused when the day's revision is not `expectedRevision` (someone else saved
 * meanwhile), when the campaign is closed, when the day can no longer change or
 * its poster is being generated, and when the day has no read template. A save
 * that moves the revision re-syncs the day's booking.
 */
export async function updateCampaignDayElements(
  db: CampaignDb,
  dayId: string,
  input: UpdateElementsInput,
  options: EditOptions & { expectedRevision: number },
): Promise<ElementsSaveResult> {
  const context = await loadEditorContext(db, dayId);
  const { templateId, doc } = requireEditable(context, options);
  if (options.expectedRevision !== context.row.contentRevision) {
    throw new CampaignDomainError('conflict', 'This day was changed by someone else. Reload it and try again.');
  }

  const current = currentElements(context, templateId, doc);
  const next = applyElementEdits(doc, current, input.values ?? []);
  const imagePrompt = input.imagePrompt === undefined ? context.row.imagePrompt : squash(input.imagePrompt, MAX_IMAGE_PROMPT);
  const saved = await persistElements(db, context, doc, current, next, imagePrompt);
  // Outside any transaction, and quietly: the save stands whatever the booking does.
  if (saved.revisionBumped) await bookCampaignDayQuietly(db, dayId, { deps: options.deliveryDeps });
  return saved;
}

// ---------------------------------------------------------------------------
// Rewrite with AI
// ---------------------------------------------------------------------------

/** Share of the template text's length a rewrite may differ by, either way. */
export const REWRITE_LENGTH_TOLERANCE = 0.2;

export interface RewriteItem {
  id: string;
  label: string;
  kind: TemplateElementKind;
  group: string | null;
  /** The template's own words: the role, and the space the design has for them. */
  templateText: string;
  minLength: number;
  maxLength: number;
}

export interface RewriteRequest {
  businessName: string;
  tagline: string | null;
  verticalName: string | null;
  items: RewriteItem[];
}

export type RewriteGenerator = (request: RewriteRequest) => Promise<Array<{ id: string; text: string }>>;

/** The length window a rewrite of `text` must fit: ±20% of its characters, at least one character. */
export function rewriteLengthBounds(text: string): { minLength: number; maxLength: number } {
  const length = text.replace(/\s+/g, ' ').trim().length;
  return {
    minLength: Math.max(1, Math.ceil(length * (1 - REWRITE_LENGTH_TOLERANCE))),
    maxLength: Math.max(1, Math.floor(length * (1 + REWRITE_LENGTH_TOLERANCE))),
  };
}

const PRICE_OR_STAT = /[₹$€£%]|\b\d+(\.\d+)?\s*(rs|inr|usd|off|percent|k|lakh|crore)\b/i;

/**
 * A model's rewrite made safe for the design, or null when it cannot be used.
 *
 * Whitespace collapsed; longer than the window, cut at the last word boundary
 * that fits (or hard at the limit); shorter than the window, refused — the space
 * would be left visibly empty. Refused too when it brings in a web address, an
 * email, a phone-like number, or a price, percentage or figure the template's
 * words did not have: those are claims only the client can make.
 */
export function clampRewrite(text: string, item: Pick<RewriteItem, 'templateText' | 'minLength' | 'maxLength'>): string | null {
  let clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  if (clean.length > item.maxLength) {
    const cut = clean.slice(0, item.maxLength + 1);
    const space = cut.lastIndexOf(' ');
    clean = (space >= item.minLength ? cut.slice(0, space) : clean.slice(0, item.maxLength)).replace(/[\s,;:–—-]+$/, '').trim();
  }
  if (clean.length < item.minLength || clean.length > item.maxLength) return null;
  const invents = (pattern: RegExp) => pattern.test(clean) && !pattern.test(item.templateText);
  if (invents(URL_OR_EMAIL) || invents(LONG_NUMBER) || invents(PRICE_OR_STAT)) return null;
  return clean;
}

const REWRITE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text'],
        properties: { id: { type: 'string' }, text: { type: 'string' } },
      },
    },
  },
} as const;

/** The default generator: one structured call with `OPENAI_MODEL`, billed as `clone-rewrite`. */
export function openAiRewriteGenerator(bill: { clientId: string; calendarId: string }): RewriteGenerator {
  return async (request) => {
    const answer = await generateStructured<{ items: Array<{ id: string; text: string }> }>({
      label: 'clone-rewrite',
      systemPrompt:
        'You write short, punchy marketing poster copy that fits an existing design exactly. You answer only with the requested JSON.',
      userPrompt: [
        `Business: ${request.businessName}${request.verticalName ? `, in ${request.verticalName}` : ''}.${request.tagline ? ` Its tagline: "${request.tagline}".` : ''}`,
        '',
        'Rewrite each text of this poster with fresh wording about the business, keeping its role in the design. Rules:',
        '- Keep each text within its character range (given in brackets): the design has exactly that much room.',
        '- A headline stays a headline, a feature a short feature label, a button a short action.',
        '- Keep the capitalisation style (ALL CAPS stays ALL CAPS, Title Case stays Title Case) and punctuation habits.',
        '- Features of one group stay parallel: the same grammatical form and similar length, each distinct.',
        '- Never invent phone numbers, web or email addresses, prices, offers, discounts or statistics.',
        '- No hashtags, emojis or other business names. Use the business name only where the original text names a business.',
        '',
        ...request.items.map(
          (item) => `${item.id} · ${item.label}${item.group ? ` (${item.group})` : ''} [${item.minLength}–${item.maxLength} chars]: ${item.templateText}`,
        ),
        '',
        'Answer with one item per id above.',
      ].join('\n'),
      schema: REWRITE_SCHEMA as unknown as Record<string, unknown>,
      schemaName: 'clone_rewrite',
      model: getModel(),
      temperature: 0.8,
      maxTokens: 2_000,
      bill: { ...bill, operation: 'clone-rewrite' },
    });
    return Array.isArray(answer.items) ? answer.items.filter((item) => typeof item?.id === 'string' && typeof item.text === 'string') : [];
  };
}

export interface RewriteResult extends ElementsSaveResult {
  /** Element ids given new words. */
  rewritten: string[];
  /** Content elements whose rewrite was unusable and kept their words. */
  kept: string[];
}

/**
 * Fresh wording for one day's content elements (never its identity), from one
 * text call, each within ±20% of the template text's length, saved like an
 * edit with source `ai`. Elements the day hides are left alone.
 */
export async function rewriteCampaignDayElements(
  db: CampaignDb,
  dayId: string,
  options: EditOptions & { generator?: RewriteGenerator } = {},
): Promise<RewriteResult> {
  const context = await loadEditorContext(db, dayId);
  const { templateId, doc } = requireEditable(context, options);
  const current = currentElements(context, templateId, doc);
  const values = new Map(current.values.map((value) => [value.id, value]));

  const items: RewriteItem[] = doc.elements
    .filter((element) => CONTENT_KINDS.has(element.kind) && element.text?.trim() && values.get(element.id)?.removed !== true)
    .map((element) => ({
      id: element.id,
      label: elementLabel(doc, element),
      kind: element.kind,
      group: element.group,
      templateText: element.text!,
      ...rewriteLengthBounds(element.text!),
    }));
  if (items.length === 0) {
    return { ...(await persistElements(db, context, doc, current, current, context.row.imagePrompt)), rewritten: [], kept: [] };
  }

  const generator = options.generator ?? openAiRewriteGenerator({ clientId: context.row.clientId, calendarId: context.row.id });
  const answer = await generator({
    businessName: context.brand.values.companyName ?? context.row.client.companyName,
    tagline: context.brand.values.tagline,
    verticalName: context.row.campaign.category.name,
    items,
  });
  const byId = new Map(answer.map((entry) => [entry.id, entry.text]));

  const edits: ElementValueInput[] = [];
  const rewritten: string[] = [];
  const kept: string[] = [];
  for (const item of items) {
    const raw = byId.get(item.id);
    const text = raw === undefined ? null : clampRewrite(raw, item);
    if (text === null) {
      kept.push(item.id);
      continue;
    }
    edits.push({ id: item.id, text });
    rewritten.push(item.id);
  }

  const next = applyElementEdits(doc, current, edits, 'ai');
  const saved = await persistElements(db, context, doc, current, next, context.row.imagePrompt);
  if (saved.revisionBumped) await bookCampaignDayQuietly(db, dayId, { deps: options.deliveryDeps });
  return { ...saved, rewritten, kept };
}

export interface RewriteDraftsResult {
  rewritten: number[];
  skipped: Array<{ dayNumber: number; reason: string }>;
  failed: Array<{ dayNumber: number; message: string }>;
  /** A configuration or credential failure stopped the run. */
  stopped: boolean;
}

/**
 * "Rewrite all drafts": `rewriteCampaignDayElements` for each listed day of the
 * campaign that has no poster yet, one at a time. Days with a poster, days not
 * in the campaign, days that can no longer change, days whose poster is queued
 * or being generated and days with no read template are skipped with the reason,
 * before any model call.
 */
export async function rewriteDraftDays(
  db: CampaignDb,
  campaignId: string,
  dayIds: readonly string[],
  options: EditOptions & { generator?: RewriteGenerator } = {},
): Promise<RewriteDraftsResult> {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? getAppTimeZone();
  const result: RewriteDraftsResult = { rewritten: [], skipped: [], failed: [], stopped: false };
  const days = await db.contentCalendar.findMany({
    where: { campaignId, id: { in: [...new Set(dayIds)] } },
    orderBy: { dayNumber: 'asc' },
    select: {
      id: true,
      dayNumber: true,
      scheduledDate: true,
      activePosterVersionId: true,
      generationStatus: true,
      posterGenerationStartedAt: true,
      delivery: { select: { status: true, scheduledFor: true } },
      campaign: { select: { deliveryTime: true, status: true } },
    },
  });

  for (const day of days) {
    if (day.activePosterVersionId) {
      result.skipped.push({ dayNumber: day.dayNumber, reason: 'It already has a poster.' });
      continue;
    }
    const lock = slotLockOf(day, now, timeZone, day.campaign?.deliveryTime);
    if (lock) {
      result.skipped.push({ dayNumber: day.dayNumber, reason: SLOT_LOCK_LABELS[lock] });
      continue;
    }
    if (isGenerationInProgress(day.generationStatus, day.posterGenerationStartedAt, now, day.campaign?.status)) {
      result.skipped.push({ dayNumber: day.dayNumber, reason: 'A poster is being generated for this day.' });
      continue;
    }
    try {
      const outcome = await rewriteCampaignDayElements(db, day.id, { ...options, now, timeZone });
      if (outcome.rewritten.length > 0) result.rewritten.push(day.dayNumber);
      else result.skipped.push({ dayNumber: day.dayNumber, reason: 'No wording could be rewritten within the design’s space.' });
    } catch (error) {
      if (error instanceof CampaignDomainError && (error.code === 'invalid-transition' || error.code === 'campaign-closed')) {
        result.skipped.push({ dayNumber: day.dayNumber, reason: error.message });
        continue;
      }
      const message = error instanceof Error ? error.message : 'Rewriting failed.';
      result.failed.push({ dayNumber: day.dayNumber, message });
      // Missing or rejected credentials fail every later day the same way.
      if (error instanceof MissingEnvError || (error instanceof LlmError && error.kind === 'config')) {
        result.stopped = true;
        break;
      }
    }
  }
  return result;
}
