import { generateStructured } from '@/lib/ai/openai';
import { prisma } from '@/lib/prisma';
import {
  BRAND_COLOR_ROLES,
  parseBrandGuideline,
  type BrandGuideline,
} from '@/lib/types/brand';

/**
 * Intelligent Brand Tokenizer — blueprint §3B.
 *
 * Ingests unstructured brand material (site copy, scrape records, style notes)
 * and structuralises it into the design-token shape the brand canvas renders.
 */

const SYSTEM_PROMPT = `You are the Structural Architect for Evokz ACE, a creative automation platform.

Your task: extract raw styling characteristics from supplied brand material into a structured design-token specification.

Rules:
- Derive tokens from evidence in the supplied material. Do not invent a palette that contradicts it.
- When the material is thin, infer conservatively from the industry and stated vibe, and prefer fewer, well-justified tokens over padding the list.
- Colours must be 6-digit hex, including the leading "#".
- Provide 3 to 6 colours. Every guideline needs exactly one "primary" and one "background"; add "secondary" and "accent" only when the material supports them.
- headingFont and bodyFont must be real, widely available typeface names (system fonts or Google Fonts) — never a description like "a modern sans".
- vibeClassification is at most four words.
- layoutDirectives are 3 to 6 short imperative rules an image generator can act on (composition, spacing, imagery treatment). No colour or font restatements.`;

/** JSON Schema constraining the response. */
const BRAND_SCHEMA = {
  type: 'object',
  properties: {
    colors: {
      type: 'array',
      description: 'Ordered palette, most dominant first.',
      items: {
        type: 'object',
        properties: {
          hex: { type: 'string', description: 'Six-digit hex colour, e.g. "#1D4ED8".' },
          role: { type: 'string', enum: [...BRAND_COLOR_ROLES] },
        },
        required: ['hex', 'role'],
        additionalProperties: false,
      },
    },
    typography: {
      type: 'object',
      properties: {
        headingFont: { type: 'string' },
        bodyFont: { type: 'string' },
        vibeClassification: { type: 'string' },
      },
      required: ['headingFont', 'bodyFont', 'vibeClassification'],
      additionalProperties: false,
    },
    layoutDirectives: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['colors', 'typography', 'layoutDirectives'],
  additionalProperties: false,
} as const;

export interface TokenizeInput {
  companyName: string;
  categoryName?: string | null;
  /** Raw brand material: site copy, scrape output, style notes, positioning. */
  sourceMaterial: string;
  /** Optional known asset references, carried through untouched. */
  assets?: BrandGuideline['assets'];
  /** Client the token spend is billed to, when called for a stored tenant. */
  clientId?: string;
}

/**
 * Extracts design tokens from raw material. Returns a normalised guideline —
 * the model's output is re-validated through `parseBrandGuideline` so a partial
 * response degrades instead of poisoning the stored JSON.
 */
export async function extractBrandTokens(
  input: TokenizeInput,
): Promise<BrandGuideline> {
  const material = input.sourceMaterial.trim();
  if (material.length < 40) {
    throw new Error(
      'Provide at least a few sentences of brand material — there is nothing to extract from.',
    );
  }

  const raw = await generateStructured<unknown>({
    label: `brand-tokenizer:${input.companyName}`,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: [
      `Company: ${input.companyName}`,
      input.categoryName ? `Industry: ${input.categoryName}` : null,
      '',
      'Brand material:',
      '"""',
      // Bounded so a pasted full-site scrape cannot blow the context window.
      material.slice(0, 24_000),
      '"""',
    ]
      .filter((line) => line !== null)
      .join('\n'),
    schema: BRAND_SCHEMA as unknown as Record<string, unknown>,
    schemaName: 'brand_guideline',
    // Extraction, not invention: keep it near-deterministic so the same material
    // yields a stable palette rather than drifting on every re-run.
    temperature: 0.2,
    maxTokens: 2_000,
    ...(input.clientId
      ? { bill: { clientId: input.clientId, operation: 'brand-tokenizer' as const } }
      : {}),
  });

  const guideline = parseBrandGuideline(raw);

  if (guideline.colors.length === 0 || guideline.typography === null) {
    throw new Error(
      'The tokenizer returned no usable colours or typography. Try supplying richer brand material.',
    );
  }

  // Assets are supplied by the operator, not extracted — carry them through so
  // persisting a fresh extraction does not wipe the asset ledger.
  return { ...guideline, assets: input.assets ?? [] };
}

/** Extracts tokens for a stored client and persists them to `brandGuideline`. */
export async function tokenizeClientBrand(
  clientId: string,
  sourceMaterial: string,
): Promise<BrandGuideline> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      companyName: true,
      brandGuideline: true,
      category: { select: { name: true } },
    },
  });
  if (!client) throw new Error(`Client ${clientId} does not exist`);

  const existing = parseBrandGuideline(client.brandGuideline);

  const guideline = await extractBrandTokens({
    companyName: client.companyName,
    categoryName: client.category.name,
    sourceMaterial,
    assets: existing.assets,
    clientId,
  });

  await prisma.client.update({
    where: { id: clientId },
    // Cast: Prisma types Json input as InputJsonValue, which a structural
    // interface does not satisfy without a widening step.
    data: { brandGuideline: guideline as unknown as object },
  });

  return guideline;
}
