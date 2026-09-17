import { z } from 'zod';

/**
 * Template clone mode — the shared contract.
 *
 * A campaign poster is the template itself with only its words, photo and
 * identity changed. That needs two documents:
 *
 *   `TemplateElementsDoc`   on `CategoryTemplate.elements` — every element of the
 *                           template an admin can change, read once from the image.
 *   `DayPosterElementsDoc`  on `ContentCalendar.posterElements` — one campaign day's
 *                           values for those elements.
 *
 * Everything that reads, edits, prompts or renders a clone goes through the pure
 * helpers here, so the extractor, the studio editor, the campaign board and the
 * image prompt all agree on what an element is and what a day did to it.
 *
 * **Identity is bound, not typed.** An element that is the business's identity —
 * its name, tagline, phone, website, logo — takes its value from the client's
 * Brand Canvas at generation time. A day stores only whether it is shown. Fixing a
 * phone number in Brand Canvas therefore fixes every poster not yet generated, and
 * a template can never carry another business's contact details onto a client's
 * poster by accident.
 */

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

export const TEMPLATE_ELEMENT_KINDS = [
  // Words the admin edits. Pre-filled with the template's own text.
  'headline',
  'subheadline',
  'body',
  'feature',
  'cta',
  'badge',
  'text',
  // Identity bound to Brand Canvas.
  'brandName',
  'tagline',
  'phone',
  'website',
  'logo',
  // Identity with no Brand Canvas field. Hidden by default — it is another
  // business's detail — and shown only if the admin types a value.
  'email',
  'address',
  'social',
  'personName',
  'credential',
  // The photograph. Replaced from the day's image prompt.
  'photo',
] as const;

export type TemplateElementKind = (typeof TEMPLATE_ELEMENT_KINDS)[number];

/** Words the admin edits, pre-filled from the template. */
export const CONTENT_KINDS: ReadonlySet<TemplateElementKind> = new Set([
  'headline',
  'subheadline',
  'body',
  'feature',
  'cta',
  'badge',
  'text',
]);

/** Brand Canvas field each bound identity kind takes its value from. */
export const BRAND_BINDINGS = {
  brandName: 'companyName',
  tagline: 'tagline',
  phone: 'phone',
  website: 'website',
  logo: 'logo',
} as const satisfies Partial<Record<TemplateElementKind, string>>;

export type BrandBoundKind = keyof typeof BRAND_BINDINGS;

export function isBrandBound(kind: TemplateElementKind): kind is BrandBoundKind {
  return Object.prototype.hasOwnProperty.call(BRAND_BINDINGS, kind);
}

/** Identity with no Brand Canvas field: hidden unless the admin types a value. */
export const UNBOUND_IDENTITY_KINDS: ReadonlySet<TemplateElementKind> = new Set([
  'email',
  'address',
  'social',
  'personName',
  'credential',
]);

/** Kinds that are pixels rather than words. */
export const IMAGE_KINDS: ReadonlySet<TemplateElementKind> = new Set(['logo', 'photo']);

const KIND_LABELS: Record<TemplateElementKind, string> = {
  headline: 'Headline',
  subheadline: 'Sub-headline',
  body: 'Body text',
  feature: 'Feature',
  cta: 'Call to action',
  badge: 'Badge',
  text: 'Text',
  brandName: 'Business name',
  tagline: 'Tagline',
  phone: 'Phone',
  website: 'Website',
  logo: 'Logo',
  email: 'Email',
  address: 'Address',
  social: 'Social handle',
  personName: 'Person name',
  credential: 'Credential',
  photo: 'Photo',
};

// ---------------------------------------------------------------------------
// Template document
// ---------------------------------------------------------------------------

export const MAX_TEMPLATE_ELEMENTS = 40;
export const MAX_ELEMENT_TEXT = 300;

/** Normalised 0-1 against the template's own width and height. */
export const elementBoxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});

export type ElementBox = z.infer<typeof elementBoxSchema>;

export const templateElementSchema = z.object({
  /** Stable within the template: "e1", "e2", … in reading order. */
  id: z.string().regex(/^e\d{1,3}$/),
  kind: z.enum(TEMPLATE_ELEMENT_KINDS),
  /** The template's own text, exactly as printed. Null for `photo` and `logo`. */
  text: z.string().max(MAX_ELEMENT_TEXT).nullable(),
  box: elementBoxSchema,
  /** Repeated items that belong together, e.g. "features". Null when standalone. */
  group: z.string().max(40).nullable(),
  /** What a photo or logo shows, for the image prompt. Null for words. */
  description: z.string().max(MAX_ELEMENT_TEXT).nullable(),
});

