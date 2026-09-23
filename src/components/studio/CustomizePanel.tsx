'use client';

import React, { useEffect, useState } from 'react';
import { Building2, ChevronDown, Gauge, Layers, PartyPopper, RefreshCw, SlidersHorizontal, Sparkles, Type } from 'lucide-react';

import { loadStudioBrandCanvasAction } from '@/app/admin/poster-studio/actions';
import type { StudioBrandCanvasSummary } from '@/lib/poster-studio/brand-context';
import { STUDIO_FESTIVALS } from '@/lib/poster-studio/festivals';
import {
  MAX_STUDIO_PROMPT_LENGTH,
  MIN_STUDIO_PROMPT_LENGTH,
  STUDIO_ASPECT_RATIO_KEYS,
  STUDIO_ASPECT_RATIOS,
  STUDIO_OVERLAY_ELEMENTS,
  STUDIO_QUALITIES,
  type StudioAspectRatio,
  type StudioFooterBackground,
  type StudioLogoBackground,
  type StudioOverlayElement,
  type StudioQuality,
} from '@/lib/poster-studio/limits';
import { cn } from '@/lib/utils';

import { BrandCanvasPanel, defaultOverlayElements } from './BrandCanvasPanel';

/**
 * Per-image settings, shown under a generated image: change the format,
 * festival, quality, lettering or branding of that one image and make it again.
 *
 * The panel only collects settings. What "apply" does belongs to the caller —
 * the studio remakes the image straight away; a bulk run re-queues that one row.
 */

export interface CustomizeSettings {
  prompt: string;
  aspectRatio: StudioAspectRatio;
  festival: string | null;
  /** Null: the server's default quality. */
  quality: StudioQuality | null;
  textFree: boolean;
  clientId: string | null;
  overlayElements: StudioOverlayElement[];
  logoBackground: StudioLogoBackground;
  footerBackground: StudioFooterBackground;
}

const QUALITY_LABELS: Record<StudioQuality, string> = {
  low: 'Low (fastest)',
  medium: 'Medium',
  high: 'High (costs most)',
};

/** The settings an existing image was made with, as the panel's starting point. */
export function settingsFromImage(item: {
  prompt: string;
  aspectRatio: string;
  festival: string | null;
  quality: string;
  textFree: boolean;
  clientId: string | null;
  overlayElements: string[];
  logoBackground: StudioLogoBackground | null;
  footerBackground: StudioFooterBackground | 'AUTO' | null;
}): CustomizeSettings {
  return {
    prompt: item.prompt,
    aspectRatio: (STUDIO_ASPECT_RATIO_KEYS as string[]).includes(item.aspectRatio)
      ? (item.aspectRatio as StudioAspectRatio)
      : '9:16',
    festival: item.festival,
    quality: (STUDIO_QUALITIES as readonly string[]).includes(item.quality) ? (item.quality as StudioQuality) : null,
    textFree: item.textFree,
    clientId: item.clientId,
    // The derived company name is drawn by rule, not chosen.
    overlayElements: item.overlayElements.filter((element): element is StudioOverlayElement =>
      (STUDIO_OVERLAY_ELEMENTS as readonly string[]).includes(element),
    ),
    logoBackground: item.logoBackground ?? 'ORIGINAL',
    footerBackground: item.footerBackground ?? 'AUTO',
  };
}

