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
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

import { Prisma, PrismaClient } from '@prisma/client';
import sharp from 'sharp';

import { labelTextBlocks, unionIntoRegions } from '@/lib/ai/plate-labeller';
import { detectTextBlocks } from '@/lib/poster/text-detect';
import { resolveFalCredentials } from '@/lib/fal-credentials';
import { downloadDriveFile, ensureVerticalTemplateFolder, uploadClientAsset } from '@/lib/google-drive';
import { sampleRegionInk } from '@/lib/poster/plate-ink';
import { findPlateHoles } from '@/lib/poster/plate-regions';
import {
  validatePlateSpec,
  posterPlateSpecSchema,
  type PosterPlateSpec,
} from '@/lib/types/plate-spec';

const prisma = new PrismaClient();

/**
 * How far outside a measured block the mask reaches, as a share of the poster.
 *
 * **Small now, and only because the boxes changed.** At 5.5% this was trying to
 * compensate for boxes that described a column a model had guessed at: the mask
 * had to be generous enough to cover type that might be anywhere inside it, and
 * the cost was a moat of erased artwork around every block — plus, when the
 * guess was wrong, letterforms left standing at the edge for the eraser to
 * hallucinate from ("G ⌇⌇⌇ H", a phone number as "nnccapci30").
 *
 * `detectTextBlocks` returns the extent of the ink itself, so there is nothing
 * left to compensate for. This is now just enough to take the anti-aliased rim
 * with the glyphs.
 */
const DEFAULT_PAD = 0.012;

/**
 * How much of the poster the mask reaches beyond a reported region.
 *
 * Tunable because the right value depends on what the type sat on. 5.5% clears
 * a headline on flat colour; text over card chrome or busy photography needs
 * more, because the eraser reconstructs from what surrounds the mask and a
 * boundary that still contains letter-shapes gives it letter-shapes to copy.
 * Too much erases artwork worth keeping, so this is a dial rather than a
 * constant.
 */
function padFrom(args: string[]): number {
  const flag = args.find((a) => a.startsWith('--pad'));
  if (!flag) return DEFAULT_PAD;
  const raw = flag.includes('=')
    ? flag.split('=')[1]
    : args[args.indexOf(flag) + 1];
  const value = Number.parseFloat(raw ?? '');
  return Number.isFinite(value) && value > 0 && value < 0.5 ? value : DEFAULT_PAD;
}

function eraserEndpoint(): string {
  return process.env.FAL_ERASER_ENDPOINT || 'fal-ai/bria/eraser';
}

function cutoutEndpoint(): string {
  return process.env.FAL_CUTOUT_ENDPOINT || 'fal-ai/birefnet/v2';
}

/**
 * Where the template's own model is standing, as a normalised box, or null.
 *
 * **The reason a plate can stop supplying its own person.** A plate keeps
 * everything the designer put on it, so a template built around a photographed
 * model hands that model to every client who ever draws it — a stethoscope is
 * generic, a human face is not.
 *
 * Found with the same segmentation endpoint the pipeline already uses to matt
 * generated frames, run backwards: birefnet returns the subject on transparency,
 * so the pixels it *kept* are the person, and their extent is the box.
 *
 * Null when nothing salient is found, which is the right answer for a template
 * that is artwork and type only — there is no figure to remove and none to
 * generate.
 */
async function findSubject(
  image: Buffer,
  mimeType: string,
  key: string,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  const response = await fetch(`https://fal.run/${cutoutEndpoint()}`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      image_url: `data:${mimeType};base64,${image.toString('base64')}`,
      sync_mode: true,
    }),
  });
  if (!response.ok) return null;

  const json = (await response.json()) as {
    image?: { url?: string };
    images?: Array<{ url?: string }>;
  };
  const url = json.image?.url ?? json.images?.[0]?.url;
  if (!url) return null;

  const cut = url.startsWith('data:')
    ? Buffer.from(url.split(',')[1] ?? '', 'base64')
    : Buffer.from(await (await fetch(url)).arrayBuffer());

  const { data, info } = await sharp(cut).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  let kept = 0;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      // Well above the anti-aliased rim, so a soft edge does not inflate the box.
      if ((data[(y * info.width + x) * 4 + 3] ?? 0) < 160) continue;
      kept += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) return null;

  /*
   * Two guards against segmenting the wrong thing.
   *
   * Below 4% of the canvas it is an icon or a logo, not a person. Above 80% it
   * has selected the whole poster — which birefnet does on artwork with no
   * clear foreground — and erasing that would delete the template.
   */
  const share = kept / (info.width * info.height);
  if (share < 0.04 || share > 0.8) return null;

  return {
    x: minX / info.width,
    y: minY / info.height,
    w: (maxX - minX + 1) / info.width,
    h: (maxY - minY + 1) / info.height,
  };
}

