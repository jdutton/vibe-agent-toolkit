import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineFunctionEventConsumer } from '../src/function-event-consumer.js';
import type { EventConsumerContext } from '../src/types.js';

import { createStandardConfig } from './test-helpers.js';

const AGENT_NAME = 'event-consumer';
const ORDER_CREATED = 'order.created';
const ORDER_UPDATED = 'order.updated';
const SUBSCRIBED_EVENTS = [ORDER_CREATED, ORDER_UPDATED];

const TEST_INPUT_SCHEMA = z.object({ orderId: z.string() });
const TEST_OUTPUT_SCHEMA = z.object({ processed: z.boolean() });

function createTestConfig(options: { subscribesTo?: string[] } = {}) {
  return createStandardConfig({
    name: AGENT_NAME,
    inputSchema: TEST_INPUT_SCHEMA,
    outputSchema: TEST_OUTPUT_SCHEMA,
    ...options,
  });
}

describe('defineFunctionEventConsumer', () => {
  it('should create an agent with valid manifest', () => {
    const agent = defineFunctionEventConsumer(
      createTestConfig({ subscribesTo: SUBSCRIBED_EVENTS }),
      async (_input, _ctx) => ({ processed: true }),
    );

    expect(agent.name).toBe(AGENT_NAME);
    expect(agent.manifest.archetype).toBe('function-event-consumer');
    expect(agent.manifest.metadata?.subscribesTo).toEqual([ORDER_CREATED, ORDER_UPDATED]);
  });

  it('should execute with event context', async () => {
    const agent = defineFunctionEventConsumer(
      createTestConfig(),
      async (input, ctx) => {
        ctx.state.set(`order:${input.orderId}`, ctx.eventData);
        await ctx.emit('order.processed', { orderId: input.orderId });
        return { processed: true };
      },
    );

    const emittedEvents: Array<{ type: string; data: unknown }> = [];
    const ctx: EventConsumerContext = {
      eventType: 'order.created',
      eventData: { id: '123', amount: 100 },
      state: new Map(),
      emit: async (type, data) => {
        emittedEvents.push({ type, data });
      },
    };

    const result = await agent.execute({ orderId: '123' }, ctx);
    expect(result.processed).toBe(true);
    expect(ctx.state.get('order:123')).toEqual({ id: '123', amount: 100 });
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]?.type).toBe('order.processed');
  });

  it('should throw error for invalid input', async () => {
    const agent = defineFunctionEventConsumer(
      createTestConfig(),
      async (_input, _ctx) => ({ processed: true }),
    );

    const ctx: EventConsumerContext = {
      eventType: 'test',
      eventData: {},
      state: new Map(),
      emit: async () => {},
    };

    await expect(agent.execute({ orderId: 123 } as never, ctx)).rejects.toThrow(
      'Invalid input for agent "event-consumer"',
    );
  });
});
