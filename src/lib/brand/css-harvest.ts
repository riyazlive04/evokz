import { hexToRgb, hslToRgb, rgbToHex } from '@/lib/poster/color';
import type { BrandColorSource } from '@/lib/types/brand';

/**
 * Colour harvesting from raw markup and stylesheet text.
 *
 * Pure parsing — no network, no I/O, no model call. `website-colors.ts` does the
 * fetching and hands the bytes here.
 *
 * The problem this solves: a site mentions dozens of colours, and raw frequency
 * is a bad ranking signal. A hairline border colour repeated on 200 footer links
 * outweighs the one hex bound to `--brand-primary`, which is the colour a human
 * would name if you asked them what the brand looks like. So every observation
 * is weighted by *where* it was found, and the weights are summed per colour
 * rather than counted.
 */

export interface ColorObservation {
  /** Normalised to lowercase `#rrggbb`. */
  hex: string;
  weight: number;
  source: BrandColorSource;
  /** Short human string for the operator, e.g. `--brand-green`. */
  evidence: string;
}

/**
 * Evidence classes, strongest first.
 *
 * `themeColor` outranks everything because `<meta name="theme-color">` is the
 * one place a site states its brand colour as a fact rather than as a side
 * effect of styling something.
 */
const WEIGHTS = {
  themeColor: 10,
  brandVariable: 9,
  cssVariable: 8,
  buttonOrCta: 5,
  headerOrHero: 4,
  heading: 2,
  other: 1,
} as const;

/** Custom-property names that read as a deliberate brand declaration. */
const BRAND_VARIABLE = /(?:^|-)(?:brand|primary|accent|main|theme|secondary)(?:-|$)/i;

/**
 * Stock palettes shipped by a CMS or CSS framework.
 *
 * WordPress emits the full `--wp--preset--color--*` set — white, black,
 * cyan-bluish-gray, luminous-vivid-orange — on every site whether or not the
 * theme uses any of them. They are declared as custom properties, so without
 * this they collect the highest evidence weight available and bury the colours
 * the site actually paints with. Every WordPress client would otherwise resolve
 * to the same generic palette.
 */
const FRAMEWORK_VARIABLE = /^--(?:wp|bs|tw|ion|ui|chakra|mui|vc|elementor)-/i;

/**
 * Variables named after the colour rather than the job it does.
 *
 * `--brand-primary` states a role and is worth trusting. `--vivid-orange` just
 * names a swatch, which is what a design system does when it is enumerating
 * options rather than making a choice.
 */
const COLOR_NAMED_VARIABLE =
  /(?:white|black|gray|grey|silver|red|orange|yellow|green|blue|cyan|teal|purple|violet|pink|magenta|vivid|pale|luminous)/i;

/** Selectors whose background is almost always the brand colour. */
const CTA_SELECTOR = /(?:\.|\b)(?:btn|button|cta|primary|submit)\b|\[type=["']?submit/i;
const HEADER_SELECTOR = /(?:\.|\b)(?:header|navbar|nav|hero|banner|masthead|topbar)\b/i;
const HEADING_SELECTOR = /\bh[1-3]\b/i;

/** Properties worth reading a colour out of. Shadows and outlines are noise. */
const COLOR_PROPERTY = /^(?:color|background|background-color|border-color|fill|stroke)$/;

/**
 * Named CSS colours worth recognising.
 *
 * Deliberately not the full 148: the long tail (`papayawhip`, `gainsboro`) never
 * appears in a brand declaration, and every extra entry is another chance to
 * match a word inside an unrelated identifier.
 */
const NAMED_COLORS: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  navy: '#000080',
  teal: '#008080',
  orange: '#ffa500',
  gold: '#ffd700',
  purple: '#800080',
  maroon: '#800000',
  olive: '#808000',
  lime: '#00ff00',
  aqua: '#00ffff',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  silver: '#c0c0c0',
  gray: '#808080',
  grey: '#808080',
  crimson: '#dc143c',
  indigo: '#4b0082',
};

// ---------------------------------------------------------------------------
// Colour literal parsing
// ---------------------------------------------------------------------------

const HEX_LITERAL = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
// Handles both legacy comma syntax and the modern space form with an optional
// `/ alpha`: rgb(255, 0, 0) and rgb(255 0 0 / 80%) both parse.
const RGB_LITERAL = /rgba?\(\s*([^)]+)\)/gi;
const HSL_LITERAL = /hsla?\(\s*([^)]+)\)/gi;
/**
 * Named colours, but only where the word stands alone as a value.
 *
 * `\b` is not enough: it treats a hyphen as a boundary, so `orange` matches
 * inside `var(--hds-color-util-accent-orange-50)` and the palette fills up with
 * `#ffa500` instead of the brand colour that variable actually resolves to.
 * Observed on real sites — Stripe and Gensler both resolved to pure `orange`
 * before this. Requiring no adjacent word character, hyphen or underscore keeps
 * `color: orange` and `var(--x, orange)` while rejecting the identifiers.
 */
