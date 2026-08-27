import { NextResponse, type NextRequest } from 'next/server';

import {
  DEFAULT_IMAGE_SIZE_ID,
  getImageSizePreset,
  resolveImageSizePreset,
} from '@/lib/image-sizes';
import {
  describeLayoutFailure,
  resolveDayLayout,
} from '@/lib/poster/layout-library';
import {
  createPlaceholderPhoto,
  createPlaceholderSubject,
} from '@/lib/poster/placeholder-photo';
import { downloadDriveFile } from '@/lib/google-drive';
import { resolvePosterCanvas } from '@/lib/poster/canvas';
import { findHtmlTemplateFor } from '@/lib/poster/html/template';
import {
  resolvePlatePhotoRequests,
  resolveSpecPhotoRequests,
  resolveTemplatePhotoRequests,
} from '@/lib/poster/photo-request';
import { renderPoster } from '@/lib/poster/render';
import { verticalKeyFor } from '@/lib/ai/vertical-vocabulary';
import { SAMPLE_LAYOUT_SPEC } from '@/lib/poster/sample-layout';
import { prisma } from '@/lib/prisma';
import { parseBrandGuideline, EMPTY_BRAND_GUIDELINE } from '@/lib/types/brand';
import { parseLayoutDraft, type PosterLayoutSpec } from '@/lib/types/layout-spec';
import { parsePlateSpec } from '@/lib/types/plate-spec';
import { parsePosterCopy, type PosterCopy } from '@/lib/types/poster';

/**
 * Renders one poster without spending anything.
 *
 * The background photo is generated procedurally and no fal.ai, Drive or WhatsApp
 * call is made. Everything downstream of the photo — theme resolution, font
 * loading, spec interpretation — is the exact production path, so what this
 * returns is what a client would receive.
 *
 * Query parameters:
 *   templateId a `CategoryTemplate` whose extracted layout to render. The review
 *              surface: it deliberately renders a spec that has NOT been approved
 *              yet, which is the whole point — an operator has to see the layout
 *              as a poster before `layoutApprovedAt` is set and it starts
 *              reaching clients. Wins over `clientId`.
 *   clientId   render what this client would actually receive, resolving the
 *              layout exactly as the pipeline does. 409s with the same message
 *              the pipeline would fail with when the vertical has none approved.
 *   day        calendar day whose stored copy and template pin to use
 *   preset     an `IMAGE_SIZE_PRESETS` id (default WhatsApp Status)
 *   tone       `dusk` | `daylight` placeholder photo
 *
 * With neither `templateId` nor `clientId` it renders `SAMPLE_LAYOUT_SPEC` — a
 * built-in layout that exists for the brand panel's thumbnail and is never
 * reachable from a client render.
 */

