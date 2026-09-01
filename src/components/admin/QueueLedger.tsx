import { DeliveryStatus } from '@prisma/client';
import {
  AlertTriangle,
  Clock,
  ExternalLink,
  EyeOff,
  ImageOff,
  ImageUp,
  Layers,
  Maximize2,
  Send,
} from 'lucide-react';

import { QueueCardActions } from '@/components/admin/QueueCardActions';
import { StatusBadge } from '@/components/admin/StatusBadge';

export interface QueueEntry {
  id: string;
  companyName: string;
  whatsappNumber: string;
  cronTime: string;
  dayNumber: number;
  theme: string | null;
  caption: string;
  hashtags: string;
  scheduledLabel: string;
  status: DeliveryStatus;
  /** When a generated-but-unsent poster is due to go out, if it is waiting. */
  sendAfterLabel: string | null;
  /** A generated poster nobody has approved. Nothing will send it until they do. */
  awaitingApproval: boolean;
  /** Approved but not yet booked to send, so the approval can still be taken back. */
  canWithdrawApproval: boolean;
  /**
   * The reference template this poster was drawn from, or null when no template
   * is recorded — a day not yet generated, or one whose template was deleted.
   *
   * The single most-asked question about a finished poster and, until now, one
   * the console could not answer at all: an operator looking at a creative that
   * came out wrong had no way to get from it back to the template responsible,
   * short of a database query.
   */
  templateLabel: string | null;
  /** True when a sheet named that template for this day, rather than the rotation choosing it. */
  templatePinned: boolean;
  /**
   * True when the operator uploaded this poster finished, rather than the
   * pipeline drawing it.
   *
   * Changes what the card offers and what it claims. There is nothing to
   * regenerate — no template, no brief, no copy — and no rotation to report
   * either, so the card says what this row actually is instead of leaving every
   * explanation on it describing a poster this system drew.
   */
  isManualUpload: boolean;
  /** Lightweight Drive thumbnail; falls back to the raw view URL. */
  thumbnailUrl: string | null;
  /**
   * The same asset at its native resolution, for looking at properly.
   *
   * A separate URL rather than reusing `viewUrl`: that one is the direct-download
   * form, so a browser saves the file instead of showing it — which is the wrong
   * gesture for "let me see this poster before I approve it".
   */
  fullUrl: string | null;
  viewUrl: string | null;
  errorMessage: string | null;
}

/**
 * How the creative is framed.
 *
 * `scan` crops to a square, which packs a long feed and is fine when the question
 * is "which of these failed". `review` shows the whole poster on a portrait card,
 * because approving one means signing off on the parts a square crop removes —
 * the logo lockup at the top and the contact bar at the bottom, which is exactly
 * where a wrong phone number would be.
 */
export type QueueLedgerVariant = 'scan' | 'review';

export function QueueLedger({
  entries,
  emptyMessage = 'No calendar entries queued. Seed a client’s ContentCalendar to populate this feed.',
  variant = 'scan',
}: {
  entries: QueueEntry[];
  /** Overrides the empty copy on filtered views, where "seed a calendar" is the wrong advice. */
  emptyMessage?: string;
  variant?: QueueLedgerVariant;
}) {
  if (entries.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border bg-muted/60 px-4 py-10 text-center text-xs text-muted-foreground">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div
      className={
        variant === 'review'
          ? 'grid gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4'
          : 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4'
      }
    >
      {entries.map((entry) => (
        <QueueCard key={entry.id} entry={entry} variant={variant} />
      ))}
    </div>
  );
}

