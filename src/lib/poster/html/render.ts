import {
  fillPoster,
  fitText,
  type HtmlPosterModel,
  type HtmlRepeatItem,
} from '@/lib/poster/html/fill';
import type { Page } from 'playwright';

import { posterBrowser, renderTimeoutMs } from '@/lib/poster/html/browser';
import { fontFaceCss } from '@/lib/poster/html/typefaces';
import {
  loadBaseCss,
  loadKitSprite,
  type HtmlTemplate,
} from '@/lib/poster/html/template';
import type { PosterCopy, PosterIdentity, PosterPhoto } from '@/lib/types/poster';

/**
 * Draws one poster by screenshotting a template.
 *
 * The whole of the previous renderer's geometry layer — the 940×1568 reference
 * grid, the row/cell interpreter, the metrics table, the headline fitter — has
 * no counterpart here, and that is the point. A template is a stylesheet, so its
 * geometry is whatever CSS the designer's reference actually needs, and long copy
 * reflows instead of clipping because that is what a browser does with text.
 *
 * What is left to do at render time is small: build a document, hand it the
 * client's words and pictures, wait for the fonts, take the picture.
 */

export interface HtmlRenderInput {
  template: HtmlTemplate;
  copy: PosterCopy;
  identity: PosterIdentity;
  /** Frames in manifest order. A zero-size entry is a deliberate hole. */
  photos: PosterPhoto[];
  width: number;
  height: number;
  /**
   * Called with the live page just before the screenshot.
   *
   * Only `check:templates` passes this, and only to assert things that stop
   * being observable once the page is a PNG — that a headline holding
   * `<script>` produced a text node and not an element, above all. The
   * alternative was to re-implement `buildDocument` inside the check, where it
   * could drift from the real one and quietly stop testing anything.
   */
  inspect?: (page: Page) => Promise<void>;
}

