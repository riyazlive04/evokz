'use client';

import * as React from 'react';

import { Check, Globe, Loader2, Sparkles } from 'lucide-react';

import { applyWebsiteColors, previewWebsiteColors } from '@/app/admin/dashboard/actions';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useAction } from '@/hooks/use-action';
import { describeColorRole } from '@/lib/types/brand';

/**
 * Reads brand colours straight from a client's website CSS.
 *
 * Sits beside `BrandTokenizerPanel` rather than replacing it: the tokenizer
 * still supplies typography, vibe and layout directives, which no stylesheet
 * states directly. This panel only overwrites the palette, which is the one part
 * the tokenizer was guessing at.
 *
 * Preview and apply are separate steps on purpose. Applying changes what a live
 * client receives on the next cron sweep, and there is no undo on a delivered
 * poster, so an operator sees the palette before it can go anywhere.
 */

interface PreviewColor {
  hex: string;
  role: string;
  source: string;
  confidence: number;
  evidence: string;
}

export function WebsiteColorPanel({
  clientId,
  companyName,
  websiteUrl,
}: {
  clientId: string;
  companyName: string;
  websiteUrl: string | null;
}) {
  const [url, setUrl] = React.useState(websiteUrl ?? '');
  const [preview, setPreview] = React.useState<PreviewColor[] | null>(null);
  const [flash, setFlash] = React.useState<string | null>(null);

  const previewAction = useAction(previewWebsiteColors);
  const applyAction = useAction(applyWebsiteColors);

  React.useEffect(() => {
    if (flash === null) return undefined;
    const timer = setTimeout(() => setFlash(null), 6_000);
    return () => clearTimeout(timer);
  }, [flash]);

  const trimmed = url.trim();
  const busy = previewAction.pending || applyAction.pending;

  async function handlePreview(event: React.FormEvent) {
    event.preventDefault();
    setFlash(null);
    const result = await previewAction.run(trimmed);
    setPreview(result.ok ? result.data.colors : null);
    if (result.ok) {
      setFlash(
        `Found ${result.data.colors.length} colour(s) across ${result.data.stylesheetsRead} stylesheet(s).`,
      );
    }
  }

  async function handleApply() {
    const result = await applyAction.run(clientId, trimmed);
    if (result.ok) {
      setPreview(null);
      setFlash(`Applied ${result.data.colors} colour(s) to ${companyName}'s brand canvas.`);
    }
  }

  return (
    <form
      onSubmit={handlePreview}
      className="rounded-2xl border border-border bg-background p-5"
    >
      <div className="flex items-center gap-2">
        <Globe className="h-4 w-4 text-brand-to" />
        <h3 className="text-xs font-semibold uppercase tracking-[0.22em] text-foreground">
          Website colours
        </h3>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Reads the exact colours declared in {companyName}&apos;s stylesheet — custom
        properties, theme-color, button and header backgrounds. Replaces the palette only;
        typography and layout directives are kept.
      </p>

      <div className="mt-4 space-y-1.5">
        <Label htmlFor="brand-website-url">Website address</Label>
        <input
          id="brand-website-url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="www.example.com"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        />
        <p className="text-[10px] text-muted-foreground/70">
          Sites that build their styles in JavaScript cannot be read this way.
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" disabled={trimmed === '' || busy}>
          {previewAction.pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          Preview colours
        </Button>

        {preview !== null && preview.length > 0 && (
          <Button type="button" onClick={handleApply} disabled={busy}>
            {applyAction.pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            Apply to brand canvas
          </Button>
        )}

        {flash && (
          <span className="flex items-center gap-1.5 text-[11px] text-success-ink">
            <Check className="h-3.5 w-3.5" />
            {flash}
          </span>
        )}

        {(previewAction.error ?? applyAction.error) && (
          <span role="alert" className="text-[11px] text-danger-ink">
            {previewAction.error ?? applyAction.error}
          </span>
        )}
      </div>

      {preview !== null && preview.length > 0 && (
        <ul className="mt-5 space-y-2">
          {preview.map((color) => (
            <li
              key={`${color.hex}-${color.role}`}
              className="flex items-center gap-3 rounded-lg border border-border px-3 py-2"
            >
              <span
                aria-hidden
                className="h-8 w-8 shrink-0 rounded-md border border-border"
                style={{ backgroundColor: color.hex }}
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-xs text-foreground">{color.hex}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {describeColorRole(color.role)}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-[10px] text-muted-foreground/70">
                  {color.source} · {color.evidence}
                </span>
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {Math.round(color.confidence * 100)}%
              </span>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
