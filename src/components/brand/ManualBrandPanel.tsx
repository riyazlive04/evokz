'use client';

import * as React from 'react';

import { AlertTriangle, Check, Loader2, Palette, Save } from 'lucide-react';

import { applyManualBrandTokens } from '@/app/admin/dashboard/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAction } from '@/hooks/use-action';
import { accentScore, bestTextOn, contrastRatio } from '@/lib/poster/color';
import {
  BODY_FONT_OPTIONS,
  DEFAULT_BODY_FONT,
  DEFAULT_HEADING_FONT,
  HEADING_FONT_OPTIONS,
  MEASURED_MIN_ACCENT_SCORE,
} from '@/lib/poster/theme';
import {
  BRAND_COLOR_ROLES,
  describeColorRole,
  type BrandColorRole,
  type BrandGuideline,
} from '@/lib/types/brand';

/**
 * Operator-chosen brand tokens, for clients the automatic paths cannot serve.
 *
 * `WebsiteColorPanel` needs a stylesheet and `BrandTokenizerPanel` needs enough
 * prose for an LLM to infer from. A client with neither — no website, nothing
 * written down — currently ends up with tokenizer guesses that the theme engine
 * distrusts and largely discards, so the poster falls back to house amber. This
 * panel is the third route: the operator looks at the brand and says what the
 * colours are.
 *
 * Two constraints shape the controls rather than the copy:
 *
 *   - Fonts are a fixed list, not a text field. The renderer loads faces by name
 *     from a closed table and silently substitutes its default for anything else,
 *     so a free-text font would look saved, preview correctly in the browser, and
 *     never appear on a poster.
 *   - A near-black or near-white "primary" is rejected by the accent picker even
 *     when it is genuinely the brand colour. That is measured, not guessed, so it
 *     is worth saying before the save rather than leaving it to be discovered.
 */

/** Starting points when a role has never been set. */
const SEED_HEX: Record<BrandColorRole, string> = {
  primary: '#1f6feb',
  secondary: '#0d2447',
  accent: '#f0a81e',
  background: '#f6f7f9',
};

const HEX_INPUT_PATTERN = /^#[0-9a-fA-F]{6}$/;

interface ColorRow {
  role: BrandColorRole;
  hex: string;
  enabled: boolean;
}

/**
 * Widens a stored hex to the six-digit form `<input type="color">` accepts.
 *
 * Stored values may be three-digit shorthand or carry an alpha pair — both parse
 * fine downstream, but a colour input silently ignores a value it cannot read and
 * shows black instead, which reads as "the brand colour is black".
 */
function toPickerHex(raw: string | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    const [r, g, b] = [value[1]!, value[2]!, value[3]!];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{8}$/.test(value)) return value.slice(0, 7).toLowerCase();
  if (HEX_INPUT_PATTERN.test(value)) return value.toLowerCase();
  return null;
}

function seedRows(guideline: BrandGuideline): ColorRow[] {
  return BRAND_COLOR_ROLES.map((role) => {
    const existing = guideline.colors.find(
      (color) => color.role.trim().toLowerCase() === role,
    );
    return {
      role,
      hex: toPickerHex(existing?.hex) ?? SEED_HEX[role],
      enabled: existing !== undefined,
    };
  });
}

