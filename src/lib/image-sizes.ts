/**
 * The output-size catalogue offered per client.
 *
 * One preset is chosen at onboarding and stored on `Client.imageSizePreset`, so
 * a construction client posting to WhatsApp Status and an agency client posting
 * to a LinkedIn feed get correctly-shaped creatives from the same pipeline.
 *
 * Two sizes exist in this system and they are not the same thing:
 *
 *   1. The **output canvas** — the composite the client receives, rasterised at
 *      the preset's exact pixel size by src/lib/poster/render.tsx. That is what a
 *      preset describes and what an operator picks.
 *   2. The **background photo** — the diffusion request. Its size and aspect come
 *      from the archetype, not from the preset, because each archetype gives the
 *      photo a differently-shaped region. That decision lives in
 *      src/lib/poster/photo-request.ts, which consumes the render limits below.
 *
 * So a preset never bounds the delivered file: a 4K canvas is delivered at 4K
 * with vector-sharp type over a photo Flux rendered at its own ceiling. Only the
 * photograph softens — see `photoIsUpscaledAt`.
 *
 * Deliberately free of `process.env` and Node built-ins: the picker is a client
 * component, and this catalogue is the data it renders from.
 */

// ---------------------------------------------------------------------------
// fal.ai render limits
// ---------------------------------------------------------------------------

/** Longest edge Flux will accept on fal before it degrades or rejects. */
export const FAL_MAX_EDGE = 2048;
/** Flux requires each dimension to be a multiple of this. */
export const FAL_DIMENSION_STEP = 16;
/** Never ask for a render smaller than this on the short edge. */
export const FAL_MIN_EDGE = 512;

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export const IMAGE_SIZE_GROUPS = [
  'whatsapp',
  'instagram',
  'facebook',
  'linkedin',
  'social',
  'mobile',
  'tablet',
  'desktop',
  'print',
] as const;

export type ImageSizeGroup = (typeof IMAGE_SIZE_GROUPS)[number];

export const IMAGE_SIZE_GROUP_LABELS: Record<ImageSizeGroup, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  social: 'Other social',
  mobile: 'Mobile wallpaper',
  tablet: 'Tablet wallpaper',
  desktop: 'Laptop / desktop wallpaper',
  print: 'Print',
};

export interface ImageSizePreset {
  /** Stable identifier persisted on the client row. Never renamed. */
  id: string;
  label: string;
  group: ImageSizeGroup;
  /** Delivered canvas, in pixels. */
  width: number;
  height: number;
  /** Human-readable aspect, e.g. "9:16". Display only. */
  ratio: string;
  /**
   * True where the style spec calls the shape off-brand — every reference
   * poster in the Evokz manual set is portrait (docs/creative-style-spec.md §1:
   * "A square render is immediately off-brand"). Not blocked, just marked.
   */
  offBrand?: boolean;
  note?: string;
}

/**
 * Ordered for the picker: delivery channel first, then the social feeds an
 * operator reaches for most, then wallpapers, then print.
 */
