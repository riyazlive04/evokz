/**
 * Fixture suite for `keyLogoBackground`.
 *
 * Generates each case with sharp rather than committing binary fixtures, runs the
 * keyer, and asserts the one outcome that matters for that case. There is no test
 * framework in this repository, so this follows the `lint-colors.mjs` pattern: a
 * standalone script with a non-zero exit code.
 *
 * Run: npm run check:logo-key
 *
 * Worth keeping green. The two cases that pull hardest against each other are 1
 * and 2 — a wordmark on white must lose its background, while white type inside a
 * coloured badge must keep every pixel — and most plausible "improvements" to the
 * fill break one of them.
 */
import sharp from 'sharp';

import { keyLogoBackground } from '@/lib/poster/logo-key';

const W = 400;
const H = 200;

/** An SVG rasterised to the requested format — the way a real logo arrives. */
async function raster(svg: string, format: 'png' | 'jpeg'): Promise<Buffer> {
  const pipeline = sharp(Buffer.from(svg));
  return format === 'jpeg'
    ? pipeline.flatten({ background: '#FFFFFF' }).jpeg({ quality: 92 }).toBuffer()
    : pipeline.png().toBuffer();
}

/** Alpha at a point, for asserting what survived. */
async function alphaAt(png: Buffer, xr: number, yr: number): Promise<number> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const x = Math.min(info.width - 1, Math.round(xr * info.width));
  const y = Math.min(info.height - 1, Math.round(yr * info.height));
  return data[(y * info.width + x) * 4 + 3]!;
}

async function rgbAt(png: Buffer, xr: number, yr: number) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const x = Math.min(info.width - 1, Math.round(xr * info.width));
  const y = Math.min(info.height - 1, Math.round(yr * info.height));
  const o = (y * info.width + x) * 4;
  return { r: data[o]!, g: data[o + 1]!, b: data[o + 2]!, a: data[o + 3]! };
}

/**
 * Share of fully transparent pixels, and whether any opaque pixel still matches
 * the background colour.
 *
 * Probing a fixed coordinate does not work now that the keyer crops to the ink
 * bounding box — the "corner" of a tight-cropped wordmark is the top bar of its
 * first letter, legitimately opaque. What the test actually wants to know is
 * whether the background survived anywhere, so ask that directly.
 */
async function backgroundReport(png: Buffer, key: { r: number; g: number; b: number }) {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let clear = 0;
  let opaqueKeyColoured = 0;
  const total = data.length / 4;

  for (let o = 0; o < data.length; o += 4) {
    if (data[o + 3] === 0) {
      clear += 1;
      continue;
    }
    if (data[o + 3]! < 250) continue;
    const dr = data[o]! - key.r;
    const dg = data[o + 1]! - key.g;
    const db = data[o + 2]! - key.b;
    if (dr * dr + dg * dg + db * db <= 20 ** 2 * 3) opaqueKeyColoured += 1;
  }

  return { clearShare: clear / total, opaqueKeyColoured };
}

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
  }
}

// ---------------------------------------------------------------------------

