'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import {
  Database,
  Gauge,
  Layers,
  Sparkles,
  Users,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Primary console navigation.
 *
 * A client component purely so `usePathname` can resolve the active tab; the
 * surrounding chrome stays server-rendered in the admin layout.
 */

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Also highlight for nested routes, e.g. `/admin/clients/<id>`. */
  nested?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: '/admin/dashboard', label: 'Dashboard', icon: Gauge },
  { href: '/admin/poster-studio', label: 'Poster Studio', icon: Sparkles, nested: true },
  { href: '/admin/plans', label: 'Plan', icon: Layers },
  { href: '/admin/verticals', label: 'Verticals', icon: Database },
  { href: '/admin/clients', label: 'Clients', icon: Users, nested: true },
];

export function AdminNav() {
  const pathname = usePathname();

  function renderItem({ href, label, icon: Icon, nested }: NavItem) {
    const active =
      pathname === href || (nested === true && pathname.startsWith(`${href}/`));

    return (
      <Link
        key={href}
        href={href}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex shrink-0 items-center gap-2 border-b-2 px-3.5 py-3 text-[13px] font-medium transition-colors duration-200',
          active
            ? 'border-brand-to text-foreground'
            : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground',
        )}
      >
        <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-brand-to' : 'text-current')} />
        {label}
      </Link>
    );
  }

  return (
    <nav
      aria-label="Console sections"
      className={cn(
        '-mb-px flex gap-1 overflow-x-auto',
        // Bleeds to the viewport edges on mobile so the row scrolls past the
        // layout's own padding instead of clipping the last tab against it. The
        // negative margin is cancelled at `sm`, where every tab fits unscrolled.
        '-mx-4 px-4 sm:mx-0 sm:px-0',
        // The horizontal bar sits directly under the header's own border, and a
        // permanent scrollbar gutter on desktop-class browsers would read as a
        // second rule.
        'scrollbar-none',
      )}
    >
      {NAV_ITEMS.map(renderItem)}
    </nav>
  );
}
