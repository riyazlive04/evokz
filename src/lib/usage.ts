import { UsageKeySource, UsageProvider } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import {
  priceImages,
  priceMessages,
  priceOpenAiCall,
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
  // Single-day poster-copy repair. Separate from `calendar` so the ledger shows
  // backfill spend distinctly — a client accruing these is one whose batch seeding
  // is returning unusable poster blocks, which is a prompt problem worth seeing.
  | 'poster-copy'
  // Vision read of an uploaded reference template, once per upload. Distinct
  // from the per-day operations because it is the only spend here that scales
  // with the size of the template library rather than with the campaign.
  | 'layout-extract'
  | 'whatsapp';

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
