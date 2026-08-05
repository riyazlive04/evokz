import { lookup } from 'node:dns/promises';

import {
  extractStylesheetUrls,
  harvestFromCss,
  harvestFromHtml,
  type ColorObservation,
} from '@/lib/brand/css-harvest';
import { intEnv } from '@/lib/env';
import { hexToRgb, relativeLuminance, rgbToHsl } from '@/lib/poster/color';
import type { BrandColor, BrandColorSource } from '@/lib/types/brand';

/**
 * Extracts a client's real brand palette from their website's CSS.
 *
 * This replaces guessing. The brand tokenizer infers a palette from prose, which
 * is why a construction client whose site is green receives an amber poster —
 * the model never saw the site, only words about it. Here the colours come from
 * the stylesheet, so `#8cc63f` is `#8cc63f`.
 *
 * No model is involved at any point, so this stage cannot hallucinate and cannot
 * fail on a schema violation.
 */

export class WebsiteColorError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WebsiteColorError';
  }
}

/** A resolved palette entry, carrying the evidence trail for the operator. */
export interface ExtractedColor {
  hex: string;
  role: string;
  source: BrandColorSource;
  confidence: number;
  /** Where it was found, e.g. `--brand-green`. Shown in the UI, not persisted. */
  evidence: string;
}

export interface ExtractionReport {
  /** The URL actually fetched, after normalisation. */
  url: string;
  colors: ExtractedColor[];
  /** Stylesheets successfully read. Useful when a palette comes back thin. */
  stylesheetsRead: number;
  /** Distinct colours seen before clustering and capping. */
  observed: number;
}

const MAX_STYLESHEETS = 5;
const MAX_HTML_BYTES = 2_000_000;
const MAX_CSS_BYTES = 4_000_000;
const MAX_COLORS = 6;

/**
 * A plain `fetch` User-Agent gets 403'd by a lot of commodity hosting and most
 * WAFs, which would read to an operator as "this site has no colours".
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---------------------------------------------------------------------------
// URL normalisation and SSRF guard
// ---------------------------------------------------------------------------

/**
 * `Client.websiteUrl` is stored as display text ("www.example.com") for the
 * poster contact bar, so a protocol has to be added before it can be fetched.
 */
export function normalizeWebsiteUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (trimmed === '') throw new WebsiteColorError('Enter a website address.');

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new WebsiteColorError(`"${raw}" is not a valid website address.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebsiteColorError('Only http and https addresses can be read.');
  }

  return url;
}

/** True for addresses that must never be fetched on behalf of an operator. */
function isPrivateAddress(address: string): boolean {
  if (address.includes(':')) {
    const normalized = address.toLowerCase();
    // Loopback, unique-local (fc00::/7) and link-local (fe80::/10).
    return (
      normalized === '::1' ||
      normalized === '::' ||
      /^f[cd][0-9a-f]{2}:/.test(normalized) ||
      /^fe[89ab][0-9a-f]:/.test(normalized)
    );
  }

  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((octet) => !Number.isFinite(octet))) return true;

  const [a = 0, b = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/**
 * Refuses to fetch anything on the internal network.
 *
 * The admin console has no auth middleware, so this is the only thing standing
 * between a pasted URL and the metadata service or a database on the same host.
 * The hostname is resolved rather than pattern-matched, because `evil.com`
 * pointing at `127.0.0.1` would sail past a string check.
 *
 * Resolution and fetch are separate calls, so a DNS-rebinding attacker with
 * control of an authoritative server could still slip between them. Closing that
 * needs a pinned-IP agent; it is out of proportion to an internal tool, and the
 * blast radius is a colour palette.
 */
async function assertPublicHost(url: URL): Promise<void> {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new WebsiteColorError(`Refusing to read from ${hostname}.`);
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch (cause) {
    throw new WebsiteColorError(`Could not resolve ${hostname}.`, { cause });
  }

  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new WebsiteColorError(`Refusing to read from ${hostname}: private address.`);
  }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** House pattern: AbortController, cleared in `finally`, never cached. */
async function fetchText(url: string, maxBytes: number): Promise<string> {
  const timeoutMs = intEnv('BRAND_FETCH_TIMEOUT_MS', 15_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/css,*/*' },
      signal: controller.signal,
      redirect: 'follow',
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new WebsiteColorError(
        `${new URL(url).host} responded ${response.status} ${response.statusText}`,
      );
    }

    const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new WebsiteColorError(
        `${new URL(url).host} returned ${declared} bytes, over the ${maxBytes} limit`,
      );
    }

    return (await response.text()).slice(0, maxBytes);
  } catch (error) {
    if (error instanceof WebsiteColorError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new WebsiteColorError(
        `Request to ${new URL(url).host} timed out after ${timeoutMs}ms`,
      );
    }
    throw new WebsiteColorError(
      `Network failure reading ${new URL(url).host}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

/**
 * Redmean distance — a cheap approximation of perceptual difference that is
 * markedly better than raw RGB euclidean around greens and blues.
 *
 * Needed because a site will define `#8cc63f` in one place and `#8dc63e` in
 * another. Treated as two colours they would consume two of six palette slots
 * and split the weight that should have made either of them the clear primary.
 */
function colorDistance(left: string, right: string): number {
  const a = hexToRgb(left);
  const b = hexToRgb(right);
  if (!a || !b) return Number.POSITIVE_INFINITY;

  const rmean = (a.r + b.r) / 2;
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;

  return Math.sqrt(
    (2 + rmean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rmean) / 256) * db * db,
  );
}

