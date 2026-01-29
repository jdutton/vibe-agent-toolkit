/**
 * LangChain adapter for conversational demo
 */

import { ChatOpenAI } from '@langchain/openai';
import {
  convertConversationalAssistantToFunction,
  type ConversationalSession,
} from '@vibe-agent-toolkit/runtime-langchain';
import type { TransportSessionContext } from '@vibe-agent-toolkit/transports';

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
 * Create LangChain adapter for breed advisor
 */
export function createLangChainAdapter(): ConversationalRuntimeAdapter<BreedAdvisorOutput, BreedAdvisorState> {
  const chatModel = new ChatOpenAI({
    modelName: 'gpt-4o-mini',
    temperature: 0.7,
    apiKey: process.env.OPENAI_API_KEY,
  });

  const chatFn = convertConversationalAssistantToFunction({
    agent: breedAdvisorAgent,
    inputSchema: BreedAdvisorInputSchema,
    outputSchema: BreedAdvisorOutputSchema,
    llmConfig: { model: chatModel },
  });

  return {
    name: 'LangChain',
    convertToFunction: async (userMessage: string, sessionContext: TransportSessionContext<BreedAdvisorState>) => {
      // Add user message to session history (transport responsibility)
      sessionContext.conversationHistory.push({ role: 'user', content: userMessage });

      // Convert TransportSessionContext to ConversationalSession
      const langchainSession: ConversationalSession = {
        history: sessionContext.conversationHistory,
        state: sessionContext.state,
      };

      // Create agent input
      const agentInput: BreedAdvisorInput = {
        message: userMessage,
        sessionState: sessionContext.state ? { profile: sessionContext.state.profile } : undefined,
      };

      // Execute via LangChain adapter
      const result = await chatFn(agentInput, langchainSession);

      // Add assistant response to session history (transport responsibility)
      sessionContext.conversationHistory.push({ role: 'assistant', content: result.output.reply });

      // Update session context state (mutate in place for transport)
      sessionContext.state = {
        profile: result.output.sessionState,
      };

      return result.output;
    },
  };
}
