'use client';

import * as React from 'react';
import Link from 'next/link';

import { AlertTriangle, Check, Loader2, Pencil, RefreshCw, Sparkles, X } from 'lucide-react';

import {
  approveCampaignDayPosterAction,
  generateCampaignDayPosterAction,
  loadCampaignDayReviewAction,
  rejectCampaignDayPosterAction,
} from '@/app/admin/campaigns/actions';
import { badgeVariants } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAction } from '@/hooks/use-action';
import { MAX_REJECTION_DETAIL, REJECTION_REASONS } from '@/lib/campaign/review';
import { studioImageUrl } from '@/lib/poster-studio/limits';
import { cn } from '@/lib/utils';

type Detail = Extract<Awaited<ReturnType<typeof loadCampaignDayReviewAction>>, { ok: true }>['data'];
type Variant = 'default' | 'secondary' | 'outline' | 'slate' | 'amber' | 'emerald' | 'destructive';

function Tag({ variant, children }: { variant: Variant; children: React.ReactNode }) {
  return <span className={badgeVariants({ variant })}>{children}</span>;
}

const APPROVAL_VARIANT: Record<string, Variant> = { APPROVED: 'emerald', REJECTED: 'destructive', PENDING: 'amber' };

const FIELD_CLASS =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * One campaign day, reviewed in one place: its content, its mapped template, the
 * poster and every version, and the actions that are valid right now.
 *
 * Every action here is Phase 1–4's: approval moves on the active `PosterVersion`,
 * regeneration is Phase 4's rolling generation with its confirmation, and Edit
 * opens Poster Studio. Older versions are shown but never approved — approval
 * belongs to the version that represents the day.
 */
