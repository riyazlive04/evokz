'use client';

import * as React from 'react';

import { AlertTriangle, CalendarPlus, Check, Loader2, X } from 'lucide-react';

import { seedContentCalendar } from '@/app/admin/dashboard/actions';
import { Button } from '@/components/ui/button';
import { useAction } from '@/hooks/use-action';

/**
 * Seeds missing ContentCalendar rows via the LLM copy stage.
 *
 * Long-running by nature (sequential batches), so the button reports progress
 * state and stays disabled while in flight.
 *
 * Guarded on `hasBrandTokens`, because seeding before tokenizing is a mistake
 * that cannot be undone in place: the generator folds the palette, typography
 * and layout directives into every imagePrompt, and re-running only fills gaps
 * (`createMany({ skipDuplicates: true })`) so it will never overwrite the
 * generic copy it wrote the first time. Recovering means clearing the calendar
 * and paying for the whole campaign again.
 */
export function SeedCalendarButton({
  clientId,
  companyName,
  calendarCount,
  totalDays,
  hasBrandTokens,
}: {
  clientId: string;
  companyName: string;
  calendarCount: number;
  totalDays: number;
  /** False when `Client.brandGuideline` has no extracted colours. */
  hasBrandTokens: boolean;
}) {
  const seed = useAction(seedContentCalendar);
  const [flash, setFlash] = React.useState<string | null>(null);
  const [confirmingBlind, setConfirmingBlind] = React.useState(false);

  React.useEffect(() => {
    if (flash === null) return undefined;
    const timer = setTimeout(() => setFlash(null), 6_000);
    return () => clearTimeout(timer);
  }, [flash]);

  // Same auto-disarm as QueueCardActions: a confirm left armed on a card the
  // operator scrolled past is a trap.
  React.useEffect(() => {
    if (!confirmingBlind) return undefined;
    const timer = setTimeout(() => setConfirmingBlind(false), 8_000);
    return () => clearTimeout(timer);
  }, [confirmingBlind]);

  const missing = Math.max(0, totalDays - calendarCount);
  if (missing === 0) return null;

  async function runSeed() {
    setConfirmingBlind(false);
    const result = await seed.run(clientId, undefined);
    if (result.ok) {
      setFlash(
        result.data.remaining > 0
          ? `Seeded ${result.data.inserted} day(s); ${result.data.remaining} still missing — run again.`
          : `Seeded ${result.data.inserted} day(s). Calendar complete.`,
      );
    }
  }

  function handleSeed() {
    // Tokenized clients seed straight away; untokenized ones must confirm.
    if (hasBrandTokens) {
      void runSeed();
      return;
    }
    setConfirmingBlind(true);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] text-warning-ink">
        {calendarCount === 0
          ? `No calendar entries — nothing will be delivered for ${companyName}.`
          : `${missing} of ${totalDays} calendar days not yet written.`}
      </span>

      {!confirmingBlind && (
        <Button size="sm" variant="outline" onClick={handleSeed} disabled={seed.pending}>
          {seed.pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CalendarPlus className="h-4 w-4" />
          )}
          {seed.pending ? `Writing ${missing} days…` : `Generate ${missing} days`}
        </Button>
      )}

      {!hasBrandTokens && !confirmingBlind && !seed.pending && (
        <span className="flex items-center gap-1.5 text-[11px] text-warning-ink">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          No brand tokens extracted yet
        </span>
      )}

      {confirmingBlind && (
        <div className="flex w-full items-start gap-2 rounded-md border border-warning/30 bg-warning/5 p-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-ink" />
          <span className="flex-1 text-[11px] leading-relaxed text-warning-ink">
            {companyName} has no brand tokens, so all {missing} days would be written
            with generic copy that ignores their palette, fonts and voice.{' '}
            <strong className="font-semibold">
              Re-seeding later cannot replace them
            </strong>{' '}
            — the generator only fills empty days. Extract tokens on the brand canvas
            first, or continue if this is deliberate.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void runSeed()}
            disabled={seed.pending}
            title="Generate anyway, without brand tokens"
          >
            Generate anyway
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setConfirmingBlind(false)}
            disabled={seed.pending}
            aria-label="Cancel"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      {flash && (
        <span className="flex items-center gap-1.5 text-[11px] text-success-ink">
          <Check className="h-3.5 w-3.5" />
          {flash}
        </span>
      )}

      {seed.error && (
        <span role="alert" className="text-[11px] text-danger-ink">
          {seed.error}
        </span>
      )}
    </div>
  );
}
