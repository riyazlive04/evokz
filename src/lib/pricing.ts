import { floatEnv } from '@/lib/env';

/**
 * Provider rate card and money helpers.
 *
 * Every rate is an env var, because provider pricing changes on the provider's
 * schedule and a hardcoded number would quietly drift from the real invoice.
 * The defaults below are starting points to check against your own billing
 * pages — the dashboard prints the rate card it used so a mismatch is visible
 * rather than buried.
 *
 * Costs are stored as USD micros (millionths of a dollar). A single caption
 * batch costs a fraction of a cent, so cents would round most rows to zero,
 * and floats would drift once millions of rows are summed.
 */

export const USD_MICROS = 1_000_000;

export interface RateCard {
  /** USD per million OpenAI input tokens billed at the full rate. */
  openAiInputPerMTok: number;
  /** USD per million input tokens served from the prompt cache. */
  openAiCachedInputPerMTok: number;
  /** USD per million OpenAI output tokens. */
  openAiOutputPerMTok: number;
  /** USD per generated image. */
  falPerImage: number;
  /**
   * USD per background-removal call.
   *
   * Its own rate rather than reusing `falPerImage`, because segmentation is an
   * order of magnitude cheaper than diffusion and pricing it as a full render
   * would report a cut-out poster as costing twice what it does — on the ledger
   * that the monthly budget alerts read.
   */
  falPerCutout: number;
  /** USD per WhatsApp message. Zero for a self-hosted Evolution instance. */
  whatsAppPerMessage: number;
  /** Rupees per US dollar, used for display only. */
  usdInr: number;
}

export function getRateCard(): RateCard {
  return {
    openAiInputPerMTok: floatEnv('PRICE_OPENAI_INPUT_PER_MTOK', 0.15),
    openAiCachedInputPerMTok: floatEnv('PRICE_OPENAI_CACHED_INPUT_PER_MTOK', 0.075),
    openAiOutputPerMTok: floatEnv('PRICE_OPENAI_OUTPUT_PER_MTOK', 0.6),
    falPerImage: floatEnv('PRICE_FAL_PER_IMAGE', 0.003),
    falPerCutout: floatEnv('PRICE_FAL_PER_CUTOUT', 0.0004),
    whatsAppPerMessage: floatEnv('PRICE_WHATSAPP_PER_MESSAGE', 0),
    usdInr: floatEnv('USD_INR_RATE', 88),
  };
}

export interface TokenUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

/**
 * Prices one OpenAI call.
 *
 * `cachedTokens` is a *subset* of `inputTokens` in the API's accounting, so the
 * uncached remainder is billed at the full rate and the cached portion at the
 * discounted one. Treating them as separate additive buckets would over-bill
 * every cached call.
 */
export function priceOpenAiCall(usage: TokenUsage, rates = getRateCard()): number {
  const cached = Math.min(Math.max(usage.cachedTokens, 0), Math.max(usage.inputTokens, 0));
  const uncached = Math.max(usage.inputTokens, 0) - cached;

  const usd =
    (uncached / 1_000_000) * rates.openAiInputPerMTok +
    (cached / 1_000_000) * rates.openAiCachedInputPerMTok +
    (Math.max(usage.outputTokens, 0) / 1_000_000) * rates.openAiOutputPerMTok;

  return toMicros(usd);
}

export function priceImages(count: number, rates = getRateCard()): number {
  return toMicros(Math.max(count, 0) * rates.falPerImage);
}

export function priceCutouts(count: number, rates = getRateCard()): number {
  return toMicros(Math.max(count, 0) * rates.falPerCutout);
}

export function priceMessages(count: number, rates = getRateCard()): number {
  return toMicros(Math.max(count, 0) * rates.whatsAppPerMessage);
}

/** Rounds a USD amount to whole micros, clamped to a safe integer. */
function toMicros(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.min(Math.round(usd * USD_MICROS), Number.MAX_SAFE_INTEGER);
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export function microsToUsd(micros: number): number {
  return micros / USD_MICROS;
}

export function microsToInr(micros: number, rates = getRateCard()): number {
  return (micros / USD_MICROS) * rates.usdInr;
}

/**
 * Formats a dollar amount at a precision that suits its size: sub-cent spend is
 * the normal case for a single call, and rounding it to `$0.00` would make the
 * per-client table look empty.
 */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}

export function formatInr(inr: number): string {
  if (inr === 0) return '₹0';
  const magnitude = Math.abs(inr);
  const sign = inr < 0 ? '-' : '';
  if (magnitude < 1) return `${sign}₹${magnitude.toFixed(2)}`;
  if (magnitude < 1_000) return `${sign}₹${magnitude.toFixed(magnitude < 100 ? 1 : 0)}`;
  return `${sign}₹${Math.round(magnitude).toLocaleString('en-IN')}`;
}

/** Compact token counts: 1_248_900 reads as "1.25M", not as a wall of digits. */
export function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}
