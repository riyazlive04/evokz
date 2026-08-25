/**
 * Extraction spike for `extractPlateRegions`.
 *
 * The counterpart to `check-layout-extract.ts`, and used the same way: feed it
 * real reference posters and read back the boxes the vision stage proposes, to
 * judge whether the proposal is worth correcting or worth replacing. A plate's
 * regions are the difference between composited type landing on the artwork and
 * landing across somebody's face, and that is not a judgement to make for the
 * first time on a live vertical.
 *
 * Prints each box as a percentage rectangle and, where the ink could be
 * measured, the colour sampled from inside it.
 *
 * Costs one vision call per image, billed to no client.
 *
 * Run: npx tsx --env-file=.env --tsconfig scripts/tsconfig.json \
 *        scripts/check-plate-extract.ts [--out <dir>] <image...>
 *
 * With `--out`, each proposal is written as `<image>.plate.json`: a whole plate
 * spec with an empty `photos`, ready to paste into the console's JSON editor for
 * a plate whose holes have already been measured.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { extractPlateRegions } from '@/lib/ai/plate-extractor';
import { readImageDimensions } from '@/lib/poster/image-info';

function mimeFor(path: string): string {
  const extension = path.toLowerCase().split('.').pop();
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  return 'image/jpeg';
}

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const outDir = outIndex >= 0 ? args[outIndex + 1] : null;
  // The `outIndex >= 0` guard is load-bearing: without `--out` the index is -1,
  // and skipping `outIndex + 1` would drop the first image instead.
  const images = args.filter(
    (arg, index) => !arg.startsWith('--') && !(outIndex >= 0 && index === outIndex + 1),
  );

  if (images.length === 0) {
    console.error(
      'Give at least one reference image: npx tsx --env-file=.env --tsconfig ' +
        'scripts/tsconfig.json scripts/check-plate-extract.ts poster.png',
    );
    process.exitCode = 1;
    return;
  }

  if (outDir) await mkdir(outDir, { recursive: true });

  let failures = 0;

  for (const path of images) {
    console.log(`\n=== ${basename(path)} ===`);

    try {
      const bytes = await readFile(path);
      const measured = readImageDimensions(bytes);

      const draft = await extractPlateRegions({
        bytes,
        mimeType: mimeFor(path),
        label: basename(path),
      });

      console.log(`  model:  ${draft.model}`);
      console.log(
        `  copy:   ${draft.featureCount} feature(s), ${draft.featureStyle}, ` +
          `${draft.ctaShape} button, headline ${draft.headlineCase} ` +
          `[${draft.headlineEmphasis.join(', ') || 'not measured'}]`,
      );
      console.log('');

      for (const region of draft.regions) {
        const box =
          `${(region.x * 100).toFixed(1)}%,${(region.y * 100).toFixed(1)}% ` +
          `${(region.w * 100).toFixed(1)}×${(region.h * 100).toFixed(1)}`;
        console.log(
          `  ${region.slot.padEnd(9)} ${box.padEnd(28)} ${region.align}/${region.valign}` +
            `  ${region.color ?? '—'}`,
        );
      }

      if (draft.regions.length === 0) {
        failures += 1;
        console.log('  no regions proposed — the model found no type on this poster.');
      }

      // The one structural rule the console will refuse a plate over, checked
      // here so a bad proposal is visible before it is pasted anywhere.
      const headlines = draft.regions.filter((r) => r.slot === 'headline').length;
      if (headlines !== 1) {
        failures += 1;
        console.log(`  PROBLEM: ${headlines} headline region(s); exactly one is required.`);
      }

      if (draft.reading) console.log(`\n  reading: ${draft.reading}`);

      if (outDir) {
        const target = `${outDir}/${basename(path)}.plate.json`;
        await writeFile(
          target,
          JSON.stringify(
            {
              version: 1,
              name: basename(path),
              // Measured from the plate by `findPlateHoles`, never from the
              // reference — left empty rather than guessed.
              aspect: measured ? measured.width / measured.height : 0,
              photos: [],
              text: draft.regions,
              featureCount: draft.featureCount,
              featureStyle: draft.featureStyle,
              ctaShape: draft.ctaShape,
              headlineEmphasis: draft.headlineEmphasis,
              headlineCase: draft.headlineCase,
            },
            null,
            2,
          ),
          'utf8',
        );
        console.log(`\n  written: ${target}`);
      }
    } catch (error) {
      failures += 1;
      console.error(`  FAILED — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} image(s) need attention.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
