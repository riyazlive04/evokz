import { DeliveryStatus, UsageKeySource, UsageProvider } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { getRateCard, microsToInr, type RateCard } from '@/lib/pricing';
import { getAppTimeZone, startOfZonedDay, zonedDayRange } from '@/lib/time';

/**
 * Spend aggregation for the dashboard.
 *
 * Reads the append-only `UsageEvent` ledger. Totals come from grouped SQL sums
 * rather than loading rows into memory, so the panel stays cheap as the ledger
 * grows past the point where a year of daily sends would be millions of rows.
 */

export const RANGE_KEYS = ['7d', '30d', '90d', 'mtd', 'all'] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];

export const RANGE_LABELS: Record<RangeKey, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  mtd: 'This month',
  all: 'All time',
};

export const PROVIDER_LABELS: Record<UsageProvider, string> = {
  [UsageProvider.OPENAI]: 'OpenAI · copy',
  [UsageProvider.FAL]: 'fal.ai · images',
  [UsageProvider.EVOLUTION]: 'WhatsApp · delivery',
};

export interface CostFilters {
  range: RangeKey;
  clientId: string | null;
  provider: UsageProvider | null;
}

export function parseRange(raw: string | string[] | undefined): RangeKey {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return RANGE_KEYS.includes(value as RangeKey) ? (value as RangeKey) : '30d';
}

export function parseProvider(raw: string | string[] | undefined): UsageProvider | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value in PROVIDER_LABELS ? (value as UsageProvider) : null;
}

/** Inclusive lower bound for a range key; `null` means unbounded. */
export function rangeStart(range: RangeKey, now: Date, timeZone: string): Date | null {
  if (range === 'all') return null;

  if (range === 'mtd') {
    // First instant of the current month in the app's zone, reached by walking
    // back to day 1 rather than by arithmetic on UTC.
    const today = startOfZonedDay(now, timeZone);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(today);
    const day = Number.parseInt(parts.slice(8, 10), 10);
    return startOfZonedDay(new Date(today.getTime() - (day - 1) * 86_400_000), timeZone);
  }

  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  // Aligned to a day boundary so the window does not slide with the clock and
  // give a different total on every page load.
  const { start } = zonedDayRange(now, timeZone);
  return new Date(start.getTime() - (days - 1) * 86_400_000);
}

export interface SpendTotals {
  costUsdMicros: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  imageCount: number;
  messageCount: number;
  events: number;
}

const ZERO: SpendTotals = {
  costUsdMicros: 0,
  inputTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
  imageCount: 0,
  messageCount: 0,
  events: 0,
};

export interface ClientSpendRow {
  clientId: string | null;
  companyName: string;
  isDemo: boolean;
  planName: string | null;
  /** Campaign fee in rupees, or null when the plan is unpriced. */
  priceInr: number | null;
  monthlyBudgetInr: number | null;
  totals: SpendTotals;
  spendInr: number;
  deliveredPosts: number;
  /** Spend per delivered post, in rupees. Null when nothing has landed yet. */
  costPerPostInr: number | null;
  /** Fee minus spend. Null when the plan carries no price. */
  marginInr: number | null;
  marginPercent: number | null;
  /** Current-month spend against the cap — independent of the chosen range. */
  monthSpendInr: number;
  budgetUsedPercent: number | null;
  overBudget: boolean;
}

export interface CostReport {
  filters: CostFilters;
  rates: RateCard;
  rangeLabel: string;
  from: Date | null;
  overall: SpendTotals;
  overallInr: number;
  byProvider: Array<{ provider: UsageProvider; totals: SpendTotals; inr: number }>;
  clients: ClientSpendRow[];
  /** Clients whose current-month spend exceeds their cap. */
  alerts: ClientSpendRow[];
  /** Ledger start, so the panel can say what it does not know. */
  trackingSince: Date | null;
  /** True when any row in range was reconstructed rather than observed. */
  hasBackfilled: boolean;
  /**
   * Images rendered on the operator's own fal.ai key in range — counted here but
   * costed nowhere, because that invoice arrives from fal.ai directly. Lets the
   * panel say why its image count and its spend no longer move together.
   */
  byoImageCount: number;
  byoEvents: number;
  clientOptions: Array<{ id: string; companyName: string; isDemo: boolean }>;
}

/** Shape of Prisma's `_sum` block for the ledger's numeric columns. */
interface SumBlock {
  costUsdMicros: number | null;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  imageCount: number | null;
  messageCount: number | null;
}

