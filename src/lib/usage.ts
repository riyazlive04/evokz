import { UsageKeySource, UsageProvider } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import {
  priceCutouts,
  priceImages,
  priceMessages,
  priceOpenAiCall,
  priceOpenAiImageCall,
  type ImageTokenUsage,
  type TokenUsage,
} from '@/lib/pricing';

/**
 * Append-only spend ledger.
 *
 * Every recorder is fire-and-forget by design: the money has already been spent
 * by the time we get here, so a failed ledger insert must never turn a
 * successful generation into a pipeline failure. Failures are logged loudly
 * instead, because a silent gap in the ledger is worse than a noisy one.
 */

export interface UsageContext {
  clientId?: string | null;
  calendarId?: string | null;
}

/** Which stage spent the money. Kept as a small closed set for grouping. */
export type UsageOperation =
  | 'calendar'
  | 'brand-tokenizer'
  | 'image'
  // Background removal on a rendered frame, for a layout cell that wants a
  // cut-out subject rather than a photographic region. Distinct from `image`
  // because it is priced an order of magnitude lower and because a client
  // accruing these is one whose vertical uses cut-out templates — which is worth
  // being able to see in the ledger without inferring it from the volume.
  | 'image-cutout'
  // Single-day poster-copy repair. Separate from `calendar` so the ledger shows
  // backfill spend distinctly — a client accruing these is one whose batch seeding
  // is returning unusable poster blocks, which is a prompt problem worth seeing.
  | 'poster-copy'
  // Vision read of an uploaded reference template, once per upload. Distinct
  // from the per-day operations because it is the only spend here that scales
  // with the size of the template library rather than with the campaign.
  | 'layout-extract'
  // Vision read of the same reference, asking where its blocks of type sit so a
  // clean plate can have copy composited into them. Separate from
  // `layout-extract` because the two are chosen rather than sequenced — a
  // template is either rebuilt from its grid or composited onto its plate — and
  // a vertical's split between the two is the thing worth seeing in the ledger.
  | 'plate-regions'
  // Naming the blocks of type a pixel pass has already measured, once per
  // upload. Distinct from `plate-regions`, which is what it replaces: that call
  // was asked for geometry and answered with a grid of tenths, so the geometry
  // moved to `detectTextBlocks` and the model kept only the classification. A
  // vertical still accruing `plate-regions` is one whose templates were read
  // before the split, which is worth being able to see.
  | 'plate-labels'
  // Reading a template's changeable elements — its words, photo and identity —
  // once per upload, for clone mode. Distinct from the plate and layout reads
  // it retires, so a vertical's move from one to the other shows in the ledger.
  | 'template-elements'
  // Reading a cloned poster's words back after generation to compare them with
  // what was asked for. Once per clone, so it scales with posters, not templates.
  | 'text-check'
  // "Rewrite with AI" on a cloned campaign poster: fresh wording for the
  // template's words, one short text call per day.
  | 'clone-rewrite'
  // One image from the AI Poster Studio (gpt-image-2 generate or edit). Its own
  // operation, not `image`: that one is fal.ai's per-image render on the delivery
  // pipeline, and the cost report counts studio rows separately because they may
  // be unpriced — see `recordOpenAiImageUsage`.
  | 'studio-image'
  | 'whatsapp';

/** Operation string for studio images, exported for the cost report's unpriced count. */
export const STUDIO_IMAGE_OPERATION: UsageOperation = 'studio-image';

async function record(data: {
  provider: UsageProvider;
  operation: UsageOperation;
  context: UsageContext;
  model?: string | null;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  imageCount?: number;
  messageCount?: number;
  costUsdMicros: number;
  keySource?: UsageKeySource;
}): Promise<void> {
  try {
    await prisma.usageEvent.create({
      data: {
        clientId: data.context.clientId ?? null,
        calendarId: data.context.calendarId ?? null,
        provider: data.provider,
        operation: data.operation,
        model: data.model ?? null,
        inputTokens: data.inputTokens ?? 0,
        cachedTokens: data.cachedTokens ?? 0,
        outputTokens: data.outputTokens ?? 0,
        imageCount: data.imageCount ?? 0,
        messageCount: data.messageCount ?? 0,
        costUsdMicros: data.costUsdMicros,
        // Omitted by the OpenAI and WhatsApp recorders, which have no
        // operator-supplied key to spend — the column default says PLATFORM, and
        // for them that is simply true.
        keySource: data.keySource ?? UsageKeySource.PLATFORM,
      },
    });
  } catch (error) {
    console.error(
      `[ace:usage] failed to record ${data.provider}/${data.operation} spend:`,
      error instanceof Error ? error.message : error,
    );
  }
}

