import { STUDIO_ASPECT_RATIOS, type StudioAspectRatio } from '@/lib/poster-studio/limits';
import {
  isBrandBound,
  legacyContentFields,
  type ElementBox,
  type ResolvedElement,
  type TemplateElementKind,
} from '@/lib/types/template-elements';

/**
 * Prompt construction for the AI Poster Studio.
 *
 * Pure functions: no model calls, no I/O. Three builders, because the three
 * modes ask the image model for different things and a shared template pushed
 * all of them towards the same one — a full redraw:
 *
 *   GENERATE   brief + format + brand + text rules (+ how to treat a reference)
 *   EDIT       the change, applied fully, and the untouched areas left alone
 *   VARIATION  a new creative direction for the same campaign: the message and
 *              brand mood survive, the concept, imagery and layout do not
 *   CLONE      the attached template reproduced exactly, with only a numbered
 *              list of its elements changed (`buildClonePrompt`)
 *
 * Every builder ends with the same "no invented branding" rule. Exact identity —
 * logo, company name, tagline, contact details — is composited deterministically
 * after generation, and a model-drawn mark beside it (or instead of it) is the
 * failure the studio exists to prevent.
 *
 * There is no vision pre-pass. The first version described an attached image
 * with gpt-4o and pasted the description in here — for an edit, that meant
 * describing the very image being sent alongside it, and on failure a hardcoded
 * "architectural photography" description was substituted as though it were
 * real. The image model reads the attached image directly.
 */

/** Brand facts resolved from a stored client. Absent fields are omitted, never guessed. */
export interface StudioBrandContext {
  companyName: string;
  industry: string | null;
  tagline: string | null;
  colors: Array<{ hex: string; role: string }>;
  typography: { headingFont: string; bodyFont: string; vibe: string | null } | null;
  layoutDirectives: string[];
}

interface CommonInput {
  aspectRatio: StudioAspectRatio;
  /** Ask for artwork with no lettering. The model draws no text of its own. */
  textFree: boolean;
  /**
   * Share of the canvas height, along the bottom edge, that the deterministic
   * Brand Canvas identity band will cover after generation. When set, the model
   * is told to keep that strip clear and to draw no logo, brand name, tagline,
   * phone number, web address or QR code anywhere — those are composited exactly
   * afterwards. Omitted or null leaves every prompt exactly as it was.
   */
  identityBandFraction?: number | null;
}

export interface GeneratePromptInput extends CommonInput {
  brief: string;
  brand: StudioBrandContext | null;
  /** True when a style reference image is attached to the request. */
  hasReference: boolean;
  /**
   * The admin's standing instruction for the attached template
   * (`CategoryTemplate.prompt`). Only read when `hasReference` is true: it
   * describes that reference, and means nothing without it.
   */
  templatePrompt?: string | null;
}

export interface EditPromptInput extends CommonInput {
  instruction: string;
}

/**
 * Concrete creative approaches a Variation rotates through.
 *
 * "Redesign substantially" on its own did not move the model: live Variations of
 * a family dental poster kept returning the same mother-and-child clinic scene
 * with the headline block top-left, partly because the campaign itself pulls
 * towards that picture. A named approach gives the model somewhere specific to
 * go. Each describes a concept and a composition, never a brand or a medium
 * that would override Brand Canvas guidance; the operator's own direction wins
 * when it asks for a style or layout.
 */
export const VARIATION_APPROACHES = [
  'Typographic concept: make the headline itself the main visual — very large, confident type across the middle of the frame — supported by one smaller, simple image.',
  'Illustrated concept: a clean, modern illustration style instead of photography, with a different subject from the source and the headline in a band across the top.',
  'Split layout: divide the frame into two clear zones — imagery in one, the message on a solid brand-colour block in the other — arranged differently from the source.',
  'Wide scene concept: a spacious environmental scene with the subject small in the frame, plenty of open space, and the headline centred in that space.',
  'Graphic shapes concept: bold geometric shapes in the brand colours framing a cut-out subject, with the headline stacked beside or below it.',
  'Close-up concept: one large, tightly framed hero detail or object that symbolises the campaign, filling most of the frame, with the headline set over the lower half.',
] as const;

