'use client';

import * as React from 'react';
import Link from 'next/link';

import { AlertTriangle, Ban, Check, Loader2, Lock, Pencil, RefreshCw, RotateCcw, Send, TextSearch, X } from 'lucide-react';

import { rejectCampaignDayPosterAction } from '@/app/admin/campaigns/actions';
import { loadBoardDayDetailsAction, type BoardDayDetailsView } from '@/app/admin/campaigns/board-actions';
import { BOARD_STATUS_VARIANT, Chip, type ChipVariant } from '@/components/campaign/board/board-ui';
import type { CardActionKind } from '@/components/campaign/board/BoardDayCard';
import type { BoardDayView } from '@/components/campaign/board/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAction } from '@/hooks/use-action';
import { templateEditorHref } from '@/lib/campaign/clone-editor-view';
import { MAX_REJECTION_DETAIL, REJECTION_REASONS } from '@/lib/campaign/review';
import { cn } from '@/lib/utils';

const APPROVAL_VARIANT: Record<string, ChipVariant> = { APPROVED: 'emerald', REJECTED: 'destructive', PENDING: 'amber' };
const SOURCE_LABEL: Record<string, string> = { PIPELINE: 'Generated', POSTER_STUDIO: 'Edited in Poster Studio', MANUAL_UPLOAD: 'Uploaded' };
const DELIVERY_VARIANT: Record<string, ChipVariant> = { SCHEDULED: 'emerald', SENDING: 'secondary', SENT: 'slate', FAILED: 'destructive', CANCELLED: 'slate', SKIPPED: 'slate' };

const FIELD_CLASS =
  'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * One day in full: the poster and every earlier version, the day's words
 * (read-only here), the delivery record with its attempts and failure, and the
 * decisions: approve, reject with a reason, regenerate, send, retry, cancel.
 *
 * "Open editor" is the dialog's primary link: Poster Studio's template poster
 * editor is where a day's words, template and poster are worked on, so the
 * decisions beside it are outlined rather than competing with it.
 *
 * Card-level actions are passed in from the board (`onAction`), so a decision
 * made here goes through exactly the same confirmation and refresh as the same
 * button on the card. Rejection lives here because it needs a reason.
 */
