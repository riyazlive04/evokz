'use client';

import * as React from 'react';

import { X } from 'lucide-react';

import type { NoticeTone } from '@/lib/campaign/clone-editor-view';
import { cn } from '@/lib/utils';

/**
 * Small pieces the template poster editor's panels share: a form section, the
 * notice line, and the field classes. Status colours come from the design
 * tokens (`*-ink` on a tinted surface), which are retuned per theme.
 */

export interface EditorNotice {
  tone: NoticeTone;
  lines: string[];
}

const NOTICE_CLASS: Record<NoticeTone, string> = {
  success: 'border-success/30 bg-success/5 text-success-ink',
  warning: 'border-warning/30 bg-warning/5 text-warning-ink',
  danger: 'border-danger/30 bg-danger/5 text-danger-ink',
};

export function NoticeLine({ notice, onDismiss }: { notice: EditorNotice; onDismiss?: () => void }) {
  return (
    <div role={notice.tone === 'danger' ? 'alert' : 'status'} className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-[12px]', NOTICE_CLASS[notice.tone])}>
      <div className="min-w-0 flex-1 space-y-0.5">
        {notice.lines.map((line, index) => (
          <p key={`${index}-${line}`} className="break-words">
            {line}
          </p>
        ))}
      </div>
      {onDismiss && (
        <button type="button" aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100" onClick={onDismiss}>
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/** One titled block of the form. */
export function EditorSection({
  id,
  title,
  description,
  action,
  children,
}: {
  id: string;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className="space-y-2.5 border-b border-border pb-4 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          {title}
        </h2>
        {action}
      </div>
      {description && <div className="text-[11px] leading-snug text-muted-foreground">{description}</div>}
      {children}
    </section>
  );
}

/** A textarea styled like `Input`. */
export const FIELD_TEXTAREA_CLASS =
  'flex min-h-[3.75rem] w-full resize-y rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50';

/** A native select styled like `Input`. */
export const FIELD_SELECT_CLASS =
  'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

/** Compact ghost buttons inside a field's header. */
export const FIELD_BUTTON_CLASS = 'h-6 gap-1 px-1.5 text-[11px] font-normal text-muted-foreground hover:text-foreground [&_svg]:size-3';
