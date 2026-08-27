/**
 * Refetches the bundled poster typefaces from Google Fonts.
 *
 * Run by hand, never at render: production has hit a blocked
 * `fonts.googleapis.com`, and a renderer that reaches for a font over the
 * network fails there in the worst possible way — by silently substituting a
 * system face and shipping a poster that looks fine to everyone except the
 * client who knows their own brand.
 *
 * Two things here are the opposite of `src/lib/poster/fonts.ts`, which serves
 * satori:
 *
 *   · A **modern** User-Agent. satori cannot parse WOFF2 and needs Google to
 *     downgrade to WOFF; Chromium wants WOFF2 and nothing else is worth the
 *     bytes.
 *   · Only the **latin** subset is kept. Google publishes one file per
 *     unicode-range, and shipping all of them would multiply the embedded
 *     base64 for glyphs no poster will ever set.
 *
 * Both families are variable, so one file covers every weight — and, for
 * Archivo, every width. The reference set's headlines are set in a condensed
 * grotesque, and the width axis is what lets a template reach that without
 * bundling a second family.
 *
 * Run: node scripts/refresh-poster-fonts.mjs
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

const FACES = [
  // Axis order in the query must be alphabetical or the API 400s.
  { family: 'Archivo', axes: 'wdth,wght@62..125,400..900', out: 'Archivo-var.woff2' },
  { family: 'Inter', axes: 'wght@400..700', out: 'Inter-var.woff2' },
];

const OUT_DIR = join(process.cwd(), 'src', 'lib', 'poster', 'fonts');

for (const face of FACES) {
  const url =
    `https://fonts.googleapis.com/css2?family=${encodeURIComponent(face.family)}:` +
    `${face.axes}&display=block`;

  const css = await (await fetch(url, { headers: { 'User-Agent': UA } })).text();

  // The latin block is the one whose unicode-range starts at U+0000-00FF. Named
  // by its range rather than by position: Google orders the blocks differently
  // between families, and taking the first one silently ships Vietnamese.
  const block = css.split('@font-face').find((part) => part.includes('U+0000-00FF'));
  if (!block) throw new Error(`no latin subset in the CSS for ${face.family}`);

  const source = block.match(/url\((https:[^)]+\.woff2)\)/);
  if (!source) throw new Error(`no woff2 source for ${face.family}`);

  const bytes = Buffer.from(
    await (await fetch(source[1], { headers: { 'User-Agent': UA } })).arrayBuffer(),
  );
  await writeFile(join(OUT_DIR, face.out), bytes);

  const descriptors = block.match(/font-(?:weight|stretch):[^;]+;/g) ?? [];
  console.log(
    `${face.family.padEnd(9)} ${String(bytes.length).padStart(6)} bytes  ` +
      `${descriptors.join(' ')}  → ${face.out}`,
  );
}
