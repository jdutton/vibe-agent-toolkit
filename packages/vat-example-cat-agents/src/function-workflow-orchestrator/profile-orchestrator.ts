import { defineFunctionOrchestrator, type Agent } from '@vibe-agent-toolkit/agent-runtime';
import { z } from 'zod';

import { parseDescription } from '../one-shot-llm-analyzer/description-parser.js';
import { generateHaiku } from '../one-shot-llm-analyzer/haiku-generator.js';
import { generateName } from '../one-shot-llm-analyzer/name-generator.js';
import { analyzePhoto } from '../one-shot-llm-analyzer/photo-analyzer.js';
import { validateHaiku } from '../pure-function-tool/haiku-validator.js';
import { validateCatName } from '../pure-function-tool/name-validator.js';
import {
  CatCharacteristicsSchema,
  HaikuSchema,
  HaikuValidationResultSchema,
  NameSuggestionSchema,
  NameValidationResultSchema,
  type CatCharacteristics,
  type Haiku,
  type HaikuValidationResult,
  type NameSuggestion,
  type NameValidationResult,
} from '../types/schemas.js';

/**
 * Input schema for profile orchestration
 */
export const ProfileOrchestratorInputSchema = z.object({
  photo: z.string().optional().describe('Path to photo file or base64-encoded image'),
  description: z.string().optional().describe('Text description of the cat'),
  maxNameAttempts: z.number().optional().default(5).describe('Maximum attempts to generate valid name'),
  maxHaikuAttempts: z.number().optional().default(5).describe('Maximum attempts to generate valid haiku'),
  acceptQuestionable: z.boolean().optional().default(false).describe('Whether to accept questionable names'),
  mockable: z.boolean().optional().default(true).describe('Whether to use mock implementations'),
});

export type ProfileOrchestratorInput = z.infer<typeof ProfileOrchestratorInputSchema>;

/**
 * Output schema for profile results
 */
export const CatProfileSchema = z.object({
  characteristics: CatCharacteristicsSchema,
  name: NameSuggestionSchema,
  nameValidation: NameValidationResultSchema,
  haiku: HaikuSchema,
  haikuValidation: HaikuValidationResultSchema,
  attempts: z.object({
    nameAttempts: z.number(),
    haikuAttempts: z.number(),
  }),
});

export type CatProfileFromSchema = z.infer<typeof CatProfileSchema>;

/**
 * A complete cat profile with all generated content
 */
export interface CatProfile {
  characteristics: CatCharacteristics;
  name: NameSuggestion;
  nameValidation: NameValidationResult;
  haiku: Haiku;
  haikuValidation: HaikuValidationResult;
  attempts: {
    nameAttempts: number;
    haikuAttempts: number;
  };
}

/**
 * Configuration for profile orchestrator
 */
export interface ProfileOrchestratorOptions {
  /**
   * Maximum attempts to generate a valid name before giving up
   * @default 5
   */
  maxNameAttempts?: number;

  /**
   * Maximum attempts to generate a valid haiku before giving up
   * @default 5
   */
  maxHaikuAttempts?: number;

  /**
   * Whether validators should accept "questionable" results
   * @default false (only accept "valid")
   */
  acceptQuestionable?: boolean;

  /**
   * Whether to use mock implementations
   * @default true
   */
  mockable?: boolean;
}

/**
 * Orchestrates the complete cat profile generation workflow.
 *
 * Archetype: Function Workflow Orchestrator
 *
 * This is the main orchestration agent that coordinates all other agents
 * to create a complete cat profile. It demonstrates:
 * - Sequential agent execution
 * - Retry loops with validation
 * - Error handling
 * - State management
 *
 * Workflow:
 * 1. Extract characteristics (from photo OR description)
 * 2. Generate name → Validate → Retry if invalid (up to max attempts)
 * 3. Generate haiku → Validate → Retry if invalid (up to max attempts)
 * 4. Return complete profile
 *
 * @param input - Photo path OR text description
 * @param options - Configuration options
 * @returns Complete cat profile
 */
