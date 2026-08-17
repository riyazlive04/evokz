import { NextResponse, type NextRequest } from 'next/server';

import {
  DEFAULT_IMAGE_SIZE_ID,
  getImageSizePreset,
  resolveImageSizePreset,
} from '@/lib/image-sizes';
import { resolvePosterArchetype } from '@/lib/ai-pipeline';
import { loadCategoryArchetypes } from '@/lib/poster/archetype-library';
import { createPlaceholderPhoto } from '@/lib/poster/placeholder-photo';
import {
  resolvePhotoRequest,
  resolveSpecPhotoRequests,
} from '@/lib/poster/photo-request';
import { renderPoster } from '@/lib/poster/render';
import { prisma } from '@/lib/prisma';
import { parseBrandGuideline, EMPTY_BRAND_GUIDELINE } from '@/lib/types/brand';
import { parseLayoutDraft } from '@/lib/types/layout-spec';
import {
  parsePosterCopy,
  posterArchetypeSchema,
  type PosterArchetype,
  type PosterCopy,
} from '@/lib/types/poster';

/**
 * Renders one poster for the admin preview grid.
 *
 * Exists so a layout change can be inspected without spending anything: the
 * background photo is generated procedurally, and no fal.ai, Drive or WhatsApp call
 * is made. Everything downstream of the photo — theme resolution, font loading,
 * archetype composition — is the exact production path, so what this returns is
 * what a client would receive.
 *
 * Query parameters:
 *   archetype  any id in `POSTER_ARCHETYPES` — the eight bases or their
 *              variants, not only the subset the day-number rotation uses
 *              (default `scrim`)
 *   templateId a `CategoryTemplate` whose extracted layout spec to render.
 *              This is the review surface: it renders a spec that has NOT been
 *              approved yet, which is the whole point — an operator has to see
 *              the layout as a poster before `layoutApprovedAt` is set and it
 *              starts reaching clients. Wins over `archetype`.
 *   preset     an `IMAGE_SIZE_PRESETS` id (default WhatsApp Status)
 *   clientId   render with a real client's brand, logo and contact details
 *   day        calendar day whose stored copy to use, with `clientId`
 *   tone       `dusk` | `daylight` placeholder photo
 */

