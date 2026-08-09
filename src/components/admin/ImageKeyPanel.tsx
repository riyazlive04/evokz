'use client';

import * as React from 'react';

import { AlertTriangle, Check, Eye, EyeOff, KeyRound, Loader2, ShieldCheck } from 'lucide-react';

import { saveFalApiKey, testFalApiKey } from '@/app/admin/dashboard/actions';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAction } from '@/hooks/use-action';
// `import type`, and it is load-bearing: `fal-credentials` reaches Prisma and,
// through `secret-box`, `node:crypto`. A value import would drag both into the
// client bundle and fail the build.
import type { FalKeyStatus } from '@/lib/fal-credentials';

/**
 * Where the operator points image generation at their own fal.ai account.
 *
 * The key is encrypted before it is stored and never comes back — `FalKeyStatus`
 * has no field that could hold one — so this panel works from the last four
 * characters and a timestamp. Saving takes effect on the next render, with no
 * redeploy, because the pipeline resolves the credential per call.
 *
 * **While a key is saved, the platform FAL_KEY is never used.** Not on rejection,
 * not on an empty balance, not when the key cannot be decrypted. The copy says so
 * in every state it can apply to, because a silent fallback is precisely what an
 * operator paying their own bill would not want and would not notice.
 *
 * **And the switch is one-way from here.** There is no remove control, because
 * there is no `clearFalApiKey` action to call — see the note where it would have
 * been in `actions.ts`. That makes the *first* save the consequential click, so
 * this panel says so plainly before it, not after: a warning an operator reads
 * only once they are stuck is not a warning.
 */
export function ImageKeyPanel({
  status,
  /** The endpoint a real render calls, so Test can flag when it differs. */
  endpoint,
}: {
  status: FalKeyStatus;
  endpoint: string;
}) {
  const save = useAction(saveFalApiKey);
  const test = useAction(testFalApiKey);

  const [draft, setDraft] = React.useState('');
  const [label, setLabel] = React.useState(status.label ?? '');
  const [revealed, setRevealed] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [note, setNote] = React.useState<string | null>(null);
  // Armed only for the *first* save — the one that cannot be undone here. Later
  // saves swap one of the operator's keys for another and need no ceremony.
  const [confirmingFirstSave, setConfirmingFirstSave] = React.useState(false);

  const busy = save.pending || test.pending;
  const error = save.error ?? test.error;
  const locked = !status.encryptionConfigured;
  const needsConfirmation = !status.configured && !confirmingFirstSave;

  // Re-syncs when the server component re-renders after a save, so the label
  // never drifts from what is persisted. Keyed off the stored timestamp rather
  // than the label itself, so re-saving the same label still settles the field.
  React.useEffect(() => {
    setLabel(status.label ?? '');
  }, [status.label, status.updatedAtLabel]);

  React.useEffect(() => {
    if (!saved) return undefined;
    const timer = setTimeout(() => setSaved(false), 2_000);
    return () => clearTimeout(timer);
  }, [saved]);

  // Same auto-disarm as ClientDangerZone — an armed confirm left on screen is a
  // trap for whoever scrolls back to it.
  React.useEffect(() => {
    if (!confirmingFirstSave) return undefined;
    const timer = setTimeout(() => setConfirmingFirstSave(false), 8_000);
    return () => clearTimeout(timer);
  }, [confirmingFirstSave]);

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    setNote(null);

    // The first save is the one-way door. Arm it rather than fire it, so nobody
    // switches the billing account for a whole install on a single click.
    if (needsConfirmation) {
      setConfirmingFirstSave(true);
      return;
    }

    const result = await save.run({ key: draft, label });
    if (result.ok) {
      setDraft('');
      setRevealed(false);
      setSaved(true);
      setConfirmingFirstSave(false);
    }
  }

  async function handleTest() {
    setNote(null);
    const result = await test.run({ key: draft.trim() || undefined });
    if (!result.ok) return;

    const { scope, endpoint: probed, renderEndpoint, elapsedMs } = result.data;
    const subject =
      scope === 'entered'
        ? 'The key you typed'
        : scope === 'saved'
          ? 'Your saved key'
          : 'The Evokz platform key';

    setNote(
      `${subject} works — ${probed} answered in ${(elapsedMs / 1000).toFixed(1)}s.` +
        (renderEndpoint === probed
          ? ''
          : ` Real renders use ${renderEndpoint}; a key that passes here can still be ` +
            'rejected there if the account cannot reach that model.'),
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-brand-to" />
          Image generation key
          {saved && (
            <span className="flex items-center gap-1 text-xs font-normal text-success-ink">
              <Check className="h-3.5 w-3.5" />
              Saved
            </span>
          )}
        </CardTitle>
        <CardDescription>
          Point image generation at your own fal.ai account. Saved keys are encrypted and take
          effect on the next render — no redeploy.{' '}
          {status.configured
            ? 'You can replace this key with another of your own at any time.'
            : 'This is a one-way switch: once saved, the console cannot return generation to the Evokz key.'}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {locked && (
          <div className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border border-warning/30 bg-warning/[0.07] p-4 text-xs text-warning-ink">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <p className="flex-1 leading-relaxed">
              <span className="font-medium">
                SETTINGS_ENCRYPTION_KEY is not set on this deployment.
              </span>{' '}
              Saving is disabled — a key would have to be written in plain text, and this panel
              will not do that. Generate one with{' '}
              <code className="rounded bg-warning/10 px-1.5 py-0.5 font-mono text-[10px]">
                node scripts/hash-password.mjs --settings-key
              </code>
              , add it to{' '}
              <code className="rounded bg-warning/10 px-1.5 py-0.5 font-mono text-[10px]">
                .env
              </code>
              , then run{' '}
              <code className="rounded bg-warning/10 px-1.5 py-0.5 font-mono text-[10px]">
                docker compose up -d app
              </code>{' '}
              — a plain restart does not re-read{' '}
              <code className="rounded bg-warning/10 px-1.5 py-0.5 font-mono text-[10px]">
                .env
              </code>
              .
            </p>
          </div>
        )}

        <KeyStatusLine status={status} />

        <form onSubmit={handleSave} className="grid gap-4 sm:grid-cols-[1fr_220px]">
          <div className="space-y-1.5">
            <Label htmlFor="fal-key" className="text-[11px]">
              {status.configured ? 'Replace with a new key' : 'Your fal.ai API key'}
            </Label>
            <div className="relative">
              <Input
                id="fal-key"
                type={revealed ? 'text' : 'password'}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setNote(null);
                }}
                placeholder={status.configured ? '••••••••••••••••••••' : 'key-id:key-secret'}
                autoComplete="off"
                spellCheck={false}
                disabled={busy || locked}
                className="pr-9 font-mono text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                tabIndex={-1}
                className="absolute right-0 top-0 h-9 w-9 text-muted-foreground"
                onClick={() => setRevealed((value) => !value)}
                aria-label={revealed ? 'Hide key' : 'Show key'}
              >
                {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">
              Two parts joined by a colon, copied whole from fal.ai → Settings → API Keys.
              {status.configured
                ? ' Saving replaces the key in use from the next render on.'
                : ' Clearing this field later does not undo the switch.'}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="fal-key-label" className="text-[11px]">
              Label (optional)
            </Label>
            <Input
              id="fal-key-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Which fal account is this?"
              maxLength={80}
              autoComplete="off"
              disabled={busy || locked}
              className="text-xs"
            />
          </div>

          <div className="sm:col-span-2 space-y-2">
            {confirmingFirstSave && (
              <div className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-md border border-warning/30 bg-warning/[0.07] p-3 text-[11px] leading-relaxed text-warning-ink">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <p className="flex-1">
                  <span className="font-medium">
                    Saving switches billing to your fal.ai account permanently.
                  </span>{' '}
                  From the next render on, every poster is charged to you. You can swap in a
                  different key of your own later, but the console cannot switch back to the
                  Evokz key — that needs someone with server access. Press{' '}
                  <span className="font-medium">Save key</span> again to confirm.
                </p>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                size="sm"
                variant={confirmingFirstSave ? 'destructive' : 'default'}
                disabled={busy || locked || !draft.trim()}
              >
                {save.pending && <Loader2 className="h-4 w-4 animate-spin" />}
                {confirmingFirstSave
                  ? 'Save key — switch billing to me'
                  : status.configured
                    ? 'Save key'
                    : 'Switch to my fal.ai key'}
              </Button>

              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleTest}
                disabled={busy}
              >
                {test.pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ShieldCheck className="h-4 w-4" />
                )}
                {draft.trim() ? 'Test entered key' : 'Test current key'}
              </Button>
            </div>

            <p className="text-[11px] text-muted-foreground">
              Test runs one 512×512 render — a real, billable call on whichever key it checks.
              With the field empty it tests whatever the pipeline would actually use.
              {!status.configured && ' Testing does not switch anything — only Save does.'}
            </p>
          </div>
        </form>

        {note && (
          <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-success-ink">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {note}
          </p>
        )}

        {error && (
          <p role="alert" className="text-[11px] leading-relaxed text-danger-ink">
            {error}
          </p>
        )}

        <p className="border-t border-border pt-3 text-[10px] leading-relaxed text-muted-foreground">
          Renders paid for with your own key are counted in the spend panel but not costed —
          fal.ai invoices you directly. Real renders call{' '}
          <code className="font-mono">{endpoint}</code>, set by{' '}
          <code className="font-mono">FAL_MODEL_ENDPOINT</code>; the model stays a deployment
          setting, only the account changes here.
        </p>
      </CardContent>
    </Card>
  );
}

