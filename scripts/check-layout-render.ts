/**
 * Render check for the layout-spec interpreter.
 *
 * Takes spec JSON — as printed by `check-layout-extract.ts` — and renders it
 * through the real poster path at several presets, so a spec can be judged as a
 * poster rather than as a tree. Costs nothing: the photography is procedural and
 * no fal.ai, Drive or WhatsApp call is made.
 *
 * Run: npx tsx scripts/check-layout-render.ts <outDir> <spec.json...>
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { getImageSizePreset } from '@/lib/image-sizes';
import { createPlaceholderPhoto } from '@/lib/poster/placeholder-photo';
import { resolveSpecPhotoRequests } from '@/lib/poster/photo-request';
import { renderPoster } from '@/lib/poster/render';
import { EMPTY_BRAND_GUIDELINE } from '@/lib/types/brand';
import {
  normalizeLayoutSpec,
  posterLayoutSpecSchema,
  validateLayoutSpec,
} from '@/lib/types/layout-spec';
import type { PosterCopy } from '@/lib/types/poster';

/** Realistic length, not lorem: a short headline hides every fitting fault. */
const COPY: PosterCopy = {
  headlineLines: ['GRAND', 'OPENING', 'PROMO'],
  accentLineIndex: 1,
  eyebrow: 'NOW OPEN',
  body: "Celebrate our new journey at our restaurant's grand opening with special prices on all of our menu.",
  features: [
    {
      icon: 'star',
      label: 'Discount up to 25% off',
      body: 'Across the entire menu, counter to kitchen.',
    },
    {
      icon: 'stopwatch',
      label: 'Promo duration',
      body: '17 - 20 August 2026, open from 8am daily.',
    },
    {
      icon: 'locationPin',
      label: 'Find us',
      body: '123 Anywhere St., any city — walk in, no booking.',
    },
  ],
  callLabel: 'TASTE IT TODAY',
  websiteLabel: 'FOLLOW OUR SOCIAL MEDIA',
  headlinePeriod: true,
};

const PRESETS = ['whatsapp-status', 'instagram-portrait'];

async function main() {
  const [outDir, ...specPaths] = process.argv.slice(2);
  if (!outDir || specPaths.length === 0) {
    throw new Error('usage: check-layout-render.ts <outDir> <spec.json...>');
  }
  await mkdir(outDir, { recursive: true });

  const logoBytes = await readFile(
    new URL('../../sample_logo-removebg-preview.png', import.meta.url),
  );
  const logoUri = `data:image/png;base64,${logoBytes.toString('base64')}`;

  let failures = 0;

  for (const specPath of specPaths) {
    const raw: unknown = JSON.parse(await readFile(specPath, 'utf8'));
    const parsed = posterLayoutSpecSchema.safeParse(raw);
    if (!parsed.success) {
      console.error(`${basename(specPath)}: not a readable spec — ${parsed.error.message}`);
      failures += 1;
      continue;
    }

    const spec = normalizeLayoutSpec(parsed.data);
    const problems = validateLayoutSpec(spec);
    if (problems.length > 0) {
      console.error(
        `${basename(specPath)}: invalid — ${problems.map((p) => `${p.path} ${p.message}`).join('; ')}`,
      );
      failures += 1;
      continue;
    }

    for (const presetId of PRESETS) {
      const preset = getImageSizePreset(presetId);
      if (!preset) throw new Error(`unknown preset ${presetId}`);

      const requests = resolveSpecPhotoRequests(spec, preset);
      const photos = requests.map((request, index) =>
        placeholder(request.width, request.height, index),
      );

      try {
        const poster = await renderPoster({
          layoutSpec: spec,
          copy: COPY,
          guideline: EMPTY_BRAND_GUIDELINE,
          identity: {
            companyName: 'TEST COMPANY 2',
            logoUrl: logoUri,
            brandTagline: 'COOKING SINCE 1980',
            websiteUrl: 'www.example.com',
            displayPhone: '+91 98765 43210',
            whatsappNumber: '919876543210',
          },
          photos: photos.length > 0 ? photos : [placeholder(1024, 1024, 0)],
          width: preset.width,
          height: preset.height,
        });

        const name = `spec-${slug(spec.name)}-${preset.width}x${preset.height}.png`;
        await writeFile(`${outDir}/${name}`, poster.body);
        console.log(
          `wrote ${name}  (${poster.layoutName}, ${poster.canvasMode} canvas, ` +
            `${requests.length} photo request(s))`,
        );
      } catch (error) {
        failures += 1;
        console.error(
          `${basename(specPath)} @ ${preset.width}×${preset.height}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} render(s) failed.`);
    process.exitCode = 1;
  }
}

/** Alternating tones so it is obvious which cell each frame landed in. */
function placeholder(width: number, height: number, index: number): Buffer {
  const capped = capLongEdge(width, height, 1024);
  return createPlaceholderPhoto(
    capped.width,
    capped.height,
    index % 2 === 0 ? 'daylight' : 'dusk',
  );
}

function capLongEdge(width: number, height: number, max: number) {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const ratio = max / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'spec';
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
