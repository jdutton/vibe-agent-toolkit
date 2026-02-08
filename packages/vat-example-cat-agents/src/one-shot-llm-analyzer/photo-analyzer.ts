import { executeLLMAnalyzer } from '@vibe-agent-toolkit/agent-runtime';
import type { Agent, LLMError, OneShotAgentOutput } from '@vibe-agent-toolkit/agent-schema';
import { LLM_INVALID_OUTPUT, RESULT_ERROR } from '@vibe-agent-toolkit/agent-schema';
import { z } from 'zod';

// Import compiled resources from markdown
// eslint-disable-next-line sonarjs/unused-import -- Will be used when real vision API is implemented
import * as _PhotoAnalyzerResources from '../../generated/resources/agents/photo-analyzer.js';
import { CatCharacteristicsSchema, type CatCharacteristics } from '../types/schemas.js';
import { extractFurColor as extractFurColorUtil } from '../utils/color-extraction.js';

/**
 * Input schema for photo analysis
 */
export const PhotoAnalyzerInputSchema = z.object({
  imagePathOrBase64: z.string().describe('Path to image file or base64-encoded image'),
  mockable: z.boolean().optional().describe('Whether to use mock mode (default: true)'),
});

export type PhotoAnalyzerInput = z.infer<typeof PhotoAnalyzerInputSchema>;

/**
 * Configuration for photo analyzer behavior
 */
export interface PhotoAnalyzerOptions {
  /**
   * Whether to use real vision API or mock data
   * @default true (mock mode for now)
   */
  mockable?: boolean;
}

/**
 * Analyzes a photo of a cat and extracts characteristics.
 *
 * Archetype: One-Shot LLM Analyzer
 *
 * This would typically call a vision API (like Claude Vision, GPT-4 Vision, etc.)
 * For now, it generates mock data based on the image filename/path.
 *
 * Mock behavior extracts characteristics from common patterns in filenames:
 * - Color keywords: orange, black, white, gray, calico, etc.
 * - Pattern keywords: tabby, striped, spotted, etc.
 * - Size keywords: tiny, small, large, etc.
 * - Personality keywords: grumpy, playful, lazy, etc.
 *
 * @param imagePathOrBase64 - Path to image file or base64-encoded image
 * @param options - Configuration options
 * @returns Cat characteristics extracted from the photo
 */
export async function analyzePhoto(
  imagePathOrBase64: string,
  options: PhotoAnalyzerOptions = {},
): Promise<CatCharacteristics> {
  const { mockable = true } = options;

  if (mockable) {
    return mockAnalyzePhoto(imagePathOrBase64);
  }

  throw new Error('Real vision API not implemented yet. Use mockable: true for testing.');
}

/**
 * Mock implementation that generates characteristics from filename patterns.
 */
function mockAnalyzePhoto(imagePath: string): CatCharacteristics {
  const lowerPath = imagePath.toLowerCase();

  // Extract color from filename
  const furColor = extractFurColor(lowerPath);
  const furPattern = extractFurPattern(lowerPath);
  const eyeColor = extractEyeColor(lowerPath);
  const breed = extractBreed(lowerPath);
  const size = extractSize(lowerPath);

  // Extract personality from filename
  const personality = extractPersonality(lowerPath);
  const quirks = extractQuirks(lowerPath);

  // Generate description based on extracted features
  const description = generateDescription(furColor, furPattern, breed, personality, size);

  return {
    physical: {
      furColor,
      furPattern,
      eyeColor,
      breed,
      size,
    },
    behavioral: {
      personality,
      quirks,
    },
    metadata: {
      origin: 'Photo analysis',
      age: 'Unknown',
    },
    description,
  };
}

function extractFurColor(text: string): string {
  // Use shared extraction with photo analyzer default
  const result = extractFurColorUtil(text, 'Gray tabby');

  // Photo analyzer uses slightly different tortoiseshell format
  if (text.toLowerCase().includes('tortie') || text.toLowerCase().includes('tortoiseshell')) {
    return 'Tortoiseshell (black and orange)';
  }

  return result;
}

function extractFurPattern(text: string): string | undefined {
  if (text.includes('tabby')) {
    return 'Tabby';
  }
  if (text.includes('stripe')) {
    return 'Striped';
  }
  if (text.includes('spot')) {
    return 'Spotted';
  }
  if (text.includes('tuxedo')) {
    return 'Tuxedo (bicolor)';
  }
  if (text.includes('calico') || text.includes('tortie')) {
    return 'Patched';
  }

  return undefined;
}

function extractEyeColor(text: string): string | undefined {
  if (text.includes('blue-eye') || text.includes('blueeye')) {
    return 'Blue';
  }
  if (text.includes('green-eye') || text.includes('greeneye')) {
    return 'Green';
  }
  if (text.includes('gold-eye') || text.includes('goldeye') || text.includes('amber')) {
    return 'Amber';
  }

  return undefined;
}

function extractBreed(text: string): string | undefined {
  if (text.includes('persian')) {
    return 'Persian';
  }
  if (text.includes('siamese')) {
    return 'Siamese';
  }
  if (text.includes('maine-coon') || text.includes('mainecoon')) {
    return 'Maine Coon';
  }
  if (text.includes('bengal')) {
    return 'Bengal';
  }
  if (text.includes('ragdoll')) {
    return 'Ragdoll';
  }
  if (text.includes('sphynx')) {
    return 'Sphynx';
  }

  return undefined;
}

const DEFAULT_SIZE = 'medium';
const EXTRA_LARGE_SIZE = 'extra-large';

