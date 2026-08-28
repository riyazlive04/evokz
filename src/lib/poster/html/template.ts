import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { optionalEnv } from '@/lib/env';

/**
 * The HTML template format: what a template file is, and what it promises.
 *
 * A template is one self-contained `.html` file holding the markup and all of
 * its CSS. **Its colours are hardcoded** — there is no per-client palette, so a
 * client using this template gets this template's colours. Its *words* are not:
 * every string a client varies arrives at render time and is written into the
 * DOM by `fill.ts`, never concatenated into the markup.
 *
 * The whole substitution vocabulary is four attributes. It is deliberately this
 * small: the previous renderer failed because its JSON vocabulary was closed and
 * a designer's mark had no word in it. Here the *design* has no vocabulary at
 * all — it is CSS — and only the *data seam* is constrained.
 *
 *   data-slot="name"    this element's textContent becomes the named string.
 *                       The element must be empty in the file; the lint enforces
 *                       that, because a template that shipped literal copy would
 *                       look perfectly correct in review and would send one
 *                       client's phone number to every other client.
 *   data-image="name"   an <img> gets its src, anything else its background-image.
 *   data-repeat="name"  a <template> cloned once per item in the named array.
 *                       data-slot inside it resolves against the item.
 *   data-when="name"    the element is dropped unless the named condition holds.
 *
 * Anything absent or empty is *removed* rather than left blank, so an unset
 * eyebrow or a client with no website collapses its own row instead of holding
 * an empty box open. That rule is why `data-when` is needed so rarely.
 *
 * The manifest below is the one thing the pipeline reads without rendering: it
 * decides what photographs to buy and at what size, so it has to be answerable
 * before a browser is launched.
 */

const photoSchema = z.object({
  /** Matches a `data-image` name in the markup. */
  name: z.string().trim().min(1),
  /**
   * `subject` frames are prompted for an isolated figure and background-removed
   * before they reach the renderer; `scene` frames pass the day's brief through
   * verbatim. Mirrors `LayoutPhotoKind` — the pipeline already branches on it.
   */
  kind: z.enum(['scene', 'subject']),
  /** `slot` draws on the day's `imagePrompt`, `backdrop` on its `backgroundPrompt`. */
  role: z.enum(['slot', 'backdrop']),
  /**
   * The pixel box this frame is drawn into at the template's own reference size.
   * Scaled to the real canvas by `resolveTemplatePhotoRequests`, exactly as the
   * spec path scales its cells — buying a 900px frame for an 1800px canvas is
   * the cheapest way to ship a soft poster.
   */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Reported in the pipeline log, so an operator can see what was bought and why. */
  reason: z.string().trim().min(1),
});

export const templateManifestSchema = z.object({
  /**
   * The `CategoryTemplate.label` this file draws. The registry is keyed on it,
   * which is what lets a template move from the spec renderer to this one by
   * adding a file — no database change, no migration.
   */
  label: z.string().trim().min(1),
  /** Width ÷ height of the reference. `resolvePosterCanvas` still sets the pixels. */
  aspect: z.number().positive(),
  /**
   * The reference's own pixel size. The stylesheet is written against it and the
   * whole document is scaled by `width / referenceWidth`, so a template author
   * works in the numbers they measured off the reference JPEG rather than in
   * percentages of an unknown canvas.
   */
  referenceWidth: z.number().int().positive(),
  photos: z.array(photoSchema).default([]),
  /**
   * How many feature entries the design has room for. The copy stage writes
   * 2–4; a template showing four cards and given two would otherwise leave two
   * gaps in a row that reads as a set.
   */
  featureCount: z.number().int().min(0).max(6).default(0),
});

export type TemplateManifest = z.infer<typeof templateManifestSchema>;

/**
 * What a template actually draws, read off its own markup.
 *
 * Derived rather than declared, and that is the point: the `data-slot`,
 * `data-image` and `data-when` names in the file *are* the list of things the
 * design puts on the poster, so anything that needs to know — the sheet an
 * operator fills in, the check that a row carries neither one field too many nor
 * one too few — can ask the template instead of being told separately and
 * drifting from it.
 *
 * It is also what makes a template nobody has seen yet safe: upload one
 * tomorrow and its contract is correct the moment the file exists.
 */
