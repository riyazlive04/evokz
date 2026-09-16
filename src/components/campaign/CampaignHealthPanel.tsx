import Link from 'next/link';

import { AlertTriangle, CheckCircle2 } from 'lucide-react';

import { badgeVariants } from '@/components/ui/badge';
import type { AttentionItem } from '@/lib/campaign/operations';
import { cn } from '@/lib/utils';

/**
 * Campaign health and the needs-attention queue (Phase 7).
 *
 * One place an operator can look to answer "is this campaign fine?", and — when
 * it is not — a list of the specific days that are not, each linking into the
 * queue that fixes it. Nobody should have to scan 365 days to find day 17.
 *
 * A server component: it renders numbers that were already counted and has no
 * interactive state of its own. Every link is a filter on this same page.
 */

export interface HealthRow {
  label: string;
  done: number;
  total: number;
  /** Where the shortfall is fixed, when there is one. */
  href?: string;
  note?: string;
}

export interface UsageView {
  generations: number;
  /** Already formatted server-side — the rate card lives in the environment. */
  estimatedCost: string | null;
  unpriced: number;
  messages: number;
}

const GROUP_LABELS: Record<AttentionItem['group'], string> = {
  CONTENT: 'Content',
  TEMPLATE: 'Template',
  POSTER: 'Poster',
  APPROVAL: 'Approval',
  DELIVERY: 'Delivery',
};

export function CampaignHealthPanel({
  rows,
  usage,
  attention,
  attentionTotal,
  basePath,
  queued,
}: {
  rows: HealthRow[];
  usage: UsageView;
  attention: AttentionItem[];
  /** The true count, which may exceed the listed items. */
  attentionTotal: number;
  basePath: string;
  queued: number;
}) {
  const grouped = new Map<AttentionItem['group'], AttentionItem[]>();
  for (const item of attention) {
    const list = grouped.get(item.group) ?? [];
    list.push(item);
    grouped.set(item.group, list);
  }

  return (
    <section aria-label="Campaign health" className="space-y-4">
      {/* ---- Counters ------------------------------------------------------- */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map((row) => {
          const complete = row.total > 0 && row.done >= row.total;
          const body = (
            <>
              <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                {row.label}
                {complete && <CheckCircle2 className="h-3 w-3 text-success-ink" />}
              </p>
              <p className="mt-0.5 font-mono text-[15px] text-foreground">
                {row.done} <span className="text-muted-foreground">/ {row.total}</span>
              </p>
              {row.note && <p className="text-[11px] text-muted-foreground">{row.note}</p>}
            </>
          );
          return row.href ? (
            <Link
              key={row.label}
              href={`${basePath}${row.href}`}
              className="rounded-lg border border-border px-3 py-2 transition-colors hover:bg-accent"
            >
              {body}
            </Link>
          ) : (
            <div key={row.label} className="rounded-lg border border-border px-3 py-2">
              {body}
            </div>
          );
        })}
      </div>

      {/* ---- AI usage ------------------------------------------------------- */}
      <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-[12px]">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">AI usage</p>
        <p className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-foreground">
          <span>
            <span className="font-mono text-[15px]">{usage.generations}</span> generation
            {usage.generations === 1 ? '' : 's'}
          </span>
          {usage.messages > 0 && (
            <span>
              <span className="font-mono text-[15px]">{usage.messages}</span> message
              {usage.messages === 1 ? '' : 's'}
            </span>
          )}
          {usage.estimatedCost ? (
            <span>
              <span className={badgeVariants({ variant: 'slate' })}>Estimated</span>{' '}
              <span className="font-mono text-[15px]">{usage.estimatedCost}</span>
            </span>
          ) : null}
          {queued > 0 && <span className="text-warning-ink">{queued} queued to generate</span>}
        </p>
        {/*
          An estimate is never presented as a bill. The image API returns token
          counts and no price, so this is the rate card applied to those counts —
          and when the rates are unset it says so instead of showing zero.
        */}
        {usage.unpriced > 0 ? (
          <p className="mt-1 text-[11px] text-warning-ink">
            {usage.unpriced} generation{usage.unpriced === 1 ? '' : 's'} recorded with no price. Set
            {' '}
            <code className="font-mono">PRICE_OPENAI_IMAGE_*</code> to cost them — the token counts are exact, so the
            figure is recoverable.
          </p>
        ) : (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Estimated from recorded tokens and the configured rate card, not from a provider invoice.
          </p>
        )}
      </div>

      {/* ---- Needs attention ------------------------------------------------ */}
      {attentionTotal === 0 ? (
        <p className="flex items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2.5 text-[12px] text-muted-foreground">
          <CheckCircle2 className="h-3.5 w-3.5 text-success-ink" />
          Nothing needs attention.
        </p>
      ) : (
        <div className="rounded-lg border border-border">
          <p className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-widest text-warning-ink">
            <AlertTriangle className="h-3.5 w-3.5" />
            Needs attention ({attentionTotal})
          </p>
          <ul className="divide-y divide-border">
            {[...grouped.entries()].map(([group, items]) => (
              <li key={group} className="px-3 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  {GROUP_LABELS[group]}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {items.map((item) => (
                    <li key={`${item.group}-${item.dayId}`}>
                      <Link
                        href={`${basePath}${item.href}`}
                        className={cn(
                          'flex flex-wrap items-baseline gap-x-2 text-[12px] underline-offset-2 hover:underline',
                        )}
                      >
                        <span className="font-semibold text-foreground">Day {item.dayNumber}</span>
                        <span className="text-muted-foreground">{item.detail}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          {attentionTotal > attention.length && (
            <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
              Showing the first {attention.length} of {attentionTotal}. Fix these and the rest will surface.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
