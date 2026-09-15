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
 *   VARIATION  the direction, plus what identity must survive it
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
  /** Ask for artwork with no lettering. Nothing is composited afterwards by the studio. */
  textFree: boolean;
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

  if (input.brand) sections.push(brandSection(input.brand, 'apply'));
  sections.push(textSection(input.textFree));

  return sections.join('\n\n');
}

export function buildEditPrompt(input: EditPromptInput): string {
  return [
    'Edit the attached image. Make only this change:',
    input.instruction.trim(),
    'Keep everything else as it is — composition, subject, colours, lighting, typography and all existing text, spelled exactly as it appears — unless the change above requires otherwise. Do not redraw or restyle the rest of the image.',
    `Output frame: ${STUDIO_ASPECT_RATIOS[input.aspectRatio].orientation}. If the attached image has a different shape, extend or crop its background naturally; never stretch or distort it.`,
    input.textFree ? 'Do not add any new text, letters, numbers or logos.' : null,
  ]
    .filter((part): part is string => part !== null)
    .join('\n\n');
}

export function buildVariationPrompt(input: VariationPromptInput): string {
  const sections = [
    'Create a new variation of the attached poster.',
    `Direction:\n${input.direction.trim()}`,
    'Keep its visual identity: the same brand, colour palette, typographic style, mood and level of polish. Keep its brand name and existing wording exactly as written unless the direction says to change them. Change the layout, composition, imagery or styling as the direction describes, so the result is a distinct design rather than a copy.',
    formatSection(input.aspectRatio),
  ];

  if (input.brand) sections.push(brandSection(input.brand, 'preserve'));
  if (input.textFree) sections.push(textSection(true));

  return sections.join('\n\n');
}

function formatSection(aspectRatio: StudioAspectRatio): string {
  const format = STUDIO_ASPECT_RATIOS[aspectRatio];
  return `Format: ${format.orientation} poster. Compose for this frame and keep important content clear of the edges.`;
}

function brandSection(brand: StudioBrandContext, intent: 'apply' | 'preserve'): string {
  const lines = [
    intent === 'apply'
      ? 'Brand guidelines — design within these:'
      : 'Brand guidelines — the variation must stay consistent with these:',
    `- Brand name: ${brand.companyName} (spell it exactly like this wherever it appears)`,
  ];

  if (brand.industry) lines.push(`- Industry: ${brand.industry}`);
  if (brand.tagline) {
    lines.push(`- Tagline: "${brand.tagline}" (use it verbatim, and only if the design includes a tagline)`);
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

function textSection(textFree: boolean): string {
  return textFree
    ? 'Text: none. Do not render any letters, words, numbers, logos or watermarks. Leave clear, uncluttered space where a headline and a logo can be added later.'
    : 'Text: render any wording from the brief exactly as written, correctly spelled and clearly legible. Do not add extra text, placeholder copy, or invented phone numbers, addresses or web addresses.';
}
