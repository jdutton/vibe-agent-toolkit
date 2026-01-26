/**
 * Vercel AI SDK adapter for conversational demo
 */

import { openai } from '@ai-sdk/openai';
import { createConversationalContext, type Message } from '@vibe-agent-toolkit/agent-runtime';
import type { Session } from '@vibe-agent-toolkit/transports';
import { streamText } from 'ai';

import { breedAdvisorAgent } from '../../src/conversational-assistant/breed-advisor.js';
import type { BreedAdvisorInput, BreedAdvisorOutput } from '../../src/types/schemas.js';
import type { ConversationalRuntimeAdapter } from '../conversational-runtime-adapter.js';

import type { BreedAdvisorState } from './shared-types.js';

/**
 * Create Vercel AI SDK adapter for breed advisor
 */
export function createVercelAISDKAdapter(): ConversationalRuntimeAdapter<
  BreedAdvisorOutput,
  BreedAdvisorState
> {
  return {
    name: 'Vercel AI SDK',
    convertToFunction: async (userMessage: string, session: Session<BreedAdvisorState>) => {
      // Create conversation context for the agent using helper
      const context = createConversationalContext(session.history, async (messages: Message[]) => {
        const vercelMessages = messages.map((msg) => ({
          role: msg.role as 'system' | 'user' | 'assistant',
          content: msg.content,
        }));

        const result = streamText({
          model: openai('gpt-4o-mini'),
          temperature: 0.7,
          messages: vercelMessages,
        });

        return await result.text;
      });

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
    },
  };
}