function toTotals(sum: SumBlock, events: number): SpendTotals {
  return {
    costUsdMicros: sum.costUsdMicros ?? 0,
    inputTokens: sum.inputTokens ?? 0,
    cachedTokens: sum.cachedTokens ?? 0,
    outputTokens: sum.outputTokens ?? 0,
    imageCount: sum.imageCount ?? 0,
    messageCount: sum.messageCount ?? 0,
    events,
  };
}

const SUM_FIELDS = {
  costUsdMicros: true,
  inputTokens: true,
  cachedTokens: true,
  outputTokens: true,
  imageCount: true,
  messageCount: true,
} as const;

/**
 * Folds one grouped row into totals, counting money only when the platform paid.
 *
 * A BYO row is a real call — it rendered an image, and it shows in every unit count
 * — but its invoice arrives from fal.ai on the operator's own account. Adding its
 * `costUsdMicros` would inflate agency spend, deflate cost-per-post, and fire budget
 * alerts over money Evokz never pays.
 */
function toAttributedTotals(
  sum: SumBlock,
  events: number,
  keySource: UsageKeySource,
): SpendTotals {
  const totals = toTotals(sum, events);
  return keySource === UsageKeySource.PLATFORM ? totals : { ...totals, costUsdMicros: 0 };
}

function addTotals(a: SpendTotals, b: SpendTotals): SpendTotals {
  return {
    costUsdMicros: a.costUsdMicros + b.costUsdMicros,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    imageCount: a.imageCount + b.imageCount,
    messageCount: a.messageCount + b.messageCount,
    events: a.events + b.events,
  };
}

