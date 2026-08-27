/**
 * Reads a reference poster's geometry off its own pixels.
 *
 * Authoring a template means turning a flat JPEG into numbers, and the one thing
 * that must not happen is guessing them: the vision-extraction path died exactly
 * there, with 59 of its 60 boxes landing on a 0.05 grid because the model was
 * estimating rather than measuring. Doing it by hand instead worked, but cost
 * most of the first template's time and produced a different bespoke probe every
 * time. This is that probe, once.
 *
 * What it prints, in the reference's own pixels:
 *
 *   palette   the dominant inks, so colours are sampled rather than eyeballed
 *   bands     contiguous rows carrying ink, with each band's box and its
 *             strongest colour — which lands the logo, each headline line, the
 *             rule, the icon rows and the contact bar without a bespoke scan
 *   edges     where a full-width block of colour starts, for bars and waves
 *
 * The ground is taken as the most common colour in the top-left corner, which
 * holds for every reference in the library: none of them start on artwork.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.json scripts/measure-reference.ts <file.png> [--bands 40]
 */
import sharp from 'sharp';

interface Pixels {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

function at(px: Pixels, x: number, y: number): [number, number, number] {
  const i = (y * px.width + x) * px.channels;
  return [px.data[i]!, px.data[i + 1]!, px.data[i + 2]!];
}

function hex(rgb: [number, number, number]): string {
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Perceptual-ish distance, good enough to separate ink from ground. */
function distance(a: [number, number, number], b: [number, number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

/**
 * Colours quantised to a 16-level cube and counted.
 *
 * Quantised because a JPEG's flat area is never one value — Med-SM-15's "flat"
 * #f6f6f6 ground spans a dozen neighbours — and an unquantised histogram reports
 * those as a dozen colours instead of one.
 */
function palette(px: Pixels, region: { x0: number; x1: number; y0: number; y1: number }, top: number) {
  const counts = new Map<string, { rgb: [number, number, number]; n: number }>();
  for (let y = region.y0; y < region.y1; y += 2) {
    for (let x = region.x0; x < region.x1; x += 2) {
      const rgb = at(px, x, y);
      const key = rgb.map((v) => v >> 4).join(',');
      const entry = counts.get(key);
      if (entry) entry.n += 1;
      else counts.set(key, { rgb, n: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, top);
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: measure-reference.ts <file.png> [--bands N]');
    process.exit(1);
  }
  const bandLimit = Number.parseInt(
    process.argv[process.argv.indexOf('--bands') + 1] ?? '',
    10,
  );

  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const px: Pixels = { data, width: info.width, height: info.height, channels: info.channels };

  console.log(`${file}  ${px.width}x${px.height}  aspect ${(px.width / px.height).toFixed(4)}`);

  const ground = palette(px, { x0: 0, x1: 60, y0: 0, y1: 60 }, 1)[0]!.rgb;
  console.log(`ground (top-left corner): ${hex(ground)}`);

  console.log('\npalette (whole poster):');
  for (const entry of palette(px, { x0: 0, x1: px.width, y0: 0, y1: px.height }, 10)) {
    const share = ((entry.n * 100) / ((px.width / 2) * (px.height / 2))).toFixed(1);
    console.log(`  ${hex(entry.rgb)}  ${share.padStart(5)}%`);
  }

  /*
   * A row counts as inked when enough of it differs from the ground. The
   * threshold is deliberately generous: a headline is a handful of stems on a
   * mostly-empty row, and requiring many pixels would miss it, while a single
   * stray JPEG artefact should not open a band.
   */
  const INK = 60;
  const MIN_PIXELS = 4;
  const rows: Array<{ n: number; left: number; right: number }> = [];
  for (let y = 0; y < px.height; y += 1) {
    let n = 0;
    let left = -1;
    let right = -1;
    for (let x = 0; x < px.width; x += 1) {
      if (distance(at(px, x, y), ground) > INK) {
        n += 1;
        if (left < 0) left = x;
        right = x;
      }
    }
    rows.push({ n, left, right });
  }

  console.log('\nbands (contiguous inked rows):');
  const bands: Array<{ top: number; bottom: number }> = [];
  let start = -1;
  for (let y = 0; y < px.height; y += 1) {
    const inked = rows[y]!.n >= MIN_PIXELS;
    if (inked && start < 0) start = y;
    if ((!inked || y === px.height - 1) && start >= 0) {
      // Bands shorter than this are JPEG noise or a stray rule cap, not a block.
      if (y - start >= 3) bands.push({ top: start, bottom: y - 1 });
      start = -1;
    }
  }

  const shown = Number.isFinite(bandLimit) ? bands.slice(0, bandLimit) : bands.slice(0, 30);
  for (const band of shown) {
    let left = px.width;
    let right = 0;
    for (let y = band.top; y <= band.bottom; y += 1) {
      const row = rows[y]!;
      if (row.left >= 0 && row.left < left) left = row.left;
      if (row.right > right) right = row.right;
    }
    // The band's strongest non-ground colour: what this block is drawn in.
    const inks = palette(px, { x0: left, x1: right + 1, y0: band.top, y1: band.bottom + 1 }, 4)
      .filter((entry) => distance(entry.rgb, ground) > INK)
      .slice(0, 2)
      .map((entry) => hex(entry.rgb))
      .join(' ');
    console.log(
      `  rows ${String(band.top).padStart(4)}-${String(band.bottom).padStart(4)}` +
        ` (h${String(band.bottom - band.top + 1).padStart(4)})` +
        `  x ${String(left).padStart(3)}-${String(right).padStart(3)}` +
        ` (w${String(right - left).padStart(3)})  ${inks}`,
    );
  }
  if (bands.length > shown.length) {
    console.log(`  … ${bands.length - shown.length} more band(s); pass --bands to see them`);
  }

  /*
   * Full-width colour blocks — contact bars, footer bands, the ground behind a
   * wave. Reported separately because a bar is not a band: it inks every row it
   * touches, so the band scan sees one enormous block rather than the edge that
   * matters.
   */
  console.log('\nfull-width blocks (rows where >90% of the width is one colour):');
  let blockStart = -1;
  let blockInk = '';
  for (let y = 0; y <= px.height; y += 1) {
    const entry = y < px.height
      ? palette(px, { x0: 0, x1: px.width, y0: y, y1: y + 1 }, 1)[0]!
      : null;
    const dominant = entry && entry.n > (px.width / 2) * 0.9 ? hex(entry.rgb) : '';
    if (dominant && dominant !== blockInk) {
      if (blockStart >= 0 && y - blockStart > 8) {
        console.log(`  rows ${String(blockStart).padStart(4)}-${String(y - 1).padStart(4)}  ${blockInk}`);
      }
      blockStart = y;
      blockInk = dominant;
    } else if (!dominant && blockStart >= 0) {
      if (y - blockStart > 8) {
        console.log(`  rows ${String(blockStart).padStart(4)}-${String(y - 1).padStart(4)}  ${blockInk}`);
      }
      blockStart = -1;
      blockInk = '';
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
