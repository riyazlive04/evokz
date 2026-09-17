import { serializeBoardQuery, SLOT_LOCK_LABELS, weekOf, type BoardStatus, type SlotLock } from '@/lib/campaign/board';
import type { PosterState } from '@/lib/campaign/poster-generation';
import {
  cloneTemplateElements,
  CONTENT_KINDS,
  elementLabel,
  MAX_ELEMENT_TEXT,
  templateBindings,
  UNBOUND_IDENTITY_KINDS,
  type BrandField,
  type DayPosterElementsDoc,
  type ElementBox,
  type TemplateElementKind,
  type TemplateElementsDoc,
  type TextCheckResult,
} from '@/lib/types/template-elements';

/**
 * Poster Studio's template poster editor — its pure view model.
 *
 * How a day's cloned elements are laid out as a form, what counts as an unsaved
 * change, the soft length guide, the status chip, which actions are offered, and
 * where the editor's links go. No React, no Prisma, no network: the editor
 * (`src/components/studio/TemplatePosterEditor.tsx`) renders these answers, the
 * server loader (`clone-editor-screen.ts`) builds the links with them, and
 * `npm run check:clone-editor-view` pins every rule here.
 *
 * **Nothing here re-decides a rule.** Which element takes its value from Brand
 * Canvas is `templateBindings`; what a fresh clone holds is
 * `cloneTemplateElements`; whether a day may be generated, approved or rejected
 * is the board's server-computed `BoardDayActions`. This module only arranges
 * those answers for one screen, and mirrors the server's text normalisation so
 * the form never saves a change the server would not see as one.
 */

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/**
 * Where an element appears in the form:
 *
 *   content  words the admin edits (Words)
 *   brand    printed from Brand Canvas — its own kind's field or a fallback
 *            binding (Brand details: read-only, Show/Hide only)
 *   hidden   another business's detail with no Brand Canvas field (Other
 *            details: hidden unless given a value)
 *   photo    the photograph (Photo: described by the image prompt)
 */
export type EditorFieldCategory = 'content' | 'brand' | 'hidden' | 'photo';

export interface EditorField {
  id: string;
  kind: TemplateElementKind;
  /** "Headline", "Feature 2" — `elementLabel`. */
  label: string;
  category: EditorFieldCategory;
  /** The Brand Canvas field a `brand` field prints; null for every other category. */
  binding: BrandField | null;
  /** The template's own words, as printed. Null for a photo or a logo. */
  templateText: string | null;
  /** What a photo or logo shows. */
  description: string | null;
  /** Content fields that belong together ("features"); null when standalone. */
  groupKey: string | null;
  box: ElementBox;
}

function categoryOf(kind: TemplateElementKind, bound: boolean): EditorFieldCategory {
  if (bound) return 'brand';
  if (CONTENT_KINDS.has(kind)) return 'content';
  if (UNBOUND_IDENTITY_KINDS.has(kind)) return 'hidden';
  return 'photo';
}

/** Every element of a template as a form field, in the template's reading order. */
export function editorFields(doc: TemplateElementsDoc): EditorField[] {
  const bindings = templateBindings(doc);
  return doc.elements.map((element) => {
    const binding = bindings.get(element.id) ?? null;
    const category = categoryOf(element.kind, binding !== null);
    return {
      id: element.id,
      kind: element.kind,
      label: elementLabel(doc, element),
      category,
      binding,
      templateText: element.text,
      description: element.description,
      groupKey: category === 'content' ? (element.group?.trim().toLowerCase() || (element.kind === 'feature' ? 'features' : null)) : null,
      box: element.box,
    };
  });
}

export interface WordGroup {
  /** Stable React key: the group key, or the field id for a standalone field. */
  key: string;
  /** "Features" for a group; null for a standalone field. */
  title: string | null;
  fields: EditorField[];
}

export interface EditorFieldGroups {
  words: WordGroup[];
  brand: EditorField[];
  hidden: EditorField[];
  photos: EditorField[];
}

/** "features" → "Features", "contact_details" → "Contact details". */
export function groupTitle(key: string): string {
  const words = key.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Group';
}

