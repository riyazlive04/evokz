import type { StudioBrandContext } from '@/lib/ai/studio-prompts';
import { formatPhone, normalizeTagline, normalizeWebsite } from '@/lib/brand/identity-format';
import {
  hasBrandCanvasLogo,
  resolveStudioLogo,
  type BrandCanvasLogoFields,
  type StudioLogoProcessing,
} from '@/lib/poster-studio/brand-logo';
import { StudioError } from '@/lib/poster-studio/errors';
import type { StudioLogoBackground } from '@/lib/poster-studio/limits';
import { resolvePosterTheme } from '@/lib/poster/theme';
import { prisma } from '@/lib/prisma';
import { parseBrandGuideline, type BrandGuideline } from '@/lib/types/brand';

/**
 * A client's existing Brand Canvas, as the AI Poster Studio uses it.
 *
 * **Brand Canvas is the single source of truth.** Everything here is read from
 * the `Client` row and `Client.brandGuideline` — the same columns the Brand
 * Canvas page edits and the delivery renderer draws from — at the moment a poster
 * is made. Nothing is copied into studio tables and nothing is written back.
 *
 * `brandGuideline` goes through `parseBrandGuideline`, the single narrowing point
 * for that column. The first studio version read `primaryColor` / `palette`,
 * which the tokenizer has never written, so no client's colours reached a prompt.
 *
 * Only what is stored comes back. Missing values stay null; nothing is filled in
 * to look complete.
 */

/** Colours and directives sent to the prompt, most dominant first. */
const MAX_PROMPT_COLORS = 6;
const MAX_PROMPT_DIRECTIVES = 6;

export interface StudioBrandCanvas {
  clientId: string;
  companyName: string;
  guideline: BrandGuideline;
  /** Visual direction for the image model. */
  brand: StudioBrandContext;
  /** Server-only: holds Drive ids and URLs. Never sent to the browser. */
  logo: BrandCanvasLogoFields;
  logoIncludesName: boolean;
  /** Exact values the identity overlay prints, display-formatted like the renderer's. */
  tagline: string | null;
  website: string | null;
  phone: string | null;
  /** The phone is derived from the WhatsApp number because no display phone is set. */
  phoneIsFallback: boolean;
}

export async function loadStudioBrandCanvas(clientId: string): Promise<StudioBrandCanvas> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      companyName: true,
      brandTagline: true,
      brandGuideline: true,
      websiteUrl: true,
      displayPhone: true,
      whatsappNumber: true,
      logoUrl: true,
      logoDriveFileId: true,
      logoOriginalUrl: true,
      logoOriginalDriveFileId: true,
      logoBackgroundRemoved: true,
      logoIncludesName: true,
      category: { select: { name: true } },
    },
  });

  if (!client) {
    throw new StudioError(
      'validation',
      'The selected client no longer exists. Choose another client or use generic studio mode.',
    );
  }

  const guideline = parseBrandGuideline(client.brandGuideline);
  const tagline = normalizeTagline(client.brandTagline);
  const phone = formatPhone(client.displayPhone, client.whatsappNumber) || null;

  return {
    clientId: client.id,
    companyName: client.companyName,
    guideline,
    brand: {
      companyName: client.companyName,
      industry: client.category?.name?.trim() || null,
      tagline,
      colors: guideline.colors
        .slice(0, MAX_PROMPT_COLORS)
        .map((color) => ({ hex: color.hex.toUpperCase(), role: color.role.trim().toLowerCase() })),
      typography: guideline.typography
        ? {
            headingFont: guideline.typography.headingFont,
            bodyFont: guideline.typography.bodyFont,
            vibe: guideline.typography.vibeClassification?.trim() || null,
          }
        : null,
      layoutDirectives: guideline.layoutDirectives
        .map((directive) => directive.trim())
        .filter(Boolean)
        .slice(0, MAX_PROMPT_DIRECTIVES),
    },
    logo: {
      logoUrl: client.logoUrl,
      logoDriveFileId: client.logoDriveFileId,
      logoOriginalUrl: client.logoOriginalUrl,
      logoOriginalDriveFileId: client.logoOriginalDriveFileId,
      logoBackgroundRemoved: client.logoBackgroundRemoved,
    },
    logoIncludesName: client.logoIncludesName,
    tagline,
    website: normalizeWebsite(client.websiteUrl),
    phone,
    phoneIsFallback: Boolean(phone) && !client.displayPhone?.trim(),
  };
}

