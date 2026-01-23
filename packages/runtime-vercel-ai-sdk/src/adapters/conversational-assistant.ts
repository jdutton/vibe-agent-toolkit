import type { Agent, Message } from '@vibe-agent-toolkit/agent-runtime';
import { streamText } from 'ai';
import type { z } from 'zod';

import type { VercelAILLMConfig } from '../types.js';

/**
 * Session state for conversational assistants
 * Maintains conversation history and agent-specific state
 */
export interface ConversationSession {
  /** Conversation history */
  history: Message[];
  /** Agent-specific session state */
  state?: Record<string, unknown>;
}

/**
 * Converts a VAT Conversational Assistant agent to a function compatible with Vercel AI SDK.
 *
 * Conversational assistants maintain context across multiple turns using conversation history.
 * They're perfect for interactive dialogs, multi-turn decision-making, and stateful interactions.
 *
 * Example:
 * ```typescript
 * import { openai } from '@ai-sdk/openai';
 * import { breedAdvisorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
 * import { BreedAdvisorInputSchema, BreedAdvisorOutputSchema } from '@vibe-agent-toolkit/vat-example-cat-agents';
 * import { convertConversationalAssistantToFunction } from '@vibe-agent-toolkit/runtime-vercel-ai-sdk';
 *
 * const breedAdvisor = convertConversationalAssistantToFunction(
 *   breedAdvisorAgent,
 *   BreedAdvisorInputSchema,
 *   BreedAdvisorOutputSchema,
 *   { model: openai('gpt-4'), temperature: 0.8 }
 * );
 *
 * // Start conversation
 * const session: ConversationSession = { history: [] };
 * const turn1 = await breedAdvisor(
 *   { message: "I'm looking for a cat", sessionState: {} },
 *   session
 * );
 * console.log(turn1.reply); // "Great! Tell me about your living space..."
 *
 * // Continue conversation
 * const turn2 = await breedAdvisor(
 *   { message: "I live in an apartment", sessionState: turn1.sessionState },
 *   session
 * );
 * console.log(turn2.recommendations); // Breed recommendations
 * ```
 *
 * @param agent - The VAT conversational assistant agent to convert
 * @param inputSchema - The Zod input schema
 * @param outputSchema - The Zod output schema
 * @param llmConfig - Configuration for the LLM (model, temperature, etc.)
 * @returns An async function that executes the agent with conversation context
 */
export function convertConversationalAssistantToFunction<TInput, TOutput>(
  agent: Agent<TInput, TOutput>,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>,
  llmConfig: VercelAILLMConfig,
): (input: TInput, session: ConversationSession) => Promise<TOutput> {
  return async (input: TInput, session: ConversationSession) => {
    // Validate input
    const validatedInput = inputSchema.parse(input);

    // Initialize session if needed
    session.history ??= [];

    // Convert VAT Message format to Vercel AI SDK format
    const convertToVercelFormat = (messages: Message[]) => {
      return messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));
    };

    // Create conversation context
    const callLLM = async (messages: Message[]) => {
      const vercelMessages = convertToVercelFormat(messages);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      const result = await streamText({
        model: llmConfig.model,
        ...(llmConfig.temperature ? { temperature: llmConfig.temperature } : {}),
        ...(llmConfig.maxTokens ? { maxTokens: llmConfig.maxTokens } : {}),
        ...llmConfig.additionalSettings,
        messages: vercelMessages,
      });

      // Collect streamed text from the response
      return await result.text;
    };

    const addToHistory = (role: 'system' | 'user' | 'assistant', content: string) => {
      session.history.push({ role, content });
    };

    const context = {
      mockable: false,
      history: session.history,
      addToHistory,
      callLLM,
    };

    // Call the agent's execute function with the conversation context
    const output = await agent.execute(validatedInput, context);

    // Validate output
    return outputSchema.parse(output);
  };
}

/**
 * Batch converts multiple conversational assistant agents to executable functions.
 *
 * Useful when you need multiple conversational agents with shared LLM configuration.
 * Each agent maintains its own independent conversation session.
 *
 * Example:
 * ```typescript
 * import { openai } from '@ai-sdk/openai';
 * import { breedAdvisorAgent, petCareAdvisorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
 * import { convertConversationalAssistantsToFunctions } from '@vibe-agent-toolkit/runtime-vercel-ai-sdk';
 *
 * const assistants = convertConversationalAssistantsToFunctions(
 *   {
 *     breedAdvisor: {
 *       agent: breedAdvisorAgent,
 *       inputSchema: BreedAdvisorInputSchema,
 *       outputSchema: BreedAdvisorOutputSchema,
 *     },
 *     petCareAdvisor: {
 *       agent: petCareAdvisorAgent,
 *       inputSchema: PetCareInputSchema,
 *       outputSchema: PetCareOutputSchema,
 *     },
 *   },
 *   { model: openai('gpt-4'), temperature: 0.8 }
 * );
 *
 * // Each assistant has its own session
 * const breedSession: ConversationSession = { history: [] };
 * const careSession: ConversationSession = { history: [] };
 *
 * const breedResponse = await assistants.breedAdvisor(
 *   { message: "I want a cat" },
 *   breedSession
 * );
 * const careResponse = await assistants.petCareAdvisor(
 *   { message: "How often should I feed my cat?" },
 *   careSession
 * );
 * ```
 *
 * @param configs - Map of assistant names to conversion configurations
 * @param llmConfig - Shared LLM configuration for all assistants
 * @returns Map of assistant names to executable async functions
 */
export interface ConversationalAssistantConversionConfig<TInput, TOutput> {
  agent: Agent<TInput, TOutput>;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
}

export function convertConversationalAssistantsToFunctions<
  T extends Record<string, ConversationalAssistantConversionConfig<unknown, unknown>>,
>(
  configs: T,
  llmConfig: VercelAILLMConfig,
): Record<keyof T, (input: unknown, session: ConversationSession) => Promise<unknown>> {
  const functions: Record<
    string,
    (input: unknown, session: ConversationSession) => Promise<unknown>
  > = {};

  for (const [name, config] of Object.entries(configs)) {
    functions[name] = convertConversationalAssistantToFunction(
      config.agent,
      config.inputSchema,
      config.outputSchema,
      llmConfig,
    );
  }

  return functions as Record<
    keyof T,
    (input: unknown, session: ConversationSession) => Promise<unknown>
  >;
}
