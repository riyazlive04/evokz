'use client';

import React from 'react';
import { Check, Minus, RefreshCw } from 'lucide-react';

import type { StudioBrandCanvasSummary } from '@/lib/poster-studio/brand-context';
import {
  studioClientLogoUrl,
  type StudioFooterBackground,
  type StudioLogoBackground,
  type StudioOverlayElement,
} from '@/lib/poster-studio/limits';
import { cn } from '@/lib/utils';

/**
 * The Brand Canvas controls shared by the studio form and the per-image
 * Customize panel. Read-only towards Brand Canvas itself: these are per-poster
 * choices.
 */

const FOOTER_OPTIONS: Array<{ value: StudioFooterBackground; label: string }> = [
  { value: 'AUTO', label: 'Auto' },
  { value: 'LIGHT', label: 'Light' },
  { value: 'DARK', label: 'Dark' },
];

/** Everything the Brand Canvas actually has, ticked by default. Nothing is invented. */
export function defaultOverlayElements(summary: StudioBrandCanvasSummary): StudioOverlayElement[] {
  const elements: StudioOverlayElement[] = [];
  if (summary.logo.available && !summary.logo.loadError) elements.push('logo');
  if (summary.tagline) elements.push('tagline');
  if (summary.website) elements.push('website');
  if (summary.phone) elements.push('phone');
  return elements;
}

/**
 * The selected client's existing Brand Canvas: what is available, the logo as a
 * poster would draw it, the per-poster logo background, and which exact identity
 * elements the overlay adds. Read-only — Brand Canvas is edited on its own page.
 */
