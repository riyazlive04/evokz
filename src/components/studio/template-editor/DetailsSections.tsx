'use client';

import * as React from 'react';

import { ChevronRight, ExternalLink, Eye, EyeOff } from 'lucide-react';

import { EditorSection, FIELD_BUTTON_CLASS, FIELD_TEXTAREA_CLASS } from '@/components/studio/template-editor/editor-ui';
import type { FieldHandlers } from '@/components/studio/template-editor/WordsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MAX_EDITOR_IMAGE_PROMPT, normalizeFieldText, type EditorDraft, type EditorField } from '@/lib/campaign/clone-editor-view';
import type { TemplateEditorScreen } from '@/lib/campaign/clone-editor-screen';
import { MAX_ELEMENT_TEXT, type BrandField } from '@/lib/types/template-elements';
import { cn } from '@/lib/utils';

const BRAND_FIELD_LABELS: Record<BrandField, string> = {
  companyName: 'Business name',
  tagline: 'Tagline',
  phone: 'Phone',
  website: 'Website',
  logo: 'Logo',
};

/**
 * Brand details: every element this template prints from Brand Canvas — its own
 * business name, tagline, phone, website and logo, and a person name or
 * credential the template binds to the business name or tagline when it has
 * none of its own. Read-only here: the value shown is exactly what the poster
 * gets, "Not set in Brand Canvas — hidden" when there is none, and each can be
 * hidden on this poster. One link edits Brand Canvas and comes back.
 */