export async function loadCostReport(
  filters: CostFilters,
  now = new Date(),
): Promise<CostReport> {
  const timeZone = getAppTimeZone();
  const rates = getRateCard();
  const from = rangeStart(filters.range, now, timeZone);
  const monthFrom = rangeStart('mtd', now, timeZone);

  const where = {
    ...(from ? { createdAt: { gte: from } } : {}),
    ...(filters.clientId ? { clientId: filters.clientId } : {}),
    ...(filters.provider ? { provider: filters.provider } : {}),
  };

  const [
    providerGroups,
    clientGroups,
    monthGroups,
    deliveredGroups,
    clientRecords,
    firstEvent,
    backfilledCount,
  ] = await Promise.all([
    // Grouped by key source as well, so BYO spend can be dropped from the money
    // while its unit counts stay. `provider` is NOT NULL, so these rows are an
    // exact partition of `where` — which is why there is no separate overall
    // aggregate any more: folding these gives the same figure and the two can no
    // longer disagree.
    prisma.usageEvent.groupBy({
      by: ['provider', 'keySource'],
      where,
      _sum: SUM_FIELDS,
      _count: { _all: true },
    }),
    prisma.usageEvent.groupBy({
      by: ['clientId', 'keySource'],
      where,
      _sum: SUM_FIELDS,
      _count: { _all: true },
    }),
    // Budget alerts always measure the calendar month, whatever range is shown,
    // so switching to "Last 7 days" cannot make an over-budget client look fine.
    //
    // BYO rows are excluded outright here rather than zeroed: the cap exists to
    // protect the agency's margin, and spend on the operator's own fal.ai account
    // never touches it.
    prisma.usageEvent.groupBy({
      by: ['clientId'],
      where: {
        keySource: UsageKeySource.PLATFORM,
        ...(monthFrom ? { createdAt: { gte: monthFrom } } : {}),
      },
      _sum: { costUsdMicros: true },
    }),
    prisma.contentCalendar.groupBy({
      by: ['clientId'],
      where: {
        deliveryStatus: DeliveryStatus.DELIVERED,
        ...(from ? { updatedAt: { gte: from } } : {}),
      },
      _count: { _all: true },
    }),
    prisma.client.findMany({
      orderBy: [{ isDemo: 'asc' }, { companyName: 'asc' }],
      select: {
        id: true,
        companyName: true,
        isDemo: true,
        monthlyBudgetInr: true,
        plan: { select: { name: true, priceInr: true } },
      },
    }),
    prisma.usageEvent.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    prisma.usageEvent.count({ where: { ...where, backfilled: true } }),
  ]);

  // Both group sets now carry two rows per key where they used to carry one, so
  // each is folded back down with money attributed as it goes.
  const spendByClient = new Map<string | null, SpendTotals>();
  for (const group of clientGroups) {
    spendByClient.set(
      group.clientId,
      addTotals(
        spendByClient.get(group.clientId) ?? ZERO,
        toAttributedTotals(group._sum, group._count._all, group.keySource),
      ),
    );
  }

  const spendByProvider = new Map<UsageProvider, SpendTotals>();
  let byoImageCount = 0;
  let byoEvents = 0;
  for (const group of providerGroups) {
    spendByProvider.set(
      group.provider,
      addTotals(
        spendByProvider.get(group.provider) ?? ZERO,
        toAttributedTotals(group._sum, group._count._all, group.keySource),
      ),
    );
    if (group.keySource === UsageKeySource.BYO) {
      byoImageCount += group._sum.imageCount ?? 0;
      byoEvents += group._count._all;
    }
  }

  const overall = [...spendByProvider.values()].reduce(addTotals, ZERO);

  const monthByClient = new Map(
    monthGroups.map((group) => [group.clientId, group._sum.costUsdMicros ?? 0]),
  );
  const deliveredByClient = new Map(
    deliveredGroups.map((group) => [group.clientId, group._count._all]),
  );

  const rows: ClientSpendRow[] = clientRecords
    .filter((client) => !filters.clientId || client.id === filters.clientId)
    .map((client) => {
      const totals = spendByClient.get(client.id) ?? ZERO;
      const spendInr = microsToInr(totals.costUsdMicros, rates);
      const deliveredPosts = deliveredByClient.get(client.id) ?? 0;
      const priceInr = client.plan.priceInr ?? null;
      const monthSpendInr = microsToInr(monthByClient.get(client.id) ?? 0, rates);
      const budget = client.monthlyBudgetInr;

      return {
        clientId: client.id,
        companyName: client.companyName,
        isDemo: client.isDemo,
        planName: client.plan.name,
        priceInr,
        monthlyBudgetInr: budget ?? null,
        totals,
        spendInr,
        deliveredPosts,
        costPerPostInr: deliveredPosts > 0 ? spendInr / deliveredPosts : null,
        marginInr: priceInr === null ? null : priceInr - spendInr,
        marginPercent:
          priceInr === null || priceInr === 0
            ? null
            : ((priceInr - spendInr) / priceInr) * 100,
        monthSpendInr,
        budgetUsedPercent:
          budget && budget > 0 ? (monthSpendInr / budget) * 100 : null,
        overBudget: Boolean(budget && budget > 0 && monthSpendInr > budget),
      };
    });

  // Spend whose client row was removed still belongs in the agency total.
  const orphan = spendByClient.get(null);
  if (orphan && !filters.clientId) {
    const spendInr = microsToInr(orphan.costUsdMicros, rates);
    rows.push({
      clientId: null,
      // Not "Removed clients": a Test-key probe has no client either, and lands
      // in exactly this bucket the moment an operator checks their key.
      companyName: 'Unattributed',
      isDemo: false,
      planName: null,
      priceInr: null,
      monthlyBudgetInr: null,
      totals: orphan,
      spendInr,
      deliveredPosts: 0,
      costPerPostInr: null,
      marginInr: null,
      marginPercent: null,
      monthSpendInr: microsToInr(monthByClient.get(null) ?? 0, rates),
      budgetUsedPercent: null,
      overBudget: false,
    });
  }

  rows.sort((a, b) => b.totals.costUsdMicros - a.totals.costUsdMicros);

  return {
    filters,
    rates,
    rangeLabel: RANGE_LABELS[filters.range],
    from,
    overall,
    overallInr: microsToInr(overall.costUsdMicros, rates),
    byProvider: [...spendByProvider.entries()]
      .map(([provider, totals]) => ({
        provider,
        totals,
        inr: microsToInr(totals.costUsdMicros, rates),
      }))
      .sort((a, b) => b.totals.costUsdMicros - a.totals.costUsdMicros),
    clients: rows,
    alerts: rows.filter((row) => row.overBudget),
    trackingSince: firstEvent?.createdAt ?? null,
    hasBackfilled: backfilledCount > 0,
    byoImageCount,
    byoEvents,
    clientOptions: clientRecords.map((client) => ({
      id: client.id,
      companyName: client.companyName,
      isDemo: client.isDemo,
    })),
  };
}

export { addTotals };
