'use client';

import * as React from 'react';

import { Check, Loader2, Sparkles } from 'lucide-react';

import { extractBrandGuideline } from '@/app/admin/dashboard/actions';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useAction } from '@/hooks/use-action';

const MIN_LENGTH = 40;

/**
 * Operator input for the brand tokenizer. Paste site copy, a scrape dump, or
 * positioning notes; the tokenizer structuralises it into the design tokens the canvas
 * above renders.
 */
export function BrandTokenizerPanel({
  clientId,
  companyName,
  hasTokens,
}: {
  clientId: string;
  companyName: string;
  hasTokens: boolean;
}) {
  const [material, setMaterial] = React.useState('');
  const [flash, setFlash] = React.useState<string | null>(null);
  const extract = useAction(extractBrandGuideline);

  React.useEffect(() => {
    if (flash === null) return undefined;
    const timer = setTimeout(() => setFlash(null), 6_000);
    return () => clearTimeout(timer);
  }, [flash]);

  const tooShort = material.trim().length < MIN_LENGTH;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const result = await extract.run(clientId, material.trim());
    if (result.ok) {
      setFlash(
        `Extracted ${result.data.colors} colour token(s)${
          result.data.headingFont ? ` and ${result.data.headingFont}` : ''
        }.`,
      );
      setMaterial('');
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-border bg-background p-5"
    >
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-brand-to" />
        <h3 className="text-xs font-semibold uppercase tracking-[0.22em] text-foreground">
          Brand tokenizer
        </h3>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        {hasTokens
          ? `Re-extracting replaces ${companyName}'s current colour and typography tokens. Imported assets are preserved.`
          : `No tokens extracted yet. Paste ${companyName}'s website copy, a scrape dump, or brand notes below.`}
      </p>

      <div className="mt-4 space-y-1.5">
        <Label htmlFor="brand-material">Source material</Label>
        <textarea
          id="brand-material"
          value={material}
          onChange={(event) => setMaterial(event.target.value)}
          rows={8}
          placeholder="Paste website copy, positioning statements, style notes, or scrape output…"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        />
        <p className="text-[10px] text-muted-foreground/70">
          {material.trim().length} characters
          {tooShort && material.length > 0 ? ` — need at least ${MIN_LENGTH}` : ''}
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={tooShort || extract.pending}>
          {extract.pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          Extract design tokens
        </Button>

        {flash && (
          <span className="flex items-center gap-1.5 text-[11px] text-success-ink">
            <Check className="h-3.5 w-3.5" />
            {flash}
          </span>
        )}

        {extract.error && (
          <span role="alert" className="text-[11px] text-danger-ink">
            {extract.error}
          </span>
        )}
      </div>
    </form>
  );
}
