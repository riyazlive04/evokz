'use client';

import * as React from 'react';

import { ImageOff, Loader2 } from 'lucide-react';

import type { EditorDraft, EditorField } from '@/lib/campaign/clone-editor-view';
import { placeLogoInBox, toPixelBox } from '@/lib/poster-studio/logo-placement';
import type { DayLogoPlacement, ElementBox } from '@/lib/types/template-elements';
import { cn } from '@/lib/utils';

export type PreviewTab = 'poster' | 'template';

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(3)}%`;
}

/** What the logo-placement preview needs to draw the mark where it will land. */
export interface LogoPreview {
  /**
   * The active version's artwork **before** any logo was composited on it. Never
   * the finished poster: that already has a mark burned in, and drawing over it
   * would show two.
   */
  rawImageUrl: string;
  /** The client's mark with its padding trimmed off — the bytes the compositor fits. */
  logoUrl: string;
  /** Every logo box of the template, normalised. */
  boxes: ElementBox[];
  /** The placement being tried, or null for the template's own position (which code decides). */
  placement: DayLogoPlacement | null;
}

/**
 * The preview: the poster, or the template with its element boxes — a segmented
 * Poster | Template switch, and both side by side on very wide screens.
 *
 * The frame takes the template's own shape and its width is capped by the
 * viewport height (`--frame-h`, set by the editor per breakpoint), so a tall
 * poster is always seen whole. The template view
 * draws every element's box as `TemplateElementsDialog` does (photographs first,
 * so the text boxes on them stay visible), faintly, and the box of the field
 * being edited strongly — that is how an admin finds "Feature 2" on the design.
 * A removed element's box is dashed.
 */
export function PosterPreview({
  tab,
  onTabChange,
  aspect,
  poster,
  template,
  fields,
  draft,
  focusedId,
  generating,
  logoPreview = null,
}: {
  tab: PreviewTab;
  onTabChange: (tab: PreviewTab) => void;
  /** Template width / height. */
  aspect: { width: number; height: number };
  /** The poster on show (the active version, or an older one being viewed). */
  poster: { imageUrl: string | null; label: string; fullImageUrl: string | null; note: string | null } | null;
  template: { imageUrl: string; label: string };
  fields: EditorField[];
  draft: EditorDraft;
  focusedId: string | null;
  /** A poster is being made: the frame says so over whatever it shows. `label` is announced once; `timer` ticks outside the live region. */
  generating: { label: string; timer: string | null } | null;
  /** The logo placement controls are open: the poster frame shows where the mark would land instead of the finished poster. */
  logoPreview?: LogoPreview | null;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div role="tablist" aria-label="Preview" className="inline-grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/60 p-1 text-xs 2xl:hidden">
          {(['poster', 'template'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={tab === option}
              onClick={() => onTabChange(option)}
              className={cn(
                'rounded-md px-3 py-1 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                tab === option ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {option === 'poster' ? 'Poster' : 'Template'}
            </button>
          ))}
        </div>
        {poster?.fullImageUrl && (
          <a className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground" href={poster.fullImageUrl} target="_blank" rel="noreferrer">
            Open full size
          </a>
        )}
      </div>

      <div className="grid gap-3 2xl:grid-cols-2">
        <Frame aspect={aspect} className={cn(tab !== 'poster' && 'hidden 2xl:block')} caption="Poster">
          {logoPreview ? (
            <LogoPlacementPreview preview={logoPreview} />
          ) : poster?.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- the session-gated studio image route serves a sized image; next/image cannot
            <img key={poster.imageUrl} src={poster.imageUrl} alt={poster.label} decoding="async" className="absolute inset-0 h-full w-full object-contain" />
          ) : (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- session-gated template proxy */}
              <img src={template.imageUrl} alt="" decoding="async" className="absolute inset-0 h-full w-full object-fill opacity-25 grayscale" />
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6 text-center">
                <ImageOff className="h-5 w-5 text-muted-foreground" aria-hidden />
                <p className="text-sm font-medium text-foreground">{poster ? 'No preview for this version' : 'Not generated yet'}</p>
                {!poster && <p className="text-[11px] text-muted-foreground">Check the words, then press Generate poster.</p>}
              </div>
            </>
          )}
          {/* Still shown over the logo preview: while a poster is being made there is nothing to place yet. */}
          {generating && <GeneratingVeil label={generating.label} timer={generating.timer} />}
          {poster?.note && !logoPreview && (
            <p className="absolute inset-x-0 bottom-0 bg-background/85 px-2 py-1 text-center text-[11px] text-foreground backdrop-blur-sm">{poster.note}</p>
          )}
        </Frame>

        <Frame aspect={aspect} className={cn(tab !== 'template' && 'hidden 2xl:block')} caption="Template">
          {/* eslint-disable-next-line @next/next/no-img-element -- session-gated template proxy */}
          <img src={template.imageUrl} alt={`${template.label}, with its elements outlined`} decoding="async" className="absolute inset-0 h-full w-full object-fill" />
          {[...fields.filter((field) => field.category === 'photo'), ...fields.filter((field) => field.category !== 'photo')].map((field) => {
            const active = field.id === focusedId;
            const removed = draft[field.id]?.removed ?? false;
            return (
              <div
                key={field.id}
                aria-hidden
                title={field.label}
                className={cn(
                  'pointer-events-none absolute rounded-[2px] transition-opacity',
                  active ? 'z-10 border-2 border-primary bg-primary/15' : removed ? 'border border-dashed border-danger/70' : 'border border-navy-500/50',
                  focusedId !== null && !active && 'opacity-30',
                )}
                style={{ left: percent(field.box.x), top: percent(field.box.y), width: percent(field.box.w), height: percent(field.box.h) }}
              >
                {active && (
                  <span className="absolute left-0 top-0 whitespace-nowrap rounded-br-[2px] bg-primary px-1 text-[9px] font-semibold leading-[13px] text-primary-foreground">
                    {field.label}
                  </span>
                )}
              </div>
            );
          })}
        </Frame>
      </div>
    </div>
  );
}

/**
 * Where the client's mark will land, drawn over the poster's **raw** artwork.
 *
 * The geometry is not estimated: `toPixelBox` and `placeLogoInBox` are the same
 * two functions the compositor runs, given the same two inputs — the raw image's
 * own pixel frame, and the mark's trimmed proportions, both read from the images
 * as they load. Percentages of the frame then scale that answer to whatever size
 * the preview is drawn at, so it cannot drift from the render.
 *
 * With no placement (the template's own position) nothing is drawn over the
 * artwork: the compositor measures the box and corrects it itself, and a
 * pretended answer here would be a lie about where the mark goes.
 */
function LogoPlacementPreview({ preview }: { preview: LogoPreview }) {
  const [frame, setFrame] = React.useState<{ width: number; height: number } | null>(null);
  const [mark, setMark] = React.useState<{ width: number; height: number } | null>(null);
  const ready = frame !== null && mark !== null && preview.placement !== null;

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- the session-gated studio image route serves a sized image; next/image cannot */}
      <img
        key={preview.rawImageUrl}
        src={preview.rawImageUrl}
        alt="This poster’s artwork without the logo"
        decoding="async"
        onLoad={(event) => setFrame({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        className="absolute inset-0 h-full w-full object-contain"
      />
      {/* Loaded whatever happens: its natural size is the mark's trimmed shape, which the placement needs. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- the session-gated logo route; next/image cannot fetch it */}
      <img
        key={preview.logoUrl}
        src={preview.logoUrl}
        alt=""
        aria-hidden
        decoding="async"
        onLoad={(event) => setMark({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        style={ready ? undefined : { visibility: 'hidden' }}
        className="absolute left-0 top-0 h-px w-px"
      />
      {ready &&
        preview.boxes.map((box, index) => {
          const placed = placeLogoInBox(toPixelBox(box, frame!.width, frame!.height), mark!, preview.placement);
          if (placed.width < 1 || placed.height < 1) return null;
          return (
            // eslint-disable-next-line @next/next/no-img-element -- the session-gated logo route; next/image cannot fetch it
            <img
              key={`${index}-${preview.logoUrl}`}
              src={preview.logoUrl}
              alt=""
              aria-hidden
              decoding="async"
              className="absolute object-contain"
              style={{
                left: percent(placed.left / frame!.width),
                top: percent(placed.top / frame!.height),
                width: percent(placed.width / frame!.width),
                height: percent(placed.height / frame!.height),
              }}
            />
          );
        })}
      <p className="absolute inset-x-0 bottom-0 bg-background/85 px-2 py-1 text-center text-[11px] text-foreground backdrop-blur-sm">
        {preview.placement === null
          ? 'Preview — the template’s own position, measured by code when the poster is made'
          : 'Preview — the logo is placed by code, no AI'}
      </p>
    </>
  );
}

function Frame({ aspect, className, caption, children }: { aspect: { width: number; height: number }; className?: string; caption: string; children: React.ReactNode }) {
  const ratio = aspect.width / aspect.height;
  return (
    <figure className={cn('m-0', className)}>
      <div
        className="relative mx-auto overflow-hidden rounded-lg border border-border bg-muted"
        style={{ aspectRatio: `${aspect.width} / ${aspect.height}`, width: `min(100%, calc(var(--frame-h, 64dvh) * ${ratio.toFixed(4)}))` }}
      >
        {children}
      </div>
      <figcaption className="mt-1 hidden text-center text-[10px] uppercase tracking-widest text-muted-foreground 2xl:block">{caption}</figcaption>
    </figure>
  );
}

function GeneratingVeil({ label, timer }: { label: string; timer: string | null }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/70 px-6 text-center backdrop-blur-[2px]">
      <Loader2 className="h-6 w-6 animate-spin text-foreground" aria-hidden />
      {/* Only the stable message is live: a region whose text changes every second would be read out every second. */}
      <p role="status" className="text-sm font-medium text-foreground">
        {label}
      </p>
      {timer && <p className="font-mono text-[12px] tabular-nums text-foreground">{timer}</p>}
      <p className="text-[11px] text-muted-foreground">It keeps going if you leave this page.</p>
    </div>
  );
}