export function ManualBrandPanel({
  clientId,
  companyName,
  guideline,
}: {
  clientId: string;
  companyName: string;
  guideline: BrandGuideline;
}) {
  const [rows, setRows] = React.useState<ColorRow[]>(() => seedRows(guideline));
  const [headingFont, setHeadingFont] = React.useState(
    () => guideline.typography?.headingFont ?? DEFAULT_HEADING_FONT,
  );
  const [bodyFont, setBodyFont] = React.useState(
    () => guideline.typography?.bodyFont ?? DEFAULT_BODY_FONT,
  );
  const [vibe, setVibe] = React.useState(
    () => guideline.typography?.vibeClassification ?? '',
  );
  const [directives, setDirectives] = React.useState(() =>
    guideline.layoutDirectives.join('\n'),
  );
  const [flash, setFlash] = React.useState<string | null>(null);
  // Bumped on save so the preview refetches instead of serving the cached PNG of
  // the palette that was just replaced.
  const [previewKey, setPreviewKey] = React.useState(0);

  const save = useAction(applyManualBrandTokens);

  React.useEffect(() => {
    if (flash === null) return undefined;
    const timer = setTimeout(() => setFlash(null), 6_000);
    return () => clearTimeout(timer);
  }, [flash]);

  const enabled = rows.filter((row) => row.enabled);
  const malformed = enabled.some((row) => !HEX_INPUT_PATTERN.test(row.hex));

  /**
   * Colours already stored under a role this panel does not offer. The tokenizer
   * emits free-text roles ("brand blue", "cta"), and saving here replaces the
   * palette wholesale — so those disappear, and that should not be a surprise.
   */
  const droppedRoles = guideline.colors
    .map((color) => color.role.trim())
    .filter(
      (role) => !BRAND_COLOR_ROLES.includes(role.toLowerCase() as BrandColorRole),
    );

  const primary = rows.find((row) => row.role === 'primary');
  const weakPrimary =
    primary?.enabled === true &&
    HEX_INPUT_PATTERN.test(primary.hex) &&
    accentScore(primary.hex) < MEASURED_MIN_ACCENT_SCORE;

  function updateRow(role: BrandColorRole, patch: Partial<ColorRow>) {
    setRows((current) =>
      current.map((row) => (row.role === role ? { ...row, ...patch } : row)),
    );
  }

  async function handleSave() {
    setFlash(null);

    const result = await save.run(clientId, {
      colors: enabled.map((row) => ({ role: row.role, hex: row.hex })),
      headingFont,
      bodyFont,
      vibeClassification: vibe.trim() || undefined,
      layoutDirectives: directives
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== ''),
    });

    if (result.ok) {
      setPreviewKey((key) => key + 1);
      setFlash(
        `Saved ${result.data.colors} colour(s) for ${companyName}. These are marked as chosen, not guessed, so the poster theme honours them directly.`,
      );
    }
  }

  return (
    <section className="rounded-2xl border border-border bg-background p-5">
      <div className="flex items-center gap-2">
        <Palette className="h-4 w-4 text-brand-to" />
        <h3 className="text-xs font-semibold uppercase tracking-[0.22em] text-foreground">
          Set brand tokens by hand
        </h3>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        For clients with no website to read and nothing written down to tokenize. What
        you set here is recorded as an operator decision, so the poster theme uses your
        role labels as given instead of re-ranking them by measurement.
      </p>

      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0 space-y-5">
          {/* ---- Palette ---- */}
          <div className="space-y-2">
            <Label>Palette</Label>
            <ul className="space-y-2">
              {rows.map((row) => {
                const valid = HEX_INPUT_PATTERN.test(row.hex);
                const ratio = valid ? contrastRatio(bestTextOn(row.hex), row.hex) : 0;

                return (
                  <li
                    key={row.role}
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2"
                  >
                    <input
                      type="checkbox"
                      id={`brand-role-${row.role}`}
                      checked={row.enabled}
                      onChange={(event) =>
                        updateRow(row.role, { enabled: event.target.checked })
                      }
                      className="h-4 w-4 shrink-0 accent-brand-to"
                    />

                    <label
                      htmlFor={`brand-role-${row.role}`}
                      className="w-36 shrink-0 text-xs text-foreground"
                    >
                      {describeColorRole(row.role)}
                    </label>

                    <input
                      type="color"
                      aria-label={`${describeColorRole(row.role)} colour`}
                      value={valid ? row.hex : SEED_HEX[row.role]}
                      disabled={!row.enabled}
                      onChange={(event) =>
                        updateRow(row.role, { hex: event.target.value.toLowerCase() })
                      }
                      className="h-8 w-12 shrink-0 cursor-pointer rounded-md border border-border bg-background disabled:cursor-not-allowed disabled:opacity-40"
                    />

                    <Input
                      aria-label={`${describeColorRole(row.role)} hex value`}
                      value={row.hex}
                      disabled={!row.enabled}
                      onChange={(event) =>
                        updateRow(row.role, { hex: event.target.value.trim() })
                      }
                      className="h-8 w-28 shrink-0 font-mono text-xs"
                    />

                    {row.enabled && valid && (
                      <span
                        aria-hidden
                        className="shrink-0 rounded px-2 py-1 text-[10px] font-semibold"
                        style={{ backgroundColor: row.hex, color: bestTextOn(row.hex) }}
                      >
                        Text {ratio.toFixed(1)}:1
                      </span>
                    )}

                    {row.enabled && !valid && (
                      <span role="alert" className="text-[10px] text-danger-ink">
                        Needs a 6-digit hex
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>

            {weakPrimary && (
              <p className="flex items-start gap-1.5 text-[10px] text-warning-ink">
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                <span>
                  That primary is close to black or white. It saves fine, but the theme
                  engine will not use it as the headline accent — near-neutral colours
                  cannot carry type — and will rank the rest of the palette instead. Set
                  a highlight accent too if you want control over that choice.
                </span>
              </p>
            )}

            {droppedRoles.length > 0 && (
              <p className="flex items-start gap-1.5 text-[10px] text-warning-ink">
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                <span>
                  Saving replaces the whole palette, which drops {droppedRoles.length}{' '}
                  existing colour(s) filed under {droppedRoles.slice(0, 3).join(', ')}
                  {droppedRoles.length > 3 ? '…' : ''}.
                </span>
              </p>
            )}
          </div>

          {/* ---- Typography ---- */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="brand-heading-font">Heading font</Label>
              <Select value={headingFont} onValueChange={setHeadingFont}>
                <SelectTrigger id="brand-heading-font">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {HEADING_FONT_OPTIONS.map((family) => (
                    <SelectItem key={family} value={family}>
                      {family}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="brand-body-font">Body font</Label>
              <Select value={bodyFont} onValueChange={setBodyFont}>
                <SelectTrigger id="brand-body-font">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {BODY_FONT_OPTIONS.map((family) => (
                    <SelectItem key={family} value={family}>
                      {family}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <p className="text-[10px] text-muted-foreground/70">
            Only these faces are offered because the renderer fetches them by name at
            render time. A family outside the list has no bytes to load, and the poster
            would quietly fall back to {DEFAULT_HEADING_FONT}.
          </p>

          {/* ---- Vibe + directives ---- */}
          <div className="space-y-1.5">
            <Label htmlFor="brand-vibe">Vibe (optional)</Label>
            <Input
              id="brand-vibe"
              value={vibe}
              maxLength={48}
              onChange={(event) => setVibe(event.target.value)}
              placeholder="confident, industrial"
            />
            <p className="text-[10px] text-muted-foreground/70">
              A few words. Goes into the caption prompt as the brand&apos;s voice.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="brand-directives">Layout directives (optional)</Label>
            <textarea
              id="brand-directives"
              value={directives}
              rows={4}
              onChange={(event) => setDirectives(event.target.value)}
              placeholder={'One per line, e.g.\nKeep headlines to three words\nNever place text over faces'}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            />
            <p className="text-[10px] text-muted-foreground/70">
              Read verbatim by the copy prompts. Up to eight lines.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              onClick={handleSave}
              disabled={save.pending || enabled.length === 0 || malformed}
            >
              {save.pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save brand tokens
            </Button>

            {enabled.length === 0 && (
              <span className="text-[11px] text-muted-foreground">
                Tick at least one colour.
              </span>
            )}

            {flash && (
              <span className="flex items-start gap-1.5 text-[11px] text-success-ink">
                <Check className="mt-px h-3.5 w-3.5 shrink-0" />
                {flash}
              </span>
            )}

            {save.error && (
              <span role="alert" className="text-[11px] text-danger-ink">
                {save.error}
              </span>
            )}
          </div>
        </div>

        {/* ---- Preview ---- */}
        <div className="shrink-0 space-y-1.5">
          <Label>Poster preview</Label>
          {/* eslint-disable-next-line @next/next/no-img-element -- one-off PNG from
              a dynamic route; next/image would proxy and cache a preview whose whole
              purpose is to reflect the palette that was just saved. */}
          <img
            src={`/api/poster/preview?clientId=${encodeURIComponent(clientId)}&v=${previewKey}`}
            alt={`Poster preview using ${companyName}'s saved brand tokens`}
            className="w-40 rounded-lg border border-border bg-muted"
          />
          <p className="w-40 text-[10px] text-muted-foreground/70">
            Saved tokens, real renderer, placeholder photo, and this vertical&apos;s own
            approved layout. Costs nothing — refresh after saving to see a change. If it
            fails to load, the vertical has no approved template and this client cannot
            generate at all yet.
          </p>
        </div>
      </div>
    </section>
  );
}