export function CampaignDayDetail({
  dayId,
  onClose,
  onChanged,
}: {
  dayId: string | null;
  onClose: () => void;
  /** A review action changed something; the page should refresh. */
  onChanged: () => void;
}) {
  const load = useAction(loadCampaignDayReviewAction);
  const approve = useAction(approveCampaignDayPosterAction);
  const reject = useAction(rejectCampaignDayPosterAction);
  const generate = useAction(generateCampaignDayPosterAction);

  const [detail, setDetail] = React.useState<Detail | null>(null);
  const [selectedVersionId, setSelectedVersionId] = React.useState<string | null>(null);
  const [rejecting, setRejecting] = React.useState(false);
  const [reason, setReason] = React.useState<string>(REJECTION_REASONS[0].key);
  const [note, setNote] = React.useState('');
  const [confirmRegenerate, setConfirmRegenerate] = React.useState(false);
  const [message, setMessage] = React.useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const { run: runLoad } = load;

  const refresh = React.useCallback(
    async (id: string) => {
      const result = await runLoad(id);
      if (result.ok) {
        setDetail(result.data);
        setSelectedVersionId((current) => current ?? result.data.poster.activeVersionId ?? result.data.versions[0]?.id ?? null);
      }
    },
    [runLoad],
  );

  React.useEffect(() => {
    setDetail(null);
    setSelectedVersionId(null);
    setRejecting(false);
    setConfirmRegenerate(false);
    setMessage(null);
    setNote('');
    if (dayId) void refresh(dayId);
  }, [dayId, refresh]);

  const version = detail?.versions.find((candidate) => candidate.id === selectedVersionId) ?? null;
  const activeVersion = detail?.versions.find((candidate) => candidate.active) ?? null;
  const busy = load.pending || approve.pending || reject.pending || generate.pending;
  const error = approve.error ?? reject.error ?? generate.error ?? load.error;

  async function afterWrite(id: string, text: string, tone: 'success' | 'warning' = 'success') {
    setMessage({ tone, text });
    setSelectedVersionId(null);
    await refresh(id);
    onChanged();
  }

  return (
    <Dialog open={dayId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        {load.pending && !detail && (
          <p className="flex items-center gap-2 py-6 text-[12px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading the day…
          </p>
        )}

        {detail && (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                Day {detail.dayNumber}
                <span className="font-mono text-[11px] font-normal text-muted-foreground">
                  {new Date(detail.scheduledDate).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                </span>
                <Tag variant={detail.poster.state === 'approved' ? 'emerald' : detail.poster.state === 'rejected' || detail.poster.state === 'failed' ? 'destructive' : detail.poster.state === 'needs-approval' || detail.poster.state === 'outdated' ? 'amber' : 'slate'}>
                  {detail.poster.stateLabel}
                </Tag>
              </DialogTitle>
              <DialogDescription>
                {detail.approvalPolicy === 'AUTO_APPROVE'
                  ? 'This campaign approves generated posters automatically.'
                  : 'Posters need approval before they could ever be delivered.'}{' '}
                Nothing is sent from here.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 sm:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
              {/* ---- Poster ---- */}
              <div className="space-y-2">
                <div className="flex h-[min(50vh,26rem)] items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
                  {version?.generationId ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={version.id}
                      src={studioImageUrl(version.generationId, { width: 640 })}
                      alt={`Day ${detail.dayNumber} poster v${version.versionNumber}`}
                      className="h-full w-auto max-w-full object-contain"
                    />
                  ) : (
                    <p className="px-4 text-center text-[12px] text-muted-foreground">
                      {detail.versions.length === 0 ? 'No poster generated yet.' : 'No preview for this version.'}
                    </p>
                  )}
                </div>
                {version?.generationId && (
                  <p className="flex flex-wrap gap-3 text-[11px]">
                    <a className="underline underline-offset-2" href={studioImageUrl(version.generationId, { width: 2048 })} target="_blank" rel="noreferrer">
                      Final poster
                    </a>
                    <a className="underline underline-offset-2" href={studioImageUrl(version.generationId, { variant: 'raw', width: 2048 })} target="_blank" rel="noreferrer">
                      Raw artwork
                    </a>
                  </p>
                )}
              </div>

              {/* ---- Content, template, versions ---- */}
              <div className="min-w-0 space-y-3">
                <section className="space-y-1">
                  <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Content</h3>
                  <p className="flex flex-wrap items-center gap-2 text-[12px]">
                    {detail.content.contentTypeLabel && <Tag variant="outline">{detail.content.contentTypeLabel}</Tag>}
                    <span className="text-muted-foreground">{detail.content.theme ?? 'No topic'}</span>
                  </p>
                  <p className="text-sm font-medium text-foreground">{detail.content.headline ?? 'No headline yet.'}</p>
                  {detail.content.supportingText && <p className="text-[12px] text-muted-foreground">{detail.content.supportingText}</p>}
                  {detail.content.cta && <p className="text-[12px] text-muted-foreground">CTA: {detail.content.cta}</p>}
                </section>

                <section className="space-y-1">
                  <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Template</h3>
                  <p className="flex flex-wrap items-center gap-2 text-[12px] text-foreground">
                    {detail.template.label ?? 'Not mapped'}
                    {detail.template.source && <Tag variant={detail.template.source === 'MANUAL' ? 'default' : 'secondary'}>{detail.template.source === 'MANUAL' ? 'Manual' : 'Auto'}</Tag>}
                  </p>
                  {detail.template.issue && (
                    <p className="flex items-start gap-1.5 text-[11px] text-warning-ink">
                      <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                      {detail.template.issue}
                    </p>
                  )}
                </section>

                {detail.poster.warning && (
                  <p className="flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-[11px] text-warning-ink">
                    <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                    {detail.poster.warning}
                  </p>
                )}

                <section className="space-y-1.5">
                  <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Versions ({detail.versions.length})
                  </h3>
                  <ol className="space-y-1.5">
                    {detail.versions.map((row) => (
                      <li key={row.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedVersionId(row.id)}
                          aria-pressed={row.id === selectedVersionId}
                          className={cn('w-full rounded-md border px-2 py-1.5 text-left text-[11px]', row.id === selectedVersionId ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent/60')}
                        >
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="font-semibold text-foreground">v{row.versionNumber}</span>
                            {row.active && <Tag variant="emerald">Active</Tag>}
                            <Tag variant={APPROVAL_VARIANT[row.approvalStatus] ?? 'slate'}>{row.approvalStatus.toLowerCase()}</Tag>
                            {!row.current && <Tag variant="amber">Outdated</Tag>}
                          </span>
                          <span className="block text-muted-foreground">
                            {row.source === 'POSTER_STUDIO' ? 'Edited in Poster Studio' : row.source === 'PIPELINE' ? 'Generated' : 'Uploaded'} ·{' '}
                            {new Date(row.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                            {row.templateLabel ? ` · ${row.templateLabel}` : ''}
                          </span>
                          {row.rejection && (
                            <span className="mt-0.5 block text-danger-ink">
                              {row.rejection.label}
                              {row.rejection.detail ? ` — ${row.rejection.detail}` : ''}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                    {detail.versions.length === 0 && <li className="text-[12px] text-muted-foreground">No versions yet.</li>}
                  </ol>
                  {version && !version.active && (
                    <p className="text-[11px] text-muted-foreground">
                      You are looking at an older version. Only v{activeVersion?.versionNumber ?? '—'}, the active one, can be approved or rejected.
                    </p>
                  )}
                </section>
              </div>
            </div>

            {message && (
              <p role="status" className={cn('text-[12px]', message.tone === 'success' ? 'text-success-ink' : 'text-warning-ink')}>
                {message.text}
              </p>
            )}
            {error && (
              <p role="alert" className="text-[12px] text-danger-ink">
                {error}
              </p>
            )}

            {/* ---- Actions: only what is valid now ---- */}
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
              {detail.actions.canApprove && activeVersion && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={async () => {
                    const result = await approve.run(detail.dayId, activeVersion.id);
                    if (result.ok) await afterWrite(detail.dayId, `Day ${detail.dayNumber} approved.`);
                  }}
                >
                  {approve.pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Approve
                </Button>
              )}

              {detail.actions.canReject && activeVersion && !rejecting && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(true)}>
                  <X className="h-4 w-4" />
                  Reject
                </Button>
              )}

              {(detail.actions.canRegenerate || detail.actions.canGenerate) && (
                confirmRegenerate ? (
                  <span className="flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-[11px] text-warning-ink">
                    This will create a new poster version and use an AI generation.
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={async () => {
                        setConfirmRegenerate(false);
                        const result = await generate.run(detail.campaignId, detail.dayId, { mode: detail.actions.canRegenerate ? 'regenerate' : 'missing', explicit: true });
                        if (!result.ok) return;
                        const outcome = result.data;
                        await afterWrite(
                          detail.dayId,
                          outcome.outcome === 'generated' ? `${outcome.message} It needs approval again.` : outcome.message,
                          outcome.outcome === 'generated' ? 'success' : 'warning',
                        );
                      }}
                    >
                      Generate 1 new version
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => setConfirmRegenerate(false)} aria-label="Cancel regenerate">
                      <X className="h-4 w-4" />
                    </Button>
                  </span>
                ) : (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmRegenerate(true)}>
                    {generate.pending ? <Loader2 className="h-4 w-4 animate-spin" /> : detail.actions.canRegenerate ? <RefreshCw className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
                    {detail.actions.canRegenerate ? 'Regenerate' : 'Generate'}
                  </Button>
                )
              )}

              {activeVersion?.generationId && (
                <Button asChild size="sm" variant="ghost">
                  <Link href={`/admin/poster-studio?campaignDay=${detail.dayId}`}>
                    <Pencil className="h-4 w-4" />
                    Edit in Poster Studio
                  </Link>
                </Button>
              )}
            </div>

            {/* ---- Reject with a reason ---- */}
            {rejecting && activeVersion && (
              <form
                className="space-y-2 rounded-md border border-border p-3"
                onSubmit={async (event) => {
                  event.preventDefault();
                  const result = await reject.run(detail.dayId, activeVersion.id, { reason, detail: note });
                  if (result.ok) {
                    setRejecting(false);
                    setNote('');
                    await afterWrite(detail.dayId, `Day ${detail.dayNumber} sent back: ${result.data.note}. The poster is kept — edit or regenerate it.`, 'warning');
                  }
                }}
              >
                <p className="text-[12px] font-medium text-foreground">Send this poster back</p>
                <div className="grid gap-2 sm:grid-cols-[12rem_minmax(0,1fr)]">
                  <span className="space-y-1">
                    <label htmlFor="reject-reason" className="block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                      Reason
                    </label>
                    <select id="reject-reason" value={reason} onChange={(event) => setReason(event.target.value)} className={`${FIELD_CLASS} h-9 py-1`}>
                      {REJECTION_REASONS.map((option) => (
                        <option key={option.key} value={option.key}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </span>
                  <span className="space-y-1">
                    <label htmlFor="reject-detail" className="block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                      What is wrong? {reason === 'other' ? '(required)' : '(optional)'}
                    </label>
                    <Input id="reject-detail" value={note} onChange={(event) => setNote(event.target.value)} maxLength={MAX_REJECTION_DETAIL} placeholder="e.g. the headline sits over the logo" />
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" size="sm" variant="outline" disabled={busy}>
                    {reject.pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                    Reject v{activeVersion.versionNumber}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setRejecting(false)} disabled={busy}>
                    Cancel
                  </Button>
                  <span className="text-[11px] text-muted-foreground">Nothing is deleted. The poster stays until a new version is made.</span>
                </div>
              </form>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
