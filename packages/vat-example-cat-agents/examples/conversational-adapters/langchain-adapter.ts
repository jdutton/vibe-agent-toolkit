/**
 * LangChain adapter for conversational demo
 */

import { ChatOpenAI } from '@langchain/openai';
import {
  convertConversationalAssistantToFunction,
  type ConversationalSession,
} from '@vibe-agent-toolkit/runtime-langchain';
import type { Session } from '@vibe-agent-toolkit/transports';

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
    convertToFunction: async (userMessage: string, session: Session<BreedAdvisorState>) => {
      // Convert Session<BreedAdvisorState> to ConversationalSession
      const langchainSession: ConversationalSession = {
        history: session.history,
        state: session.state,
      };

      // Create agent input
      const agentInput: BreedAdvisorInput = {
        message: userMessage,
        sessionState: session.state ? { profile: session.state.profile } : undefined,
      };

      // Execute via LangChain adapter
      const agentOutput = await chatFn(agentInput, langchainSession);

      // Update session state
      const updatedState: BreedAdvisorState = {
        profile: agentOutput.updatedProfile,
      };

      return {
        output: agentOutput,
        session: {
          history: langchainSession.history,
          state: updatedState,
        },
      };
    },
  };
}
