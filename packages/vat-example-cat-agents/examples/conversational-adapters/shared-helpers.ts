/**
 * Shared helpers for conversational adapters
 *
 * Reduces duplication between runtime-specific adapters
 */

import { createConversationalContext, type Message } from '@vibe-agent-toolkit/agent-runtime';
import type { TransportSessionContext } from '@vibe-agent-toolkit/transports';

import { breedAdvisorAgent } from '../../src/conversational-assistant/breed-advisor.js';
import type { BreedAdvisorInput, BreedAdvisorOutput } from '../../src/types/schemas.js';

import type { BreedAdvisorState } from './shared-types.js';

/**
 * Conversational context interface for executing breed advisor
 */
export interface BreedAdvisorContext {
  history: Message[];
  addToHistory: (role: 'system' | 'user' | 'assistant', content: string) => void;
  callLLM: (messages: Message[]) => Promise<string>;
  mockable: boolean;
}

/**
 * Execute the breed advisor agent with the given context
 *
 * @param userMessage - User's message
 * @param sessionContext - Transport session context
 * @param agentContext - Conversational context with callLLM function
 * @returns Agent output
 */
export async function executeBreedAdvisor(
  userMessage: string,
  sessionContext: TransportSessionContext<BreedAdvisorState>,
  agentContext: BreedAdvisorContext,
): Promise<BreedAdvisorOutput> {
  // Add user message to session history (transport responsibility)
  sessionContext.conversationHistory.push({ role: 'user', content: userMessage });

  // Create agent input
  const agentInput: BreedAdvisorInput = {
    message: userMessage,
    sessionState: sessionContext.state ? { profile: sessionContext.state.profile } : undefined,
  };

  // Execute agent
  const agentOutput: BreedAdvisorOutput = await breedAdvisorAgent.execute(agentInput, agentContext);

  // Add assistant response to session history (transport responsibility)
  sessionContext.conversationHistory.push({ role: 'assistant', content: agentOutput.reply });

  // Update session context state (mutate in place for transport)
  sessionContext.state = {
    profile: agentOutput.sessionState,
  };

  return agentOutput;
}

/**
 * Create conversational context for adapters
 *
 * Wrapper around createConversationalContext to reduce duplication
 *
 * @param history - Message history
 * @param callLLM - Function to call LLM
 * @returns Conversational context
 */
export function createAdapterContext(
  history: Message[],
  callLLM: (messages: Message[]) => Promise<string>,
): BreedAdvisorContext {
  return createConversationalContext(history, callLLM);
}