export function FestivalSelect({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-foreground flex items-center gap-1.5">
        <PartyPopper className="w-3.5 h-3.5 text-brand-to" /> Festival (optional)
      </label>
      <select
        id={id}
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
        className="w-full bg-background border border-input rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
      >
        <option value="">No festival</option>
        {STUDIO_FESTIVALS.map((festival) => (
          <option key={festival.key} value={festival.key}>
            {festival.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function QualitySelect({
  id,
  value,
  defaultQuality,
  onChange,
  disabled,
}: {
  id: string;
  value: StudioQuality | null;
  /** The server's configured quality, named in the "Default" option. */
  defaultQuality: string;
  onChange: (value: StudioQuality | null) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-foreground flex items-center gap-1.5">
        <Gauge className="w-3.5 h-3.5 text-brand-to" /> Quality
      </label>
      <select
        id={id}
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange((event.target.value || null) as StudioQuality | null)}
        className="w-full bg-background border border-input rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
      >
        <option value="">Default ({defaultQuality})</option>
        {STUDIO_QUALITIES.map((quality) => (
          <option key={quality} value={quality}>
            {QUALITY_LABELS[quality]}
          </option>
        ))}
      </select>
    </div>
  );
}

export function CustomizePanel({
  id,
  title = 'Customize',
  initial,
  clients,
  defaultQuality,
  disabled,
  applyLabel = 'Regenerate with these settings',
  note,
  lockedAspectRatio,
  lockedClient = false,
  defaultOpen = false,
  brandControls = true,
  onApply,
}: {
  /** Unique per panel on the page: form ids and radio names derive from it. */
  id: string;
  title?: string;
  initial: CustomizeSettings;
  clients: Array<{ id: string; companyName: string }>;
  defaultQuality: string;
  disabled: boolean;
  applyLabel?: string;
  /** One line under the button: what applying will do (and cost). */
  note?: string;
  /** Set when the format cannot change, e.g. a campaign day's own shape. */
  lockedAspectRatio?: StudioAspectRatio;
  /** The client cannot change (a campaign's posters are its client's). */
  lockedClient?: boolean;
  defaultOpen?: boolean;
  /** False hides the client and Brand Canvas choices (a bulk batch sets those once). */
  brandControls?: boolean;
  onApply: (settings: CustomizeSettings) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [settings, setSettings] = useState<CustomizeSettings>(initial);
  const [problem, setProblem] = useState<string | null>(null);

  const [summary, setSummary] = useState<StudioBrandCanvasSummary | null>(null);
  const [brandLoading, setBrandLoading] = useState(false);
  const [brandError, setBrandError] = useState<string | null>(null);

  // A different image starts from its own settings.
  const initialKey = JSON.stringify(initial);
  useEffect(() => {
    setSettings(JSON.parse(initialKey) as CustomizeSettings);
    setProblem(null);
  }, [initialKey]);

  const set = <K extends keyof CustomizeSettings>(key: K, value: CustomizeSettings[K]) =>
    setSettings((previous) => ({ ...previous, [key]: value }));

  // The Brand Canvas is loaded only while the panel is open and a client is set.
  const clientId = settings.clientId;
  const initialClientId = initial.clientId;
  useEffect(() => {
    if (!open || !clientId || !brandControls) {
      setSummary(null);
      setBrandError(null);
      setBrandLoading(false);
      return;
    }
    let cancelled = false;
    setBrandLoading(true);
    setBrandError(null);
    loadStudioBrandCanvasAction(clientId)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setBrandError(result.error);
          return;
        }
        setSummary(result.summary);
        // A newly chosen client starts with everything its Brand Canvas has,
        // as the studio form does; the image's own client keeps its choices.
        if (clientId !== initialClientId) {
          setSettings((previous) => ({ ...previous, overlayElements: defaultOverlayElements(result.summary) }));
        }
      })
      .catch(() => {
        if (!cancelled) setBrandError('The Brand Canvas could not be loaded. Reload the page and try again.');
      })
      .finally(() => {
        if (!cancelled) setBrandLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, clientId, initialClientId, brandControls]);

  const aspectRatio = lockedAspectRatio ?? settings.aspectRatio;

  const apply = () => {
    const prompt = settings.prompt.trim();
    if (prompt.length < MIN_STUDIO_PROMPT_LENGTH) {
      setProblem(`The prompt needs at least ${MIN_STUDIO_PROMPT_LENGTH} characters.`);
      return;
    }
    if (brandControls && settings.clientId && (brandLoading || brandError)) {
      setProblem(brandLoading ? 'The Brand Canvas is still loading.' : 'The Brand Canvas could not be loaded, so the image cannot be branded.');
      return;
    }
    if (
      settings.overlayElements.includes('logo') &&
      settings.logoBackground === 'REMOVED' &&
      summary &&
      !summary.logo.removal.possible
    ) {
      setProblem(summary.logo.removal.message ?? 'The background cannot be removed from this logo.');
      return;
    }
    setProblem(null);
    onApply({
      ...settings,
      prompt,
      aspectRatio,
      overlayElements: settings.clientId ? settings.overlayElements : [],
    });
  };

  return (
    <div className="w-full min-w-0 rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={`${id}-body`}
        className="flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-xs font-semibold text-foreground hover:bg-muted/50 rounded-xl"
      >
        <span className="flex items-center gap-1.5">
          <SlidersHorizontal className="w-3.5 h-3.5 text-brand-to" /> {title}
        </span>
        <ChevronDown className={cn('w-4 h-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div id={`${id}-body`} className="space-y-3.5 border-t border-border px-3.5 pb-3.5 pt-3">
          <div className="space-y-1.5">
            <label htmlFor={`${id}-prompt`} className="text-xs font-medium text-foreground flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-brand-to" /> Prompt
            </label>
            <textarea
              id={`${id}-prompt`}
              value={settings.prompt}
              disabled={disabled}
              maxLength={MAX_STUDIO_PROMPT_LENGTH}
              rows={3}
              onChange={(event) => set('prompt', event.target.value)}
              className="w-full bg-background border border-input rounded-lg p-2.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-y leading-relaxed disabled:opacity-60"
            />
          </div>

          <div className="space-y-1.5">
            <span className="text-xs font-medium text-foreground flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-brand-to" /> Aspect ratio
            </span>
            <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Aspect ratio">
              {STUDIO_ASPECT_RATIO_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={aspectRatio === key}
                  disabled={disabled || (lockedAspectRatio !== undefined && lockedAspectRatio !== key)}
                  onClick={() => set('aspectRatio', key)}
                  className={cn(
                    'rounded-lg border px-2 py-1.5 text-left transition-all disabled:opacity-50',
                    aspectRatio === key
                      ? 'border-primary bg-primary/10 text-foreground font-semibold'
                      : 'border-border bg-background text-muted-foreground hover:border-muted-foreground/30',
                  )}
                >
                  <span className="block text-[11px]">{STUDIO_ASPECT_RATIOS[key].label}</span>
                </button>
              ))}
            </div>
            {lockedAspectRatio && (
              <p className="text-[10px] text-muted-foreground">Fixed to the campaign day&rsquo;s shape.</p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FestivalSelect id={`${id}-festival`} value={settings.festival} onChange={(value) => set('festival', value)} disabled={disabled} />
            <QualitySelect
              id={`${id}-quality`}
              value={settings.quality}
              defaultQuality={defaultQuality}
              onChange={(value) => set('quality', value)}
              disabled={disabled}
            />
          </div>

          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <span className="text-xs font-medium text-foreground flex items-center gap-1.5">
              <Type className="w-3.5 h-3.5 text-brand-to" /> Text-free artwork
            </span>
            <input
              type="checkbox"
              checked={settings.textFree}
              disabled={disabled}
              onChange={(event) => set('textFree', event.target.checked)}
              className="w-4 h-4 rounded border-input text-primary focus:ring-ring"
            />
          </label>

          {brandControls && (
            <div className="space-y-1.5">
              <label htmlFor={`${id}-client`} className="text-xs font-medium text-foreground flex items-center gap-1.5">
                <Building2 className="w-3.5 h-3.5 text-brand-to" /> Client
              </label>
              <select
                id={`${id}-client`}
                value={settings.clientId ?? ''}
                disabled={disabled || lockedClient}
                onChange={(event) => {
                  const next = event.target.value || null;
                  // Another client's identity choices do not carry over; what that
                  // client's Brand Canvas has is ticked once it loads.
                  setSettings((previous) => ({ ...previous, clientId: next, overlayElements: [] }));
                  setSummary(null);
                }}
                className="w-full bg-background border border-input rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
              >
                <option value="">No client — no brand identity</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.companyName}
                  </option>
                ))}
              </select>
            </div>
          )}

          {brandControls && settings.clientId && (
            <BrandCanvasPanel
              idPrefix={id}
              compact
              clientId={settings.clientId}
              summary={summary}
              loading={brandLoading}
              error={brandError}
              elements={settings.overlayElements}
              onElementsChange={(elements) => set('overlayElements', elements)}
              logoBackground={settings.logoBackground}
              onLogoBackgroundChange={(value) => set('logoBackground', value)}
              footerBackground={settings.footerBackground}
              onFooterBackgroundChange={(value) => set('footerBackground', value)}
              disabled={disabled}
            />
          )}
          {problem && <p className="text-[11px] text-destructive">{problem}</p>}

          <button
            type="button"
            disabled={disabled}
            onClick={apply}
            className="w-full py-2.5 px-3 rounded-lg bg-gradient-brand hover:opacity-95 text-white font-semibold text-xs flex items-center justify-center gap-2 shadow-sm transition-all disabled:opacity-50"
          >
            {disabled ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {applyLabel}
          </button>
          {note && <p className="text-[10px] text-muted-foreground text-center">{note}</p>}
        </div>
      )}
    </div>
  );
}
