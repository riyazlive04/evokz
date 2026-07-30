'use client';

import * as React from 'react';

import { CalendarPlus, Check, Loader2 } from 'lucide-react';

import { seedContentCalendar } from '@/app/admin/dashboard/actions';
import { Button } from '@/components/ui/button';
import { useAction } from '@/hooks/use-action';

/**
 * Seeds missing ContentCalendar rows via the LLM copy stage.
 *
 * Long-running by nature (sequential batches), so the button reports progress
 * state and stays disabled while in flight.
 */
export function SeedCalendarButton({
  clientId,
  companyName,
  calendarCount,
  totalDays,
}: {
  clientId: string;
  companyName: string;
  calendarCount: number;
  totalDays: number;
}) {
  const seed = useAction(seedContentCalendar);
  const [flash, setFlash] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (flash === null) return undefined;
    const timer = setTimeout(() => setFlash(null), 6_000);
    return () => clearTimeout(timer);
  }, [flash]);

  const missing = Math.max(0, totalDays - calendarCount);
  if (missing === 0) return null;

  async function handleSeed() {
    const result = await seed.run(clientId, undefined);
    if (result.ok) {
      setFlash(
        result.data.remaining > 0
          ? `Seeded ${result.data.inserted} day(s); ${result.data.remaining} still missing — run again.`
          : `Seeded ${result.data.inserted} day(s). Calendar complete.`,
      );
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] text-amber-600">
        {calendarCount === 0
          ? `No calendar entries — nothing will be delivered for ${companyName}.`
          : `${missing} of ${totalDays} calendar days not yet written.`}
      </span>

      <Button size="sm" variant="outline" onClick={handleSeed} disabled={seed.pending}>
        {seed.pending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <CalendarPlus className="h-4 w-4" />
        )}
        {seed.pending ? `Writing ${missing} days…` : `Generate ${missing} days`}
      </Button>

      {flash && (
        <span className="flex items-center gap-1.5 text-[11px] text-emerald-600">
          <Check className="h-3.5 w-3.5" />
          {flash}
        </span>
      )}

      {seed.error && (
        <span role="alert" className="text-[11px] text-red-600">
          {seed.error}
        </span>
      )}
    </div>
  );
}