function extractSize(text: string): 'tiny' | 'small' | 'medium' | 'large' | 'extra-large' | undefined {
  if (text.includes('tiny') || text.includes('kitten')) {
    return 'tiny';
  }
  if (text.includes('small')) {
    return 'small';
  }
  if (text.includes(DEFAULT_SIZE)) {
    return DEFAULT_SIZE;
  }
  if (text.includes('large') || text.includes('big')) {
    return 'large';
  }
  if (text.includes('huge') || text.includes(EXTRA_LARGE_SIZE) || text.includes('giant')) {
    return EXTRA_LARGE_SIZE;
  }

  return DEFAULT_SIZE;
}

function extractPersonality(text: string): string[] {
  const personality: string[] = [];

  if (text.includes('grumpy') || text.includes('angry')) {
    personality.push('Grumpy', 'Judgmental');
  } else if (text.includes('lazy') || text.includes('sleepy')) {
    personality.push('Lazy', 'Relaxed', 'Peaceful');
  } else if (text.includes('playful') || text.includes('energetic')) {
    personality.push('Playful', 'Energetic', 'Curious');
  } else if (text.includes('regal') || text.includes('noble')) {
    personality.push('Regal', 'Distinguished', 'Aloof');
  } else if (text.includes('friendly') || text.includes('social')) {
    personality.push('Friendly', 'Affectionate', 'Social');
  } else if (text.includes('orange')) {
    // Default personality based on color
    personality.push('Confident', 'Bold', 'Adventurous');
  } else if (text.includes('black')) {
    personality.push('Mysterious', 'Elegant', 'Independent');
  } else if (text.includes('white')) {
    personality.push('Graceful', 'Calm', 'Serene');
  } else {
    personality.push('Curious', 'Intelligent', 'Observant');
  }

  return personality;
}

function extractQuirks(text: string): string[] | undefined {
  const quirks: string[] = [];

  if (text.includes('cross-eye') || text.includes('crosseye')) {
    quirks.push('Cross-eyed stare');
  }
  if (text.includes('fluffy') || text.includes('longhair')) {
    quirks.push('Luxuriously fluffy tail');
  }
  if (text.includes('short') && text.includes('tail')) {
    quirks.push('Adorably short tail');
  }
  if (text.includes('polydactyl') || text.includes('extra-toe')) {
    quirks.push('Extra toes (polydactyl)');
  }

  return quirks.length > 0 ? quirks : undefined;
}

function getSizeDescription(size?: 'tiny' | 'small' | 'medium' | 'large' | 'extra-large'): string {
  if (size === 'tiny') {
    return 'tiny';
  }
  if (size === 'small') {
    return 'petite';
  }
  if (size === 'large') {
    return 'large';
  }
  if (size === EXTRA_LARGE_SIZE) {
    return 'magnificently large';
  }
  return '';
}

function generateDescription(
  color: string,
  pattern: string | undefined,
  breed: string | undefined,
  personality: string[],
  size?: 'tiny' | 'small' | 'medium' | 'large' | 'extra-large',
): string {
  const parts: string[] = [];

  // Size
  const sizeDesc = getSizeDescription(size);

  if (sizeDesc) {
    parts.push(`A ${sizeDesc}`);
  } else {
    parts.push('A');
  }

  // Breed
  if (breed) {
    parts.push(breed);
  }

  // Pattern and color
  if (pattern) {
    parts.push(`with ${color.toLowerCase()} ${pattern.toLowerCase()} fur`);
  } else {
    parts.push(`with ${color.toLowerCase()} fur`);
  }

  // Personality
  const mainPersonality = personality[0]?.toLowerCase() ?? 'mysterious';
  parts.push(`and a ${mainPersonality} personality`);

  return parts.join(' ') + '.';
}

/**
 * Photo analyzer agent
 *
 * Pixel is a tech-savvy cat who analyzes photos with computer vision terminology.
 * He uses advanced pattern recognition algorithms (his words) to extract detailed
 * characteristics about cats from their photos.
 *
 * In mock mode, analyzes filename patterns. In real mode, uses vision LLM to analyze actual images.
 */
export const photoAnalyzerAgent: Agent<
  PhotoAnalyzerInput,
  OneShotAgentOutput<CatCharacteristics, LLMError>
> = {
  name: 'photo-analyzer',
  manifest: {
    name: 'photo-analyzer',
    version: '1.0.0',
    description: 'Analyzes cat photos and extracts detailed physical and behavioral characteristics',
    archetype: 'one-shot-llm-analyzer',
    metadata: {
      author: 'Pixel',
      personality: 'Tech-savvy cat who speaks in computer vision terminology',
      requiresVision: true,
      model: 'claude-3-haiku',
    },
  },
  execute: async (input: PhotoAnalyzerInput) => {
    // Validate input
    const parsed = PhotoAnalyzerInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        result: { status: RESULT_ERROR, error: LLM_INVALID_OUTPUT },
      };
    }

    const { imagePathOrBase64, mockable = true } = parsed.data;

    return executeLLMAnalyzer({
      mockable,
      mockFn: () => mockAnalyzePhoto(imagePathOrBase64),
      realFn: async () => {
        throw new Error('Real vision API not implemented yet. Use mockable: true for testing.');
        // When real vision API is implemented, use:
        // systemPrompt: _PhotoAnalyzerResources.fragments.systemPrompt.body
        // See resources/agents/photo-analyzer.md for prompts and domain knowledge
      },
      parseOutput: (raw) => {
        const parsed = JSON.parse(raw as string);
        return CatCharacteristicsSchema.parse(parsed);
      },
      errorContext: 'Photo analysis',
    });
  },
};
