import { z } from 'zod';

/**
 * Shape of `Client.brandGuideline` (Prisma `Json?`).
 *
 * Prisma types the column as `JsonValue`, so every consumer must narrow before
 * use. `parseBrandGuideline` is the single narrowing point: it never throws, and
 * partial/legacy records degrade to empty collections rather than crashing the
 * brand canvas.
 */

export const BRAND_COLOR_ROLES = [
  'primary',
  'secondary',
  'accent',
  'background',
] as const;

export type BrandColorRole = (typeof BRAND_COLOR_ROLES)[number];

/**
 * Where a colour came from, strongest evidence first.
 *
 * Provenance is what separates a measured colour from a guessed one. The poster
 * theme engine only trusts a role label when the colour carries a non-`llm`
 * source — see `resolvePosterTheme` in `@/lib/poster/theme`.
 *
 * `llm` is never written: it is the implicit source of every record predating
 * provenance, and those parse with `source` absent. It exists so a caller can
 * say "this came from the tokenizer" explicitly without inventing a new value.
 */
export const BRAND_COLOR_SOURCES = [
  'theme-color',
  'css-var',
  'css-usage',
  'llm',
  'manual',
] as const;

export type BrandColorSource = (typeof BRAND_COLOR_SOURCES)[number];

export const brandColorSchema = z.object({
  hex: z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/),
  role: z.string().min(1),
  // Optional so every legacy record still parses. Absent means "tokenizer
  // guess", which the theme engine treats as untrusted.
  source: z.enum(BRAND_COLOR_SOURCES).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const brandTypographySchema = z.object({
  headingFont: z.string().min(1),
  bodyFont: z.string().min(1),
  vibeClassification: z.string().min(1).optional(),
});

export const brandAssetSchema = z.object({
  label: z.string().min(1),
  type: z.enum(['logo', 'website', 'image', 'document']).default('image'),
  url: z.string().min(1).optional(),
  note: z.string().optional(),
});

export const brandGuidelineSchema = z.object({
  colors: z.array(brandColorSchema).default([]),
  typography: brandTypographySchema.nullable().default(null),
  layoutDirectives: z.array(z.string()).default([]),
  assets: z.array(brandAssetSchema).default([]),
});

export type BrandColor = z.infer<typeof brandColorSchema>;
export type BrandTypography = z.infer<typeof brandTypographySchema>;
export type BrandAsset = z.infer<typeof brandAssetSchema>;
export type BrandGuideline = z.infer<typeof brandGuidelineSchema>;

export const EMPTY_BRAND_GUIDELINE: BrandGuideline = {
  colors: [],
  typography: null,
  layoutDirectives: [],
  assets: [],
};

/**
 * Narrows an untrusted `Json` column into `BrandGuideline`.
 * Unknown/partial input yields the empty guideline instead of throwing.
 */
export function parseBrandGuideline(raw: unknown): BrandGuideline {
  if (raw === null || raw === undefined) return EMPTY_BRAND_GUIDELINE;

  const source = typeof raw === 'string' ? safeJsonParse(raw) : raw;
  const result = brandGuidelineSchema.safeParse(source);

  if (result.success) return result.data;

  // Salvage whatever individual fields do parse — a malformed font block should
  // not hide a perfectly good colour palette.
  const partial =
    typeof source === 'object' && source !== null
      ? (source as Record<string, unknown>)
      : {};

  return {
    colors: z.array(brandColorSchema).safeParse(partial.colors).data ?? [],
    typography: brandTypographySchema.safeParse(partial.typography).data ?? null,
    layoutDirectives:
      z.array(z.string()).safeParse(partial.layoutDirectives).data ?? [],
    assets: z.array(brandAssetSchema).safeParse(partial.assets).data ?? [],
  };
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Human label for a colour role, e.g. `primary` -> "Primary Accent". */
export function describeColorRole(role: string): string {
  const normalized = role.trim().toLowerCase();
  switch (normalized) {
    case 'primary':
      return 'Primary Accent';
    case 'secondary':
      return 'Secondary Tone';
    case 'accent':
      return 'Highlight Accent';
    case 'background':
      return 'Surface Base';
    default:
      return role
        .trim()
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase());
  }
}