export const IMAGE_SIZE_PRESETS: readonly ImageSizePreset[] = [
  // ---- WhatsApp — the actual delivery channel ------------------------------
  {
    id: 'whatsapp-status',
    label: 'WhatsApp Status',
    group: 'whatsapp',
    width: 1080,
    height: 1920,
    ratio: '9:16',
    note: 'Matches the creative style spec exactly. Recommended default.',
  },
  {
    id: 'whatsapp-chat',
    label: 'WhatsApp chat image',
    group: 'whatsapp',
    width: 1080,
    height: 1440,
    ratio: '3:4',
    note: 'WhatsApp recompresses in-chat images; 3:4 survives it best.',
  },

  // ---- Instagram -----------------------------------------------------------
  {
    id: 'instagram-story',
    label: 'Story / Reel cover',
    group: 'instagram',
    width: 1080,
    height: 1920,
    ratio: '9:16',
  },
  {
    id: 'instagram-portrait',
    label: 'Feed portrait',
    group: 'instagram',
    width: 1080,
    height: 1350,
    ratio: '4:5',
    note: 'Most feed real estate of any Instagram shape.',
  },
  {
    id: 'instagram-square',
    label: 'Feed square',
    group: 'instagram',
    width: 1080,
    height: 1080,
    ratio: '1:1',
    offBrand: true,
  },
  {
    id: 'instagram-landscape',
    label: 'Feed landscape',
    group: 'instagram',
    width: 1080,
    height: 566,
    ratio: '1.91:1',
    offBrand: true,
  },

  // ---- Facebook ------------------------------------------------------------
  {
    id: 'facebook-story',
    label: 'Story / Reel cover',
    group: 'facebook',
    width: 1080,
    height: 1920,
    ratio: '9:16',
  },
  {
    id: 'facebook-portrait',
    label: 'Feed portrait',
    group: 'facebook',
    width: 1080,
    height: 1350,
    ratio: '4:5',
  },
  {
    id: 'facebook-square',
    label: 'Feed square',
    group: 'facebook',
    width: 1080,
    height: 1080,
    ratio: '1:1',
    offBrand: true,
  },
  {
    id: 'facebook-link',
    label: 'Shared link / OG image',
    group: 'facebook',
    width: 1200,
    height: 630,
    ratio: '1.91:1',
    offBrand: true,
  },
  {
    id: 'facebook-cover',
    label: 'Page cover',
    group: 'facebook',
    width: 1640,
    height: 856,
    ratio: '1.91:1',
    offBrand: true,
  },

  // ---- LinkedIn ------------------------------------------------------------
  {
    id: 'linkedin-portrait',
    label: 'Feed portrait',
    group: 'linkedin',
    width: 1080,
    height: 1350,
    ratio: '4:5',
    note: 'Best organic reach of the LinkedIn feed shapes.',
  },
  {
    id: 'linkedin-square',
    label: 'Feed square',
    group: 'linkedin',
    width: 1200,
    height: 1200,
    ratio: '1:1',
    offBrand: true,
    note: 'LinkedIn renders feed images at 1200 px wide.',
  },
  {
    id: 'linkedin-landscape',
    label: 'Feed landscape',
    group: 'linkedin',
    width: 1200,
    height: 627,
    ratio: '1.91:1',
    offBrand: true,
  },
  // `linkedin-banner` (1128×191, 5.9:1) is deliberately RETIRED, not merely
  // flagged off-brand.
  //
  // At that aspect the photo layer cover-fits its source into a strip roughly a
  // sixth of the image's own height, and satori's nested overflow-mask chain
  // over the result makes resvg's `IntRect::from_ltrb(..).unwrap()` return None
  // — a Rust panic that ABORTS THE NODE PROCESS. It cannot be caught by the
  // pipeline's try/catch, so a single client on this preset would kill an entire
  // cron sweep and leave every row in it PENDING with no error to debug from.
  //
  // Retiring the id rather than repairing the layout is the honest fix: the
  // style spec already records that the slot skeleton does not fit at 5.9:1, so
  // even a rendering poster would be unusable. `resolveImageSizePreset` falls
  // back when it meets an unknown id, so any client already stored on this
  // preset silently heals onto the fleet default — no migration needed.

  // ---- Other social --------------------------------------------------------
  {
    id: 'x-post',
    label: 'X / Twitter post',
    group: 'social',
    width: 1600,
    height: 900,
    ratio: '16:9',
    offBrand: true,
  },
  {
    id: 'youtube-thumbnail',
    label: 'YouTube thumbnail',
    group: 'social',
    width: 1280,
    height: 720,
    ratio: '16:9',
    offBrand: true,
  },
  {
    id: 'pinterest-pin',
    label: 'Pinterest pin',
    group: 'social',
    width: 1000,
    height: 1500,
    ratio: '2:3',
  },

  // ---- Mobile wallpaper ----------------------------------------------------
  {
    id: 'mobile-fhd',
    label: 'Phone FHD',
    group: 'mobile',
    width: 1080,
    height: 1920,
    ratio: '9:16',
  },
  {
    id: 'mobile-tall',
    label: 'Phone tall (iPhone Pro class)',
    group: 'mobile',
    width: 1170,
    height: 2532,
    ratio: '9:19.5',
  },
  {
    id: 'mobile-qhd',
    label: 'Phone QHD+ (Android flagship)',
    group: 'mobile',
    width: 1440,
    height: 3120,
    ratio: '9:20',
  },

  // ---- Tablet wallpaper ----------------------------------------------------
  {
    id: 'tablet-portrait',
    label: 'Tablet portrait (iPad 11")',
    group: 'tablet',
    width: 1640,
    height: 2360,
    ratio: '~3:4',
  },
  {
    id: 'tablet-pro-portrait',
    label: 'Tablet portrait (iPad Pro 13")',
    group: 'tablet',
    width: 2048,
    height: 2732,
    ratio: '3:4',
  },
  {
    id: 'tablet-landscape',
    label: 'Tablet landscape',
    group: 'tablet',
    width: 2732,
    height: 2048,
    ratio: '4:3',
    offBrand: true,
  },

  // ---- Laptop / desktop wallpaper -----------------------------------------
  {
    id: 'laptop-fhd',
    label: 'Laptop FHD',
    group: 'desktop',
    width: 1920,
    height: 1080,
    ratio: '16:9',
    offBrand: true,
  },
  {
    id: 'laptop-16-10',
    label: 'Laptop 16:10 (MacBook Air)',
    group: 'desktop',
    width: 1920,
    height: 1200,
    ratio: '16:10',
    offBrand: true,
  },
  {
    id: 'laptop-retina',
    label: 'Laptop Retina 16:10',
    group: 'desktop',
    width: 2560,
    height: 1600,
    ratio: '16:10',
    offBrand: true,
  },
  {
    id: 'desktop-qhd',
    label: 'Desktop QHD',
    group: 'desktop',
    width: 2560,
    height: 1440,
    ratio: '16:9',
    offBrand: true,
  },
  {
    id: 'desktop-4k',
    label: 'Desktop 4K UHD',
    group: 'desktop',
    width: 3840,
    height: 2160,
    ratio: '16:9',
    offBrand: true,
  },
  {
    id: 'desktop-ultrawide',
    label: 'Ultrawide',
    group: 'desktop',
    width: 3440,
    height: 1440,
    ratio: '21:9',
    offBrand: true,
  },

  // ---- Print ---------------------------------------------------------------
  {
    id: 'print-a4-portrait',
    label: 'A4 portrait @300dpi',
    group: 'print',
    width: 2480,
    height: 3508,
    ratio: '1:√2',
  },
  {
    id: 'print-a4-landscape',
    label: 'A4 landscape @300dpi',
    group: 'print',
    width: 3508,
    height: 2480,
    ratio: '√2:1',
    offBrand: true,
  },
] as const;