const MERGE_DISTANCE = 40;

interface Cluster {
  hex: string;
  /** Strongest single piece of evidence seen for this colour. */
  peak: number;
  occurrences: number;
  weight: number;
  source: BrandColorSource;
  evidence: string;
}

/**
 * Collapses observations into distinct colours, strongest evidence first.
 *
 * Scoring is `peak + log1p(occurrences)`, not a sum. Summing would defeat the
 * entire weighting scheme: body text at `#333` repeated 300 times would total
 * 300 and beat a `--brand-primary` declared once at 9, which is precisely the
 * frequency-over-evidence mistake the weights exist to avoid. Repetition still
 * counts, but only as a tiebreak between colours of similar standing.
 *
 * The representative hex is the highest-weighted member rather than a computed
 * average: the operator asked for the site's colour, and an averaged centroid is
 * a colour that appears nowhere on it.
 */
function cluster(observations: ColorObservation[]): Cluster[] {
  const byWeight = [...observations].sort((a, b) => b.weight - a.weight);
  const clusters: Cluster[] = [];

  for (const observation of byWeight) {
    const existing = clusters.find(
      (candidate) => colorDistance(candidate.hex, observation.hex) <= MERGE_DISTANCE,
    );

    if (existing) {
      existing.occurrences += 1;
      existing.peak = Math.max(existing.peak, observation.weight);
      continue;
    }

    clusters.push({
      hex: observation.hex,
      peak: observation.weight,
      occurrences: 1,
      weight: 0,
      source: observation.source,
      evidence: observation.evidence,
    });
  }

  for (const entry of clusters) {
    entry.weight = entry.peak + Math.log1p(entry.occurrences);
  }

  return clusters.sort((a, b) => b.weight - a.weight);
}

// ---------------------------------------------------------------------------
// Role assignment
// ---------------------------------------------------------------------------

/** Saturation floor for a colour that can carry a brand role. */
const CHROMATIC_MIN_SATURATION = 0.15;

/**
 * Lightness band a chromatic colour must sit in.
 *
 * HSL saturation is meaningless at the extremes — the formula divides by a term
 * that vanishes as lightness approaches 0 or 1, so a near-white cream like
 * `#fffbeb` reports a saturation of 0.98 and outranks every real brand colour.
 * A colour this pale or this dark is a surface, whatever its saturation says.
 */
const CHROMATIC_MIN_LUMINANCE = 0.02;
const CHROMATIC_MAX_LUMINANCE = 0.8;
/** Two accents closer than this in hue read as the same colour on a poster. */
const DISTINCT_HUE_DEGREES = 30;
const LIGHT_LUMINANCE = 0.75;

const CONFIDENCE_FLOOR: Record<BrandColorSource, number> = {
  'theme-color': 0.9,
  'css-var': 0.7,
  'css-usage': 0.4,
  llm: 0.2,
  manual: 1,
};

function describe(entry: Cluster): { saturation: number; hue: number; luminance: number } {
  const rgb = hexToRgb(entry.hex);
  if (!rgb) return { saturation: 0, hue: 0, luminance: 0 };
  const { h, s } = rgbToHsl(rgb);
  return { saturation: s, hue: h, luminance: relativeLuminance(rgb) };
}

