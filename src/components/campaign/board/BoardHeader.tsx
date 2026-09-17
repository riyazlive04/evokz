'use client';

import * as React from 'react';
import Link from 'next/link';

import { ArrowLeft, CalendarCheck, ChevronLeft, ChevronRight, Loader2, Pause, Play, Search, X } from 'lucide-react';

import { BOARD_STATUS_INK, Chip, type ChipVariant } from '@/components/campaign/board/board-ui';
import type { BoardView } from '@/components/campaign/board/types';
import { Button } from '@/components/ui/button';
import { BOARD_STATUS_LABELS, BOARD_STATUSES, MAX_BOARD_SEARCH, normalizeBoardSearch, type BoardFilter, type BoardQuery } from '@/lib/campaign/board';
import { cn } from '@/lib/utils';

const CAMPAIGN_STATUS_VARIANT: Record<BoardView['status'], ChipVariant> = {
  DRAFT: 'slate',
  ACTIVE: 'emerald',
  PAUSED: 'amber',
  COMPLETED: 'slate',
  CANCELLED: 'destructive',
};

const FILTERS: BoardFilter[] = ['all', ...BOARD_STATUSES];

/**
 * The board's sticky header: who and what, the campaign's switches, the
 * counters that are also the filters, search and the week pager.
 *
 * Everything that changes the view is a URL change (`onNavigate`), so reload,
 * back and a shared link all open the same view.
 */