const NAMED_LITERAL = new RegExp(
  `(?<![\\w-])(${Object.keys(NAMED_COLORS).join('|')})(?![\\w-])`,
  'gi',
);

/**
 * Anything below this is a scrim or a hover wash, not a brand colour. Reading
 * `rgba(0,0,0,.04)` as a palette entry is how a site ends up with six greys.
 */
const MIN_ALPHA = 0.5;

/** Splits `255, 0, 0` or `255 0 0 / 80%` into numeric parts plus alpha. */
function splitComponents(raw: string): { parts: string[]; alpha: number } {
  const [main, alphaPart] = raw.split('/');
  const parts = (main ?? '')
    .trim()
    .split(/[\s,]+/)
    .filter((part) => part.length > 0);

  const alphaToken = alphaPart?.trim() ?? parts[3];
  return { parts: parts.slice(0, 3), alpha: parseAlpha(alphaToken) };
}

function parseAlpha(token: string | undefined): number {
  if (token === undefined) return 1;
  const trimmed = token.trim();
  if (trimmed === '') return 1;
  const value = Number.parseFloat(trimmed);
  if (!Number.isFinite(value)) return 1;
  return trimmed.endsWith('%') ? value / 100 : value;
}

/** `50%` -> 127.5, `255` -> 255. Percentages appear in the modern rgb() syntax. */
function parseChannel(token: string | undefined, scale: number): number | null {
  if (token === undefined) return null;
  const value = Number.parseFloat(token);
  if (!Number.isFinite(value)) return null;
  return token.trim().endsWith('%') ? (value / 100) * scale : value;
}

/**
 * Every colour literal in a string, normalised to `#rrggbb`.
 *
 * Order is preserved and duplicates are kept — the caller weights each
 * occurrence, so collapsing them here would throw away the signal.
 */
