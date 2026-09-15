import type { StudioBrandContext } from '@/lib/ai/studio-prompts';
import { StudioError } from '@/lib/poster-studio/errors';
import { prisma } from '@/lib/prisma';
import { parseBrandGuideline } from '@/lib/types/brand';

/**
 * Resolves a stored client into the brand facts a studio prompt can use.
 *
 * Reads `brandGuideline` through `parseBrandGuideline`, the single narrowing
 * point for that column. The first version read `primaryColor` / `palette`,
 * which the brand tokenizer has never written — it stores `colors: [{ hex, role }]`
 * — so no client's colours ever reached a prompt.
 *
 * Only what is stored comes back. A client with no guideline yet still gets its
 * name, industry and tagline; nothing is filled in to look complete.
 */

/** Colours sent to the prompt, most dominant first as the tokenizer orders them. */
const MAX_PROMPT_COLORS = 6;
const MAX_PROMPT_DIRECTIVES = 6;

export interface ResolvedStudioClient {
  id: string;
  companyName: string;
  brand: StudioBrandContext;
}

export async function loadStudioClient(clientId: string): Promise<ResolvedStudioClient> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      companyName: true,
      brandTagline: true,
      brandGuideline: true,
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

  return {
    id: client.id,
    companyName: client.companyName,
    brand: {
      companyName: client.companyName,
      industry: client.category?.name?.trim() || null,
      tagline: client.brandTagline?.trim() || null,
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
  };
}
