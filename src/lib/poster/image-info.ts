/**
 * Intrinsic image dimensions read from container headers.
 *
 * Satori needs explicit `width`/`height` on every `<img>`: without them it cannot
 * lay the element out, and with only one of them it does not derive the other.
 * That makes the intrinsic size a hard requirement for any image whose shape we
 * do not already control — an operator-uploaded logo above all.
 *
 * These read container headers rather than decoding pixels, which is all the
 * layout needs and costs nothing on a 4 MB file. That used to be the whole story:
 * the module was written to avoid `sharp` entirely, because its native binary was
 * a recurring source of deploy breakage on Vercel's serverless runtime.
 *
 * **`sharp` is now a dependency** — background-keying a logo requires real pixel
 * access, and the Vercel objection died with the move to a Docker/glibc VPS (see
 * `logo-key.ts`). These functions stay anyway: they are called on every render
 * and in the edge-adjacent paths, and spinning up libvips to read four bytes of
 * an IHDR chunk would be worse in every dimension. Only the handful of formats a
 * logo or photo realistically arrives in are supported.
 */

export interface ImageDimensions {
  width: number;
  height: number;
  mimeType: string;
}

/** Reads dimensions from PNG, JPEG, GIF or WebP bytes. Null if unrecognised. */
export function readImageDimensions(bytes: Buffer): ImageDimensions | null {
  return (
    readPng(bytes) ?? readGif(bytes) ?? readWebp(bytes) ?? readJpeg(bytes) ?? null
  );
}

// ---------------------------------------------------------------------------
// PNG — 8-byte signature, then an IHDR chunk with width/height as big-endian u32
// ---------------------------------------------------------------------------

function readPng(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 24) return null;
  if (bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) {
    return null;
  }
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null;

  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    mimeType: 'image/png',
  };
}

// ---------------------------------------------------------------------------
// GIF — "GIF87a"/"GIF89a", then width/height as little-endian u16
// ---------------------------------------------------------------------------

function readGif(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 10) return null;
  const signature = bytes.toString('ascii', 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null;

  return {
    width: bytes.readUInt16LE(6),
    height: bytes.readUInt16LE(8),
    mimeType: 'image/gif',
  };
}

// ---------------------------------------------------------------------------
// WebP — RIFF container with three different chunk layouts
// ---------------------------------------------------------------------------

function readWebp(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 30) return null;
  if (bytes.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (bytes.toString('ascii', 8, 12) !== 'WEBP') return null;

  const chunk = bytes.toString('ascii', 12, 16);

  // Lossy: VP8 bitstream, dimensions 14 bytes in, 14 significant bits each.
  if (chunk === 'VP8 ') {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
      mimeType: 'image/webp',
    };
  }

  // Lossless: 14-bit dimensions minus one, bit-packed across bytes 21–24.
  if (chunk === 'VP8L') {
    const packed = bytes.readUInt32LE(21);
    return {
      width: (packed & 0x3fff) + 1,
      height: ((packed >> 14) & 0x3fff) + 1,
      mimeType: 'image/webp',
    };
  }

  // Extended: canvas size as 24-bit minus one, little-endian.
  if (chunk === 'VP8X') {
    const width = bytes.readUIntLE(24, 3) + 1;
    const height = bytes.readUIntLE(27, 3) + 1;
    return { width, height, mimeType: 'image/webp' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// JPEG — walk the marker segments to a Start-Of-Frame
// ---------------------------------------------------------------------------

/**
 * SOF markers carrying frame dimensions. SOF0/1/2 are baseline/extended/
 * progressive; the rest are arithmetic and lossless variants that share the
 * layout. DHT (0xC4), JPG (0xC8) and DAC (0xCC) sit in the same numeric range but
 * are *not* frame headers, which is why this is an explicit set rather than a
 * range test — treating DHT as an SOF yields plausible-looking garbage
 * dimensions.
 */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function readJpeg(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 4) return null;
  if (bytes.readUInt16BE(0) !== 0xffd8) return null;

  let offset = 2;

  while (offset + 4 <= bytes.length) {
    // Segments begin 0xFF; a run of fill bytes between them is legal.
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1];
    if (marker === undefined) return null;

    // Standalone markers: no length field follows.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }

    const length = bytes.readUInt16BE(offset + 2);
    // A length under 2 cannot include its own field — the stream is corrupt, and
    // continuing would loop forever on the same offset.
    if (length < 2) return null;

    if (SOF_MARKERS.has(marker)) {
      if (offset + 9 > bytes.length) return null;
      return {
        // Frame header: [length u16][precision u8][height u16][width u16]
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
        mimeType: 'image/jpeg',
      };
    }

    offset += 2 + length;
  }

  return null;
}

