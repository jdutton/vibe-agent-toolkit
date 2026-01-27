/**
 * Shared helpers for conversational adapters
 *
 * Reduces duplication between runtime-specific adapters
 */

import { createConversationalContext, type Message } from '@vibe-agent-toolkit/agent-runtime';
import type { Session } from '@vibe-agent-toolkit/transports';

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
 * Execute the breed advisor agent with the given context and session
 *
 * @param userMessage - User's message
 * @param session - Current session state
 * @param context - Conversational context with callLLM function
 * @returns Updated output and session
 */
export async function executeBreedAdvisor(
  userMessage: string,
  session: Session<BreedAdvisorState>,
  context: BreedAdvisorContext,
): Promise<{
  output: BreedAdvisorOutput;
  session: Session<BreedAdvisorState>;
}> {
  // Create agent input
  const agentInput: BreedAdvisorInput = {
    message: userMessage,
    sessionState: session.state ? { profile: session.state.profile } : undefined,
  };

  // Execute agent
  const agentOutput: BreedAdvisorOutput = await breedAdvisorAgent.execute(agentInput, context);

  // Update session state
  const updatedState: BreedAdvisorState = {
    profile: agentOutput.sessionState,
  };

  return {
    output: agentOutput,
    session: {
      history: session.history,
      state: updatedState,
    },
  };
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
