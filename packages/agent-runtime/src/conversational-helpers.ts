/**
 * Helper utilities for building conversational agent contexts
 */

import type { ConversationalContext, Message } from './types.js';

/**
 * Creates a conversational context with the given LLM function and history
 * Reduces duplication between adapters and examples
 *
 * @param history - Conversation history array (will be mutated by addToHistory)
 * @param callLLM - Function to call the LLM with messages
 * @returns ConversationalContext object
 *
 * @example
 * ```typescript
 * const session = { history: [] };
 * const context = createConversationalContext(
 *   session.history,
 *   async (messages) => {
 *     // Call your LLM here
 *     return "response";
 *   }
 * );
 * ```
 */
export function createConversationalContext(
  history: Message[],
  callLLM: (messages: Message[]) => Promise<string>,
): ConversationalContext {
  return {
    mockable: false,
    history,
    addToHistory: (role: 'system' | 'user' | 'assistant', content: string) => {
      history.push({ role, content });
    },
    callLLM,
  };
}
