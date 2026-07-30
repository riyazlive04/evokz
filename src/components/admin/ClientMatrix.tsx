'use client';

import * as React from 'react';

import Link from 'next/link';

import {
  Check,
  CloudOff,
  FolderCheck,
  Loader2,
  Pause,
  Play,
  Search,
  Undo2,
  X,
} from 'lucide-react';

import {
  repairDriveFolder,
  setClientActive,
  updateClientCronTime,
} from '@/app/admin/dashboard/actions';
import { SeedCalendarButton } from '@/components/admin/SeedCalendarButton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAction } from '@/hooks/use-action';

export interface ClientRow {
  id: string;
  companyName: string;
  whatsappNumber: string;
  planName: string;
  categoryName: string;
  cronTime: string;
  startDateLabel: string;
  endDateLabel: string;
  isActive: boolean;
  hasDriveFolder: boolean;
  deliveredCount: number;
  /** ContentCalendar rows that exist for this client, any status. */
  calendarCount: number;
  totalDays: number;
}

/**
 * Matches a client against the search box.
 *
 * Filtering happens in the browser: the page already ships every tenant to
 * render the table, so a round trip per keystroke would buy nothing. Numeric
 * queries are compared digit-only, so "+91 98765" and "9198765" both hit.
 */
function matchesQuery(client: ClientRow, needle: string, digits: string): boolean {
  return (
    client.companyName.toLowerCase().includes(needle) ||
    client.planName.toLowerCase().includes(needle) ||
    client.categoryName.toLowerCase().includes(needle) ||
    (digits.length > 0 && client.whatsappNumber.includes(digits))
  );
}

