import { deflateSync } from 'node:zlib';

/**
 * A synthetic background photo, for previewing layouts without billing fal.ai.
 *
 * The preview surface has to hand `renderPoster` real image bytes of a known size,
 * and calling the diffusion endpoint to look at a layout change would cost money
 * per refresh. So this draws one procedurally.
 *
 * It is deliberately not a flat colour. The archetypes are judged on how their
 * scrims, dissolves and accent-on-photo contrast behave, and a flat fill makes all
 * of that look fine when it is not. The generated frame reproduces the tonal
 * structure of the reference set — bright warm horizon, deep sky above, dark mass
 * lower-right — so a scrim that fails to lift the headline off the photo fails
 * visibly here too.
 *
 * PNG is encoded by hand against Node's built-in zlib rather than adding an image
 * library: this is preview-only scaffolding and does not justify a dependency that
 * ships to production.
 */

export type PlaceholderTone = 'dusk' | 'daylight';

/**
 * Renders a placeholder photo as PNG bytes.
 *
 * `dusk` suits the warm-accent archetypes (scrim, diagonal); `daylight` is high-key
 * and suits the light-field ones (bands, curve, editorial), where the dissolve only
 * reads correctly over a bright photo.
 */
export function createPlaceholderPhoto(
  width: number,
  height: number,
  tone: PlaceholderTone = 'dusk',
): Buffer {
  const pixels = Buffer.allocUnsafe(width * height * 3);
  const palette = tone === 'dusk' ? DUSK : DAYLIGHT;

  // Horizon sits high, leaving the lower half for the ground mass — the same
  // proportion as the reference photographs.
  const horizon = height * 0.56;
  // Sun placed where PHOTO_FOCUS expects the subject, so the focal crop is
  // exercised rather than bypassed.
  const sunX = width * 0.72;
  const sunY = horizon * 0.82;
  const sunRadius = Math.min(width, height) * 0.42;

  let offset = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r: number;
      let g: number;
      let b: number;

      if (y < horizon) {
        // Sky: vertical ramp from zenith to horizon.
        const t = y / horizon;
        r = lerp(palette.zenith[0], palette.horizon[0], t);
        g = lerp(palette.zenith[1], palette.horizon[1], t);
        b = lerp(palette.zenith[2], palette.horizon[2], t);
      } else {
        // Ground: darkens toward the bottom edge.
        const t = (y - horizon) / (height - horizon);
        r = lerp(palette.ground[0], palette.groundDark[0], t);
        g = lerp(palette.ground[1], palette.groundDark[1], t);
        b = lerp(palette.ground[2], palette.groundDark[2], t);
      }

      // Radial sun glow, falling off smoothly and only above the horizon.
      const dx = x - sunX;
      const dy = y - sunY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < sunRadius && y < horizon * 1.12) {
        const glow = (1 - distance / sunRadius) ** 2.4 * palette.glowStrength;
        r += (255 - r) * glow;
        g += (245 - g) * glow;
        b += (215 - b) * glow;
      }

      // A blocky silhouette on the right, standing in for the building mass every
      // reference photo carries. Makes cover-cropping and focal bias observable.
      //
      // Shaded to roughly half brightness rather than crushed to near-black. An
      // aggressive multiplier here made every preview look like a failed scrim: the
      // photo read as flat black, so there was no way to tell an over-opaque overlay
      // from a dark placeholder. Half-brightness keeps the mass legible as a shape
      // while still being clearly darker than the sky.
      if (x > width * 0.58 && y > horizon * 0.55) {
        const column = Math.floor((x - width * 0.58) / (width * 0.1));
        const towerTop = horizon * (0.55 + (column % 3) * 0.12);
        if (y > towerTop) {
          const shade = 0.48 + (column % 2) * 0.1;
          r *= shade;
          g *= shade;
          b *= shade + 0.05;
        }
      }

      pixels[offset] = clampByte(r);
      pixels[offset + 1] = clampByte(g);
      pixels[offset + 2] = clampByte(b);
      offset += 3;
    }
  }

  return encodePng(width, height, pixels);
}

interface Palette {
  zenith: [number, number, number];
  horizon: [number, number, number];
  ground: [number, number, number];
  groundDark: [number, number, number];
  glowStrength: number;
}

const DUSK: Palette = {
  zenith: [16, 30, 56],
  horizon: [226, 148, 74],
  ground: [30, 28, 30],
  groundDark: [10, 10, 13],
  glowStrength: 0.85,
};

const DAYLIGHT: Palette = {
  zenith: [138, 186, 232],
  horizon: [232, 240, 248],
  ground: [176, 182, 186],
  groundDark: [118, 124, 128],
  glowStrength: 0.5,
};

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * Math.min(1, Math.max(0, t));
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder
// ---------------------------------------------------------------------------

/**
 * Encodes 8-bit RGB pixels as a PNG.
 *
 * Colour type 2 (truecolour, no alpha), filter type 0 on every scanline. No
 * filtering is applied because zlib already compresses these smooth gradients well
 * and a filter pass would only add CPU to a preview-only path.
 */
function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type: truecolour
  ihdr.writeUInt8(0, 10); // compression: deflate
  ihdr.writeUInt8(0, 11); // filter method: adaptive
  ihdr.writeUInt8(0, 12); // interlace: none

  // Each scanline is prefixed with its filter byte, so the raw stream is
  // height * (1 + width * 3) bytes.
  const stride = width * 3;
  const raw = Buffer.allocUnsafe(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const target = y * (stride + 1);
    raw.writeUInt8(0, target);
    rgb.copy(raw, target + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength, 0);

  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);

  return Buffer.concat([length, typeAndData, crc]);
}

/** Standard CRC-32 (reflected, polynomial 0xEDB88320), as PNG requires. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
