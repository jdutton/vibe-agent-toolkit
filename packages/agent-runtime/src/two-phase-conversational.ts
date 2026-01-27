/**
 * Two-Phase Conversational Assistant Pattern
 *
 * Provides a declarative API for building conversational agents that gather
 * information naturally through dialogue (Phase 1), then extract structured
 * data when ready (Phase 2).
 *
 * This pattern solves the "JSON every turn" anti-pattern where LLMs are asked
 * to return JSON on every conversational turn, fighting their natural
 * conversational behavior.
 */

import { type z } from 'zod';

import {
  buildManifest,
  createAsyncExecuteWrapperWithContext,
  createConversationalContextMapper,
} from './execute-wrapper.js';
import type { Agent, ConversationalContext } from './types.js';

/**
 * Defines a single piece of information to gather
 */
export interface FactorDefinition {
  /** Unique name for this factor (e.g., "musicPreference") */
  name: string;

  /** Human-readable description of what this factor represents */
  description?: string;

  /** Data type of this factor */
  type: 'string' | 'enum' | 'boolean' | 'number';

  /** Valid enum values (required if type is 'enum') */
  values?: string[];

  /** Whether this factor is required to proceed to extraction phase */
  required?: boolean;

  /** Weight/importance multiplier (default: 1) */
  weight?: number;

  /** Guidance for handling user input that doesn't map to valid values */
  clarificationHint?: string;

  /**
   * Natural language mappings from common user phrases to formal values
   * Example: { "big house": "large-house", "flat": "apartment" }
   */
  naturalLanguageMappings?: Record<string, string>;

  /**
   * Examples of valid values to help the LLM understand
   * Example: ["classical", "jazz", "rock"]
   */
  examples?: string[];
}

/**
 * Configuration for Phase 1: Gathering
 */
export interface GatheringPhaseConfig {
  /** Conversational tone (e.g., "friendly", "professional", "enthusiastic") */
  tone?: string;

  /** Factors to gather during conversation */
  factors: FactorDefinition[];

  /**
   * Function to determine if enough information has been gathered
   * Default: all required factors are present
   */
  readinessCheck?: (profile: Record<string, unknown>) => boolean;

  /**
   * Custom guidance to include in the gathering phase prompt
   * Use this to add domain-specific context or instructions
   */
  customGuidance?: string;

  /**
   * Whether to prioritize certain factors in conversation flow
   * If provided, LLM will ask about these factors early
   */
  priorityFactors?: string[];
}

/**
 * Configuration for Phase 2: Extraction
 */
export interface ExtractionPhaseConfig {
  /**
   * Optional function to generate recommendations/results from gathered profile
   * This is called after structured extraction to enhance the output
   */
  generateRecommendations?: (profile: Record<string, unknown>) => unknown;

  /**
   * Whether to use Structured Outputs API (OpenAI gpt-4o-2024-08-06+)
   * for 100% schema adherence. Default: false
   */
  useStructuredOutputs?: boolean;

  /**
   * Custom prompt for extraction phase
   * If not provided, a default extraction prompt is generated
   */
  customExtractionPrompt?: string;
}

/**
 * Complete configuration for two-phase conversational assistant
 */
export interface TwoPhaseConversationalConfig<TInput, TOutput> {
  /** Unique name for the agent */
  name: string;

  /** Human-readable description of what the agent does */
  description: string;

  /** Semantic version (e.g., "1.0.0") */
  version: string;

  /** Zod schema for input validation */
  inputSchema: z.ZodType<TInput>;

  /** Zod schema for output validation (used in extraction phase) */
  outputSchema: z.ZodType<TOutput>;

  /** Gathering phase configuration */
  gatheringPhase: GatheringPhaseConfig;

  /** Extraction phase configuration */
  extractionPhase: ExtractionPhaseConfig;

