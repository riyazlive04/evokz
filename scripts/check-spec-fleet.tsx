/**
 * Renders every layout spec stored in a database, and reports what breaks.
 *
 * The fixture suite proves the shapes someone thought to write down. This proves
 * the shapes an operator actually uploaded — a different set, and the only one
 * clients ever see. Point it at a restored production dump before a deploy, and
 * at the mirror again after a round of re-extraction.
 *
 * Read-only: it reads `CategoryTemplate` and writes nothing back. No fal.ai,
 * Drive or WhatsApp call is made and no image is bought — the photography is
 * procedural.
 *
 * Run: DATABASE_URL=… npm run check:fleet [-- <outDir>]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { Prisma, PrismaClient } from '@prisma/client';

import { getImageSizePreset } from '@/lib/image-sizes';
import { headlineColumnWidth } from '@/lib/poster/layout-render';
import { AVERAGE_CAP_ADVANCE, fitHeadline, resolveMetrics } from '@/lib/poster/metrics';
import { resolvePosterCanvas } from '@/lib/poster/canvas';
import {
  createPlaceholderPhoto,
  createPlaceholderSubject,
} from '@/lib/poster/placeholder-photo';
import { resolveSpecPhotoRequests } from '@/lib/poster/photo-request';
import { renderPoster } from '@/lib/poster/render';
import { EMPTY_BRAND_GUIDELINE } from '@/lib/types/brand';
import { parseLayoutSpec, validateLayoutSpec } from '@/lib/types/layout-spec';
import type { PosterCopy } from '@/lib/types/poster';

/**
 * Deliberately harder than a real day's copy.
 *
 * A stored spec that survives this has headroom. One that only survives short
 * words is a clipped poster waiting for the copy model to have an expansive day,
 * which is exactly how the headline fault reached production unnoticed.
 */