/** White where the type is, black everywhere else. */
async function buildMask(
  width: number,
  height: number,
  boxes: ReadonlyArray<{ x: number; y: number; w: number; h: number }>,
  PAD: number,
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
  const pad = padFrom(args);
  /*
   * Leaves the template's own photographed model in place.
   *
   * The default removes them, because a plate otherwise gives every client in
   * the vertical the same face. Kept as an escape hatch for a template whose
   * figure is the design rather than a stand-in.
   */
  const keepModel = args.includes('--keep-model');

  const labelsArg = args.find((a) => a.startsWith('--labels'));
  const labelValueIndex = labelsArg && !labelsArg.includes('=') ? args.indexOf(labelsArg) + 1 : -1;
  const labels = labelsArg
    ? (labelsArg.includes('=') ? labelsArg.split('=').slice(1).join('=') : (args[labelValueIndex] ?? ''))
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  // A flag's value is a bare argument too, so drop those before reading the
  // vertical and the snapshot directory off the front.
  const padFlag = args.find((a) => a.startsWith('--pad'));
  const padValueIndex = padFlag && !padFlag.includes('=') ? args.indexOf(padFlag) + 1 : -1;
  const positional = args.filter(
    (a, i) => !a.startsWith('--') && i !== labelValueIndex && i !== padValueIndex,
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
      /*
       * Written once and never overwritten.
       *
       * A `--replace` run would otherwise snapshot the state *with* the previous
       * plate on it, so "restore" would put back the plate being replaced rather
       * than the template as it was before any of this — quietly turning the
       * revert into a no-op after the second attempt.
       */
      const snapshotPath = `${snapshotDir}/${template.label}.json`;
      const { id: _id, mimeType: _m, gDriveFileId: _g, ...columns } = template;
      if (!existsSync(snapshotPath)) {
        await writeFile(
          snapshotPath,
          JSON.stringify({ templateId: template.id, saved: true, row: columns }, null, 2),
          'utf8',
        );
      }

      const reference = await downloadDriveFile(template.gDriveFileId);
      const meta = await sharp(reference).metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      if (width <= 0 || height <= 0) throw new Error('reference has no readable dimensions');

      /*
       * Measured, then named — never estimated.
       *
       * `extractPlateRegions` used to do both here, and did the measuring so
       * badly that it is the root cause of nearly everything wrong with the
       * plate path: across the live library it returned 59 of 60 boxes with
       * every coordinate on a 0.05 grid. Those boxes placed the type *and* built
       * the mask below, so a single bad estimate misplaced the words and cleared
       * the wrong artwork at the same time.
       */
      const detection = await detectTextBlocks(reference);
      if (!detection || detection.blocks.length === 0) {
        throw new Error('no type found to erase');
      }

      const labelling = await labelTextBlocks({
        bytes: reference,
        mimeType: template.mimeType,
        label: template.label,
        blocks: detection.blocks,
      });

      /*
       * Only what the labeller recognised as words.
       *
       * A block it called `ignore` is a stethoscope, a decorative rule or a
       * patch of somebody's face — artwork the plate is supposed to keep. This
       * is what stops the mask eating the design, and it is only possible
       * because the boxes are real: an invented grid has no notion of a box that
       * should not be erased.
       */
      const wordBlocks = labelling.labelled
        .filter((entry) => entry.label !== 'ignore')
        .map((entry) => entry.block);

      if (wordBlocks.length === 0) throw new Error('every measured block was labelled ignore');

      const regions = unionIntoRegions(labelling.labelled);

      /*
       * Each region's ink colour, measured from the reference.
       *
       * `extractPlateRegions` did this internally and it went with it — leaving
       * every region's colour null, so a template on `paletteSource: "template"`
       * silently fell back to the theme and lost the designer's palette, which
       * is the entire point of that setting.
       *
       * Sequential: five or six crops of one decoded buffer is milliseconds, and
       * sharp's thread pool is shared with the erase running after it.
       */
      for (const region of regions) {
        region.color = await sampleRegionInk(reference, region);
      }

      const draft = {
        regions,
        featureCount: labelling.featureCount,
        featureStyle: labelling.featureStyle,
        ctaShape: labelling.ctaShape,
        headlineCase: labelling.headlineCase,
        // Measured, so there is no line-by-line emphasis to report any more. The
        // headline's own colours are sampled per region by `sampleRegionInk`.
        headlineEmphasis: [] as PosterPlateSpec['headlineEmphasis'],
      };
      if (draft.regions.length === 0) throw new Error('no type found to erase');

      /*
       * The template's own model is erased alongside its words, and a `subject`
       * region is left where they stood so the generated figure takes their
       * place — composited over the finished artwork, not behind a hole in it.
       *
       * Erased with a smaller pad than the type gets: a figure's outline is
       * exactly where the background has to be reconstructed, and reaching too
       * far takes the artwork around them with it.
       */
      const subject = keepModel ? null : await findSubject(reference, template.mimeType, credentials.key);

      /*
       * The mask is built from the measured *lines*, not from the slot regions.
       *
       * A slot region is the union of its lines — the column the copy is allowed
       * — and masking that would clear the ragged space beside every short line
       * along with the artwork in it. The lines are what the ink actually
       * occupies, so the eraser is asked to reconstruct only where there were
       * words. That is also why the pad below can be small: these boxes already
       * hug the glyphs.
       */
      const eraseBoxes = subject ? [...wordBlocks, subject] : wordBlocks;

      /*
       * The subject is padded by the same amount as the type and no more.
       *
       * It used to be inflated by 0.01 here and then handed to `buildMask`,
       * which added the full pad again — so the figure got a larger halo than
       * the words, while the comment beside it claimed a smaller one. A bounding
       * box round a standing person is mostly not the person, and every extra
       * percent of it is finished design being thrown away for the eraser to
       * invent.
       */
      const mask = await buildMask(width, height, eraseBoxes, pad);
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

      /*
       * A measured hole is a scene showing through; the subject box is a figure
       * standing on top. Both are photo regions and the renderer tells them
       * apart by `kind`.
       */
      const photos = subject
        ? [...holes.regions, { ...subject, kind: 'subject' as const, fit: 'contain' as const }].slice(0, 2)
        : holes.regions;

      const spec = posterPlateSpecSchema.parse({
        version: 1,
        name: template.label,
        aspect: holes.width / holes.height,
        photos,
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
          (subject ? ', model removed and replaced by a subject slot' : ', no model found') +
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
