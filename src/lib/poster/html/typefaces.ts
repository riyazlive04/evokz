import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { optionalEnv } from '@/lib/env';

/**
 * The typefaces every template draws with, embedded as data URIs.
 *
 * **Bundled, not fetched.** `src/lib/poster/fonts.ts` pulls TTFs from
 * `fonts.googleapis.com` at render time, which production has already seen
 * blocked once. A poster that silently falls back to a system face is worse than
 * one that fails: it looks like a poster, so nobody looks twice, and it goes to
 * a paying client set in whatever Chromium found lying around.
 *
 * Embedded as `@font-face { src: url(data:...) }` rather than installed into the
 * image with `fc-cache`, for the same reason satori was handed buffers: the page
 * then depends on nothing outside the string it was given. It also removes a
 * whole class of platform drift — the Windows dev machine and the Debian
 * container have entirely different system font sets, and the poster has to
 * render identically on both or a local preview stops predicting production.
 *
 * Both files are the **latin subset of the variable font**: one file per family
 * covering every weight — and, for Archivo, every width. Static weights would
 * have been four files per family and a worse result, because the designs want
 * weights (600, 800) that sit between the statics Google publishes, and because
 * the reference headlines are condensed, which no static Archivo is.
 *
 * Fetched with a *modern* User-Agent, which is the exact opposite of what
 * `fonts.ts` does — satori cannot parse WOFF2 and needs Google to downgrade,
 * whereas Chromium wants WOFF2 and nothing else is worth shipping. Refresh them
 * with `npm run fonts:refresh`.
 */

interface Typeface {
  family: string;
  file: string;
  /** The variable font's weight axis range, for the `@font-face` descriptor. */
  weights: string;
  /**
   * The width axis range, where the family publishes one.
   *
   * Load-bearing rather than decorative: without a `font-stretch` descriptor
   * naming the range, Chromium clamps the axis to 100% and a template asking for
   * condensed type silently gets regular. The reference set's headlines are all
   * condensed grotesques, so this is what lets one bundled family reach them.
   */
  widths?: string;
}

/**
 * Display and text.
 *
 * Archivo is the closest published grotesque to the reference set's headline
 * face — the Medicals references are set in a tightly-spaced heavy grotesque
 * with flat terminals, and Archivo at 700–800 with negative tracking is a near
 * match. Inter carries the labels and body, where the references use a plainer
 * humanist face.
 *
 * A template is free to ask for either. It is not free to ask for a third: an
 * unbundled family would resolve to a system fallback in dev and to nothing in
 * the container, which is precisely the silent substitution this file exists to
 * prevent. `check:templates` fails a template naming a family not listed here.
 */
export const BUNDLED_TYPEFACES: readonly Typeface[] = [
  { family: 'Archivo', file: 'Archivo-var.woff2', weights: '400 900', widths: '62% 125%' },
  { family: 'Inter', file: 'Inter-var.woff2', weights: '400 700' },
];

export const BUNDLED_FAMILIES: readonly string[] = BUNDLED_TYPEFACES.map(
  (face) => face.family,
);

function fontDir(): string {
  const override = optionalEnv('POSTER_HTML_FONT_DIR', '');
  return override || join(process.cwd(), 'src', 'lib', 'poster', 'fonts');
}

/**
 * Process-lifetime cache of the assembled `<style>` block.
 *
 * Roughly 115 KB of base64 that is identical for every poster this process ever
 * draws, so reading and encoding it per render would be pure waste — the same
 * argument the logo cache makes.
 */
let cached: Promise<string> | null = null;

export function fontFaceCss(): Promise<string> {
  if (!cached) {
    cached = buildFontFaceCss();
    cached.catch(() => {
      cached = null;
    });
  }
  return cached;
}

async function buildFontFaceCss(): Promise<string> {
  const blocks = await Promise.all(
    BUNDLED_TYPEFACES.map(async (face) => {
      const path = join(fontDir(), face.file);
      let bytes: Buffer;
      try {
        bytes = await readFile(path);
      } catch (error: unknown) {
        throw new Error(
          `Poster typeface "${face.family}" was not found at ${path}. In production ` +
            'this means the image did not copy src/lib/poster/fonts — see the runner ' +
            `stage of the Dockerfile. (${describe(error)})`,
        );
      }

      return [
        '@font-face {',
        `  font-family: "${face.family}";`,
        `  font-weight: ${face.weights};`,
        ...(face.widths ? [`  font-stretch: ${face.widths};`] : []),
        '  font-style: normal;',
        // `block` rather than `swap`: a swap would let the screenshot catch the
        // fallback face if it fired between load and paint, which is a poster
        // set in the wrong font and no error anywhere. The render already waits
        // on `document.fonts.ready`, so blocking costs nothing.
        '  font-display: block;',
        `  src: url(data:font/woff2;base64,${bytes.toString('base64')}) format("woff2");`,
        '}',
      ].join('\n');
    }),
  );

  return blocks.join('\n\n');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