  /** Whether this agent can be mocked in tests (default: true) */
  mockable?: boolean;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Generates the system prompt for Phase 1: Gathering
 */
export function generateGatheringPrompt(config: GatheringPhaseConfig): string {
  const { tone, factors, customGuidance, priorityFactors } = config;
  const toneValue = tone ?? 'friendly';

  // Build factor descriptions
  const factorDescriptions = factors
    .map((factor) => {
      const factorDesc = factor.description ?? factor.name;
      let desc = `- **${factor.name}**: ${factorDesc}`;

      if (factor.type === 'enum' && factor.values) {
        const quotedValues = factor.values.map((v) => `"${v}"`).join(', ');
        desc += `\n  Valid values: ${quotedValues}`;
      }

      if (factor.clarificationHint) {
        desc += `\n  ${factor.clarificationHint}`;
      }

      if (factor.naturalLanguageMappings) {
        const mappings = Object.entries(factor.naturalLanguageMappings)
          .map(([phrase, value]) => {
            const mapping = `"${phrase}" → "${value}"`;
            return mapping;
          })
          .join(', ');
        desc += `\n  Natural language mappings: ${mappings}`;
      }

      if (factor.required) {
        desc += '\n  (REQUIRED)';
      }

      return desc;
    })
    .join('\n\n');

  // Build priority guidance
  const priorityGuidance = priorityFactors
    ? `\nPrioritize asking about these factors early: ${priorityFactors.join(', ')}`
    : '';

  // Build enum validation rules
  const enumFactors = factors.filter((f) => f.type === 'enum');
  let enumGuidance = '';
  if (enumFactors.length > 0) {
    const enumRules = enumFactors
      .map((f) => {
        const quotedValues = f.values?.map((v) => `"${v}"`).join(', ') ?? '';
        const fieldName = f.name;
        return `- **${fieldName}**: ONLY use these exact values: ${quotedValues}
  - If user mentions a value NOT in this list, DO NOT set ${fieldName} in your response
  - Instead, ask the user to choose from the valid options
  - Provide context about which valid option might fit their intent`;
      })
      .join('\n');
    enumGuidance = `\n\nCRITICAL ENUM VALIDATION RULES:\n${enumRules}`;
  }

  return `You are a ${toneValue} conversational assistant.

Your task is to gather the following information through natural conversation:

${factorDescriptions}${priorityGuidance}

CONVERSATION GUIDELINES:
- Ask questions naturally, one topic at a time
- Extract information from user responses
- Track what you've learned across conversation turns
- When the user provides information, acknowledge it and move to the next factor
- Be patient and adapt to the user's communication style${enumGuidance}

${customGuidance ? `ADDITIONAL GUIDANCE:\n${customGuidance}\n` : ''}
READINESS INDICATOR:
- When you have gathered enough information (at minimum, all required factors), acknowledge this to the user
- Example: "I have enough information now! Ready to see the results?"
- Wait for user confirmation before proceeding to recommendations`;
}

/**
 * Generates the system prompt for Phase 2: Extraction
 */
export function generateExtractionPrompt(
  config: ExtractionPhaseConfig,
  gatheredProfile: Record<string, unknown>,
): string {
  if (config.customExtractionPrompt) {
    return config.customExtractionPrompt;
  }

  return `You are a data extraction assistant.

Extract and validate the following profile information into structured format:

${JSON.stringify(gatheredProfile, null, 2)}

Return ONLY a valid JSON object matching the expected schema.
Ensure all values match their expected types and constraints.`;
}

/**
 * Defines a two-phase conversational assistant agent.
 *
 * Phase 1 (Gathering): Natural conversation to collect information
 * - No JSON output required
 * - Conversational text responses
 * - Accumulates factors informally
 *
 * Phase 2 (Extraction): Structured data extraction
 * - JSON output with schema validation
 * - Triggered when readiness check passes
 * - Uses Structured Outputs API if configured
 *
 * @param config - Two-phase configuration
 * @param handler - Optional custom handler (if you want full control)
 * @returns Agent with validated execute function and manifest
 *
 * @example
 * ```typescript
 * const breedAdvisor = defineTwoPhaseConversationalAssistant({
 *   name: 'breed-advisor',
 *   description: 'Helps users find their perfect cat breed',
 *   version: '1.0.0',
 *   inputSchema: BreedAdvisorInputSchema,
 *   gatheringPhase: {
 *     tone: 'enthusiastic',
 *     factors: [
 *       {
 *         name: 'musicPreference',
 *         description: 'User\'s music taste',
 *         type: 'enum',
 *         values: ['classical', 'jazz', 'rock', 'pop'],
 *         required: true,
 *         weight: 2,
 *       },
 *       {
 *         name: 'livingSpace',
 *         type: 'enum',
 *         values: ['apartment', 'house', 'farm'],
 *         naturalLanguageMappings: {
 *           'flat': 'apartment',
 *           'big house': 'house',
 *         },
 *       },
 *     ],
 *     readinessCheck: (profile) => Object.keys(profile).length >= 4,
 *   },
 *   extractionPhase: {
 *     outputSchema: BreedRecommendationSchema,
 *     generateRecommendations: matchBreeds,
 *   },
 * });
 * ```
 */
export function defineTwoPhaseConversationalAssistant<TInput, TOutput>(
  config: TwoPhaseConversationalConfig<TInput, TOutput>,
  handler?: (input: TInput, ctx: ConversationalContext) => Promise<TOutput>,
): Agent<TInput, TOutput> {
  // Generate system prompts
  const gatheringPrompt = generateGatheringPrompt(config.gatheringPhase);

  // Build manifest
  const manifest = buildManifest(config, 'two-phase-conversational-assistant', {
    mockable: config.mockable ?? true,
    gatheringPhase: {
      tone: config.gatheringPhase.tone,
      factorCount: config.gatheringPhase.factors.length,
      requiredFactors: config.gatheringPhase.factors.filter((f) => f.required).map((f) => f.name),
      priorityFactors: config.gatheringPhase.priorityFactors,
    },
    extractionPhase: {
      useStructuredOutputs: config.extractionPhase.useStructuredOutputs ?? false,
    },
    systemPrompt: {
      gathering: gatheringPrompt,
    },
  });

  // If custom handler provided, use it
  if (handler) {
    const execute = createAsyncExecuteWrapperWithContext(
      config,
      handler,
      createConversationalContextMapper(config.mockable ?? true),
    );

    return {
      name: config.name,
      execute,
      manifest,
    };
  }

  // Default implementation: Two-phase pattern
  const defaultHandler = async (_input: TInput, ctx: ConversationalContext): Promise<TOutput> => {
    // Check if gathering prompt is in history
    const hasGatheringPrompt = ctx.history.some(
      (msg) => msg.role === 'system' && msg.content.includes(gatheringPrompt),
    );

    if (!hasGatheringPrompt) {
      ctx.addToHistory('system', gatheringPrompt);
    }

    // Determine current phase from session state or conversation history
    // This would need access to session state from input
    // For now, this is a placeholder - actual implementation would handle phase management

    // Phase 1: Gathering
    // Phase 2: Extraction

    throw new Error(
      'Default two-phase handler not yet implemented. ' +
        'Please provide a custom handler or use the generated prompts manually.',
    );
  };

  const execute = createAsyncExecuteWrapperWithContext(
    config,
    defaultHandler,
    createConversationalContextMapper(config.mockable ?? true),
  );

  return {
    name: config.name,
    execute,
    manifest,
  };
}