const COPY: PosterCopy = {
  headlineLines: ['COMPREHENSIVE', 'DIAGNOSTIC CARE', 'YOU CAN TRUST'],
  accentLineIndex: 2,
  eyebrow: 'NOW OPEN',
  body: 'Celebrate our new journey with special prices across everything we offer, for as long as the promotion runs.',
  features: [
    {
      icon: 'shieldCheck',
      label: 'Quality assurance',
      body: 'Our products meet the highest standards of safety.',
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
    {
      icon: 'people',
      label: 'Walk-ins welcome',
      body: 'No booking needed at any hour we are open.',
    },
  ],
  callLabel: 'CONTACT US TODAY',
  websiteLabel: 'FOLLOW OUR SOCIAL MEDIA',
  ctaLabel: 'BOOK A SITE VISIT',
  headlinePeriod: true,
};

const PRESETS = [
  'whatsapp-status',
  'instagram-portrait',
  'instagram-square',
  'instagram-landscape',
  'desktop-ultrawide',
];

interface Fault {
  template: string;
  vertical: string;
  approved: boolean;
  detail: string;
}

async function main() {
  const outDir = process.argv[2] ?? null;
  if (outDir) await mkdir(outDir, { recursive: true });

  const db = new PrismaClient();
  const rows = await db.categoryTemplate.findMany({
    where: { layoutSpec: { not: Prisma.DbNull } },
    select: {
      label: true,
      layoutApprovedAt: true,
      layoutSpec: true,
      width: true,
      height: true,
      category: {
        select: { name: true, clients: { select: { imageSizePreset: true } } },
      },
    },
    orderBy: [{ category: { name: 'asc' } }, { label: 'asc' }],
  });

  const logoBytes = await readFile(
    new URL('../../sample_logo-removebg-preview.png', import.meta.url),
  );
  const logoUri = `data:image/png;base64,${logoBytes.toString('base64')}`;

  const faults: Fault[] = [];
  const byVertical = new Map<
    string,
    { total: number; approved: number; faulty: Set<string> }
  >();
  let rendered = 0;

  for (const row of rows) {
    const vertical = row.category.name;
    const approved = row.layoutApprovedAt !== null;
    const tally = byVertical.get(vertical) ?? {
      total: 0,
      approved: 0,
      faulty: new Set<string>(),
    };
    tally.total += 1;
    if (approved) tally.approved += 1;
    byVertical.set(vertical, tally);

    const note = (detail: string) => {
      faults.push({ template: row.label, vertical, approved, detail });
      tally.faulty.add(row.label);
    };

    // Through `parseLayoutSpec`, not trusted — the same door the render path
    // uses, so a spec this build cannot read fails here rather than live.
    const spec = parseLayoutSpec(row.layoutSpec);
    if (!spec) {
      note('spec does not parse in this build');
      continue;
    }

    const problems = validateLayoutSpec(spec);
    for (const problem of problems) note(`invalid: ${problem.path} ${problem.message}`);
    if (problems.length > 0) continue;

    /*
     * Does this spec know its own shape?
     *
     * This block used to compare the reference's aspect against the presets the
     * vertical's clients were set to, and report the mismatch — because a spec
     * recorded band order and column splits but never the aspect it was read
     * from, so a square 600x600 template drawn onto a 9:16 canvas kept its type
     * at reference size while the frame grew 42% taller, and every plain-ground
     * margin the reference had opened into a half-poster void. Four live
     * Individuals templates were doing exactly that.
     *
     * The mismatch is no longer possible for a spec that carries `aspect`:
     * `resolvePosterCanvas` gives it its own proportions and the preset only
     * sets the resolution. So the finding moved one step earlier — the fault is
     * now a spec with *no* stored aspect, which still falls back to the client's
     * preset and can still open those holes. The fix is to re-read the template,
     * which is a sentence an operator can act on rather than a ratio comparison.
     */
    if (spec.aspect <= 0) {
      const reference =
        row.width && row.height
          ? `${row.width}x${row.height} (${(row.width / row.height).toFixed(2)}:1)`
          : 'an unmeasurable file';
      note(
        `no stored aspect — this spec predates template-shaped canvases, so its ` +
          `posters are drawn at whatever preset each client is set to rather than at ` +
          `${reference}. Re-read and re-approve it.`,
      );
    } else if (row.width && row.height) {
      // The spec's aspect is written from these columns at extraction, so a
      // disagreement means the file was replaced without re-reading it.
      const measured = row.width / row.height;
      if (Math.abs(measured - spec.aspect) / measured > 0.02) {
        note(
          `stored aspect ${spec.aspect.toFixed(2)}:1 disagrees with the file's own ` +
            `${measured.toFixed(2)}:1 — re-read it.`,
        );
      }
    }

    for (const presetId of PRESETS) {
      const preset = getImageSizePreset(presetId)!;
      // The canvas production would actually draw on: the template's shape at
      // the preset's resolution. Checking the raw preset would test a poster no
      // client receives.
      const canvas = resolvePosterCanvas(spec, preset);
      const metrics = resolveMetrics(canvas.width, canvas.height, spec.aspect);

      // The fault this script exists for: a headline sliced by its own column.
      const room = headlineColumnWidth(spec, metrics);
      const fit = fitHeadline(metrics, COPY.headlineLines, room);
      const units = fit.wrap
        ? COPY.headlineLines.flatMap((line) => line.split(/\s+/))
        : COPY.headlineLines;
      const longest = units.reduce((max, unit) => Math.max(max, unit.length), 0);
      const predicted = longest * fit.size * AVERAGE_CAP_ADVANCE;
      if (predicted > room) {
        note(
          `${presetId}: headline needs ${Math.round(predicted)}px in a ` +
            `${Math.round(room)}px column`,
        );
      }

      try {
        const requests = resolveSpecPhotoRequests(spec, canvas);
        const photos = requests.map((request, index) =>
          request.kind === 'subject'
            ? createPlaceholderSubject(
                Math.min(request.width, 1024),
                Math.min(request.height, 1024),
              )
            : createPlaceholderPhoto(
                Math.min(request.width, 1024),
                Math.min(request.height, 1024),
                index % 2 === 0 ? 'daylight' : 'dusk',
              ),
        );
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
          photos:
            photos.length > 0 ? photos : [createPlaceholderPhoto(1024, 1024, 'daylight')],
          width: canvas.width,
          height: canvas.height,
        });
        rendered += 1;
        if (outDir) {
          const slug = `${vertical}-${row.label}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
          await writeFile(`${outDir}/${slug}-${canvas.width}x${canvas.height}.png`, poster.body);
        }
      } catch (error) {
        note(
          `${presetId}: render threw — ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  await db.$disconnect();

  console.log(`\n=== ${rows.length} stored specs, ${rendered} renders ===\n`);
  for (const [vertical, tally] of [...byVertical].sort()) {
    const liveFaults = faults.some((f) => f.vertical === vertical && f.approved);
    const state = liveFaults ? 'FAIL' : tally.faulty.size === 0 ? 'ok  ' : 'warn';
    console.log(
      `  ${state} ${vertical}: ${tally.total} spec(s), ${tally.approved} approved` +
        (tally.faulty.size > 0 ? ` — ${tally.faulty.size} faulty` : ''),
    );
  }

  /*
   * Only an approved template can fail the run.
   *
   * A draft that does not parse is already out of rotation — `resolveDayLayout`
   * will not choose it, and the console shows the operator why. Failing the gate
   * on one would mean a deploy blocked by a template nobody has finished
   * reading, which is how people learn to ignore a gate. Approved is the line,
   * because approved is what reaches a client.
   */
  const live = faults.filter((fault) => fault.approved);
  const drafts = faults.filter((fault) => !fault.approved);

  if (drafts.length > 0) {
    console.log(`\n${drafts.length} draft(s) to re-read before they can be approved:\n`);
    for (const fault of drafts) {
      console.log(`  ${fault.vertical} / ${fault.template}`);
      console.log(`    ${fault.detail}`);
    }
  }

  if (live.length > 0) {
    console.error(`\n${live.length} fault(s) in APPROVED templates — these reach clients:\n`);
    for (const fault of live) {
      console.error(`  ${fault.vertical} / ${fault.template}`);
      console.error(`    ${fault.detail}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('\nEvery approved spec renders cleanly at every preset.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
