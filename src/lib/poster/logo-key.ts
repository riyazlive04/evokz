/**
 * Knocks the flat background out of an uploaded logo.
 *
 * Clients send logos as JPEG or as a flattened PNG, so the file carries a baked-in
 * white rectangle. Nothing downstream can undo that: `LogoLock` paints the logo's
 * own pixels straight onto the ground colour with no backing plate, so on the four
 * dark archetypes the slab lands on near-black and reads as a defect.
 *
 * ---------------------------------------------------------------------------
 * Why `sharp`, in a codebase that spent two modules avoiding it
 * ---------------------------------------------------------------------------
 * `image-info.ts` and `placeholder-photo.ts` both hand-roll rather than depend on
 * an image library, and the stated reason is Vercel: sharp's native binary was a
 * recurring source of serverless deploy breakage. That deployment no longer
 * exists — the app runs `node:20-bookworm-slim` under Docker Compose on a VPS,
 * glibc, with `node_modules` copied wholesale from the builder stage for exactly
 * the reason that keeps the resvg addon intact.
 *
 * And nothing cheaper would do. Keying needs real pixels, `@resvg/resvg-js`
 * renders SVG rather than decoding rasters, and the format that *forces* the
 * problem is JPEG — a JPEG logo always has a baked background because the format
 * has no alpha channel — which rules out hand-rolling a decoder.
 *
 * **Lockfile trap:** sharp resolves its addon from `@img/sharp-<platform>`
 * optional deps. The lockfile here is generated on Windows, so it must be
 * refreshed with `npm install --os=linux --libc=glibc --cpu=x64 sharp` or `npm ci`
 * inside Debian installs only the win32 binary and every call throws "Could not
 * load the sharp module" at runtime — after a green build.
 *
 * ---------------------------------------------------------------------------
 * Why flood fill from the border, and not "make white transparent"
 * ---------------------------------------------------------------------------
 * A global colour key removes every pixel matching the background, which includes
 * the counters of letters and any white mark *inside* the logo. A white wordmark
 * on a dark roundel would come out hollow. Only background reachable from the
 * image border may be erased, so the fill is seeded from the edge and never
 * crosses the logo's own ink.
 *
 * **The consequence, which is deliberate:** an enclosed region keeps its colour.
 * The counter of an "O" in a black wordmark on white stays white rather than
 * becoming transparent, so on a dark archetype it reads as a small white dot.
 * There is no local signal that separates that from the white "EV" inside a blue
 * roundel — the two are topologically identical, both being background-coloured
 * regions enclosed by ink — so any rule that cleared the first would delete the
 * second. Between a cosmetic dot and silently erasing a client's wordmark, this
 * takes the dot. An operator who needs the counters knocked out can revert to the
 * original and supply a real transparent PNG.
 */

import sharp from 'sharp';

import { relativeLuminance } from '@/lib/poster/color';

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Why a logo was left alone.
 *
 * Every one of these is a legitimate outcome rather than an error, but the
 * operator has to be told which — "nothing happened" and "this logo already had
 * transparency" call for very different next steps. `PosterIdentityPanel` prints
 * the copy for each.
 */
export type LogoKeySkipReason =
  | 'already-transparent'
  | 'background-not-flat'
  | 'nothing-to-remove'
  | 'would-erase-logo'
  | 'vector'
  | 'undecodable';

export type LogoKeyResult =
  | {
      keyed: true;
      png: Buffer;
      width: number;
      height: number;
      /**
       * Mean relative luminance of the surviving ink, 0–1. The renderer uses it
       * to decide whether the logo needs a light plate behind it on a dark
       * ground — without which this fix would simply trade a white slab for an
       * invisible logo.
       */
      inkLuminance: number;
      /** Share of pixels erased, 0–1. Surfaced in the log line, not the UI. */
      erasedFraction: number;
    }
  | { keyed: false; reason: LogoKeySkipReason };

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Squared euclidean RGB distances, 0–195075 (= 255² × 3).
 *
 * Two thresholds rather than one is what separates a clean cut-out from one that
 * looks scissored. Anti-aliased type meets its background through a ramp of
 * intermediate pixels; keying on a single threshold quantises that ramp to
 * all-or-nothing and leaves stair-stepped edges. Between the two, alpha is
 * interpolated, so the ramp survives as a soft edge.
 */
