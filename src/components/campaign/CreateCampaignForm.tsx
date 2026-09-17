'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { CalendarPlus, Loader2, X } from 'lucide-react';

import { createCampaignAction } from '@/app/admin/campaigns/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAction } from '@/hooks/use-action';

/**
 * Creates a DRAFT campaign with empty day slots, then opens its board.
 * No content is generated and nothing is spent until the operator asks.
 *
 * There is no template-mapping choice any more: each day's template is set on
 * the day itself, so new campaigns are always created in MANUAL mode.
 */
export function CreateCampaignForm({
  clientId,
  defaultName,
  defaultStartDate,
  planDurationDays,
}: {
  clientId: string;
  defaultName: string;
  /** YYYY-MM-DD in the app timezone. */
  defaultStartDate: string;
  planDurationDays: number;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState(defaultName);
  const [startDate, setStartDate] = React.useState(defaultStartDate);
  const [duration, setDuration] = React.useState(String(planDurationDays));
  const create = useAction(createCampaignAction);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const result = await create.run(clientId, {
      name,
      startDate,
      durationDays: Number(duration),
    });
    if (result.ok) router.push(`/admin/clients/${clientId}/campaigns/${result.data.campaignId}`);
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <CalendarPlus className="h-4 w-4" />
        New campaign
      </Button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="campaign-name">Campaign name</Label>
        <Input id="campaign-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={160} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="campaign-start">First day</Label>
        <Input id="campaign-start" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="campaign-duration">Content days</Label>
        <Input
          id="campaign-duration"
          type="number"
          min={1}
          max={730}
          value={duration}
          onChange={(event) => setDuration(event.target.value)}
          required
        />
      </div>
      {create.error && (
        <p role="alert" className="text-xs text-danger-ink sm:col-span-2">
          {create.error}
        </p>
      )}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={create.pending}>
          {create.pending && <Loader2 className="h-4 w-4 animate-spin" />}
          Create campaign
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={create.pending}>
          <X className="h-4 w-4" />
          Cancel
        </Button>
      </div>
    </form>
  );
}
