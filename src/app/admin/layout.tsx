import Link from 'next/link';

import { Activity } from 'lucide-react';

import { AdminNav } from '@/components/admin/AdminNav';
import { getAppTimeZone } from '@/lib/time';

/**
 * Shared console shell: the dark evokz.in chrome, the section tabs, and the
 * page container. Deliberately free of database reads so navigating between
 * sections never re-renders — or staleness-traps — the header.
 */
export default function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const timeZone = getAppTimeZone();

  return (
    <div className="min-h-screen bg-background">
      {/* `dark` re-binds the design tokens for this subtree only, so the bar
          resolves against the site's #151821 chrome while the body stays white. */}
      <header className="dark sticky top-0 z-40 border-b border-border bg-card text-foreground">
        {/* Blueprint plane, scoped to the dark bar — it needs a dark ground to read. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-blueprint-grid opacity-40"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-full bg-gradient-brand-radial opacity-60"
        />

        <div className="relative mx-auto max-w-[1600px] px-4 sm:px-8">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 pt-4">
            <Link
              href="/admin/dashboard"
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
            >
              <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.28em] text-brand-to">
                <Activity className="h-3.5 w-3.5" />
                Evokz ACE
              </span>
              <span className="text-gradient-brand text-lg font-bold tracking-tight">
                Creative Engine Console
              </span>
            </Link>

            <p className="text-[11px] text-muted-foreground">
              Dispatch window evaluated in{' '}
              <span className="font-mono text-foreground/70">{timeZone}</span>
            </p>
          </div>

          <AdminNav />
        </div>
      </header>

      <main className="relative mx-auto max-w-[1600px] space-y-6 px-4 py-8 sm:px-8">
        {children}
      </main>
    </div>
  );
}