const HARD_DISTANCE = 18 ** 2 * 3;
const SOFT_DISTANCE = 46 ** 2 * 3;

/**
 * How far border samples may spread before the background is declared non-flat.
 *
 * A photographed logo or one on a gradient will blow straight past this, which is
 * the point: declining is a better outcome than a half-erased mark, and the
 * operator gets told why.
 */
const BORDER_SPREAD_LIMIT = 30 ** 2 * 3;

/** Alpha below this counts as erased when measuring the result. */
const ERASED_ALPHA = 8;

/** Alpha at or above this counts as ink when measuring luminance and the crop. */
const INK_ALPHA = 24;

/**
 * A logo that is already mostly transparent has an alpha channel someone made
 * deliberately. Re-keying it risks eating a soft shadow for no gain.
 */
const ALREADY_TRANSPARENT_FRACTION = 0.02;

/** Below this, nothing meaningful was removed and the original is unchanged. */
const MIN_ERASED_FRACTION = 0.005;

/**
 * Least ink a result may contain before it is judged destroyed.
 *
 * Deliberately a floor on what *survives*, not a ceiling on what is erased. The
 * obvious guard — "refuse if more than 92% of pixels went" — is wrong, and
 * wrong on the single most common logo there is: a wordmark on a wide white
 * canvas is only a few percent ink, so keying it correctly erases 95%+ and the
 * ceiling rejects exactly the case this module was built for. What actually
 * marks a destroyed logo is that nothing is left, which is what this measures.
 */
const MIN_INK_PIXELS = 64;
const MIN_INK_FRACTION = 0.0005;

/**
 * Guards the fill against a decompression bomb. A logo larger than this is a
 * mistake — the layout box tops out around 270 px — and the flood fill is O(n)
 * in pixels with a visited map to match.
 */
const MAX_PIXELS = 32_000_000;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Removes the flat background from `bytes`, or explains why it did not.
 *
 * Never throws and never returns a partially-processed image: either the caller
 * gets a PNG it can use, or a reason and the original bytes it already had.
 */
export async function keyLogoBackground(
  bytes: Buffer,
  mimeType: string,
): Promise<LogoKeyResult> {
  // SVG is vector — there is no raster background to key, and rasterising one to
  // strip a background it probably does not have would only lose resolution.
  if (mimeType === 'image/svg+xml' || looksLikeSvg(bytes)) {
    return { keyed: false, reason: 'vector' };
  }

  let width: number;
  let height: number;
  let pixels: Buffer;

  try {
    const decoded = await sharp(bytes, { limitInputPixels: MAX_PIXELS })
      // A JPEG has no alpha channel at all, so the buffer stride would be 3 and
      // every index below would be wrong. This normalises all inputs to RGBA.
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    pixels = decoded.data;
    width = decoded.info.width;
    height = decoded.info.height;
  } catch {
    return { keyed: false, reason: 'undecodable' };
  }

  if (width < 2 || height < 2) return { keyed: false, reason: 'undecodable' };

  if (transparentFraction(pixels) > ALREADY_TRANSPARENT_FRACTION) {
    return { keyed: false, reason: 'already-transparent' };
  }

  const key = readBorderKey(pixels, width, height);
  if (!key) return { keyed: false, reason: 'background-not-flat' };

  const erased = floodFillFromBorder(pixels, width, height, key);
  const erasedFraction = erased / (width * height);

  if (erasedFraction < MIN_ERASED_FRACTION) {
    return { keyed: false, reason: 'nothing-to-remove' };
  }

  const ink = inkBounds(pixels, width, height);

  // Nothing survived, or so little that what is left is speckle rather than a
  // mark. This is the border colour having matched the logo itself — a
  // solid-colour block, or a mark that runs edge to edge — and the original is
  // the better answer.
  if (!ink || ink.pixels < Math.max(MIN_INK_PIXELS, width * height * MIN_INK_FRACTION)) {
    return { keyed: false, reason: 'would-erase-logo' };
  }

  unblendKeyColour(pixels, key);

  const inkLuminance = meanInkLuminance(pixels);

  const png = await sharp(pixels, { raw: { width, height, channels: 4 } })
    .extract(ink.box)
    .png({ compressionLevel: 9 })
    .toBuffer();

  return {
    keyed: true,
    png,
    width: ink.box.width,
    height: ink.box.height,
    inkLuminance,
    erasedFraction,
  };
}

