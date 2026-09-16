'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { AlertTriangle, CheckCheck, ImageOff, Loader2, Send, X } from 'lucide-react';

import {
  cancelCampaignDeliveryAction,
  retryCampaignDeliveryAction,
  scheduleCampaignDeliveriesAction,
  sendCampaignDayNowAction,
} from '@/app/admin/campaigns/actions';
import { badgeVariants } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAction } from '@/hooks/use-action';
import { matchesDeliveryFilter, type DeliveryFilter } from '@/lib/campaign/delivery';
import { studioImageUrl } from '@/lib/poster-studio/limits';
import { cn } from '@/lib/utils';

type Variant = 'default' | 'secondary' | 'outline' | 'slate' | 'amber' | 'emerald' | 'destructive';

export interface DeliveryDayViewModel {
  dayId: string;
  dayNumber: number;
  dateLabel: string;
  headline: string | null;
  generationId: string | null;
  versionNumber: number | null;
  approvalStatus: string | null;
  status: string | null;
  statusLabel: string;
  scheduledForLabel: string | null;
  attempts: number;
  lastAttemptLabel: string | null;
  sentAtLabel: string | null;
  providerMessageId: string | null;
  failureReason: string | null;
  failurePermanent: boolean;
  refusal: string | null;
  canSendNow: boolean;
  canRetry: boolean;
  canCancel: boolean;
}

export interface DeliverySummaryView {
  total: number;
  scheduled: number;
  sending: number;
  sent: number;
  failed: number;
  cancelled: number;
  skipped: number;
  notScheduled: number;
  dueNow: number;
}

const STATUS_VARIANT: Record<string, Variant> = {
  SCHEDULED: 'secondary',
  SENDING: 'amber',
  SENT: 'emerald',
  FAILED: 'destructive',
  CANCELLED: 'slate',
  SKIPPED: 'slate',
};

function Tag({ variant, children }: { variant: Variant; children: React.ReactNode }) {
  return <span className={badgeVariants({ variant })}>{children}</span>;
}

/**
 * The campaign's delivery queue (Phase 6): what is booked, what went out, and
 * what failed.
 *
 * Nothing here decides whether a day may be sent. Every button calls a server
 * action that re-runs the full eligibility gate — approval, current version,
 * campaign status, recipient, duplicate protection — after claiming the row.
 * The refusals shown are the server's own reasons, read back.
 */
