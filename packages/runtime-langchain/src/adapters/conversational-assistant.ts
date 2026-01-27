import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import type { Agent, ConversationalContext, Message } from '@vibe-agent-toolkit/agent-runtime';
import type { z } from 'zod';

import type { LangChainLLMConfig } from '../types.js';

/**
 * Session state for conversational assistants
 */
export interface ConversationalSession<TState = Record<string, unknown>> {
  /** Conversation history */
  history: Message[];

  /** Session-specific state (e.g., user profile, preferences) */
  state: TState;
}

/**
 * Configuration for conversational assistant conversion
 */
export interface ConversationalAssistantConfig<TInput, TOutput, TState = Record<string, unknown>> {
  /** The VAT conversational assistant agent */
  agent: Agent<TInput, TOutput>;

  /** Zod schema for validating inputs */
  inputSchema: z.ZodType<TInput>;

  /** Zod schema for validating outputs */
  outputSchema: z.ZodType<TOutput>;

  /** LangChain LLM configuration */
  llmConfig: LangChainLLMConfig;

  /** Initial session state (optional) */
  initialState?: TState;

  /** System prompt (overrides agent's system prompt if provided) */
  systemPrompt?: string;
}

/**
 * Result from a conversational turn
 */
export interface ConversationalResult<TOutput, TState = Record<string, unknown>> {
  /** The agent's output */
  output: TOutput;

  /** Updated session to pass to next turn */
  session: ConversationalSession<TState>;
}

/**
 * Converts a VAT Conversational Assistant agent to an executable function with LangChain
 *
 * The returned function manages conversation history and session state across turns,
 * providing a stateful conversational interface backed by LangChain models.
 *
 * @param config - Configuration including agent, schemas, and LLM settings
 * @returns Async function that executes the agent with conversation context
 *
 * @example
 * ```typescript
 * import { ChatOpenAI } from '@langchain/openai';
 * import { breedAdvisorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
 * import { convertConversationalAssistantToFunction } from '@vibe-agent-toolkit/runtime-langchain';
 *
 * const chat = convertConversationalAssistantToFunction({
 *   agent: breedAdvisorAgent,
 *   inputSchema: BreedAdvisorInputSchema,
 *   outputSchema: BreedAdvisorOutputSchema,
 *   llmConfig: {
 *     model: new ChatOpenAI({ modelName: 'gpt-4o' }),
 *     temperature: 0.7,
 *   },
 * });
 *
 * // First turn
 * let result = await chat({ message: 'I need help finding a cat breed' });
 * console.log(result.output.reply);
 *
 * // Second turn (pass session)
 * result = await chat(
 *   { message: 'I love classical music', sessionState: result.session.state },
 *   result.session
 * );
 * console.log(result.output.reply);
 * ```
 */
export function convertConversationalAssistantToFunction<
  TInput,
  TOutput,
  TState = Record<string, unknown>
>(
  config: ConversationalAssistantConfig<TInput, TOutput, TState>,
): (
  input: TInput,
  session?: ConversationalSession<TState>,
) => Promise<ConversationalResult<TOutput, TState>> {
  const { agent, inputSchema, outputSchema, llmConfig, systemPrompt } = config;

  return async (
    input: TInput,
    session?: ConversationalSession<TState>,
  ): Promise<ConversationalResult<TOutput, TState>> => {
    // Validate input
    const validatedInput = inputSchema.parse(input);

    // Initialize or continue session
    const currentSession: ConversationalSession<TState> = session ?? {
      history: [],
      state: (config.initialState ?? {}) as TState,
    };

    // Add system prompt to history if this is the first turn
    if (currentSession.history.length === 0) {
      const metadataPrompt = agent.manifest['metadata']?.['systemPrompt'];
      const prompt =
        systemPrompt ??
        (typeof metadataPrompt === 'string'
          ? metadataPrompt
          : (metadataPrompt as { gathering?: string })?.gathering);

      if (typeof prompt === 'string') {
        currentSession.history.push({
          role: 'system',
          content: prompt,
        });
      }
    }

    // Create conversational context
    const context: ConversationalContext = {
      mockable: false,
      history: [...currentSession.history],
      addToHistory: (role: 'system' | 'user' | 'assistant', content: string) => {
        context.history.push({ role, content });
      },
      callLLM: async (messages: Message[]): Promise<string> => {
        // Convert VAT messages to LangChain messages
        const langchainMessages = messages.map((msg) => {
          switch (msg.role) {
            case 'system':
              return new SystemMessage(msg.content);
            case 'user':
              return new HumanMessage(msg.content);
            case 'assistant':
              return new AIMessage(msg.content);
            default:
              throw new Error(`Unknown message role: ${msg.role}`);
          }
        });

        // Call LangChain model
        // Note: LangChain models configure temperature/maxTokens at initialization,
        // not per-invocation. Model configuration should be passed when creating the model.
        const response = await llmConfig.model.invoke(langchainMessages);

        return response.content.toString();
      },
    };

    // Execute the agent
    const output = await agent.execute(validatedInput, context);

    // Validate output
    const validatedOutput = outputSchema.parse(output);

    // Update session with new history
    const updatedSession: ConversationalSession<TState> = {
      history: context.history,
      state: currentSession.state,
    };

    return {
      output: validatedOutput,
      session: updatedSession,
    };
  };
}

/**
 * Batch configuration for conversational assistant conversions
 */
export interface ConversationalAssistantConversionConfigs {
  [key: string]: {
    agent: Agent<unknown, unknown>;
    inputSchema: z.ZodType<unknown>;
    outputSchema: z.ZodType<unknown>;
  };
}

/**
 * Batch converts multiple VAT Conversational Assistant agents to executable functions
 *
 * @param configs - Map of function names to conversion configurations
 * @param llmConfig - Shared LangChain LLM configuration for all agents
 * @returns Map of function names to executable async functions
 *
 * @example
 * ```typescript
 * import { ChatOpenAI } from '@langchain/openai';
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
 *   {
 *     model: new ChatOpenAI({ modelName: 'gpt-4o' }),
 *     temperature: 0.7,
 *   }
 * );
 *
 * const result = await assistants.breedAdvisor({ message: 'Hello' });
 * ```
 */
export function convertConversationalAssistantsToFunctions(
  configs: ConversationalAssistantConversionConfigs,
  llmConfig: LangChainLLMConfig,
): Record<
  string,
  (
    input: unknown,
    session?: ConversationalSession,
  ) => Promise<ConversationalResult<unknown>>
> {
  const result: Record<
    string,
    (
      input: unknown,
      session?: ConversationalSession,
    ) => Promise<ConversationalResult<unknown>>
  > = {};

  for (const [name, config] of Object.entries(configs)) {
    result[name] = convertConversationalAssistantToFunction({
      agent: config.agent,
      inputSchema: config.inputSchema,
      outputSchema: config.outputSchema,
      llmConfig,
    });
  }

  return result;
}
