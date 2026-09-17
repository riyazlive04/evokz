'use client';

import * as React from 'react';

import { useRouter } from 'next/navigation';

import { AlertTriangle, CalendarX, Loader2, Trash2, X } from 'lucide-react';

import {
  clearUnsentLegacyCalendarAction,
  deleteClient,
  type ClearLegacyCalendarOutcome,
} from '@/app/admin/dashboard/actions';
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
 * The client-level destructive action, deliberately kept at the bottom of the
 * detail page rather than beside the routine controls in the client matrix — a
 * delete sitting next to a pause toggle invites a misclick.
 */
export function ClientDangerZone({
  clientId,
  companyName,
}: {
  clientId: string;
  companyName: string;
}) {
  const router = useRouter();
  const remove = useAction(deleteClient);
  const [typedName, setTypedName] = React.useState('');

  const nameMatches = typedName.trim() === companyName;

  async function handleDelete() {
    const result = await remove.run(clientId, typedName);
    // The page this component sits on ceases to exist, so revalidation alone
    // would re-render a 404 in place.
    if (result.ok) router.push('/admin/clients');
  }

  return (
    <Card className="border-danger/25">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-danger-ink">
          <AlertTriangle className="h-4 w-4" />
          Danger zone
        </CardTitle>
        <CardDescription>Deleting the client cannot be undone.</CardDescription>
      </CardHeader>

      <CardContent className="space-y-2">
        <p className="text-xs font-medium text-foreground">Delete this client</p>
        <p className="text-[11px] text-muted-foreground">
          Removes {companyName} with every campaign and poster record. The Drive folder is moved
          to the bin, recoverable there for 30 days. Spend history is kept and reappears on the
          dashboard under “Unattributed”.
        </p>

        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="delete-confirm" className="text-[11px]">
              Type <span className="font-mono text-foreground">{companyName}</span> to confirm
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
            disabled={remove.pending || !nameMatches}
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

        {remove.error && (
          <p role="alert" className="text-[11px] text-danger-ink">
            {remove.error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Clears a client's unsent calendar days from before campaigns, which hold day
 * numbers a new campaign needs. Two clicks; delivered and generated days are
 * never touched.
 *
 * Rendered unconditionally by the page so the result survives the refresh that
 * hides the older-days note; it renders nothing while there is nothing to say.
 */
export function ClearLegacyCalendarButton({
  clientId,
  clearableDays,
}: {
  clientId: string;
  /** Older PENDING + FAILED days — what the clear removes. */
  clearableDays: number;
}) {
  const router = useRouter();
  const clear = useAction(clearUnsentLegacyCalendarAction);
  const [armed, setArmed] = React.useState(false);
  const [outcome, setOutcome] = React.useState<string | null>(null);

  // An armed confirm left on screen is a trap for whoever scrolls back to it.
  React.useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(false), 8_000);
    return () => clearTimeout(timer);
  }, [armed]);

  if (clearableDays === 0 && !outcome && !clear.error) return null;

  const days = `${clearableDays} unsent older day${clearableDays === 1 ? '' : 's'}`;

  async function handleClear() {
    const result = await clear.run(clientId);
    setArmed(false);
    if (result.ok) {
      setOutcome(describeClearOutcome(result.data));
      router.refresh();
    }
  }

  return (
    <div className="space-y-1.5">
      {clearableDays > 0 &&
        (!armed ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setOutcome(null);
              setArmed(true);
            }}
            disabled={clear.pending}
          >
            <CalendarX className="h-4 w-4" />
            Clear {days}
          </Button>
        ) : (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-danger/25 bg-danger/5 p-2">
            <span className="flex-1 text-[11px] leading-relaxed text-danger-ink">
              Delete {days}? They were never sent. Delivered and generated days are kept as
              history.
            </span>
            <Button size="sm" variant="destructive" onClick={handleClear} disabled={clear.pending}>
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
              onClick={() => setArmed(false)}
              disabled={clear.pending}
              aria-label="Cancel clearing older days"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}

      {outcome && (
        <p role="status" className="text-[11px] text-success-ink">
          {outcome}
        </p>
      )}
      {clear.error && (
        <p role="alert" className="text-[11px] text-danger-ink">
          {clear.error}
        </p>
      )}
    </div>
  );
}

function describeClearOutcome(outcome: ClearLegacyCalendarOutcome): string {
  const parts = [
    outcome.deleted === 0
      ? 'There were no unsent older days left to clear.'
      : `Cleared ${outcome.deleted} unsent older day${outcome.deleted === 1 ? '' : 's'}.`,
  ];
  if (outcome.filesNotBinned > 0) {
    parts.push(
      `${outcome.filesNotBinned} Drive file${outcome.filesNotBinned === 1 ? '' : 's'} could not be moved to the bin — remove ${outcome.filesNotBinned === 1 ? 'it' : 'them'} from the client’s folder by hand.`,
    );
  }
  if (outcome.kept > 0) {
    parts.push(
      `${outcome.kept} generated or delivered day${outcome.kept === 1 ? ' was' : 's were'} kept.`,
    );
  }
  return parts.join(' ');
}
