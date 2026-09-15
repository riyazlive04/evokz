'use client';

import * as React from 'react';

import { Check, Loader2, RotateCcw } from 'lucide-react';

import { saveVerticalContentStrategyAction } from '@/app/admin/campaigns/actions';
import { Button } from '@/components/ui/button';
import { useAction } from '@/hooks/use-action';

/**
 * A vertical's content strategy, edited as text: one pillar per line,
 * `Label | weight | guidance`, optionally `| promotional`.
 *
 * Text rather than a row editor because the whole strategy is a handful of lines
 * an operator reads top to bottom, and the format round-trips exactly
 * (`formatContentStrategyText` / `parseContentStrategyText`). Saving empty text
 * returns the vertical to the default strategy.
 */
export function ContentStrategyEditor({
  categoryId,
  initialText,
  defaultText,
  usesDefault,
}: {
  categoryId: string;
  /** The vertical's current strategy, or the default when it has none. */
  initialText: string;
  defaultText: string;
  usesDefault: boolean;
}) {
  const [text, setText] = React.useState(initialText);
  const [saved, setSaved] = React.useState<string | null>(null);
  const save = useAction(saveVerticalContentStrategyAction);

  React.useEffect(() => setText(initialText), [initialText]);

  async function submit(value: string) {
    setSaved(null);
    const result = await save.run(categoryId, value);
    if (result.ok) {
      setSaved(result.data.usesDefault ? 'Using the default strategy.' : `Saved ${result.data.pillars} pillars.`);
      if (result.data.usesDefault) setText(defaultText);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        One pillar per line: <span className="font-mono">Label | weight | guidance</span>, adding{' '}
        <span className="font-mono">| promotional</span> to pillars that ask the audience to buy or book. Weights set each
        pillar&apos;s share of a campaign&apos;s days; promotional days are never scheduled back to back.{' '}
        {usesDefault ? 'This vertical uses the default strategy.' : 'This vertical has its own strategy.'}
      </p>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={Math.min(14, Math.max(6, text.split('\n').length + 1))}
        spellCheck={false}
        aria-label="Content strategy"
        className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void submit(text)} disabled={save.pending || text.trim() === ''}>
          {save.pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          Save strategy
        </Button>
        {!usesDefault && (
          <Button size="sm" variant="ghost" onClick={() => void submit('')} disabled={save.pending}>
            <RotateCcw className="h-4 w-4" />
            Use default
          </Button>
        )}
        {saved && <span className="text-[11px] text-success-ink">{saved}</span>}
        {save.error && (
          <span role="alert" className="text-[11px] text-danger-ink">
            {save.error}
          </span>
        )}
      </div>
    </div>
  );
}