/**
 * Mean luminance of a logo's opaque pixels, for a file we did not key ourselves.
 *
 * Externally-linked logos never pass through the upload path, and an
 * already-transparent PNG is skipped by `keyLogoBackground` — but the renderer
 * still has to decide whether either needs a plate behind it on a dark ground.
 * Returns null when the bytes cannot be decoded or carry no ink at all, which the
 * caller reads as "unknown, change nothing".
 */
export async function measureInkLuminance(
  bytes: Buffer,
  mimeType: string,
): Promise<number | null> {
  if (mimeType === 'image/svg+xml' || looksLikeSvg(bytes)) return null;

  try {
    const { data } = await sharp(bytes, { limitInputPixels: MAX_PIXELS })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const luminance = meanInkLuminance(data);
    return Number.isFinite(luminance) ? luminance : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Steps
//
// Buffer reads below are asserted non-null. `noUncheckedIndexedAccess` is on, so
// every `pixels[i]` widens to `number | undefined` — correct in general, but here
// each index is derived from the decoded `width`/`height` and bounded by the loop
// that produced it, and Buffer would return a number for any in-range read. The
// alternative, `readUInt8` per channel, puts a bounds-checked call on every one of
// several million accesses to restate a guarantee the loops already give.
// ---------------------------------------------------------------------------

function looksLikeSvg(bytes: Buffer): boolean {
  return bytes.toString('utf8', 0, 300).trimStart().toLowerCase().startsWith('<svg');
}

function transparentFraction(pixels: Buffer): number {
  let count = 0;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index]! < 250) count += 1;
  }
  return count / (pixels.length / 4);
}

interface KeyColour {
  r: number;
  g: number;
  b: number;
}

/**
 * The background colour, read from a two-pixel ring around the edge.
 *
 * Returns null when the ring is not one colour. That check is what keeps the
 * function honest on a photographic or gradient background: rather than keying
 * against a meaningless average and eating an arbitrary chunk of the image, it
 * declines and the caller keeps the original.
 *
 * The median is taken per channel rather than the mean, so a logo that bleeds a
 * few pixels into the ring — a descender, a stray mark — does not drag the key
 * off the true background.
 */
function readBorderKey(pixels: Buffer, width: number, height: number): KeyColour | null {
  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];

  const sample = (x: number, y: number): void => {
    const offset = (y * width + x) * 4;
    // A transparent border pixel describes no colour; including it would drag
    // the key toward whatever garbage sits in the RGB of a cleared pixel.
    if (pixels[offset + 3]! < 250) return;
    reds.push(pixels[offset]!);
    greens.push(pixels[offset + 1]!);
    blues.push(pixels[offset + 2]!);
  };

  const depth = Math.min(2, Math.floor(Math.min(width, height) / 2));
  for (let d = 0; d < depth; d += 1) {
    for (let x = d; x < width - d; x += 1) {
      sample(x, d);
      sample(x, height - 1 - d);
    }
    for (let y = d + 1; y < height - 1 - d; y += 1) {
      sample(d, y);
      sample(width - 1 - d, y);
    }
  }

  if (reds.length < 8) return null;

  const key = {
    r: median(reds),
    g: median(greens),
    b: median(blues),
  };

  // Homogeneity: how much of the ring sits near that median. A flat background
  // puts nearly all of it there; a gradient or photo does not. Judged on the
  // share within tolerance rather than the worst outlier, so a logo touching the
  // edge costs a few samples instead of the whole decision.
  let near = 0;
  for (let index = 0; index < reds.length; index += 1) {
    const distance = squaredDistance(reds[index]!, greens[index]!, blues[index]!, key);
    if (distance <= BORDER_SPREAD_LIMIT) near += 1;
  }

  return near / reds.length >= 0.9 ? key : null;
}

/**
 * Clears every background pixel reachable from the border, and returns how many.
 *
 * Iterative with an explicit stack: the recursive form of this is the textbook
 * one, and it blows the call stack on any real logo — a 2000×2000 upload is four
 * million frames deep in the worst case.
 */
