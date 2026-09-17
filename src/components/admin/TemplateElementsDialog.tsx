'use client';

import * as React from 'react';

import { Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  groupTemplateElements,
  overlayDrawOrder,
  templateElementItems,
  type ElementCategory,
  type ElementViewItem,
} from '@/lib/templates/elements-view';
import type { TemplateElementsDoc } from '@/lib/types/template-elements';
import { cn } from '@/lib/utils';

/**
 * A template's elements, drawn over the template and listed beside it.
 *
 * This is where an admin checks what the reading found before campaign posters
 * rely on it: each element's box on the image, and the same elements grouped by
 * what a clone does to them — words the admin edits, identity filled from the
 * client's Brand Canvas, another business's details hidden by default, and the
 * photograph. Hovering either side highlights the element on both.
 *
 * Read-only apart from "Re-read", which asks first: a reading is not
 * deterministic, so a new one can differ from the one it replaces, and campaign
 * days copy their words from the elements by id.
 *
 * The dialog holds no action of its own. The card owns the read, so its pending
 * state and error survive the dialog being closed mid-read.
 */

/**
 * One colour per category, shared by the boxes, their label chips and the list's
 * swatches, so the list doubles as the legend.
 *
 * Status tokens for the three identity/photo categories and the fixed navy ramp
 * for words: the boxes sit on a poster, not on the page, so they need colours
 * that stay distinct from each other in both themes rather than page ink.
 * Dashed outlines mark the two categories a clone does not keep as they are
 * printed — hidden details and the photo.
 */
const CATEGORY_STYLES: Record<ElementCategory, { box: string; chip: string; swatch: string }> = {
  content: {
    box: 'border-navy-500 bg-navy-500/10',
    chip: 'bg-navy-600 text-navy-50',
    swatch: 'bg-navy-500',
  },
  brand: {
    box: 'border-success bg-success/10',
    chip: 'bg-success text-success-foreground',
    swatch: 'bg-success',
  },
  hidden: {
    box: 'border-dashed border-danger bg-danger/10',
    chip: 'bg-danger text-danger-foreground',
    swatch: 'bg-danger',
  },
  photo: {
    box: 'border-dashed border-warning bg-warning/5',
    chip: 'bg-warning text-warning-foreground',
    swatch: 'bg-warning',
  },
};

