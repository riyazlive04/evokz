'use client';

import * as React from 'react';

import {
  Check,
  ImageOff,
  Link2,
  Loader2,
  Scissors,
  Trash2,
  Undo2,
  Upload,
} from 'lucide-react';

import {
  removeClientLogoBackground,
  revertClientLogoBackground,
  setClientLogoUrl,
  updateClientPosterIdentity,
  uploadClientLogo,
} from '@/app/admin/dashboard/actions';
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
import type { LogoKeySkipReason } from '@/lib/poster/logo-key';

/**
 * Editor for the identity the poster renderer composites onto every creative:
 * the logo lockup, the tagline beneath it, and the two contact-bar values.
 *
 * Lives on the brand canvas rather than the tenant record because these are brand
 * assets, and because the canvas already reserved a slot for them — its asset
 * ledger has always read "Logo uploads and scrape targets appear here."
 */

/**
 * Why an upload's background was left as it arrived.
 *
 * Shorter than the copy `removeClientLogoBackground` returns, because that one
 * answers a button press and this one explains an outcome nobody asked about —
 * the file uploaded successfully either way. Keyed by `LogoKeySkipReason`; the
 * `Record` makes a new reason a type error rather than a blank line in the UI.
 */
const SKIP_NOTES: Record<LogoKeySkipReason, string> = {
  'already-transparent': 'Already had a transparent background — left as it is.',
  'background-not-flat':
    "Background is a gradient or photo, so it was left alone rather than damaged. Supply a PNG with a transparent background if you need it removed.",
  'nothing-to-remove': 'No background found around the edges — left as it is.',
  'would-erase-logo':
    'The mark is the same colour as its border, so removing the background would have erased it. Left as it is.',
  vector: 'SVG artwork has no background to remove.',
  undecodable: 'The image could not be read for background removal, so it was stored as-is.',
};

export interface PosterIdentityPanelProps {
  clientId: string;
  companyName: string;
  logoUrl: string | null;
  /** Set when we host the file, which is what makes "Remove" able to tidy up. */
  logoDriveFileId: string | null;
  /** The pre-removal file. Non-null exactly when `logoBackgroundRemoved` is true. */
  logoOriginalUrl: string | null;
  logoBackgroundRemoved: boolean;
  brandTagline: string | null;
  websiteUrl: string | null;
  displayPhone: string | null;
  /** Fallback source for the contact bar when `displayPhone` is unset. */
  whatsappNumber: string;
  hasDriveFolder: boolean;
}