// The renderer reads fonts from the filesystem and composes Buffers, so this must
// not be pushed to the edge runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;


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
     * Three modes, in order of specificity.
     *
     *   templateId  the review surface — that template's draft, approved or not,
     *               handled above so an unreadable one 404s rather than being
     *               quietly substituted.
     *   clientId    what this client would actually receive, resolved exactly as
     *               the pipeline resolves it.
     *   neither     the built-in sample, which is what the brand panel wants: a
     *               palette rendered through the real path, on a vertical that
     *               may have no approved template at all.
     *
     * The sample is never reachable from a client render. `resolveDayLayout`
     * failing for a real client is reported, not papered over — that failure is
     * the operator's signal that the vertical is not shippable.
     */
    let resolved: PosterLayoutSpec = draft?.spec ?? SAMPLE_LAYOUT_SPEC;
    let clientLayoutLabel: string | null = null;
    if (!templateId && context) {
      const layout = await resolveDayLayout({
        categoryId: context.categoryId,
        dayNumber: Number.isFinite(day) ? day : 1,
        pinnedTemplateId: context.pinnedTemplateId,
      });
      if (!layout.ok) {
        return NextResponse.json(
          {
            error: describeLayoutFailure(layout, {
              categoryId: context.categoryId,
              categoryName: context.categoryName,
              dayNumber: Number.isFinite(day) ? day : 1,
            }),
          },
          { status: 409 },
        );
      }
      resolved = layout.spec;
      clientLayoutLabel = layout.label;
    }

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
    /*
     * Resolved exactly as the pipeline resolves it, so the operator reviewing a
     * template sees the shape the client will actually receive. A preview drawn
     * at the preset's aspect while production draws at the template's would make
     * the approval step worse than useless — it would show a poster nobody gets.
     */
    /*
     * A plate, when the template being reviewed has one.
     *
     * `?palette=template|client` overrides the stored choice for this render
     * only, so an operator can see both readings side by side before committing
     * one to the column.
     */
    /*
     * An authored HTML template wins over both other paths.
     *
     * The preview is the review surface, and approval means an operator has seen
     * the template rendered — so it has to render what production would render.
     * Once a template has an HTML file that is what production draws, and a
     * preview still showing the spec interpretation would be approving the wrong
     * artefact.
     *
     * Resolved from the label rather than from a flag, exactly as `renderPoster`
     * resolves it, so the two cannot disagree about which renderer owns a
     * template.
     */
    const htmlTemplate = await findHtmlTemplateFor(draft?.label ?? clientLayoutLabel);

    const paletteParam = params.get('palette');
    // Never loaded for an authored template: the HTML *is* the artwork, so
    // compositing type onto an erased JPEG of the same design would draw it
    // twice.
    const plate = templateId && !htmlTemplate
      ? await loadTemplatePlate(
          templateId,
          paletteParam === 'template' ? true : paletteParam === 'client' ? false : null,
        )
      : null;

    const canvas = resolvePosterCanvas(
      htmlTemplate
        ? { aspect: htmlTemplate.manifest.aspect, name: htmlTemplate.manifest.label }
        : (plate?.spec ?? resolved),
      preset,
    );

    const requests = htmlTemplate
      ? resolveTemplatePhotoRequests(htmlTemplate.manifest, canvas)
      : plate
        ? resolvePlatePhotoRequests(plate.spec, canvas)
        : resolveSpecPhotoRequests(resolved, canvas);

    const photos = requests.map((request, index) => {
      const placeholder = capLongEdge(request.width, request.height, 1280);

      // A subject cell gets a transparent silhouette rather than a landscape, so
      // the preview shows what production shows: a figure standing on the
      // poster's own colour, not a rectangle of sky.
      if (request.kind === 'subject') {
        return createPlaceholderSubject(placeholder.width, placeholder.height);
      }

      // Alternating tone across a multi-photo spec: two identical procedural
      // frames make it impossible to tell which cell received which request,
      // which is exactly what this preview exists to show.
      const frameTone = index % 2 === 0 ? tone : tone === 'dusk' ? 'daylight' : 'dusk';
      return createPlaceholderPhoto(placeholder.width, placeholder.height, frameTone);
    });

    const poster = await renderPoster({
      layoutSpec: resolved,
      copy: context?.copy ?? sampleCopyFor(draft?.categoryName),
      guideline: context?.guideline ?? EMPTY_BRAND_GUIDELINE,
      identity: context?.identity ?? SAMPLE_IDENTITY,
      photos,
      ...(plate ? { plate } : {}),
      ...(htmlTemplate ? { templateLabel: htmlTemplate.manifest.label } : {}),
      width: canvas.width,
      height: canvas.height,
    });

    return new NextResponse(poster.body as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        // Never cached: the point of the preview is to reflect the current code.
        'Cache-Control': 'no-store, max-age=0',
        // Names the layout that drew this, which is how a caller can tell a real
        // template apart from the built-in sample without reading the pixels.
        'X-Poster-Layout': poster.layoutName,
        'X-Poster-Canvas-Mode': poster.canvasMode,
        // The resolved size and why, so a caller can tell a template-driven
        // canvas from a preset-driven one without measuring the PNG.
        'X-Poster-Canvas': `${canvas.width}x${canvas.height}`,
        'X-Poster-Canvas-Reason': canvas.reason,
        // Which path drew this, so a caller can tell a composited poster from a
        // rebuilt one without reading the pixels.
        'X-Poster-Path': htmlTemplate ? 'template' : plate ? 'plate' : 'grid',
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
    // The vertical comes along so the preview can stand the template up in its
    // own trade's words rather than in commercial-property copy.
    select: {
      layoutSpec: true,
      // The label is the registry key for the HTML renderer — see
      // `findHtmlTemplateFor`. Without it this route could only ever preview the
      // spec path, which would leave an authored template unreviewable.
      label: true,
      category: { select: { name: true } },
    },
  });
  if (!template) return null;
  return {
    ...parseLayoutDraft(template.layoutSpec),
    label: template.label,
    categoryName: template.category.name,
  };
}

/**
 * The template's clean plate, ready to composite.
 *
 * Deliberately ignores `plateApprovedAt`, exactly as the layout draft above
 * ignores `layoutApprovedAt` and for the same reason: approval says an operator
 * has seen the plate rendered, and they cannot see it rendered until something
 * renders it. Gating the review surface on the flag it exists to inform would
 * make the review impossible to perform.
 *
 * Returns null when there is no plate, or when its spec cannot be read — both of
 * which fall the preview back to the grid path, which is what production would
 * do too.
 */
async function loadTemplatePlate(templateId: string, useTemplatePalette: boolean | null) {
  const row = await prisma.categoryTemplate.findUnique({
    where: { id: templateId },
    select: { plateSpec: true, plateDriveFileId: true, paletteSource: true },
  });
  if (!row?.plateDriveFileId) return null;

  const spec = parsePlateSpec(row.plateSpec);
  if (!spec) return null;

  let bytes: Buffer;
  try {
    bytes = await downloadDriveFile(row.plateDriveFileId);
  } catch {
    // A plate that cannot be read back is worth showing as "no plate" rather
    // than failing the preview: the grid render still tells the operator
    // something, and the Drive fault surfaces on the template card.
    return null;
  }

  return {
    spec,
    bytes,
    mimeType: 'image/png',
    useTemplatePalette: useTemplatePalette ?? row.paletteSource === 'template',
  };
}

