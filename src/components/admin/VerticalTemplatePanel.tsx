'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { ImagePlus, Loader2, Pencil, Trash2, Upload } from 'lucide-react';

import {
  deleteVerticalTemplate,
  readTemplateElementsAction,
  renameVerticalTemplate,
  uploadVerticalTemplate,
} from '@/app/admin/dashboard/actions';
import { setTemplateActiveAction } from '@/app/admin/campaigns/actions';
import { TemplateElementsDialog } from '@/components/admin/TemplateElementsDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAction } from '@/hooks/use-action';
import { cloneSizeFor } from '@/lib/poster-studio/clone-size';
import { MAX_TEMPLATES_PER_CATEGORY } from '@/lib/template-limits';
import type { TemplateElementsState } from '@/lib/templates/elements-view';

/**
 * Reference-poster library for one vertical.
 *
 * A template is usable as soon as it is uploaded — there is no approval step.
 * Each upload is read once for its elements (its words, photo and business
 * details), which campaign posters copy the template around, so the things an
 * admin manages here are the image, its name, that reading and whether it is
 * active. The template prompt box is retired: the elements replace it.
 *
 * Every card refreshes the page itself after a successful change
 * (`router.refresh()`), as the campaign screens do, rather than relying on the
 * action's revalidation to reach this page.
 *
 * Uploads run one file per action call rather than one call carrying the whole
 * selection. Server Actions have a body limit, a batch of full-size posters
 * would breach it, and sequencing gives a per-file error — "poster-3.png is
 * 9 MB" — instead of one failure for the batch with nothing to act on.
 */

export interface VerticalTemplateRow {
  id: string;
  label: string;
  /** Gallery-sized, through the console's own authenticated proxy. */
  thumbnailUrl: string;
  /** The stored file at full size, through the same proxy. */
  viewUrl: string;
  width: number | null;
  height: number | null;
  /** Whether campaign days may be newly mapped to this template. */
  isActive: boolean;
  /** Days of open campaigns currently using it (manual or auto). */
  campaignDays: number;
  /** What its element reading found, or why there is none. */
  elements: TemplateElementsState;
}

