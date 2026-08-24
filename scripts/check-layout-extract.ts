/**
 * Extraction spike / fixture check for `extractLayoutSpec`.
 *
 * Feeds real reference posters to the vision stage and prints the grid it read
 * back, so the accuracy of the draft can be judged before anyone relies on it.
 * There is no test framework in this repository, so this follows the
 * `check-logo-key.ts` pattern: a standalone script with a non-zero exit code.
 *
 * Costs one vision call per image, billed to no client.
 *
 * Run: npx tsx scripts/check-layout-extract.ts [--out <dir>] <image...>
 *
 * With `--out`, each spec is also written as `<image>.json`, ready to hand to
 * `check-layout-render.ts`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { extractLayoutSpec } from '@/lib/ai/layout-extractor';
import { readImageDimensions } from '@/lib/poster/image-info';
import { countPhotoSlots, type PosterLayoutSpec } from '@/lib/types/layout-spec';

function render(spec: PosterLayoutSpec): string {
  const lines: string[] = [
    `  name:   ${spec.name}`,
    `  ground: ${spec.ground}`,
    `  photos: ${countPhotoSlots(spec)}`,
    '',
  ];

  spec.rows.forEach((row, index) => {
    const size =
      row.sizingMode === 'fixed'
        ? `fixed ${(row.heightFraction * 100).toFixed(0)}%`
        : row.sizingMode;
    lines.push(`  row ${index + 1}  [${size}]  fill=${row.fill}`);

    const total = row.cells.reduce((sum, cell) => sum + cell.weight, 0);
    for (const cell of row.cells) {
      const share = ((cell.weight / total) * 100).toFixed(0);
      lines.push(
        `      ${share.padStart(3)}%  fill=${cell.fill.padEnd(7)} ` +
          `align=${cell.align.padEnd(6)} ${cell.padded ? 'padded  ' : 'bleed   '} ` +
          cell.slots.join(' + '),
      );
    }
  });

  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const outFlag = argv.indexOf('--out');
  const outDir = outFlag >= 0 ? argv[outFlag + 1] : null;
  // Guarded on `outFlag >= 0`: without it the `outFlag + 1` term is 0 when the
  // flag is absent, which silently ate the first image path.
  const paths =
    outFlag >= 0
      ? argv.filter((_, index) => index !== outFlag && index !== outFlag + 1)
      : argv;

  if (paths.length === 0) {
    throw new Error('usage: check-layout-extract.ts [--out <dir>] <image...>');
  }
  if (outDir) await mkdir(outDir, { recursive: true });

  let failures = 0;

  for (const path of paths) {
    const bytes = await readFile(path);
    const dimensions = readImageDimensions(bytes);
    const label = basename(path);

    console.log(`\n=== ${label} (${dimensions?.width ?? '?'}×${dimensions?.height ?? '?'}) ===`);

    try {
      const result = await extractLayoutSpec({
        bytes,
        mimeType: dimensions?.mimeType ?? 'image/png',
        label,
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
      });

      console.log(`  model:  ${result.model}`);
      console.log(`\n  --- what the model read ---\n${result.reading}\n`);
      console.log(render(result.spec));

      if (result.problems.length > 0) {
        failures += 1;
        console.log('\n  PROBLEMS:');
        for (const problem of result.problems) {
          console.log(`    ${problem.path} ${problem.message}`);
        }
      } else {
        console.log('\n  structurally valid');
      }

      if (outDir) {
        const file = `${outDir}/${label.replace(/\.[^.]+$/, '')}.json`;
        await writeFile(file, `${JSON.stringify(result.spec, null, 2)}\n`, 'utf8');
        console.log(`\n  spec written to ${file}`);
      } else {
        console.log(`\n  --- spec JSON ---\n${JSON.stringify(result.spec, null, 2)}`);
      }
    } catch (error) {
      failures += 1;
      console.error(`  FAILED: ${error instanceof Error ? error.message : error}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} of ${paths.length} extraction(s) unusable.`);
    process.exit(1);
  }
  console.log(`\nAll ${paths.length} extraction(s) structurally valid.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
