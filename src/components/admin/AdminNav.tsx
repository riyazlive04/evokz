'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import {
  Database,
  Gauge,
  Layers,
  MonitorPlay,
  Palette,
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
  { href: '/admin/plans', label: 'Plan', icon: Layers },
  { href: '/admin/verticals', label: 'Verticals', icon: Database },
  { href: '/admin/clients', label: 'Clients', icon: Users, nested: true },
];

/** Pinned to the far end of the bar — a sales surface, not a console section. */
const TRAILING_NAV_ITEMS: NavItem[] = [
  { href: '/admin/poster-preview', label: 'Posters', icon: Palette },
  { href: '/admin/demo', label: 'Demo', icon: MonitorPlay, nested: true },
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
    <nav aria-label="Console sections" className="-mb-px flex gap-1 overflow-x-auto">
      {NAV_ITEMS.map(renderItem)}
      <span className="ml-auto flex gap-1 pl-6">{TRAILING_NAV_ITEMS.map(renderItem)}</span>
    </nav>
  );
}