async function loadClientContext(clientId: string, day: number | null) {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      companyName: true,
      whatsappNumber: true,
      categoryId: true,
      category: { select: { name: true } },
      brandGuideline: true,
      logoUrl: true,
      logoIncludesName: true,
      brandTagline: true,
      websiteUrl: true,
      displayPhone: true,
      calendarDays: day
        ? {
            where: { dayNumber: day },
            select: { posterCopy: true, posterTemplateId: true },
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
    categoryName: client.category.name,
    pinnedTemplateId: entry?.posterTemplateId ?? null,
    guideline: parseBrandGuideline(client.brandGuideline),
    // Falls back to the sample rather than 404ing: an operator previewing a client
    // that has not been seeded yet still wants to see their palette and logo
    // applied to the layout. In the client's own vertical, so an unseeded clinic
    // is not previewed in commercial-property words.
    copy: stored ?? sampleCopyFor(client.category.name),
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
  ctaLabel: 'GET STARTED TODAY',
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

/**
 * Stand-in copy in the vertical's own words.
 *
 * `SAMPLE_COPY` above is commercial-property copy, and until this it was what
 * every template previewed in — so an operator checking a *clinic* layout saw
 * "PREMIUM COMMERCIAL SPACES" and "Strategic Locations" sitting in it and
 * concluded, reasonably, that the wrong template was being drawn. It was not:
 * the geometry was theirs and only the words were foreign. But a review surface
 * that has to be explained before it can be trusted is not doing its job.
 *
 * Keyed by the same resolver the image briefs use, so "Medicals" and
 * "Contructions" (sic) both land somewhere real rather than falling through.
 * A vertical with no entry keeps `SAMPLE_COPY`, which is honest: generic copy is
 * better than copy from the wrong trade.
 *
 * Word lengths are held close to the construction original on purpose. The
 * preview exists to show whether a headline overflows its column, so sample copy
 * that is shorter than production would hide the fault it is meant to reveal.
 */
const SAMPLE_COPY_BY_VERTICAL: Record<string, PosterCopy> = {
  healthcaredentalclinics: {
    headlineLines: ['GOOD HEALTH', 'HAPPIER LIFE'],
    accentLineIndex: 1,
    eyebrow: 'NOW ACCEPTING',
    body: 'Consultation, diagnostics and therapy under one roof, with a team that follows up after the visit.',
    features: [
      {
        icon: 'shieldCheck',
        label: 'General Consultation',
        body: 'Same-day appointments across every weekday morning.',
      },
      {
        icon: 'chart',
        label: 'Accurate Diagnostics',
        body: 'Reported on site, so results come back the same day.',
      },
      {
        icon: 'people',
        label: 'Physiotherapy',
        body: 'One-to-one sessions with a plan you take home.',
      },
    ],
    callLabel: 'CALL US TODAY',
    websiteLabel: 'VISIT OUR WEBSITE',
    ctaLabel: 'BOOK AN APPOINTMENT',
    headlinePeriod: false,
  },
  restaurantscafes: {
    headlineLines: ['SLOW COOKED', 'EVERY MORNING'],
    accentLineIndex: 1,
    eyebrow: 'NOW SERVING',
    body: 'A short menu cooked to order, with produce bought the same week and nothing sitting under a lamp.',
    features: [
      { icon: 'leaf', label: 'Fresh Produce', body: 'Bought weekly from growers we can name.' },
      { icon: 'stopwatch', label: 'Cooked To Order', body: 'Nothing held warm, nothing reheated.' },
      { icon: 'star', label: 'Small Menu', body: 'Fewer dishes, each one worth ordering.' },
    ],
    callLabel: 'CALL TO RESERVE',
    websiteLabel: 'SEE THE MENU',
    ctaLabel: 'BOOK A TABLE',
    headlinePeriod: false,
  },
  interiordesign: {
    headlineLines: ['ROOMS THAT', 'WORK HARDER'],
    accentLineIndex: 1,
    eyebrow: 'TAKING PROJECTS',
    body: 'Drawings, materials and site supervision from one studio, so nobody is left coordinating three trades.',
    features: [
      { icon: 'blueprint', label: 'Measured Drawings', body: 'Every millimetre agreed before work starts.' },
      { icon: 'houseInHand', label: 'Turnkey Delivery', body: 'One contract covering the whole fit-out.' },
      { icon: 'award', label: 'Honest Materials', body: 'Specified to last, not to photograph.' },
    ],
    callLabel: 'CALL THE STUDIO',
    websiteLabel: 'SEE OUR WORK',
    ctaLabel: 'BOOK A CONSULTATION',
    headlinePeriod: false,
  },
};

/** The sample copy a template of this vertical should preview in. */
function sampleCopyFor(categoryName: string | null | undefined): PosterCopy {
  const key = verticalKeyFor(categoryName);
  return (key && SAMPLE_COPY_BY_VERTICAL[key]) || SAMPLE_COPY;
}
