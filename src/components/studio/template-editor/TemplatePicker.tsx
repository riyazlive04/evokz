'use client';

import * as React from 'react';

import { Check, LayoutTemplate, Loader2 } from 'lucide-react';

import { listCampaignDayTemplateChoicesAction } from '@/app/admin/campaigns/clone-actions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAction } from '@/hooks/use-action';
import type { TemplateChoice } from '@/lib/campaign/clone-template-change';
import { cn } from '@/lib/utils';

/**
 * The day's template: a thumbnail, its name, and "Change".
 *
 * "Change" opens a grid of the vertical's active templates whose elements have
 * been read, with what each one holds — including the ones kept out of the daily
 * rotation, which is the only way a festival design ever reaches a day. Choosing one hands it to the editor,
 * which confirms (when the day's words were changed) and re-clones the day. The
 * list is loaded when the dialog opens, so it is never stale.
 */
export function TemplatePicker({
  dayId,
  template,
  disabledReason,
  pending,
  onChoose,
}: {
  dayId: string;
  template: { id: string; label: string; thumbnailUrl: string; aspectLabel: string | null; summary: string };
  /** Why the template cannot change now; null when it can. */
  disabledReason: string | null;
  pending: boolean;
  onChoose: (choice: TemplateChoice) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const load = useAction(listCampaignDayTemplateChoicesAction);
  const { run: runLoad } = load;
  const [choices, setChoices] = React.useState<TemplateChoice[] | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setChoices(null);
    void runLoad(dayId).then((result) => {
      if (result.ok) setChoices(result.data);
    });
  }, [open, dayId, runLoad]);

  return (
    <div className="flex items-center gap-3">
      {/* eslint-disable-next-line @next/next/no-img-element -- the session-gated template proxy serves a sized image; next/image cannot */}
      <img src={template.thumbnailUrl} alt="" className="h-16 w-14 shrink-0 rounded border border-border bg-muted object-cover" decoding="async" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground" title={template.label}>
          {template.label}
        </p>
        <p className="line-clamp-2 text-[11px] text-muted-foreground">
          {template.aspectLabel ? `${template.aspectLabel} · ` : ''}
          {template.summary}
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="h-8 shrink-0"
        disabled={disabledReason !== null || pending}
        title={disabledReason ?? undefined}
        onClick={() => setOpen(true)}
      >
        {pending ? <Loader2 className="animate-spin" /> : <LayoutTemplate />}
        Change
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader className="pr-6">
            <DialogTitle>Choose a template for this day</DialogTitle>
            <DialogDescription>
              The day&apos;s words are replaced by the chosen template&apos;s. Your photo description is kept. A poster already made becomes outdated.
            </DialogDescription>
          </DialogHeader>

          {load.error && (
            <p role="alert" className="text-[12px] text-danger-ink">
              {load.error}
            </p>
          )}
          {!choices && !load.error && (
            <p className="flex items-center gap-2 py-8 text-[12px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading templates…
            </p>
          )}
          {choices && choices.length === 0 && (
            <p className="py-8 text-center text-[12px] text-muted-foreground">
              This vertical has no active template that has been read. Open the vertical and press Read now.
            </p>
          )}
          {choices && choices.length > 0 && (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {choices.map((choice) => {
                const disabled = choice.current || !choice.usable;
                return (
                  <li key={choice.id}>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        setOpen(false);
                        onChoose(choice);
                      }}
                      className={cn(
                        'flex h-full w-full flex-col overflow-hidden rounded-lg border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        choice.current ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/60 hover:bg-accent/40',
                        !choice.usable && 'opacity-60',
                      )}
                    >
                      <span className="flex aspect-[4/5] w-full items-center justify-center bg-muted">
                        {/* eslint-disable-next-line @next/next/no-img-element -- session-gated proxy image */}
                        <img src={choice.thumbnailUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-contain" />
                      </span>
                      <span className="flex flex-1 flex-col gap-0.5 p-2">
                        <span className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
                          <span className="min-w-0 truncate">{choice.label}</span>
                          {choice.current && (
                            <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                              <Check className="h-3 w-3" aria-hidden /> In use
                            </span>
                          )}
                        </span>
                        <span className="line-clamp-2 text-[10px] text-muted-foreground">
                          {choice.aspectLabel ? `${choice.aspectLabel} · ` : ''}
                          {choice.summary}
                        </span>
                        {/* The vertical's own two flags, read straight through from the
                            template card. Nothing is filtered on them: a festival design
                            is chosen here on purpose, and the chips say it was deliberate. */}
                        {(choice.keepsOwnColours || choice.outOfRotation) && (
                          <span className="flex flex-wrap gap-1 pt-0.5">
                            {choice.keepsOwnColours && (
                              <span className="rounded-full border border-border bg-muted px-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                                Own colours
                              </span>
                            )}
                            {choice.outOfRotation && (
                              <span className="rounded-full border border-border bg-muted px-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                                Not in rotation
                              </span>
                            )}
                          </span>
                        )}
                        {!choice.usable && <span className="text-[10px] text-warning-ink">Clones cannot be made in this shape.</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