function floodFillFromBorder(
  pixels: Buffer,
  width: number,
  height: number,
  key: KeyColour,
): number {
  const total = width * height;
  const visited = new Uint8Array(total);
  const stack: number[] = [];

  const consider = (index: number): void => {
    if (visited[index]) return;
    visited[index] = 1;

    const offset = index * 4;
    const distance = squaredDistance(
      pixels[offset]!,
      pixels[offset + 1]!,
      pixels[offset + 2]!,
      key,
    );

    if (distance > SOFT_DISTANCE) return;

    if (distance <= HARD_DISTANCE) {
      pixels[offset + 3] = 0;
    } else {
      // The soft band. Alpha ramps with distance from the key, so an anti-aliased
      // edge keeps its gradient instead of being quantised to a hard line.
      const ratio = (distance - HARD_DISTANCE) / (SOFT_DISTANCE - HARD_DISTANCE);
      const alpha = Math.round(ratio * 255);
      // Never *raise* alpha: a pixel already partly transparent stays that way.
      if (alpha < pixels[offset + 3]!) pixels[offset + 3] = alpha;
    }

    // Only fully-cleared pixels propagate. Letting a soft-band pixel seed further
    // neighbours is how a fill leaks through anti-aliased type and hollows the
    // logo out from the inside.
    if (distance <= HARD_DISTANCE) stack.push(index);
  };

  for (let x = 0; x < width; x += 1) {
    consider(x);
    consider((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    consider(y * width);
    consider(y * width + width - 1);
  }

  while (stack.length > 0) {
    const index = stack.pop() as number;
    const x = index % width;
    const y = (index - x) / width;

    if (x > 0) consider(index - 1);
    if (x < width - 1) consider(index + 1);
    if (y > 0) consider(index - width);
    if (y < height - 1) consider(index + width);
  }

  let erased = 0;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index]! < ERASED_ALPHA) erased += 1;
  }
  return erased;
}

/**
 * Removes the background's contribution from partially transparent pixels.
 *
 * An anti-aliased edge pixel is a blend: `observed = ink·a + key·(1−a)`. Leaving
 * it as-is keeps a rim of background colour around the mark, which on a dark
 * ground shows up as exactly the white halo this whole module exists to remove —
 * a subtler version of the original bug. Solving for the ink recovers the true
 * colour: `ink = (observed − key·(1−a)) / a`.
 */
function unblendKeyColour(pixels: Buffer, key: KeyColour): void {
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3]!;
    if (alpha === 0 || alpha === 255) continue;

    const a = alpha / 255;
    pixels[offset] = unblend(pixels[offset]!, key.r, a);
    pixels[offset + 1] = unblend(pixels[offset + 1]!, key.g, a);
    pixels[offset + 2] = unblend(pixels[offset + 2]!, key.b, a);
  }
}

function unblend(observed: number, keyChannel: number, alpha: number): number {
  const value = (observed - keyChannel * (1 - alpha)) / alpha;
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

/**
 * Tight bounding box of the remaining ink.
 *
 * Cropping the cleared margin is not cosmetic. `LogoLock` fits the logo into a
 * fixed box with `containFit`, so any transparent padding left in the file is
 * padding the mark is scaled down to accommodate — the logo would render
 * measurably smaller than the one beside it for no reason.
 */
function inkBounds(
  pixels: Buffer,
  width: number,
  height: number,
): {
  box: { left: number; top: number; width: number; height: number };
  pixels: number;
} | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (pixels[(row + x) * 4 + 3]! >= INK_ALPHA) {
        count += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return null;

  return {
    box: { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    pixels: count,
  };
}

/**
 * Mean relative luminance of the ink, weighted by nothing — every opaque pixel
 * counts once.
 *
 * A weighted mean would be more defensible in principle, but the consumer only
 * asks "is this mark too dark to read on near-black", and for that a plain mean
 * over the visible pixels is both sufficient and easier to reason about when a
 * plate appears where it was not expected.
 */
function meanInkLuminance(pixels: Buffer): number {
  let sum = 0;
  let count = 0;

  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3]! < INK_ALPHA) continue;
    sum += relativeLuminance({
      r: pixels[offset]!,
      g: pixels[offset + 1]!,
      b: pixels[offset + 2]!,
    });
    count += 1;
  }

  return count === 0 ? Number.NaN : sum / count;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function squaredDistance(r: number, g: number, b: number, key: KeyColour): number {
  const dr = r - key.r;
  const dg = g - key.g;
  const db = b - key.b;
  return dr * dr + dg * dg + db * db;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}