export interface TemplateContract {
  /** `data-slot` names, including those inside a repeat. */
  text: readonly string[];
  /** `data-image` names. */
  images: readonly string[];
  /** `data-when` condition names. */
  conditions: readonly string[];
}

export interface HtmlTemplate {
  slug: string;
  manifest: TemplateManifest;
  contract: TemplateContract;
  /** The file, verbatim. The manifest block is still in it and is inert. */
  html: string;
}

/** The fields of `PosterCopy` and `PosterIdentity` a template puts on the page. */
export interface TemplateCopyNeeds {
  eyebrow: boolean;
  body: boolean;
  ctaLabel: boolean;
  callLabel: boolean;
  websiteLabel: boolean;
  website: boolean;
  tagline: boolean;
  phone: boolean;
  logo: boolean;
  /**
   * How many features the design draws — from the manifest, which is the
   * authority, with the markup checked against it by `check:templates`.
   */
  features: number;
}

export function copyNeedsOf(template: HtmlTemplate): TemplateCopyNeeds {
  const text = new Set(template.contract.text);
  return {
    eyebrow: text.has('eyebrow'),
    body: text.has('body'),
    ctaLabel: text.has('ctaLabel'),
    callLabel: text.has('callLabel'),
    websiteLabel: text.has('websiteLabel'),
    website: text.has('website'),
    tagline: text.has('tagline'),
    phone: text.has('phone'),
    logo: template.contract.images.includes('logo'),
    features: template.manifest.featureCount,
  };
}

/** How many `featureNLabel` slots the markup actually carries. */
export function markedUpFeatureCount(contract: TemplateContract): number {
  return contract.text.filter((name) => /^feature[0-9]+Label$/.test(name)).length;
}

function readContract(html: string): TemplateContract {
  const names = (attribute: string): string[] => [
    ...new Set(
      [...html.matchAll(new RegExp(`${attribute}="([^"]+)"`, 'gi'))].map((match) => match[1]!),
    ),
  ];
  return {
    text: names('data-slot'),
    images: names('data-image'),
    conditions: names('data-when'),
  };
}

/**
 * Every template this build can draw, by file slug.
 *
 * An explicit list rather than a directory scan. A scan would make a renamed or
 * mistyped file a *runtime* miss on one client's poster; the list makes it a
 * type error, and `check:templates` proves each entry resolves to a real file.
 */
export const HTML_TEMPLATE_SLUGS = [
  'con-sm-01',
  'con-sm-02',
  'con-sm-03',
  'con-sm-04',
  'con-sm-05',
  'con-sm-06',
  'con-sm-07',
  'int-sm-01',
  'int-sm-03',
  'med-sm-01',
  'med-sm-03',
  'med-sm-04',
  'med-sm-05',
  'med-sm-06',
  'med-sm-07',
  'med-sm-08',
  'med-sm-11',
  'med-sm-12',
  'med-sm-13',
  'med-sm-14',
  'med-sm-15',
  'med-sm-16',
  'med-sm-17',
] as const;

export type HtmlTemplateSlug = (typeof HTML_TEMPLATE_SLUGS)[number];

/**
 * Where the `.html` files live at runtime.
 *
 * **This is a production trap, and the reason for the assertion in the
 * Dockerfile's runner stage.** The image copies `.next`, `node_modules`,
 * `prisma` and two config files — not `src`. A template read through `fs` is
 * therefore present on the dev machine and absent in the container unless the
 * Dockerfile copies it explicitly, and the failure would first appear as one
 * client's poster failing at compose, days after the deploy looked clean.
 */
function templateDir(): string {
  const override = optionalEnv('POSTER_TEMPLATE_DIR', '');
  return override || join(process.cwd(), 'src', 'lib', 'poster', 'templates');
}

/**
 * Process-lifetime cache of parsed templates.
 *
 * Holds the in-flight promise, not the resolved value, so a dispatch sweep
 * firing several clients in the same minute reads the file once. Templates do
 * not change while a process lives — a new one arrives with a new deploy.
 */
const cache = new Map<string, Promise<HtmlTemplate>>();

/**
 * The shared mark sprite, injected into every document.
 *
 * Not a template and deliberately not in `HTML_TEMPLATE_SLUGS` — the leading
 * underscore is a reminder that nothing renders it on its own. It holds the
 * pictograms and rules that repeat across a vertical, so that a fix to the
 * scanner icon reaches every template that draws one instead of twenty-three
 * traced copies each being wrong in a different way.
 */