export function parseColorLiterals(input: string): string[] {
  const found: string[] = [];

  for (const match of input.matchAll(HEX_LITERAL)) {
    const literal = match[0];
    // 4- and 8-digit forms carry alpha in the trailing pair; drop it, but only
    // after checking it is not a near-transparent wash.
    if (literal.length === 5 || literal.length === 9) {
      const alphaHex = literal.slice(literal.length === 5 ? 4 : 7);
      const alpha =
        Number.parseInt(alphaHex.length === 1 ? alphaHex.repeat(2) : alphaHex, 16) / 255;
      if (alpha < MIN_ALPHA) continue;
    }
    const rgb = hexToRgb(literal);
    if (rgb) found.push(rgbToHex(rgb).toLowerCase());
  }

  for (const match of input.matchAll(RGB_LITERAL)) {
    const { parts, alpha } = splitComponents(match[1] ?? '');
    if (alpha < MIN_ALPHA) continue;
    const r = parseChannel(parts[0], 255);
    const g = parseChannel(parts[1], 255);
    const b = parseChannel(parts[2], 255);
    if (r === null || g === null || b === null) continue;
    found.push(rgbToHex({ r, g, b }).toLowerCase());
  }

  for (const match of input.matchAll(HSL_LITERAL)) {
    const { parts, alpha } = splitComponents(match[1] ?? '');
    if (alpha < MIN_ALPHA) continue;
    const h = parseChannel(parts[0], 360);
    const s = parseChannel(parts[1], 100);
    const l = parseChannel(parts[2], 100);
    if (h === null || s === null || l === null) continue;
    found.push(rgbToHex(hslToRgb({ h, s: s / 100, l: l / 100 })).toLowerCase());
  }

  for (const match of input.matchAll(NAMED_LITERAL)) {
    const named = NAMED_COLORS[match[0].toLowerCase()];
    if (named) found.push(named);
  }

  return found;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;
/**
 * One flat rule: `selector { declarations }`.
 *
 * Neither half may contain a brace, so an at-rule wrapper like `@media (...) {`
 * never matches as a selector — the scan simply advances and picks up the
 * nested rules inside it, which is the behaviour we want.
 */
const CSS_RULE = /([^{}]+)\{([^{}]*)\}/g;

/**
 * Weight and provenance for one declaration.
 *
 * Source and weight are decided together because they answer the same question.
 * A demoted framework preset is reported as `css-usage` rather than `css-var`:
 * in this taxonomy `css-var` means "someone declared a brand token", and a CMS
 * enumerating its stock swatches has not done that.
 */
function classifyDeclaration(
  selector: string,
  property: string,
): { weight: number; source: BrandColorSource } {
  if (property.startsWith('--')) {
    if (FRAMEWORK_VARIABLE.test(property)) {
      return { weight: WEIGHTS.other, source: 'css-usage' };
    }
    if (BRAND_VARIABLE.test(property)) {
      return { weight: WEIGHTS.brandVariable, source: 'css-var' };
    }
    if (COLOR_NAMED_VARIABLE.test(property)) {
      return { weight: WEIGHTS.other, source: 'css-usage' };
    }
    return { weight: WEIGHTS.cssVariable, source: 'css-var' };
  }

  const isBackground = property === 'background' || property === 'background-color';

  if (isBackground && CTA_SELECTOR.test(selector)) {
    return { weight: WEIGHTS.buttonOrCta, source: 'css-usage' };
  }
  if (isBackground && HEADER_SELECTOR.test(selector)) {
    return { weight: WEIGHTS.headerOrHero, source: 'css-usage' };
  }
  if (property === 'color' && HEADING_SELECTOR.test(selector)) {
    return { weight: WEIGHTS.heading, source: 'css-usage' };
  }

  return { weight: WEIGHTS.other, source: 'css-usage' };
}

/** Harvests every colour declaration from a stylesheet. */
export function harvestFromCss(css: string): ColorObservation[] {
  const observations: ColorObservation[] = [];
  const cleaned = css.replace(CSS_COMMENT, '');

  for (const rule of cleaned.matchAll(CSS_RULE)) {
    const selector = (rule[1] ?? '').trim();
    const body = rule[2] ?? '';

    for (const declaration of body.split(';')) {
      const separator = declaration.indexOf(':');
      if (separator === -1) continue;

      const property = declaration.slice(0, separator).trim().toLowerCase();
      const value = declaration.slice(separator + 1);
      if (property === '') continue;

      const isVariable = property.startsWith('--');
      if (!isVariable && !COLOR_PROPERTY.test(property)) continue;

      const { weight, source } = classifyDeclaration(selector, property);
      // A custom property is named by its own identifier; a normal declaration
      // is only identifiable by the selector it sat on.
      const evidence = isVariable ? property : `${truncate(selector, 40)} { ${property} }`;

      for (const hex of parseColorLiterals(value)) {
        observations.push({ hex, weight, source, evidence });
      }
    }
  }

  return observations;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const THEME_COLOR_META =
  /<meta[^>]+name=["']?theme-color["']?[^>]*content=["']([^"']+)["'][^>]*>/gi;
const THEME_COLOR_META_REVERSED =
  /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']?theme-color["']?[^>]*>/gi;
const STYLE_BLOCK = /<style[^>]*>([\s\S]*?)<\/style>/gi;
const INLINE_STYLE = /\sstyle=["']([^"']+)["']/gi;
const STYLESHEET_LINK = /<link[^>]+>/gi;
const HREF_ATTR = /href=["']([^"']+)["']/i;

/** Harvests colours declared directly in the document. */
export function harvestFromHtml(html: string): ColorObservation[] {
  const observations: ColorObservation[] = [];

  for (const pattern of [THEME_COLOR_META, THEME_COLOR_META_REVERSED]) {
    for (const match of html.matchAll(pattern)) {
      for (const hex of parseColorLiterals(match[1] ?? '')) {
        observations.push({
          hex,
          weight: WEIGHTS.themeColor,
          source: 'theme-color',
          evidence: 'meta theme-color',
        });
      }
    }
  }

  for (const block of html.matchAll(STYLE_BLOCK)) {
    observations.push(...harvestFromCss(block[1] ?? ''));
  }

  for (const inline of html.matchAll(INLINE_STYLE)) {
    // Wrapped in a synthetic rule so the shared declaration parser applies.
    observations.push(...harvestFromCss(`inline { ${inline[1] ?? ''} }`));
  }

  return observations;
}

/** Hosts that serve webfont CSS. Never contains a brand colour. */
const FONT_HOST = /(?:fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|fonts\.bunny\.net)/i;

/** Icon-font and vendor-reset sheets: hundreds of rules, no brand colour. */
const NOISE_FILE =
  /(?:font-awesome|fontawesome|icon-?moon|pe-icon|material-design|stroke-gap|glyphicon|bootstrap(?:\.min)?\.css|normalize|reset|animate)/i;

/** Filenames that conventionally carry a theme's own palette. */
const THEME_FILE = /(?:^|\/)(?:style|styles|custom|main|theme|app|base|layout|colors?)\.(?:min\.)?css/i;

/**
 * How likely a stylesheet is to declare the brand palette.
 *
 * Ordering matters more than it looks. A WordPress homepage links ~40 sheets and
 * the first several are always plugin CSS — contact forms, sliders, social feeds
 * — so reading "the first five" reads five files that describe someone else's
 * widget. The theme's own stylesheet is typically halfway down the list.
 */
function stylesheetPriority(url: string): number {
  if (FONT_HOST.test(url) || NOISE_FILE.test(url)) return Number.NEGATIVE_INFINITY;

  let score = 0;
  if (/\/themes?\//i.test(url)) score += 10;
  if (THEME_FILE.test(url)) score += 4;
  // Plugin sheets style a plugin, not the brand. Ranked last but not excluded:
  // on a page-builder site they are sometimes all there is.
  if (/\/plugins?\//i.test(url) || /\/wp-includes\//i.test(url)) score -= 8;

  return score;
}

/**
 * Stylesheet URLs referenced by the document, most brand-relevant first.
 *
 * Anything unresolvable is dropped rather than thrown — one malformed `href`
 * must not abort a harvest the other stylesheets would have served.
 */
export function extractStylesheetUrls(html: string, baseUrl: string): string[] {
  const urls: string[] = [];

  for (const tag of html.matchAll(STYLESHEET_LINK)) {
    const element = tag[0];
    if (!/rel=["']?stylesheet/i.test(element)) continue;

    const href = element.match(HREF_ATTR)?.[1];
    if (!href) continue;

    try {
      urls.push(new URL(href, baseUrl).toString());
    } catch {
      continue;
    }
  }

  return [...new Set(urls)]
    .map((url) => ({ url, priority: stylesheetPriority(url) }))
    .filter((entry) => entry.priority !== Number.NEGATIVE_INFINITY)
    .sort((a, b) => b.priority - a.priority)
    .map((entry) => entry.url);
}

function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}