export async function createCatProfile(
  input: { photo?: string; description?: string },
  options: ProfileOrchestratorOptions = {},
): Promise<CatProfile> {
  const {
    maxNameAttempts = 5,
    maxHaikuAttempts = 5,
    acceptQuestionable = false,
    mockable = true,
  } = options;

  // Step 1: Extract characteristics
  const characteristics = await extractCharacteristics(input, mockable);

  // Step 2: Generate and validate name (with retry loop)
  const { name, nameValidation, attempts: nameAttempts } = await generateValidName(
    characteristics,
    maxNameAttempts,
    acceptQuestionable,
    mockable,
  );

  // Step 3: Generate and validate haiku (with retry loop)
  const { haiku, haikuValidation, attempts: haikuAttempts } = await generateValidHaiku(
    characteristics,
    maxHaikuAttempts,
    mockable,
  );

  return {
    characteristics,
    name,
    nameValidation,
    haiku,
    haikuValidation,
    attempts: {
      nameAttempts,
      haikuAttempts,
    },
  };
}

/**
 * Extracts characteristics from either photo or description.
 */
async function extractCharacteristics(
  input: { photo?: string; description?: string },
  mockable: boolean,
): Promise<CatCharacteristics> {
  if (!input.photo && !input.description) {
    throw new Error('Must provide either photo or description');
  }

  if (input.photo) {
    return analyzePhoto(input.photo, { mockable });
  }

  if (input.description) {
    return parseDescription(input.description, { mockable });
  }

  throw new Error('Unreachable: input validation failed');
}

/**
 * Generates a name and validates it, retrying until valid or max attempts reached.
 */
async function generateValidName(
  characteristics: CatCharacteristics,
  maxAttempts: number,
  acceptQuestionable: boolean,
  mockable: boolean,
): Promise<{
  name: NameSuggestion;
  nameValidation: NameValidationResult;
  attempts: number;
}> {
  let attempts = 0;
  let lastAttempt: { name: NameSuggestion; validation: NameValidationResult } | undefined;

  while (attempts < maxAttempts) {
    attempts++;

    // Generate name (start with 'mixed' strategy, switch to 'safe' after 2 failures)
    const strategy = attempts > 2 ? 'safe' : 'mixed';
    const name = await generateName(characteristics, { mockable, strategy });

    // Validate name
    const validation = validateCatName(name.name, characteristics);

    // Check if we should accept this result
    const isAcceptable = validation.status === 'valid'
      || (acceptQuestionable && validation.status === 'questionable');

    if (isAcceptable) {
      return { name, nameValidation: validation, attempts };
    }

    // Store for fallback
    lastAttempt = { name, validation };
  }

  // Max attempts reached - return the last attempt even if not valid
  if (!lastAttempt) {
    throw new Error('Failed to generate any name suggestions');
  }

  return {
    name: lastAttempt.name,
    nameValidation: lastAttempt.validation,
    attempts,
  };
}

/**
 * Generates a haiku and validates it, retrying until valid or max attempts reached.
 */
async function generateValidHaiku(
  characteristics: CatCharacteristics,
  maxAttempts: number,
  mockable: boolean,
): Promise<{
  haiku: Haiku;
  haikuValidation: HaikuValidationResult;
  attempts: number;
}> {
  let attempts = 0;
  let lastAttempt: { haiku: Haiku; validation: HaikuValidationResult } | undefined;

  while (attempts < maxAttempts) {
    attempts++;

    // Generate haiku (start with 'mixed' strategy, switch to 'valid' after 2 failures)
    const strategy = attempts > 2 ? 'valid' : 'mixed';
    const haiku = await generateHaiku(characteristics, { mockable, strategy });

    // Validate haiku
    const validation = validateHaiku(haiku);

    if (validation.valid) {
      return { haiku, haikuValidation: validation, attempts };
    }

    // Store for fallback
    lastAttempt = { haiku, validation };
  }

  // Max attempts reached - return the last attempt even if not valid
  if (!lastAttempt) {
    throw new Error('Failed to generate any haiku');
  }

  return {
    haiku: lastAttempt.haiku,
    haikuValidation: lastAttempt.validation,
    attempts,
  };
}

/**
 * Formats a cat profile for display.
 */
