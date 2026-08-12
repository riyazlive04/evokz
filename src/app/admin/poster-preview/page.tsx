import Link from 'next/link';

import { AlertTriangle, Palette } from 'lucide-react';

import { PageHeader } from '@/components/admin/PageHeader';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  DEFAULT_IMAGE_SIZE_ID,
  describeImageSize,
  getImageSizePreset,
  groupedImageSizePresets,
  resolveImageSizePreset,
} from '@/lib/image-sizes';
import { resolveCanvasMode, droppedSlots } from '@/lib/poster/metrics';
import { auditTheme, resolvePosterTheme } from '@/lib/poster/theme';
import { prisma } from '@/lib/prisma';
import { parseBrandGuideline, EMPTY_BRAND_GUIDELINE } from '@/lib/types/brand';
import { describeArchetype, POSTER_ARCHETYPES } from '@/lib/types/poster';

/**
 * Visual regression surface for the poster renderer.
 *
 * Renders every archetype side by side at a chosen output preset, optionally
 * with a real client's brand applied. Costs nothing to refresh — the background
 * photo is generated, not diffused — so it is the right place to judge a layout
 * change before it reaches a client's WhatsApp.
 */

export const dynamic = 'force-dynamic';

export default async function PosterPreviewPage({
  searchParams,
}: {
  searchParams: { preset?: string; clientId?: string; day?: string; tone?: string };
}) {
  const preset =
    getImageSizePreset(searchParams.preset) ??
    resolveImageSizePreset(DEFAULT_IMAGE_SIZE_ID, '');
  const tone = searchParams.tone === 'daylight' ? 'daylight' : 'dusk';
  const clientId = searchParams.clientId ?? '';
  const day = searchParams.day ?? '';

  const clients = await prisma.client.findMany({
    orderBy: { companyName: 'asc' },
    select: { id: true, companyName: true, brandGuideline: true },
    take: 100,
  });

  const selected = clients.find((client) => client.id === clientId) ?? null;
  const guideline = selected
    ? parseBrandGuideline(selected.brandGuideline)
    : EMPTY_BRAND_GUIDELINE;
  const theme = resolvePosterTheme(guideline);
  const warnings = auditTheme(theme);

  const mode = resolveCanvasMode(preset.width, preset.height);
  const dropped = droppedSlots(mode);

  const buildQuery = (overrides: Record<string, string>): string => {
    const query = new URLSearchParams({
      ...(preset.id !== DEFAULT_IMAGE_SIZE_ID ? { preset: preset.id } : {}),
      ...(clientId ? { clientId } : {}),
      ...(day ? { day } : {}),
      ...(tone !== 'dusk' ? { tone } : {}),
      ...overrides,
    });
    for (const [key, value] of [...query.entries()]) {
      if (!value) query.delete(key);
    }
    const rendered = query.toString();
    return rendered ? `?${rendered}` : '';
  };

  return (
    <>
      <PageHeader
        eyebrow="Creative engine"
        title="Poster preview"
        description="Every layout archetype at the selected output size. The background photo is generated locally, so refreshing costs nothing."
      />

      {/* ---- Controls ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Render settings</CardTitle>
          <CardDescription>
            Currently {describeImageSize(preset)} · {preset.label} ·{' '}
            <span className="font-mono">{mode}</span> canvas
            {preset.offBrand && (
              <>
                {' '}
                <Badge variant="amber">off-brand shape</Badge>
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <ControlRow label="Photo tone">
            {(['dusk', 'daylight'] as const).map((option) => (
              <PillLink
                key={option}
                href={buildQuery({ tone: option === 'dusk' ? '' : option })}
                active={tone === option}
              >
                {option}
              </PillLink>
            ))}
          </ControlRow>

          <ControlRow label="Brand">
            <PillLink href={buildQuery({ clientId: '', day: '' })} active={!selected}>
              Sample
            </PillLink>
            {clients.map((client) => (
              <PillLink
                key={client.id}
                href={buildQuery({ clientId: client.id })}
                active={selected?.id === client.id}
              >
                {client.companyName}
              </PillLink>
            ))}
          </ControlRow>

          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Output size
            </p>
            <div className="space-y-2">
              {groupedImageSizePresets().map((group) => (
                <div key={group.group} className="flex flex-wrap items-center gap-1.5">
                  <span className="w-[150px] shrink-0 text-[11px] text-muted-foreground">
                    {group.label}
                  </span>
                  {group.presets.map((option) => (
                    <PillLink
                      key={option.id}
                      href={buildQuery({
                        preset: option.id === DEFAULT_IMAGE_SIZE_ID ? '' : option.id,
                      })}
                      active={preset.id === option.id}
                    >
                      {option.ratio}
                      {option.offBrand ? ' ·' : ''}
                    </PillLink>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* ---- Resolved theme ---- */}
          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Resolved theme · {theme.family} accent family
            </p>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ['darkNeutral', theme.darkNeutral],
                  ['lightNeutral', theme.lightNeutral],
                  ['accent', theme.accent],
                  ['accentOnDark', theme.accentOnDark],
                  ['accentOnLight', theme.accentOnLight],
                ] as const
              ).map(([label, hex]) => (
                <span
                  key={label}
                  className="flex items-center gap-1.5 rounded-full border border-border px-2 py-1 text-[10px]"
                >
                  <span
                    className="h-3 w-3 rounded-full border border-border"
                    style={{ backgroundColor: hex }}
                  />
                  {label}
                  <span className="font-mono text-muted-foreground">{hex}</span>
                </span>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Type: {theme.headingFont.family} headings · {theme.bodyFont.family} body
            </p>
          </div>

          {warnings.length > 0 && (
            <div className="space-y-1 rounded-lg border border-warning/40 bg-warning/5 p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-warning-ink">
                <AlertTriangle className="h-3.5 w-3.5" />
                Contrast below target after correction
              </p>
              {warnings.map((warning) => (
                <p key={warning} className="text-[11px] text-muted-foreground">
                  {warning}
                </p>
              ))}
              <p className="text-[11px] text-muted-foreground">
                This palette cannot fully carry the house look. Worth an account
                conversation rather than a code change.
              </p>
            </div>
          )}

          {dropped.length > 0 && (
            <div className="rounded-lg border border-danger/40 bg-danger/5 p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-danger-ink">
                <AlertTriangle className="h-3.5 w-3.5" />
                This canvas drops: {dropped.join(', ')}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                A {mode} canvas has no room for the full slot skeleton. Pick a portrait
                preset to carry all of it.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---- Every archetype ---- */}
      <section className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
        {POSTER_ARCHETYPES.map((archetype) => (
          <Card key={archetype} className="overflow-hidden">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Palette className="h-3.5 w-3.5 text-brand-to" />
                {archetype}
              </CardTitle>
              <CardDescription className="text-[11px]">
                {describeArchetype(archetype).description}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* A plain img: the route is dynamic and uncached by design, which is
                  exactly what next/image would try to optimise away. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/poster/preview${buildQuery({ archetype })}`}
                alt={`${archetype} archetype preview`}
                width={preset.width}
                height={preset.height}
                className="w-full rounded-lg border border-border bg-muted"
              />
            </CardContent>
          </Card>
        ))}
      </section>

      <p className="text-[11px] text-muted-foreground">
        Layout rules live in{' '}
        <span className="font-mono">docs/creative-style-spec.md</span>. A campaign day
        with no stored archetype cycles through these deterministically, so day 47
        always renders the same way it did the first time.
      </p>
    </>
  );
}

function ControlRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function PillLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={`/admin/poster-preview${href}`}
      className={
        active
          ? 'rounded-full bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground'
          : 'rounded-full border border-border px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground'
      }
    >
      {children}
    </Link>
  );
}
