import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { defineLLMAnalyzer, type LLMAnalyzerContext } from '../src/index.js';

import { createSentimentAgentConfig } from './test-helpers.js';

const SENTIMENT_AGENT_NAME = 'sentiment';
const SENTIMENT_AGENT_DESC = 'Analyzes sentiment';
const TEST_AGENT_NAME = 'test';
const TEST_AGENT_DESC = 'Test agent';

describe('defineLLMAnalyzer', () => {
  it('should create an agent with valid manifest', () => {
    const sentimentAgent = defineLLMAnalyzer(createSentimentAgentConfig(), async (input, ctx) => {
      await ctx.callLLM(`Analyze: ${input.text}`);
      return { sentiment: 'positive' as const };
    });

    expect(sentimentAgent.name).toBe(SENTIMENT_AGENT_NAME);
    expect(sentimentAgent.manifest.name).toBe(SENTIMENT_AGENT_NAME);
    expect(sentimentAgent.manifest.description).toBe(SENTIMENT_AGENT_DESC);
    expect(sentimentAgent.manifest.version).toBe('1.0.0');
    expect(sentimentAgent.manifest.archetype).toBe('llm-analyzer');
    expect(sentimentAgent.manifest.inputSchema).toBeDefined();
    expect(sentimentAgent.manifest.outputSchema).toBeDefined();
    expect(sentimentAgent.manifest.metadata).toEqual({
      mockable: true,
      model: 'claude-3-haiku',
      temperature: 0.7,
    });
  });

  it('should default mockable to true', () => {
    const agent = defineLLMAnalyzer(
      {
        name: TEST_AGENT_NAME,
        description: TEST_AGENT_DESC,
        version: '1.0.0',
        inputSchema: z.string(),
        outputSchema: z.string(),
      },
      async (input) => input,
    );

    expect(agent.manifest.metadata?.mockable).toBe(true);
  });

  it('should execute with valid input and context', async () => {
    const mockCallLLM = vi.fn().mockResolvedValue('positive sentiment');

    const sentimentAgent = defineLLMAnalyzer(createSentimentAgentConfig(), async (input, ctx) => {
      const response = await ctx.callLLM(`Analyze: ${input.text}`);
      expect(response).toBe('positive sentiment');
      return { sentiment: 'positive' as const };
    });

    const ctx: LLMAnalyzerContext = {
      mockable: true,
      callLLM: mockCallLLM,
    };

    const result = await sentimentAgent.execute({ text: 'I love this!' }, ctx);

    expect(result).toEqual({ sentiment: 'positive' });
    expect(mockCallLLM).toHaveBeenCalledWith('Analyze: I love this!');
  });

  it('should pass config values to context', async () => {
    const agent = defineLLMAnalyzer(
      {
        name: TEST_AGENT_NAME,
        description: TEST_AGENT_DESC,
        version: '1.0.0',
        inputSchema: z.string(),
        outputSchema: z.string(),
        model: 'claude-3-opus',
        temperature: 0.5,
        mockable: false,
      },
      async (input, ctx) => {
        expect(ctx.model).toBe('claude-3-opus');
        expect(ctx.temperature).toBe(0.5);
        expect(ctx.mockable).toBe(false);
        return input;
      },
    );

    const ctx: LLMAnalyzerContext = {
      mockable: true,
      callLLM: async () => 'response',
    };

    await agent.execute('test', ctx);
  });

  it('should throw error for invalid input', async () => {
    const agent = defineLLMAnalyzer(
      {
        name: TEST_AGENT_NAME,
        description: TEST_AGENT_DESC,
        version: '1.0.0',
        inputSchema: z.object({
          value: z.number(),
        }),
        outputSchema: z.string(),
      },
      async (input) => String(input.value),
    );

    const ctx: LLMAnalyzerContext = {
      mockable: true,
      callLLM: async () => 'response',
    };

    await expect(agent.execute({ value: 'not a number' } as never, ctx)).rejects.toThrow(
      `Invalid input for agent "${TEST_AGENT_NAME}"`,
    );
  });

  it('should throw error for invalid output', async () => {
    const agent = defineLLMAnalyzer(
      {
        name: TEST_AGENT_NAME,
        description: TEST_AGENT_DESC,
        version: '1.0.0',
        inputSchema: z.string(),
        outputSchema: z.number(),
      },
      async () => 'not a number' as never,
    );

    const ctx: LLMAnalyzerContext = {
      mockable: true,
      callLLM: async () => 'response',
    };

    await expect(agent.execute('test', ctx)).rejects.toThrow(
      `Invalid output from agent "${TEST_AGENT_NAME}"`,
    );
  });

  it('should include additional metadata', () => {
    const agent = defineLLMAnalyzer(
      {
        name: TEST_AGENT_NAME,
        description: TEST_AGENT_DESC,
        version: '1.0.0',
        inputSchema: z.string(),
        outputSchema: z.string(),
        metadata: {
          author: 'Test Author',
          tags: ['test'],
        },
      },
      async (input) => input,
    );

    expect(agent.manifest.metadata).toEqual(
      expect.objectContaining({
        author: 'Test Author',
        tags: ['test'],
        mockable: true,
      }),
    );
  });
});
