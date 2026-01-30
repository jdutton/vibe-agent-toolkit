/**
 * Runtime adapter interface for conversational assistants
 *
 * Defines the contract that each runtime must implement to support
 * the conversational demo with breed advisor agent.
 */

import type { TransportSessionContext } from '@vibe-agent-toolkit/transports';

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
   * that works with the transport's session context.
   */
  convertToFunction: (userMessage: string, context: TransportSessionContext<TState>) => Promise<TOutput>;
}
