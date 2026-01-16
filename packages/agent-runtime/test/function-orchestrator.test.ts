import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineFunctionOrchestrator } from '../src/function-orchestrator.js';
import type { OrchestratorContext } from '../src/types.js';

import { createStandardConfig } from './test-helpers.js';

const AGENT_NAME = 'orchestrator';

const TEST_INPUT_SCHEMA_1 = z.object({ data: z.array(z.string()) });
const TEST_OUTPUT_SCHEMA_1 = z.object({ processed: z.array(z.string()) });
const TEST_INPUT_SCHEMA_2 = z.object({ items: z.array(z.string()) });
const TEST_OUTPUT_SCHEMA_2 = z.object({ results: z.array(z.string()) });

function createTestConfig1() {
  return createStandardConfig({
    name: AGENT_NAME,
    inputSchema: TEST_INPUT_SCHEMA_1,
    outputSchema: TEST_OUTPUT_SCHEMA_1,
  });
}

function createTestConfig2() {
  return createStandardConfig({
    name: AGENT_NAME,
    inputSchema: TEST_INPUT_SCHEMA_2,
    outputSchema: TEST_OUTPUT_SCHEMA_2,
  });
}

const processItem = (item: string): (() => Promise<string>) => async () => `processed-${item}`;

describe('defineFunctionOrchestrator', () => {
  it('should create an agent with valid manifest', () => {
    const agent = defineFunctionOrchestrator(
      createTestConfig1(),
      async (input, _ctx) => ({ processed: input.data }),
    );

    expect(agent.name).toBe(AGENT_NAME);
    expect(agent.manifest.archetype).toBe('function-orchestrator');
  });

  it('should execute with orchestration context', async () => {
    const agent = defineFunctionOrchestrator(
      createTestConfig2(),
      async (input, ctx) => {
        const results = await ctx.parallel(input.items.map(processItem));
        return { results };
      },
    );

    const parallelFn = async <T>(calls: Array<() => Promise<T>>): Promise<T[]> =>
      Promise.all(calls.map((fn) => fn()));

    const ctx: OrchestratorContext = {
      call: async <T, R>(_name: string, _input: T): Promise<R> =>
        ({ result: 'test' }) as R,
      parallel: parallelFn,
      retry: async (fn) => fn(),
      state: new Map(),
    };

    const result = await agent.execute({ items: ['a', 'b', 'c'] }, ctx);
    expect(result.results).toEqual(['processed-a', 'processed-b', 'processed-c']);
  });

  it('should throw error for invalid input', async () => {
    const agent = defineFunctionOrchestrator(
      createTestConfig2(),
      async (_input, _ctx) => ({ results: [] }),
    );

    const ctx: OrchestratorContext = {
      call: async <R>() => ({} as R),
      parallel: async (_calls) => [],
      retry: async (fn) => fn(),
      state: new Map(),
    };

    await expect(agent.execute({ items: 'not-array' } as never, ctx)).rejects.toThrow(
      'Invalid input for agent "orchestrator"',
    );
  });
});
