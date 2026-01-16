import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineAgenticResearcher } from '../src/agentic-researcher.js';
import type { ResearcherContext } from '../src/types.js';

import { createStandardConfig } from './test-helpers.js';

const AGENT_NAME = 'researcher';

const TEST_INPUT_SCHEMA = z.object({ query: z.string() });
const TEST_OUTPUT_SCHEMA = z.object({ answer: z.string() });

function createTestConfig() {
  return createStandardConfig({
    name: AGENT_NAME,
    inputSchema: TEST_INPUT_SCHEMA,
    outputSchema: TEST_OUTPUT_SCHEMA,
  });
}

describe('defineAgenticResearcher', () => {
  it('should create an agent with valid manifest', () => {
    const agent = defineAgenticResearcher(
      createTestConfig(),
      async (_input, _ctx) => ({ answer: 'done' }),
    );

    expect(agent.name).toBe(AGENT_NAME);
    expect(agent.manifest.archetype).toBe('agentic-researcher');
    expect(agent.manifest.metadata?.mockable).toBe(true);
  });

  it('should execute with research context', async () => {
    const agent = defineAgenticResearcher(
      createTestConfig(),
      async (input, ctx) => {
        const analysis = await ctx.callLLM(`Research: ${input.query}`);
        const searchResults = (await ctx.callTool('search', { q: input.query })) as string[];
        return { answer: `${analysis}: ${searchResults.join(', ')}` };
      },
    );

    const ctx: ResearcherContext = {
      mockable: true,
      tools: {
        search: async () => ['result1', 'result2'],
      },
      callLLM: async () => 'analysis',
      callTool: async (_name, _args) => ['result1', 'result2'],
      iterationCount: 0,
      maxIterations: 5,
    };

    const result = await agent.execute({ query: 'test' }, ctx);
    expect(result.answer).toBe('analysis: result1, result2');
  });

  it('should throw error for invalid input', async () => {
    const agent = defineAgenticResearcher(
      createTestConfig(),
      async (_input, _ctx) => ({ answer: '' }),
    );

    const ctx: ResearcherContext = {
      mockable: true,
      tools: {},
      callLLM: async () => '',
      callTool: async () => ({}),
      iterationCount: 0,
      maxIterations: 5,
    };

    await expect(agent.execute({ query: 123 } as never, ctx)).rejects.toThrow(
      'Invalid input for agent "researcher"',
    );
  });
});
