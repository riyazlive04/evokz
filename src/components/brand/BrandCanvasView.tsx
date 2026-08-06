'use client';

import * as React from 'react';

import {
  Check,
  Copy,
  FileText,
  Globe,
  Hand,
  ImageIcon,
  Layers,
  Palette,
  Pipette,
  Sparkles,
  Type as TypeIcon,
} from 'lucide-react';

import {
  describeColorRole,
  parseBrandGuideline,
  type BrandAsset,
  type BrandColor,
  type BrandGuideline,
} from '@/lib/types/brand';
import { cn } from '@/lib/utils';

/**
 * BrandCanvasView — a Figma-style workspace for one client's extracted design
 * tokens. Renders `Client.brandGuideline`, so it accepts the raw `Json` column
 * and narrows it internally rather than trusting the caller.
 */

export interface BrandCanvasClient {
  id: string;
  companyName: string;
  /** Raw `Client.brandGuideline` JSON, or an already-parsed guideline. */
  brandGuideline: unknown;
  categoryName?: string | null;
  gDriveFolderId?: string | null;
}

export interface BrandCanvasViewProps {
  clientData: BrandCanvasClient;
  className?: string;
}

type CanvasTool = 'pan' | 'text' | 'inspect';

interface ToolDefinition {
  id: CanvasTool;
  label: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
}

const TOOLS: readonly ToolDefinition[] = [
  { id: 'pan', label: 'Pan', hint: 'Drag to traverse the canvas', icon: Hand },
  { id: 'text', label: 'Text', hint: 'Preview typography tokens', icon: TypeIcon },
  { id: 'inspect', label: 'Inspect', hint: 'Reveal channel breakdowns', icon: Pipette },
] as const;

const TYPE_SCALE = [
  { token: 'display', size: '3.25rem', leading: '1.02', weight: 700, weightLabel: 'Bold' },
  { token: 'h1', size: '2.25rem', leading: '1.1', weight: 700, weightLabel: 'Bold' },
  { token: 'h2', size: '1.5rem', leading: '1.2', weight: 600, weightLabel: 'Semibold' },
  { token: 'h3', size: '1.125rem', leading: '1.3', weight: 600, weightLabel: 'Semibold' },
] as const;

const BODY_SCALE = [
  { token: 'lead', size: '1.125rem', leading: '1.6', weight: 400, weightLabel: 'Regular' },
  { token: 'base', size: '1rem', leading: '1.65', weight: 400, weightLabel: 'Regular' },
  { token: 'sm', size: '0.875rem', leading: '1.6', weight: 400, weightLabel: 'Regular' },
  { token: 'caption', size: '0.75rem', leading: '1.5', weight: 500, weightLabel: 'Medium' },
] as const;