export interface VariationPromptInput extends CommonInput {
  direction: string;
  brand: StudioBrandContext | null;
  /** Index into `VARIATION_APPROACHES`, wrapped; chosen by the caller so successive variations differ. */
  approach: number;
  /**
   * The brief the source artwork's campaign was generated from, when the source
   * is a History item whose lineage reaches a Generate. Gives the model the
   * campaign's intent in words, so it does not have to recover it by copying the
   * picture. Null for an uploaded source.
   */
  campaignBrief?: string | null;
}

export function buildGeneratePrompt(input: GeneratePromptInput): string {
  const band = input.identityBandFraction ?? null;
  const sections = [
    'Design a finished, professional marketing poster.',
    `Brief:\n${input.brief.trim()}`,
    formatSection(input.aspectRatio),
  ];

  if (input.hasReference) {
    sections.push(referenceSection(input.brand !== null));
    const templatePrompt = input.templatePrompt?.trim();
    if (templatePrompt) sections.push(templatePromptSection(templatePrompt));
  }
  if (input.brand) sections.push(brandSection(input.brand, 'apply', band !== null));
  if (band !== null) sections.push(identitySection(band));
  sections.push(textSection(input.textFree));
  sections.push(noInventedBrandingSection('create', band !== null));

  return sections.join('\n\n');
}

/**
 * An edit changes what it is asked to and nothing else — but it does change it.
 *
 * The first version listed "composition, subject, colours…" under "keep
 * everything else as it is", which pulled a request to replace the main artwork
 * back towards the old subject. The change is now applied fully, and the
 * preservation clause covers only the areas it does not touch.
 */
export function buildEditPrompt(input: EditPromptInput): string {
  const band = input.identityBandFraction ?? null;
  return [
    'Edit the attached image. Make this change:',
    input.instruction.trim(),
    'Apply the change fully. If it replaces a subject, a scene, the main artwork or another large region, redraw that region completely as described — do not keep, blend in or ghost the old content there.',
    'Leave every area the change does not touch as it is: its composition, colours, lighting, typography and existing text, spelled exactly as it appears. Do not redesign or restyle unrelated parts of the image.',
    `Output frame: ${STUDIO_ASPECT_RATIOS[input.aspectRatio].orientation}. If the attached image has a different shape, extend or crop its background naturally; never stretch or distort it.`,
    band !== null ? identitySection(band) : null,
    input.textFree ? 'Do not add any new text, letters or numbers.' : null,
    noInventedBrandingSection('edit', band !== null),
  ]
    .filter((part): part is string => part !== null)
    .join('\n\n');
}

/**
 * A new creative direction for the source artwork's campaign — not an edit of it.
 *
 * The attached image goes through the edit endpoint, which leans hard towards
 * keeping what it is given. Two earlier versions asked to keep the "typographic
 * style" or "typographic character" and the "essential wording exactly as
 * written" of the parent, and in live testing the model kept the whole text
 * block — position, scale, typeface and line breaks — and only rearranged the
 * imagery. The parent's layout and typography are therefore never named as
 * something to keep. What survives is the message and the brand mood; the
 * concept, imagery, focal point, composition and hierarchy are explicitly open,
 * and a near-duplicate is named as the failure. Brand Canvas colours, typography
 * and layout rules still guide the design, as brand guidance rather than as a
 * copy of the parent.
 *
 * Wording alone was not enough: at full resolution the model still kept the
 * parent's subject, pose and headline block. The action therefore sends a
 * reduced preview of the source (`reduceVariationSource`), and each variation
 * is given one concrete approach from `VARIATION_APPROACHES`.
 */