const READ_AT_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(3)}%`;
}

export function TemplateElementsDialog({
  open,
  onOpenChange,
  label,
  imageUrl,
  doc,
  readAt,
  lastError,
  campaignDays,
  rereading,
  rereadError,
  onReread,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The template's name. */
  label: string;
  /** The stored file, through the console's authenticated proxy. */
  imageUrl: string;
  doc: TemplateElementsDoc;
  /** ISO instant of the reading, when known. */
  readAt: string | null;
  /** Why the last re-read failed, when it did. The reading shown is the one kept. */
  lastError: string | null;
  /** Open campaign days using this template, for the re-read warning. */
  campaignDays: number;
  /** A read of this template is running. */
  rereading: boolean;
  /** The running or last read's own error, when the page does not show it yet. */
  rereadError: string | null;
  onReread: () => Promise<void>;
}) {
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [confirming, setConfirming] = React.useState(false);

  // A confirmation belongs to the moment it was asked in, not to the next time
  // the dialog opens.
  React.useEffect(() => {
    if (!open) {
      setConfirming(false);
      setActiveId(null);
    }
  }, [open]);

  const items = React.useMemo(() => templateElementItems(doc), [doc]);
  const groups = React.useMemo(() => groupTemplateElements(doc), [doc]);

  async function reread() {
    await onReread();
    setConfirming(false);
  }

  const readLine = [
    `${doc.elements.length} element${doc.elements.length === 1 ? '' : 's'}`,
    readAt ? `read ${READ_AT_FORMAT.format(new Date(readAt))}` : null,
    doc.model,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader className="pr-6">
          <DialogTitle className="truncate">{label}</DialogTitle>
          <DialogDescription>
            Campaign posters copy this template exactly and change only these.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:gap-6">
          <ElementsOverlay
            imageUrl={imageUrl}
            label={label}
            doc={doc}
            items={items}
            activeId={activeId}
            onActivate={setActiveId}
          />

          <div className="space-y-4 md:max-h-[65dvh] md:overflow-y-auto md:pr-1">
            {groups.map((group) => (
              <section key={group.category} aria-label={group.title}>
                <h3 className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', CATEGORY_STYLES[group.category].swatch)} />
                  {group.title}
                  <span className="font-mono font-normal tracking-normal text-muted-foreground/70">
                    {group.items.length}
                  </span>
                </h3>
                <ul className="divide-y divide-border/60 overflow-hidden rounded-md border border-border">
                  {group.items.map((item) => (
                    <li
                      key={item.id}
                      onMouseEnter={() => setActiveId(item.id)}
                      onMouseLeave={() => setActiveId(null)}
                      className={cn(
                        'flex gap-3 px-2.5 py-1.5 text-[11px] leading-snug transition-colors',
                        activeId === item.id && 'bg-muted',
                      )}
                    >
                      <span className="w-24 shrink-0 font-medium text-foreground">{item.label}</span>
                      <span className="min-w-0 break-words text-muted-foreground">{item.detail ?? '—'}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <p className="font-mono text-[10px] text-muted-foreground">{readLine}</p>
            {lastError && (
              <p className="text-[11px] text-warning-ink">
                The last re-read failed, so this reading was kept: {lastError}
              </p>
            )}
            {rereadError && !rereading && (
              <p role="alert" className="text-[11px] text-danger-ink">
                {rereadError}
              </p>
            )}
          </div>

          <div className="flex shrink-0 flex-col gap-2 sm:max-w-xs sm:items-end">
            {rereading ? (
              <Button size="sm" variant="outline" disabled>
                <Loader2 className="animate-spin" />
                Reading… up to a minute
              </Button>
            ) : confirming ? (
              <>
                <p className="text-[11px] text-warning-ink sm:text-right">
                  Replace this reading? A new read can differ slightly
                  {campaignDays > 0
                    ? ` — check the words on the ${campaignDays} campaign day${campaignDays === 1 ? '' : 's'} using this template afterwards.`
                    : '.'}
                </p>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={() => void reread()}>
                    Re-read now
                  </Button>
                </div>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
                <RefreshCw />
                Re-read
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The template with a labelled box per element.
 *
 * The frame takes the reading's own aspect ratio and the image fills it exactly,
 * so a box's 0-1 fractions are percentages of the frame. Its width is capped by
 * the viewport height, so a tall 9:16 template fits on screen whole instead of
 * pushing its lower elements out of sight. Photographs are drawn first: a
 * full-bleed photo would otherwise sit over every text box on it.
 */
function ElementsOverlay({
  imageUrl,
  label,
  doc,
  items,
  activeId,
  onActivate,
}: {
  imageUrl: string;
  label: string;
  doc: TemplateElementsDoc;
  items: ElementViewItem[];
  activeId: string | null;
  onActivate: (id: string | null) => void;
}) {
  const ratio = doc.width / doc.height;

  return (
    <div
      className="relative mx-auto overflow-hidden rounded-md border border-border bg-muted"
      style={{ aspectRatio: `${doc.width} / ${doc.height}`, width: `min(100%, calc(65dvh * ${ratio.toFixed(4)}))` }}
    >
      {/* A plain img for the same reason as the card: the proxy already serves
          a sized WebP that is private to this session. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageUrl}
        alt={`${label}, with its elements outlined`}
        decoding="async"
        className="absolute inset-0 h-full w-full object-fill"
      />

      {overlayDrawOrder(items).map((item) => {
        const style = CATEGORY_STYLES[item.category];
        const active = activeId === item.id;
        return (
          <div
            key={item.id}
            aria-hidden
            title={item.detail ? `${item.label}: ${item.detail}` : item.label}
            onMouseEnter={() => onActivate(item.id)}
            onMouseLeave={() => onActivate(null)}
            className={cn(
              'absolute rounded-[2px] transition-opacity',
              style.box,
              active ? 'z-10 border-2' : 'border',
              activeId !== null && !active && 'opacity-30',
            )}
            style={{
              left: percent(item.box.x),
              top: percent(item.box.y),
              width: percent(item.box.w),
              height: percent(item.box.h),
            }}
          >
            <span
              className={cn(
                'absolute left-0 top-0 whitespace-nowrap rounded-br-[2px] px-1 text-[9px] font-semibold leading-[13px]',
                style.chip,
              )}
            >
              {item.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