export async function recordOpenAiUsage(
  usage: TokenUsage,
  model: string,
  operation: UsageOperation,
  context: UsageContext,
): Promise<void> {
  // A zero-token response would only add noise to the ledger.
  if (usage.inputTokens <= 0 && usage.outputTokens <= 0) return;

  await record({
    provider: UsageProvider.OPENAI,
    operation,
    context,
    model,
    inputTokens: usage.inputTokens,
    cachedTokens: usage.cachedTokens,
    outputTokens: usage.outputTokens,
    costUsdMicros: priceOpenAiCall(usage),
  });
}

export async function recordImageUsage(
  endpoint: string,
  context: UsageContext,
  /**
   * Which credential paid. Must come from the *same* resolved credentials object
   * that made the call, never re-resolved here: a key saved between the fal
   * request and this insert would otherwise mis-attribute the one row where the
   * attribution matters most — the row that straddles the change.
   */
  keySource: UsageKeySource,
  count = 1,
): Promise<void> {
  await record({
    provider: UsageProvider.FAL,
    operation: 'image',
    context,
    model: endpoint,
    imageCount: count,
    // Priced at the platform rate card either way. On a BYO row the figure is
    // never added up — see `toAttributedTotals` in cost-report — but recording it
    // keeps the ledger a faithful statement of what the render was worth.
    costUsdMicros: priceImages(count),
    keySource,
  });
}

/**
 * One background-removal call against a frame fal has already rendered.
 *
 * A separate recorder rather than a flag on `recordImageUsage`, because the two
 * differ in both of the things that matter downstream: the operation string the
 * cost report groups on, and the rate. Segmentation is roughly a tenth the price
 * of diffusion, so folding it into `image` would report every cut-out poster as
 * costing twice what it does — on the same ledger the monthly budget alerts read.
 *
 * Still `imageCount`, and deliberately: the column counts billable fal units, and
 * a cut-out is one. What separates it from a render is `operation` and the money.
 */
export async function recordCutoutUsage(
  endpoint: string,
  context: UsageContext,
  keySource: UsageKeySource,
  count = 1,
): Promise<void> {
  await record({
    provider: UsageProvider.FAL,
    operation: 'image-cutout',
    context,
    model: endpoint,
    imageCount: count,
    costUsdMicros: priceCutouts(count),
    keySource,
  });
}

/**
 * One GPT image call from the AI Poster Studio.
 *
 * Recorded on every successful response, before the image is stored anywhere —
 * the money is spent at that point whether or not Drive or the database then
 * accept the result.
 *
 * **Zero money here means "not priced", not "free".** OpenAI's image response
 * carries token counts but no price, and the image-token rates have no defaults
 * (see `RateCard.openAiImageTextInputPerMTok`). Until they are configured the row
 * keeps its exact token and image counts with `costUsdMicros` 0, and
 * `loadCostReport` reports how many studio images in range are unpriced so the
 * panel can say its total is incomplete. `costUsdMicros` is NOT NULL on a table
 * that predates the studio, so null is not available without altering it.
 *
 * `inputTokens` is text and image input together, matching the column's meaning
 * everywhere else; the text/image split is only needed for pricing.
 *
 * PLATFORM always: the studio only ever calls with the environment's key.
 */
export async function recordOpenAiImageUsage(
  usage: ImageTokenUsage | null,
  model: string,
  context: UsageContext,
  count = 1,
): Promise<void> {
  const priced = priceOpenAiImageCall(usage);

  if (priced === null) {
    console.warn(
      `[ace:usage] ${model} studio image recorded unpriced — set PRICE_OPENAI_IMAGE_* to cost it, and reconcile against OpenAI billing.`,
    );
  }

  await record({
    provider: UsageProvider.OPENAI,
    operation: STUDIO_IMAGE_OPERATION,
    context,
    model,
    inputTokens: usage ? usage.textInputTokens + usage.imageInputTokens : 0,
    outputTokens: usage?.outputTokens ?? 0,
    imageCount: count,
    costUsdMicros: priced ?? 0,
    keySource: UsageKeySource.PLATFORM,
  });
}

export async function recordWhatsAppUsage(
  context: UsageContext,
  count = 1,
): Promise<void> {
  await record({
    provider: UsageProvider.EVOLUTION,
    operation: 'whatsapp',
    context,
    messageCount: count,
    costUsdMicros: priceMessages(count),
  });
}
