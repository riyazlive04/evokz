import {
  CONTENT_KINDS,
  elementLabel,
  isBrandBound,
  parseTemplateElements,
  summarizeTemplateElements,
  UNBOUND_IDENTITY_KINDS,
  type ElementBox,
  type TemplateElementKind,
  type TemplateElementsDoc,
} from '@/lib/types/template-elements';

/**
 * How a template's elements are shown on the vertical page: the one-line state
 * on its card and the grouped list in its elements dialog.
 *
 * Pure and free of React and Prisma, so the page (server), the card and dialog
 * (client) and `scripts/check-template-elements-view.ts` all read the same
 * answer. What an element *is* stays in `src/lib/types/template-elements.ts`;
 * this file only decides how an admin sees it.
 */

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * The four things a clone can do to an element, which is what an admin needs to
 * know about it:
 *
 *   content  words the admin edits, pre-filled from the template
 *   brand    identity replaced from the client's Brand Canvas
 *   hidden   another business's detail with no Brand Canvas field — left off a
 *            client's poster unless the admin types a value
 *   photo    the photograph, replaced from the day's image prompt
 */
export type ElementCategory = 'content' | 'brand' | 'hidden' | 'photo';

/** Display order of the dialog's groups: what the admin changes first. */
export const ELEMENT_CATEGORIES: readonly ElementCategory[] = ['content', 'brand', 'hidden', 'photo'];

export const ELEMENT_CATEGORY_TITLES: Record<ElementCategory, string> = {
  content: 'Words you can edit',
  brand: 'Filled from Brand Canvas',
  hidden: 'Hidden by default',
  photo: 'Photo',
};

/**
 * Which category a kind belongs to.
 *
 * Derived from the contract's own sets rather than a second table, so a kind
 * added there lands in the right group here without an edit. The final branch
 * is `photo` only because every other kind is in one of the three sets — the
 * check script asserts that for every kind.
 */
export function elementCategory(kind: TemplateElementKind): ElementCategory {
  if (CONTENT_KINDS.has(kind)) return 'content';
  if (isBrandBound(kind)) return 'brand';
  if (UNBOUND_IDENTITY_KINDS.has(kind)) return 'hidden';
  return 'photo';
}

// ---------------------------------------------------------------------------
// Items and groups
// ---------------------------------------------------------------------------

export interface ElementViewItem {
  id: string;
  kind: TemplateElementKind;
  /** "Headline", "Feature 2" — see `elementLabel`. */
  label: string;
  category: ElementCategory;
  /**
   * What the list prints beside the label: the template's own words, or for a
   * photo or logo what it shows. Null when the reading has neither.
   */
  detail: string | null;
  box: ElementBox;
}

export interface ElementGroupView {
  category: ElementCategory;
  title: string;
  items: ElementViewItem[];
}

/** Every element with its label and category, in the template's reading order. */
export function templateElementItems(doc: TemplateElementsDoc): ElementViewItem[] {
  return doc.elements.map((element) => ({
    id: element.id,
    kind: element.kind,
    label: elementLabel(doc, element),
    category: elementCategory(element.kind),
    detail: element.text ?? element.description,
    box: element.box,
  }));
}

/**
 * The dialog's list: one group per category in `ELEMENT_CATEGORIES` order, each
 * in reading order. A category the template has nothing in is left out rather
 * than shown empty — "Hidden by default: none" is noise on most templates.
 */
export function groupTemplateElements(doc: TemplateElementsDoc): ElementGroupView[] {
  const items = templateElementItems(doc);
  return ELEMENT_CATEGORIES.map((category) => ({
    category,
    title: ELEMENT_CATEGORY_TITLES[category],
    items: items.filter((item) => item.category === category),
  })).filter((group) => group.items.length > 0);
}

/**
 * The order boxes are drawn over the template: photographs first, so the small
 * text boxes on top of a full-bleed photo stay visible and can be hovered.
 * Stable within each layer.
 */
export function overlayDrawOrder(items: readonly ElementViewItem[]): ElementViewItem[] {
  return [...items.filter((item) => item.category === 'photo'), ...items.filter((item) => item.category !== 'photo')];
}

// ---------------------------------------------------------------------------
// Card state
// ---------------------------------------------------------------------------

/** Shown when a stored reading exists but this build cannot parse it. */
export const UNREADABLE_ELEMENTS_MESSAGE = 'The stored reading is in a format this version cannot show. Read it again.';

/**
 * What a template card says about its elements. Serializable, so the page can
 * hand it straight to the client card.
 *
 *   read    a usable reading. `lastError` is set when a later re-read failed:
 *           a failed re-read keeps the reading it could not replace.
 *   failed  no usable reading, and why.
 *   unread  never read — a template uploaded before clone mode.
 */
export type TemplateElementsState =
  | {
      status: 'read';
      doc: TemplateElementsDoc;
      summary: string;
      /** ISO instant of the reading, or null for a row written without one. */
      readAt: string | null;
      lastError: string | null;
    }
  | { status: 'failed'; error: string }
  | { status: 'unread' };

export function templateElementsState(row: {
  elements: unknown;
  elementsReadAt: Date | null;
  elementsError: string | null;
}): TemplateElementsState {
  const error = row.elementsError?.trim() || null;

  // Prisma returns both a database NULL and a JSON null as `null`; both mean
  // "nothing was ever stored".
  if (row.elements === null || row.elements === undefined) {
    return error ? { status: 'failed', error } : { status: 'unread' };
  }

  const doc = parseTemplateElements(row.elements);
  if (!doc) return { status: 'failed', error: error ?? UNREADABLE_ELEMENTS_MESSAGE };

  return {
    status: 'read',
    doc,
    summary: summarizeTemplateElements(doc),
    readAt: row.elementsReadAt ? row.elementsReadAt.toISOString() : null,
    lastError: error,
  };
}