export function PosterIdentityPanel({
  clientId,
  companyName,
  logoUrl,
  logoDriveFileId,
  logoOriginalUrl,
  logoBackgroundRemoved,
  brandTagline,
  websiteUrl,
  displayPhone,
  whatsappNumber,
  hasDriveFolder,
}: PosterIdentityPanelProps) {
  const upload = useAction(uploadClientLogo);
  const link = useAction(setClientLogoUrl);
  const identity = useAction(updateClientPosterIdentity);
  const cutout = useAction(removeClientLogoBackground);
  const restore = useAction(revertClientLogoBackground);

  const fileRef = React.useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [urlDraft, setUrlDraft] = React.useState('');
  const [saved, setSaved] = React.useState(false);
  /**
   * Why an upload's background was left alone. Held in state rather than derived
   * from props because it describes what just happened to *this* file — the row
   * afterwards looks identical to one that was never processed.
   */
  const [uploadNote, setUploadNote] = React.useState<string | null>(null);

  const [form, setForm] = React.useState({
    brandTagline: brandTagline ?? '',
    websiteUrl: websiteUrl ?? '',
    displayPhone: displayPhone ?? '',
  });

  // Re-syncs when the server component re-renders with fresh values after a
  // successful save, so the inputs never drift from what is persisted.
  React.useEffect(() => {
    setForm({
      brandTagline: brandTagline ?? '',
      websiteUrl: websiteUrl ?? '',
      displayPhone: displayPhone ?? '',
    });
  }, [brandTagline, websiteUrl, displayPhone]);

  const flashSaved = React.useCallback(() => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2_000);
  }, []);

  async function handleUpload(event: React.FormEvent) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    const body = new FormData();
    body.set('logo', file);

    const result = await upload.run(clientId, body);
    if (result.ok) {
      setFileName(null);
      if (fileRef.current) fileRef.current.value = '';
      // A declined removal is not an upload failure — the file stored fine. It
      // gets a note beside the preview rather than the error line.
      setUploadNote(result.data.skipped ? SKIP_NOTES[result.data.skipped] : null);
      flashSaved();
    }
  }

  async function handleUseUrl(event: React.FormEvent) {
    event.preventDefault();
    const result = await link.run(clientId, urlDraft);
    if (result.ok) {
      setUrlDraft('');
      setUploadNote(null);
      flashSaved();
    }
  }

  async function handleRemove() {
    const result = await link.run(clientId, null);
    if (result.ok) {
      setUploadNote(null);
      flashSaved();
    }
  }

  async function handleCutout() {
    const result = await cutout.run(clientId);
    if (result.ok) {
      setUploadNote(null);
      flashSaved();
    }
  }

  async function handleRestore() {
    const result = await restore.run(clientId);
    if (result.ok) {
      setUploadNote(null);
      flashSaved();
    }
  }

  async function handleSaveIdentity(event: React.FormEvent) {
    event.preventDefault();
    const result = await identity.run(clientId, {
      brandTagline: form.brandTagline,
      websiteUrl: form.websiteUrl,
      displayPhone: form.displayPhone,
    });
    if (result.ok) flashSaved();
  }

  const busy =
    upload.pending || link.pending || identity.pending || cutout.pending || restore.pending;
  const error =
    upload.error ?? link.error ?? identity.error ?? cutout.error ?? restore.error;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Poster identity
          {saved && (
            <span className="flex items-center gap-1 text-xs font-normal text-success-ink">
              <Check className="h-3.5 w-3.5" />
              Saved
            </span>
          )}
        </CardTitle>
        <CardDescription>
          Composited onto every creative for {companyName}. The logo replaces the
          generated wordmark lockup; the phone and website fill the contact bar.
          Changes apply from the next render onward — already-delivered days keep the
          asset they shipped with.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* ---- Logo ---- */}
        <div className="grid gap-5 sm:grid-cols-[200px_1fr]">
          <div className="space-y-2">
            <div
              className="flex h-[132px] items-center justify-center rounded-xl border border-dashed border-border p-3"
              /* A checkerboard, not a flat surface. Transparency is the whole
                 point of this panel now, and against a solid background a logo
                 that still carries a white box is indistinguishable from one
                 that has been keyed — which is exactly the thing the operator
                 came here to check. */
              style={
                logoUrl
                  ? {
                      backgroundImage:
                        'linear-gradient(45deg, hsl(var(--muted)) 25%, transparent 25%), linear-gradient(-45deg, hsl(var(--muted)) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, hsl(var(--muted)) 75%), linear-gradient(-45deg, transparent 75%, hsl(var(--muted)) 75%)',
                      backgroundSize: '16px 16px',
                      backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
                    }
                  : undefined
              }
            >
              {logoUrl ? (
                /* Arbitrary remote host (Drive or a client CDN) — a plain img avoids
                   allowlisting every possible remote pattern in next.config. */
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoUrl}
                  alt={`${companyName} logo`}
                  className="max-h-full max-w-full object-contain"
                />
              ) : (
                <div className="flex flex-col items-center gap-1.5 text-muted-foreground">
                  <ImageOff className="h-6 w-6" />
                  <span className="text-[11px]">No logo on file</span>
                </div>
              )}
            </div>

            {logoUrl && (
              <div className="space-y-1.5">
                {logoBackgroundRemoved ? (
                  <>
                    <div className="flex items-center gap-2">
                      {logoOriginalUrl && (
                        /* The before, at thumbnail size. Small on purpose — it is
                           there to answer "did that work?" at a glance, and the
                           result above is the thing being judged. */
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={logoOriginalUrl}
                          alt="Logo before background removal"
                          title="Before"
                          className="h-8 w-8 shrink-0 rounded border border-border bg-muted object-contain p-0.5"
                        />
                      )}
                      <p className="flex items-center gap-1 text-[11px] text-success-ink">
                        <Check className="h-3 w-3 shrink-0" />
                        Background removed
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 w-full text-[11px]"
                      disabled={busy}
                      onClick={handleRestore}
                    >
                      {restore.pending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Undo2 className="h-3.5 w-3.5" />
                      )}
                      Use original
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 w-full text-[11px]"
                    disabled={busy || !hasDriveFolder}
                    onClick={handleCutout}
                  >
                    {cutout.pending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Scissors className="h-3.5 w-3.5" />
                    )}
                    Remove background
                  </Button>
                )}
              </div>
            )}

            {uploadNote && (
              <p className="text-[11px] leading-snug text-muted-foreground">{uploadNote}</p>
            )}
          </div>

          <div className="space-y-4">
            <form onSubmit={handleUpload} className="space-y-2">
              <Label htmlFor="logo-file" className="text-xs">
                Upload a logo
              </Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="logo-file"
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  disabled={busy || !hasDriveFolder}
                  onChange={(event) =>
                    setFileName(event.target.files?.[0]?.name ?? null)
                  }
                  className="h-9 max-w-[260px] cursor-pointer file:mr-2 file:cursor-pointer file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs"
                />
                <Button type="submit" size="sm" disabled={busy || !fileName}>
                  {upload.pending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  Upload
                </Button>
                {logoUrl && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={handleRemove}
                  >
                    <Trash2 className="h-4 w-4" />
                    Remove
                  </Button>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                PNG, JPEG, WebP or SVG, up to 4 MB. A flat background is detected and
                removed automatically, and the file you uploaded is kept so
                &ldquo;Use original&rdquo; is always available. Stored in the
                client&apos;s Drive folder and published link-readable, because the
                renderer fetches it server-side.
                {!hasDriveFolder && (
                  <span className="mt-1 block text-danger-ink">
                    This client has no Drive folder yet — repair it first, or point at
                    an external URL below.
                  </span>
                )}
              </p>
            </form>

            <form onSubmit={handleUseUrl} className="space-y-2">
              <Label htmlFor="logo-url" className="text-xs">
                Or use an external URL
              </Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="logo-url"
                  value={urlDraft}
                  onChange={(event) => setUrlDraft(event.target.value)}
                  placeholder="https://example.com/logo.png"
                  disabled={busy}
                  className="max-w-[320px] font-mono text-xs"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  disabled={busy || urlDraft.trim() === ''}
                >
                  {link.pending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Link2 className="h-4 w-4" />
                  )}
                  Use URL
                </Button>
              </div>
              {logoUrl && !logoDriveFileId && (
                <p className="text-[11px] text-muted-foreground">
                  Currently pointing at an external URL. If it stops resolving, the
                  poster falls back to the wordmark lockup rather than failing.
                </p>
              )}
            </form>
          </div>
        </div>

        {/* ---- Contact bar + tagline ---- */}
        <form
          onSubmit={handleSaveIdentity}
          className="grid gap-4 border-t border-border pt-5 sm:grid-cols-3"
        >
          <Field
            id="brand-tagline"
            label="Tagline"
            hint="Letterspaced caps under the logo. Leave blank to omit."
            value={form.brandTagline}
            placeholder="Building trust since 1998"
            maxLength={60}
            disabled={busy}
            onChange={(value) => setForm((prev) => ({ ...prev, brandTagline: value }))}
          />
          <Field
            id="display-phone"
            label="Contact phone"
            hint={`Shown exactly as typed. Blank derives ${derivePhone(whatsappNumber)} from WhatsApp.`}
            value={form.displayPhone}
            placeholder={derivePhone(whatsappNumber)}
            maxLength={32}
            disabled={busy}
            onChange={(value) => setForm((prev) => ({ ...prev, displayPhone: value }))}
          />
          <Field
            id="website-url"
            label="Website"
            hint="The scheme is stripped for display."
            value={form.websiteUrl}
            placeholder="www.example.com"
            maxLength={120}
            disabled={busy}
            onChange={(value) => setForm((prev) => ({ ...prev, websiteUrl: value }))}
          />

          <div className="sm:col-span-3">
            <Button type="submit" size="sm" disabled={busy}>
              {identity.pending && <Loader2 className="h-4 w-4 animate-spin" />}
              Save identity
            </Button>
          </div>
        </form>

        {error && <p className="text-xs text-danger-ink">{error}</p>}
      </CardContent>
    </Card>
  );
}

function Field({
  id,
  label,
  hint,
  value,
  placeholder,
  maxLength,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  maxLength: number;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * Mirrors `formatPhone` in the renderer so the placeholder shows exactly what the
 * contact bar will print when this field is left blank.
 */
function derivePhone(whatsappNumber: string): string {
  const digits = whatsappNumber.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  return digits ? `+${digits}` : '';
}

export default PosterIdentityPanel;