export function BrandCanvasPanel({
  clientId,
  summary,
  loading,
  error,
  elements,
  onElementsChange,
  logoBackground,
  onLogoBackgroundChange,
  footerBackground,
  onFooterBackgroundChange,
  disabled,
  idPrefix = 'studio',
  compact = false,
}: {
  clientId: string;
  summary: StudioBrandCanvasSummary | null;
  loading: boolean;
  error: string | null;
  elements: StudioOverlayElement[];
  onElementsChange: (elements: StudioOverlayElement[]) => void;
  logoBackground: StudioLogoBackground;
  onLogoBackgroundChange: (value: StudioLogoBackground) => void;
  footerBackground: StudioFooterBackground;
  onFooterBackgroundChange: (value: StudioFooterBackground) => void;
  disabled: boolean;
  /** Keeps radio names and label ids unique when two panels share a page. */
  idPrefix?: string;
  /** Hides the Brand Canvas checklist: only the choices a poster makes are shown. */
  compact?: boolean;
}) {
  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-muted/40 p-3 text-[11px] text-muted-foreground flex items-center gap-2">
        <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Loading Brand Canvas…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-[11px] text-destructive">
        {error}
      </div>
    );
  }
  if (!summary) return null;

  const logoUsable = summary.logo.available && !summary.logo.loadError;
  const toggle = (element: StudioOverlayElement, on: boolean) =>
    onElementsChange(on ? [...elements.filter((e) => e !== element), element] : elements.filter((e) => e !== element));

  const checklist: Array<{ label: string; ok: boolean; detail?: React.ReactNode }> = [
    { label: 'Logo', ok: logoUsable, detail: summary.logo.loadError ? 'unreadable' : undefined },
    {
      label: 'Colors',
      ok: summary.colors.length > 0,
      detail:
        summary.colors.length > 0 ? (
          <span className="flex gap-0.5">
            {summary.colors.map((color) => (
              <span
                key={`${color.role}-${color.hex}`}
                title={`${color.role} ${color.hex}`}
                className="inline-block w-2.5 h-2.5 rounded-sm border border-border"
                style={{ backgroundColor: color.hex }}
              />
            ))}
          </span>
        ) : undefined,
    },
    { label: 'Typography', ok: summary.typography !== null, detail: summary.typography?.headingFont },
    { label: 'Tagline', ok: Boolean(summary.tagline) },
    { label: 'Website', ok: Boolean(summary.website) },
    { label: 'Phone', ok: Boolean(summary.phone), detail: summary.phoneIsFallback ? 'from WhatsApp' : undefined },
    { label: 'Layout rules', ok: summary.layoutDirectives.length > 0, detail: summary.layoutDirectives.length || undefined },
    { label: 'Industry', ok: Boolean(summary.industry), detail: summary.industry ?? undefined },
  ];

  const selectable: Array<{ element: StudioOverlayElement; label: string; available: boolean; value?: string | null }> = [
    { element: 'logo', label: 'Logo', available: logoUsable },
    { element: 'tagline', label: 'Tagline', available: Boolean(summary.tagline), value: summary.tagline },
    { element: 'website', label: 'Website', available: Boolean(summary.website), value: summary.website },
    { element: 'phone', label: 'Phone', available: Boolean(summary.phone), value: summary.phone },
  ];

  return (
    <div className="rounded-lg border border-border bg-background p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">Brand Canvas</p>
        <a
          href={`/admin/clients/${encodeURIComponent(clientId)}/brand?return=${encodeURIComponent('/admin/poster-studio')}`}
          className="text-[10px] text-brand-to hover:underline font-medium"
        >
          Edit in Brand Canvas
        </a>
      </div>

      {!compact && (
        <ul className="grid grid-cols-2 gap-x-3 gap-y-1">
          {checklist.map((item) => (
            <li key={item.label} className="flex items-center gap-1.5 text-[11px] min-w-0">
              {item.ok ? (
                <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400 shrink-0" />
              ) : (
                <Minus className="w-3 h-3 text-muted-foreground shrink-0" />
              )}
              <span className={cn('shrink-0', item.ok ? 'text-foreground' : 'text-muted-foreground')}>{item.label}</span>
              {item.ok && item.detail !== undefined ? (
                <span className="text-[10px] text-muted-foreground truncate">{item.detail}</span>
              ) : !item.ok ? (
                <span className="text-[10px] text-muted-foreground truncate">{item.detail ?? 'not set'}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {summary.logo.loadError && <p className="text-[10px] text-destructive leading-snug">{summary.logo.loadError}</p>}

      {logoUsable && elements.includes('logo') && (
        <div className="flex items-start gap-3">
          <div
            className="w-20 h-14 shrink-0 rounded border border-border flex items-center justify-center overflow-hidden"
            style={{
              backgroundImage: 'repeating-conic-gradient(rgba(127,127,127,0.25) 0% 25%, transparent 0% 50%)',
              backgroundSize: '10px 10px',
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- session-gated route; the logo's storage is never exposed */}
            <img
              key={logoBackground}
              src={studioClientLogoUrl(clientId, logoBackground)}
              alt={`${summary.companyName} logo`}
              className="max-w-full max-h-full object-contain"
            />
          </div>
          <fieldset className="space-y-1 text-[11px]" disabled={disabled}>
            <legend className="text-[10px] font-medium text-foreground mb-0.5">Logo background</legend>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name={`${idPrefix}-logo-background`}
                checked={logoBackground === 'ORIGINAL'}
                onChange={() => onLogoBackgroundChange('ORIGINAL')}
              />
              Keep original
            </label>
            <label
              className={cn(
                'flex items-center gap-1.5',
                summary.logo.removal.possible ? 'cursor-pointer' : 'opacity-60 cursor-not-allowed',
              )}
            >
              <input
                type="radio"
                name={`${idPrefix}-logo-background`}
                checked={logoBackground === 'REMOVED'}
                disabled={!summary.logo.removal.possible}
                onChange={() => onLogoBackgroundChange('REMOVED')}
              />
              Remove background
            </label>
            {summary.logo.removal.possible ? (
              <p className="text-[10px] text-muted-foreground leading-snug">
                {summary.logo.removal.via === 'brand-canvas-removed'
                  ? 'Uses the transparent logo already in Brand Canvas.'
                  : summary.logo.removal.via === 'keyed-for-poster'
                    ? 'Removed for this poster only; Brand Canvas is not changed.'
                    : 'This logo is already transparent.'}
              </p>
            ) : (
              <p className="text-[10px] text-muted-foreground leading-snug">{summary.logo.removal.message}</p>
            )}
          </fieldset>
        </div>
      )}

      <div className="space-y-1 border-t border-border pt-2">
        <p className="text-[10px] font-medium text-foreground">Exact identity on the poster</p>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          {selectable.map((option) => (
            <label
              key={option.element}
              className={cn(
                'flex items-center gap-1.5 text-[11px] min-w-0',
                option.available ? 'cursor-pointer text-foreground' : 'text-muted-foreground cursor-not-allowed',
              )}
              title={option.value ?? undefined}
            >
              <input
                type="checkbox"
                disabled={disabled || !option.available}
                checked={option.available && elements.includes(option.element)}
                onChange={(event) => toggle(option.element, event.target.checked)}
              />
              <span className="shrink-0">{option.label}</span>
              {option.value && <span className="text-[10px] text-muted-foreground truncate">{option.value}</span>}
            </label>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground leading-snug">
          {elements.length > 0
            ? `Drawn exactly from Brand Canvas after generation, never by the AI, in a footer along the bottom.${
                elements.includes('logo') && summary.logo.includesName ? '' : ' The company name is added too.'
              }`
            : 'No identity overlay — the poster is the AI artwork only.'}
        </p>
      </div>

      {elements.length > 0 && (
        <div className="space-y-1 border-t border-border pt-2">
          <p className="text-[10px] font-medium text-foreground" id={`${idPrefix}-footer-label`}>
            Footer background
          </p>
          <div
            role="radiogroup"
            aria-labelledby={`${idPrefix}-footer-label`}
            className="grid grid-cols-3 gap-1 bg-muted/60 p-1 rounded-md border border-border text-[11px]"
          >
            {FOOTER_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={footerBackground === option.value}
                disabled={disabled}
                onClick={() => onFooterBackgroundChange(option.value)}
                className={cn(
                  'py-1 rounded font-medium transition-all disabled:opacity-60',
                  footerBackground === option.value
                    ? 'bg-card text-foreground shadow-sm font-semibold'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground leading-snug">
            {footerBackground === 'AUTO'
              ? 'Light or dark, chosen from the finished artwork so the footer blends in.'
              : footerBackground === 'LIGHT'
                ? 'A light footer with dark text.'
                : 'A dark footer with light text.'}
          </p>
        </div>
      )}
    </div>
  );
}
