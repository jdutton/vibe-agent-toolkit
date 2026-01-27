/**
 * Runtime adapter interface for conversational assistants
 *
 * Defines the contract that each runtime must implement to support
 * the conversational demo with breed advisor agent.
 */

import type { Session } from '@vibe-agent-toolkit/transports';

/**
 * Runtime adapter for conversational assistants
 *
 * Each runtime (Vercel AI SDK, LangChain, OpenAI SDK, Claude Agent SDK)
 * provides an implementation of this interface.
 */
export interface ConversationalRuntimeAdapter<TOutput, TState> {
  /** Name of the runtime (e.g., "Vercel AI SDK", "LangChain") */
  name: string;

  /**
   * Convert a conversational assistant agent to an executable function
   * that works with the CLI transport's Session type.
   */
  convertToFunction: (userMessage: string, session: Session<TState>) => Promise<{
    output: TOutput;
    session: Session<TState>;
  }>;
}
