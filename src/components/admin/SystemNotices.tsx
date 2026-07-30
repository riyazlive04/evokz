import { AlertTriangle, Database } from 'lucide-react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/**
 * Cross-section notices: a config gap and a dead database both need to be
 * legible from whichever page the operator happens to be on.
 */

export function ConfigWarning({ missing }: { missing: string[] }) {
  if (missing.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-4 text-xs text-amber-700">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="font-medium">
        {missing.length} integration variable{missing.length === 1 ? '' : 's'} unset — the
        related steps will fail at runtime:
      </span>
      {missing.map((key) => (
        <code key={key} className="rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px]">
          {key}
        </code>
      ))}
    </div>
  );
}

export function DatabaseErrorState({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center py-10">
      <Card className="max-w-lg border-red-500/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-red-600">
            <Database className="h-4 w-4" />
            Database unreachable
          </CardTitle>
          <CardDescription>
            The console could not read from PostgreSQL. Verify <code>DATABASE_URL</code> and
            that the schema has been pushed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <pre className="overflow-x-auto rounded-lg border border-border bg-muted p-3 text-[11px] text-muted-foreground">
            {message}
          </pre>
          <p className="text-xs text-muted-foreground">
            Run <code className="text-foreground">npm run prisma:push</code> to sync the schema.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
