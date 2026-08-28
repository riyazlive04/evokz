/**
 * Renders one template to a PNG, for looking at.
 *
 * `check:templates` renders all twenty-three across four copy shapes, which is
 * the right thing before a commit and far too slow a loop when the question is
 * "does this chevron land where the reference has it". This renders one, with
 * copy shaped like the reference's own, and writes it where it can be opened.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.json scripts/render-one.ts con-sm-01
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getImageSizePreset } from '@/lib/image-sizes';
import { resolvePosterCanvas } from '@/lib/poster/canvas';
import { closePosterBrowser } from '@/lib/poster/html/browser';
import { renderHtmlPoster } from '@/lib/poster/html/render';
import {
  loadHtmlTemplate,
  type HtmlTemplateSlug,
} from '@/lib/poster/html/template';
import { resolveTemplatePhotoRequests } from '@/lib/poster/photo-request';
import {
  createPlaceholderPhoto,
  createPlaceholderSubject,
} from '@/lib/poster/placeholder-photo';
import type { PosterCopy, PosterIdentity } from '@/lib/types/poster';

/** The same stand-in lockup `check:templates` uses, so the two agree. */
const LOGO =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMTAgMjA0Ij48cGF0aCBkPSJNMTM4IDhoMzR2MjZoMjZ2MzRoLTI2djI2aC0zNFY2OGgtMjZWMzRoMjZ6IiBmaWxsPSIjMTIzYTYzIi8+PHBhdGggZD0iTTE4MCAxNGMyMiAxMCAzMCAzNCAyMiA1Ni04IDIxLTMwIDMwLTUyIDI2IDI2LTYgNDAtMjIgNDItNDIgMS0xNi00LTMwLTEyLTQweiIgZmlsbD0iIzBkODE4OSIvPjxyZWN0IHg9IjE2IiB5PSIxMTIiIHdpZHRoPSIyNzgiIGhlaWdodD0iMzQiIHJ4PSI2IiBmaWxsPSIjMTIzYTYzIi8+PHJlY3QgeD0iNjAiIHk9IjE2NCIgd2lkdGg9IjE5MCIgaGVpZ2h0PSIxMiIgcng9IjYiIGZpbGw9IiMwZDgxODkiLz48L3N2Zz4=';

const IDENTITY: PosterIdentity = {
  companyName: 'Meridian Build',
  logoDataUri: LOGO,
  logoIncludesName: false,
  brandTagline: 'We build it right',
  phone: '+91 12345 67890',
  website: 'www.meridianbuild.in',
};

const COPY: PosterCopy = {
  headlineLines: ['WE BUILD', 'MORE THAN STRUCTURES'],
  accentLineIndex: 2,
  headlinePeriod: false,
  eyebrow: 'We build trust',
  body: 'Structure, finishes and services from one team, signed off room by room.',
  features: [
    { icon: 'shieldCheck', label: 'Quality', body: 'Checked at every stage, not only at handover.' },
    { icon: 'hardHat', label: 'Safety', body: 'Site rules that are enforced, on every shift.' },
    { icon: 'handshake', label: 'Integrity', body: 'One quote, held to. No surprises at the end.' },
    { icon: 'award', label: 'Commitment', body: 'We finish, and we stand behind the finish.' },
  ],
  ctaLabel: 'From vision to reality',
  callLabel: 'Call',
  websiteLabel: 'Visit',
};

async function main(): Promise<void> {
  const slug = (process.argv[2] ?? 'con-sm-01') as HtmlTemplateSlug;
  const template = await loadHtmlTemplate(slug);

  const preset = getImageSizePreset('whatsapp-status') ?? { width: 1080, height: 1920 };
  const canvas = resolvePosterCanvas(
    { aspect: template.manifest.aspect, name: template.manifest.label },
    preset,
  );

  const photos = resolveTemplatePhotoRequests(template.manifest, canvas).map((request) => {
    const bytes =
      request.kind === 'subject'
        ? createPlaceholderSubject(request.width, request.height)
        : createPlaceholderPhoto(request.width, request.height, 'daylight');
    return {
      dataUri: `data:image/png;base64,${bytes.toString('base64')}`,
      width: request.width,
      height: request.height,
    };
  });

  const png = await renderHtmlPoster({
    template,
    copy: COPY,
    identity: IDENTITY,
    photos,
    width: canvas.width,
    height: canvas.height,
    onLayoutProblems: (problems) => {
      for (const problem of problems) {
        console.log(`  ${problem.kind}: ${problem.detail}`);
      }
    },
  });

  const out = join('snapshots', 'templates', `${slug}.look.png`);
  await writeFile(out, png);
  console.log(`${canvas.width}x${canvas.height} -> ${out}`);
  await closePosterBrowser();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