/**
 * The form's sections. Words keep the template's reading order; content fields
 * sharing a group key (two or more of them) become one titled group placed where
 * its first member reads, so "Features" sits between the sub-headline and the
 * call to action exactly as on the poster. A lone member stays a plain field.
 */
export function groupEditorFields(doc: TemplateElementsDoc): EditorFieldGroups {
  const fields = editorFields(doc);
  const content = fields.filter((field) => field.category === 'content');
  const sizes = new Map<string, number>();
  for (const field of content) if (field.groupKey) sizes.set(field.groupKey, (sizes.get(field.groupKey) ?? 0) + 1);

  const words: WordGroup[] = [];
  const byKey = new Map<string, WordGroup>();
  for (const field of content) {
    const key = field.groupKey && (sizes.get(field.groupKey) ?? 0) > 1 ? field.groupKey : null;
    if (!key) {
      words.push({ key: field.id, title: null, fields: [field] });
      continue;
    }
    const existing = byKey.get(key);
    if (existing) {
      existing.fields.push(field);
    } else {
      const group = { key: `group:${key}`, title: groupTitle(key), fields: [field] };
      byKey.set(key, group);
      words.push(group);
    }
  }

  return {
    words,
    brand: fields.filter((field) => field.category === 'brand'),
    hidden: fields.filter((field) => field.category === 'hidden'),
    photos: fields.filter((field) => field.category === 'photo'),
  };
}

// ---------------------------------------------------------------------------
// Draft — what the form holds, and what changed
// ---------------------------------------------------------------------------

export interface FieldDraft {
  /** The words in the field. Always '' for brand-bound fields and photos. */
  text: string;
  /** Hidden on this day's poster. */
  removed: boolean;
}

export type EditorDraft = Record<string, FieldDraft>;

/** The form's starting state from a day's stored (reconciled) values. */
export function draftFromElements(doc: TemplateElementsDoc, elements: DayPosterElementsDoc): EditorDraft {
  const values = new Map(elements.values.map((value) => [value.id, value]));
  return Object.fromEntries(
    doc.elements.map((element) => {
      const value = values.get(element.id);
      return [element.id, { text: value?.text ?? '', removed: value?.removed ?? false }];
    }),
  );
}

/**
 * The values a fresh clone of the template would give this day — the template's
 * words with its business name swapped for the client's — which is what "Reset"
 * returns a field to. Never the raw template text: that can name another
 * business.
 */
export function templateDefaults(doc: TemplateElementsDoc, templateId: string, businessName: string | null): EditorDraft {
  return draftFromElements(doc, cloneTemplateElements(doc, templateId, { businessName }));
}

/**
 * A field's words exactly as the server stores them (`updateCampaignDayElements`):
 * whitespace collapsed, trimmed, capped at `MAX_ELEMENT_TEXT`; empty is null.
 */
export function normalizeFieldText(text: string | null | undefined): string | null {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_ELEMENT_TEXT).trim() || null;
}

/** Longest image prompt a day stores — `MAX_IMAGE_PROMPT` in `clone-editor.ts`, which is server-only. */
export const MAX_EDITOR_IMAGE_PROMPT = 4_000;

/** The image prompt exactly as the server stores it. */
export function normalizeImagePrompt(prompt: string | null | undefined): string {
  return (prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_EDITOR_IMAGE_PROMPT).trim();
}

/** One element's change, in the shape `updateCampaignDayElementsAction` takes. */
export interface DraftEdit {
  id: string;
  text?: string | null;
  removed?: boolean;
}

/**
 * The edits that turn `saved` into `draft`, for the fields given — nothing for a
 * field whose words differ only in whitespace. Words are sent only for fields
 * that have words of their own (content and hidden details): the server refuses
 * words on a brand-bound element or a photo.
 */
export function draftEdits(fields: readonly EditorField[], saved: EditorDraft, draft: EditorDraft): DraftEdit[] {
  const edits: DraftEdit[] = [];
  for (const field of fields) {
    const next = draft[field.id];
    if (!next) continue;
    const before = saved[field.id] ?? { text: '', removed: false };
    const edit: DraftEdit = { id: field.id };
    if ((field.category === 'content' || field.category === 'hidden') && normalizeFieldText(next.text) !== normalizeFieldText(before.text)) {
      edit.text = normalizeFieldText(next.text);
    }
    if (next.removed !== before.removed) edit.removed = next.removed;
    if (edit.text !== undefined || edit.removed !== undefined) edits.push(edit);
  }
  return edits;
}