async function main() {
  // -- 1. The reported bug: dark wordmark on a white JPEG -------------------
  console.log('\n1. dark wordmark on white JPEG (the reported case)');
  {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect width="100%" height="100%" fill="#FFFFFF"/>
      <text x="200" y="118" font-family="DejaVu Sans, sans-serif" font-size="64"
            font-weight="bold" fill="#111827" text-anchor="middle">EVOKZ</text>
    </svg>`;
    const result = await keyLogoBackground(await raster(svg, 'jpeg'), 'image/jpeg');

    check('keyed', result.keyed, result.keyed ? '' : `reason=${result.reason}`);
    if (result.keyed) {
      const bg = await backgroundReport(result.png, { r: 255, g: 255, b: 255 });
      check(
        'open white background gone',
        bg.clearShare > 0.4,
        `clear=${(bg.clearShare * 100).toFixed(1)}%`,
      );
      // Whatever background colour survives is enclosed by ink — the counter of
      // the "O" — which the module keeps on purpose; see its header. Bounding the
      // share is what catches a fill that failed to reach open background.
      check(
        'surviving background is only enclosed counters',
        bg.opaqueKeyColoured / (result.width * result.height) < 0.12,
        `share=${((bg.opaqueKeyColoured / (result.width * result.height)) * 100).toFixed(1)}%`,
      );
      check('ink survives', (await alphaAt(result.png, 0.5, 0.5)) > 200);
      check(
        'ink reads as dark',
        result.inkLuminance < 0.25,
        `inkLuminance=${result.inkLuminance.toFixed(3)}`,
      );
      check('cropped to the mark', result.width < W * 0.95, `${result.width}x${result.height}`);
    }
  }

  // -- 2. The trap: white letters INSIDE a dark roundel ---------------------
  console.log('\n2. white letters inside a dark roundel (interior must survive)');
  {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
      <rect width="100%" height="100%" fill="#FFFFFF"/>
      <circle cx="150" cy="150" r="120" fill="#0B3D91"/>
      <text x="150" y="178" font-family="DejaVu Sans, sans-serif" font-size="86"
            font-weight="bold" fill="#FFFFFF" text-anchor="middle">EV</text>
    </svg>`;
    const result = await keyLogoBackground(await raster(svg, 'jpeg'), 'image/jpeg');

    check('keyed', result.keyed, result.keyed ? '' : `reason=${result.reason}`);
    if (result.keyed) {
      check('outer white erased', (await alphaAt(result.png, 0.02, 0.02)) === 0);
      // Centre of the roundel is white type on blue — the exact pixels a global
      // white-key would delete.
      const centre = await rgbAt(result.png, 0.5, 0.52);
      check(
        'interior white type kept opaque',
        centre.a > 200,
        `alpha=${centre.a} rgb=${centre.r},${centre.g},${centre.b}`,
      );
      check('roundel body kept', (await alphaAt(result.png, 0.5, 0.12)) > 200);
    }
  }

  // -- 3. Already transparent — must be left alone --------------------------
  console.log('\n3. already-transparent PNG');
  {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <circle cx="200" cy="100" r="70" fill="#EF4444"/>
    </svg>`;
    const result = await keyLogoBackground(await raster(svg, 'png'), 'image/png');
    check(
      'skipped as already-transparent',
      !result.keyed && result.reason === 'already-transparent',
      !result.keyed ? `reason=${result.reason}` : 'was keyed',
    );
  }

  // -- 4. Photographic / gradient background — must decline -----------------
  console.log('\n4. gradient background (must decline, not half-erase)');
  {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0EA5E9"/><stop offset="100%" stop-color="#F59E0B"/>
      </linearGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <text x="200" y="118" font-family="DejaVu Sans, sans-serif" font-size="60"
            font-weight="bold" fill="#FFFFFF" text-anchor="middle">EVOKZ</text>
    </svg>`;
    const result = await keyLogoBackground(await raster(svg, 'jpeg'), 'image/jpeg');
    check(
      'declined as background-not-flat',
      !result.keyed && result.reason === 'background-not-flat',
      !result.keyed ? `reason=${result.reason}` : 'was keyed',
    );
  }

  // -- 5. Solid colour block — the >92% guard -------------------------------
  console.log('\n5. solid-colour block (guard must stop total erasure)');
  {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect width="100%" height="100%" fill="#1D4ED8"/>
    </svg>`;
    const result = await keyLogoBackground(await raster(svg, 'jpeg'), 'image/jpeg');
    check(
      'declined as would-erase-logo',
      !result.keyed && result.reason === 'would-erase-logo',
      !result.keyed ? `reason=${result.reason}` : 'was keyed',
    );
  }

  // -- 6. Nothing to remove: mark fills the frame edge-to-edge --------------
  console.log('\n6. mark touching every edge (nothing-to-remove or declined)');
  {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect width="100%" height="100%" fill="#FFFFFF"/>
      <rect x="0" y="0" width="${W}" height="${H}" fill="#059669"/>
    </svg>`;
    const result = await keyLogoBackground(await raster(svg, 'jpeg'), 'image/jpeg');
    check(
      'did not silently mangle it',
      !result.keyed,
      !result.keyed ? `reason=${result.reason}` : 'was keyed',
    );
  }

  // -- 7. Light ink on white — the plate-inverse case -----------------------
  console.log('\n7. light-ink logo (inkLuminance must read high)');
  {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect width="100%" height="100%" fill="#FFFFFF"/>
      <circle cx="200" cy="100" r="70" fill="#FDE68A"/>
    </svg>`;
    const result = await keyLogoBackground(await raster(svg, 'jpeg'), 'image/jpeg');
    check('keyed', result.keyed, result.keyed ? '' : `reason=${result.reason}`);
    if (result.keyed) {
      check(
        'ink reads as light',
        result.inkLuminance > 0.5,
        `inkLuminance=${result.inkLuminance.toFixed(3)}`,
      );
    }
  }

  // -- 8. Non-white flat background ----------------------------------------
  console.log('\n8. flat NON-white background (key is not hardcoded to white)');
  {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect width="100%" height="100%" fill="#F3E8D8"/>
      <text x="200" y="118" font-family="DejaVu Sans, sans-serif" font-size="64"
            font-weight="bold" fill="#7C2D12" text-anchor="middle">EVOKZ</text>
    </svg>`;
    const result = await keyLogoBackground(await raster(svg, 'jpeg'), 'image/jpeg');
    check('keyed', result.keyed, result.keyed ? '' : `reason=${result.reason}`);
    if (result.keyed) {
      const bg = await backgroundReport(result.png, { r: 0xf3, g: 0xe8, b: 0xd8 });
      check(
        'open beige background gone',
        bg.clearShare > 0.4,
        `clear=${(bg.clearShare * 100).toFixed(1)}%`,
      );
      // Whatever background colour survives is enclosed by ink — the counter of
      // the "O" — which the module keeps on purpose; see its header. Bounding the
      // share is what catches a fill that failed to reach open background.
      check(
        'surviving background is only enclosed counters',
        bg.opaqueKeyColoured / (result.width * result.height) < 0.12,
        `share=${((bg.opaqueKeyColoured / (result.width * result.height)) * 100).toFixed(1)}%`,
      );
    }
  }

  // -- 9. Halo check: no white fringe left on the edge ----------------------
  console.log('\n9. de-halo (edge pixels must not stay background-coloured)');
  {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
      <rect width="100%" height="100%" fill="#FFFFFF"/>
      <circle cx="150" cy="150" r="110" fill="#111827"/>
    </svg>`;
    const result = await keyLogoBackground(await raster(svg, 'jpeg'), 'image/jpeg');
    check('keyed', result.keyed, result.keyed ? '' : `reason=${result.reason}`);
    if (result.keyed) {
      // Walk the horizontal centre line outward and find semi-transparent pixels.
      const { data, info } = await sharp(result.png)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const y = Math.floor(info.height / 2);
      let worst = 0;
      let samples = 0;
      for (let x = 0; x < info.width; x += 1) {
        const o = (y * info.width + x) * 4;
        const a = data[o + 3]!;
        if (a > 20 && a < 235) {
          samples += 1;
          // Un-blended ink is near-black. A leftover halo shows up as a high
          // channel value on a partially transparent pixel.
          worst = Math.max(worst, Math.max(data[o]!, data[o + 1]!, data[o + 2]!));
        }
      }
      check(
        'no white fringe on soft edge',
        samples === 0 || worst < 150,
        `edgeSamples=${samples} brightest=${worst}`,
      );
    }
  }

  // -- 10. SVG passes straight through -------------------------------------
  console.log('\n10. SVG input');
  {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40"/></svg>`,
    );
    const result = await keyLogoBackground(svg, 'image/svg+xml');
    check(
      'skipped as vector',
      !result.keyed && result.reason === 'vector',
      !result.keyed ? `reason=${result.reason}` : 'was keyed',
    );
  }

  // -- 11. Garbage bytes ----------------------------------------------------
  console.log('\n11. undecodable bytes');
  {
    const result = await keyLogoBackground(Buffer.from('not an image at all'), 'image/png');
    check(
      'skipped as undecodable',
      !result.keyed && result.reason === 'undecodable',
      !result.keyed ? `reason=${result.reason}` : 'was keyed',
    );
  }

  console.log(`\n${failures === 0 ? 'ALL FIXTURES PASSED' : `${failures} FAILURE(S)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
