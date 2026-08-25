/**
 * Clones every template in a vertical into a clean plate, without anyone opening
 * an image editor.
 *
 * A plate is the template's own artwork with its words erased and its content
 * regions mapped — see `CategoryTemplate.plateDriveFileId`. Producing one by hand
 * takes ten to twenty minutes, and a vertical is twenty templates, which is the
 * single reason the compositing path sat unused after it shipped.
 *
 * Three steps per template, all machine:
 *
 *   1. Ask the extractor where the type is, reading the *reference* — the plate
 *      does not exist yet and the reference still has its words on it.
 *   2. Paint those boxes into a mask and send both to fal's eraser.
 *   3. Store the result as the plate, with the same regions as its text map.
 *
 * **The mask is padded hard, and that is the whole difference between working
 * and not.** The first run used a tight pad: the eraser removed the middle of
 * each block and left the first and last letters standing, then hallucinated
 * letterforms into the gap — "GOOD HEALTH" came back as "G ⌇⌇⌇ H" and a phone
 * number as "nnccapci30". The extractor reports the column a block sits in, not
 * the ink, and glyphs routinely overhang it. At 5.5% the type goes and the
 * artwork stays.
 *
 * **Nothing is approved.** `plateApprovedAt` stays null, so no client poster
 * composites onto any of this until a human has looked. Erase quality varies
 * with what sat under the type — flat colour reconstructs cleanly, busy
 * photography smears — and that is a judgement no threshold makes for you.
 *
 * **Every template is snapshotted first**, to `<out>/<label>.json`, so a plate
 * can be undone exactly with `template-snapshot.ts restore`.
 *
 * Costs one vision call and one eraser call per template.
 *
 * Run: DATABASE_URL=… OPENAI_API_KEY=… FAL_KEY=… \
 *        scripts/autoplate-vertical.ts <vertical> <snapshotDir> [--labels a,b] [--replace]
 */
import { writeFile } from 'node:fs/promises';

import { Prisma, PrismaClient } from '@prisma/client';
import sharp from 'sharp';

import { extractPlateRegions } from '@/lib/ai/plate-extractor';
import { resolveFalCredentials } from '@/lib/fal-credentials';
import { downloadDriveFile, ensureVerticalTemplateFolder, uploadClientAsset } from '@/lib/google-drive';
import { findPlateHoles } from '@/lib/poster/plate-regions';
import { validatePlateSpec, posterPlateSpecSchema } from '@/lib/types/plate-spec';

const prisma = new PrismaClient();

/**
 * How far outside a reported region the mask reaches, as a share of the poster.
 *
 * See the header: the extractor reports the column, glyphs overhang it, and a
 * mask that clips them leaves the eraser inventing letters in the middle of the
 * block. Generous is safe — the surrounding artwork reconstructs from its own
 * neighbourhood — while tight is the one setting that produces garbage.
 */
const PAD = 0.055;

function eraserEndpoint(): string {
  return process.env.FAL_ERASER_ENDPOINT || 'fal-ai/bria/eraser';
}