export function BoardHeader({
  board,
  navigating,
  statusPending,
  policyPending,
  onNavigate,
  onToggleStatus,
  onTogglePolicy,
}: {
  board: BoardView;
  navigating: boolean;
  statusPending: boolean;
  policyPending: boolean;
  onNavigate: (next: Partial<BoardQuery>) => void;
  onToggleStatus: () => void;
  onTogglePolicy: () => void;
}) {
  const [search, setSearch] = React.useState(board.q);
  const lastPushed = React.useRef(board.q);

  // The URL is the source of truth: follow it when it changes from elsewhere (back,
  // a shared link) — but not when it is our own search arriving, which would
  // overwrite whatever was typed while that page loaded.
  React.useEffect(() => {
    if (board.q === lastPushed.current) return;
    setSearch(board.q);
    lastPushed.current = board.q;
  }, [board.q]);

  // Typing searches after a short pause, without a history entry per keystroke.
  React.useEffect(() => {
    const next = normalizeBoardSearch(search);
    if (next === lastPushed.current) return undefined;
    const timer = window.setTimeout(() => {
      lastPushed.current = next;
      onNavigate({ q: next, week: null });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [search, onNavigate]);

  const autoApprove = board.approvalPolicy === 'AUTO_APPROVE';
  const canToggleStatus = !board.closed && (board.status === 'DRAFT' || board.status === 'ACTIVE' || board.status === 'PAUSED');
  const filtered = board.mode === 'filtered';
  const { page } = board;

  return (
    <div className="space-y-3">
      {/* ---- Identity and switches ---- */}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 space-y-1">
          <Link
            href={`/admin/clients/${board.clientId}`}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" />
            {board.clientName}
          </Link>
          <h1 className="flex flex-wrap items-center gap-2 text-lg font-semibold tracking-tight text-foreground sm:text-xl">
            <span className="min-w-0 break-words">{board.campaignName}</span>
            <Chip variant={CAMPAIGN_STATUS_VARIANT[board.status]}>{board.status.toLowerCase()}</Chip>
          </h1>
          <p className="text-[11px] text-muted-foreground">
            <span className="font-mono">{board.datesLabel}</span> · {board.scheduleLabel} · {board.categoryName}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {!board.closed && (
            <div className="flex max-w-xs items-center gap-2.5">
              <button
                type="button"
                role="switch"
                aria-checked={autoApprove}
                aria-label="Auto-approve new posters"
                disabled={policyPending}
                onClick={onTogglePolicy}
                className={cn(
                  'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                  autoApprove ? 'border-primary bg-primary' : 'border-border bg-muted',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'inline-block h-3.5 w-3.5 rounded-full bg-background shadow transition-transform',
                    autoApprove ? 'translate-x-[1.1rem]' : 'translate-x-0.5',
                  )}
                />
              </button>
              <span className="min-w-0">
                <span className="block text-[12px] font-medium text-foreground">
                  Auto-approve {policyPending && <Loader2 className="ml-1 inline h-3 w-3 animate-spin" />}
                </span>
                <span className="block text-[11px] leading-4 text-muted-foreground">
                  {autoApprove ? 'New posters are approved as they are made, then booked.' : 'New posters wait for your approval before they are booked.'}
                </span>
              </span>
            </div>
          )}
          {canToggleStatus && (
            <Button size="sm" variant={board.status === 'ACTIVE' ? 'outline' : 'default'} onClick={onToggleStatus} disabled={statusPending}>
              {statusPending ? <Loader2 className="h-4 w-4 animate-spin" /> : board.status === 'ACTIVE' ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              {board.status === 'ACTIVE' ? 'Pause' : board.status === 'PAUSED' ? 'Resume' : 'Activate'}
            </Button>
          )}
        </div>
      </div>

      {/* ---- Counters, which are the filters ---- */}
      <nav aria-label="Filter posts by status" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <ul className="flex w-max gap-1.5 pb-0.5">
          {FILTERS.map((filter) => {
            const active = board.filter === filter;
            const count = board.counts[filter];
            const label = filter === 'all' ? 'All' : BOARD_STATUS_LABELS[filter];
            return (
              <li key={filter}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => onNavigate({ status: filter, week: null })}
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active ? 'border-primary bg-primary/15 text-foreground' : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground',
                    count === 0 && !active && 'opacity-60',
                  )}
                >
                  {label}
                  <span className={cn('font-mono text-[11px] font-semibold', filter === 'all' ? 'text-foreground' : count > 0 ? BOARD_STATUS_INK[filter] : 'text-muted-foreground')}>
                    {count}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* ---- Search and pager ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <form
          role="search"
          className="relative min-w-0 flex-1 basis-56 sm:max-w-xs"
          onSubmit={(event) => {
            event.preventDefault();
            const next = normalizeBoardSearch(search);
            lastPushed.current = next;
            onNavigate({ q: next, week: null });
          }}
        >
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            maxLength={MAX_BOARD_SEARCH}
            placeholder="Search headline or day…"
            aria-label="Search posts by headline or day number"
            className="flex h-8 w-full rounded-md border border-input bg-background pl-8 pr-8 text-[12px] shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden"
          />
          {search && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setSearch('');
                lastPushed.current = '';
                onNavigate({ q: '', week: null });
              }}
              className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </form>

        <div className="ml-auto flex items-center gap-1">
          {navigating && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
          <Button
            size="icon"
            variant="outline"
            className="h-8 w-8"
            aria-label={filtered ? 'Previous page' : 'Previous week'}
            disabled={page.index <= 1}
            onClick={() => onNavigate({ week: page.index - 1 })}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[7.5rem] px-1 text-center text-[12px] font-medium text-foreground" aria-live="polite">
            {page.label}
            <span className="block text-[10px] font-normal text-muted-foreground">
              {filtered ? `page ${page.index} of ${page.count}` : `week ${page.index} of ${page.count}`}
            </span>
          </span>
          <Button
            size="icon"
            variant="outline"
            className="h-8 w-8"
            aria-label={filtered ? 'Next page' : 'Next week'}
            disabled={page.index >= page.count}
            onClick={() => onNavigate({ week: page.index + 1 })}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          {filtered ? (
            <Button size="sm" variant="ghost" className="h-8" onClick={() => onNavigate({ status: 'all', q: '', week: null })}>
              <X className="h-3.5 w-3.5" />
              Clear
            </Button>
          ) : (
            <Button size="sm" variant="ghost" className="h-8" disabled={page.index === page.todayIndex} onClick={() => onNavigate({ week: null })}>
              <CalendarCheck className="h-3.5 w-3.5" />
              Today
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