/** `saved` with `edits` applied — the new baseline once the server accepted them. */
export function applyDraftEdits(saved: EditorDraft, edits: readonly DraftEdit[]): EditorDraft {
  const next: EditorDraft = { ...saved };
  for (const edit of edits) {
    const before = next[edit.id] ?? { text: '', removed: false };
    next[edit.id] = {
      text: edit.text !== undefined ? (edit.text ?? '') : before.text,
      removed: edit.removed ?? before.removed,
    };
  }
  return next;
}

export function isFieldDirty(field: EditorField, saved: EditorDraft, draft: EditorDraft): boolean {
  return draftEdits([field], saved, draft).length > 0;
}

/** Anything in the form the server does not have yet. */
export function hasUnsavedChanges(
  fields: readonly EditorField[],
  saved: { draft: EditorDraft; prompt: string },
  current: { draft: EditorDraft; prompt: string },
): boolean {
  return normalizeImagePrompt(saved.prompt) !== normalizeImagePrompt(current.prompt) || draftEdits(fields, saved.draft, current.draft).length > 0;
}

/**
 * The day's words or visibility differ from a fresh clone of its template — what
 * changing the template would throw away, so it is confirmed first. The image
 * prompt is not counted: a template change keeps it.
 */
export function differsFromTemplate(fields: readonly EditorField[], defaults: EditorDraft, draft: EditorDraft): boolean {
  return draftEdits(fields, defaults, draft).length > 0;
}

// ---------------------------------------------------------------------------
// Length guide
// ---------------------------------------------------------------------------

/**
 * Share of the template text's length a field may grow by before the editor
 * warns — the same ±20% window "Rewrite with AI" writes within
 * (`REWRITE_LENGTH_TOLERANCE`). A warning only: longer words may still fit.
 */
export const SOFT_LENGTH_TOLERANCE = 0.2;

export interface LengthGuide {
  count: number;
  /** The template's own words' length: the room the design has. Null when it has none. */
  templateLength: number | null;
  /** Longest length before the warning. */
  softLimit: number | null;
  over: boolean;
}

export function lengthGuide(text: string, templateText: string | null): LengthGuide {
  const count = (text ?? '').replace(/\s+/g, ' ').trim().length;
  const templateLength = (templateText ?? '').replace(/\s+/g, ' ').trim().length;
  if (templateLength === 0) return { count, templateLength: null, softLimit: null, over: false };
  const softLimit = Math.max(1, Math.floor(templateLength * (1 + SOFT_LENGTH_TOLERANCE)));
  return { count, templateLength, softLimit, over: count > softLimit };
}

// ---------------------------------------------------------------------------
// Status and actions
// ---------------------------------------------------------------------------

/** Badge variants the chip uses (`badgeVariants`). */
export type EditorChipTone = 'slate' | 'secondary' | 'default' | 'emerald' | 'amber' | 'destructive';

/**
 * The top bar's status chip, from the board's status of the day and its poster
 * state. The board's catch-all "Needs attention" is split into what the admin
 * does next: an outdated poster is regenerated, a rejected one fixed.
 */
export function editorStatusChip(input: { status: BoardStatus; posterState: PosterState }): { label: string; tone: EditorChipTone } {
  switch (input.status) {
    case 'draft':
      return { label: 'Draft', tone: 'slate' };
    case 'generating':
      return { label: 'Generating', tone: 'secondary' };
    case 'needs-approval':
      return { label: 'Needs approval', tone: 'default' };
    case 'approved':
      return { label: 'Approved', tone: 'emerald' };
    case 'scheduled':
      return { label: 'Scheduled', tone: 'emerald' };
    case 'sent':
      return { label: 'Sent', tone: 'slate' };
    case 'failed':
      return { label: 'Failed', tone: 'destructive' };
    case 'attention':
      if (input.posterState === 'outdated') return { label: 'Outdated', tone: 'amber' };
      if (input.posterState === 'rejected') return { label: 'Rejected', tone: 'destructive' };
      return { label: 'Needs attention', tone: 'amber' };
  }
}