function QueueCard({
  entry,
  variant,
}: {
  entry: QueueEntry;
  variant: QueueLedgerVariant;
}) {
  const hasAsset = Boolean(entry.viewUrl);
  const review = variant === 'review';

  return (
    <article className="flex flex-col overflow-hidden rounded-xl border border-border bg-card transition-all duration-300 hover:border-primary/40 hover:shadow-brand-glow-sm">
      {/* Creative preview, pulled from the recorded Drive asset. */}
      <div
        className={`relative w-full overflow-hidden border-b border-border bg-muted ${
          review ? 'aspect-[3/4]' : 'aspect-square'
        }`}
      >
        {entry.thumbnailUrl ? (
          /*
           * The card's thumbnail is capped well below the poster's real size, so
           * a detail an operator is signing off on — a phone number, a headline
           * that ran long — can be too small to read here. Clicking opens the
           * asset at full resolution, which is the gesture the grid otherwise
           * invited and did not answer.
           *
           * A new tab rather than an in-page lightbox: the browser's own image
           * viewer already zooms and pans, and it leaves the approvals grid
           * exactly where it was.
           */
          <a
            href={entry.fullUrl ?? entry.thumbnailUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="group/zoom block h-full w-full cursor-zoom-in"
            aria-label={`View day ${entry.dayNumber} poster for ${entry.companyName} at full size`}
          >
            {/* Drive serves these; a plain img avoids per-host remotePatterns
                config and keeps the optimizer out of a high-density grid. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={entry.thumbnailUrl}
              alt={`Day ${entry.dayNumber} creative for ${entry.companyName}`}
              loading="lazy"
              decoding="async"
              // Google's content host can reject a request that carries a
              // localhost referrer; it needs none to serve a link-readable file.
              referrerPolicy="no-referrer"
              className={
                review
                  ? 'h-full w-full object-contain'
                  : 'h-full w-full object-cover transition-transform duration-500 group-hover/zoom:scale-105'
              }
            />
            {/* Hover-only, because the affordance is otherwise invisible: a
                poster looks no different from a static image until you try. */}
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover/zoom:opacity-100">
              <span className="flex items-center gap-1.5 rounded-full bg-background/85 px-2.5 py-1 text-[10px] font-medium text-foreground shadow-sm">
                <Maximize2 className="h-3 w-3" />
                Full size
              </span>
            </span>
          </a>
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground/50">
            <ImageOff className="h-7 w-7" />
            <span className="text-[10px] uppercase tracking-widest">Not generated</span>
          </div>
        )}

        <div className="absolute left-2.5 top-2.5">
          <StatusBadge status={entry.status} />
        </div>

        {/* Overlays the creative itself, so it stays light-on-dark whatever
            the page theme is doing. */}
        <div className="absolute right-2.5 top-2.5 rounded-full bg-scrim/80 px-2 py-0.5 font-mono text-[10px] text-navy-100 backdrop-blur-sm">
          Day {String(entry.dayNumber).padStart(3, '0')}
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <header className="space-y-1">
          <h4 className="truncate text-sm font-semibold text-foreground">
            {entry.companyName}
          </h4>
          {/* Rendered only when present. An imported day carries no content
              angle, and an empty <p> would leave a line of dead space on every
              card in a sheet-seeded campaign. */}
          {entry.theme && (
            <p className="line-clamp-1 text-xs font-medium text-foreground">{entry.theme}</p>
          )}
          <p className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            {entry.scheduledLabel} · {entry.cronTime} · +{entry.whatsappNumber}
          </p>
          {/* Which reference drew this. Rendered only once there is one, so a
              day still waiting to generate does not claim a template it has not
              been given — the pin is written by the import, but the rotation
              picks at render time and a pending row genuinely has no answer.

              "pinned" vs "rotation" is the actionable half: the same wrong
              poster is fixed by editing the sheet in one case and by
              withdrawing the template in the other. */}
          {entry.templateLabel && (
            <p className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
              <Layers className="h-3 w-3" />
              {entry.templateLabel}
              <span className="text-muted-foreground/60">
                {entry.templatePinned ? '· pinned by sheet' : '· rotation'}
              </span>
            </p>
          )}
          {/* Explains the otherwise-puzzling state of a poster that exists but
              has not been sent: it is waiting out its randomised send delay. */}
          {/* Said plainly, because every other explanation on this card — the
              template, the rotation, the awaiting-approval line — is about a
              poster this system drew, and none of them apply here. */}
          {entry.isManualUpload && (
            <p className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
              <ImageUp className="h-3 w-3" />
              Uploaded by hand
              <span className="text-muted-foreground/60">· approved on upload</span>
            </p>
          )}
          {entry.sendAfterLabel && (
            <p className="flex items-center gap-1.5 font-mono text-[10px] text-brand-to">
              <Send className="h-3 w-3" />
              Sending {entry.sendAfterLabel}
            </p>
          )}
          {/* The other, more common reason a generated poster is sitting still.
              Without this the card looks identical to one mid-delay, and an
              operator waits for a send that is never coming. */}
          {entry.awaitingApproval && (
            <p className="flex items-center gap-1.5 font-mono text-[10px] text-warning-ink">
              <EyeOff className="h-3 w-3" />
              Awaiting approval
            </p>
          )}
        </header>

        <p className="line-clamp-3 flex-1 text-[11px] leading-relaxed text-muted-foreground">
          {entry.caption}
        </p>

        {entry.hashtags && (
          <p className="line-clamp-1 text-[10px] text-muted-foreground/70">{entry.hashtags}</p>
        )}

        {entry.errorMessage && (
          <p className="flex items-start gap-1.5 rounded-md border border-danger/20 bg-danger/5 p-2 text-[10px] leading-relaxed text-danger-ink">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="line-clamp-3">{entry.errorMessage}</span>
          </p>
        )}

        {/*
          * A failed row, or a manual upload that has not gone out yet.
          *
          * The second is the only correction a manually-uploaded poster has.
          * There is no regenerate for one — no template, no brief, nothing to
          * draw again — so without this a poster scheduled onto the wrong day
          * could not be fixed from the console at all. Delivered rows stay
          * undeletable whatever wrote them: the row is the record of the send.
          */}
        <QueueCardActions
          calendarId={entry.id}
          hasAsset={hasAsset}
          deletable={
            entry.status === DeliveryStatus.FAILED ||
            (entry.isManualUpload && entry.status === DeliveryStatus.GENERATED)
          }
          awaitingApproval={entry.awaitingApproval}
          canWithdrawApproval={entry.canWithdrawApproval}
          canRegenerate={!entry.isManualUpload}
          deleteBinsArtwork={entry.isManualUpload}
        />

        {entry.viewUrl && (
          <a
            href={entry.viewUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground transition-colors duration-200 hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
            Open in Drive
          </a>
        )}
      </div>
    </article>
  );
}
