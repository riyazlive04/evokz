import sharp from 'sharp';

import { StudioError } from '@/lib/poster-studio/errors';
import {
  MAX_STUDIO_IMAGE_BYTES,
  MAX_STUDIO_IMAGE_MB,
  STUDIO_IMAGE_MIME_TYPES,
} from '@/lib/poster-studio/limits';
import { readImageDimensions } from '@/lib/poster/image-info';

/**
 * Image handling for AI Poster Studio inputs and previews.
 *
 * See the lockfile trap documented at the top of `src/lib/poster/logo-key.ts` —
 * sharp's native addon is platform-specific.
 */

/**
 * Long edge an uploaded input image is reduced to. Matches the largest output
 * edge (`STUDIO_ASPECT_RATIOS`), so no detail the model could use is discarded.
 */
const INPUT_LONG_EDGE = 2048;

/** High enough that an edit of a poster with small type keeps its edges. */
const INPUT_QUALITY = 90;

export interface PreparedStudioImage {
  bytes: Buffer;
  mimeType: string;
  width: number | null;
  height: number | null;
}

/**
 * Validates an operator upload and normalises it before it is sent or stored.
 *
 * **Strict, unlike `prepareTemplateImage`.** A reference template that sharp
 * cannot decode is stored anyway because a human only ever looks at it; this
 * image is sent to a paid API, and a file that is not really an image should be
 * refused here with a clear message rather than billed for and refused there.
 * The decoded format is checked, not just the browser-declared MIME type.
 *
 * The output is WebP: EXIF orientation applied and then stripped (along with any
 * GPS metadata from a phone photo), and the long edge capped. OpenAI's edit
 * endpoint accepts WebP.
 */
export async function prepareStudioInputImage(
  bytes: Buffer,
  declaredMimeType: string,
  fileName: string,
): Promise<PreparedStudioImage> {
  if (bytes.length > MAX_STUDIO_IMAGE_BYTES) {
    throw new StudioError(
      'image-too-large',
      `${fileName} is ${(bytes.length / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_STUDIO_IMAGE_MB} MB.`,
    );
  }

  if (!(STUDIO_IMAGE_MIME_TYPES as readonly string[]).includes(declaredMimeType)) {
    throw new StudioError(
      'invalid-image',
      `"${fileName}" is not a supported format. Use a PNG, JPEG or WebP image.`,
    );
  }

  let format: string | undefined;
  try {
    const metadata = await sharp(bytes).metadata();
    format = metadata.format;
    if (!metadata.width || !metadata.height) format = undefined;
  } catch (error) {
    throw new StudioError(
      'invalid-image',
      `"${fileName}" could not be read as an image. It may be damaged, or not really a PNG, JPEG or WebP file.`,
      { cause: error },
    );
  }

  if (format !== 'png' && format !== 'jpeg' && format !== 'webp') {
    throw new StudioError(
      'invalid-image',
      `"${fileName}" is not a PNG, JPEG or WebP image, whatever its file name says.`,
    );
  }

  try {
    const body = await sharp(bytes)
      .rotate()
      .resize({
        width: INPUT_LONG_EDGE,
        height: INPUT_LONG_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: INPUT_QUALITY })
      .toBuffer();

    const dimensions = readImageDimensions(body);
    return {
      bytes: body,
      mimeType: 'image/webp',
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
    };
  } catch (error) {
    throw new StudioError(
      'invalid-image',
      `"${fileName}" could not be processed as an image. Try exporting it again as PNG or JPEG.`,
      { cause: error },
    );
  }
}

/**
 * Long edge of the source artwork as Variation sends it to the model.
 *
 * The edit endpoint preserves the composition of the image it is given, and at
 * full resolution no prompt wording moved it: live Variations kept the parent's
 * subject, pose, headline block and layout. A reduced preview still carries the
 * campaign's message, subject and mood — and its headline stays legible — but not
 * the pixel-level layout, and in live testing the result became a genuinely
 * different design. It also costs about a third of the image-input tokens.
 */
const VARIATION_SOURCE_LONG_EDGE = 512;

/** The reduced copy of a Variation's source that is sent to the model. The stored input is unchanged. */
export async function reduceVariationSource(image: { bytes: Buffer; mimeType: string }): Promise<{ bytes: Buffer; mimeType: string }> {
  const bytes = await sharp(image.bytes)
    .resize({ width: VARIATION_SOURCE_LONG_EDGE, height: VARIATION_SOURCE_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  return { bytes, mimeType: 'image/png' };
}

/**
 * Decoded size of an image the model returned, or null when the bytes are not
 * an image sharp can read. Decoded rather than read from the header, so a
 * truncated or corrupt response is caught before it is stored.
 */
export async function readStudioImageSize(bytes: Buffer): Promise<{ width: number; height: number } | null> {
  try {
    const { info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    return info.width > 0 && info.height > 0 ? { width: info.width, height: info.height } : null;
  } catch {
    return null;
  }
}

/**
 * Resized WebP copy of a stored studio image for the browser.
 *
 * Quality steps up with width: a history thumbnail is glanced at, the canvas
 * preview is inspected. Best-effort like `templateThumbnail` — anything sharp
 * cannot handle is served as stored.
 */
export async function studioPreview(
  bytes: Buffer,
  mimeType: string,
  width: number,
): Promise<{ body: Buffer; mimeType: string }> {
  try {
    const body = await sharp(bytes)
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: width > 640 ? 86 : 72 })
      .toBuffer();
    return { body, mimeType: 'image/webp' };
  } catch (error) {
    console.warn(
      '[studio:images] could not resize a preview, serving as stored:',
      error instanceof Error ? error.message : error,
    );
    return { body: bytes, mimeType };
  }
}
