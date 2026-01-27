/**
 * Claude Agent SDK adapter for conversational demo
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Message } from '@vibe-agent-toolkit/agent-runtime';
import { extractTextFromResponse, formatMessagesForAnthropic } from '@vibe-agent-toolkit/runtime-claude-agent-sdk';
import type { Session } from '@vibe-agent-toolkit/transports';

import type { BreedAdvisorOutput } from '../../src/types/schemas.js';
import type { ConversationalRuntimeAdapter } from '../conversational-runtime-adapter.js';

import { createAdapterContext, executeBreedAdvisor } from './shared-helpers.js';
import type { BreedAdvisorState } from './shared-types.js';

/**
 * Create Claude Agent SDK adapter for breed advisor
 */
export function createClaudeAgentSDKAdapter(): ConversationalRuntimeAdapter<
  BreedAdvisorOutput,
  BreedAdvisorState
> {
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  return {
    name: 'Claude Agent SDK',
    convertToFunction: async (userMessage: string, session: Session<BreedAdvisorState>) => {
      // Create conversation context using shared helper
      const context = createAdapterContext(session.history, async (messages: Message[]) => {
        // Format messages using shared helper
        const { systemPrompt, conversationMessages } = formatMessagesForAnthropic(messages);

        const response = await anthropic.messages.create({
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 4096,
          temperature: 0.7,
          ...(systemPrompt && { system: systemPrompt }),
          messages: conversationMessages,
        });

        return extractTextFromResponse(response);
      });

      // Execute breed advisor with shared helper
      return executeBreedAdvisor(userMessage, session, context);
    },
  };
}