export function ClientMatrix({
  clients,
  timeZone,
}: {
  clients: ClientRow[];
  timeZone: string;
}) {
  const [query, setQuery] = React.useState('');
  const searchRef = React.useRef<HTMLInputElement>(null);

  const trimmed = query.trim();
  const visible = React.useMemo(() => {
    if (trimmed === '') return clients;
    const needle = trimmed.toLowerCase();
    const digits = trimmed.replace(/\D/g, '');
    return clients.filter((client) => matchesQuery(client, needle, digits));
  }, [clients, trimmed]);

  function handleClear() {
    setQuery('');
    searchRef.current?.focus();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full sm:max-w-sm">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query !== '') {
                event.preventDefault();
                handleClear();
              }
            }}
            placeholder="Search company, WhatsApp, plan, or vertical"
            aria-label="Search clients"
            className="pl-9 pr-9"
          />
          {query !== '' && (
            <button
              type="button"
              onClick={handleClear}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground transition-colors duration-200 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground" aria-live="polite">
          {trimmed === ''
            ? `${clients.length} client${clients.length === 1 ? '' : 's'}`
            : `${visible.length} of ${clients.length} matching`}
          <span className="mx-1.5 text-muted-foreground/50">·</span>
          times in <span className="font-mono text-foreground">{timeZone}</span>
        </p>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Company</TableHead>
            <TableHead>WhatsApp</TableHead>
            <TableHead>Plan / Vertical</TableHead>
            <TableHead>Active window</TableHead>
            <TableHead className="w-52">Delivery time</TableHead>
            <TableHead className="w-32">Progress</TableHead>
            <TableHead className="w-28 text-right">State</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="py-8 text-center text-xs text-muted-foreground">
                {clients.length === 0 ? (
                  <>
                    No clients onboarded yet. Use “Manual onboarding” to create one without a
                    payment.
                  </>
                ) : (
                  <>
                    No client matches “<span className="text-foreground">{trimmed}</span>”.{' '}
                    <button
                      type="button"
                      onClick={handleClear}
                      className="underline underline-offset-2 transition-colors duration-200 hover:text-foreground"
                    >
                      Clear search
                    </button>
                  </>
                )}
              </TableCell>
            </TableRow>
          ) : (
            visible.map((client) => <ClientRowItem key={client.id} client={client} />)
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function ClientRowItem({ client }: { client: ClientRow }) {
  const cronAction = useAction(updateClientCronTime);
  const activeAction = useAction(setClientActive);
  const driveAction = useAction(repairDriveFolder);

  const [cronTime, setCronTime] = React.useState(client.cronTime);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);

  React.useEffect(() => {
    setCronTime(client.cronTime);
  }, [client.cronTime]);

  const dirty = cronTime !== client.cronTime;

  async function handleSaveCron() {
    const result = await cronAction.run(client.id, cronTime);
    if (result.ok) setSavedAt(Date.now());
  }

  // Clear the "saved" flash without leaving a timer behind on unmount.
  React.useEffect(() => {
    if (savedAt === null) return undefined;
    const timer = setTimeout(() => setSavedAt(null), 2_000);
    return () => clearTimeout(timer);
  }, [savedAt]);

  const progressPercent =
    client.totalDays > 0
      ? Math.min(100, Math.round((client.deliveredCount / client.totalDays) * 100))
      : 0;

  return (
    <>
      <TableRow className={client.isActive ? '' : 'opacity-60'}>
        <TableCell>
          <div className="flex items-center gap-2">
            <Link
              href={`/admin/clients/${client.id}`}
              className="font-medium text-foreground underline-offset-4 transition-colors duration-200 hover:text-primary hover:underline"
              title="Open client detail"
            >
              {client.companyName}
            </Link>
            {client.hasDriveFolder ? (
              <FolderCheck
                className="h-3.5 w-3.5 shrink-0 text-emerald-600/70"
                aria-label="Drive folder provisioned"
              />
            ) : (
              <CloudOff
                className="h-3.5 w-3.5 shrink-0 text-red-600"
                aria-label="Drive folder missing"
              />
            )}
          </div>
        </TableCell>

        <TableCell className="font-mono text-xs text-muted-foreground">
          +{client.whatsappNumber}
        </TableCell>

        <TableCell>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-foreground">{client.planName}</span>
            <span className="text-[11px] text-muted-foreground">{client.categoryName}</span>
          </div>
        </TableCell>

        <TableCell className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
          {client.startDateLabel}
          <span className="mx-1 text-muted-foreground/60">→</span>
          {client.endDateLabel}
        </TableCell>

        {/* Inline cronTime editor — commits on Enter or via the check button. */}
        <TableCell>
          <div className="flex items-center gap-1.5">
            <Input
              type="time"
              value={cronTime}
              step={60}
              onChange={(event) => setCronTime(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && dirty) {
                  event.preventDefault();
                  void handleSaveCron();
                }
                if (event.key === 'Escape') setCronTime(client.cronTime);
              }}
              className="w-28 font-mono"
              aria-label={`Delivery time for ${client.companyName}`}
            />

            {dirty && (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={handleSaveCron}
                  disabled={cronAction.pending}
                  aria-label="Save delivery time"
                >
                  {cronAction.pending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="h-4 w-4 text-emerald-600" />
                  )}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setCronTime(client.cronTime)}
                  aria-label="Revert delivery time"
                >
                  <Undo2 className="h-4 w-4" />
                </Button>
              </>
            )}

            {savedAt !== null && !dirty && (
              <span className="text-[11px] text-emerald-600 transition-opacity duration-300">
                Saved
              </span>
            )}
          </div>
        </TableCell>

        <TableCell>
          <div className="space-y-1">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-gradient-brand transition-all duration-500"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <span className="font-mono text-[10px] text-muted-foreground">
              {client.deliveredCount}/{client.totalDays} sent
            </span>
          </div>
        </TableCell>

        <TableCell>
          <div className="flex items-center justify-end gap-1">
            <Badge variant={client.isActive ? 'emerald' : 'slate'}>
              {client.isActive ? 'Live' : 'Paused'}
            </Badge>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => void activeAction.run(client.id, !client.isActive)}
              disabled={activeAction.pending}
              aria-label={client.isActive ? 'Pause client' : 'Resume client'}
            >
              {activeAction.pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : client.isActive ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </Button>
          </div>
        </TableCell>
      </TableRow>

      {(!client.hasDriveFolder ||
        client.calendarCount < client.totalDays ||
        cronAction.error ||
        activeAction.error ||
        driveAction.error) && (
        <TableRow>
          <TableCell colSpan={7} className="pt-0">
            <div className="flex flex-wrap items-center gap-3">
              <SeedCalendarButton
                clientId={client.id}
                companyName={client.companyName}
                calendarCount={client.calendarCount}
                totalDays={client.totalDays}
              />
              {!client.hasDriveFolder && (
                <>
                  <span className="text-[11px] text-red-600">
                    No Drive folder — the pipeline cannot deliver for this client.
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void driveAction.run(client.id)}
                    disabled={driveAction.pending}
                  >
                    {driveAction.pending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <FolderCheck className="h-4 w-4" />
                    )}
                    Provision folder
                  </Button>
                </>
              )}
              {[cronAction.error, activeAction.error, driveAction.error]
                .filter((message): message is string => Boolean(message))
                .map((message) => (
                  <span key={message} role="alert" className="text-[11px] text-red-600">
                    {message}
                  </span>
                ))}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
