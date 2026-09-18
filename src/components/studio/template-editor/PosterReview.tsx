'use client';

import * as React from 'react';

import { AlertTriangle, CheckCircle2, Loader2, MessageSquare, SpellCheck, Wand2, X } from 'lucide-react';

import { Chip, type ChipVariant } from '@/components/campaign/board/board-ui';
import { FIELD_SELECT_CLASS, FIELD_TEXTAREA_CLASS } from '@/components/studio/template-editor/editor-ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { foldPosterChange, missingBrandFactsForInstruction, type RevisionAvailability, type TextCheckView } from '@/lib/campaign/clone-editor-view';
import type { TemplateEditorScreen } from '@/lib/campaign/clone-editor-screen';
import { MAX_REJECTION_DETAIL, REJECTION_REASONS } from '@/lib/campaign/review';
import type { CloneBrandValues } from '@/lib/types/template-elements';
import { cn } from '@/lib/utils';

/**
 * What sits under the preview: the text check with "Fix text", "Reject…", the
 * poster chat and the versions strip. Each is compact and only as loud as its
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
// The poster chat
// ---------------------------------------------------------------------------

/** Longest the composer grows to before it scrolls. */
const MAX_CHAT_ROWS = 6;

/** Said once, permanently, under the box — never a dialog. The admin sees the price before they type, not after. */
export const POSTER_CHAT_COST = '1 image edit, about 2 minutes, billed to this client. Saved as a new version.';

/**
 * The box the admin talks to the poster in: one instruction, sent straight
 * away.
 *
 * It replaces "Small change", which was a `<details>` collapsed by default with
 * a confirm dialog behind it. Nobody found it — the first Sirah campaign's admin
 * typed "add footer also with phone number and website" into the **Photo** box
 * instead, where it could never work. So the composer is always visible, under
 * the poster it changes, and the cost it used to confirm is simply written under
 * it (`aria-describedby`, so it is read with the box rather than after it).
 *
 * The history stays where it was: the versions strip below. This is a composer,
 * not a transcript.
 *
 * Enter sends and Shift+Enter makes a new line — guarded on `isComposing`, or an
 * IME's own Enter would send half a word to the image model. While this tab's
 * change runs the box is `readOnly` rather than `disabled`: disabling it throws
 * the caret to `<body>`, and the admin loses their place in a two-minute wait.
 */
export function PosterChat({
  inputRef,
  availability,
  maxLength,
  minLength,
  running,
  failure,
  brand,
  onSend,
  onDismissFailure,
}: {
  /** Held by the editor, so the Photo box's nudge can put the caret here. */
  inputRef: React.RefObject<HTMLTextAreaElement>;
  availability: RevisionAvailability;
  maxLength: number;
  minLength: number;
  /** This tab's change, running now: what was asked, and the elapsed ticker. */
  running: { instruction: string; timer: string | null } | null;
  /** The last change that did not happen, and whether the image was paid for anyway. */
  failure: { message: string; billed: boolean } | null;
  /** The client's Brand Canvas values, to warn when the instruction names one it has not got. */
  brand: CloneBrandValues;
  /** Resolves true when the poster changed; the box is cleared then, and kept otherwise. */
  onSend: (instruction: string) => Promise<boolean>;
  onDismissFailure: () => void;
}) {
  const [instruction, setInstruction] = React.useState('');
  const pending = running !== null;
  const folded = foldPosterChange(instruction);
  const ready = availability.enabled && !pending && folded.length >= minLength;
  const missingBrandFacts = React.useMemo(() => missingBrandFactsForInstruction(folded, brand), [folded, brand]);

  const grow = React.useCallback(() => {
    const element = inputRef.current;
    if (!element) return;
    const styles = window.getComputedStyle(element);
    const line = Number.parseFloat(styles.lineHeight) || 20;
    const chrome =
      (Number.parseFloat(styles.paddingTop) || 0) +
      (Number.parseFloat(styles.paddingBottom) || 0) +
      (Number.parseFloat(styles.borderTopWidth) || 0) +
      (Number.parseFloat(styles.borderBottomWidth) || 0);
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, Math.round(line * MAX_CHAT_ROWS + chrome))}px`;
  }, [inputRef]);
  React.useEffect(grow, [grow, instruction]);

  const send = async () => {
    if (!ready) return;
    // The caret stays where it was for the whole run: the box is only read-only.
    if (await onSend(folded)) setInstruction('');
    inputRef.current?.focus();
  };

  return (
    <section aria-label="Poster chat" className="space-y-2 rounded-md border border-border p-2.5">
      <form
        className="space-y-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label htmlFor="editor-poster-chat" className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
          <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          Ask for a change
        </label>
        <textarea
          id="editor-poster-chat"
          ref={inputRef}
          rows={2}
          value={instruction}
          maxLength={maxLength}
          readOnly={pending}
          aria-disabled={pending || !availability.enabled}
          aria-describedby="editor-poster-chat-cost"
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey) return;
            // An IME composing a word ends it with Enter; sending there would cut
            // the word in half and bill an edit for it.
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            void send();
          }}
          placeholder="Ask for one change — e.g. add a footer strip with my phone and website"
          className={cn(FIELD_TEXTAREA_CLASS, 'min-h-0 resize-none', pending && 'cursor-default opacity-70')}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p id="editor-poster-chat-cost" className="text-[10px] leading-snug text-muted-foreground">
            {POSTER_CHAT_COST}
          </p>
          <Button type="submit" size="sm" className="h-8 shrink-0 text-[12px]" disabled={!ready} title={availability.reason ?? undefined}>
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Wand2 aria-hidden />}
            Send
          </Button>
        </div>
      </form>

      {!availability.enabled && availability.reason && <p className="text-[11px] text-muted-foreground">{availability.reason}</p>}

      {missingBrandFacts.length > 0 && !pending && (
        <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-[11px] leading-snug text-warning-ink">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          Brand Canvas has no {listOf(missingBrandFacts)} for this client, so the AI would invent one — add it in Brand Canvas first.
        </p>
      )}

      {running && (
        <div className="space-y-1 rounded-md border border-border bg-muted/40 px-2.5 py-2">
          <p className="break-words text-[12px] text-foreground">“{running.instruction}”</p>
          {/* Only the stable sentence is live: a region carrying the timer would be read out every second. */}
          <p className="text-[11px] text-muted-foreground">
            <span role="status">Applying your change to the poster… It keeps going if you leave this page.</span>
            {running.timer && <span className="ml-1 font-mono tabular-nums">{running.timer}</span>}
          </p>
        </div>
      )}

      {failure && !running && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-2.5 py-2 text-[11px] leading-snug text-danger-ink">
          <span className="min-w-0 flex-1">
            {failure.message}
            <span className="block text-muted-foreground">
              {failure.billed
                ? 'The image was generated, so this edit was billed. The poster is unchanged — your words are still in the box.'
                : 'Nothing was billed. Your words are still in the box.'}
            </span>
          </span>
          <button type="button" aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100" onClick={onDismissFailure}>
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      )}
    </section>
  );
}

/** "Phone", "Phone and Website", "Phone, Website and Tagline". */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
