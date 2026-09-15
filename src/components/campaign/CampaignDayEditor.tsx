'use client';

import * as React from 'react';

import { Loader2 } from 'lucide-react';

import { updateCampaignDayAction } from '@/app/admin/campaigns/actions';
import type { CampaignDayView } from '@/components/campaign/CampaignCalendar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAction } from '@/hooks/use-action';

const FIELD_CLASS =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

interface Draft {
  theme: string;
  contentType: string;
  headline: string;
  supportingText: string;
  cta: string;
  caption: string;
  hashtags: string;
  imagePrompt: string;
}

function draftOf(day: CampaignDayView): Draft {
  return {
    theme: day.theme ?? '',
    contentType: day.contentType ?? '',
    headline: day.headline ?? '',
    supportingText: day.supportingText ?? '',
    cta: day.cta ?? '',
    caption: day.caption,
    hashtags: day.hashtags,
    imagePrompt: day.imagePrompt,
  };
}

/**
 * Edits one campaign day's content by hand. Saves that day only, makes no model
 * request, and is refused if the day changed since the calendar was loaded.
 * Saving marks the day reviewed; changing a poster input marks an existing
 * poster outdated.
 */
export function CampaignDayEditor({
  day,
  pillars,
  onClose,
  onSaved,
}: {
  day: CampaignDayView | null;
  pillars: Array<{ key: string; label: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = React.useState<Draft | null>(day ? draftOf(day) : null);
  const save = useAction(updateCampaignDayAction);
  const { reset } = save;

  React.useEffect(() => {
    setDraft(day ? draftOf(day) : null);
    reset();
  }, [day, reset]);

  const set = (field: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setDraft((current) => (current ? { ...current, [field]: event.target.value } : current));

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!day || !draft) return;
    const result = await save.run(
      day.id,
      {
        theme: draft.theme,
        contentType: draft.contentType || null,
        headline: draft.headline,
        supportingText: draft.supportingText,
        cta: draft.cta,
        caption: draft.caption,
        hashtags: draft.hashtags,
        imagePrompt: draft.imagePrompt,
      },
      day.contentRevision,
    );
    if (result.ok) onSaved();
  }

  const knownType = !draft?.contentType || pillars.some((pillar) => pillar.key === draft.contentType);

  return (
    <Dialog open={day !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {day && draft && (
          <>
            <DialogHeader>
              <DialogTitle>Edit day {day.dayNumber} · {day.dateLabel}</DialogTitle>
              <DialogDescription>
                Changes this day only. No AI request is made.
                {day.poster !== 'none' && ' Changing the topic, type, headline, text, CTA or photo brief marks its poster outdated.'}
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={handleSubmit} className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="day-topic">Topic</Label>
                <Input id="day-topic" value={draft.theme} onChange={set('theme')} maxLength={200} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="day-type">Content type</Label>
                <select id="day-type" value={draft.contentType} onChange={set('contentType')} className={`${FIELD_CLASS} h-9 py-1`}>
                  <option value="">No type</option>
                  {pillars.map((pillar) => (
                    <option key={pillar.key} value={pillar.key}>
                      {pillar.label}
                    </option>
                  ))}
                  {!knownType && <option value={draft.contentType}>{draft.contentType} (not in strategy)</option>}
                </select>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="day-headline">Headline</Label>
                <Input id="day-headline" value={draft.headline} onChange={set('headline')} maxLength={200} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="day-supporting">Supporting text</Label>
                <textarea id="day-supporting" value={draft.supportingText} onChange={set('supportingText')} rows={2} maxLength={1000} className={FIELD_CLASS} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="day-cta">Call to action</Label>
                <Input id="day-cta" value={draft.cta} onChange={set('cta')} maxLength={80} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="day-caption">Caption</Label>
                <textarea id="day-caption" value={draft.caption} onChange={set('caption')} rows={4} maxLength={4000} className={FIELD_CLASS} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="day-hashtags">Hashtags</Label>
                <Input id="day-hashtags" value={draft.hashtags} onChange={set('hashtags')} maxLength={1000} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="day-image-prompt">Image prompt</Label>
                <textarea id="day-image-prompt" value={draft.imagePrompt} onChange={set('imagePrompt')} rows={3} maxLength={4000} className={FIELD_CLASS} />
              </div>

              {save.error && (
                <p role="alert" className="text-xs text-danger-ink sm:col-span-2">
                  {save.error}
                </p>
              )}

              <DialogFooter className="sm:col-span-2">
                <Button type="button" variant="ghost" onClick={onClose} disabled={save.pending}>
                  Cancel
                </Button>
                <Button type="submit" disabled={save.pending}>
                  {save.pending && <Loader2 className="h-4 w-4 animate-spin" />}
                  Save day {day.dayNumber}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
