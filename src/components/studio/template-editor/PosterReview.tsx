'use client';

import * as React from 'react';

import { AlertTriangle, CheckCircle2, ChevronRight, Loader2, SpellCheck, Wand2, X } from 'lucide-react';

import { Chip, type ChipVariant } from '@/components/campaign/board/board-ui';
import { FIELD_SELECT_CLASS } from '@/components/studio/template-editor/editor-ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { RevisionAvailability, TextCheckView } from '@/lib/campaign/clone-editor-view';
import type { TemplateEditorScreen } from '@/lib/campaign/clone-editor-screen';
import { MAX_REJECTION_DETAIL, REJECTION_REASONS } from '@/lib/campaign/review';
import { cn } from '@/lib/utils';

/**
 * What sits under the preview: the text check with "Fix text", the versions
 * strip, "Reject…" and "Small change". Each is compact and only as loud as its
 * state — an all-correct text check is one green line.
 */

// ---------------------------------------------------------------------------
// Text check
// ---------------------------------------------------------------------------

export function TextCheckPanel({
  view,
  hasPoster,
  viewingOlder,
  fix,
  pending,
  onFix,
}: {
  view: TextCheckView;
  hasPoster: boolean;
  /** An older version is on show: its check is not this panel's. */
  viewingOlder: boolean;
  fix: RevisionAvailability;
  pending: boolean;
  onFix: () => void;
}) {
  if (!hasPoster || viewingOlder) return null;
  if (view.state === 'none') {
    return <p className="text-[12px] text-muted-foreground">Text not checked on this poster.</p>;
  }
  if (view.state === 'ok') {
    return (
      <p className="flex items-center gap-1.5 text-[12px] text-success-ink">
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
        All text correct
      </p>
    );
  }
  return (
    <section aria-label="Text check" className="space-y-2 rounded-md border border-warning/30 bg-warning/5 p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[12px] font-medium text-warning-ink">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
          Text check: {view.issues.length} {view.issues.length === 1 ? 'difference' : 'differences'}
        </p>
        <Button size="sm" variant="outline" className="h-7 gap-1.5 px-2 text-[11px] [&_svg]:size-3.5" disabled={!fix.enabled || pending} title={fix.reason ?? undefined} onClick={onFix}>
          {pending ? <Loader2 className="animate-spin" /> : <SpellCheck />}
          Fix text
        </Button>
      </div>
      <ul className="space-y-1 text-[11px] leading-snug">
        {view.issues.map((issue) => (
          <li key={issue.key} className="break-words text-foreground">
            {issue.leftover ? (
              <>
                <span className="text-muted-foreground">Leftover:</span> “{issue.found}”
              </>
            ) : (
              <>
                <span className="text-muted-foreground">{issue.label}:</span> expected “{issue.expected}” · found {issue.found ? `“${issue.found}”` : 'nothing legible'}
              </>
            )}
          </li>
        ))}
      </ul>
      {!fix.enabled && fix.reason && <p className="text-[10px] text-muted-foreground">{fix.reason}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

const APPROVAL_VARIANT: Record<string, ChipVariant> = { APPROVED: 'emerald', REJECTED: 'destructive', PENDING: 'amber' };
const APPROVAL_LABEL: Record<string, string> = { APPROVED: 'Approved', REJECTED: 'Rejected', PENDING: 'Pending' };

/**
 * Every version as a thumbnail, oldest to newest. Selecting one shows it in the
 * preview, read-only; the active one is marked and selecting it returns there.
 */
export function VersionsStrip({
  versions,
  selectedId,
  onSelect,
}: {
  versions: TemplateEditorScreen['versions'];
  /** The version on show; null for the active one. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  if (versions.length === 0) return null;
  const ordered = [...versions].sort((a, b) => a.versionNumber - b.versionNumber);
  return (
    <section aria-label="Versions" className="space-y-1.5">
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Versions ({versions.length})</h3>
      <ol className="flex gap-2 overflow-x-auto pb-1">
        {ordered.map((version) => {
          const selected = selectedId === null ? version.active : selectedId === version.id;
          return (
            <li key={version.id} className="shrink-0">
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelect(version.active ? null : version.id)}
                title={`v${version.versionNumber} · ${APPROVAL_LABEL[version.approvalStatus] ?? version.approvalStatus}${version.current ? '' : ' · outdated'} · ${version.createdLabel}`}
                className={cn(
                  'flex w-20 flex-col gap-1 rounded-md border p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent/60',
                )}
              >
                <span className="relative block aspect-[4/5] w-full overflow-hidden rounded-sm bg-muted">
                  {version.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element -- session-gated studio image route
                    <img src={version.imageUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                  )}
                </span>
                <span className="flex items-center justify-between gap-1 text-[10px]">
                  <span className="font-semibold text-foreground">v{version.versionNumber}</span>
                  {version.active && <span className="text-[9px] font-semibold uppercase tracking-wider text-primary">Active</span>}
                </span>
                <Chip variant={APPROVAL_VARIANT[version.approvalStatus] ?? 'slate'} className="justify-center px-1 text-[9px]">
                  {APPROVAL_LABEL[version.approvalStatus] ?? version.approvalStatus}
                </Chip>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Reject
// ---------------------------------------------------------------------------

/** "Reject…": a reason from the review catalogue and an optional detail. */
export function RejectPanel({
  versionNumber,
  pending,
  error,
  onReject,
}: {
  versionNumber: number;
  pending: boolean;
  error: string | null;
  onReject: (input: { reason: string; detail: string }) => Promise<boolean>;
}) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState<string>(REJECTION_REASONS[0].key);
  const [detail, setDetail] = React.useState('');

  if (!open) {
    return (
      <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground [&_svg]:size-3.5" onClick={() => setOpen(true)}>
        <X aria-hidden />
        Reject…
      </Button>
    );
  }
  return (
    <form
      className="space-y-2 rounded-md border border-border p-2.5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (await onReject({ reason, detail })) {
          setOpen(false);
          setDetail('');
        }
      }}
    >
      <p className="text-[12px] font-medium text-foreground">Send v{versionNumber} back</p>
      <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
        <span className="space-y-1">
          <label htmlFor="editor-reject-reason" className="block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Reason
          </label>
          <select id="editor-reject-reason" value={reason} onChange={(event) => setReason(event.target.value)} className={FIELD_SELECT_CLASS}>
            {REJECTION_REASONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </span>
        <span className="space-y-1">
          <label htmlFor="editor-reject-detail" className="block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            What is wrong? {reason === 'other' ? '(required)' : '(optional)'}
          </label>
          <Input id="editor-reject-detail" value={detail} onChange={(event) => setDetail(event.target.value)} maxLength={MAX_REJECTION_DETAIL} placeholder="e.g. the headline sits over the logo" />
        </span>
      </div>
      {error && (
        <p role="alert" className="text-[12px] text-danger-ink">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" variant="outline" className="h-8" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : <X />}
          Reject
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-8" disabled={pending} onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <span className="text-[11px] text-muted-foreground">The next generation is told why.</span>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Small change
// ---------------------------------------------------------------------------

/** "Small change": one instruction applied to the poster as it is, collapsed until wanted. */
export function SmallChangePanel({
  availability,
  pending,
  maxLength,
  onApply,
}: {
  availability: RevisionAvailability;
  pending: boolean;
  maxLength: number;
  onApply: (instruction: string) => Promise<boolean>;
}) {
  const [instruction, setInstruction] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const ready = availability.enabled && !pending && instruction.replace(/\s+/g, ' ').trim().length >= 3;

  return (
    <details className="group rounded-md border border-border" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-2 text-[12px] font-medium text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
        Small change
        <span className="font-normal text-muted-foreground">— edit this poster without regenerating it</span>
      </summary>
      <form
        className="space-y-2 px-2.5 pb-2.5"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!ready) return;
          if (await onApply(instruction)) setInstruction('');
        }}
      >
        <label htmlFor="editor-small-change" className="sr-only">
          Describe one change to this poster
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="editor-small-change"
            value={instruction}
            maxLength={maxLength}
            disabled={pending}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="Describe one change to this poster…"
          />
          <Button type="submit" size="sm" className="h-9 shrink-0" disabled={!ready} title={availability.reason ?? undefined}>
            {pending ? <Loader2 className="animate-spin" /> : <Wand2 />}
            Apply
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          {availability.reason ?? 'e.g. “make the background lighter”. Words, layout and photo stay as they are unless you ask. One AI image edit, about two minutes; saved as a new version.'}
        </p>
      </form>
    </details>
  );
}