export interface EditorActionFlags {
  canGenerate: boolean;
  canRegenerate: boolean;
  canApprove: boolean;
  canReject: boolean;
}

export interface PrimaryActions {
  generate: { label: string; mode: 'missing' | 'regenerate'; enabled: boolean };
  approve: boolean;
  reject: boolean;
}

/**
 * The top bar's Generate and Approve, and the preview's Reject. Offered exactly
 * when the board would offer them on this day's card, and never while a poster
 * is being made or another action of this editor is running.
 */
export function primaryActions(input: { flags: EditorActionFlags; hasPoster: boolean; generating: boolean; busy: boolean }): PrimaryActions {
  const idle = !input.generating && !input.busy;
  return {
    generate: {
      label: input.hasPoster ? 'Regenerate' : 'Generate poster',
      mode: input.hasPoster ? 'regenerate' : 'missing',
      enabled: idle && (input.hasPoster ? input.flags.canRegenerate : input.flags.canGenerate),
    },
    approve: idle && input.flags.canApprove,
    reject: idle && input.flags.canReject,
  };
}

/** Shortest and longest "Small change" instruction (`clone-fix.ts` enforces them). */
export const MIN_POSTER_CHANGE_LENGTH = 3;
export const MAX_POSTER_CHANGE_LENGTH = 500;

export interface RevisionAvailability {
  enabled: boolean;
  /** Why not, for the admin; null when enabled. */
  reason: string | null;
}

/**
 * Whether "Fix text" and "Small change" can run on the active poster: the same
 * refusals `clone-fix.ts` makes, checked early so the buttons say why.
 */
export function revisionAvailability(input: {
  campaignStatus: string;
  poster: { current: boolean; hasArtwork: boolean; textCheck: TextCheckResult | null } | null;
  generating: boolean;
  busy: boolean;
  /** The day's slot lock (the screen's `status.lock`). A sent, sending or past day's poster is final. */
  lock?: SlotLock | null;
}): { fix: RevisionAvailability; edit: RevisionAvailability } {
  const common = ((): string | null => {
    if (input.generating) return 'A poster is being made for this day.';
    if (input.busy) return 'Another change is running.';
    if (input.lock === 'sent' || input.lock === 'sending' || input.lock === 'past') return `${SLOT_LOCK_LABELS[input.lock]} Its poster can no longer change.`;
    if (input.campaignStatus !== 'ACTIVE') return 'Activate the campaign to change posters.';
    if (!input.poster) return 'Generate a poster first.';
    if (!input.poster.hasArtwork) return 'An uploaded poster cannot be changed with AI.';
    if (!input.poster.current) return 'This poster is outdated — regenerate it with the new words.';
    return null;
  })();
  const issues = textCheckView(input.poster?.textCheck ?? null);
  const fixReason = common ?? (issues.state === 'none' ? 'This poster has no text check.' : issues.state === 'ok' ? 'All text is correct.' : null);
  return {
    fix: { enabled: fixReason === null, reason: fixReason },
    edit: { enabled: common === null, reason: common },
  };
}

// ---------------------------------------------------------------------------
// Text check
// ---------------------------------------------------------------------------

export interface TextCheckIssueView {
  key: string;
  /** "Headline", or null for a leftover found anywhere. */
  label: string | null;
  expected: string | null;
  found: string | null;
  leftover: boolean;
}

export interface TextCheckView {
  state: 'none' | 'ok' | 'issues';
  issues: TextCheckIssueView[];
}

/** The text check as the preview lists it: mismatches in reading order, then leftovers. */
export function textCheckView(result: TextCheckResult | null): TextCheckView {
  if (!result) return { state: 'none', issues: [] };
  const issues: TextCheckIssueView[] = [
    ...result.items
      .filter((item) => !item.match)
      .map((item) => ({ key: `item:${item.elementId}`, label: item.label, expected: item.expected, found: item.found, leftover: false })),
    ...result.leftovers.map((text, index) => ({ key: `leftover:${index}`, label: null, expected: null, found: text, leftover: true })),
  ];
  return { state: issues.length === 0 ? 'ok' : 'issues', issues };
}

// ---------------------------------------------------------------------------
// Navigation and links
// ---------------------------------------------------------------------------

