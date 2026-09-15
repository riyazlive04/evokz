import { STUDIO_ASPECT_RATIOS, type StudioAspectRatio } from '@/lib/poster-studio/limits';

/**
 * Prompt construction for the AI Poster Studio.
 *
 * Pure functions: no model calls, no I/O. Three builders, because the three
 * modes ask the image model for different things and a shared template pushed
 * all of them towards the same one — a full redraw:
 *
 *   GENERATE   brief + format + brand + text rules (+ how to treat a reference)
 *   EDIT       the change, and an instruction to leave everything else alone
 *   VARIATION  a new layout for the same campaign: what must survive, and
 *              explicit licence to redesign everything else
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
}

export interface EditPromptInput extends CommonInput {
  instruction: string;
}

export interface VariationPromptInput extends CommonInput {
  direction: string;
  brand: StudioBrandContext | null;
}

export function buildGeneratePrompt(input: GeneratePromptInput): string {
  const sections = [
    'Design a finished, professional marketing poster.',
    `Brief:\n${input.brief.trim()}`,
    formatSection(input.aspectRatio),
  ];

  if (input.hasReference) {
    sections.push(
      [
        'Reference image:',
        'The attached image is a style and layout reference only. Follow its composition, visual hierarchy, colour treatment and typographic feel.',
        'Do not copy its wording, logos, people, products or brand marks, and do not reproduce it — design a new poster for the brief above.',
      ].join('\n'),
    );
  }

  const band = input.identityBandFraction ?? null;
  if (input.brand) sections.push(brandSection(input.brand, 'apply', band !== null));
  if (band !== null) sections.push(identitySection(band));
  sections.push(textSection(input.textFree));

  return sections.join('\n\n');
}

export function buildEditPrompt(input: EditPromptInput): string {
  const band = input.identityBandFraction ?? null;
  return [
    'Edit the attached image. Make only this change:',
    input.instruction.trim(),
    'Keep everything else as it is — composition, subject, colours, lighting, typography and all existing text, spelled exactly as it appears — unless the change above requires otherwise. Do not redraw or restyle the rest of the image.',
    `Output frame: ${STUDIO_ASPECT_RATIOS[input.aspectRatio].orientation}. If the attached image has a different shape, extend or crop its background naturally; never stretch or distort it.`,
    band !== null ? identitySection(band) : null,
    input.textFree ? 'Do not add any new text, letters, numbers or logos.' : null,
  ]
    .filter((part): part is string => part !== null)
    .join('\n\n');
}

/**
 * A new poster for the parent's campaign — not an edit of the parent.
 *
 * The attached image goes through the edit endpoint, which leans towards
 * keeping what it is given. The first version of this prompt asked to keep the
 * "typographic style" and "existing wording exactly as written" in one breath
 * and left "change the layout" as a closing clause, and in live testing the
 * model kept the whole text block in place — same position, scale and line
 * breaks — and only rearranged the imagery. So this prompt separates *what* is
 * kept (campaign, brand, quality, essential wording) from *where* it goes, and
 * spells out that position, scale, hierarchy and negative space are open.
 */
export function buildVariationPrompt(input: VariationPromptInput): string {
  const band = input.identityBandFraction ?? null;
  // With the identity band, the brand name is composited afterwards, so the
  // model is asked to keep the visual identity and the headline — not to write
  // the name itself.
  const keep = [
    '- the campaign concept and its message',
    band !== null
      ? '- the brand identity: the colour palette, the typographic character and the mood'
      : '- the brand identity: any brand name, the colour palette, the typographic character and the mood',
    '- the same level of finish and visual quality',
  ];
  if (!input.textFree) {
    keep.push(
      band !== null
        ? '- the essential wording — headline and key supporting line — spelled exactly as written, unless the direction changes it'
        : '- the essential wording — headline, key supporting line and any brand name — spelled exactly as written, unless the direction changes it',
    );
  }

  const sections = [
    'Design a new poster for the same campaign as the attached poster.',
    'The attached poster is the parent design. Use it as the campaign and brand reference, not as a layout to reuse. The result must read as a different poster from the same campaign, not as an edited copy of the parent.',
    `Direction:\n${input.direction.trim()}`,
    ['Keep from the parent:', ...keep].join('\n'),
    [
      'Redesign freely:',
      '- the overall composition and layout grid',
      '- where the text block sits, and the headline’s scale, line breaks and placement',
      '- the main imagery: what is shown, how it is arranged, angle, framing and crop',
      '- the visual hierarchy and the order in which the poster is read',
      '- the position of objects and the supporting graphic elements',
      '- the amount and placement of negative space',
    ].join('\n'),
    'Do not reuse the parent’s arrangement. Placing the text block in a different area, changing the headline scale, choosing a different dominant image and rebalancing the negative space are all expected. If the result could pass for the parent with small changes, it is not different enough.',
    formatSection(input.aspectRatio),
  ];

  if (input.brand) sections.push(brandSection(input.brand, 'preserve', band !== null));
  if (band !== null) sections.push(identitySection(band));
  sections.push(variationTextSection(input.textFree));

  return sections.join('\n\n');
}

/**
 * The reserved identity band, for prompts whose poster gets the deterministic
 * Brand Canvas overlay. The percentage comes from `identityBandFraction`, the
 * same figure the compositor draws with.
 */
function identitySection(fraction: number): string {
  const percent = Math.round(fraction * 100);
  return [
    `Identity band: the bottom ${percent}% of the image will be covered afterwards by an exact brand identity band (logo and contact details). Keep that strip free of text, faces, products and important detail — let the background simply continue behind it.`,
    'Do not draw any logo, brand name, wordmark, tagline, phone number, web address, social media handle or QR code anywhere in the image. Exact brand identity is added separately.',
  ].join('\n');
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
 * Variation's own text rule, kept apart from `textSection` so Generate's wording
 * is untouched. A variation's copy comes from the parent image rather than a typed
 * brief, and a redesign is exactly when a model invents badges and QR codes.
 */
function variationTextSection(textFree: boolean): string {
  return textFree
    ? `${textSection(true)} Do not add QR codes or badges.`
    : 'Text: use only wording that appears in the parent poster or in the direction, correctly spelled and clearly legible. Do not add logos, QR codes, watermarks, badges, placeholder copy, or invented phone numbers, addresses or web addresses.';
}

function textSection(textFree: boolean): string {
  return textFree
    ? 'Text: none. Do not render any letters, words, numbers, logos or watermarks. Leave clear, uncluttered space where a headline and a logo can be added later.'
    : 'Text: render any wording from the brief exactly as written, correctly spelled and clearly legible. Do not add extra text, placeholder copy, or invented phone numbers, addresses or web addresses.';
}