export function BrandCanvasView({ clientData, className }: BrandCanvasViewProps) {
  const guideline = React.useMemo<BrandGuideline>(
    () => parseBrandGuideline(clientData.brandGuideline),
    [clientData.brandGuideline],
  );

  const [activeTool, setActiveTool] = React.useState<CanvasTool>('pan');
  const [copiedHex, setCopiedHex] = React.useState<string | null>(null);
  const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const handleCopy = React.useCallback(async (hex: string) => {
    const copied = await copyToClipboard(hex);
    if (!copied) return;

    setCopiedHex(hex);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopiedHex(null), 1_600);
  }, []);

  const headingFont = guideline.typography?.headingFont ?? 'Inter';
  const bodyFont = guideline.typography?.bodyFont ?? 'Inter';
  const inspecting = activeTool === 'inspect';

  return (
    <section
      className={cn(
        // `dark` scopes the token set to the canvas: the blueprint grid, the
        // brand blooms and the glass toolbar all need a dark ground to read,
        // so this stays a dark island on the otherwise light page.
        'dark relative isolate min-h-[620px] w-full overflow-hidden rounded-2xl border border-border bg-background text-foreground sm:min-h-[860px]',
        activeTool === 'pan' && 'cursor-grab active:cursor-grabbing',
        activeTool === 'text' && 'cursor-text',
        inspecting && 'cursor-crosshair',
        className,
      )}
      aria-label={`Brand canvas for ${clientData.companyName}`}
    >
      {/* Blueprint grid — infinite lines, vignetted so the plane fades to void. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-blueprint-grid [mask-image:radial-gradient(ellipse_70%_60%_at_50%_35%,#000_50%,transparent_100%)]"
      />
      {/* Sand bloom behind the origin point. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-primary/15 blur-[120px]"
      />
      {/* Secondary navy wash, offset so the field reads as depth. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 right-0 h-[420px] w-[560px] rounded-full bg-brand-via/20 blur-[130px]"
      />

      <FloatingControlBar
        activeTool={activeTool}
        onToolChange={setActiveTool}
        companyName={clientData.companyName}
      />

      {/* perspective-1000 establishes the shared projection for every 3D child. */}
      <div className="perspective-1000 relative z-10 space-y-8 px-4 pb-10 pt-24 sm:space-y-12 sm:px-10 sm:pb-16 sm:pt-32">
        <CanvasHeader
          companyName={clientData.companyName}
          categoryName={clientData.categoryName}
          vibe={guideline.typography?.vibeClassification ?? null}
          headingFont={headingFont}
          colorCount={guideline.colors.length}
        />

        <ColorSwatchTray
          colors={guideline.colors}
          copiedHex={copiedHex}
          inspecting={inspecting}
          onCopy={handleCopy}
        />

        <FontTokenMatrix
          headingFont={headingFont}
          bodyFont={bodyFont}
          vibe={guideline.typography?.vibeClassification ?? null}
          hasTypography={guideline.typography !== null}
          previewMode={activeTool === 'text'}
        />

        {guideline.layoutDirectives.length > 0 && (
          <LayoutDirectiveStrip directives={guideline.layoutDirectives} />
        )}

        <AssetLedger assets={guideline.assets} gDriveFolderId={clientData.gDriveFolderId ?? null} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Floating glassmorphic control bar
// ---------------------------------------------------------------------------

function FloatingControlBar({
  activeTool,
  onToolChange,
  companyName,
}: {
  activeTool: CanvasTool;
  onToolChange: (tool: CanvasTool) => void;
  companyName: string;
}) {
  const active = TOOLS.find((tool) => tool.id === activeTool);

  return (
    <div className="absolute left-1/2 top-6 z-30 -translate-x-1/2">
      <div
        role="toolbar"
        aria-label="Canvas tools"
        className="flex items-center gap-1 rounded-2xl border border-navy-200/10 bg-card/70 p-1.5 shadow-canvas-float backdrop-blur-xl transition-all duration-300"
      >
        <div className="flex items-center gap-2 rounded-xl bg-navy-200/5 px-3 py-1.5">
          <Layers className="h-3.5 w-3.5 text-primary" />
          <span className="max-w-[150px] truncate text-[11px] font-semibold uppercase tracking-widest text-foreground/80">
            {companyName}
          </span>
        </div>

        <div aria-hidden className="mx-1 h-6 w-px bg-navy-200/10" />

        {TOOLS.map((tool) => {
          const Icon = tool.icon;
          const isActive = tool.id === activeTool;
          return (
            <button
              key={tool.id}
              type="button"
              onClick={() => onToolChange(tool.id)}
              aria-pressed={isActive}
              title={`${tool.label} — ${tool.hint}`}
              className={cn(
                'group relative flex h-9 w-9 items-center justify-center rounded-xl transition-all duration-300',
                isActive
                  ? 'bg-primary text-primary-foreground shadow-brand-glow'
                  : 'text-muted-foreground hover:bg-navy-200/5 hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4" />
              <span className="sr-only">{tool.label}</span>
            </button>
          );
        })}

        <div aria-hidden className="mx-1 h-6 w-px bg-navy-200/10" />

        <span className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors duration-300">
          {active?.hint ?? ''}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function CanvasHeader({
  companyName,
  categoryName,
  vibe,
  headingFont,
  colorCount,
}: {
  companyName: string;
  categoryName?: string | null;
  vibe: string | null;
  headingFont: string;
  colorCount: number;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 sm:gap-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.28em] text-primary/90">
          <Sparkles className="h-3.5 w-3.5" />
          Design token workspace
        </div>
        <h2
          className="text-gradient-brand text-2xl font-bold tracking-tight transition-all duration-300 sm:text-4xl"
          style={{ fontFamily: quoteFontFamily(headingFont) }}
        >
          {companyName}
        </h2>
        <p className="text-sm text-muted-foreground">
          {categoryName ? `${categoryName} · ` : ''}
          {colorCount} colour token{colorCount === 1 ? '' : 's'}
          {vibe ? ` · ${vibe}` : ''}
        </p>
      </div>

      <dl className="flex gap-3">
        <StatChip label="Palette" value={String(colorCount)} />
        <StatChip label="Typeface" value={headingFont} />
      </dl>
    </header>
  );
}

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-navy-200/5 bg-navy-200/[0.03] px-4 py-2.5 backdrop-blur-sm transition-all duration-300 hover:border-primary/40 hover:bg-gradient-brand-soft">
      <dt className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 max-w-[140px] truncate text-sm font-medium text-foreground">
        {value}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Color swatch tray
// ---------------------------------------------------------------------------

function ColorSwatchTray({
  colors,
  copiedHex,
  inspecting,
  onCopy,
}: {
  colors: BrandColor[];
  copiedHex: string | null;
  inspecting: boolean;
  onCopy: (hex: string) => void;
}) {
  return (
    <div className="space-y-4">
      <SectionLabel icon={Palette} title="Colour tokens" meta={`${colors.length} swatches`} />

      {colors.length === 0 ? (
        <EmptyPlate message="No colour tokens extracted yet. Run the brand tokenizer to populate this tray." />
      ) : (
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {colors.map((color, index) => (
            <ColorSwatchCard
              key={`${color.hex}-${color.role}-${index}`}
              color={color}
              copied={copiedHex === color.hex}
              inspecting={inspecting}
              onCopy={onCopy}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ColorSwatchCard({
  color,
  copied,
  inspecting,
  onCopy,
}: {
  color: BrandColor;
  copied: boolean;
  inspecting: boolean;
  onCopy: (hex: string) => void;
}) {
  const rgb = hexToRgb(color.hex);
  const onLightSurface = rgb !== null && relativeLuminance(rgb) > 0.55;

  return (
    <button
      type="button"
      onClick={() => onCopy(color.hex)}
      title={`Copy ${color.hex}`}
      // The 3D rest pose flattens on hover — the card "lifts to face" the user.
      className="rotate-x-6 rotate-y-6 hover:rotate-x-0 hover:rotate-y-0 group relative overflow-hidden rounded-2xl border border-navy-200/10 bg-card/70 text-left shadow-canvas-card transition-all duration-300 hover:border-primary/40 hover:shadow-brand-glow-lg focus:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {/* Colour-block fill area */}
      <div
        className="relative h-32 w-full transition-all duration-300 group-hover:h-36"
        style={{ backgroundColor: color.hex }}
      >
        <span
          className={cn(
            'absolute right-2.5 top-2.5 flex h-7 w-7 items-center justify-center rounded-lg backdrop-blur-md transition-all duration-300',
            // This chip sits on an arbitrary CLIENT hex, not on a themed
            // surface, so it uses the fixed ramps rather than tokens — the
            // swatch behind it does not follow the theme.
            copied
              ? 'bg-success text-success-foreground opacity-100'
              : 'bg-scrim/40 text-navy-50 opacity-0 group-hover:opacity-100',
            // On a light swatch the ink has to invert. It previously used
            // `text-foreground`, which inside this dark island resolves to
            // near-white — a white glyph on a white wash over a light colour.
            onLightSurface && !copied && 'bg-navy-50/50 text-navy-900',
          )}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </span>
      </div>

      <div className="space-y-1.5 p-3.5">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-primary/90">
          {describeColorRole(color.role)}
        </p>
        <p className="font-mono text-sm font-medium uppercase text-foreground">
          {color.hex}
        </p>

        {/* Colour Inspector tool reveals the channel breakdown. */}
        <div
          className={cn(
            'overflow-hidden font-mono text-[10px] text-muted-foreground transition-all duration-300',
            inspecting && rgb ? 'max-h-10 opacity-100' : 'max-h-0 opacity-0',
          )}
        >
          {rgb && (
            <>
              <p>{`rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`}</p>
              <p>{rgbToHslString(rgb)}</p>
            </>
          )}
        </div>

        <p className="text-[10px] text-muted-foreground/80 transition-colors duration-300 group-hover:text-muted-foreground">
          {copied ? 'Copied to clipboard' : 'Click to copy hex'}
        </p>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Font token matrix
// ---------------------------------------------------------------------------

function FontTokenMatrix({
  headingFont,
  bodyFont,
  vibe,
  hasTypography,
  previewMode,
}: {
  headingFont: string;
  bodyFont: string;
  vibe: string | null;
  hasTypography: boolean;
  previewMode: boolean;
}) {
  return (
    <div className="space-y-4">
      <SectionLabel
        icon={TypeIcon}
        title="Typography matrix"
        meta={vibe ?? (hasTypography ? 'Extracted' : 'Fallback stack')}
      />

      {!hasTypography && (
        <EmptyPlate message="No typography tokens extracted — showing the Inter fallback stack." />
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <FontSpecSheet
          role="Headings"
          fontFamily={headingFont}
          scale={TYPE_SCALE}
          sample="Momentum by design"
          highlighted={previewMode}
        />
        <FontSpecSheet
          role="Body"
          fontFamily={bodyFont}
          scale={BODY_SCALE}
          sample="Every creative ships on schedule, in the client's own visual language."
          highlighted={previewMode}
        />
      </div>
    </div>
  );
}

function FontSpecSheet({
  role,
  fontFamily,
  scale,
  sample,
  highlighted,
}: {
  role: string;
  fontFamily: string;
  scale: readonly {
    token: string;
    size: string;
    leading: string;
    weight: number;
    weightLabel: string;
  }[];
  sample: string;
  highlighted: boolean;
}) {
  // "Mock injection": the extracted family name is applied inline ahead of the
  // local fallback stack, so an installed face renders and anything unknown
  // degrades to Inter instead of blank text.
  const injectedFamily = quoteFontFamily(fontFamily);

  return (
    <div
      className={cn(
        'rounded-2xl border bg-card/60 p-5 backdrop-blur-sm transition-all duration-300',
        highlighted
          ? 'border-primary/40 bg-gradient-brand-soft shadow-brand-glow-lg'
          : 'border-navy-200/10 hover:border-navy-200/20',
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-primary/90">
          {role}
        </p>
        <p className="truncate font-mono text-xs text-muted-foreground">{fontFamily}</p>
      </div>

      <p
        className="mt-4 text-2xl text-foreground transition-all duration-300"
        style={{ fontFamily: injectedFamily }}
      >
        {sample}
      </p>

      <dl className="mt-5 divide-y divide-navy-200/5 border-t border-navy-200/5">
        {scale.map((step) => (
          <div key={step.token} className="flex items-center justify-between gap-4 py-2">
            <dt className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              {step.token}
            </dt>
            <dd
              className="flex-1 truncate text-right text-foreground/80 transition-all duration-300"
              style={{
                fontFamily: injectedFamily,
                fontSize: step.size,
                lineHeight: step.leading,
                fontWeight: step.weight,
              }}
            >
              Aa
            </dd>
            <dd className="w-40 shrink-0 text-right font-mono text-[10px] text-muted-foreground/80">
              {step.size} / {step.leading} · {step.weightLabel} {step.weight}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout directives
// ---------------------------------------------------------------------------

function LayoutDirectiveStrip({ directives }: { directives: string[] }) {
  return (
    <div className="space-y-4">
      <SectionLabel
        icon={Layers}
        title="Layout directives"
        meta={`${directives.length} rules`}
      />
      <ul className="flex flex-wrap gap-2.5">
        {directives.map((directive, index) => (
          <li
            key={`${directive}-${index}`}
            className="rounded-full border border-navy-200/10 bg-navy-200/[0.03] px-4 py-1.5 text-xs text-foreground/80 transition-all duration-300 hover:border-primary/40 hover:bg-gradient-brand-soft hover:text-primary"
          >
            {directive}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Asset ledger
// ---------------------------------------------------------------------------

function AssetLedger({
  assets,
  gDriveFolderId,
}: {
  assets: BrandAsset[];
  gDriveFolderId: string | null;
}) {
  return (
    <div className="space-y-4">
      <SectionLabel
        icon={ImageIcon}
        title="Asset ledger"
        meta={gDriveFolderId ? 'Drive vault linked' : 'Drive vault pending'}
      />

      {assets.length === 0 ? (
        <EmptyPlate message="No imported assets recorded. Logo uploads and scrape targets appear here." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {assets.map((asset, index) => (
            <AssetCard key={`${asset.label}-${index}`} asset={asset} />
          ))}
        </div>
      )}
    </div>
  );
}

function AssetCard({ asset }: { asset: BrandAsset }) {
  const Icon = assetIcon(asset.type);

  return (
    <article className="group rounded-2xl border border-primary/25 bg-card/70 p-4 shadow-brand-glow-sm transition-all duration-300 hover:-translate-y-1 hover:border-primary/50 hover:shadow-brand-glow-lg">
      <div className="flex h-24 items-center justify-center overflow-hidden rounded-xl border border-navy-200/5 bg-gradient-surface">
        {asset.type === 'logo' || asset.type === 'image' ? (
          asset.url ? (
            /* Arbitrary third-party asset hosts — a plain img avoids having to
               allowlist every possible remote pattern. */
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={asset.url}
              alt={asset.label}
              loading="lazy"
              className="max-h-20 max-w-full object-contain transition-transform duration-300 group-hover:scale-105"
            />
          ) : (
            <Icon className="h-7 w-7 text-primary/50" />
          )
        ) : (
          <Icon className="h-7 w-7 text-primary/50 transition-transform duration-300 group-hover:scale-110" />
        )}
      </div>

      <div className="mt-3.5 space-y-1">
        <p className="truncate text-sm font-medium text-foreground">{asset.label}</p>
        <p className="text-[10px] font-semibold uppercase tracking-widest text-primary/80">
          {asset.type}
        </p>
        {asset.note && <p className="line-clamp-2 text-[11px] text-muted-foreground">{asset.note}</p>}
        {asset.url && (
          <a
            href={asset.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-block max-w-full truncate font-mono text-[10px] text-muted-foreground/80 transition-colors duration-300 hover:text-primary"
          >
            {asset.url}
          </a>
        )}
      </div>
    </article>
  );
}

function assetIcon(type: BrandAsset['type']): React.ComponentType<{ className?: string }> {
  switch (type) {
    case 'website':
      return Globe;
    case 'document':
      return FileText;
    default:
      return ImageIcon;
  }
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function SectionLabel({
  icon: Icon,
  title,
  meta,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  meta?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <Icon className="h-4 w-4 text-primary/90" />
      <h3 className="text-xs font-semibold uppercase tracking-[0.22em] text-foreground/80">
        {title}
      </h3>
      <div
        aria-hidden
        className="h-px flex-1 bg-gradient-to-r from-brand-from/50 via-primary/30 to-transparent"
      />
      {meta && <span className="text-[10px] uppercase tracking-widest text-muted-foreground/80">{meta}</span>}
    </div>
  );
}

function EmptyPlate({ message }: { message: string }) {
  return (
    <p className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-6 text-center text-xs text-muted-foreground">
      {message}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Colour + clipboard utilities
// ---------------------------------------------------------------------------

/** Wraps a family name so multi-word values stay valid CSS. */
function quoteFontFamily(family: string): string {
  const safe = family.replace(/["\\]/g, '').trim();
  return safe ? `"${safe}", var(--font-inter), ui-sans-serif, system-ui, sans-serif` : 'var(--font-inter), ui-sans-serif, sans-serif';
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb | null {
  const normalized = hex.replace('#', '').trim();
  const expanded =
    normalized.length === 3
      ? normalized
          .split('')
          .map((char) => `${char}${char}`)
          .join('')
      : normalized.slice(0, 6);

  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) return null;

  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

/** WCAG relative luminance — decides icon contrast over the colour block. */
function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function rgbToHslString({ r, g, b }: Rgb): string {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const lightness = (max + min) / 2;

  let hue = 0;
  if (delta !== 0) {
    if (max === rn) hue = ((gn - bn) / delta) % 6;
    else if (max === gn) hue = (bn - rn) / delta + 2;
    else hue = (rn - gn) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }

  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));

  return `hsl(${Math.round(hue)}, ${Math.round(saturation * 100)}%, ${Math.round(lightness * 100)}%)`;
}

/**
 * Clipboard write with a legacy fallback: `navigator.clipboard` is unavailable
 * over plain HTTP, which is how a self-hosted admin panel often runs.
 */
async function copyToClipboard(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the textarea approach.
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export default BrandCanvasView;
