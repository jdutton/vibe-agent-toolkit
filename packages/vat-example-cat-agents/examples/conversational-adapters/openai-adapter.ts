/**
 * OpenAI SDK adapter for conversational demo
 */

import {
  convertConversationalAssistantToFunction,
  type ConversationalSessionState,
} from '@vibe-agent-toolkit/runtime-openai';
import type { TransportSessionContext } from '@vibe-agent-toolkit/transports';
import OpenAI from 'openai';

import { breedAdvisorAgent } from '../../src/conversational-assistant/breed-advisor.js';
import {
  BreedAdvisorInputSchema,
  type BreedAdvisorInput,
  type BreedAdvisorOutput,
  BreedAdvisorOutputSchema,
} from '../../src/types/schemas.js';
import type { ConversationalRuntimeAdapter } from '../conversational-runtime-adapter.js';

import type { BreedAdvisorState } from './shared-types.js';

/**
 * Create OpenAI SDK adapter for breed advisor
 */
export function createOpenAIAdapter(): ConversationalRuntimeAdapter<BreedAdvisorOutput, BreedAdvisorState> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const chatFn = convertConversationalAssistantToFunction(
    breedAdvisorAgent,
    BreedAdvisorInputSchema,
    BreedAdvisorOutputSchema,
    {
      client: openai,
      model: 'gpt-4o-mini',
      temperature: 0.7,
    },
  );

  return {
    name: 'OpenAI SDK',
    convertToFunction: async (userMessage: string, sessionContext: TransportSessionContext<BreedAdvisorState>) => {
      // Add user message to session history (transport responsibility)
      sessionContext.conversationHistory.push({ role: 'user', content: userMessage });

      // Convert TransportSessionContext to ConversationalSessionState
      const openaiSession: ConversationalSessionState = {
        history: sessionContext.conversationHistory,
        state: sessionContext.state,
      };

      // Create agent input
      const agentInput: BreedAdvisorInput = {
        message: userMessage,
        sessionState: sessionContext.state ? { profile: sessionContext.state.profile } : undefined,
      };

      // Execute via OpenAI adapter
      const agentOutput = await chatFn(agentInput, openaiSession);

      // Add assistant response to session history (transport responsibility)
      sessionContext.conversationHistory.push({ role: 'assistant', content: agentOutput.reply });

      // Update session context state (mutate in place for transport)
      sessionContext.state = {
        profile: agentOutput.sessionState,
      };

      return agentOutput;
    },
  };
}