export function BrandDetailsSection({
  fields,
  draft,
  brand,
  brandCanvasHref,
  disabled,
  linkPausedReason = null,
  handlers,
  onNavigate,
}: {
  fields: EditorField[];
  draft: EditorDraft;
  brand: TemplateEditorScreen['brand'];
  brandCanvasHref: string;
  disabled: boolean;
  /** Leaving the editor is paused (this tab's long action runs): the link says why instead of navigating. */
  linkPausedReason?: string | null;
  handlers: FieldHandlers;
  onNavigate: (href: string) => void;
}) {
  if (fields.length === 0) return null;
  return (
    <EditorSection
      id="editor-brand"
      title="Brand details"
      action={
        <a
          href={brandCanvasHref}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
            event.preventDefault();
            if (linkPausedReason) return;
            onNavigate(brandCanvasHref);
          }}
          aria-disabled={linkPausedReason ? true : undefined}
          title={linkPausedReason ?? undefined}
          className={cn(
            'inline-flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2',
            linkPausedReason ? 'cursor-not-allowed opacity-60' : 'hover:text-foreground hover:underline',
          )}
        >
          Edit in Brand Canvas
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      }
    >
      <ul className="divide-y divide-border/60 overflow-hidden rounded-md border border-border">
        {fields.map((field) => {
          const binding = field.binding ?? 'companyName';
          const value = binding === 'logo' ? (brand.hasLogo ? brand.logoUrl : null) : (brand[binding] ?? null);
          const removed = draft[field.id]?.removed ?? false;
          const missing = !value;
          // A person name or credential printing the business name or tagline (`templateBindings`' fallbacks).
          const fallback = field.kind === 'personName' || field.kind === 'credential';
          return (
            <li key={field.id} className={cn('flex items-center gap-2.5 px-2.5 py-1.5', removed && 'bg-muted/40')}>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] text-muted-foreground">
                  {field.label}
                  {fallback && <span className="text-muted-foreground/70"> · shows {BRAND_FIELD_LABELS[binding].toLowerCase()}</span>}
                </p>
                {missing ? (
                  <p className="text-[12px] italic text-muted-foreground">Not set in Brand Canvas — hidden</p>
                ) : binding === 'logo' ? (
                  // eslint-disable-next-line @next/next/no-img-element -- the session-gated logo route; next/image cannot fetch it
                  <img src={value} alt="Brand Canvas logo" className={cn('mt-0.5 h-8 max-w-[8rem] rounded border border-border bg-muted object-contain p-0.5', removed && 'opacity-40')} />
                ) : (
                  <p className={cn('truncate text-[12px] text-foreground', removed && 'text-muted-foreground line-through')} title={value}>
                    {value}
                  </p>
                )}
              </div>
              {!missing && (
                <Button
                  size="sm"
                  variant="ghost"
                  className={FIELD_BUTTON_CLASS}
                  disabled={disabled}
                  aria-pressed={!removed}
                  aria-label={`${removed ? 'Show' : 'Hide'} ${field.label} on this poster`}
                  onClick={() => {
                    handlers.onChange(field.id, { removed: !removed });
                    handlers.onBlur(field.id);
                  }}
                >
                  {removed ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                  {removed ? 'Hidden' : 'Shown'}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </EditorSection>
  );
}

/**
 * Details the template printed for its own business that Brand Canvas has no
 * field for — an address, an email, a doctor's registration. Hidden on the
 * client's poster by default and collapsed; typing a value shows it, clearing it
 * hides it again.
 */
export function HiddenDetailsSection({
  fields,
  draft,
  focusedId,
  disabled,
  handlers,
}: {
  fields: EditorField[];
  draft: EditorDraft;
  focusedId: string | null;
  disabled: boolean;
  handlers: FieldHandlers;
}) {
  const shown = fields.filter((field) => {
    const value = draft[field.id];
    return value && !value.removed && normalizeFieldText(value.text) !== null;
  }).length;
  // Open to start with when something is already shown; after that the admin decides.
  const [open, setOpen] = React.useState(shown > 0);
  if (fields.length === 0) return null;

  return (
    <details className="group border-b border-border pb-4" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden />
        Other details from the template
        <span className="font-mono font-normal normal-case tracking-normal text-muted-foreground/70">
          {shown > 0 ? `${shown} shown, ${fields.length - shown} hidden` : `${fields.length} hidden`}
        </span>
      </summary>
      <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
        These belonged to the template&apos;s business and are left off this poster. Type a value to show one.
      </p>
      <div className="mt-2 space-y-2.5">
        {fields.map((field) => {
          const value = draft[field.id] ?? { text: '', removed: true };
          const inputId = `editor-hidden-${field.id}`;
          const visible = !value.removed && normalizeFieldText(value.text) !== null;
          return (
            <div key={field.id} className={cn('-mx-1 space-y-1 rounded-md px-1 py-0.5', focusedId === field.id && 'bg-muted/60')}>
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={inputId} className="text-[12px] font-medium text-foreground">
                  {field.label}
                </label>
                <span className={cn('text-[10px]', visible ? 'text-success-ink' : 'text-muted-foreground')}>{visible ? 'Shown' : 'Hidden'}</span>
              </div>
              <Input
                id={inputId}
                value={value.text}
                disabled={disabled}
                maxLength={MAX_ELEMENT_TEXT}
                placeholder="Leave empty to keep it hidden"
                onFocus={() => handlers.onFocus(field.id)}
                onBlur={() => handlers.onBlur(field.id)}
                onChange={(event) => handlers.onChange(field.id, { text: event.target.value, removed: normalizeFieldText(event.target.value) === null })}
              />
              {field.templateText && <p className="break-words text-[10px] text-muted-foreground/80">Template had: “{field.templateText}”</p>}
            </div>
          );
        })}
      </div>
    </details>
  );
}

/**
 * The photo: one description, empty by default — the image model then picks a
 * new photograph suited to the headline. The template photo's own description is
 * shown as a hint.
 */
export function PhotoSection({
  photos,
  prompt,
  disabled,
  onChange,
  onBlur,
  onFocus,
}: {
  photos: EditorField[];
  prompt: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onBlur: () => void;
  onFocus: () => void;
}) {
  if (photos.length === 0) return null;
  const main = photos.reduce((largest, photo) => (photo.box.w * photo.box.h > largest.box.w * largest.box.h ? photo : largest), photos[0]!);
  return (
    <EditorSection id="editor-photo" title="Photo">
      <label htmlFor="editor-image-prompt" className="sr-only">
        Photo description
      </label>
      <textarea
        id="editor-image-prompt"
        value={prompt}
        rows={3}
        disabled={disabled}
        maxLength={MAX_EDITOR_IMAGE_PROMPT}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        onFocus={onFocus}
        placeholder="Describe the photo you want, or leave empty and AI picks a new photo that suits the headline."
        aria-describedby="editor-image-prompt-hint"
        className={FIELD_TEXTAREA_CLASS}
      />
      <p id="editor-image-prompt-hint" className="text-[10px] leading-snug text-muted-foreground/80">
        {main.description ? `Template photo: ${main.description}.` : 'The template’s photo is always replaced with a new one.'}
        {photos.length > 1 ? ` The template has ${photos.length} photos; this describes the largest, and the others get suitable new photos.` : ''}
      </p>
    </EditorSection>
  );
}

/** One line: the brand accent colours a clone recolours to, or the template's own. */
export function ColoursLine({ colourMode, colors }: { colourMode: 'brand' | 'template'; colors: Array<{ hex: string; role: string }> }) {
  return (
    <EditorSection id="editor-colours" title="Colours">
      {colourMode === 'brand' && colors.length > 0 ? (
        <p className="flex flex-wrap items-center gap-2 text-[12px] text-foreground">
          Brand colours
          <span className="flex items-center gap-1">
            {colors.map((color) => (
              <span
                key={`${color.role}-${color.hex}`}
                title={`${color.role} ${color.hex}`}
                aria-label={`${color.role} ${color.hex}`}
                className="h-4 w-4 rounded-full border border-border"
                style={{ backgroundColor: color.hex }}
              />
            ))}
          </span>
        </p>
      ) : (
        <p className="text-[12px] text-muted-foreground">Template colours (no brand colours set)</p>
      )}
    </EditorSection>
  );
}
