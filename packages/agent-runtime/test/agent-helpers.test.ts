import { describe, expect, it } from 'vitest';

import { executeLLMCall } from '../src/agent-helpers.js';

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