export function buildVariationPrompt(input: VariationPromptInput): string {
  const band = input.identityBandFraction ?? null;
  const brief = input.campaignBrief?.trim() || null;

  const sections = [
    'Create a genuinely new creative direction for the campaign shown in the attached artwork.',
    [
      'The attached image is a small preview of the source artwork. Use it to understand the campaign — its message, its key facts and its mood — not as a layout to reuse or an image to edit.',
      'Preserve the underlying message and the brand mood, but substantially redesign the visual concept, imagery, focal point, composition and layout. Do not create a near-duplicate: explore a clearly different visual concept.',
    ].join('\n'),
  ];

  if (brief) {
    sections.push(
      `Campaign intent — the brief this campaign was first created from (the source artwork is authoritative where the two differ):\n${brief}`,
    );
  }

  const approach =
    VARIATION_APPROACHES[
      ((input.approach % VARIATION_APPROACHES.length) + VARIATION_APPROACHES.length) % VARIATION_APPROACHES.length
    ];

  sections.push(
    `Direction for this variation:\n${input.direction.trim()}`,
    `Creative approach for this variation — follow it unless the direction above asks for a specific style or layout:\n${approach}`,
    [
      'Keep:',
      '- the campaign’s core message and the key facts it states, such as an offer, a date or an audience',
      '- the brand mood and colour world',
      '- a finished, professional level of quality',
    ].join('\n'),
    [
      'Change substantially:',
      '- the visual concept and the main subject or scene',
      '- the imagery: what is shown, the illustration or photographic style, the angle, framing and crop',
      '- the focal point',
      '- the composition, spatial arrangement and layout grid',
      '- the visual hierarchy: where the headline sits, its scale and its typographic treatment',
      '- the colour treatment and lighting, within the brand palette',
      '- the supporting graphic elements and the negative space',
    ].join('\n'),
    'Different enough means that, side by side, the two read as two different poster concepts for the same campaign. Do not keep the source’s headline position, text block shape, type styling, main subject, subject placement or background scene. If the result could pass for the source with small changes, it is not different enough.',
    formatSection(input.aspectRatio),
  );

  if (input.brand) sections.push(brandSection(input.brand, 'preserve', band !== null));
  if (band !== null) sections.push(identitySection(band));
  sections.push(variationTextSection(input.textFree));
  sections.push(noInventedBrandingSection('create', band !== null, 'source'));

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

export interface ClonePromptInput {
  /** Every template element with what the day does to it, from `resolveDayElements`. */
  resolved: readonly ResolvedElement[];
  /**
   * Brand Canvas colours to recolour to; null or empty keeps the template's own
   * colours. Only accent roles are used — see `cloneAccentColors`.
   */
  brandColors: ReadonlyArray<{ hex: string; role: string }> | null;
  /**
   * Who prints the business name, tagline, phone and website. `ai` gives the
   * image model the exact strings; `code` has it clear those places so
   * `composeCloneIdentity` can draw them afterwards.
   */
  identity: 'ai' | 'code';
  /** The output frame in words, e.g. "vertical 4:5". */
  orientation: string;
  /**
   * One sentence correcting a rejected earlier version (`rejectionGuidance`),
   * placed last. Null or absent adds nothing.
   */
  correction?: string | null;
}

/**
 * Colour roles that describe a surface or type rather than an accent. Recolouring
 * a template's background to a brand "background" turned dark templates light in
 * the Phase 0 spike (0d10ad31 D, b58b0a93 D) — a different poster. Only accents
 * are recoloured.
 */
const NON_ACCENT_ROLE = /background|surface|neutral|base|text|foreground|ink|white|black/i;

/** The brand colours a clone may recolour to: accent roles only, background and neutral roles removed. */
export function cloneAccentColors(
  colors: ReadonlyArray<{ hex: string; role: string }> | null | undefined,
): Array<{ hex: string; role: string }> {
  return (colors ?? []).filter((color) => /^#[0-9a-f]{3,8}$/i.test(color.hex.trim()) && !NON_ACCENT_ROLE.test(color.role));
}

/**
 * Identity text code can draw exactly: the brand-bound kinds that are words.
 * The logo is always composited by code, whichever way `identity` is set.
 */
export function isCodeDrawnIdentity(kind: TemplateElementKind): boolean {
  return isBrandBound(kind) && kind !== 'logo';
}

/**
 * A template reproduced exactly, with only its listed elements changed.
 *
 * The opposite stance to every other builder here. Generate treats a reference as
 * inspiration and Variation asks for a different poster; a clone *is* the
 * template, and anything the model redesigns is a defect. So the prompt names what
 * must survive in concrete terms — layout, type, shapes, effects — and then gives
 * the changes as a short numbered list, one line per element, because a model
 * editing an image follows an explicit list far better than prose.
 *
 * Elements the day keeps are not listed at all: naming them invites the model to
 * "improve" them. Each listed element is located by its label and its position in
 * words — the model cannot use coordinates — and a photograph also by what it
 * shows, since a poster can hold two.
 *
 * Kept short on purpose (under 4,000 characters for twenty elements): shared
 * rules — text fitting its area, orphaned icons and empty shapes, empty logo
 * areas — are stated once rather than repeated on every line.
 */
export function buildClonePrompt(input: ClonePromptInput): string {
  const headline = legacyContentFields(input.resolved).headline;
  // The day's image prompt describes the poster's main photograph. A second,
  // smaller picture — a cut-out portrait, an inset — gets a new subject suited to
  // the poster instead of a copy of the main one's description.
  const photos = input.resolved.filter((item) => item.action.type === 'photo');
  const mainPhoto = photos.reduce<ResolvedElement | null>(
    (largest, item) => (!largest || item.element.box.w * item.element.box.h > largest.element.box.w * largest.element.box.h ? item : largest),
    null,
  );
  const changes = input.resolved
    .map((item) => cloneChangeLine(item, input.identity, headline, item === mainPhoto))
    .filter((line): line is string => line !== null);

  const colors = cloneAccentColors(input.brandColors);
  const hasLogo = input.resolved.some((item) => item.action.type === 'logo');
  const correction = input.correction?.trim() || null;

  return [
    'Recreate the attached poster exactly. Keep its layout and composition, typography (typeface style, weight, size, colour, case and alignment), spacing, shapes, icons, buttons, backgrounds and effects, so the result reads as the same poster.',
    `Output frame: ${input.orientation}, the same shape as the attached poster. Do not crop, stretch or rearrange it.`,
    changes.length > 0
      ? [
          `Change only these ${changes.length === 1 ? 'thing' : `${changes.length} things`}:`,
          ...changes.map((line, index) => `${index + 1}. ${line}`),
        ].join('\n')
      : 'Change nothing: reproduce every element as it is.',
    changes.length > 0
      ? [
          'Replaced text keeps the style of the text it replaces: typeface, weight, size, colour, case, alignment and line arrangement. Longer text may wrap or get smaller, but stays inside the area of the text it replaces.',
          'Erased elements leave clean background that matches their surroundings. An icon, bullet, label or divider that only served an erased element goes with it. If a bar, pill, card, button or badge is left with nothing in it, remove that shape as well, or let the content beside it close up, so no empty shapes or orphaned icons remain.',
          hasLogo ? "The space left for the client's logo stays clean and empty: no text, shape or picture may move into it." : null,
          'Everything not listed stays exactly as it is.',
        ]
          .filter((line): line is string => line !== null)
          .join(' ')
      : null,
    colors.length > 0
      ? `Colours: recolour only the design's accent colours (shapes, bars, buttons, icons and highlighted words) to this palette: ${colors
          .map((color) => `${color.role} ${color.hex}`)
          .join(', ')}. Keep the lightness of every area: dark areas and backgrounds stay dark, light ones stay light. Keep photographs natural and every text clearly readable against its background.`
      : 'Colours: keep every colour exactly as in the original.',
    'Do not add any new text, logos, badges, QR codes or watermarks. Spell every provided text exactly as written.',
    correction,
  ]
    .filter((part): part is string => part !== null)
    .join('\n\n');
}

/** Contact details that templates print beside an icon of their own. */
const CONTACT_DETAIL_KINDS: ReadonlySet<TemplateElementKind> = new Set(['phone', 'website', 'email', 'address', 'social']);

function cloneChangeLine(
  item: ResolvedElement,
  identity: 'ai' | 'code',
  headline: string | null,
  mainPhoto: boolean,
): string | null {
  const { element, action } = item;
  const where = describeBoxPosition(element.box);
  const shows = element.description ? `, ${element.description}` : '';
  const quoted = element.text ? `"${element.text}"` : 'the text';

  switch (action.type) {
    case 'keep':
      return null;
    case 'replace':
      if (identity === 'code' && isCodeDrawnIdentity(element.kind)) {
        return `${item.label} (${where}): erase ${quoted} and leave its space empty, keeping any bar, button or shape behind it.`;
      }
      return `${item.label} (${where}): replace ${quoted} with "${action.text}".`;
    case 'remove':
      if (element.kind === 'photo') {
        return `${item.label} (${where}${shows}): erase this photograph and fill its space naturally with the surrounding background.`;
      }
      if (element.kind === 'logo') {
        return `${item.label} (${where}${shows}): remove this logo completely and leave clean background.`;
      }
      // A contact detail usually sits beside its own icon (a map pin, a phone, a
      // globe); the end-to-end run left the pin behind with nothing after it.
      if (CONTACT_DETAIL_KINDS.has(element.kind)) {
        return `${item.label} (${where}): erase ${quoted} together with its icon, such as a map pin, phone or globe symbol, and close the space naturally.`;
      }
      return `${item.label} (${where}): erase ${quoted} and close the space naturally.`;
    case 'logo':
      if (action.name) {
        return `${item.label} (${where}${shows}): remove this logo and all of its lettering, keeping the badge or pill shape behind it. At the left end of the badge, leave a square as tall as the badge as clean, empty background; the client's logo is placed there afterwards. Write "${action.name}" in the rest of the badge, in the style of the original lettering.`;
      }
      return `${item.label} (${where}${shows}): remove this logo mark completely and leave its area as clean, empty background matching its surroundings; the client's logo is placed there afterwards.`;
    case 'photo': {
      const subject =
        action.prompt && mainPhoto
          ? `one of ${action.prompt}`
          : `realistic one suited to ${headline ? `the headline "${headline}"` : "the poster's message"}`;
      return `${item.label} (${where}${shows}): replace this photograph with a new ${subject}. ${PHOTO_RULE}`;
    }
  }
}

/**
 * What every replaced photograph must do.
 *
 * Measured in the Phase 0 spike (2026-09-17): "a new, different photograph …
 * never the same people" left the template's doctor recognisably in place on
 * three of four renders — the edit endpoint holds on to faces it is given — and
 * kept a urology wall chart and a logo printed on a coat. The rule therefore names
 * what "different" means for a person, and forbids the old photograph's own words
 * and marks, which belong to the template's business. It says "even in a small
 * cut-out portrait" because the urology template kept its doctor in the inset
 * portrait as well as in the main photograph (variant D).
 *
 * The Phase 2 end-to-end run (2026-09-17) changed the inset doctor but still kept
 * the main photograph's doctor face for face: asking to "keep its crop" let the
 * model retouch the old people in place. The rule now calls the photograph a new
 * shoot, re-casts every person as a different gender or a clearly different age,
 * and keeps only the photograph's place, framing and light — not its people.
 */
const PHOTO_RULE =
  'This is a new photo shoot, not a retouch: re-cast every person with a clearly different person (a different gender or a clearly different age, a different face, hairstyle and clothing), so nobody from the original is recognisable, even in a small cut-out portrait. Keep no logo, sign or printed words from the old photograph. Keep only its position, framing, lighting and colour treatment.';

/**
 * Where a box sits, in words an image model can use: "top left", "bottom centre",
 * "across the top". Thirds of the poster, by the box's centre; a box spanning most
 * of the width is "across" its band instead.
 */
export function describeBoxPosition(box: ElementBox): string {
  const centreX = box.x + box.w / 2;
  const centreY = box.y + box.h / 2;
  const band = centreY < 1 / 3 ? 'top' : centreY > 2 / 3 ? 'bottom' : 'middle';
  if (box.w >= 0.8) return `across the ${band}`;
  const side = centreX < 1 / 3 ? 'left' : centreX > 2 / 3 ? 'right' : 'centre';
  if (band === 'middle') return side === 'centre' ? 'centre' : `middle ${side}`;
  return `${band} ${side}`;
}

/**
 * How Generate treats an attached reference poster: visual inspiration, never a
 * template to trace and never a source of identity. The reference usually
 * belongs to someone else's brand, so its logo, name and contact details are
 * named explicitly as things to ignore — and not to replace with invented ones.
 */
function referenceSection(hasBrand: boolean): string {
  return [
    'Reference image:',
    'The attached image is visual inspiration only — a guide to visual language, not a poster to copy. Take from it the overall style: the composition approach, visual hierarchy, colour and lighting treatment, typographic feel and level of finish.',
    'Design a new poster for the brief above, with new imagery, the wording from the brief, and a composition adapted to the output frame. Do not reproduce the reference or rebuild its layout element for element, and do not copy its wording, people or products.',
    'Ignore the reference’s own identity entirely: its logos, brand or company names, taglines, contact details, QR codes, badges and seals. Do not copy them and do not replace them with invented ones.',
    hasBrand
      ? 'Where the reference’s colours or typography conflict with the brand guidelines below, follow the brand guidelines.'
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/**
 * The admin's own instruction for this template, placed straight after the
 * generic reference guidance so it can override it — "keep the curved footer"
 * is a deliberate request to rebuild part of the layout, which that guidance
 * otherwise discourages. The identity band and branding rules still follow it
 * and still apply.
 */
function templatePromptSection(templatePrompt: string): string {
  return [
    'Template instructions from the admin, for the attached reference:',
    templatePrompt,
    'Follow these instructions. Where they conflict with the reference guidance above, these instructions win.',
  ].join('\n');
}

/**
 * The reserved identity band, for prompts whose poster gets the deterministic
 * Brand Canvas overlay. The percentage comes from `identityBandFraction`, the
 * same figure the compositor draws with.
 */
function identitySection(fraction: number): string {
  const percent = Math.round(fraction * 100);
  return [
    `Identity band: the bottom ${percent}% of the image will be covered afterwards by an exact brand identity footer (logo, company name and contact details). Keep that strip free of text, faces, products and important detail — let the background simply continue behind it.`,
    'Do not write the brand name, tagline, phone number, web address or social media handle anywhere in the image. Exact brand identity is added separately.',
  ].join('\n');
}

/**
 * The rule against model-drawn identity, shared by every mode.
 *
 * Aimed at what *reads as* branding — a live BrightSmile generation put a tooth
 * pictogram in a circular tile in the top corner, exactly where a logo sits —
 * without banning the ordinary icons and illustrations a poster legitimately
 * uses. `source` adds a clause for Variation, whose attached artwork may already
 * carry such a mark from an earlier generation.
 */
function noInventedBrandingSection(
  mode: 'create' | 'edit',
  identityOverlay: boolean,
  source?: 'source',
): string {
  const lines = [
    mode === 'edit'
      ? 'No invented branding: do not add logos, logo-like marks, monograms, emblems, crests, badges, seals, stamps, certification or award marks, watermarks, QR codes or barcodes, and do not add company, brand or business names unless the change above asks for them.'
      : identityOverlay
        ? 'No invented branding: do not create logos, logo-like marks, monograms, emblems, crests, badges, seals, stamps, certification or award marks, watermarks, QR codes or barcodes, and do not invent company, brand or business names.'
        : 'No invented branding: do not create logos, logo-like marks, monograms, emblems, crests, badges, seals, stamps, certification or award marks, watermarks, QR codes or barcodes, and do not invent company, brand or business names — use only names given above.',
    'That includes a symbol set on its own in a circle, shield or rounded tile in a corner or header where a logo would sit, a stand-alone emblem of the business’s subject (such as a tooth for a dental clinic) placed by itself in a corner or along an edge, and stylised lettering that reads as a made-up wordmark. Where a logo would normally go, leave clean background — no placeholder.',
  ];
  if (source) {
    lines.push('If the source artwork contains a logo, a brand name, a badge, a seal or a logo-like mark, do not carry it over.');
  }
  if (identityOverlay) {
    lines.push(
      "The client's exact logo, company name, tagline, website and phone number are added deterministically after generation, so the artwork must not contain its own version of any of them.",
    );
  }
  lines.push(
    'Ordinary illustrations, pictograms and decorative icons that belong to the scene or explain the message are fine, as long as they do not look like a brand mark.',
  );
  return lines.join('\n');
}

function formatSection(aspectRatio: StudioAspectRatio): string {
  const format = STUDIO_ASPECT_RATIOS[aspectRatio];
  return `Format: ${format.orientation} poster. Compose for this frame and keep important content clear of the edges.`;
}

/**
 * Brand Canvas guidance for the image model.
 *
 * `deterministicIdentity` is set when the identity overlay will draw the exact
 * brand name and tagline afterwards. The name and tagline are then given as
 * context for the visual direction and the model is told not to write them — a
 * second, model-drawn copy of the name beside the exact one would be wrong in
 * every way that matters. Without the overlay the guidance is unchanged.
 */
function brandSection(
  brand: StudioBrandContext,
  intent: 'apply' | 'preserve',
  deterministicIdentity = false,
): string {
  const lines = [
    intent === 'apply'
      ? 'Brand guidelines — design within these:'
      : 'Brand guidelines — the variation must stay consistent with these:',
    deterministicIdentity
      ? `- Brand: ${brand.companyName} (context for the visual direction only — do not write the brand name in the image)`
      : `- Brand name: ${brand.companyName} (spell it exactly like this wherever it appears)`,
  ];

  if (brand.industry) lines.push(`- Industry: ${brand.industry}`);
  if (brand.tagline) {
    lines.push(
      deterministicIdentity
        ? `- Brand message: "${brand.tagline}" (context only — do not write it in the image)`
        : `- Tagline: "${brand.tagline}" (use it verbatim, and only if the design includes a tagline)`,
    );
  }
  if (brand.colors.length > 0) {
    lines.push(`- Colours: ${brand.colors.map((color) => `${color.role} ${color.hex}`).join(', ')}`);
  }
  if (brand.typography) {
    const { headingFont, bodyFont, vibe } = brand.typography;
    lines.push(`- Typography: headings in the style of ${headingFont}, body text in the style of ${bodyFont}`);
    if (vibe) lines.push(`- Overall feel: ${vibe}`);
  }
  if (brand.layoutDirectives.length > 0) {
    lines.push('- Layout rules:');
    for (const directive of brand.layoutDirectives) lines.push(`  - ${directive}`);
  }

  return lines.join('\n');
}

/**
 * Variation's own text rule. A variation's copy comes from the source artwork
 * rather than a typed brief. The *words* carry the campaign's message and are
 * kept; how they are set is part of the redesign, so the rule says so here too.
 */
function variationTextSection(textFree: boolean): string {
  return textFree
    ? textSection(true)
    : 'Text: carry over the campaign’s key wording from the source artwork — the headline and key facts such as an offer or a date — or use wording from the direction, correctly spelled and clearly legible. Give it a new typographic treatment, scale and position. Do not add placeholder copy or invented phone numbers, addresses or web addresses.';
}

function textSection(textFree: boolean): string {
  return textFree
    ? 'Text: none. Do not render any letters, words, numbers, logos or watermarks. Leave clear, uncluttered space where a headline and a logo can be added later.'
    : 'Text: render any wording from the brief exactly as written, correctly spelled and clearly legible. Do not add extra text, placeholder copy, or invented phone numbers, addresses or web addresses.';
}