export function CampaignDeliveryQueue({
  campaignId,
  days,
  summary,
  recipient,
  whatsappConfigured,
  mediaConfigured,
  deliveryTime,
  campaignActive,
  initialFilter = 'all',
}: {
  campaignId: string;
  days: DeliveryDayViewModel[];
  summary: DeliverySummaryView;
  recipient: { number: string | null; valid: boolean };
  whatsappConfigured: boolean;
  mediaConfigured: boolean;
  deliveryTime: string;
  campaignActive: boolean;
  initialFilter?: DeliveryFilter;
}) {
  const router = useRouter();
  const [filter, setFilter] = React.useState<DeliveryFilter>(initialFilter);
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const schedule = useAction(scheduleCampaignDeliveriesAction);
  const sendNow = useAction(sendCampaignDayNowAction);
  const retry = useAction(retryCampaignDeliveryAction);
  const cancel = useAction(cancelCampaignDeliveryAction);

  const visible = days.filter((day) => matchesDeliveryFilter({ status: day.status as never }, filter));
  const blocked = !whatsappConfigured || !mediaConfigured || !recipient.valid;

  const counts: Array<{ key: DeliveryFilter; label: string; value: number }> = [
    { key: 'all', label: 'All', value: summary.total },
    { key: 'scheduled', label: 'Scheduled', value: summary.scheduled + summary.sending },
    { key: 'sent', label: 'Sent', value: summary.sent },
    { key: 'failed', label: 'Failed', value: summary.failed },
    { key: 'skipped', label: 'Skipped', value: summary.skipped + summary.cancelled },
    { key: 'not-scheduled', label: 'Not scheduled', value: summary.notScheduled },
  ];

  async function runSendNow(dayId: string) {
    const result = await sendNow.run(campaignId, dayId);
    if (result.ok) {
      setNotice(
        result.data.ok
          ? `Day ${result.data.dayNumber} sent.`
          : `Day ${result.data.dayNumber} was not sent — ${result.data.message}`,
      );
      router.refresh();
    }
    setConfirming(null);
  }

  return (
    <section aria-label="Campaign delivery" className="space-y-4">
      {/* ---- Destination, stated plainly ------------------------------------ */}
      <div className="rounded-lg border border-border bg-muted/40 p-3 text-[12px]">
        <p className="font-semibold uppercase tracking-widest text-muted-foreground">Destination</p>
        <p className="mt-1 text-foreground">
          Approved posters go to the client&apos;s own WhatsApp number
          {recipient.number ? <span className="font-mono"> +{recipient.number}</span> : null}, at {deliveryTime} on each
          day&apos;s date. This product has no customer list — delivery is to the business, for them to post.
        </p>
        {blocked && (
          <p role="alert" className="mt-2 flex items-start gap-1.5 text-danger-ink">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {!recipient.valid
                ? 'This client has no valid WhatsApp number, so nothing can be delivered.'
                : !whatsappConfigured
                  ? 'Evolution is not configured on this deployment (EVOLUTION_API_URL / EVOLUTION_API_KEY), so nothing can be delivered.'
                  : 'PUBLIC_BASE_URL is not set, so WhatsApp would have no address to fetch the poster from.'}
            </span>
          </p>
        )}
        {!campaignActive && (
          <p className="mt-2 text-warning-ink">
            The campaign is not active. Booked days stay booked and nothing is sent until it is resumed.
          </p>
        )}
      </div>

      {/* ---- Counts --------------------------------------------------------- */}
      <div className="flex flex-wrap gap-2">
        {counts.map((count) => (
          <button
            key={count.key}
            type="button"
            onClick={() => setFilter(count.key)}
            aria-pressed={filter === count.key}
            aria-label={`${count.label} (${count.value})`}
            className={cn(
              'rounded-md border px-2.5 py-1 text-[11px] transition-colors',
              filter === count.key ? 'border-primary bg-primary/10 text-foreground' : 'border-border hover:bg-accent/60',
            )}
          >
            <span className="font-semibold">{count.value}</span> {count.label}
          </button>
        ))}
        {summary.dueNow > 0 && (
          <span className="self-center text-[11px] text-warning-ink">
            {summary.dueNow} due now — the next sweep will send {summary.dueNow === 1 ? 'it' : 'them'}.
          </span>
        )}
      </div>

      {/* ---- Booking -------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={schedule.pending}
          onClick={async () => {
            const result = await schedule.run(campaignId);
            if (result.ok) {
              const booked = result.data.scheduled.length;
              setNotice(
                booked > 0
                  ? `Booked ${booked} day${booked === 1 ? '' : 's'} for delivery.`
                  : 'Nothing new to book — every approved day is already scheduled.',
              );
              router.refresh();
            }
          }}
        >
          {schedule.pending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          Schedule approved days
        </Button>
        <span className="text-[11px] text-muted-foreground">
          Booking never sends. Delivery happens at each day&apos;s own time.
        </span>
      </div>

      {(schedule.error || sendNow.error || retry.error || cancel.error) && (
        <p role="alert" className="text-[12px] text-danger-ink">
          {schedule.error ?? sendNow.error ?? retry.error ?? cancel.error}
        </p>
      )}
      {notice && <p className="text-[12px] text-muted-foreground">{notice}</p>}

      {/* ---- Rows ----------------------------------------------------------- */}
      {visible.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted-foreground">
          Nothing here.
        </p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {visible.map((day) => (
            <li key={day.dayId} data-delivery-day={day.dayNumber} className="space-y-1.5 px-3 py-2.5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2.5">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-muted">
                    {day.generationId ? (
                      /* eslint-disable-next-line @next/next/no-img-element -- session-gated Drive proxy; next/image cannot forward the admin cookie */
                      <img
                        src={studioImageUrl(day.generationId, { width: 96 })}
                        alt=""
                        /*
                         * Lazy, and load-bearing: every thumbnail is a Drive
                         * download plus a re-encode on the server. Eager loading
                         * a 365-day campaign would ask for 365 of them at once.
                         */
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <ImageOff className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 text-[13px]">
                      <span className="font-semibold text-foreground">Day {day.dayNumber}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">{day.dateLabel}</span>
                      <Tag variant={day.status ? (STATUS_VARIANT[day.status] ?? 'slate') : 'outline'}>
                        {day.statusLabel}
                      </Tag>
                      {day.versionNumber !== null && (
                        <span className="text-[11px] text-muted-foreground">v{day.versionNumber}</span>
                      )}
                    </p>
                    {day.headline && <p className="truncate text-[12px] text-muted-foreground">{day.headline}</p>}
                    <p className="text-[11px] text-muted-foreground">
                      {day.sentAtLabel
                        ? `Sent ${day.sentAtLabel}`
                        : day.scheduledForLabel
                          ? `Scheduled ${day.scheduledForLabel}`
                          : 'Not scheduled'}
                      {day.attempts > 0 && ` · ${day.attempts} attempt${day.attempts === 1 ? '' : 's'}`}
                      {day.providerMessageId && (
                        <>
                          {' · '}
                          <span className="font-mono">{day.providerMessageId.slice(0, 18)}</span>
                        </>
                      )}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  {day.canCancel && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={cancel.pending}
                      onClick={async () => {
                        const result = await cancel.run(campaignId, day.dayId);
                        if (result.ok) router.refresh();
                      }}
                    >
                      <X className="mr-1 h-3.5 w-3.5" />
                      Cancel
                    </Button>
                  )}
                  {day.canRetry && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={retry.pending}
                      onClick={async () => {
                        const result = await retry.run(campaignId, day.dayId);
                        if (result.ok) router.refresh();
                      }}
                    >
                      Reschedule
                    </Button>
                  )}
                  {day.status !== 'SENT' && day.canSendNow && (
                    <Button
                      size="sm"
                      variant={confirming === day.dayId ? 'default' : 'outline'}
                      disabled={sendNow.pending || blocked}
                      onClick={() => (confirming === day.dayId ? runSendNow(day.dayId) : setConfirming(day.dayId))}
                    >
                      {sendNow.pending && confirming === day.dayId ? (
                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Send className="mr-1 h-3.5 w-3.5" />
                      )}
                      {confirming === day.dayId ? 'Confirm — send to the client' : 'Send now'}
                    </Button>
                  )}
                  {day.status === 'SENT' && (
                    <span className="flex items-center gap-1 text-[11px] text-success-ink">
                      <CheckCheck className="h-3.5 w-3.5" /> Delivered once
                    </span>
                  )}
                </div>
              </div>

              {day.failureReason && (
                <p className={cn('text-[11px]', day.failurePermanent ? 'text-danger-ink' : 'text-warning-ink')}>
                  {day.failureReason}
                  {day.failurePermanent && ' (will not be retried automatically)'}
                </p>
              )}
              {!day.canSendNow && day.refusal && day.status !== 'SENT' && (
                <p className="text-[11px] text-muted-foreground">{day.refusal}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
