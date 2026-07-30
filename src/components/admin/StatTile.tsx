import Link from 'next/link';

import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

// `brand` tracks the palette; the rest stay literal because they are semantic
// status colours, not brand colours.
const TONE_CLASSES = {
  brand: 'text-brand-to',
  amber: 'text-amber-600',
  emerald: 'text-emerald-600',
  red: 'text-red-600',
  slate: 'text-muted-foreground',
} as const;

export type StatTone = keyof typeof TONE_CLASSES;

export function StatTile({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'brand',
  href,
  active = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  hint: string;
  tone?: StatTone;
  /** When set, the whole tile becomes a link to its detail breakdown. */
  href?: string;
  /** Marks the tile whose breakdown is currently open. */
  active?: boolean;
}) {
  const card = (
    <Card
      className={cn(
        'h-full transition-all duration-300 hover:border-brand-to/40 hover:shadow-brand-glow-sm',
        active && 'border-brand-to/60 shadow-brand-glow-sm',
      )}
    >
      <CardContent className="flex items-start justify-between gap-3 p-5">
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            {label}
          </p>
          <p className="font-mono text-3xl font-semibold text-foreground">{value}</p>
          <p className="text-[11px] text-muted-foreground">{hint}</p>
        </div>
        <Icon className={`h-5 w-5 shrink-0 ${TONE_CLASSES[tone]}`} />
      </CardContent>
    </Card>
  );

  if (!href) return card;

  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? 'true' : undefined}
      title={active ? `Hide ${label.toLowerCase()} detail` : `Show ${label.toLowerCase()} detail`}
      className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      {card}
    </Link>
  );
}