export function formatCatProfile(profile: CatProfile): string {
  const lines: string[] = [];

  lines.push('╔════════════════════════════════════════════════════════╗');
  lines.push('║              CAT PROFILE GENERATED                     ║');
  lines.push('╚════════════════════════════════════════════════════════╝');
  lines.push('');

  // Characteristics
  lines.push('📋 CHARACTERISTICS');
  lines.push('─────────────────');
  lines.push(`Fur: ${profile.characteristics.physical.furColor}`);
  if (profile.characteristics.physical.furPattern) {
    lines.push(`Pattern: ${profile.characteristics.physical.furPattern}`);
  }
  if (profile.characteristics.physical.breed) {
    lines.push(`Breed: ${profile.characteristics.physical.breed}`);
  }
  if (profile.characteristics.physical.size) {
    lines.push(`Size: ${profile.characteristics.physical.size}`);
  }
  lines.push(`Personality: ${profile.characteristics.behavioral.personality.join(', ')}`);
  if (profile.characteristics.behavioral.quirks) {
    lines.push(`Quirks: ${profile.characteristics.behavioral.quirks.join(', ')}`);
  }
  lines.push('');

  // Name
  lines.push('✨ SUGGESTED NAME');
  lines.push('─────────────────');
  lines.push(`Name: ${profile.name.name}`);
  lines.push(`Status: ${profile.nameValidation.status.toUpperCase()}`);
  lines.push(`Reasoning: ${profile.name.reasoning}`);
  lines.push(`Validation: ${profile.nameValidation.reason}`);
  lines.push(`(Generated after ${profile.attempts.nameAttempts} attempt${profile.attempts.nameAttempts === 1 ? '' : 's'})`);
  lines.push('');

  // Haiku
  lines.push('🎋 COMMEMORATIVE HAIKU');
  lines.push('──────────────────────');
  lines.push(profile.haiku.line1);
  lines.push(profile.haiku.line2);
  lines.push(profile.haiku.line3);
  lines.push('');
  lines.push(`Syllables: ${profile.haikuValidation.syllables.line1}-${profile.haikuValidation.syllables.line2}-${profile.haikuValidation.syllables.line3}`);
  lines.push(`Valid: ${profile.haikuValidation.valid ? 'YES ✓' : 'NO ✗'}`);
  if (!profile.haikuValidation.valid) {
    lines.push(`Errors: ${profile.haikuValidation.errors.join(', ')}`);
  }
  lines.push(`(Generated after ${profile.attempts.haikuAttempts} attempt${profile.attempts.haikuAttempts === 1 ? '' : 's'})`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Profile orchestrator agent
 *
 * Coordinates all other agents to create a complete cat profile.
 * Demonstrates workflow orchestration, retry logic, and state management.
 *
 * Workflow:
 * 1. Extract characteristics (photo OR description)
 * 2. Generate and validate name (with retry)
 * 3. Generate and validate haiku (with retry)
 * 4. Return complete profile
 */
export const profileOrchestratorAgent: Agent<ProfileOrchestratorInput, CatProfile> = defineFunctionOrchestrator(
  {
    name: 'profile-orchestrator',
    description: 'Orchestrates complete cat profile generation workflow with validation and retry logic',
    version: '1.0.0',
    inputSchema: ProfileOrchestratorInputSchema,
    outputSchema: CatProfileSchema,
    metadata: {
      orchestrates: [
        'photo-analyzer',
        'description-parser',
        'name-generator',
        'name-validator',
        'haiku-generator',
        'haiku-validator',
      ],
      retryEnabled: true,
      workflow: 'sequential',
    },
  },
  async (input, _ctx) => {
    // Convert input to the format expected by createCatProfile
    const profileInput: { photo?: string; description?: string } = {
      ...(input.photo && { photo: input.photo }),
      ...(input.description && { description: input.description }),
    };

    const options: ProfileOrchestratorOptions = {
      maxNameAttempts: input.maxNameAttempts ?? 5,
      maxHaikuAttempts: input.maxHaikuAttempts ?? 5,
      acceptQuestionable: input.acceptQuestionable ?? false,
      mockable: input.mockable ?? true,
    };

    // Note: In a real orchestrator context, _ctx would provide utilities like:
    // - _ctx.call(agentName, input) to call other agents
    // - _ctx.parallel(...) for parallel execution
    // - _ctx.retry(...) for retry logic
    // For now, we directly call the existing implementation
    const profile = await createCatProfile(profileInput, options);

    return profile;
  },
);
