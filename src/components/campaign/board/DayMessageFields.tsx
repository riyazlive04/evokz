'use client';

import * as React from 'react';
import { Check, Loader2, Lock } from 'lucide-react';

import { saveCampaignDayMessageAction } from '@/app/admin/campaigns/board-actions';
import type { BoardDayView } from '@/components/campaign/board/types';
import { Button } from '@/components/ui/button';
import { MAX_CAPTION_LENGTH } from '@/lib/campaign/delivery';
import { cn } from '@/lib/utils';

/**
 * The words that go out with a ready-to-send poster: Caption and Link, sent
 * with the image on WhatsApp, and Notes for the team, which never leave the
 * console. Saving never touches the poster, its approval or its booking.
 *
 * Read-only once the post is being sent or has been sent — what left is shown
 * as it left.
 */
export function DayMessageFields({
  campaignId,
  day,
  onEditingChange,
  onSaved,
}: {
  campaignId: string;
  day: BoardDayView;
  /** True while a field has focus, so the card is not dragged instead of the text selected. */
  onEditingChange: (editing: boolean) => void;
  onSaved: () => void;
}) {
  const saved = day.message;
  const [caption, setCaption] = React.useState(saved.caption);
  const [link, setLink] = React.useState(saved.link ?? '');
  const [notes, setNotes] = React.useState(saved.notes ?? '');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [justSaved, setJustSaved] = React.useState(false);

  // A refresh after someone else's save (or this one) brings the stored values.
  React.useEffect(() => {
    setCaption(saved.caption);
    setLink(saved.link ?? '');
    setNotes(saved.notes ?? '');
  }, [saved.caption, saved.link, saved.notes]);

  const dirty = caption !== saved.caption || link !== (saved.link ?? '') || notes !== (saved.notes ?? '');
  const length = caption.trim().length + (link.trim() ? link.trim().length + 2 : 0);
  const tooLong = length > MAX_CAPTION_LENGTH;
  const id = `day-${day.id}-message`;

  const save = async () => {
    setError(null);
    setPending(true);
    try {
      const result = await saveCampaignDayMessageAction(campaignId, day.id, {
        caption,
        link: link.trim() ? link : null,
        notes: notes.trim() ? notes : null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCaption(result.data.caption);
      setLink(result.data.link ?? '');
      setNotes(result.data.notes ?? '');
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 2000);
      onSaved();
    } catch {
      setError('Saving did not complete. Your session may have expired — reload the page.');
    } finally {
      setPending(false);
    }
  };

  if (!saved.editable) {
    return (
      <div className="space-y-1 rounded-md border border-border bg-muted/40 p-2 text-[11px]" aria-label={`Message for day ${day.dayNumber}`}>
        <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Lock className="h-3 w-3" aria-hidden /> {saved.lockedReason ?? 'Read-only'}
        </p>
        <p className="whitespace-pre-line break-words text-foreground">{saved.caption || <span className="italic text-muted-foreground">No caption — headline, text and CTA are sent.</span>}</p>
        {saved.link && <p className="break-all text-brand-to">{saved.link}</p>}
        {saved.notes && (
          <p className="whitespace-pre-line break-words text-muted-foreground">
            <span className="font-semibold">Notes (internal):</span> {saved.notes}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      className="space-y-1.5 rounded-md border border-border bg-muted/30 p-2"
      aria-label={`Message for day ${day.dayNumber}`}
      onFocus={() => onEditingChange(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onEditingChange(false);
      }}
    >
      <label htmlFor={`${id}-caption`} className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Caption
      </label>
      <textarea
        id={`${id}-caption`}
        value={caption}
        rows={3}
        disabled={pending}
        onChange={(event) => setCaption(event.target.value)}
        placeholder="Sent with the poster. Empty: headline, text and CTA are sent."
        className="w-full resize-y rounded border border-input bg-background px-2 py-1 text-[11px] leading-4 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <label htmlFor={`${id}-link`} className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Link <span className="font-normal normal-case">(optional)</span>
      </label>
      <input
        id={`${id}-link`}
        type="text"
        inputMode="url"
        value={link}
        disabled={pending}
        onChange={(event) => setLink(event.target.value)}
        placeholder="https://…"
        className="w-full rounded border border-input bg-background px-2 py-1 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <label htmlFor={`${id}-notes`} className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Notes <span className="font-normal normal-case">(internal — never sent)</span>
      </label>
      <textarea
        id={`${id}-notes`}
        value={notes}
        rows={2}
        disabled={pending}
        onChange={(event) => setNotes(event.target.value)}
        className="w-full resize-y rounded border border-input bg-background px-2 py-1 text-[11px] leading-4 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      />
      {error && (
        <p role="alert" className="text-[11px] text-danger-ink">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" className="h-7 px-2 text-[11px]" disabled={!dirty || pending || tooLong} onClick={save}>
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : justSaved ? <Check className="h-3 w-3" /> : null}
          {justSaved ? 'Saved' : 'Save message'}
        </Button>
        <span className={cn('ml-auto font-mono text-[10px]', tooLong ? 'text-danger-ink' : 'text-muted-foreground')} title="Caption and link together, as WhatsApp counts them">
          {length}/{MAX_CAPTION_LENGTH}
        </span>
      </div>
    </div>
  );
}
