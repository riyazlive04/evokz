/**
 * Prototype harness for measured text detection.
 *
 * Answers one question: can `detectTextBlocks` find the blocks of type on the
 * real references, well enough to replace the vision model's estimates?
 *
 * It prints the measured boxes beside the ones currently stored for the same
 * template, and writes an overlay PNG per template so the answer can be judged
 * by eye rather than from four decimal places. The stored boxes are drawn too,
 * in a second colour — that comparison is the point.
 *
 * Costs nothing but a Drive download. No vision call, no fal.ai, no writes.
 *
 * Run on a machine with DATABASE_URL and the Google credentials:
 *   npx tsx --env-file=.env --tsconfig scripts/tsconfig.json \
 *     scripts/check-text-detect.ts <outDir> [--vertical Medicals] [--labels a,b]
 */
import { mkdir, writeFile } from 'node:fs/promises';

import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';

import { downloadDriveFile } from '@/lib/google-drive';
import { detectTextBlocks, type TextBlock } from '@/lib/poster/text-detect';
import { parsePlateSpec } from '@/lib/types/plate-spec';

const prisma = new PrismaClient();

/** Everything on a 0.05 grid is the signature of an estimate, not a measurement. */
function isRound(value: number): boolean {
  return Math.abs(value * 100 - Math.round((value * 100) / 5) * 5) < 1e-9;
}

function pct(value: number): string {
  return (value * 100).toFixed(1).padStart(5);
}

function describe(block: { x: number; y: number; w: number; h: number }): string {
  return `x ${pct(block.x)}  y ${pct(block.y)}  w ${pct(block.w)}  h ${pct(block.h)}`;
}

/**
 * Draws the detected blocks over the reference, with the stored boxes beside
 * them for comparison.
 *
 * SVG composited by sharp rather than pixels poked into the buffer: the labels
 * matter as much as the rectangles when reading one of these by eye.
 */
async function overlay(
  reference: Buffer,
  detected: TextBlock[],
  stored: Array<{ slot: string; x: number; y: number; w: number; h: number }>,
): Promise<Buffer> {
  const meta = await sharp(reference).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  const rects: string[] = [];

  for (const box of stored) {
    const x = box.x * width;
    const y = box.y * height;
    rects.push(
      `<rect x="${x}" y="${y}" width="${box.w * width}" height="${box.h * height}" ` +
        `fill="none" stroke="#E0442B" stroke-width="5" stroke-dasharray="16 10"/>` +
        `<text x="${x + 8}" y="${y + 34}" font-family="monospace" font-size="26" ` +
        `fill="#E0442B" font-weight="bold">stored: ${box.slot}</text>`,
    );
  }

  detected.forEach((box, index) => {
    const x = box.x * width;
    const y = box.y * height;
    rects.push(
      `<rect x="${x}" y="${y}" width="${box.w * width}" height="${box.h * height}" ` +
        `fill="none" stroke="#12B886" stroke-width="5"/>` +
        `<text x="${x + 8}" y="${y - 10}" font-family="monospace" font-size="26" ` +
        `fill="#12B886" font-weight="bold">${index + 1}</text>`,
    );
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects.join('')}</svg>`;

  return sharp(reference)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

async function main() {
  const args = process.argv.slice(2);
  const outDir = args.find((a) => !a.startsWith('--'));
  if (!outDir) {
    console.error('Usage: check-text-detect.ts <outDir> [--vertical X] [--labels a,b]');
    process.exitCode = 1;
    return;
  }
  await mkdir(outDir, { recursive: true });

  const valueOf = (flag: string): string | null => {
    const hit = args.find((a) => a === flag || a.startsWith(`${flag}=`));
    if (!hit) return null;
    return hit.includes('=') ? hit.split('=').slice(1).join('=') : (args[args.indexOf(hit) + 1] ?? null);
  };

  const vertical = valueOf('--vertical');
  const labels = (valueOf('--labels') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  const templates = await prisma.categoryTemplate.findMany({
    where: {
      ...(vertical ? { category: { name: { equals: vertical, mode: 'insensitive' } } } : {}),
      ...(labels.length > 0 ? { label: { in: labels } } : {}),
    },
    orderBy: { label: 'asc' },
    select: { id: true, label: true, gDriveFileId: true, plateSpec: true },
  });

  if (templates.length === 0) {
    console.error('No templates matched.');
    process.exitCode = 1;
    return;
  }

  console.log(`${templates.length} template(s)\n`);

  let totalStored = 0;
  let totalRound = 0;
  let totalDetected = 0;

  for (const template of templates) {
    console.log(`\n=== ${template.label} ===`);

    let reference: Buffer;
    try {
      reference = await downloadDriveFile(template.gDriveFileId);
    } catch (error) {
      console.log(`  could not fetch the reference: ${error instanceof Error ? error.message : error}`);
      continue;
    }

    const spec = parsePlateSpec(template.plateSpec);
    const stored = spec?.text ?? [];
    const roundBoxes = stored.filter(
      (r) => isRound(r.x) && isRound(r.y) && isRound(r.w) && isRound(r.h),
    ).length;
    totalStored += stored.length;
    totalRound += roundBoxes;

    const started = process.hrtime.bigint();
    const detection = await detectTextBlocks(reference);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    if (!detection) {
      console.log('  the reference could not be decoded');
      continue;
    }

    totalDetected += detection.blocks.length;

    console.log(
      `  stored:   ${stored.length} box(es), ${roundBoxes} of them entirely on a 0.05 grid`,
    );
    for (const region of stored) {
      console.log(`    ${region.slot.padEnd(9)} ${describe(region)}`);
    }

    console.log(`  measured: ${detection.blocks.length} block(s) in ${ms.toFixed(0)}ms`);
    detection.blocks.forEach((block, index) => {
      console.log(
        `    ${String(index + 1).padEnd(9)} ${describe(block)}  ` +
          `${block.cells} cells, ${block.inkIsDark ? 'dark ink' : 'light ink'}`,
      );
    });

    const png = await overlay(reference, detection.blocks, stored);
    const path = `${outDir}/${template.label}.png`;
    await writeFile(path, png);
    console.log(`  overlay: ${path}`);
  }

  console.log('\n--- summary ---');
  console.log(`stored boxes:            ${totalStored}`);
  console.log(`entirely on a 0.05 grid: ${totalRound}`);
  console.log(`measured blocks:         ${totalDetected}`);
  console.log('\nGreen = measured by this detector. Red dashed = what is stored today.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