// The renderer reads fonts from the filesystem and composes Buffers, so this must
// not be pushed to the edge runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const archetypeParam = posterArchetypeSchema.safeParse(params.get('archetype'));

  const preset =
    getImageSizePreset(params.get('preset')) ??
    resolveImageSizePreset(DEFAULT_IMAGE_SIZE_ID, '');

  const tone = params.get('tone') === 'daylight' ? 'daylight' : 'dusk';
  const clientId = params.get('clientId');
  const templateId = params.get('templateId');
  const day = Number.parseInt(params.get('day') ?? '', 10);

  try {
    const context = clientId
      ? await loadClientContext(clientId, Number.isFinite(day) ? day : null)
      : null;

    if (clientId && !context) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 });
    }

    /*
     * Deliberately reads the spec whether or not it has been approved, and
     * deliberately ignores `layoutApprovedAt`. Approval is a statement that an
     * operator has seen the layout rendered, and they cannot see it rendered
     * until something renders it — gating this endpoint on the flag it exists to
     * inform would make the review step impossible to perform.
     */
    const draft = templateId ? await loadTemplateLayout(templateId) : null;
    const layoutSpec = draft && draft.problems.length === 0 ? draft.spec : null;

    if (templateId && !layoutSpec) {
      /*
       * Names the actual fault. The first version of this said "run extraction
       * first" for every null, which is wrong and expensive: the common case is
       * a draft that extracted perfectly well and was then refused for a
       * structural reason — two headlines, a photo cell holding text — and an
       * operator told to re-run extraction will re-run it, get the same draft,
       * and have no idea what to do next.
       */
      return NextResponse.json(
        {
          error:
            draft && draft.problems.length > 0
              ? 'This template’s layout was read but cannot render yet.'
              : 'No layout has been read from this template yet. Open the vertical ' +
                'in the console and use “Read layout” on its card.',
          ...(draft && draft.problems.length > 0
            ? {
                problems: draft.problems.map((p) => `${p.path} ${p.message}`),
                fix: 'Open the vertical in the console; the template card has the draft loaded in its editor.',
              }
            : {}),
        },
        { status: 404 },
      );
    }

    /*
     * An explicit `archetype` wins — the preview grid names one per tile, which is
     * what makes it a catalogue.
     *
     * Without one, and given a real client, this resolves exactly as the pipeline
     * would: the row's stored pin, else the layouts mapped to that client's
     * vertical, else the day-number rotation. That is what lets an operator check
     * "what will this client actually receive on day 4" rather than only "what does
     * layout X look like".
     */
    const archetype: PosterArchetype = archetypeParam.success
      ? archetypeParam.data
      : context
        ? resolvePosterArchetype(
            context.storedArchetype,
            Number.isFinite(day) ? day : 1,
            await loadCategoryArchetypes(context.categoryId),
          )
        : 'scrim';

    // Shaped exactly as the pipeline would shape it, so a cropping problem shows up
    // in the preview rather than only in production — but capped in absolute size.
    //
    // The cap is not an optimisation. The placeholder is PNG, and PNG on a
    // photographic gradient runs several times larger than the JPEG fal returns;
    // base64 then inflates it by a third into the SVG string that resvg has to parse.
    // At full print-preset dimensions that was enough to exhaust the dev server's
    // heap and kill the process mid-request. Only the aspect ratio matters for
    // judging a layout, so the long edge is bounded and the production path — which
    // uses the real photo at full size — is untouched.
    const requests = layoutSpec
      ? resolveSpecPhotoRequests(layoutSpec, preset)
      : [resolvePhotoRequest(archetype, preset)];

    const photos = requests.map((request, index) => {
      const placeholder = capLongEdge(request.width, request.height, 1280);
      // Alternating tone across a multi-photo spec: two identical procedural
      // frames make it impossible to tell which cell received which request,
      // which is exactly what this preview exists to show.
      const frameTone = index % 2 === 0 ? tone : tone === 'dusk' ? 'daylight' : 'dusk';
      return createPlaceholderPhoto(placeholder.width, placeholder.height, frameTone);
    });

    const poster = await renderPoster({
      archetype,
      layoutSpec,
      dayNumber: Number.isFinite(day) ? day : 1,
      copy: context?.copy ?? SAMPLE_COPY,
      guideline: context?.guideline ?? EMPTY_BRAND_GUIDELINE,
      identity: context?.identity ?? SAMPLE_IDENTITY,
      photos,
      width: preset.width,
      height: preset.height,
    });

    return new NextResponse(poster.body as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        // Never cached: the point of the preview is to reflect the current code.
        'Cache-Control': 'no-store, max-age=0',
        'X-Poster-Archetype': poster.archetype,
        'X-Poster-Dropped': poster.dropped.join(',') || 'none',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown render failure';
    console.error('[ace:poster-preview]', error);

    // Satori reports layout and asset faults as terse one-liners ("Invalid URL",
    // "Unsupported image type") with no indication of which element produced them,
    // so `?debug=1` appends the stack. Opt-in rather than always on: the body is
    // normally consumed by an <img>, where a stack is just noise.
    const detail =
      params.get('debug') === '1' && error instanceof Error && error.stack
        ? `\n\n${error.stack}`
        : '';

    // Plain text rather than JSON: this endpoint is consumed by an <img>, and a
    // readable body is what shows up in the network panel when one breaks.
    return new NextResponse(`Poster render failed: ${message}${detail}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

/** Scales a size down so its long edge is at most `max`, preserving aspect. */
function capLongEdge(
  width: number,
  height: number,
  max: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const ratio = max / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

async function loadTemplateLayout(templateId: string) {
  const template = await prisma.categoryTemplate.findUnique({
    where: { id: templateId },
    select: { layoutSpec: true },
  });
  if (!template) return null;
  return parseLayoutDraft(template.layoutSpec);
}

async function loadClientContext(clientId: string, day: number | null) {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      companyName: true,
      whatsappNumber: true,
      categoryId: true,
      brandGuideline: true,
      logoUrl: true,
      logoIncludesName: true,
      brandTagline: true,
      websiteUrl: true,
      displayPhone: true,
      calendarDays: day
        ? {
            where: { dayNumber: day },
            select: { posterCopy: true, posterArchetype: true },
            take: 1,
          }
        : false,
    },
  });

  if (!client) return null;

  const entry = client.calendarDays?.[0] ?? null;
  const stored = day ? parsePosterCopy(entry?.posterCopy ?? null) : null;

  return {
    categoryId: client.categoryId,
    storedArchetype: entry?.posterArchetype ?? null,
    guideline: parseBrandGuideline(client.brandGuideline),
    // Falls back to the sample rather than 404ing: an operator previewing a client
    // that has not been seeded yet still wants to see their palette and logo
    // applied to the layout.
    copy: stored ?? SAMPLE_COPY,
    identity: {
      companyName: client.companyName,
      logoUrl: client.logoUrl,
      logoIncludesName: client.logoIncludesName,
      brandTagline: client.brandTagline,
      websiteUrl: client.websiteUrl,
      displayPhone: client.displayPhone,
      whatsappNumber: client.whatsappNumber,
    },
  };
}

/**
 * Stand-in copy for previewing with no client selected.
 *
 * Real English rather than lorem ipsum on purpose: the layout has to be judged at
 * realistic word lengths, and lorem's unusually short words make headlines fit that
 * would overflow in production.
 */
const SAMPLE_COPY: PosterCopy = {
  headlineLines: ['PREMIUM', 'COMMERCIAL', 'SPACES'],
  accentLineIndex: 1,
  eyebrow: 'NOW LEASING',
  body: 'Built for business and designed for growth, with infrastructure that scales alongside your team.',
  features: [
    {
      icon: 'locationPin',
      label: 'Strategic Locations',
      body: 'Positioned on the corridors your customers already travel.',
    },
    {
      icon: 'building',
      label: 'Smart Infrastructure',
      body: 'Power, data and access control specified for continuous operation.',
    },
    {
      icon: 'leaf',
      label: 'Sustainable Build',
      body: 'Lower running costs across the whole life of the lease.',
    },
  ],
  callLabel: 'CALL US TODAY',
  websiteLabel: 'VISIT OUR WEBSITE',
  headlinePeriod: false,
};

const SAMPLE_IDENTITY = {
  companyName: 'Evokz Preview',
  logoUrl: null,
  brandTagline: 'BUILT TO A HIGHER SPEC',
  websiteUrl: 'www.example.com',
  displayPhone: '+91 98765 43210',
  whatsappNumber: '919876543210',
};
