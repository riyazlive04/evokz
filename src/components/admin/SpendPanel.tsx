import Link from 'next/link';
import { UsageProvider } from '@prisma/client';

import { BellRing, Coins, ImageIcon, Send, Sparkles, Wallet } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  PROVIDER_LABELS,
  RANGE_KEYS,
  RANGE_LABELS,
  type CostReport,
  type RangeKey,
} from '@/lib/cost-report';
import {
  formatInr,
  formatTokens,
  formatUsd,
  microsToInr,
  microsToUsd,
} from '@/lib/pricing';
import { formatDisplayDate } from '@/lib/time';
import { cn } from '@/lib/utils';

/**
 * Cost and credit consumption, overall and split by client.
 *
 * Every figure is shown in both currencies: providers invoice in USD, but the
 * agency prices campaigns in rupees, so a single-currency view would force a
 * mental conversion on every comparison.
 */

const PROVIDER_ICONS: Record<UsageProvider, React.ComponentType<{ className?: string }>> = {
  [UsageProvider.OPENAI]: Sparkles,
  [UsageProvider.FAL]: ImageIcon,
  [UsageProvider.EVOLUTION]: Send,
};

/**
 * Rebuilds the dashboard URL with one cost filter changed, carrying `?view=`
 * through so adjusting a filter does not collapse an open counter drill-down.
 */
function filterHref(
  report: CostReport,
  viewParam: string | null,
  patch: { range?: RangeKey; clientId?: string | null; provider?: UsageProvider | null },
): string {
  const params = new URLSearchParams();
  const range = patch.range ?? report.filters.range;
  const clientId = 'clientId' in patch ? patch.clientId : report.filters.clientId;
  const provider = 'provider' in patch ? patch.provider : report.filters.provider;

  if (viewParam) params.set('view', viewParam);
  if (range !== '30d') params.set('range', range);
  if (clientId) params.set('spendClient', clientId);
  if (provider) params.set('spendProvider', provider);

  const query = params.toString();
  return query ? `/admin/dashboard?${query}#spend` : '/admin/dashboard#spend';
}