export function loadKitSprite(): Promise<string> {
  return shared('_kit.svg', 'mark kit');
}

/**
 * The stylesheet for the chrome every template repeats — logo box, headline,
 * contact bar, service rings — driven by custom properties a template sets.
 * Injected before the template's own <style>, so a template can override any of
 * it by restating the declaration.
 */
export function loadBaseCss(): Promise<string> {
  return shared('_base.css', 'base stylesheet');
}

const sharedFiles = new Map<string, Promise<string>>();

function shared(file: string, label: string): Promise<string> {
  const cached = sharedFiles.get(file);
  if (cached) return cached;

  const request = readFile(join(templateDir(), file), 'utf8').catch((error: unknown) => {
    // Not remembered as a failure: every template depends on this, so a
    // transient read on a OneDrive-synced working copy must not poison the
    // process for the rest of its life.
    sharedFiles.delete(file);
    throw new Error(
      `The poster ${label} (${file}) could not be read: ${describe(error)}. ` +
        'Every template depends on it, so this fails all of them at once.',
    );
  });
  sharedFiles.set(file, request);
  return request;
}

export async function loadHtmlTemplate(slug: HtmlTemplateSlug): Promise<HtmlTemplate> {
  const cached = cache.get(slug);
  if (cached) return cached;

  const request = readTemplate(slug);
  cache.set(slug, request);
  // A failed read must not be remembered for the process lifetime. The commonest
  // cause is a missing COPY and the fix is a redeploy, but the second commonest
  // is a transient filesystem error on a OneDrive-synced working copy, where the
  // next attempt succeeds.
  request.catch(() => cache.delete(slug));
  return request;
}

async function readTemplate(slug: string): Promise<HtmlTemplate> {
  const path = join(templateDir(), `${slug}.html`);

  let html: string;
  try {
    html = await readFile(path, 'utf8');
  } catch (error: unknown) {
    throw new Error(
      `Poster template "${slug}" was not found at ${path}. In production this ` +
        'means the image did not copy src/lib/poster/templates — see the runner ' +
        `stage of the Dockerfile. (${describe(error)})`,
    );
  }

  return {
    slug,
    manifest: readManifest(slug, html),
    contract: readContract(stripComments(html)),
    html,
  };
}

/**
 * The `<script type="application/json" id="poster-manifest">` block.
 *
 * Carried inside the HTML rather than in a sidecar file so a template is one
 * artefact: the lint, the registry and whoever opens the file in an editor are
 * all looking at the same thing. The block is inert at render — nothing executes
 * it, and `fill.ts` removes it before the screenshot.
 */
const MANIFEST_PATTERN =
  /<script[^>]*id=["']poster-manifest["'][^>]*>([\s\S]*?)<\/script>/i;

export function readManifest(slug: string, html: string): TemplateManifest {
  const match = MANIFEST_PATTERN.exec(html);
  if (!match) {
    throw new Error(
      `Poster template "${slug}" has no <script id="poster-manifest"> block, so ` +
        'the pipeline cannot tell what photographs it needs before rendering it.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!);
  } catch (error: unknown) {
    throw new Error(
      `Poster template "${slug}" has an unparseable manifest: ${describe(error)}`,
    );
  }

  const result = templateManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Poster template "${slug}" has an invalid manifest: ` +
        result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '),
    );
  }

  return result.data;
}

/**
 * The template that draws a given `CategoryTemplate.label`, or null.
 *
 * Null is the answer for every template that has not been migrated yet, and the
 * caller falls back to the spec renderer. That is what makes this a per-template
 * migration rather than a flag day.
 */
export async function findHtmlTemplateFor(
  label: string | null | undefined,
): Promise<HtmlTemplate | null> {
  const wanted = label?.trim().toLowerCase();
  if (!wanted) return null;

  for (const slug of HTML_TEMPLATE_SLUGS) {
    const template = await loadHtmlTemplate(slug);
    if (template.manifest.label.trim().toLowerCase() === wanted) return template;
  }
  return null;
}

/**
 * Comments are stripped before the contract is read.
 *
 * Several templates quote a `data-slot="..."` in their header comment to explain
 * the format, and a name that only exists in prose is not a name the design
 * draws — counting it would make the sheet ask an operator for a field that
 * lands nowhere.
 */
function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, ' ');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