function hueGap(left: number, right: number): number {
  const raw = Math.abs(left - right) % 360;
  return raw > 180 ? 360 - raw : raw;
}

/**
 * Assigns palette roles by measurement.
 *
 * Ordering matters: `primary` is claimed by the heaviest chromatic colour, and
 * `accent` only by one far enough away in hue to be visibly different. A site
 * built entirely from one green gets a primary and no accent, which is honest —
 * inventing a second role would put a colour on the poster the brand never had.
 */
function assignRoles(clusters: Cluster[]): ExtractedColor[] {
  const measured = clusters.map((entry) => ({ entry, ...describe(entry) }));
  const topWeight = measured[0]?.entry.weight ?? 1;

  const chromatic = measured.filter(
    (item) =>
      item.saturation >= CHROMATIC_MIN_SATURATION &&
      item.luminance >= CHROMATIC_MIN_LUMINANCE &&
      item.luminance <= CHROMATIC_MAX_LUMINANCE,
  );
  const primary = chromatic[0];
  const accent = chromatic.find(
    (item) => primary !== undefined && hueGap(item.hue, primary.hue) >= DISTINCT_HUE_DEGREES,
  );
  const secondary = chromatic.find((item) => item !== primary && item !== accent);
  const background = measured.find((item) => item.luminance >= LIGHT_LUMINANCE);

  const roles = new Map<(typeof measured)[number], string>();
  if (primary) roles.set(primary, 'primary');
  if (accent) roles.set(accent, 'accent');
  if (secondary) roles.set(secondary, 'secondary');
  // Assigned last and only if still unclaimed: a saturated colour that also
  // happens to be light is more useful as the primary than as a surface.
  if (background && !roles.has(background)) roles.set(background, 'background');

  return measured
    .filter((item) => roles.has(item))
    .concat(measured.filter((item) => !roles.has(item)))
    .slice(0, MAX_COLORS)
    .map((item) => {
      const floor = CONFIDENCE_FLOOR[item.entry.source];
      const share = topWeight > 0 ? item.entry.weight / topWeight : 0;
      return {
        hex: item.entry.hex,
        role: roles.get(item) ?? 'secondary',
        source: item.entry.source,
        confidence: Math.min(1, Number((floor + share * 0.2).toFixed(2))),
        evidence: item.entry.evidence,
      };
    });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Reads a website and returns its palette. Never persists anything.
 *
 * Stylesheet failures degrade rather than abort — a site whose third stylesheet
 * 404s still yields a palette from the other two, and the count of what was
 * actually read comes back in the report so a thin result is explicable.
 */
export async function extractWebsiteColors(rawUrl: string): Promise<ExtractionReport> {
  const url = normalizeWebsiteUrl(rawUrl);
  await assertPublicHost(url);

  const html = await fetchText(url.toString(), MAX_HTML_BYTES);
  const observations: ColorObservation[] = harvestFromHtml(html);

  const stylesheetUrls = extractStylesheetUrls(html, url.toString()).slice(0, MAX_STYLESHEETS);
  let budget = MAX_CSS_BYTES;
  let stylesheetsRead = 0;

  for (const stylesheetUrl of stylesheetUrls) {
    if (budget <= 0) break;
    try {
      const parsed = new URL(stylesheetUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      await assertPublicHost(parsed);

      const css = await fetchText(stylesheetUrl, budget);
      budget -= css.length;
      stylesheetsRead += 1;
      observations.push(...harvestFromCss(css));
    } catch (error) {
      console.warn(
        `[ace:brand] skipped stylesheet ${stylesheetUrl}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  if (observations.length === 0) {
    throw new WebsiteColorError(
      `No colours found on ${url.host}. The site may render its styles with JavaScript, which this stage cannot see.`,
    );
  }

  const clusters = cluster(observations);

  return {
    url: url.toString(),
    colors: assignRoles(clusters),
    stylesheetsRead,
    observed: clusters.length,
  };
}

/** Strips the evidence trail, which is operator UI and not part of the stored shape. */
export function toBrandColors(colors: ExtractedColor[]): BrandColor[] {
  return colors.map(({ hex, role, source, confidence }) => ({
    hex,
    role,
    source,
    confidence,
  }));
}