// ---------------------------------------------------------------------------
// SVG — no binary header; dimensions come from the root element's attributes
// ---------------------------------------------------------------------------

/**
 * Reads an SVG's intrinsic size from `width`/`height`, falling back to the
 * `viewBox`.
 *
 * Worth handling separately because SVG is the single most likely format for a
 * logo a client hands over, and it is the one format `readImageDimensions` cannot
 * touch — there is no header to parse.
 *
 * A `viewBox`-only SVG (very common in exported logos) has no intrinsic pixel
 * size at all; its ratio is used, scaled to a nominal 512 px wide, which is enough
 * for `containFit` to derive a correct box since only the aspect ratio matters.
 */
export function readSvgDimensions(source: string): ImageDimensions | null {
  const head = source.slice(0, 2048);

  const width = parseSvgLength(/\bwidth\s*=\s*["']([^"']+)["']/.exec(head)?.[1]);
  const height = parseSvgLength(/\bheight\s*=\s*["']([^"']+)["']/.exec(head)?.[1]);

  if (width && height) {
    return { width, height, mimeType: 'image/svg+xml' };
  }

  const viewBox = /\bviewBox\s*=\s*["']([^"']+)["']/.exec(head)?.[1];
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    const [, , vbWidth, vbHeight] = parts;
    if (
      parts.length === 4 &&
      typeof vbWidth === 'number' &&
      typeof vbHeight === 'number' &&
      Number.isFinite(vbWidth) &&
      Number.isFinite(vbHeight) &&
      vbWidth > 0 &&
      vbHeight > 0
    ) {
      const NOMINAL = 512;
      return {
        width: NOMINAL,
        height: Math.round((vbHeight / vbWidth) * NOMINAL),
        mimeType: 'image/svg+xml',
      };
    }
  }

  return null;
}

/** Accepts `240`, `240px`, `240.5pt`. Rejects percentages — not a pixel size. */
function parseSvgLength(raw: string | undefined): number | null {
  if (!raw) return null;
  if (raw.includes('%')) return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

export interface Box {
  width: number;
  height: number;
}

/**
 * Largest box with the source's aspect ratio that fits inside `bounds`.
 * Used for the logo, which must never be cropped.
 */
export function containFit(source: Box, bounds: Box): Box {
  if (source.width <= 0 || source.height <= 0) return bounds;
  const ratio = Math.min(bounds.width / source.width, bounds.height / source.height);
  return {
    width: Math.round(source.width * ratio),
    height: Math.round(source.height * ratio),
  };
}

/**
 * Smallest box with the source's aspect ratio that covers `bounds`, plus the
 * offsets that centre it. Used for the photo, which is expected to bleed.
 *
 * Returned as explicit width/height/offsets rather than relying on satori's
 * `objectFit: cover`, whose behaviour differs from a browser's when the parent
 * has no intrinsic size — a common shape in these archetypes, where the photo's
 * container is itself absolutely positioned.
 */
export function coverFit(
  source: Box,
  bounds: Box,
): { width: number; height: number; left: number; top: number } {
  if (source.width <= 0 || source.height <= 0) {
    return { ...bounds, left: 0, top: 0 };
  }

  const ratio = Math.max(bounds.width / source.width, bounds.height / source.height);
  const width = Math.ceil(source.width * ratio);
  const height = Math.ceil(source.height * ratio);

  return {
    width,
    height,
    left: Math.round((bounds.width - width) / 2),
    top: Math.round((bounds.height - height) / 2),
  };
}

/**
 * Cover-fit biased toward one region of the source instead of the centre.
 *
 * Each archetype mandates where the photo's empty space must be (§5), and a
 * centre crop can throw away the very negative space the copy needs. `focusX`/
 * `focusY` are 0–1 in source space: 0.5/0.5 reproduces `coverFit`, 1/0.5 pins the
 * right edge, keeping a right-of-centre subject in frame.
 */
export function coverFitFocused(
  source: Box,
  bounds: Box,
  focusX: number,
  focusY: number,
): { width: number; height: number; left: number; top: number } {
  const fitted = coverFit(source, bounds);
  const overflowX = fitted.width - bounds.width;
  const overflowY = fitted.height - bounds.height;

  return {
    width: fitted.width,
    height: fitted.height,
    left: Math.round(-overflowX * clamp01(focusX)),
    top: Math.round(-overflowY * clamp01(focusY)),
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
