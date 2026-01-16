import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineLLMCoordinator } from '../src/llm-coordinator.js';
import type { CoordinatorContext } from '../src/types.js';

import { createStandardConfig } from './test-helpers.js';

const AGENT_NAME = 'coordinator';

const TEST_INPUT_SCHEMA = z.object({ task: z.string() });
const TEST_OUTPUT_SCHEMA = z.object({ result: z.string() });

function createTestConfig() {
  return createStandardConfig({
    name: AGENT_NAME,
    inputSchema: TEST_INPUT_SCHEMA,
    outputSchema: TEST_OUTPUT_SCHEMA,
  });
}

describe('defineLLMCoordinator', () => {
  it('should create an agent with valid manifest', () => {
    const agent = defineLLMCoordinator(
      createTestConfig(),
      async (_input, _ctx) => ({ result: 'done' }),
    );

    expect(agent.name).toBe(AGENT_NAME);
    expect(agent.manifest.archetype).toBe('llm-coordinator');
    expect(agent.manifest.metadata?.mockable).toBe(true);
  });

  it('should execute with coordination context', async () => {
    const agent = defineLLMCoordinator(
      createTestConfig(),
      async (input, ctx) => {
        const decision = await ctx.callLLM(`How to handle: ${input.task}`);
        const result = await ctx.route(decision, {
          simple: async () => 'simple-result',
          complex: async () => 'complex-result',
        });
        return { result: String(result) };
      },
    );

    const ctx: CoordinatorContext = {
      mockable: true,
      call: async <R>() => ({} as R),
      callLLM: async () => 'simple',
      route: async (decision, routes) => {
        const handler = routes[decision];
        return handler ? handler() : routes['simple']?.();
      },
      state: new Map(),
    };

    const result = await agent.execute({ task: 'test' }, ctx);
    expect(result.result).toBe('simple-result');
  });

  it('should throw error for invalid input', async () => {
    const agent = defineLLMCoordinator(
      createTestConfig(),
      async (_input, _ctx) => ({ result: '' }),
    );

    const ctx: CoordinatorContext = {
      mockable: true,
      call: async <R>() => ({} as R),
      callLLM: async () => '',
      route: async () => ({}),
      state: new Map(),
    };

    await expect(agent.execute({ task: 123 } as never, ctx)).rejects.toThrow(
      'Invalid input for agent "coordinator"',
    );
  });
});