// ---------------------------------------------------------------------------
// Browser-safe summary
// ---------------------------------------------------------------------------

/**
 * What the studio panel shows for a selected client. Values an operator already
 * sees on the Brand Canvas page are included; storage details are not — no Drive
 * ids, no logo URLs, no folder ids.
 */
export interface StudioBrandCanvasSummary {
  clientId: string;
  companyName: string;
  industry: string | null;
  logo: {
    available: boolean;
    /** Brand Canvas has already made a transparent version. */
    backgroundRemovedInBrandCanvas: boolean;
    includesName: boolean;
    /** Set when the logo exists but could not be read. */
    loadError: string | null;
    removal: {
      possible: boolean;
      /** How "Remove background" would be satisfied, when possible. */
      via: StudioLogoProcessing | null;
      /** Why it is not possible — the keyer's own explanation. */
      message: string | null;
    };
    defaultBackground: StudioLogoBackground;
  };
  colors: Array<{ hex: string; role: string }>;
  typography: { headingFont: string; bodyFont: string; vibe: string | null } | null;
  /** The faces the overlay will actually draw with, after mapping to loadable fonts. */
  overlayFonts: { heading: string; body: string };
  tagline: string | null;
  website: string | null;
  phone: string | null;
  phoneIsFallback: boolean;
  layoutDirectives: string[];
}

export async function summarizeStudioBrandCanvas(
  canvas: StudioBrandCanvas,
): Promise<StudioBrandCanvasSummary> {
  const available = hasBrandCanvasLogo(canvas.logo);
  const defaultBackground: StudioLogoBackground = canvas.logo.logoBackgroundRemoved ? 'REMOVED' : 'ORIGINAL';

  let loadError: string | null = null;
  let removal: StudioBrandCanvasSummary['logo']['removal'] = { possible: false, via: null, message: null };

  if (available) {
    try {
      const removed = await resolveStudioLogo(canvas.logo, 'REMOVED');
      removal = { possible: true, via: removed.processing, message: null };
    } catch (error) {
      if (error instanceof StudioError && error.kind === 'logo-background') {
        removal = { possible: false, via: null, message: error.message };
        // The original must still be readable for "Keep original" to be offered.
        try {
          await resolveStudioLogo(canvas.logo, 'ORIGINAL');
        } catch (originalError) {
          loadError = originalError instanceof StudioError ? originalError.message : 'The logo could not be read.';
        }
      } else {
        loadError = error instanceof StudioError ? error.message : 'The logo could not be read.';
      }
    }
  }

  const theme = resolvePosterTheme(canvas.guideline);

  return {
    clientId: canvas.clientId,
    companyName: canvas.companyName,
    industry: canvas.brand.industry,
    logo: {
      available,
      backgroundRemovedInBrandCanvas: canvas.logo.logoBackgroundRemoved,
      includesName: canvas.logoIncludesName,
      loadError,
      removal,
      defaultBackground,
    },
    colors: canvas.brand.colors,
    typography: canvas.brand.typography,
    overlayFonts: { heading: theme.headingFont.family, body: theme.bodyFont.family },
    tagline: canvas.tagline,
    website: canvas.website,
    phone: canvas.phone,
    phoneIsFallback: canvas.phoneIsFallback,
    layoutDirectives: canvas.brand.layoutDirectives,
  };
}
