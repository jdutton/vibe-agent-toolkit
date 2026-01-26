import { describe, expect, it } from 'vitest';

import { createPureFunctionAgent, createSafePureFunctionAgent, executeLLMCall } from '../src/agent-helpers.js';

describe('createPureFunctionAgent', () => {
  it('should wrap sync function as async agent', async () => {
    const agent = createPureFunctionAgent(
      (x: number) => ({ status: 'success' as const, data: x * 2 }),
      { name: 'doubler' }
    );

    const output = await agent.execute(5);

    expect(output.result).toEqual({ status: 'success', data: 10 });
    expect(output.metadata?.synchronous).toBe(true);
  });

  it('should propagate errors from function', async () => {
    const agent = createPureFunctionAgent(
      (x: number) => {
        if (x < 0) {
          return { status: 'error' as const, error: 'negative-input' };
        }
        return { status: 'success' as const, data: x * 2 };
      }
    );

    const output = await agent.execute(-5);

    expect(output.result).toEqual({ status: 'error', error: 'negative-input' });
  });
});

describe('createSafePureFunctionAgent', () => {
  it('should catch exceptions and return error result', async () => {
    const agent = createSafePureFunctionAgent(
      (text: string) => JSON.parse(text)
    );

    const output = await agent.execute('invalid json');

    expect(output.result.status).toBe('error');
    if (output.result.status === 'error') {
      expect(output.result.error).toBe('execution-error');
    }
    expect(output.metadata?.errorMessage).toContain('JSON');
  });

  it('should return success for valid input', async () => {
    const agent = createSafePureFunctionAgent(
      (text: string) => JSON.parse(text)
    );

    const output = await agent.execute('{"hello": "world"}');

    expect(output.result.status).toBe('success');
    if (output.result.status === 'success') {
      expect(output.result.data).toEqual({ hello: 'world' });
    }
  });
});

describe('executeLLMCall', () => {
  it('should return success for successful LLM call', async () => {
    const result = await executeLLMCall(async () => 'LLM response');

    expect(result).toEqual({ status: 'success', data: 'LLM response' });
  });

  it('should map timeout errors', async () => {
    const result = await executeLLMCall(async () => {
      throw new Error('Request timeout');
    });

    expect(result).toEqual({ status: 'error', error: 'llm-timeout' });
  });

  it('should map rate limit errors', async () => {
    const result = await executeLLMCall(async () => {
      throw new Error('Rate limit exceeded (429)');
    });

    expect(result).toEqual({ status: 'error', error: 'llm-rate-limit' });
  });

  it('should map content policy errors', async () => {
    const result = await executeLLMCall(async () => {
      throw new Error('Content policy violation');
    });

    expect(result).toEqual({ status: 'error', error: 'llm-refusal' });
  });

  it('should handle parse errors', async () => {
    const result = await executeLLMCall(
      async () => ({ invalid: 'data' }),
      {
        parseOutput: () => {
          throw new Error('Parse failed');
        },
      }
    );

    expect(result).toEqual({ status: 'error', error: 'llm-invalid-output' });
  });
});
