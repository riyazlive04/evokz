'use client';

import * as React from 'react';

import {
  AlertTriangle,
  Check,
  ExternalLink,
  Loader2,
  Send,
  Undo2,
  Zap,
} from 'lucide-react';

import { runDemoCreativeNow } from '@/app/admin/dashboard/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAction } from '@/hooks/use-action';

/**
 * Instant creative for a demo tenant.
 *
 * Writes one calendar row from the copy typed here and runs the existing
 * pipeline on it immediately — Flux.1 render, Drive upload, WhatsApp send — so a
 * prospect watches the creative land on their phone during the call.
 *
 * Two-step arm/confirm: the send is a real WhatsApp message and cannot be
 * recalled, so a single stray click must not fire it.
 */

const TEXTAREA_CLASS =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background';

interface SentSummary {
  dayNumber: number;
  status: string;
  viewUrl: string | null;
}

export function DemoCreativePanel({
  clientId,
  companyName,
  whatsappNumber,
  hasDriveFolder,
  missingIdentity = [],
}: {
  clientId: string;
  companyName: string;
  whatsappNumber: string;
  hasDriveFolder: boolean;
  /**
   * Poster-identity fields with no value. Surfaced as a warning, never a block:
   * the renderer degrades on purpose — a missing logo becomes a wordmark
   * lockup, a missing phone is derived from the WhatsApp number — so a creative
   * without identity still renders correctly. Refusing to generate would
   * contradict that and make a quick pipeline smoke test impossible.
   */
  missingIdentity?: string[];
}) {
  const send = useAction(runDemoCreativeNow);

  const [theme, setTheme] = React.useState('');
  const [caption, setCaption] = React.useState('');
  const [hashtags, setHashtags] = React.useState('');
  const [imagePrompt, setImagePrompt] = React.useState('');
  const [armed, setArmed] = React.useState(false);
  const [sent, setSent] = React.useState<SentSummary | null>(null);

  const ready =
    theme.trim().length >= 2 &&
    caption.trim().length >= 10 &&
    imagePrompt.trim().length >= 10;

  // Any edit disarms: the confirm must apply to what is on screen now.
  function edit<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setArmed(false);
    };
  }

  async function handleSend() {
    setSent(null);
    const result = await send.run(clientId, {
      theme: theme.trim(),
      caption: caption.trim(),
      hashtags: hashtags.trim(),
      imagePrompt: imagePrompt.trim(),
    });

    setArmed(false);
    if (result.ok) {
      setSent(result.data);
      setTheme('');
      setCaption('');
      setHashtags('');
      setImagePrompt('');
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="demo-theme">Theme</Label>
          <Input
            id="demo-theme"
            value={theme}
            onChange={(event) => edit(setTheme)(event.target.value)}
            placeholder="Monsoon-ready site safety"
            maxLength={120}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="demo-hashtags">Hashtags</Label>
          <Input
            id="demo-hashtags"
            value={hashtags}
            onChange={(event) => edit(setHashtags)(event.target.value)}
            placeholder="#construction #safety #monsoon"
            maxLength={400}
          />
          <p className="text-[10px] text-muted-foreground">
            Optional. Space-separated, each starting with “#”.
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="demo-caption">Caption</Label>
        <textarea
          id="demo-caption"
          value={caption}
          onChange={(event) => edit(setCaption)(event.target.value)}
          rows={4}
          maxLength={2_000}
          placeholder="The post copy, exactly as it should arrive on WhatsApp…"
          className={TEXTAREA_CLASS}
        />
        <p className="text-[10px] text-muted-foreground/70">
          {caption.trim().length} characters
          {caption.length > 0 && caption.trim().length < 10 ? ' — need at least 10' : ''}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="demo-image-prompt">Image prompt</Label>
        <textarea
          id="demo-image-prompt"
          value={imagePrompt}
          onChange={(event) => edit(setImagePrompt)(event.target.value)}
          rows={4}
          maxLength={2_000}
          placeholder="One specific photographic scene — subject, composition, lighting, colour treatment, mood. No text or logos in frame."
          className={TEXTAREA_CLASS}
        />
        <p className="text-[10px] text-muted-foreground/70">
          Rendered by Flux.1. Image models render embedded words and logos badly — describe
          only what is visible.
        </p>
      </div>

      {!hasDriveFolder && (
        <p className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger/5 p-3 text-[11px] text-danger-ink">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {companyName} has no Drive folder yet. Provision it above — the upload stage has
            nowhere to write.
          </span>
        </p>
      )}

      {missingIdentity.length > 0 && (
        <p className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/5 p-3 text-[11px] text-warning-ink">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Poster identity is incomplete for {companyName} —{' '}
            <span className="font-medium">{missingIdentity.join(', ')}</span>{' '}
            {missingIdentity.length === 1 ? 'is' : 'are'} unset. The creative will still
            render, using fallbacks for those fields. Set them under Brand identity above
            if this is going in front of a prospect.
          </span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        {armed ? (
          <>
            <Button onClick={handleSend} disabled={send.pending} variant="destructive">
              {send.pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {send.pending ? 'Rendering & sending…' : `Confirm — send to +${whatsappNumber}`}
            </Button>
            <Button variant="ghost" onClick={() => setArmed(false)} disabled={send.pending}>
              <Undo2 className="h-4 w-4" />
              Cancel
            </Button>
          </>
        ) : (
          <Button
            onClick={() => setArmed(true)}
            disabled={!ready || !hasDriveFolder || send.pending}
            title={
              ready
                ? `Render, store on Drive, and WhatsApp to +${whatsappNumber} now`
                : 'Fill in theme, caption, and image prompt first'
            }
          >
            <Zap className="h-4 w-4" />
            Generate &amp; send now
          </Button>
        )}

        {armed && !send.pending && (
          <span className="text-[11px] text-warning-ink">
            This sends a real WhatsApp message immediately.
          </span>
        )}

        {sent && (
          <span className="flex flex-wrap items-center gap-2 text-[11px] text-success-ink">
            <Check className="h-3.5 w-3.5" />
            Day {sent.dayNumber} {sent.status.toLowerCase()} to +{whatsappNumber}.
            {sent.viewUrl && (
              <a
                href={sent.viewUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 underline underline-offset-2"
              >
                <ExternalLink className="h-3 w-3" />
                Open in Drive
              </a>
            )}
          </span>
        )}

        {send.error && (
          <span role="alert" className="text-[11px] text-danger-ink">
            {send.error}
          </span>
        )}
      </div>
    </div>
  );
}
