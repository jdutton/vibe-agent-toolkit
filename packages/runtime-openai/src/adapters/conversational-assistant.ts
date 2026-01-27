import type { Agent, ConversationalContext, Message } from '@vibe-agent-toolkit/agent-runtime';
import type { z } from 'zod';

import type { OpenAIConfig } from '../types.js';

import { createConversationalCallLLM } from './common-helpers.js';

/**
 * Session state type for conversational assistants
 * Includes conversation history and custom state data
 */
export interface ConversationalSessionState {
  /** Conversation history */
  history: Message[];
  /** Custom state data (e.g., user profile, context) */
  state?: Record<string, unknown>;
}

/**
 * Converts a VAT Conversational Assistant agent to an executable async function with OpenAI
 *
 * @param agent - The VAT conversational assistant agent to convert
 * @param inputSchema - Zod schema for validating inputs
 * @param outputSchema - Zod schema for validating outputs
 * @param openaiConfig - OpenAI configuration
 * @param systemPrompt - Optional system prompt to prepend to conversation
 * @returns Async function that executes the agent with OpenAI chat completions
 *
 * @example
 * ```typescript
 * import OpenAI from 'openai';
 * import { breedAdvisorAgent, BreedAdvisorInputSchema, BreedAdvisorOutputSchema } from '@vibe-agent-toolkit/vat-example-cat-agents';
 * import { convertConversationalAssistantToFunction } from '@vibe-agent-toolkit/runtime-openai';
 *
 * const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
 *
 * const chat = convertConversationalAssistantToFunction(
 *   breedAdvisorAgent,
 *   BreedAdvisorInputSchema,
 *   BreedAdvisorOutputSchema,
 *   {
 *     client: openai,
 *     model: 'gpt-4o',
 *     temperature: 0.8,
 *   }
 * );
 *
 * // First turn
 * let session: ConversationalSessionState = { history: [] };
 * const result1 = await chat({ message: 'I need help finding a cat', sessionState: { profile: {} } }, session);
 * console.log(result1.reply);
 *
 * // Second turn (uses accumulated history)
 * const result2 = await chat({ message: 'I live in an apartment', sessionState: { profile: result1.updatedProfile } }, session);
 * console.log(result2.reply);
 * ```
 */
export function convertConversationalAssistantToFunction<TInput, TOutput>(
  agent: Agent<TInput, TOutput>,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>,
  openaiConfig: OpenAIConfig,
  systemPrompt?: string,
): (input: TInput, session: ConversationalSessionState) => Promise<TOutput> {
  // Extract system prompt from agent manifest if not provided
  const metadataSystemPrompt = agent.manifest.metadata?.['systemPrompt'];
  const effectiveSystemPrompt =
    systemPrompt ??
    (typeof metadataSystemPrompt === 'string'
      ? metadataSystemPrompt
      : (metadataSystemPrompt as { gathering?: string })?.gathering);

  // Create base callLLM function
  const baseCallLLM = createConversationalCallLLM(openaiConfig);

  // Wrap it to handle system prompt
  const callLLM = async (messages: Message[]): Promise<string> => {
    // Prepend system prompt if provided
    const messagesWithSystem = effectiveSystemPrompt
      ? [{ role: 'system' as const, content: effectiveSystemPrompt }, ...messages]
      : messages;

    return baseCallLLM(messagesWithSystem);
  };

  // Return wrapped function
  return async (input: TInput, session: ConversationalSessionState): Promise<TOutput> => {
    // Validate input
    const validatedInput = inputSchema.parse(input);

    // Initialize or use existing session history
    if (!session.history) {
      session.history = [];
    }

    // Create conversation context
    const context: ConversationalContext = {
      mockable: false,
      history: session.history,
      addToHistory: (role: 'system' | 'user' | 'assistant', content: string) => {
        session.history.push({ role, content });
      },
      callLLM,
    };

    // Execute the agent
    const output = await agent.execute(validatedInput, context);

    // Validate output
    return outputSchema.parse(output);
  };
}
