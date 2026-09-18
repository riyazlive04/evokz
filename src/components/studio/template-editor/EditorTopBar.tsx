'use client';

import * as React from 'react';

import { AlertCircle, ArrowLeft, Check, ChevronLeft, ChevronRight, Loader2, RefreshCw, Sparkles } from 'lucide-react';

import { Chip } from '@/components/campaign/board/board-ui';
import { Button } from '@/components/ui/button';
import { templateEditorHref, type EditorChipTone } from '@/lib/campaign/clone-editor-view';
import type { TemplateEditorScreen } from '@/lib/campaign/clone-editor-screen';
import { cn } from '@/lib/utils';

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

/**
 * The editor's top bar: the way back to the board, the day walker, what day this
 * is, its status, whether the form is saved, and the one or two actions that
 * move the poster on — Generate (or Regenerate) and Approve.
 *
 * Approve names the version it acts on ("Approve v1"), which is whichever one
 * the versions strip has on show, so the label follows the admin’s choice
 * rather than the day’s active pointer. The editor decides it (`approveAction`).
 *
 * Links are real anchors (a middle-click still opens a tab) whose ordinary
 * click goes through `onNavigate`, so the editor can save pending words first.
 * While this tab's long action runs (`leavePausedReason`) an ordinary click does
 * nothing: the links show as busy and say why.
 */
export function EditorTopBar({
  screen,
  chip,
  saveState,
  saveError,
  onRetrySave,
  generate,
  approve,
  busyKind,
  leavePausedReason,
  onNavigate,
}: {
  screen: TemplateEditorScreen;
  chip: { label: string; tone: EditorChipTone };
  saveState: SaveState;
  saveError: string | null;
  onRetrySave: () => void;
  generate: { label: string; enabled: boolean; reason: string | null; onClick: () => void };
  approve: { visible: boolean; label: string; onClick: () => void };
  busyKind: string | null;
  leavePausedReason: string | null;
  onNavigate: (href: string) => void;
}) {
  const { day, nav, campaign, links } = screen;
  const approving = busyKind === 'approve';
  const generating = busyKind === 'generate';
  const hasPoster = screen.activeVersion !== null;
  const paused = leavePausedReason !== null;

  const follow = (href: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    if (paused) return;
    onNavigate(href);
  };
  const pausedProps = paused ? { 'aria-disabled': true, 'aria-describedby': 'editor-leave-paused', title: leavePausedReason } : {};

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <a
          href={links.board}
          onClick={follow(links.board)}
          {...pausedProps}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-sm text-[12px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            paused ? 'cursor-not-allowed opacity-60' : 'hover:text-foreground',
          )}
        >
          {paused ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <ArrowLeft className="h-3.5 w-3.5" aria-hidden />}
          Back to campaign
        </a>
        {paused && (
          <span id="editor-leave-paused" className="sr-only">
            {leavePausedReason}
          </span>
        )}
        <nav aria-label="Other days" className="flex items-center gap-1">
          <DayLink direction="prev" target={nav.prev} pausedReason={leavePausedReason} onNavigate={follow} />
          <span className="px-1 font-mono text-[11px] text-muted-foreground" aria-label={`Day ${day.dayNumber} of ${campaign.totalDays}`}>
            {day.dayNumber}/{campaign.totalDays}
          </span>
          <DayLink direction="next" target={nav.next} pausedReason={leavePausedReason} onNavigate={follow} />
        </nav>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-semibold tracking-tight text-foreground sm:text-lg">
            <span>Day {day.dayNumber}</span>
            <span className="font-normal text-muted-foreground">· {day.dateLabel}</span>
            <span className="hidden min-w-0 max-w-[18rem] truncate font-normal text-muted-foreground sm:inline">· {campaign.name}</span>
            <Chip variant={chip.tone}>{chip.label}</Chip>
          </h1>
          <p className="truncate text-[12px] text-muted-foreground">
            <span className="sm:hidden">{campaign.name} · </span>
            {screen.client.companyName}
            {screen.delivery ? ` · ${screen.delivery.statusLabel} ${screen.delivery.whenLabel}` : ''}
            {screen.status.lockLabel ? ` · ${screen.status.lockLabel}` : ''}
          </p>
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          <SaveIndicator state={saveState} error={saveError} onRetry={onRetrySave} />
          {approve.visible && (
            <Button size="sm" onClick={approve.onClick} disabled={approving} className="flex-1 sm:flex-none">
              {approving ? <Loader2 className="animate-spin" /> : <Check />}
              {approve.label}
            </Button>
          )}
          <Button
            size="sm"
            variant={approve.visible ? 'outline' : 'default'}
            onClick={generate.onClick}
            disabled={!generate.enabled || generating}
            title={generate.enabled ? undefined : (generate.reason ?? undefined)}
            className="flex-1 sm:flex-none"
          >
            {generating ? <Loader2 className="animate-spin" /> : hasPoster ? <RefreshCw /> : <Sparkles />}
            {generate.label}
          </Button>
        </div>
      </div>
      {!generate.enabled && generate.reason && !generating && (
        <p className="text-right text-[11px] text-muted-foreground sm:text-[11px]">{generate.reason}</p>
      )}
    </div>
  );
}

function DayLink({
  direction,
  target,
  pausedReason,
  onNavigate,
}: {
  direction: 'prev' | 'next';
  target: { id: string; dayNumber: number; dateLabel: string } | null;
  pausedReason: string | null;
  onNavigate: (href: string) => (event: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  const Icon = direction === 'prev' ? ChevronLeft : ChevronRight;
  const className = 'inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  if (!target) {
    return (
      <span aria-disabled className={cn(className, 'cursor-default text-muted-foreground/40')}>
        <Icon className="h-4 w-4" aria-hidden />
        <span className="sr-only">{direction === 'prev' ? 'No earlier day' : 'No later day'}</span>
      </span>
    );
  }
  const href = templateEditorHref(target.id);
  return (
    <a
      href={href}
      onClick={onNavigate(href)}
      className={cn(className, 'text-muted-foreground', pausedReason ? 'cursor-not-allowed opacity-60' : 'hover:bg-accent hover:text-foreground')}
      aria-label={`${direction === 'prev' ? 'Previous' : 'Next'}: day ${target.dayNumber}, ${target.dateLabel}`}
      aria-disabled={pausedReason ? true : undefined}
      aria-describedby={pausedReason ? 'editor-leave-paused' : undefined}
      title={pausedReason ?? `Day ${target.dayNumber} · ${target.dateLabel}`}
    >
      {direction === 'next' && <span className="hidden sm:inline">Day {target.dayNumber}</span>}
      <Icon className="h-4 w-4" aria-hidden />
      {direction === 'prev' && <span className="hidden sm:inline">Day {target.dayNumber}</span>}
    </a>
  );
}

function SaveIndicator({ state, error, onRetry }: { state: SaveState; error: string | null; onRetry: () => void }) {
  if (state === 'error') {
    return (
      <span role="alert" className="inline-flex items-center gap-1.5 text-[11px] text-danger-ink" title={error ?? undefined}>
        <AlertCircle className="h-3.5 w-3.5" aria-hidden />
        Couldn&apos;t save
        <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2">
          Retry
        </button>
      </span>
    );
  }
  const text = state === 'saving' ? 'Saving…' : state === 'dirty' ? 'Unsaved changes' : state === 'saved' ? 'Saved' : null;
  if (!text) return null;
  return (
    <span aria-live="polite" className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
      {state === 'saving' && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
      {state === 'saved' && <Check className="h-3 w-3 text-success-ink" aria-hidden />}
      {text}
    </span>
  );
}