export function DayDetailsDialog({
  campaignId,
  day,
  closed,
  startRejecting,
  busyKind,
  onClose,
  onAction,
  onChanged,
}: {
  campaignId: string;
  /** The card's current view of the day; the dialog closes if it leaves the page. */
  day: BoardDayView | null;
  closed: boolean;
  /** Opened from "Reject…": show the reason form straight away. */
  startRejecting: boolean;
  busyKind: CardActionKind | null;
  onClose: () => void;
  onAction: (kind: CardActionKind, day: BoardDayView) => void;
  onChanged: () => void;
}) {
  const load = useAction(loadBoardDayDetailsAction);
  const reject = useAction(rejectCampaignDayPosterAction);
  const { run: runLoad } = load;

  const [details, setDetails] = React.useState<BoardDayDetailsView | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [rejecting, setRejecting] = React.useState(false);
  const [reason, setReason] = React.useState<string>(REJECTION_REASONS[0].key);
  const [note, setNote] = React.useState('');
  const [message, setMessage] = React.useState<string | null>(null);

  const dayId = day?.id ?? null;
  // Reload whenever the card changes under us (an action here, a refresh).
  const cardVersion = day ? `${day.status}|${day.poster?.versionId ?? ''}|${day.poster?.approvalStatus ?? ''}|${day.delivery?.status ?? ''}|${day.delivery?.attempts ?? 0}` : '';

  React.useEffect(() => {
    setRejecting(startRejecting);
    setMessage(null);
    setNote('');
    setReason(REJECTION_REASONS[0].key);
    setSelectedId(null);
    setDetails(null);
  }, [dayId, startRejecting]);

  React.useEffect(() => {
    if (!dayId) return;
    void runLoad(campaignId, dayId).then((result) => {
      if (result.ok) setDetails(result.data);
    });
  }, [campaignId, dayId, cardVersion, runLoad]);

  const versions = details?.versions ?? [];
  const selected = versions.find((version) => version.id === selectedId) ?? versions.find((version) => version.active) ?? versions[0] ?? null;
  const active = versions.find((version) => version.active) ?? null;

  return (
    <Dialog
      open={day !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
        {day && (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2 pr-6">
                Day {day.dayNumber}
                <span className="font-mono text-[11px] font-normal text-muted-foreground">{day.dateLabel}</span>
                <Chip variant={BOARD_STATUS_VARIANT[day.status]}>{day.statusLabel}</Chip>
                {day.lock && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-normal text-muted-foreground">
                    <Lock className="h-3 w-3" /> {day.lockLabel}
                  </span>
                )}
              </DialogTitle>
              <DialogDescription>
                {day.template ? `Template: ${day.template.label}` : 'No template — use Fill empty days or pick one in Poster Studio.'}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 sm:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
              {/* ---- Poster ---- */}
              <div className="space-y-2">
                <div className="flex aspect-[3/4] items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
                  {selected?.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={selected.id} src={selected.imageUrl} alt={`Day ${day.dayNumber} poster, version ${selected.versionNumber}`} className="h-full w-full object-contain" />
                  ) : load.pending && !details ? (
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />
                  ) : (
                    <p className="px-4 text-center text-[12px] text-muted-foreground">{versions.length === 0 ? 'No poster generated yet.' : 'No preview for this version.'}</p>
                  )}
                </div>
                {selected?.fullImageUrl && (
                  <a className="text-[11px] underline underline-offset-2" href={selected.fullImageUrl} target="_blank" rel="noreferrer">
                    Open full size
                  </a>
                )}
              </div>

              <div className="min-w-0 space-y-4">
                {/* ---- Words ---- */}
                <section className="space-y-1">
                  <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Content</h3>
                  <p className="text-sm font-medium text-foreground">{details?.content.headline ?? day.headline ?? (day.template ? 'This template has no headline — its words are in the editor.' : 'No headline yet.')}</p>
                  {details?.content.supportingText && <p className="text-[12px] text-muted-foreground">{details.content.supportingText}</p>}
                  {details?.content.cta && <p className="text-[12px] text-muted-foreground">Call to action: {details.content.cta}</p>}
                  <Button asChild size="sm" className="mt-1 h-8">
                    <Link href={templateEditorHref(day.id)}>
                      <Pencil className="h-3.5 w-3.5" />
                      Open editor
                    </Link>
                  </Button>
                </section>

                {day.note && (
                  <p
                    className={cn(
                      'flex items-start gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px]',
                      day.note.tone === 'danger' ? 'border-danger/30 bg-danger/5 text-danger-ink' : day.note.tone === 'warning' ? 'border-warning/30 bg-warning/5 text-warning-ink' : 'border-border text-muted-foreground',
                    )}
                  >
                    <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                    {day.note.text}
                  </p>
                )}

                {/* ---- Decisions ---- */}
                {!closed && (
                  <div className="flex flex-wrap items-center gap-2">
                    {day.actions.canApprove && (
                      <Button size="sm" variant="outline" className="h-8" disabled={busyKind !== null} onClick={() => onAction('approve', day)}>
                        {busyKind === 'approve' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        Approve v{day.poster?.versionNumber}
                      </Button>
                    )}
                    {day.actions.canReject && !rejecting && (
                      <Button size="sm" variant="outline" className="h-8" disabled={busyKind !== null} onClick={() => setRejecting(true)}>
                        <X className="h-3.5 w-3.5" />
                        Reject…
                      </Button>
                    )}
                    {(day.actions.canRegenerate || day.actions.canGenerate) && (
                      <Button size="sm" variant="ghost" className="h-8" disabled={busyKind !== null} onClick={() => onAction(day.actions.canRegenerate ? 'regenerate' : 'generate', day)}>
                        {busyKind === 'generate' || busyKind === 'regenerate' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                        {day.actions.canRegenerate ? 'Regenerate' : 'Generate'}
                      </Button>
                    )}
                  </div>
                )}

                {rejecting && active && day.actions.canReject && (
                  <form
                    className="space-y-2 rounded-md border border-border p-3"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      const result = await reject.run(day.id, active.id, { reason, detail: note });
                      if (result.ok) {
                        setRejecting(false);
                        setNote('');
                        setMessage(`Sent back: ${result.data.note}. The poster is kept — edit or regenerate it.`);
                        onChanged();
                      }
                    }}
                  >
                    <p className="text-[12px] font-medium text-foreground">Send v{active.versionNumber} back</p>
                    <div className="grid gap-2 sm:grid-cols-[11rem_minmax(0,1fr)]">
                      <span className="space-y-1">
                        <label htmlFor="board-reject-reason" className="block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                          Reason
                        </label>
                        <select id="board-reject-reason" value={reason} onChange={(event) => setReason(event.target.value)} className={FIELD_CLASS}>
                          {REJECTION_REASONS.map((option) => (
                            <option key={option.key} value={option.key}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </span>
                      <span className="space-y-1">
                        <label htmlFor="board-reject-detail" className="block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                          What is wrong? {reason === 'other' ? '(required)' : '(optional)'}
                        </label>
                        <Input id="board-reject-detail" value={note} onChange={(event) => setNote(event.target.value)} maxLength={MAX_REJECTION_DETAIL} placeholder="e.g. the headline sits over the logo" />
                      </span>
                    </div>
                    {reject.error && (
                      <p role="alert" className="text-[12px] text-danger-ink">
                        {reject.error}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="submit" size="sm" variant="outline" className="h-8" disabled={reject.pending}>
                        {reject.pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                        Reject
                      </Button>
                      <Button type="button" size="sm" variant="ghost" className="h-8" onClick={() => setRejecting(false)} disabled={reject.pending}>
                        Cancel
                      </Button>
                      <span className="text-[11px] text-muted-foreground">Nothing is deleted, and a booking for this poster is withdrawn.</span>
                    </div>
                  </form>
                )}

                {message && (
                  <p role="status" className="text-[12px] text-warning-ink">
                    {message}
                  </p>
                )}

                {/* ---- Delivery ---- */}
                <section className="space-y-1.5">
                  <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Delivery</h3>
                  {details?.delivery ? (
                    <div className="space-y-1 text-[12px]">
                      <p className="flex flex-wrap items-center gap-2">
                        <Chip variant={DELIVERY_VARIANT[details.delivery.status] ?? 'slate'}>{details.delivery.status.toLowerCase()}</Chip>
                        <span className="text-muted-foreground">
                          {details.delivery.sentAtLabel ? `Sent ${details.delivery.sentAtLabel}` : `For ${details.delivery.scheduledForLabel}`}
                          {details.delivery.pinnedVersionNumber !== null && ` · v${details.delivery.pinnedVersionNumber}`}
                          {` · ${details.delivery.attempts} attempt${details.delivery.attempts === 1 ? '' : 's'}`}
                          {details.delivery.lastAttemptLabel && ` · last ${details.delivery.lastAttemptLabel}`}
                        </span>
                      </p>
                      {details.delivery.failureReason && (
                        <p className={cn('text-[11px]', details.delivery.status === 'FAILED' ? 'text-danger-ink' : 'text-muted-foreground')}>
                          {details.delivery.failurePermanent && details.delivery.status === 'FAILED' ? 'Will not retry automatically: ' : ''}
                          {details.delivery.failureReason}
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-[12px] text-muted-foreground">
                      {load.pending && !details ? 'Loading…' : 'Not booked. An approved poster is booked automatically while the campaign is active.'}
                    </p>
                  )}
                  {!closed && (day.actions.canSendNow || day.actions.canRetry || day.actions.canCancel) && (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {day.actions.canSendNow && (
                        <Button size="sm" variant="outline" className="h-8" disabled={busyKind !== null} onClick={() => onAction('send', day)}>
                          {busyKind === 'send' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                          Send now
                        </Button>
                      )}
                      {day.actions.canRetry && (
                        <Button size="sm" variant="outline" className="h-8" disabled={busyKind !== null} onClick={() => onAction('retry', day)}>
                          {busyKind === 'retry' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                          Retry
                        </Button>
                      )}
                      {day.actions.canCancel && (
                        <Button size="sm" variant="ghost" className="h-8 text-danger-ink" disabled={busyKind !== null} onClick={() => onAction('cancel', day)}>
                          <Ban className="h-3.5 w-3.5" />
                          Cancel delivery
                        </Button>
                      )}
                    </div>
                  )}
                </section>

                {/* ---- Versions ---- */}
                <section className="space-y-1.5">
                  <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Versions ({versions.length})</h3>
                  {load.error && (
                    <p role="alert" className="text-[12px] text-danger-ink">
                      {load.error}
                    </p>
                  )}
                  <ol className="space-y-1.5">
                    {versions.map((version) => (
                      <li key={version.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(version.id)}
                          aria-pressed={selected?.id === version.id}
                          className={cn('w-full rounded-md border px-2 py-1.5 text-left text-[11px]', selected?.id === version.id ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent/60')}
                        >
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="font-semibold text-foreground">v{version.versionNumber}</span>
                            {version.active && <Chip variant="emerald">Active</Chip>}
                            <Chip variant={APPROVAL_VARIANT[version.approvalStatus] ?? 'slate'}>{version.approvalStatus.toLowerCase()}</Chip>
                            {!version.current && <Chip variant="amber">Outdated</Chip>}
                            {version.textCheckIssues > 0 && (
                              <span className="inline-flex items-center gap-1 text-warning-ink">
                                <TextSearch className="h-3 w-3" /> Text check: {version.textCheckIssues} {version.textCheckIssues === 1 ? 'difference' : 'differences'}
                              </span>
                            )}
                          </span>
                          <span className="block text-muted-foreground">
                            {SOURCE_LABEL[version.source] ?? version.source} · {version.createdLabel}
                            {version.templateLabel ? ` · ${version.templateLabel}` : ''}
                          </span>
                          {version.rejection && (
                            <span className="mt-0.5 block text-danger-ink">
                              {version.rejection.label}
                              {version.rejection.detail ? ` — ${version.rejection.detail}` : ''}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                    {details && versions.length === 0 && <li className="text-[12px] text-muted-foreground">No versions yet.</li>}
                  </ol>
                </section>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
