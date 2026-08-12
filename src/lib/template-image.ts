import sharp from 'sharp';

import { readImageDimensions } from '@/lib/poster/image-info';

/**
 * Downscales an uploaded reference poster before it is stored.
 *
 * A reference is only ever looked at: shown in the vertical's gallery at a few
 * hundred pixels, and opened full-size occasionally to decide which layout it
 * represents. It is never composited into a poster — satori builds those from
 * code — so nothing downstream can use the extra resolution.
 *
 * Keeping originals is therefore pure cost, and at the scale this library is
 * meant to reach the cost is not small: a hundred templates across ten verticals
 * at the 6 MB ceiling is roughly 6 GB, against about 350 MB downscaled. That is
 * the difference between a fifth of a Workspace plan's storage and a rounding
 * error.
 *
 * **Best-effort by design.** A file sharp cannot decode is stored exactly as it
 * arrived rather than rejected. The upload already validated the MIME type; a
 * decode failure past that point is a malformed-but-viewable image or a sharp
 * install problem, and neither is a good reason to refuse an operator's file. The
 * same reasoning as `readImageDimensions`, which degrades to a missing size badge.
 *
 * See the lockfile trap documented at the top of `src/lib/poster/logo-key.ts` —
 * sharp's native addon is platform-specific and this repo's lockfile is generated
 * on Windows.
 */

/**
 * Long edge a stored reference is reduced to.
 *
 * Comfortably above the ~640px the gallery renders and the ~1024px a full-size
 * look needs, and comfortably below anything that would make the file large again.
 */
export const TEMPLATE_LONG_EDGE = 1600;

/** WebP quality. At 80 the artefacts are invisible at gallery scale. */
const TEMPLATE_QUALITY = 80;

export interface StoredTemplateImage {
  body: Buffer;
  mimeType: string;
  width: number | null;
  height: number | null;
  /** False when the original was returned untouched. */
  downscaled: boolean;
}

export async function prepareTemplateImage(
  bytes: Buffer,
  mimeType: string,
): Promise<StoredTemplateImage> {
  try {
    const body = await sharp(bytes)
      .rotate() // Honour EXIF orientation before discarding the metadata.
      .resize({
        width: TEMPLATE_LONG_EDGE,
        height: TEMPLATE_LONG_EDGE,
        fit: 'inside',
        // A reference smaller than the ceiling is left at its own size —
        // upscaling would add bytes and no detail.
        withoutEnlargement: true,
      })
      .webp({ quality: TEMPLATE_QUALITY })
      .toBuffer();

    // Measured from the encoded result rather than predicted from the resize
    // arguments, so the stored dimensions describe the stored file.
    const dimensions = readImageDimensions(body);

    return {
      body,
      mimeType: 'image/webp',
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      downscaled: true,
    };
  } catch (error) {
    console.warn(
      '[ace:template] could not downscale, storing the original:',
      error instanceof Error ? error.message : error,
    );
    const dimensions = readImageDimensions(bytes);
    return {
      body: bytes,
      mimeType,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      downscaled: false,
    };
  }
}

/**
 * Gallery-sized copy of a stored reference, made on the way out to the browser.
 *
 * The stored file is 1600px so it can be opened and looked at properly; a card
 * in a grid of twenty-four shows it at a few hundred. Serving the stored bytes
 * to every card is roughly 7 MB a page against under 1 MB resized, and the
 * proxy route pays a Drive round-trip for each one regardless — the resize is
 * the cheap part of that request.
 *
 * Same best-effort contract as `prepareTemplateImage`: anything sharp cannot
 * handle comes back as the original bytes and their own MIME type, because a
 * heavier thumbnail is better than a broken one.
 */
export async function templateThumbnail(
  bytes: Buffer,
  mimeType: string,
  width = 640,
): Promise<{ body: Buffer; mimeType: string }> {
  try {
    const body = await sharp(bytes)
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: THUMBNAIL_QUALITY })
      .toBuffer();
    return { body, mimeType: 'image/webp' };
  } catch (error) {
    console.warn(
      '[ace:template] could not resize for the gallery, serving as stored:',
      error instanceof Error ? error.message : error,
    );
    return { body: bytes, mimeType };
  }
}

/** Lower than the stored quality — this is a thumbnail nobody inspects. */
const THUMBNAIL_QUALITY = 70;

/** Swaps an uploaded filename's extension for the stored format's. */
export function templateFileName(original: string, mimeType: string): string {
  const base = original.replace(/\.[^.]+$/, '') || 'template';
  const extension = mimeType === 'image/webp' ? 'webp' : (mimeType.split('/')[1] ?? 'png');
  return `${base}.${extension}`;
}