export async function renderHtmlPoster(input: HtmlRenderInput): Promise<Buffer> {
  const { template, width, height } = input;
  const markup = await buildDocument(template, width, height);
  const model = buildModel(input);

  const browser = await posterBrowser();
  /*
   * A context per render rather than a shared one. Two clients' posters must not
   * be able to see each other's data URIs through any cache, and a context is
   * the boundary Chromium actually enforces; it also means a page that wedges
   * takes nothing else down with it.
   */
  const context = await browser.newContext({
    viewport: { width, height },
    // The page carries its own pixels. Scaling happens in CSS (see the `zoom` in
    // `buildDocument`) so that text is laid out at final size and rasterised
    // crisply, rather than drawn small and resampled up.
    deviceScaleFactor: 1,
    // Nothing in a poster depends on locale, and leaving it to the host would
    // let a Windows dev machine and a Debian container disagree about digit
    // shaping and default fallback fonts.
    locale: 'en-GB',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });

  try {
    const page = await context.newPage();
    page.setDefaultTimeout(renderTimeoutMs());

    /*
     * Every request that is not the document itself is refused.
     *
     * Belt and braces over the fact that templates are self-contained: a
     * template that acquired a Google Fonts <link> or a remote <img> would
     * otherwise render correctly on the dev machine and then, in production —
     * where fonts.googleapis.com has been blocked before — either hang the
     * render or silently substitute a system face. Failing the request makes
     * that a visible defect the first time it is previewed.
     */
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('data:') || url.startsWith('about:')) return route.continue();
      return route.abort();
    });

    /*
     * `page.evaluate` works by stringifying the function and eval'ing it inside
     * the page, so the function arrives carrying whatever helpers the bundler
     * wrapped it in — and esbuild's `keepNames` (which tsx turns on, so every
     * check script hits this) emits calls to a `__name` helper that exists only
     * in the Node bundle. Without this shim `fillPoster` dies on its first line
     * with a bare "ReferenceError: __name is not defined" that says nothing
     * about bundlers.
     *
     * Injected as a literal string rather than a function for the obvious
     * reason: a function passed here would be stringified by the same machinery
     * and would need the same helper.
     */
    await page.setContent(markup, { waitUntil: 'domcontentloaded' });

    // Evaluated as a *string* rather than a function, and after setContent
    // rather than through addInitScript: an init script only runs on a real
    // navigation, and setContent replaces the document in place, so one
    // registered here never fires at all.
    await page.evaluate(
      'globalThis.__name = globalThis.__name || function (fn) { return fn; };',
    );

    // The copy crosses into the page here, as a structured clone rather than as
    // markup. See the note at the top of fill.ts for why that removes escaping
    // from the problem entirely.
    const report = await page.evaluate(fillPoster, model);

    if (report.unknown.length > 0) {
      // A slot the model has no value for is a renamed or mistyped `data-slot`,
      // and the element has been removed — so the poster would be delivered with
      // a hole in it and nothing in the log. Loud, because it is a template bug
      // and template bugs reach every client using that template.
      throw new Error(
        `Template "${template.slug}" declares slot(s) the renderer has no value for: ` +
          `${[...new Set(report.unknown)].join(', ')}. Either the markup or ` +
          'buildModel() in html/render.ts is out of date.',
      );
    }

    /*
     * Fonts before pixels. `setContent` resolves on DOMContentLoaded, which is
     * before the embedded faces have been decoded, and screenshotting there
     * catches the poster set in whatever Chromium had to hand. `font-display:
     * block` keeps that from being a visible fallback, but it would still be a
     * blank headline.
     */
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    // Only now can type be measured — see the note on `fitText`. Anything it
    // shrank is reported, because the honest fix for a headline that did not fit
    // is shorter copy, and nobody will write shorter copy they were never told
    // about.
    const shrunk = await page.evaluate(fitText);
    for (const change of shrunk) {
      console.info(
        `[ace:poster] template "${template.slug}": a block was shrunk from ` +
          `${change.from.toFixed(0)}px to ${change.to.toFixed(0)}px` +
          `${change.wrapped ? ' and re-wrapped' : ''} to fit its copy.`,
      );
    }

    if (input.inspect) await input.inspect(page);

    const body = await page.screenshot({ type: 'png', animations: 'disabled' });

    if (body.byteLength === 0) {
      throw new Error('The poster renderer produced an empty image');
    }
    return body;
  } finally {
    // The context, not the browser: the browser is a process-lifetime singleton.
    await context.close().catch(() => undefined);
  }
}

/**
 * Wraps a template's markup in the document that will actually be rendered.
 *
 * The template file holds no `<html>`, `<head>` or reset of its own — that is
 * this function's job, so that a fix to the reset reaches all 24 templates
 * rather than 24 copies of it drifting apart.
 */
async function buildDocument(
  template: HtmlTemplate,
  width: number,
  height: number,
): Promise<string> {
  const [fonts, kit, base] = await Promise.all([
    fontFaceCss(),
    loadKitSprite(),
    loadBaseCss(),
  ]);

  /*
   * The template's stylesheet is written in the reference's own pixels — the
   * numbers its author measured off the reference JPEG — and the whole stage is
   * zoomed to the output canvas.
   *
   * `zoom` rather than `transform: scale()` deliberately. A transform rasterises
   * the layer and then scales the result, so a 900px design blown up to 1080
   * arrives soft; `zoom` scales the layout *before* rasterisation, so the type is
   * laid out and drawn at final size. It is also why the browser context uses a
   * deviceScaleFactor of 1 — the two would multiply.
   *
   * The stage's height comes from the canvas rather than from the manifest's
   * aspect, so that a canvas which is a pixel off the reference's ratio stretches
   * the design imperceptibly instead of leaving a strip of background. The canvas
   * is already derived from the template's aspect by `resolvePosterCanvas`, so
   * the two disagree by at most the even-edge rounding.
   */
  const zoom = width / template.manifest.referenceWidth;

  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<style>',
    fonts,
    `*, *::before, *::after { box-sizing: border-box; }`,
    'html, body { margin: 0; padding: 0; }',
    `body { width: ${width}px; height: ${height}px; overflow: hidden; }`,
    '#poster-stage {',
    `  zoom: ${zoom};`,
    `  width: ${template.manifest.referenceWidth}px;`,
    `  height: ${height / zoom}px;`,
    '  position: relative;',
    '  overflow: hidden;',
    // Text rendering settled here rather than per template, for the same reason
    // the reset is: it has to be identical across the fleet or two templates
    // set the same headline at two different widths.
    '  -webkit-font-smoothing: antialiased;',
    '  text-rendering: geometricPrecision;',
    '}',
    // After the reset and before the template's own rules, so a template
    // overrides any of it by simply restating the declaration.
    base,
    '</style></head><body>',
    // The sprite first, so a `<use>` in the template always resolves against a
    // symbol that is already in the document.
    kit,
    `<div id="poster-stage">${template.html}</div>`,
    '</body></html>',
  ].join('\n');
}

