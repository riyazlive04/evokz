'use client';

import * as React from 'react';

import { ExternalLink, ImagePlus, Loader2, Trash2, Upload } from 'lucide-react';

import {
  deleteVerticalTemplate,
  setTemplateArchetype,
  uploadVerticalTemplate,
} from '@/app/admin/dashboard/actions';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAction } from '@/hooks/use-action';
import { MAX_TEMPLATES_PER_CATEGORY } from '@/lib/template-limits';
import { ARCHETYPE_CATALOGUE, POSTER_ARCHETYPES } from '@/lib/types/poster';

/**
 * Reference-poster library for one vertical, and the layout each one represents.
 *
 * The mapping is the point. An uploaded image on its own tells the renderer
 * nothing — satori composes from code and cannot replay a raster. What it can do
 * is use the layout an operator says a reference represents, which is what the
 * picker on each card records. Generation then draws that vertical's layouts from
 * this set, duplicates and all, so uploading eight diagonal references and two
 * curved ones produces campaigns in roughly that mix.
 *
 * Mapping happens here rather than during upload: a bulk selection gives no
 * opportunity to say which file is which, and the choice needs the image in front
 * of you.
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
  /** The layout this reference represents, or null while unmapped. */
  archetype: string | null;
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
          {totalCount} / {MAX_TEMPLATES_PER_CATEGORY}
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
          {categoryName} is at the {MAX_TEMPLATES_PER_CATEGORY}-template limit. Delete one to add
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

/** Sentinel for the "not mapped" option — Radix Select rejects an empty value. */
const UNMAPPED = '__unmapped__';

function TemplateCard({ template }: { template: VerticalTemplateRow }) {
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const remove = useAction(deleteVerticalTemplate);
  const map = useAction(setTemplateArchetype);
  // Held locally so the select reflects the choice immediately; the server
  // revalidation that follows confirms it a moment later.
  const [archetype, setArchetype] = React.useState(template.archetype);

  async function handleArchetype(next: string) {
    const value = next === UNMAPPED ? null : next;
    const previous = archetype;
    setArchetype(value);
    const result = await map.run(template.id, value);
    if (!result.ok) setArchetype(previous);
  }

  // Click twice to delete, matching the vertical list itself. A dialog for a
  // thumbnail an operator can re-upload in seconds is heavier than the risk.
  React.useEffect(() => {
    if (!confirmDelete) return undefined;
    const timer = setTimeout(() => setConfirmDelete(false), 4_000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  return (
    <article className="overflow-hidden rounded-lg border border-border bg-background">
      <a
        href={template.viewUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="flex aspect-[3/4] items-center justify-center overflow-hidden bg-muted"
        aria-label={`Open ${template.label} full size`}
      >
        {/* A plain img: next/image would want to optimise a route that already
            returns a sized WebP, and it cannot help with a response that is
            private to this operator's session anyway. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={template.thumbnailUrl}
          alt={template.label}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      </a>

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

      <div className="space-y-1.5 border-t border-border px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Layout
          </span>
          {map.pending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>

        <Select value={archetype ?? UNMAPPED} onValueChange={handleArchetype}>
          <SelectTrigger className="h-8 text-xs" aria-label={`Layout for ${template.label}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-80">
            <SelectItem value={UNMAPPED}>Not mapped — excluded</SelectItem>
            {POSTER_ARCHETYPES.map((id) => (
              <SelectItem key={id} value={id}>
                {ARCHETYPE_CATALOGUE[id].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {archetype ? (
          <a
            href={`/admin/poster-preview?archetype=${encodeURIComponent(archetype)}`}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
            See this layout rendered
          </a>
        ) : (
          <p className="text-[10px] text-muted-foreground/70">
            Unmapped templates are stored but never used for generation.
          </p>
        )}

        {map.error && (
          <p role="alert" className="text-[10px] text-danger-ink">
            {map.error}
          </p>
        )}
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