/** The nearest day before and after `dayNumber` among `days` (any order). */
export function adjacentDays<T extends { dayNumber: number }>(days: readonly T[], dayNumber: number): { prev: T | null; next: T | null } {
  let prev: T | null = null;
  let next: T | null = null;
  for (const day of days) {
    if (day.dayNumber < dayNumber && (!prev || day.dayNumber > prev.dayNumber)) prev = day;
    if (day.dayNumber > dayNumber && (!next || day.dayNumber < next.dayNumber)) next = day;
  }
  return { prev, next };
}

/** The editor for one campaign day. */
export function templateEditorHref(dayId: string): string {
  return `/admin/poster-studio?campaignDay=${encodeURIComponent(dayId)}`;
}

/** The campaign board, opened on the week page holding this day. */
export function campaignBoardHref(clientId: string, campaignId: string, dayNumber: number): string {
  return `/admin/clients/${clientId}/campaigns/${campaignId}${serializeBoardQuery({ week: weekOf(dayNumber) })}`;
}

/** Brand Canvas, with a way back to `returnTo` (the page accepts only `/admin/…` paths). */
export function brandCanvasHref(clientId: string, returnTo: string): string {
  return `/admin/clients/${clientId}/brand?return=${encodeURIComponent(returnTo)}`;
}

// ---------------------------------------------------------------------------
// Words for the admin
// ---------------------------------------------------------------------------

/** "0:07", "1:12", "12:03". */
export function formatElapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** Seconds since `startedAt` (an ISO instant), or since `fallbackMs` when there is none. */
export function elapsedSince(startedAt: string | null, nowMs: number, fallbackMs: number | null): number {
  const start = startedAt ? Date.parse(startedAt) : fallbackMs;
  if (start === null || !Number.isFinite(start)) return 0;
  return Math.max(0, Math.round((nowMs - start) / 1000));
}

export type NoticeTone = 'success' | 'warning' | 'danger';

/** What approving did to the day's delivery — the board's wording, for the same `BookingNotice`. */
export function approvalNotice(
  dayNumber: number,
  booking: { result: string; whenLabel: string | null; immediate: boolean; refusal: string | null } | null,
  campaignActive: boolean,
): { tone: NoticeTone; text: string } {
  const approved = `Day ${dayNumber} approved.`;
  if (!booking) return { tone: 'success', text: approved };
  switch (booking.result) {
    case 'booked':
    case 'rebooked':
    case 'repinned':
    case 'rescheduled':
    case 'unchanged':
      if (booking.whenLabel) {
        return booking.immediate
          ? { tone: 'warning', text: `${approved} Booked for ${booking.whenLabel} — it will be sent within a minute.` }
          : { tone: 'success', text: `${approved} Booked for ${booking.whenLabel}.` };
      }
      return { tone: 'success', text: campaignActive ? approved : `${approved} It is booked when the campaign is active.` };
    case 'missed':
      return { tone: 'warning', text: `${approved} Its delivery day has passed, so it was not booked.` };
    default:
      return { tone: 'warning', text: `${approved} Not booked${booking.refusal ? `: ${booking.refusal}` : '.'}` };
  }
}

/** "Rewrite with AI"'s result: how many texts changed, and which kept their words. */
export function rewriteNotice(result: { rewritten: readonly string[]; kept: readonly string[] }, labels: ReadonlyMap<string, string>): { tone: NoticeTone; lines: string[] } {
  const name = (id: string) => labels.get(id) ?? id;
  const lines = [
    result.rewritten.length > 0
      ? `Rewrote ${result.rewritten.length} text${result.rewritten.length === 1 ? '' : 's'}.`
      : 'Nothing was rewritten: no new wording fitted the design’s space.',
  ];
  if (result.kept.length > 0) lines.push(`Kept their words (no rewrite fitted): ${result.kept.map(name).join(', ')}.`);
  return { tone: result.rewritten.length === 0 ? 'warning' : result.kept.length > 0 ? 'warning' : 'success', lines };
}

/** A save refused because the day moved on under this tab (the server's conflict wording). */
export function isConflictMessage(message: string | null | undefined): boolean {
  return /changed by someone else|changed or started generating meanwhile/i.test(message ?? '');
}