/**
 * What the template's slots are filled with.
 *
 * The one place that knows both `PosterCopy`'s field names and the slot names a
 * template may use. A template cannot invent a slot — an unrecognised one is a
 * hard error at render, above — which is what keeps the data seam narrow while
 * the design stays unconstrained.
 */
function buildModel(input: HtmlRenderInput): HtmlPosterModel {
  const { copy, identity, template } = input;

  /*
   * Which line is accented is decided here, in TypeScript; what accented *looks
   * like* is decided in the template's CSS. Clamped rather than trusted:
   * `accentLineIndex` is written by a language model against a headline it may
   * have since trimmed, and an out-of-range index would silently leave the
   * poster with no accent at all.
   */
  const accent = Math.min(
    Math.max(copy.accentLineIndex, 0),
    Math.max(copy.headlineLines.length - 1, 0),
  );

  const headline: HtmlRepeatItem[] = copy.headlineLines.map((line, index) => {
    const last = index === copy.headlineLines.length - 1;
    const mark: Record<string, string> = {};
    if (index === accent) mark.accent = 'true';
    // The trailing full stop is a tic the reference set carries on 5 of 12
    // designs, so it belongs to the copy rather than to the template — and it
    // goes on the last line, not on every one.
    return { text: { line: copy.headlinePeriod && last ? `${line}.` : line }, mark };
  });

  const text: Record<string, string> = {
    eyebrow: copy.eyebrow,
    body: copy.body,
    callLabel: copy.callLabel,
    websiteLabel: copy.websiteLabel,
    ctaLabel: copy.ctaLabel,
    phone: identity.phone,
    website: identity.website ?? '',
    companyName: identity.logoIncludesName && identity.logoDataUri ? '' : identity.companyName,
    tagline: identity.brandTagline ?? '',
  };

  const present: Record<string, boolean> = {};

  /*
   * Features are numbered slots rather than a repeat, because in these designs
   * the icon belongs to the *card* and not to the copy — the reference draws a
   * stethoscope, a microscope, a therapist and a scanner, in that order, and
   * they are the designer's drawings. A repeat would clone one card four times
   * and give all four the same icon, which is how the old renderer ended up
   * choosing icons from its own set instead of the designer's.
   *
   * A template with more cards than the day has features drops the surplus
   * cards through `data-when`, rather than leaving an iconned card with no
   * words under it.
   */
  for (let index = 0; index < template.manifest.featureCount; index += 1) {
    const feature = copy.features[index];
    const key = `feature${index + 1}`;
    text[`${key}Label`] = feature?.label ?? '';
    text[`${key}Body`] = feature?.body ?? '';
    present[key] = feature !== undefined;
  }

  present.website = Boolean(identity.website);
  present.tagline = Boolean(identity.brandTagline);
  present.logo = Boolean(identity.logoDataUri);

  const images: Record<string, string | null> = {
    logo: identity.logoDataUri,
  };

  template.manifest.photos.forEach((photo, index) => {
    const frame = input.photos[index] ?? input.photos[input.photos.length - 1];
    // A zero-length frame is a deliberate hole — the pipeline pushes one when a
    // backdrop was declared and the day carried no `backgroundPrompt` — and the
    // element is removed so the template's own ground shows through.
    images[photo.name] = frame && frame.dataUri ? frame.dataUri : null;
  });

  return { text, images, repeats: { headline }, present };
}