export function SpendPanel({
  report,
  viewParam = null,
}: {
  report: CostReport;
  /** Current `?view=` value, preserved across filter changes. */
  viewParam?: string | null;
}) {
  const { overall, rates } = report;
  const tokensTotal = overall.inputTokens + overall.outputTokens;

  return (
    <Card id="spend">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-brand-to" />
          Cost &amp; credit consumption
        </CardTitle>
        <CardDescription>
          {report.rangeLabel}
          {report.from ? ` from ${formatDisplayDate(report.from)}` : ''} · {overall.events}{' '}
          billable call{overall.events === 1 ? '' : 's'} recorded.{' '}
          {report.trackingSince
            ? `Ledger starts ${formatDisplayDate(report.trackingSince)}.`
            : 'Nothing recorded yet.'}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        <FilterBar report={report} viewParam={viewParam} />

        {report.alerts.length > 0 && <BudgetAlerts report={report} />}

        {/* ---- Overall ---- */}
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MoneyTile
            icon={Coins}
            label="Total spend"
            micros={overall.costUsdMicros}
            rates={rates}
            hint={`${RANGE_LABELS[report.filters.range].toLowerCase()}, all providers`}
            emphasis
          />
          {report.byProvider.length === 0 ? (
            <div className="sm:col-span-2 xl:col-span-3 flex items-center rounded-xl border border-dashed border-border bg-muted/50 px-4 text-xs text-muted-foreground">
              No spend recorded in this window.
            </div>
          ) : (
            report.byProvider.map(({ provider, totals }) => (
              <MoneyTile
                key={provider}
                icon={PROVIDER_ICONS[provider]}
                label={PROVIDER_LABELS[provider]}
                micros={totals.costUsdMicros}
                rates={rates}
                hint={describeUnits(provider, totals)}
              />
            ))
          )}
        </section>

        {/* ---- Credit consumption in provider units ---- */}
        <section className="grid gap-1 sm:grid-cols-2 xl:grid-cols-4 overflow-hidden rounded-xl border border-border bg-border">
          <UnitCell label="Images rendered" value={overall.imageCount.toLocaleString('en-IN')} />
          <UnitCell label="WhatsApp messages" value={overall.messageCount.toLocaleString('en-IN')} />
          <UnitCell label="Tokens in / out" value={`${formatTokens(overall.inputTokens)} / ${formatTokens(overall.outputTokens)}`} />
          <UnitCell
            label="Prompt cache hit"
            value={
              overall.inputTokens > 0
                ? `${Math.round((overall.cachedTokens / overall.inputTokens) * 100)}%`
                : '—'
            }
            hint={tokensTotal > 0 ? `${formatTokens(overall.cachedTokens)} cached` : undefined}
          />
        </section>

        <ClientSplit report={report} />

        <RateCardNote report={report} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function FilterBar({
  report,
  viewParam,
}: {
  report: CostReport;
  viewParam: string | null;
}) {
  const { filters } = report;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/40 p-3">
      <FilterRow label="Period">
        {RANGE_KEYS.map((key) => (
          <Pill
            key={key}
            href={filterHref(report, viewParam, { range: key })}
            active={filters.range === key}
          >
            {RANGE_LABELS[key]}
          </Pill>
        ))}
      </FilterRow>

      <FilterRow label="Provider">
        <Pill href={filterHref(report, viewParam, { provider: null })} active={filters.provider === null}>
          All
        </Pill>
        {(Object.keys(PROVIDER_LABELS) as UsageProvider[]).map((provider) => (
          <Pill
            key={provider}
            href={filterHref(report, viewParam, { provider })}
            active={filters.provider === provider}
          >
            {PROVIDER_LABELS[provider]}
          </Pill>
        ))}
      </FilterRow>

      {report.clientOptions.length > 0 && (
        <FilterRow label="Client">
          <Pill href={filterHref(report, viewParam, { clientId: null })} active={filters.clientId === null}>
            All
          </Pill>
          {report.clientOptions.map((client) => (
            <Pill
              key={client.id}
              href={filterHref(report, viewParam, { clientId: client.id })}
              active={filters.clientId === client.id}
            >
              {client.companyName}
              {client.isDemo ? ' (demo)' : ''}
            </Pill>
          ))}
        </FilterRow>
      )}
    </div>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className="w-16 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

function Pill({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'rounded-full border px-2.5 py-0.5 text-[11px] transition-colors duration-200',
        active
          ? 'border-brand-to/50 bg-brand-to/10 font-medium text-foreground'
          : 'border-border text-muted-foreground hover:border-brand-to/40 hover:text-foreground',
      )}
    >
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

function MoneyTile({
  icon: Icon,
  label,
  micros,
  rates,
  hint,
  emphasis = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  micros: number;
  rates: CostReport['rates'];
  hint: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border bg-card p-4',
        emphasis ? 'border-brand-to/40 shadow-brand-glow-sm' : 'border-border',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {label}
        </p>
        <Icon className={cn('h-4 w-4 shrink-0', emphasis ? 'text-brand-to' : 'text-muted-foreground')} />
      </div>
      <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-foreground">
        {formatInr(microsToInr(micros, rates))}
      </p>
      <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatUsd(microsToUsd(micros))}
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}

function UnitCell({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="bg-card p-4">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Budget alerts
// ---------------------------------------------------------------------------

function BudgetAlerts({ report }: { report: CostReport }) {
  return (
    <div className="space-y-2 rounded-xl border border-danger/30 bg-danger/[0.06] p-4">
      <p className="flex items-center gap-2 text-xs font-semibold text-danger-ink">
        <BellRing className="h-4 w-4 shrink-0" />
        {report.alerts.length} client{report.alerts.length === 1 ? '' : 's'} over the monthly
        cap
      </p>
      <ul className="space-y-1">
        {report.alerts.map((row) => (
          <li key={row.clientId ?? 'orphan'} className="text-[11px] text-danger-ink">
            <span className="font-medium">{row.companyName}</span> — spent{' '}
            <span className="font-mono">{formatInr(row.monthSpendInr)}</span> this month against
            a <span className="font-mono">{formatInr(row.monthlyBudgetInr ?? 0)}</span> cap
            {row.budgetUsedPercent !== null && (
              <span className="font-mono"> ({Math.round(row.budgetUsedPercent)}%)</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-client split
// ---------------------------------------------------------------------------

function ClientSplit({ report }: { report: CostReport }) {
  if (report.clients.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border bg-muted/50 px-4 py-8 text-center text-xs text-muted-foreground">
        No clients to split spend across yet.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
        Split by client
      </h3>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Client</TableHead>
              <TableHead className="text-right">Images</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Sent</TableHead>
              <TableHead className="text-right">Spend</TableHead>
              <TableHead className="text-right">Per post</TableHead>
              <TableHead className="text-right">Fee</TableHead>
              <TableHead className="text-right">Margin</TableHead>
              <TableHead className="text-right">Budget</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.clients.map((row) => (
              <TableRow key={row.clientId ?? 'orphan'}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    {row.clientId ? (
                      <Link
                        href={
                          row.isDemo
                            ? `/admin/demo?tenant=${row.clientId}`
                            : `/admin/clients/${row.clientId}`
                        }
                        className="font-medium text-foreground underline-offset-4 decoration-primary/40 transition-colors duration-200 hover:underline hover:decoration-primary"
                      >
                        {row.companyName}
                      </Link>
                    ) : (
                      <span className="italic text-muted-foreground">{row.companyName}</span>
                    )}
                    {row.isDemo && <Badge variant="amber">Demo</Badge>}
                  </div>
                  {row.planName && (
                    <span className="text-[10px] text-muted-foreground">{row.planName}</span>
                  )}
                </TableCell>

                <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {row.totals.imageCount || '—'}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {row.totals.inputTokens + row.totals.outputTokens > 0
                    ? formatTokens(row.totals.inputTokens + row.totals.outputTokens)
                    : '—'}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {row.deliveredPosts || '—'}
                </TableCell>

                <TableCell className="text-right">
                  <span className="block font-mono text-xs font-medium tabular-nums text-foreground">
                    {formatInr(row.spendInr)}
                  </span>
                  <span className="block font-mono text-[10px] tabular-nums text-muted-foreground">
                    {formatUsd(microsToUsd(row.totals.costUsdMicros))}
                  </span>
                </TableCell>

                <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {row.costPerPostInr === null ? '—' : formatInr(row.costPerPostInr)}
                </TableCell>

                <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {row.priceInr === null ? (
                    <span className="text-warning-ink" title="Set a price on this plan">
                      unpriced
                    </span>
                  ) : (
                    formatInr(row.priceInr)
                  )}
                </TableCell>

                <TableCell className="text-right">
                  {row.marginInr === null ? (
                    <span className="font-mono text-xs text-muted-foreground">—</span>
                  ) : (
                    <>
                      <span
                        className={cn(
                          'block font-mono text-xs font-medium tabular-nums',
                          row.marginInr >= 0 ? 'text-success-ink' : 'text-danger-ink',
                        )}
                      >
                        {formatInr(row.marginInr)}
                      </span>
                      {row.marginPercent !== null && (
                        <span className="block font-mono text-[10px] tabular-nums text-muted-foreground">
                          {row.marginPercent.toFixed(1)}%
                        </span>
                      )}
                    </>
                  )}
                </TableCell>

                <TableCell className="text-right">
                  {row.monthlyBudgetInr === null ? (
                    <span className="font-mono text-[10px] text-muted-foreground">no cap</span>
                  ) : (
                    <div className="space-y-1">
                      <span
                        className={cn(
                          'block font-mono text-[10px] tabular-nums',
                          row.overBudget ? 'text-danger-ink' : 'text-muted-foreground',
                        )}
                      >
                        {formatInr(row.monthSpendInr)} / {formatInr(row.monthlyBudgetInr)}
                      </span>
                      <div className="ml-auto h-1 w-16 overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn(
                            'h-full rounded-full',
                            row.overBudget ? 'bg-danger' : 'bg-primary',
                          )}
                          style={{
                            width: `${Math.min(100, Math.round(row.budgetUsedPercent ?? 0))}%`,
                          }}
                        />
                      </div>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <p className="text-[10px] text-muted-foreground">
        Spend, images, tokens and sent counts follow the selected period. Fee is the plan&apos;s
        full campaign price, and margin is that fee minus period spend — so margin only reads
        true once the period covers the whole campaign. Budget always measures the current
        calendar month, whatever period is selected.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

function describeUnits(
  provider: UsageProvider,
  totals: { imageCount: number; messageCount: number; inputTokens: number; outputTokens: number },
): string {
  switch (provider) {
    case UsageProvider.FAL:
      return `${totals.imageCount.toLocaleString('en-IN')} image${totals.imageCount === 1 ? '' : 's'}`;
    case UsageProvider.EVOLUTION:
      return `${totals.messageCount.toLocaleString('en-IN')} message${totals.messageCount === 1 ? '' : 's'}`;
    case UsageProvider.OPENAI:
      return `${formatTokens(totals.inputTokens + totals.outputTokens)} tokens`;
  }
}

function RateCardNote({ report }: { report: CostReport }) {
  const { rates } = report;

  return (
    <div className="space-y-1.5 border-t border-border pt-4 text-[10px] leading-relaxed text-muted-foreground">
      <p className="font-semibold uppercase tracking-widest">Rate card in use</p>
      <p className="font-mono">
        OpenAI ${rates.openAiInputPerMTok}/${rates.openAiCachedInputPerMTok} in ·{' '}
        ${rates.openAiOutputPerMTok} out per 1M tokens · fal.ai ${rates.falPerImage}/image ·
        WhatsApp ${rates.whatsAppPerMessage}/message · ₹{rates.usdInr} per $1
      </p>
      <p>
        Set from <code>PRICE_*</code> and <code>USD_INR_RATE</code>. These are defaults, not
        quotes — check them against your provider invoices, because every figure above is
        derived from them.
        {report.hasBackfilled &&
          ' Rows reconstructed from delivery history carry exact counts priced at the current rate, not the rate in force at the time.'}
      </p>
    </div>
  );
}