export type TemplateElement = z.infer<typeof templateElementSchema>;

export const templateElementsDocSchema = z.object({
  version: z.literal(1),
  /** Pixel size the boxes were read against. */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Vision model that named the elements. */
  model: z.string().max(80),
  elements: z.array(templateElementSchema).max(MAX_TEMPLATE_ELEMENTS),
  /**
   * The highest element id number this template has ever used, across every
   * reading — including ids of elements a later re-read no longer found. A new
   * element is always numbered after it, so an id a campaign day still holds is
   * never given to a different element. Absent on documents stored before it
   * existed: `elementIdHighWater` then falls back to the highest id present.
   */
  lastId: z.number().int().min(0).max(999).optional(),
});

export type TemplateElementsDoc = z.infer<typeof templateElementsDocSchema>;

/** A stored `CategoryTemplate.elements`, or null if absent or unreadable by this build. */
export function parseTemplateElements(value: unknown): TemplateElementsDoc | null {
  const parsed = templateElementsDocSchema.safeParse(value);
  if (!parsed.success) return null;
  const ids = new Set(parsed.data.elements.map((element) => element.id));
  return ids.size === parsed.data.elements.length ? parsed.data : null;
}

/** 7 for "e7"; 0 for anything unparseable. */
export function elementIdNumber(id: string): number {
  const parsed = Number.parseInt(id.slice(1), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The highest element id number a template document has used: its recorded
 * `lastId`, or — for a document stored before `lastId` existed, or one whose
 * `lastId` is somehow behind its own ids — the highest id it holds.
 */
export function elementIdHighWater(doc: Pick<TemplateElementsDoc, 'elements' | 'lastId'>): number {
  return Math.max(doc.lastId ?? 0, 0, ...doc.elements.map((element) => elementIdNumber(element.id)));
}

/** "Headline", "Feature 2", "Phone" — numbered only when a kind repeats. */
export function elementLabel(doc: TemplateElementsDoc, element: TemplateElement): string {
  const sameKind = doc.elements.filter((candidate) => candidate.kind === element.kind);
  const base = KIND_LABELS[element.kind];
  return sameKind.length > 1 ? `${base} ${sameKind.indexOf(element) + 1}` : base;
}

/** "Headline · 3 features · CTA · logo · phone" for the template card. */
export function summarizeTemplateElements(doc: TemplateElementsDoc): string {
  const counts = new Map<TemplateElementKind, number>();
  for (const element of doc.elements) counts.set(element.kind, (counts.get(element.kind) ?? 0) + 1);
  return [...counts.entries()]
    .map(([kind, count]) => {
      const label = KIND_LABELS[kind].toLowerCase();
      return count > 1 ? `${count} ${label}${label.endsWith('s') ? '' : 's'}` : label;
    })
    .join(' · ');
}

// ---------------------------------------------------------------------------
// Day document
// ---------------------------------------------------------------------------

export const posterElementValueSchema = z.object({
  /** The template element's id. */
  id: z.string().regex(/^e\d{1,3}$/),
  /**
   * The day's words. Always null for brand-bound kinds and for `photo`: those
   * take their value from Brand Canvas and the day's image prompt.
   */
  text: z.string().max(MAX_ELEMENT_TEXT).nullable(),
  /** Hidden on this day's poster. The template's space closes up around it. */
  removed: z.boolean(),
  /** Who last set `text`, for the editor's "Reset to template". */
  source: z.enum(['template', 'admin', 'ai']),
  /**
   * The kind of the template element this value was written for. Written on
   * every clone, seed and save; absent on values stored before it existed. A
   * value whose kind no longer matches the template element with its id belongs
   * to a different element and is dropped (`reconcileDayElements`).
   */
  kind: z.enum(TEMPLATE_ELEMENT_KINDS).optional(),
});

export type PosterElementValue = z.infer<typeof posterElementValueSchema>;

export const dayPosterElementsDocSchema = z.object({
  version: z.literal(1),
  /** The template these values were cloned from. A remapped day is re-cloned. */
  templateId: z.string().uuid(),
  values: z.array(posterElementValueSchema).max(MAX_TEMPLATE_ELEMENTS),
});

export type DayPosterElementsDoc = z.infer<typeof dayPosterElementsDocSchema>;

/** A stored `ContentCalendar.posterElements`, or null if absent or unreadable. */
export function parseDayPosterElements(value: unknown): DayPosterElementsDoc | null {
  const parsed = dayPosterElementsDocSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Whether two day documents say the same thing: template, and every value's
 * words, visibility and source. `kind` is bookkeeping and is ignored, so a day
 * stored before values carried it is not mistaken for a changed one.
 */
export function sameDayElements(a: DayPosterElementsDoc | null, b: DayPosterElementsDoc | null): boolean {
  const key = (doc: DayPosterElementsDoc | null) =>
    doc ? JSON.stringify([doc.version, doc.templateId, doc.values.map((value) => [value.id, value.text, value.removed, value.source])]) : null;
  return key(a) === key(b);
}

// ---------------------------------------------------------------------------
// Contact details inside template words
// ---------------------------------------------------------------------------

/** A web address or an email address. Shared by the rewrite clamp, the clone and the text check. */
export const URL_OR_EMAIL = /(https?:\/\/|www\.|\b[\w.-]+@[\w-]+\.[\w.]+|\b[\w-]+\.(com|in|org|net|io|co)\b)/i;

/** A phone-like run of digits (spaces and hyphens allowed inside). */
export const LONG_NUMBER = /\d[\d\s-]{5,}\d/;

/** A registration, licence or tax number ("Reg No. 30435", "GSTIN 29ABCDE1234F1Z5") — another business's credential. */
export const REGISTRATION_NUMBER = /\b(?:reg(?:istration)?|licen[cs]e|lic|gst(?:in)?)\.?\s*(?:no|number|#)?\.?\s*[:#-]?\s*[a-z]*[-/]?\d[\w/-]{2,}/i;

/** Whether `text` holds a web address, an email address, a phone-like number or a registration number. */
export function containsContactDetail(text: string | null | undefined): boolean {
  return Boolean(text) && (URL_OR_EMAIL.test(text!) || LONG_NUMBER.test(text!) || REGISTRATION_NUMBER.test(text!));
}

/** Every contact detail in `text`, folded: addresses lower-cased, numbers to their digits. */
function contactDetailsIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(new RegExp(URL_OR_EMAIL.source, 'gi'))) found.push(`url:${match[0].toLowerCase()}`);
  for (const match of text.matchAll(new RegExp(LONG_NUMBER.source, 'g'))) found.push(`number:${match[0].replace(/\D/g, '')}`);
  for (const match of text.matchAll(new RegExp(REGISTRATION_NUMBER.source, 'gi'))) found.push(`reg:${match[0].replace(/\W/g, '').toLowerCase()}`);
  return found;
}

/**
 * Whether `printed` still carries a contact detail — a web or email address, a
 * phone-like number — that the template's own words `templateText` had: the
 * template's words kept as they are, or with only the business name swapped. A
 * detail the admin typed that the template did not have does not count.
 */
export function carriesTemplateContactDetail(printed: string | null | undefined, templateText: string | null | undefined): boolean {
  if (!printed || !templateText) return false;
  const inherited = new Set(contactDetailsIn(templateText));
  return inherited.size > 0 && contactDetailsIn(printed).some((detail) => inherited.has(detail));
}

// ---------------------------------------------------------------------------
// Bindings — which Brand Canvas field an element prints in this template
// ---------------------------------------------------------------------------

/** A Brand Canvas field an element can be bound to. */
export type BrandField = (typeof BRAND_BINDINGS)[BrandBoundKind];

/**
 * Every element of a template that takes its value from Brand Canvas, and from
 * which field.
 *
 * The bound kinds bind to their own field. Two fallbacks keep a template's
 * identity slots from going empty when the reader found no business name or
 * tagline of its own — a doctor's poster whose only "name" is the doctor's:
 *
 *   - no `brandName` element: the first `personName` prints the company name;
 *   - no `tagline` element: the first `credential` prints the tagline.
 *
 * Every other person name and credential stays unbound (hidden by default).
 * Measured in the Phase 0 spike: the urology template kept an empty teal
 * doctor bar once its name, registration and degrees were all erased.
 */
export function templateBindings(doc: TemplateElementsDoc): Map<string, BrandField> {
  const bindings = new Map<string, BrandField>();
  for (const element of doc.elements) {
    if (isBrandBound(element.kind)) bindings.set(element.id, BRAND_BINDINGS[element.kind]);
  }
  if (!doc.elements.some((element) => element.kind === 'brandName')) {
    const person = doc.elements.find((element) => element.kind === 'personName');
    if (person) bindings.set(person.id, 'companyName');
  }
  if (!doc.elements.some((element) => element.kind === 'tagline')) {
    const credential = doc.elements.find((element) => element.kind === 'credential');
    if (credential) bindings.set(credential.id, 'tagline');
  }
  return bindings;
}

/** Whether a template element prints a Brand Canvas value (its own kind's or a fallback's). */
export function isBoundElement(doc: TemplateElementsDoc, elementId: string): boolean {
  return templateBindings(doc).has(elementId);
}

// ---------------------------------------------------------------------------
// Business name in the template's own words
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `text` with every whole-phrase, case-insensitive occurrence of one of `names`
 * replaced by `replacement`. A phrase only matches between non-letters and
 * non-digits, so "EDC" is not found inside "EDCLINIC". Longer names are tried
 * first, so "Urocare Clinic" wins over "Urocare".
 */
export function replaceBusinessName(text: string, names: readonly string[], replacement: string): string {
  const cleanNames = [...new Set(names.map((name) => name.replace(/\s+/g, ' ').trim()).filter((name) => name.length >= 2))].sort(
    (a, b) => b.length - a.length,
  );
  const target = replacement.replace(/\s+/g, ' ').trim();
  if (cleanNames.length === 0 || !target) return text;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${cleanNames.map((name) => escapeRegExp(name).replace(/ /g, '\\s+')).join('|')})(?![\\p{L}\\p{N}])`,
    'giu',
  );
  return text.replace(pattern, target);
}

export interface CloneOptions {
  /**
   * The client's company name. When set, the template's own business name (the
   * text of its `brandName` elements) is replaced by it inside the template's
   * words — "Choose Urocare Clinic." becomes "Choose Sirah Dental." — so a clone
   * never advertises the business the template was made for.
   */
  businessName?: string | null;
}

/**
 * A fresh day copy of a template: its words as they are (with the template's
 * business name swapped for the client's), identity bound to Brand Canvas —
 * including the fallback bindings of `templateBindings` — and every other
 * unbound identity detail hidden: those are another business's name, address
 * or registration number.
 *
 * **Contact details inside the words are hidden too.** A content element whose
 * template words hold a web or email address or a phone-like number ("Call
 * 98765 43210 today") starts removed: those digits belong to the business the
 * template was made for, and must never reach a client's poster unless an admin
 * shows or rewrites the element on purpose.
 */
export function cloneTemplateElements(
  doc: TemplateElementsDoc,
  templateId: string,
  options: CloneOptions = {},
): DayPosterElementsDoc {
  const bindings = templateBindings(doc);
  const businessName = options.businessName?.replace(/\s+/g, ' ').trim() || null;
  const templateNames = doc.elements
    .filter((element) => element.kind === 'brandName' && element.text)
    .map((element) => element.text!);

  return {
    version: 1,
    templateId,
    values: doc.elements.map((element) => {
      const content = CONTENT_KINDS.has(element.kind);
      let text = content ? element.text : null;
      if (text && businessName && templateNames.length > 0) {
        text = replaceBusinessName(text, templateNames, businessName).slice(0, MAX_ELEMENT_TEXT);
      }
      return {
        id: element.id,
        text,
        removed: (UNBOUND_IDENTITY_KINDS.has(element.kind) && !bindings.has(element.id)) || (content && containsContactDetail(element.text)),
        source: 'template' as const,
        kind: element.kind,
      };
    }),
  };
}

/**
 * Brings a stored day copy in line with the template's current elements: values
 * for elements the template no longer has are dropped, and new elements are
 * added as a fresh clone would add them. Returns the same shape either way, so
 * callers never special-case an old copy.
 *
 * - **A value written for another kind of element is dropped.** Its id now
 *   belongs to a different element (a re-read found other elements), so its
 *   words would land in the wrong place; the element starts fresh. A value
 *   stored before values carried `kind` cannot be checked and is kept.
 * - **Words still the template's follow the template.** A `template` value takes
 *   its words from the fresh clone — a re-read that fixed a misread word, or a
 *   new business name, reaches every day that never changed those words — and
 *   keeps only whether the day hides it. Words an admin or the AI wrote stay.
 */
export function reconcileDayElements(
  template: TemplateElementsDoc,
  day: DayPosterElementsDoc | null,
  templateId: string,
  options: CloneOptions = {},
): DayPosterElementsDoc {
  const fresh = cloneTemplateElements(template, templateId, options);
  if (!day || day.templateId !== templateId) return fresh;
  const stored = new Map(day.values.map((value) => [value.id, value]));
  return {
    version: 1,
    templateId,
    values: fresh.values.map((value) => {
      const kept = stored.get(value.id);
      if (!kept || (kept.kind !== undefined && kept.kind !== value.kind)) return value;
      if (kept.source === 'template') return { ...value, removed: kept.removed };
      return { id: value.id, text: kept.text, removed: kept.removed, source: kept.source, kind: value.kind };
    }),
  };
}

/** A day's headline, supporting text and call to action as its legacy columns hold them. */
export interface LegacyDayContent {
  headline: string | null;
  supportingText: string | null;
  cta: string | null;
}

/**
 * A fresh clone of a template for a day that has content but no elements yet —
 * a day written by the AI content calendar before clone mode — with that
 * content kept rather than overwritten by the template's words:
 *
 *   headline        → the first `headline` element
 *   supporting text → the first `subheadline`, else the first `body`
 *   call to action  → the first `cta`
 *
 * Each seeded value is the admin's (`source: 'admin'`) and shown. A text the
 * template has no element for stays on the day's columns only; a text that
 * already reads as the template's own words (a day whose columns were synced
 * from an earlier clone) is left as the template's, so seeding such a day gives
 * exactly the fresh clone.
 */
export function seedDayElementsFromLegacy(
  doc: TemplateElementsDoc,
  templateId: string,
  legacy: LegacyDayContent,
  options: CloneOptions = {},
): DayPosterElementsDoc {
  const fresh = cloneTemplateElements(doc, templateId, options);
  const values = fresh.values.map((value) => ({ ...value }));
  const fold = (text: string | null | undefined) => text?.replace(/\s+/g, ' ').trim() ?? '';
  const ofKinds = (kinds: readonly TemplateElementKind[]) => values.filter((value) => value.kind !== undefined && kinds.includes(value.kind));
  const shown = (kinds: readonly TemplateElementKind[]) =>
    ofKinds(kinds)
      .filter((value) => !value.removed && fold(value.text))
      .map((value) => fold(value.text));

  const seed = (text: string | null, target: (typeof values)[number] | undefined, templateWords: string[]) => {
    const clean = fold(text).slice(0, MAX_ELEMENT_TEXT).trim();
    if (!clean || !target) return;
    if (clean === templateWords.join(' ') || clean === fold(target.text)) return;
    target.text = clean;
    target.removed = false;
    target.source = 'admin';
  };

  seed(legacy.headline, ofKinds(['headline'])[0], shown(['headline']));
  seed(legacy.supportingText, ofKinds(['subheadline'])[0] ?? ofKinds(['body'])[0], shown(['subheadline', 'body']));
  seed(legacy.cta, ofKinds(['cta'])[0], shown(['cta']).slice(0, 1));
  return { ...fresh, values };
}

/**
 * The day's values for a template, wherever a missing or stored copy is turned
 * into the one to edit, generate or save: a stored copy reconciled with the
 * template (`reconcileDayElements`), or — when the day has none — a fresh clone
 * seeded with the day's existing content (`seedDayElementsFromLegacy`).
 */
export function materializeDayElements(
  doc: TemplateElementsDoc,
  stored: DayPosterElementsDoc | null,
  templateId: string,
  legacy: LegacyDayContent,
  options: CloneOptions = {},
): DayPosterElementsDoc {
  return stored ? reconcileDayElements(doc, stored, templateId, options) : seedDayElementsFromLegacy(doc, templateId, legacy, options);
}

// ---------------------------------------------------------------------------
// Resolution — what a day does to each element
// ---------------------------------------------------------------------------

/** The Brand Canvas values a clone can bind to. Empty strings count as absent. */
export interface CloneBrandValues {
  companyName: string | null;
  tagline: string | null;
  phone: string | null;
  website: string | null;
  hasLogo: boolean;
  /**
   * The client's logo artwork already spells the company name (Brand Canvas
   * `logoIncludesName`). Absent means false. Decides whether a wide logo badge
   * gets the name written beside the composited mark — see `isLogoLockupBox`.
   */
  logoIncludesName?: boolean;
}

export type ElementAction =
  /** Leave the element exactly as the template has it. */
  | { type: 'keep' }
  /** Print different words in the element's place, in its style. */
  | { type: 'replace'; text: string }
  /** Erase the element; the design closes up around it. */
  | { type: 'remove' }
  /**
   * Clear the template's logo; the client's logo is composited here afterwards.
   * `name`, present only for a wide logo badge (`isLogoLockupBox`), is the
   * company name the image model writes in the badge beside the mark, whose
   * square at the badge's left end is left empty for the composited logo.
   */
  | { type: 'logo'; name?: string }
  /** Replace the photograph; `prompt` is the day's image prompt, or null for "suited to the headline". */
  | { type: 'photo'; prompt: string | null };

/**
 * A logo box more than twice as wide as tall, in pixels, is a badge or lockup
 * — a mark with lettering beside it, often on a pill — rather than a mark alone.
 */
export const LOGO_LOCKUP_MIN_ASPECT = 2;

export function isLogoLockupBox(box: ElementBox, doc: Pick<TemplateElementsDoc, 'width' | 'height'>): boolean {
  const height = box.h * doc.height;
  return height > 0 && (box.w * doc.width) / height > LOGO_LOCKUP_MIN_ASPECT;
}

/** Identity kinds printed as words: what a contact label ("Call us on", "Visit us at:") introduces. */
const IDENTITY_TEXT_KINDS: ReadonlySet<TemplateElementKind> = new Set([
  'brandName',
  'tagline',
  'phone',
  'website',
  'email',
  'address',
  'social',
  'personName',
  'credential',
]);

/** Longest label introducing a detail on its own line without a colon ("Call us on"). */
const MAX_INLINE_LABEL = 24;

/**
 * Contact labels and the identity detail each introduces: label id → detail id.
 *
 * A label is a `text` or `cta` element that is followed by an identity detail
 * either on the same line, to its right (short labels only: "Call us on"), or —
 * when it ends with a colon ("Visit us at:") — on the same line or just below.
 * A label with nothing left to introduce is an orphan: `resolveDayElements`
 * removes it with its detail. Measured in the Phase 0 spike: "Find Us Here:"
 * stayed on the poster, pointing at an erased address.
 */
export function contactLabelTargets(doc: TemplateElementsDoc): Map<string, string> {
  const labels = new Map<string, string>();
  for (const label of doc.elements) {
    if (label.kind !== 'text' && label.kind !== 'cta') continue;
    const text = label.text?.trim() ?? '';
    if (!text) continue;
    const colon = /[:：]$/.test(text);
    const a = label.box;
    const centreA = a.y + a.h / 2;

    let best: { id: string; distance: number } | null = null;
    for (const detail of doc.elements) {
      if (detail.id === label.id || !IDENTITY_TEXT_KINDS.has(detail.kind)) continue;
      const b = detail.box;
      const sameLine = Math.abs(b.y + b.h / 2 - centreA) < Math.max(Math.min(a.h, b.h), 0.005) && b.x >= a.x + a.w * 0.5;
      const below =
        colon &&
        b.y >= a.y + a.h * 0.5 &&
        b.y - (a.y + a.h) < Math.max(a.h, 0.01) * 1.5 &&
        Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x);
      if (!(sameLine && (colon || text.length <= MAX_INLINE_LABEL)) && !below) continue;
      const distance = sameLine ? Math.max(0, b.x - (a.x + a.w)) : 1 + (b.y - (a.y + a.h));
      if (!best || distance < best.distance) best = { id: detail.id, distance };
    }
    if (best) labels.set(label.id, best.id);
  }
  return labels;
}

export interface ResolvedElement {
  element: TemplateElement;
  label: string;
  action: ElementAction;
}

function present(value: string | null | undefined): string | null {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed : null;
}

/**
 * Every template element with what this day does to it. Pure, and the single
 * source for the image prompt, the editor preview and the text check.
 */
export function resolveDayElements(
  template: TemplateElementsDoc,
  day: DayPosterElementsDoc,
  brand: CloneBrandValues,
  imagePrompt: string | null,
): ResolvedElement[] {
  const values = new Map(day.values.map((value) => [value.id, value]));
  const bindings = templateBindings(template);
  const hasBrandNameElement = template.elements.some((element) => element.kind === 'brandName');

  const resolved = template.elements.map((element): ResolvedElement => {
    const label = elementLabel(template, element);
    const value = values.get(element.id);
    const binding = bindings.get(element.id);
    const removed = value?.removed ?? (UNBOUND_IDENTITY_KINDS.has(element.kind) && !binding);

    if (element.kind === 'photo') {
      return { element, label, action: removed ? { type: 'remove' } : { type: 'photo', prompt: present(imagePrompt) } };
    }
    if (element.kind === 'logo') {
      if (removed || !brand.hasLogo) return { element, label, action: { type: 'remove' } };
      // A wide badge left with only a small mark in it reads as broken: the
      // model writes the company name where the template's lettering was —
      // unless the logo already spells it, or the template prints the name in
      // its own element beside the logo.
      const name =
        isLogoLockupBox(element.box, template) && !brand.logoIncludesName && !hasBrandNameElement ? present(brand.companyName) : null;
      return { element, label, action: name ? { type: 'logo', name } : { type: 'logo' } };
    }
    if (removed) return { element, label, action: { type: 'remove' } };

    if (binding && binding !== 'logo') {
      const bound = present(brand[binding]);
      return { element, label, action: bound ? { type: 'replace', text: bound } : { type: 'remove' } };
    }

    const text = present(value?.text);
    if (!text) return { element, label, action: { type: 'remove' } };
    if (text === present(element.text)) return { element, label, action: { type: 'keep' } };
    return { element, label, action: { type: 'replace', text } };
  });

  // A contact label whose detail is gone goes with it, unless an admin wrote it.
  const byId = new Map(resolved.map((item) => [item.element.id, item]));
  for (const [labelId, detailId] of contactLabelTargets(template)) {
    const label = byId.get(labelId);
    const detail = byId.get(detailId);
    if (!label || !detail || detail.action.type !== 'remove' || label.action.type === 'remove') continue;
    if (values.get(labelId)?.source === 'admin') continue;
    label.action = { type: 'remove' };
  }
  return resolved;
}

/**
 * The day's headline, supporting text and call to action, derived from its
 * elements so review, delivery captions and history keep working unchanged.
 */
export function legacyContentFields(resolved: readonly ResolvedElement[]): {
  headline: string | null;
  supportingText: string | null;
  cta: string | null;
} {
  const shown = (kinds: TemplateElementKind[]) =>
    resolved
      .filter((item) => kinds.includes(item.element.kind))
      .map((item) =>
        item.action.type === 'replace'
          ? item.action.text
          : item.action.type === 'keep'
            ? present(item.element.text)
            : null,
      )
      .filter((text): text is string => Boolean(text));

  return {
    headline: shown(['headline']).join(' ') || null,
    supportingText: shown(['subheadline', 'body']).join(' ') || null,
    cta: shown(['cta'])[0] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Text check
// ---------------------------------------------------------------------------

export const textCheckItemSchema = z.object({
  elementId: z.string(),
  label: z.string(),
  expected: z.string(),
  /** What the read-back found in that place, or null if nothing legible. */
  found: z.string().nullable(),
  match: z.boolean(),
});

export const textCheckResultSchema = z.object({
  checkedAt: z.string(),
  model: z.string(),
  /** True when every expected text matched and no leftover was found. */
  ok: z.boolean(),
  items: z.array(textCheckItemSchema),
  /** Template text that should have been changed or removed but is still visible. */
  leftovers: z.array(z.string()),
});

export type TextCheckResult = z.infer<typeof textCheckResultSchema>;

export function parseTextCheck(value: unknown): TextCheckResult | null {
  const parsed = textCheckResultSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Differences worth showing on a card: mismatched texts plus leftovers. */
export function textCheckIssueCount(result: TextCheckResult | null): number {
  if (!result) return 0;
  return result.items.filter((item) => !item.match).length + result.leftovers.length;
}
