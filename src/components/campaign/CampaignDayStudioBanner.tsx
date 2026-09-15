'use client';

import * as React from 'react';
import Link from 'next/link';

import { ArrowLeft, CalendarRange, Check, Loader2 } from 'lucide-react';

import { saveStudioPosterToCampaignDayAction } from '@/app/admin/campaigns/actions';
import { Button } from '@/components/ui/button';
import { useAction } from '@/hooks/use-action';
import type { CampaignDayStudioContext } from '@/lib/campaign/poster-generation-service';
import type { StudioHistoryItem } from '@/lib/poster-studio/history';

/**
 * Shown above the Poster Studio workspace when it was opened from a campaign day.
 *
 * Poster Studio itself is unchanged: an Edit or Variation made here is an
 * ordinary history item. Only "Save to Day N" turns the selected poster into the
 * day's new active version — explicitly, and only for a poster of the campaign's
 * client in the campaign's format.
 */
export function CampaignDayStudioBanner({
  context,
  current,
  busy,
}: {
  context: CampaignDayStudioContext;
  /** The poster selected in the studio preview. */
  current: StudioHistoryItem | null;
  busy: boolean;
}) {
  const save = useAction(saveStudioPosterToCampaignDayAction);
  const [saved, setSaved] = React.useState<{ generationId: string; versionNumber: number; alreadySaved: boolean } | null>(null);

  const calendarUrl = `/admin/clients/${context.clientId}/campaigns/${context.campaignId}`;
  const reason = !current
    ? 'Select a poster to save it to this day.'
    : current.clientId !== context.clientId
      ? `The selected poster was not made for ${context.companyName}.`
      : current.aspectRatio !== context.aspectRatio
        ? `The selected poster is ${current.aspectRatio}; this campaign's posters are ${context.aspectRatio ?? 'not a Poster Studio format'}.`
        : current.id === context.activeGenerationId
          ? `The selected poster is already Day ${context.dayNumber}'s active version.`
          : null;

  return (
    <div role="status" className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-foreground">
      <p className="flex flex-wrap items-center gap-2">
        <CalendarRange className="h-4 w-4 shrink-0 text-brand-to" />
        <span>
          Campaign day: <span className="font-semibold">Day {context.dayNumber}</span> of {context.campaignName} ({context.companyName})
          {context.activeVersionNumber ? ` · editing v${context.activeVersionNumber}` : ' · no poster yet'}
        </span>
      </p>
      <p className="text-[12px] text-muted-foreground">
        Posters you make here stay in History and are not added to the campaign until you save one to this day. Saving creates a new
        version and makes it active; earlier versions are kept.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={busy || save.pending || reason !== null}
          onClick={async () => {
            if (!current) return;
            const result = await save.run(context.dayId, current.id);
            if (result.ok) setSaved({ generationId: current.id, ...result.data });
          }}
        >
          {save.pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          Save to Day {context.dayNumber}
        </Button>
        <Button asChild size="sm" variant="ghost">
          <Link href={calendarUrl}>
            <ArrowLeft className="h-4 w-4" />
            Back to campaign
          </Link>
        </Button>
        {reason && !saved && <span className="text-[12px] text-muted-foreground">{reason}</span>}
      </div>
      {saved && (
        <p className="text-[12px] text-success-ink">
          {saved.alreadySaved
            ? `That poster was already saved to Day ${context.dayNumber} as v${saved.versionNumber}.`
            : `Saved to Day ${context.dayNumber} as v${saved.versionNumber}, now the active poster.`}
        </p>
      )}
      {save.error && (
        <p role="alert" className="text-[12px] text-danger-ink">
          {save.error}
        </p>
      )}
    </div>
  );
}
