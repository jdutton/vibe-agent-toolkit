import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineLLMEventHandler } from '../src/llm-event-handler.js';
import type { LLMEventHandlerContext } from '../src/types.js';

import { createStandardConfig } from './test-helpers.js';

const AGENT_NAME = 'event-handler';
const TICKET_CREATED = 'ticket.created';
const SUBSCRIBED_EVENTS = [TICKET_CREATED];

const TEST_INPUT_SCHEMA = z.object({ ticketId: z.string(), content: z.string() });
const TEST_OUTPUT_SCHEMA = z.object({ priority: z.string(), category: z.string() });

function createTestConfig(options: { subscribesTo?: string[] } = {}) {
  return createStandardConfig({
    name: AGENT_NAME,
    inputSchema: TEST_INPUT_SCHEMA,
    outputSchema: TEST_OUTPUT_SCHEMA,
    ...options,
  });
}

describe('defineLLMEventHandler', () => {
  it('should create an agent with valid manifest', () => {
    const agent = defineLLMEventHandler(
      createTestConfig({ subscribesTo: SUBSCRIBED_EVENTS }),
      async (_input, _ctx) => ({ priority: 'high', category: 'technical' }),
    );

    expect(agent.name).toBe(AGENT_NAME);
    expect(agent.manifest.archetype).toBe('llm-event-handler');
    expect(agent.manifest.metadata?.mockable).toBe(true);
    expect(agent.manifest.metadata?.subscribesTo).toEqual([TICKET_CREATED]);
  });

  it('should execute with LLM event context', async () => {
    const agent = defineLLMEventHandler(
      createTestConfig(),
      async (input, ctx) => {
        const analysis = await ctx.callLLM(`Analyze: ${input.content}`);
        ctx.state.set(`ticket:${input.ticketId}`, analysis);
        await ctx.emit('ticket.analyzed', { ticketId: input.ticketId, analysis });
        return { priority: 'high', category: 'technical' };
      },
    );

    const emittedEvents: Array<{ type: string; data: unknown }> = [];
    const ctx: LLMEventHandlerContext = {
      mockable: true,
      eventType: 'ticket.created',
      eventData: {},
      callLLM: async (_prompt) => 'analysis-result',
      emit: async (type, data) => {
        emittedEvents.push({ type, data });
      },
      state: new Map(),
    };

    const result = await agent.execute({ ticketId: '123', content: 'help' }, ctx);
    expect(result.priority).toBe('high');
    expect(ctx.state.get('ticket:123')).toBe('analysis-result');
    expect(emittedEvents).toHaveLength(1);
  });

  it('should throw error for invalid input', async () => {
    const agent = defineLLMEventHandler(
      createTestConfig(),
      async (_input, _ctx) => ({ priority: 'high', category: 'technical' }),
    );

    const ctx: LLMEventHandlerContext = {
      mockable: true,
      eventType: 'test',
      eventData: {},
      callLLM: async () => '',
      emit: async () => {},
      state: new Map(),
    };

    await expect(agent.execute({ ticketId: 123 } as never, ctx)).rejects.toThrow(
      'Invalid input for agent "event-handler"',
    );
  });
});
