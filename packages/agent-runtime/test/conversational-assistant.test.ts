import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineConversationalAssistant } from '../src/conversational-assistant.js';
import type { ConversationalContext } from '../src/types.js';

import { createStandardConfig } from './test-helpers.js';

const AGENT_NAME = 'chat-assistant';
const MOCK_RESPONSE = 'mock response';

const TEST_INPUT_SCHEMA = z.object({ message: z.string() });
const TEST_OUTPUT_SCHEMA = z.object({ reply: z.string() });

function createTestConfig() {
  return createStandardConfig({
    name: AGENT_NAME,
    inputSchema: TEST_INPUT_SCHEMA,
    outputSchema: TEST_OUTPUT_SCHEMA,
    metadata: { systemPrompt: 'You are helpful' },
  });
}

describe('defineConversationalAssistant', () => {
  it('should create an agent with valid manifest', () => {
    const agent = defineConversationalAssistant(
      createTestConfig(),
      async (_input, _ctx) => ({ reply: 'hello' }),
    );

    expect(agent.name).toBe(AGENT_NAME);
    expect(agent.manifest.archetype).toBe('conversational-assistant');
    expect(agent.manifest.metadata?.mockable).toBe(true);
  });

  it('should execute with conversation context', async () => {
    const agent = defineConversationalAssistant(
      createTestConfig(),
      async (input, ctx) => {
        ctx.addToHistory('user', input.message);
        const response = await ctx.callLLM(ctx.history);
        ctx.addToHistory('assistant', response);
        return { reply: response };
      },
    );

    const history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
    const ctx: ConversationalContext = {
      mockable: true,
      history,
      addToHistory: (role, content) => {
        history.push({ role, content });
      },
      callLLM: async () => MOCK_RESPONSE,
    };

    const result = await agent.execute({ message: 'hello' }, ctx);
    expect(result.reply).toBe(MOCK_RESPONSE);
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: 'user', content: 'hello' });
    expect(history[1]).toEqual({ role: 'assistant', content: MOCK_RESPONSE });
  });

  it('should throw error for invalid input', async () => {
    const agent = defineConversationalAssistant(
      createTestConfig(),
      async (_input, _ctx) => ({ reply: '' }),
    );

    const ctx: ConversationalContext = {
      mockable: true,
      history: [],
      addToHistory: () => {},
      callLLM: async () => '',
    };

    await expect(agent.execute({ message: 123 } as never, ctx)).rejects.toThrow(
      'Invalid input for agent "chat-assistant"',
    );
  });
});
