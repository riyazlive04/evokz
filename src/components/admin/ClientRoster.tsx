import Link from 'next/link';

import { CloudOff, FolderCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export interface ClientRosterRow {
  id: string;
  companyName: string;
  whatsappNumber: string;
  planName: string;
  categoryName: string;
  cronTime: string;
  windowLabel: string;
  isActive: boolean;
  hasDriveFolder: boolean;
  deliveredCount: number;
  totalDays: number;
}

/**
 * Read-only tenant breakdown for the dashboard drill-down.
 *
 * Deliberately not `ClientMatrix`: editing a cron time or pausing a tenant
 * belongs on `/admin/clients`, so this stays a server component and the
 * dashboard ships no extra client bundle for it.
 */
export function ClientRoster({ clients }: { clients: ClientRosterRow[] }) {
  if (clients.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border bg-muted/60 px-4 py-10 text-center text-xs text-muted-foreground">
        No clients onboarded yet.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Company</TableHead>
          <TableHead>WhatsApp</TableHead>
          <TableHead>Plan / Vertical</TableHead>
          <TableHead>Active window</TableHead>
          <TableHead className="w-24">Sends at</TableHead>
          <TableHead className="w-32">Progress</TableHead>
          <TableHead className="w-24 text-right">State</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {clients.map((client) => {
          const progressPercent =
            client.totalDays > 0
              ? Math.min(100, Math.round((client.deliveredCount / client.totalDays) * 100))
              : 0;

          return (
            <TableRow key={client.id} className={client.isActive ? '' : 'opacity-60'}>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Link
                    href={`/admin/clients/${client.id}`}
                    className="font-medium text-foreground underline-offset-4 decoration-primary/40 transition-colors duration-200 hover:underline hover:decoration-primary"
                    title="Open client detail"
                  >
                    {client.companyName}
                  </Link>
                  {client.hasDriveFolder ? (
                    <FolderCheck
                      className="h-3.5 w-3.5 shrink-0 text-success-ink/70"
                      aria-label="Drive folder provisioned"
                    />
                  ) : (
                    <CloudOff
                      className="h-3.5 w-3.5 shrink-0 text-danger-ink"
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
                  <span className="text-[11px] text-muted-foreground">
                    {client.categoryName}
                  </span>
                </div>
              </TableCell>

              <TableCell className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                {client.windowLabel}
              </TableCell>

              <TableCell className="font-mono text-xs text-muted-foreground">
                {client.cronTime}
              </TableCell>

              <TableCell>
                <div className="space-y-1">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-500"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {client.deliveredCount}/{client.totalDays} sent
                  </span>
                </div>
              </TableCell>

              <TableCell className="text-right">
                <Badge variant={client.isActive ? 'emerald' : 'slate'}>
                  {client.isActive ? 'Live' : 'Paused'}
                </Badge>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