/** White where the type is, black everywhere else. */
async function buildMask(
  width: number,
  height: number,
  boxes: ReadonlyArray<{ x: number; y: number; w: number; h: number }>,
): Promise<Buffer> {
  const rects = boxes
    .map((b) => {
      const x = Math.max(0, Math.round((b.x - PAD) * width));
      const y = Math.max(0, Math.round((b.y - PAD) * height));
      const w = Math.min(width - x, Math.round((b.w + PAD * 2) * width));
      const h = Math.min(height - y, Math.round((b.h + PAD * 2) * height));
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="white"/>`;
    })
    .join('');

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="black"/>${rects}</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function erase(image: Buffer, mimeType: string, mask: Buffer, key: string): Promise<Buffer> {
  const response = await fetch(`https://fal.run/${eraserEndpoint()}`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      image_url: `data:${mimeType};base64,${image.toString('base64')}`,
      mask_url: `data:image/png;base64,${mask.toString('base64')}`,
      sync_mode: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`fal ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const json = (await response.json()) as {
    image?: { url?: string };
    images?: Array<{ url?: string }>;
  };
  const url = json.image?.url ?? json.images?.[0]?.url;
  if (!url) throw new Error('the eraser returned no image');

  if (url.startsWith('data:')) return Buffer.from(url.split(',')[1] ?? '', 'base64');
  return Buffer.from(await (await fetch(url)).arrayBuffer());
}

async function main() {
  const args = process.argv.slice(2);
  const replace = args.includes('--replace');

  const labelsArg = args.find((a) => a.startsWith('--labels'));
  const labelValueIndex = labelsArg && !labelsArg.includes('=') ? args.indexOf(labelsArg) + 1 : -1;
  const labels = labelsArg
    ? (labelsArg.includes('=') ? labelsArg.split('=').slice(1).join('=') : (args[labelValueIndex] ?? ''))
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const positional = args.filter(
    (a, i) => !a.startsWith('--') && i !== labelValueIndex,
  );
  const name = positional[0];
  const snapshotDir = positional[1];

  if (!name || !snapshotDir) {
    console.error(
      'Usage: autoplate-vertical.ts <vertical> <snapshotDir> [--labels a,b] [--replace]',
    );
    process.exitCode = 1;
    return;
  }

  const category = await prisma.category.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true },
  });
  if (!category) {
    console.error(`No vertical called "${name}".`);
    process.exitCode = 1;
    return;
  }

  const templates = await prisma.categoryTemplate.findMany({
    where: {
      categoryId: category.id,
      ...(labels.length > 0 ? { label: { in: labels } } : {}),
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      label: true,
      mimeType: true,
      gDriveFileId: true,
      plateDriveFileId: true,
      layoutSpec: true,
      layoutReading: true,
      layoutApprovedAt: true,
      plateViewUrl: true,
      plateWidth: true,
      plateHeight: true,
      plateSpec: true,
      plateApprovedAt: true,
      paletteSource: true,
    },
  });

  const credentials = await resolveFalCredentials();
  const folder = await ensureVerticalTemplateFolder(category.name);

  let plated = 0;
  let skipped = 0;
  let failed = 0;

  console.log(`${category.name}: ${templates.length} template(s)\n`);

  for (const template of templates) {
    if (template.plateDriveFileId && !replace) {
      skipped += 1;
      console.log(`  skip   ${template.label} — already has a plate (--replace to redo)`);
      continue;
    }

    process.stdout.write(`  ${template.label} … `);

    try {
      // Snapshotted before anything is written, so this template can be put back
      // exactly as it was. See template-snapshot.ts for why re-reading is not a
      // restore.
      const { id: _id, mimeType: _m, gDriveFileId: _g, ...columns } = template;
      await writeFile(
        `${snapshotDir}/${template.label}.json`,
        JSON.stringify({ templateId: template.id, saved: true, row: columns }, null, 2),
        'utf8',
      );

      const reference = await downloadDriveFile(template.gDriveFileId);
      const meta = await sharp(reference).metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      if (width <= 0 || height <= 0) throw new Error('reference has no readable dimensions');

      const draft = await extractPlateRegions({
        bytes: reference,
        mimeType: template.mimeType,
        label: template.label,
      });
      if (draft.regions.length === 0) throw new Error('no type found to erase');

      const mask = await buildMask(width, height, draft.regions);
      const erased = await erase(reference, template.mimeType, mask, credentials.key);

      const holes = await findPlateHoles(erased);
      if (!holes) throw new Error('the erased plate could not be decoded');

      const uploaded = await uploadClientAsset({
        folderId: folder,
        fileName: `${template.label} — autoplate.png`,
        body: erased,
        mimeType: 'image/png',
        publish: false,
      });

      const spec = posterPlateSpecSchema.parse({
        version: 1,
        name: template.label,
        aspect: holes.width / holes.height,
        photos: holes.regions,
        text: draft.regions,
        featureCount: draft.featureCount,
        featureStyle: draft.featureStyle,
        ctaShape: draft.ctaShape,
        headlineEmphasis: draft.headlineEmphasis,
        headlineCase: draft.headlineCase,
      });
      const problems = validatePlateSpec(spec);

      await prisma.categoryTemplate.update({
        where: { id: template.id },
        data: {
          plateDriveFileId: uploaded.fileId,
          plateViewUrl: uploaded.viewUrl,
          plateWidth: holes.width,
          plateHeight: holes.height,
          plateSpec: spec as unknown as Prisma.InputJsonValue,
          // Never set here, for the reason in the header: erase quality varies
          // with what sat under the type, and only a human can see that.
          plateApprovedAt: null,
          /*
           * A plate is finished artwork in its designer's colours. Setting the
           * type in a different brand's palette on top of it is how a composite
           * stops looking composed — see `paletteSource` on the model.
           */
          paletteSource: 'template',
        },
      });

      plated += 1;
      console.log(
        `plated — ${draft.regions.length} region(s), ${holes.regions.length} hole(s)` +
          (problems.length > 0
            ? `  NEEDS A FIX: ${problems.map((p) => p.message).join('; ')}`
            : ''),
      );
    } catch (error) {
      failed += 1;
      console.log(`FAILED — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(
    `\n${plated} plated, ${skipped} skipped, ${failed} failed. None approved — ` +
      'open each in the console, use "See this template rendered", and approve the ones ' +
      'whose erase came back clean.',
  );
  console.log(`Snapshots in ${snapshotDir}; restore one with template-snapshot.ts.`);

  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
