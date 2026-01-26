/**
 * OpenAI SDK adapter for conversational demo
 */

import {
  convertConversationalAssistantToFunction,
  type ConversationalSessionState,
} from '@vibe-agent-toolkit/runtime-openai';
import type { Session } from '@vibe-agent-toolkit/transports';
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
    convertToFunction: async (userMessage: string, session: Session<BreedAdvisorState>) => {
      // Convert Session<BreedAdvisorState> to ConversationalSessionState
      const openaiSession: ConversationalSessionState = {
        history: session.history,
        state: session.state,
      };

      // Create agent input
      const agentInput: BreedAdvisorInput = {
        message: userMessage,
        sessionState: session.state ? { profile: session.state.profile } : undefined,
      };

      // Execute via OpenAI adapter
      const agentOutput = await chatFn(agentInput, openaiSession);

      // Update session state
      const updatedState: BreedAdvisorState = {
        profile: agentOutput.updatedProfile,
      };

      return {
        output: agentOutput,
        session: {
          history: openaiSession.history,
          state: updatedState,
        },
      };
    },
  };
}
