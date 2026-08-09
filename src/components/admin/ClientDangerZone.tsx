'use client';

import * as React from 'react';

import { useRouter } from 'next/navigation';

import { AlertTriangle, CalendarX, Check, Loader2, Trash2, X } from 'lucide-react';

import { clearClientCalendar, deleteClient } from '@/app/admin/dashboard/actions';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAction } from '@/hooks/use-action';

/**
 * The two destructive client-level actions, deliberately kept together at the
 * bottom of the detail page rather than beside the routine controls in the
 * client matrix — a delete sitting next to a pause toggle invites a misclick.
 *
 * They are also complementary: a plan can only be shortened once the surplus
 * calendar days are gone, so "clear" is what unblocks a plan change.
 */
export function ClientDangerZone({
  clientId,
  companyName,
  clearableDays,
  lockedDays,
  returnTo = '/admin/clients',
  kind = 'client',
}: {
  clientId: string;
  companyName: string;
  /** PENDING + FAILED rows — what a clear would actually remove. */
  clearableDays: number;
  /** GENERATED + DELIVERED rows, which a clear never touches. */
  lockedDays: number;
  /**
   * Where to land after a successful delete. The page this component sits on
   * ceases to exist, so revalidation alone would re-render a 404 in place.
   */
  returnTo?: string;
  /** Wording only — demo tenants and paying clients delete identically. */
  kind?: 'client' | 'demo tenant';
}) {
  const router = useRouter();
  const clear = useAction(clearClientCalendar);
  const remove = useAction(deleteClient);

  const [confirmingClear, setConfirmingClear] = React.useState(false);
  const [typedName, setTypedName] = React.useState('');
  const [flash, setFlash] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (flash === null) return undefined;
    const timer = setTimeout(() => setFlash(null), 6_000);
    return () => clearTimeout(timer);
  }, [flash]);

  // Same auto-disarm as QueueCardActions — an armed confirm left on screen is
  // a trap for whoever scrolls back to it.
  React.useEffect(() => {
    if (!confirmingClear) return undefined;
    const timer = setTimeout(() => setConfirmingClear(false), 8_000);
    return () => clearTimeout(timer);
  }, [confirmingClear]);

  const busy = clear.pending || remove.pending;
  const nameMatches = typedName.trim() === companyName;

  async function handleClear() {
    const result = await clear.run(clientId);
    setConfirmingClear(false);
    if (result.ok) {
      setFlash(
        result.data.kept > 0
          ? `Cleared ${result.data.deleted} day(s). ${result.data.kept} generated/delivered day(s) left untouched.`
          : `Cleared ${result.data.deleted} day(s).`,
      );
    }
  }

  async function handleDelete() {
    const result = await remove.run(clientId, typedName);
    if (result.ok) router.push(returnTo);
  }

  return (
    <Card className="border-danger/25">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-danger-ink">
          <AlertTriangle className="h-4 w-4" />
          Danger zone
        </CardTitle>
        <CardDescription>
          Clearing the calendar is how you recover from a bad seed. Deleting the client
          cannot be undone.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* ---- Clear calendar ---- */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-foreground">Clear unsent calendar days</p>
          <p className="text-[11px] text-muted-foreground">
            Removes the {clearableDays} pending and failed day(s) so the calendar can be
            rewritten — after extracting brand tokens, for example.
            {lockedDays > 0 && (
              <>
                {' '}
                The {lockedDays} generated or delivered day(s) are never removed, because
                they record what {companyName} actually received.
              </>
            )}
          </p>

          {!confirmingClear ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirmingClear(true)}
              disabled={busy || clearableDays === 0}
              title={
                clearableDays === 0
                  ? 'No pending or failed days to clear'
                  : 'Delete every pending and failed calendar day'
              }
            >
              <CalendarX className="h-4 w-4" />
              Clear {clearableDays} unsent day{clearableDays === 1 ? '' : 's'}
            </Button>
          ) : (
            <div className="flex items-center gap-2 rounded-md border border-danger/25 bg-danger/5 p-2">
              <span className="flex-1 text-[11px] leading-relaxed text-danger-ink">
                Delete {clearableDays} unsent day{clearableDays === 1 ? '' : 's'} for{' '}
                {companyName}? The copy is gone; regenerating costs another run.
              </span>
              <Button
                size="sm"
                variant="destructive"
                onClick={handleClear}
                disabled={busy}
              >
                {clear.pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CalendarX className="h-4 w-4" />
                )}
                Clear
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setConfirmingClear(false)}
                disabled={clear.pending}
                aria-label="Cancel clear"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>

        {/* ---- Delete client ---- */}
        <div className="space-y-2 border-t border-border pt-5">
          <p className="text-xs font-medium text-foreground">Delete this {kind}</p>
          <p className="text-[11px] text-muted-foreground">
            Removes {companyName} and every calendar day. The Drive folder is moved to the
            bin, recoverable there for 30 days. Spend history is kept and reappears on the
            dashboard under “Unattributed”.
          </p>

          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="delete-confirm" className="text-[11px]">
                Type <span className="font-mono text-foreground">{companyName}</span> to
                confirm
              </Label>
              <Input
                id="delete-confirm"
                value={typedName}
                onChange={(event) => setTypedName(event.target.value)}
                placeholder={companyName}
                autoComplete="off"
                className="w-64"
              />
            </div>
            <Button
              size="sm"
              variant="destructive"
              onClick={handleDelete}
              disabled={busy || !nameMatches}
              title={nameMatches ? 'Delete permanently' : 'Company name does not match'}
            >
              {remove.pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              Delete permanently
            </Button>
          </div>
        </div>

        {flash && (
          <p className="flex items-center gap-1.5 text-[11px] text-success-ink">
            <Check className="h-3.5 w-3.5" />
            {flash}
          </p>
        )}

        {(clear.error ?? remove.error) && (
          <p role="alert" className="text-[11px] text-danger-ink">
            {clear.error ?? remove.error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
