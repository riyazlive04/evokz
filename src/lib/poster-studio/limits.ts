/**
 * AI Poster Studio bounds, shared by the server action that enforces them and
 * the workspace that renders them.
 *
 * One module for the same reason as `src/lib/template-limits.ts`: a limit that
 * lives in two places drifts, and the first version of the studio shipped exactly
 * that bug — the panel allowed 10 MB while the Server Action body limit was 8 MB,
 * so a 7 MB upload died with Next's body-size error instead of the studio's own.
 *
 * Deliberately free of Prisma, `googleapis`, `sharp` and `openai`: the workspace
 * is a client component and imports this file.
 */

/**
 * Largest input image the studio accepts, in bytes.
 *
 * Matches `MAX_TEMPLATE_BYTES`, and for the same reason: comfortably under the
 * 8 MB Server Action `bodySizeLimit` in next.config.mjs once the other form
 * fields and multipart framing are added. The image travels as a binary
 * `FormData` part, not a base64 string, so there is no 33% inflation to budget
 * for. Raising this means raising the body limit too — do not do one alone.
 */
export const MAX_STUDIO_IMAGE_BYTES = 6 * 1024 * 1024;

export const MAX_STUDIO_IMAGE_MB = MAX_STUDIO_IMAGE_BYTES / 1024 / 1024;

/** Raster formats both sharp and the OpenAI image edit endpoint accept. */
export const STUDIO_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** Operator-typed prompt bounds. The model allows 32,000 characters; the rest is ours. */
export const MIN_STUDIO_PROMPT_LENGTH = 3;
export const MAX_STUDIO_PROMPT_LENGTH = 4_000;

export const STUDIO_MODES = ['GENERATE', 'EDIT', 'VARIATION'] as const;
export type StudioMode = (typeof STUDIO_MODES)[number];

/**
 * Output formats, keyed by aspect ratio.
 *
 * The first version sent `1024x1792` / `1792x1024` — DALL·E 3's sizes, which are
 * 4:7, not 9:16. gpt-image-2 takes an arbitrary `WIDTHxHEIGHT` when both edges
 * are divisible by 16 and the ratio is within 1:3–3:1, with sizes above
 * 2560x1440 marked experimental (see `ImageGenerateParamsBase.size` in the
 * installed `openai` SDK). These are exact ratios that satisfy all of that:
 *
 *   1152x2048 — 72·16 × 128·16, exactly 9:16, downsamples cleanly to 1080x1920
 *   1024x1024 — the standard square size every GPT image model supports
 *   2048x1152 — the 9:16 frame rotated
 *
 * These sizes are only valid for gpt-image-2; `gpt-image-1`/`1.5` accept only
 * the three standard sizes. The model is pinned in `openai-images.ts` for that
 * reason.
 */
export const STUDIO_ASPECT_RATIOS = {
  '9:16': { label: '9:16 Story', hint: 'Vertical', size: '1152x2048', orientation: 'vertical 9:16' },
  '1:1': { label: '1:1 Square', hint: 'Feed post', size: '1024x1024', orientation: 'square 1:1' },
  '16:9': { label: '16:9 Banner', hint: 'Landscape', size: '2048x1152', orientation: 'horizontal 16:9' },
} as const;

export type StudioAspectRatio = keyof typeof STUDIO_ASPECT_RATIOS;

export const STUDIO_ASPECT_RATIO_KEYS = Object.keys(STUDIO_ASPECT_RATIOS) as StudioAspectRatio[];

/** Where the input image for a request comes from. */
export const STUDIO_SOURCE_KINDS = [
  /** No input image. Only valid for GENERATE. */
  'none',
  /** A file in the request's `image` form field. */
  'upload',
  /** The output image of an existing generation. */
  'generation-output',
  /** The input image stored on an existing generation — reuses an earlier upload. */
  'generation-reference',
] as const;

export type StudioSourceKind = (typeof STUDIO_SOURCE_KINDS)[number];

/** Browser-facing URL for a stored studio image. Served by the admin-gated proxy route. */
export function studioImageUrl(
  generationId: string,
  options: { variant?: 'output' | 'reference'; width?: number; download?: boolean } = {},
): string {
  const params = new URLSearchParams();
  if (options.variant === 'reference') params.set('variant', 'reference');
  if (options.download) {
    params.set('full', '1');
    params.set('download', '1');
  } else if (options.width) {
    params.set('w', String(options.width));
  }
  const query = params.toString();
  return `/api/poster-studio/${encodeURIComponent(generationId)}/image${query ? `?${query}` : ''}`;
}