/**
 * WhatsApp Status. The delivery channel is WhatsApp and the style spec is 9:16,
 * so this is the only default that is right by construction.
 */
export const DEFAULT_IMAGE_SIZE_ID = 'whatsapp-status';

const PRESETS_BY_ID = new Map(IMAGE_SIZE_PRESETS.map((preset) => [preset.id, preset]));

export function getImageSizePreset(id: string | null | undefined): ImageSizePreset | null {
  if (!id) return null;
  return PRESETS_BY_ID.get(id) ?? null;
}

export function isImageSizePresetId(id: string): boolean {
  return PRESETS_BY_ID.has(id);
}

/** Every preset id, for schema validation. */
export function imageSizePresetIds(): string[] {
  return IMAGE_SIZE_PRESETS.map((preset) => preset.id);
}

/** Grouped in catalogue order, for a grouped `<Select>`. */
export function groupedImageSizePresets(): Array<{
  group: ImageSizeGroup;
  label: string;
  presets: ImageSizePreset[];
}> {
  return IMAGE_SIZE_GROUPS.map((group) => ({
    group,
    label: IMAGE_SIZE_GROUP_LABELS[group],
    presets: IMAGE_SIZE_PRESETS.filter((preset) => preset.group === group),
  })).filter((entry) => entry.presets.length > 0);
}

/** `1080 × 1920 · 9:16` */
export function describeImageSize(preset: ImageSizePreset): string {
  return `${preset.width} × ${preset.height} · ${preset.ratio}`;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * The preset in force for a client: its stored choice, else `fallbackId` (the
 * caller passes `FAL_IMAGE_SIZE` here, so the fleet default can move without a
 * migration), else WhatsApp Status.
 *
 * An id that is not in the catalogue resolves to the next fallback rather than
 * throwing — a preset retired from the list must not break dispatch for the
 * clients still pointing at it.
 */
export function resolveImageSizePreset(
  storedId: string | null | undefined,
  fallbackId?: string | null,
): ImageSizePreset {
  return (
    getImageSizePreset(storedId) ??
    getImageSizePreset(fallbackId) ??
    // Non-null: DEFAULT_IMAGE_SIZE_ID is a catalogue member by construction.
    PRESETS_BY_ID.get(DEFAULT_IMAGE_SIZE_ID)!
  );
}

/**
 * True when the canvas is larger than Flux can render, so the *background photo*
 * is scaled up during compositing.
 *
 * This is a softness advisory, not a size limit. The delivered file is always the
 * preset's exact pixel size — satori/resvg rasterise the composite at
 * `width`×`height`, and every text element stays vector-sharp at any canvas. Only
 * the photograph beneath them loses detail, because fal caps a render at
 * `FAL_MAX_EDGE` per side.
 *
 * Worth surfacing on the print and 4K presets, where the photo is stretched
 * ~1.7–1.9×. Not worth blocking: a slightly soft background under crisp type is
 * still a usable poster.
 */
export function photoIsUpscaledAt(preset: ImageSizePreset): boolean {
  return Math.max(preset.width, preset.height) > FAL_MAX_EDGE;
}

/**
 * How far the background photo is stretched at this canvas. 1 when the photo
 * covers it natively.
 *
 * Approximate by design: the exact factor depends on which region the archetype
 * gives the photo (see `resolvePhotoRequest`), so this reports the canvas-level
 * worst case for an operator-facing hint.
 */
export function photoUpscaleFactor(preset: ImageSizePreset): number {
  const longestEdge = Math.max(preset.width, preset.height);
  if (longestEdge <= FAL_MAX_EDGE) return 1;
  return Number((longestEdge / FAL_MAX_EDGE).toFixed(1));
}