/** One line saying whose account the next render will bill, and whether it works. */
function KeyStatusLine({ status }: { status: FalKeyStatus }) {
  if (status.configured && status.health === 'undecryptable') {
    return (
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border border-danger/25 bg-danger/[0.06] p-4 text-xs text-danger-ink">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <p className="flex-1 leading-relaxed">
          <span className="font-medium">A key is saved, but it cannot be decrypted.</span>{' '}
          SETTINGS_ENCRYPTION_KEY has changed since the key was stored, or this database was
          restored onto a different host. Image generation fails until you paste your key
          above and save it again, which replaces the unreadable one. There is deliberately no
          fallback to the Evokz key — quietly billing us against your instruction would be
          worse than a visible failure.
        </p>
      </div>
    );
  }

  if (status.configured) {
    return (
      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        <KeyRound className="h-3.5 w-3.5 text-brand-to" />
        <span>
          Using your fal.ai key{' '}
          <span className="font-mono text-foreground">••••{status.last4}</span>
          {status.label ? ` · ${status.label}` : ''}
          {status.updatedAtLabel ? ` — saved ${status.updatedAtLabel}` : ''}. Every render is
          billed to your fal.ai account, not to Evokz.
        </span>
      </p>
    );
  }

  return (
    <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
      <KeyRound className="h-3.5 w-3.5" />
      <span>
        Using the Evokz platform key. Renders are billed to Evokz.
        {!status.platformKeyPresent && (
          <span className="text-warning-ink">
            {' '}
            FAL_KEY is unset too, so generation will fail until you save a key here.
          </span>
        )}
      </span>
    </p>
  );
}
