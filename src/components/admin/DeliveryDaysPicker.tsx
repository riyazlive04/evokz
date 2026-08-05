'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * Weekday selector for a client's delivery schedule.
 *
 * The value is ISO weekdays (1 = Monday … 7 = Sunday). An empty array means
 * "every day" in the database, but the picker never *emits* empty — a client
 * with no delivery days would never receive anything, which is what pausing is
 * for. Selecting all seven is normalised back to empty by the server.
 *
 * Presentational only: it holds no server state and fires no action. Callers
 * decide when to persist, because onboarding writes once on submit while the
 * client detail page saves on demand.
 */

const DAYS: Array<{ iso: number; short: string; full: string }> = [
  { iso: 1, short: 'M', full: 'Monday' },
  { iso: 2, short: 'T', full: 'Tuesday' },
  { iso: 3, short: 'W', full: 'Wednesday' },
  { iso: 4, short: 'T', full: 'Thursday' },
  { iso: 5, short: 'F', full: 'Friday' },
  { iso: 6, short: 'S', full: 'Saturday' },
  { iso: 7, short: 'S', full: 'Sunday' },
];

const PRESETS: Array<{ label: string; days: number[] }> = [
  { label: 'Every day', days: [1, 2, 3, 4, 5, 6, 7] },
  { label: 'Mon–Fri', days: [1, 2, 3, 4, 5] },
  { label: 'Weekends', days: [6, 7] },
];

export function DeliveryDaysPicker({
  value,
  onChange,
  disabled = false,
  id = 'delivery-days',
}: {
  /** ISO weekdays. Empty is treated as every day. */
  value: number[];
  onChange: (next: number[]) => void;
  disabled?: boolean;
  id?: string;
}) {
  // Empty means unrestricted, so render it as all seven selected.
  const selected = value.length === 0 ? DAYS.map((day) => day.iso) : value;

  function toggle(iso: number) {
    const next = selected.includes(iso)
      ? selected.filter((day) => day !== iso)
      : [...selected, iso].sort((a, b) => a - b);

    // Refuse to empty the set from the UI — the last day cannot be turned off.
    if (next.length === 0) return;
    onChange(next);
  }

  const matchedPreset = PRESETS.find(
    (preset) => preset.days.join() === [...selected].sort((a, b) => a - b).join(),
  );

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Delivery days</Label>

      <div id={id} role="group" aria-label="Delivery days" className="flex flex-wrap gap-1">
        {DAYS.map((day) => {
          const on = selected.includes(day.iso);
          return (
            <button
              key={day.iso}
              type="button"
              disabled={disabled}
              onClick={() => toggle(day.iso)}
              aria-pressed={on}
              title={day.full}
              className={cn(
                'h-8 w-8 rounded-md border text-[11px] font-semibold transition-colors duration-200 disabled:opacity-50',
                on
                  ? 'border-primary/40 bg-primary/15 text-foreground'
                  : 'border-border text-muted-foreground hover:border-brand-to/40 hover:text-foreground',
              )}
            >
              {day.short}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((preset) => (
          <Button
            key={preset.label}
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange(preset.days)}
            className={cn(
              'h-6 px-2 text-[10px]',
              matchedPreset?.label === preset.label && 'text-brand-to',
            )}
          >
            {preset.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