export function VerticalTemplatePanel({
  categoryId,
  categoryName,
  templates,
  totalCount,
}: {
  categoryId: string;
  categoryName: string;
  /** The current page of the library, not all of it. */
  templates: VerticalTemplateRow[];
  /** Every template in the vertical, across all pages. */
  totalCount: number;
}) {
  const router = useRouter();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [progress, setProgress] = React.useState<string | null>(null);
  const [problems, setProblems] = React.useState<string[]>([]);

  const upload = useAction(uploadVerticalTemplate);

  // Against the whole library, never the page. Sizing this to `templates.length`
  // would offer room for another twenty-four uploads on every page of a vertical
  // that is already full, and the action would refuse every one of them.
  const remaining = MAX_TEMPLATES_PER_CATEGORY - totalCount;
  const full = remaining <= 0;

  async function handleFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.target.files ?? []);
    if (chosen.length === 0) return;

    setProblems([]);
    const failures: string[] = [];
    // Only as many as the vertical can still hold; the action enforces the same
    // cap, but stopping here avoids a run of guaranteed failures.
    const queue = chosen.slice(0, Math.max(0, remaining));

    if (chosen.length > queue.length) {
      failures.push(
        `Only ${queue.length} of ${chosen.length} uploaded — ${categoryName} holds at most ${MAX_TEMPLATES_PER_CATEGORY}.`,
      );
    }

    for (const [index, file] of queue.entries()) {
      // "and reading": each call also reads the template's elements, which is
      // most of its ten seconds to a minute. Without saying so the button looks
      // stuck.
      setProgress(`Uploading and reading ${index + 1} of ${queue.length} — ${file.name}…`);
      const body = new FormData();
      body.set('template', file);
      const result = await upload.run(categoryId, body);
      if (!result.ok) failures.push(`${file.name}: ${result.error}`);
    }

    setProgress(null);
    setProblems(failures);
    if (fileRef.current) fileRef.current.value = '';
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={fileRef}
          id="vertical-templates"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          onChange={handleFiles}
          disabled={upload.pending || full}
          className="hidden"
        />
        <Button type="button" onClick={() => fileRef.current?.click()} disabled={upload.pending || full}>
          {upload.pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          Upload templates
        </Button>

        <span className="font-mono text-[11px] text-muted-foreground">
          {totalCount} / {MAX_TEMPLATES_PER_CATEGORY}
        </span>

        {progress && <span className="text-[11px] text-muted-foreground">{progress}</span>}
      </div>

      <p className="text-[11px] text-muted-foreground/70">
        PNG, JPEG or WebP · up to 6 MB each · select several at once. Each one is read for its words,
        photo and business details as it uploads, which takes up to a minute per template.
      </p>

      {full && (
        <p className="text-[11px] text-warning-ink">
          {categoryName} is at the {MAX_TEMPLATES_PER_CATEGORY}-template limit. Delete one to add another.
        </p>
      )}

      {problems.length > 0 && (
        <ul role="alert" className="space-y-1">
          {problems.map((problem) => (
            <li key={problem} className="text-[11px] text-danger-ink">
              {problem}
            </li>
          ))}
        </ul>
      )}

      {templates.length === 0 ? (
        <p className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-10 text-center text-xs text-muted-foreground">
          <ImagePlus className="h-5 w-5 text-muted-foreground/60" />
          No reference templates for {categoryName} yet.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {templates.map((template) => (
            <TemplateCard key={template.id} template={template} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The shape a poster drawn from this template will be delivered at. Named
 * shapes rather than pixels, because the pixel height depends on the client's
 * preset width and this card knows nothing about any client.
 */
function describeShape(width: number, height: number): string {
  // The same shape names the clone uses (2:3, not "1:1.50 portrait").
  const named = cloneSizeFor(width, height)?.aspectLabel;
  if (named === '1:1') return 'Square';
  if (named) return named;
  const aspect = width / height;
  return aspect > 1 ? `${aspect.toFixed(2)}:1 landscape` : `1:${(1 / aspect).toFixed(2)} portrait`;
}

function TemplateCard({ template }: { template: VerticalTemplateRow }) {
  const router = useRouter();
  const remove = useAction(deleteVerticalTemplate);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  // Click twice to delete. A dialog for a thumbnail an admin can re-upload in
  // seconds is heavier than the risk.
  React.useEffect(() => {
    if (!confirmDelete) return undefined;
    const timer = setTimeout(() => setConfirmDelete(false), 4_000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  return (
    <article className="flex flex-col overflow-hidden rounded-lg border border-border bg-background">
      <a
        href={template.viewUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="relative flex aspect-[4/5] items-center justify-center overflow-hidden bg-muted"
        aria-label={`Open ${template.label} full size`}
      >
        {/* A plain img: next/image would want to optimise a route that already
            returns a sized WebP, and it cannot help with a response that is
            private to this admin's session anyway. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={template.thumbnailUrl}
          alt={template.label}
          loading="lazy"
          decoding="async"
          className={`h-full w-full object-cover transition-opacity ${template.isActive ? '' : 'opacity-50'}`}
        />
        {!template.isActive && (
          <Badge variant="amber" className="absolute left-2 top-2 bg-background/90">
            Inactive
          </Badge>
        )}
      </a>

      <div className="flex flex-1 flex-col gap-3 p-3">
        <div className="flex items-start gap-2">
          <TemplateName template={template} />
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 shrink-0"
            onClick={async () => {
              if (!confirmDelete) {
                setConfirmDelete(true);
                return;
              }
              if ((await remove.run(template.id)).ok) router.refresh();
            }}
            disabled={remove.pending}
            aria-label={confirmDelete ? `Confirm delete ${template.label}` : `Delete ${template.label}`}
            title={confirmDelete ? 'Click again to delete' : 'Delete template'}
          >
            {remove.pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className={`h-4 w-4 ${confirmDelete ? 'text-danger-ink' : ''}`} />
            )}
          </Button>
        </div>

        {confirmDelete && !remove.pending && (
          <p className="-mt-2 text-[10px] text-warning-ink">Click the bin again to delete.</p>
        )}
        {remove.error && (
          <p role="alert" className="-mt-2 text-[10px] text-danger-ink">
            {remove.error}
          </p>
        )}

        <TemplateElementsLine template={template} />

        <TemplateStatus template={template} />
      </div>
    </article>
  );
}

function TemplateName({ template }: { template: VerticalTemplateRow }) {
  const router = useRouter();
  const rename = useAction(renameVerticalTemplate);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(template.label);

  React.useEffect(() => {
    setDraft(template.label);
  }, [template.label]);

  async function commit() {
    if (draft.trim() === template.label) {
      setEditing(false);
      return;
    }
    const result = await rename.run(template.id, draft);
    if (result.ok) {
      setEditing(false);
      router.refresh();
    }
  }

  return (
    <div className="min-w-0 flex-1 space-y-0.5">
      {editing ? (
        <input
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void commit();
            if (event.key === 'Escape') {
              setDraft(template.label);
              setEditing(false);
            }
          }}
          disabled={rename.pending}
          aria-label={`Name for ${template.label}`}
          className="w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="group flex w-full min-w-0 items-center gap-1.5 rounded text-left"
          title="Rename"
        >
          <span className="truncate text-sm font-medium text-foreground">{template.label}</span>
          <Pencil className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
      )}
      <p className="font-mono text-[10px] text-muted-foreground">
        {template.width && template.height
          ? `${describeShape(template.width, template.height)} · ${template.width}×${template.height}`
          : 'Size unknown'}
      </p>
      {rename.error && (
        <p role="alert" className="text-[10px] text-danger-ink">
          {rename.error}
        </p>
      )}
    </div>
  );
}

/**
 * The template's elements in one line: what the reading found, with "View" for
 * the full list over the image; or "Not read yet" / the failure, with a button to
 * read it now.
 *
 * The card owns the read rather than the dialog, so a read started from the
 * dialog keeps its pending state and error when the dialog is closed. The page is
 * refreshed after every read, failed ones included: a failure is stored too, and
 * the card should settle on the stored state rather than on this call's result.
 */
function TemplateElementsLine({ template }: { template: VerticalTemplateRow }) {
  const router = useRouter();
  const read = useAction(readTemplateElementsAction);
  const [open, setOpen] = React.useState(false);
  const state = template.elements;

  async function runRead(): Promise<void> {
    await read.run(template.id);
    router.refresh();
  }

  const storedError =
    state.status === 'failed' ? state.error : state.status === 'read' ? state.lastError : null;
  // This call's own error, shown only until the refreshed page carries the same
  // text — or for good, when it was never stored (a dropped connection, a
  // template deleted mid-read).
  const liveError = read.error && read.error !== storedError ? read.error : null;

  return (
    <div className="-mt-1 space-y-1">
      {read.pending ? (
        <p role="status" className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
          Reading elements… up to a minute
        </p>
      ) : state.status === 'read' ? (
        <div className="flex items-start justify-between gap-2">
          <p className="line-clamp-2 min-w-0 text-[11px] leading-snug text-muted-foreground" title={state.summary}>
            {state.summary}
          </p>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="shrink-0 rounded text-[11px] font-medium text-brand-to underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`View the elements of ${template.label}`}
          >
            View
          </button>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-2">
          {state.status === 'failed' ? (
            <p className="line-clamp-2 min-w-0 text-[11px] leading-snug text-warning-ink" title={state.error}>
              {state.error}
            </p>
          ) : (
            <p className="min-w-0 text-[11px] leading-snug text-muted-foreground">Not read yet</p>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-6 shrink-0 px-2 text-[11px]"
            onClick={() => void runRead()}
          >
            {state.status === 'failed' ? 'Try again' : 'Read now'}
          </Button>
        </div>
      )}

      {state.status === 'read' && state.lastError && !read.pending && (
        <p className="line-clamp-2 text-[10px] leading-snug text-warning-ink" title={state.lastError}>
          Re-read failed, previous reading kept: {state.lastError}
        </p>
      )}
      {liveError && !read.pending && !open && (
        <p role="alert" className="text-[10px] text-danger-ink">
          {liveError}
        </p>
      )}

      {state.status === 'read' && (
        <TemplateElementsDialog
          open={open}
          onOpenChange={setOpen}
          label={template.label}
          imageUrl={template.viewUrl}
          doc={state.doc}
          readAt={state.readAt}
          lastError={state.lastError}
          campaignDays={template.campaignDays}
          rereading={read.pending}
          rereadError={liveError}
          onReread={runRead}
        />
      )}
    </div>
  );
}

/**
 * Active or inactive, and how many campaign days use it.
 *
 * Deactivating retires a template without deleting it: campaign days already
 * mapped to it keep it and are flagged "Template inactive — action required" on
 * their calendar, so nothing is replaced behind anyone's back.
 */
function TemplateStatus({ template }: { template: VerticalTemplateRow }) {
  const router = useRouter();
  const active = useAction(setTemplateActiveAction);
  const [confirmDeactivate, setConfirmDeactivate] = React.useState(false);

  React.useEffect(() => {
    if (!confirmDeactivate) return undefined;
    const timer = setTimeout(() => setConfirmDeactivate(false), 6_000);
    return () => clearTimeout(timer);
  }, [confirmDeactivate]);

  const usage =
    template.campaignDays > 0
      ? `Used on ${template.campaignDays} campaign day${template.campaignDays === 1 ? '' : 's'}`
      : 'Not used by any campaign yet';

  return (
    <div className="mt-auto space-y-1.5 border-t border-border/60 pt-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">{usage}</span>
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 px-2.5 text-[11px]"
          disabled={active.pending}
          onClick={async () => {
            if (template.isActive && template.campaignDays > 0 && !confirmDeactivate) {
              setConfirmDeactivate(true);
              return;
            }
            setConfirmDeactivate(false);
            if ((await active.run(template.id, !template.isActive)).ok) router.refresh();
          }}
        >
          {active.pending && <Loader2 className="h-3 w-3 animate-spin" />}
          {template.isActive ? (confirmDeactivate ? 'Deactivate anyway' : 'Deactivate') : 'Activate'}
        </Button>
      </div>

      {confirmDeactivate && (
        <p className="text-[10px] text-warning-ink">
          Those days keep this template and are flagged for a replacement. Nothing changes automatically.
        </p>
      )}
      {active.error && (
        <p role="alert" className="text-[10px] text-danger-ink">
          {active.error}
        </p>
      )}
    </div>
  );
}
