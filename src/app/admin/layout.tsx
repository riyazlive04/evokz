import Link from 'next/link';

import { Activity } from 'lucide-react';

import { AdminNav } from '@/components/admin/AdminNav';
import { SignOutButton } from '@/components/admin/SignOutButton';
import { ThemeToggle } from '@/components/admin/ThemeToggle';
import { getAppTimeZone } from '@/lib/time';

/**
 * Shared console shell: header bar, section tabs, and page container.
 * Deliberately free of database reads so navigating between sections never
 * re-renders — or staleness-traps — the header.
 *
 * The bar follows the active theme rather than pinning itself dark: it reads
 * `bg-secondary`, which resolves to the light-blue field (#e3edf7) on the light
 * theme and steel navy (#213a56) on the dark one. `sticky` already makes this a
 * containing block for the two absolutely-positioned decorations below, so it
 * must NOT also be given `relative` — both set `position` and would collide.
 */
export default function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const timeZone = getAppTimeZone();

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-secondary text-foreground">
        {/* Blueprint plane; the grid lines track --border in either theme. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-blueprint-grid opacity-40"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-full bg-gradient-brand-radial opacity-35"
        />

        <div className="relative mx-auto max-w-[1600px] px-4 sm:px-8">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 pt-4">
            <Link
              href="/admin/dashboard"
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
            >
              {/* `text-brand-to`, not `text-primary`: primary is true sand, which
                  measures ~2.3:1 on the light-blue bar. brand-to resolves to
                  sand-600 on light (4.79:1) and true sand on dark. */}
              <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.28em] text-brand-to">
                <Activity className="h-3.5 w-3.5" />
                Evokz ACE
              </span>
              <span className="text-gradient-brand text-lg font-bold tracking-tight">
                Creative Engine Console
              </span>
            </Link>

            <div className="flex items-center gap-3">
              <p className="text-[11px] text-muted-foreground">
                Dispatch window evaluated in{' '}
                <span className="font-mono text-foreground/70">{timeZone}</span>
              </p>
              <ThemeToggle />
              <SignOutButton />
            </div>
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
