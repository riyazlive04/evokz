import { generateStructured } from '@/lib/ai/openai';

export interface StudioPromptInput {
  userPrompt: string;
  editInstruction?: string;
  referenceAnalysis?: ReferenceAnalysisResult | null;
  aspectRatio: '1024x1024' | '1024x1792' | '1792x1024';
  brandTokens?: {
    companyName?: string;
    tagline?: string;
    primaryColor?: string;
    secondaryColor?: string;
    accentColor?: string;
    industry?: string;
  } | null;
  hybridVectorOverlay?: boolean;
}

export interface ReferenceAnalysisResult {
  composition: string;
  colorPalette: string;
  typographyStyle: string;
  imagerySubject: string;
  layoutHierarchy: string;
  keyDesignElements: string;
}

/**
 * Analyzes an uploaded reference poster image using Vision to extract key visual, layout, and style rules.
 */
export async function analyzeReferencePoster(imageDataUri: string): Promise<ReferenceAnalysisResult> {
  const systemPrompt = `You are an expert graphic designer and visual analyst. 
Analyze the provided reference poster image and extract its core layout, color palette, visual composition, typography hierarchy, and key design elements.
Return a structured JSON object describing these characteristics to guide subsequent AI poster generation.`;

  const userPrompt = `Extract the visual design rules from this reference poster.`;

  const schema = {
    type: 'object',
    properties: {
      composition: { type: 'string', description: 'Layout structure, e.g. diagonal split, top photo band, centered hero, bottom bar' },
      colorPalette: { type: 'string', description: 'Dominant and accent colors, e.g. deep navy ground with gold accent' },
      typographyStyle: { type: 'string', description: 'Headline weight, casing, placement, alignment' },
      imagerySubject: { type: 'string', description: 'Primary subject matter in the photograph or illustration' },
      layoutHierarchy: { type: 'string', description: 'Visual reading order and spacing' },
      keyDesignElements: { type: 'string', description: 'Notable shapes, badges, borders, gradients, or decorative lines' },
    },
    required: ['composition', 'colorPalette', 'typographyStyle', 'imagerySubject', 'layoutHierarchy', 'keyDesignElements'],
    additionalProperties: false,
  };

  try {
    const analysis = await generateStructured<ReferenceAnalysisResult>({
      label: 'studio-reference-analysis',
      systemPrompt,
      userPrompt,
      imageDataUri,
      schema,
      schemaName: 'ReferencePosterAnalysis',
      model: 'gpt-4o', // vision analysis
    });

    return analysis;
  } catch (error) {
    console.warn('[studio-prompts] Vision reference analysis fallback:', error);
    return {
      composition: 'Professional balanced marketing poster composition',
      colorPalette: 'High contrast brand colors',
      typographyStyle: 'Bold modern sans-serif typography hierarchy',
      imagerySubject: 'High quality professional architectural or commercial photography',
      layoutHierarchy: 'Clear visual flow with headline top and contact bar bottom',
      keyDesignElements: 'Clean geometrical framing and subtle gradients',
    };
  }
}

/**
 * Builds the comprehensive DALL-E 3 image generation prompt.
 */
export function buildStudioImagePrompt(input: StudioPromptInput): string {
  const parts: string[] = [];

  // Core Request
  parts.push(`PROMPT: ${input.userPrompt.trim()}`);

  // Edit instructions (if in edit mode)
  if (input.editInstruction && input.editInstruction.trim()) {
    parts.push(`MODIFICATION INSTRUCTION: ${input.editInstruction.trim()}. Apply these specific updates while retaining overall aesthetic consistency.`);
  }

  // Reference Poster Guidance
  if (input.referenceAnalysis) {
    const ref = input.referenceAnalysis;
    parts.push(`VISUAL REFERENCE GUIDANCE:
- Composition: ${ref.composition}
- Color Direction: ${ref.colorPalette}
- Imagery Style: ${ref.imagerySubject}
- Decorative Elements: ${ref.keyDesignElements}`);
  }

  // Brand Rules
  if (input.brandTokens) {
    const b = input.brandTokens;
    const brandParts: string[] = [];
    if (b.companyName) brandParts.push(`Brand Name: ${b.companyName}`);
    if (b.industry) brandParts.push(`Industry: ${b.industry}`);
    if (b.primaryColor) brandParts.push(`Primary Color Accent: ${b.primaryColor}`);
    if (b.accentColor) brandParts.push(`Highlight Accent: ${b.accentColor}`);
    if (brandParts.length > 0) {
      parts.push(`BRAND DIRECTION: ${brandParts.join(', ')}.`);
    }
  }

  // Dimension & Aspect Ratio Specs
  if (input.aspectRatio === '1024x1792') {
    parts.push('FORMAT: Vertical 9:16 social media story/status poster layout.');
  } else if (input.aspectRatio === '1792x1024') {
    parts.push('FORMAT: Horizontal 16:9 banner poster layout.');
  } else {
    parts.push('FORMAT: Square 1:1 Instagram post layout.');
  }

  // Hybrid Vector Note
  if (input.hybridVectorOverlay) {
    parts.push('COMPOSITION NOTE: Leave clean dark/light photographic space for composited vector headlines and logo lockup overlay. Background photography carries no written text.');
  } else {
    parts.push('DESIGN QUALITY: Professional commercial design, elegant contrast, studio lighting, crisp typography hierarchy, premium aesthetic suitable for high-end marketing campaigns.');
  }

  return parts.join('\n\n');
}
