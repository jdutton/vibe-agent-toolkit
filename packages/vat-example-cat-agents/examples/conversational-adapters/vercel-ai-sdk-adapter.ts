/**
 * Vercel AI SDK adapter for conversational demo
 */

import { openai } from '@ai-sdk/openai';
import type { Message } from '@vibe-agent-toolkit/agent-runtime';
import type { TransportSessionContext } from '@vibe-agent-toolkit/transports';
import { streamText } from 'ai';

import type { BreedAdvisorOutput } from '../../src/types/schemas.js';
import type { ConversationalRuntimeAdapter } from '../conversational-runtime-adapter.js';

import { createAdapterContext, executeBreedAdvisor } from './shared-helpers.js';
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
    convertToFunction: async (userMessage: string, sessionContext: TransportSessionContext<BreedAdvisorState>) => {
      // Create conversation context using shared helper
      const agentContext = createAdapterContext(sessionContext.conversationHistory, async (messages: Message[]) => {
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

      // Execute breed advisor with shared helper
      return executeBreedAdvisor(userMessage, sessionContext, agentContext);
    },
  };
}
