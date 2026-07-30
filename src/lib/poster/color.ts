/**
 * Colour utilities for the poster renderer.
 *
 * Exists because the poster layer cannot eyeball its own output: a brand accent
 * that fails contrast against the ground it lands on produces an unreadable
 * headline, and the first person to notice would be the client receiving it on
 * WhatsApp. Every colour pairing the renderer makes is checked here first.
 *
 * All ratios follow WCAG 2.1 relative-luminance / contrast definitions.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsl {
  /** Degrees, 0–360. */
  h: number;
  /** 0–1. */
  s: number;
  /** 0–1. */
  l: number;
}

// ---------------------------------------------------------------------------
// Parsing / formatting
// ---------------------------------------------------------------------------

/** Parses `#rgb`, `#rrggbb` or `#rrggbbaa` (alpha discarded). Null if invalid. */
export function hexToRgb(hex: string): Rgb | null {
  const normalized = hex.replace('#', '').trim();
  const expanded =
    normalized.length === 3
      ? normalized
          .split('')
          .map((char) => `${char}${char}`)
          .join('')
      : normalized.slice(0, 6);

  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) return null;

  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const channel = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * `rgba()` string for a hex plus an alpha.
 *
 * Satori supports `rgba()` but not an 8-digit hex, and every scrim gradient in
 * the archetypes needs a partially transparent stop of a brand colour.
 */
export function withAlpha(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex) ?? { r: 0, g: 0, b: 0 };
  const clamped = Math.max(0, Math.min(1, alpha));
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clamped})`;
}

// ---------------------------------------------------------------------------
// HSL conversion
// ---------------------------------------------------------------------------

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;

  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));

  return { h, s, l };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = chroma * (1 - Math.abs((hp % 2) - 1));

  let base: [number, number, number];
  if (hp < 1) base = [chroma, x, 0];
  else if (hp < 2) base = [x, chroma, 0];
  else if (hp < 3) base = [0, chroma, x];
  else if (hp < 4) base = [0, x, chroma];
  else if (hp < 5) base = [x, 0, chroma];
  else base = [chroma, 0, x];

  const m = l - chroma / 2;
  return {
    r: (base[0] + m) * 255,
    g: (base[1] + m) * 255,
    b: (base[2] + m) * 255,
  };
}

// ---------------------------------------------------------------------------
// Contrast
// ---------------------------------------------------------------------------

/** WCAG 2.1 relative luminance. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio between two hex colours, 1–21. Unknown input reads as 1. */
export function contrastRatio(foreground: string, background: string): number {
  const fg = hexToRgb(foreground);
  const bg = hexToRgb(background);
  if (!fg || !bg) return 1;

  const lf = relativeLuminance(fg);
  const lb = relativeLuminance(bg);
  const lighter = Math.max(lf, lb);
  const darker = Math.min(lf, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Whichever of black/white reads better on `background`. */
export function bestTextOn(background: string): string {
  return contrastRatio('#FFFFFF', background) >= contrastRatio('#0B0B0D', background)
    ? '#FFFFFF'
    : '#0B0B0D';
}

/**
 * Nudges `color`'s HSL lightness until it clears `target` contrast against
 * `background`, preserving hue and saturation so the result still reads as the
 * brand colour rather than a generic tint.
 *
 * Walks away from the background's luminance in 2% steps. If the full range is
 * exhausted without clearing the target — a mid-grey background is the pathology,
 * since nothing contrasts well with it — returns the best ratio found rather
 * than the original, because a partial improvement still helps legibility.
 */
export function ensureContrast(
  color: string,
  background: string,
  target = 4.5,
): string {
  if (contrastRatio(color, background) >= target) return color;

  const rgb = hexToRgb(color);
  const bgRgb = hexToRgb(background);
  if (!rgb || !bgRgb) return color;

  const hsl = rgbToHsl(rgb);
  // Move away from the ground: lighten on a dark ground, darken on a light one.
  const direction = relativeLuminance(bgRgb) < 0.5 ? 1 : -1;

  let best = color;
  let bestRatio = contrastRatio(color, background);

  for (let step = 1; step <= 50; step += 1) {
    const l = hsl.l + direction * step * 0.02;
    if (l <= 0 || l >= 1) break;

    const candidate = rgbToHex(hslToRgb({ ...hsl, l }));
    const ratio = contrastRatio(candidate, background);

    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = candidate;
    }
    if (ratio >= target) return candidate;
  }

  return best;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * How accent-like a colour is: saturated and mid-lightness scores high, greys
 * and near-blacks score ~0. Used to pick the accent out of an unordered palette
 * when the tokenizer's role labels are unreliable.
 */
export function accentScore(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;

  const { s, l } = rgbToHsl(rgb);
  // Peaks at l = 0.5 and falls off toward both extremes.
  const lightnessFitness = 1 - Math.abs(l - 0.5) * 2;
  return s * Math.max(0, lightnessFitness);
}

/** True for near-greys — candidates for the neutral roles, never the accent. */
export function isNeutral(hex: string): boolean {
  const rgb = hexToRgb(hex);
  if (!rgb) return false;
  return rgbToHsl(rgb).s < 0.18;
}
