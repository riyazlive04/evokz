'use client';

import * as React from 'react';

import { ImagePlus, Loader2, Trash2, Upload } from 'lucide-react';

import {
  deleteVerticalTemplate,
  uploadVerticalTemplate,
} from '@/app/admin/dashboard/actions';
import { Button } from '@/components/ui/button';
import { useAction } from '@/hooks/use-action';

/**
 * Reference-poster library for one vertical.
 *
 * These are stored, not interpreted: no part of the render pipeline reads them
 * yet. They are the source material for the layout work that follows, so the
 * panel's whole job is to make a set of posters easy to collect, look at and
 * throw away again.
 *
 * Uploads run one file per action call rather than one call carrying the whole
 * selection. Server Actions have a body limit, a batch of full-size posters
 * would breach it, and sequencing gives a per-file error — "poster-3.png is
 * 9 MB" — instead of one failure for the batch with nothing to act on.
 */

export interface VerticalTemplateRow {
  id: string;
  label: string;
  thumbnailUrl: string;
  viewUrl: string;
  width: number | null;
  height: number | null;
}

const MAX_TEMPLATES = 20;

export function VerticalTemplatePanel({
  categoryId,
  categoryName,
  templates,
}: {
  categoryId: string;
  categoryName: string;
  templates: VerticalTemplateRow[];
}) {
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [progress, setProgress] = React.useState<string | null>(null);
  const [problems, setProblems] = React.useState<string[]>([]);

  const upload = useAction(uploadVerticalTemplate);

  const remaining = MAX_TEMPLATES - templates.length;
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
        `Only ${queue.length} of ${chosen.length} uploaded — ${categoryName} holds at most ${MAX_TEMPLATES}.`,
      );
    }

    for (const [index, file] of queue.entries()) {
      setProgress(`Uploading ${index + 1} of ${queue.length} — ${file.name}`);
      const body = new FormData();
      body.set('template', file);
      const result = await upload.run(categoryId, body);
      if (!result.ok) failures.push(`${file.name}: ${result.error}`);
    }

    setProgress(null);
    setProblems(failures);
    if (fileRef.current) fileRef.current.value = '';
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
        <Button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={upload.pending || full}
        >
          {upload.pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
          Upload templates
        </Button>

        <span className="font-mono text-[11px] text-muted-foreground">
          {templates.length} / {MAX_TEMPLATES}
        </span>

        {progress && (
          <span className="text-[11px] text-muted-foreground">{progress}</span>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground/70">
        PNG, JPEG or WebP · up to 6 MB each · select several at once. Stored in this
        vertical&apos;s Drive folder.
      </p>

      {full && (
        <p className="text-[11px] text-warning-ink">
          {categoryName} is at the {MAX_TEMPLATES}-template limit. Delete one to add
          another.
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

function TemplateCard({ template }: { template: VerticalTemplateRow }) {
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const remove = useAction(deleteVerticalTemplate);

  // Click twice to delete, matching the vertical list itself. A dialog for a
  // thumbnail an operator can re-upload in seconds is heavier than the risk.
  React.useEffect(() => {
    if (!confirmDelete) return undefined;
    const timer = setTimeout(() => setConfirmDelete(false), 4_000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  return (
    <article className="overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex aspect-[3/4] items-center justify-center overflow-hidden bg-muted">
        {/* Arbitrary remote host, and the route is uncached by design — a plain
            img avoids allowlisting Drive in next.config. `no-referrer` is load
            bearing: Google's content host rejects a request carrying a localhost
            referrer and the thumbnail silently fails in dev. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={template.thumbnailUrl}
          alt={template.label}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
        />
      </div>

      <div className="flex items-center gap-2 px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-foreground">{template.label}</span>
          <span className="block font-mono text-[10px] text-muted-foreground">
            {template.width && template.height
              ? `${template.width}×${template.height}`
              : 'size unknown'}
          </span>
        </span>

        <Button
          size="icon"
          variant="ghost"
          onClick={() =>
            confirmDelete ? void remove.run(template.id) : setConfirmDelete(true)
          }
          disabled={remove.pending}
          aria-label={
            confirmDelete ? `Confirm delete ${template.label}` : `Delete ${template.label}`
          }
        >
          {remove.pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Trash2
              className={`h-4 w-4 ${confirmDelete ? 'text-danger-ink' : ''}`}
            />
          )}
        </Button>
      </div>

      {confirmDelete && !remove.pending && (
        <p className="px-3 pb-2 text-[10px] text-warning-ink">Click again to delete.</p>
      )}

      {remove.error && (
        <p role="alert" className="px-3 pb-2 text-[10px] text-danger-ink">
          {remove.error}
        </p>
      )}
    </article>
  );
}
