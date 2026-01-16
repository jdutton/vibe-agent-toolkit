import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineExternalEventIntegrator } from '../src/external-event-integrator.js';
import type { ExternalEventContext } from '../src/types.js';

import { createStandardConfig } from './test-helpers.js';

const AGENT_NAME = 'integrator';

const TEST_INPUT_SCHEMA = z.object({ request: z.string() });
const TEST_OUTPUT_SCHEMA = z.object({ approved: z.boolean() });

function createTestConfig() {
  return createStandardConfig({
    name: AGENT_NAME,
    inputSchema: TEST_INPUT_SCHEMA,
    outputSchema: TEST_OUTPUT_SCHEMA,
  });
}

describe('defineExternalEventIntegrator', () => {
  it('should create an agent with valid manifest', () => {
    const agent = defineExternalEventIntegrator(
      createTestConfig(),
      async (_input, _ctx) => ({ approved: true }),
    );

    expect(agent.name).toBe(AGENT_NAME);
    expect(agent.manifest.archetype).toBe('external-event-integrator');
  });

  it('should execute with external event context', async () => {
    const agent = defineExternalEventIntegrator(
      createTestConfig(),
      async (input, ctx) => {
        await ctx.emit('approval.requested', { request: input.request });
        const response = await ctx.waitFor<{ approved: boolean }>('approval.response', 5000);
        return response;
      },
    );

    const emittedEvents: Array<{ type: string; data: unknown }> = [];
    const ctx: ExternalEventContext = {
      emit: async (type, data) => {
        emittedEvents.push({ type, data });
      },
      waitFor: async <T>() => ({ approved: true } as T),
    };

    const result = await agent.execute({ request: 'test' }, ctx);
    expect(result.approved).toBe(true);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]?.type).toBe('approval.requested');
  });

  it('should throw error for invalid input', async () => {
    const agent = defineExternalEventIntegrator(
      createTestConfig(),
      async (_input, _ctx) => ({ approved: true }),
    );

    const ctx: ExternalEventContext = {
      emit: async () => {},
      waitFor: async <T>() => ({} as T),
    };

    await expect(agent.execute({ request: 123 } as never, ctx)).rejects.toThrow(
      'Invalid input for agent "integrator"',
    );
  });
});
