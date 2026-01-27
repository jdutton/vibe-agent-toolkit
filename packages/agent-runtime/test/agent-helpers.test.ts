import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  executeLLMAnalyzer,
  executeLLMCall,
  executeExternalEvent,
  validateAgentInput,
} from '../src/agent-helpers.js';

// Test constants
const MOCK_RESULT = 'result';
const REAL_RESULT = 'real result';
const ERROR_LLM_INVALID_OUTPUT = 'llm-invalid-output';
const ERROR_LLM_REFUSAL = 'llm-refusal';
const ERROR_LLM_UNAVAILABLE = 'llm-unavailable';
const ERROR_EVENT_INVALID_RESPONSE = 'event-invalid-response';
const ERROR_EVENT_REJECTED = 'event-rejected';
const ERROR_CONTEXT = 'Test context';

// Test helpers
const createMockFn = () => () => ({ result: 'mocked' });
const createHandler = (result: string) => async () => result;

function expectSuccessWithMetadata(output: unknown, data: unknown, mode: string) {
  expect(output).toEqual({
    result: { status: 'success', data },
    metadata: {
      mode,
      executedAt: expect.any(String),
    },
  });
}

describe('validateAgentInput', () => {
  const TestSchema = z.object({
    name: z.string(),
    age: z.number(),
  });

  it('should return parsed data for valid input', () => {
    const input = { name: 'Alice', age: 30 };
    const result = validateAgentInput(input, TestSchema);

    expect(result).toEqual({ name: 'Alice', age: 30 });
  });

  it('should return error envelope for invalid input', () => {
    const input = { name: 'Bob' }; // Missing age
    const result = validateAgentInput(input, TestSchema);

    expect(result).toEqual({
      result: { status: 'error', error: ERROR_LLM_INVALID_OUTPUT },
    });
  });

  it('should use custom error code', () => {
    const input = { invalid: 'data' };
    const result = validateAgentInput(input, TestSchema, ERROR_EVENT_INVALID_RESPONSE);

    expect(result).toEqual({
      result: { status: 'error', error: ERROR_EVENT_INVALID_RESPONSE },
    });
  });
});

describe('executeLLMCall', () => {
  it('should return success for successful LLM call', async () => {
    const result = await executeLLMCall(async () => 'LLM response');

    expect(result).toEqual({ status: 'success', data: 'LLM response' });
  });

  it('should parse output when parseOutput provided', async () => {
    const result = await executeLLMCall(
      async () => '{"value": 42}',
      {
        parseOutput: (raw) => JSON.parse(raw as string),
      }
    );

    expect(result).toEqual({ status: 'success', data: { value: 42 } });
  });

  it('should map timeout errors', async () => {
    const result = await executeLLMCall(async () => {
      throw new Error('Request timeout');
    });

    expect(result).toEqual({ status: 'error', error: 'llm-timeout' });
  });

  it('should map ETIMEDOUT errors', async () => {
    const result = await executeLLMCall(async () => {
      throw new Error('ETIMEDOUT');
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

    expect(result).toEqual({ status: 'error', error: ERROR_LLM_REFUSAL });
  });

  it('should map content filter errors', async () => {
    const result = await executeLLMCall(async () => {
      throw new Error('Blocked by content filter');
    });

    expect(result).toEqual({ status: 'error', error: ERROR_LLM_REFUSAL });
  });

  it('should map token limit errors', async () => {
    const result = await executeLLMCall(async () => {
      throw new Error('Token limit exceeded');
    });

    expect(result).toEqual({ status: 'error', error: 'llm-token-limit' });
  });

  it('should map 503 service errors', async () => {
    const result = await executeLLMCall(async () => {
      throw new Error('Service unavailable (503)');
    });

    expect(result).toEqual({ status: 'error', error: ERROR_LLM_UNAVAILABLE });
  });

  it('should map 502 bad gateway errors', async () => {
    const result = await executeLLMCall(async () => {
      throw new Error('Bad gateway (502)');
    });

    expect(result).toEqual({ status: 'error', error: ERROR_LLM_UNAVAILABLE });
  });

  it('should default to llm-unavailable for unknown errors', async () => {
    const result = await executeLLMCall(async () => {
      throw new Error('Something unexpected happened');
    });

    expect(result).toEqual({ status: 'error', error: ERROR_LLM_UNAVAILABLE });
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

    expect(result).toEqual({ status: 'error', error: ERROR_LLM_INVALID_OUTPUT });
  });

  it('should log parse errors to console', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await executeLLMCall(
      async () => 'bad data',
      {
        parseOutput: () => {
          throw new Error('Parse error message');
        },
      }
    );

    expect(warnSpy).toHaveBeenCalledWith('LLM output parse error:', 'Parse error message');
    warnSpy.mockRestore();
  });
});

describe('executeLLMAnalyzer', () => {
  it('should return mock data in mock mode', async () => {
    const mockFn = createMockFn();
    const output = await executeLLMAnalyzer({
      mockable: true,
      mockFn,
    });

    expect(output).toEqual({
      result: { status: 'success', data: { result: 'mocked' } },
      metadata: {
        mode: 'mock',
        executedAt: expect.any(String),
      },
    });
  });

  it('should return error when real mode not implemented', async () => {
    const mockFn = createMockFn();
    const output = await executeLLMAnalyzer({
      mockable: false,
      mockFn,
    });

    expect(output).toEqual({
      result: { status: 'error', error: ERROR_LLM_UNAVAILABLE },
      metadata: {
        mode: 'real',
        message: 'Real LLM implementation not available',
        executedAt: expect.any(String),
      },
    });
  });

  it('should use custom not-implemented message', async () => {
    const mockFn = createMockFn();
    const output = await executeLLMAnalyzer({
      mockable: false,
      mockFn,
      notImplementedMessage: 'Custom message',
    });

    expect(output.metadata).toMatchObject({
      message: 'Custom message',
    });
  });

  it('should call real LLM in real mode', async () => {
    const mockFn = createMockFn();
    const realFn = async () => REAL_RESULT;

    const output = await executeLLMAnalyzer({
      mockable: false,
      mockFn,
      realFn,
    });

    expectSuccessWithMetadata(output, REAL_RESULT, 'real');
  });

  it('should parse output in real mode', async () => {
    const mockFn = createMockFn();
    const realFn = async () => '{"value": 42}';
    const parseOutput = (raw: unknown) => JSON.parse(raw as string);

    const output = await executeLLMAnalyzer({
      mockable: false,
      mockFn,
      realFn,
      parseOutput,
    });

    expect(output.result).toEqual({ status: 'success', data: { value: 42 } });
  });

  it('should handle real mode errors', async () => {
    const mockFn = createMockFn();
    const realFn = async () => {
      throw new Error('LLM failed');
    };

    const output = await executeLLMAnalyzer({
      mockable: false,
      mockFn,
      realFn,
    });

    expect(output.result).toEqual({ status: 'error', error: ERROR_LLM_UNAVAILABLE });
  });

  it('should log error with context', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mockFn = () => {
      throw new Error('Mock error');
    };

    await executeLLMAnalyzer({
      mockable: true,
      mockFn,
      errorContext: ERROR_CONTEXT,
    });

    expect(warnSpy).toHaveBeenCalledWith(`${ERROR_CONTEXT} error:`, 'Mock error');
    warnSpy.mockRestore();
  });
});

describe('executeExternalEvent', () => {
  it('should return auto-response in auto mode', async () => {
    const handler = createHandler(REAL_RESULT);
    const output = await executeExternalEvent({
      autoResponse: 'auto result',
      handler,
    });

    expect(output).toEqual({
      result: { status: 'success', data: 'auto result' },
      metadata: {
        mode: 'auto',
        executedAt: expect.any(String),
      },
    });
  });

  it('should call handler in real mode', async () => {
    const handler = createHandler(REAL_RESULT);
    const output = await executeExternalEvent({
      handler,
    });

    expectSuccessWithMetadata(output, REAL_RESULT, 'real');
  });

  it('should include timeout in metadata when specified', async () => {
    const handler = async () => MOCK_RESULT;
    const output = await executeExternalEvent({
      handler,
      timeoutMs: 5000,
    });

    expect(output.metadata).toMatchObject({
      timeoutMs: 5000,
    });
  });

  it('should map timeout errors', async () => {
    const handler = async () => {
      throw new Error('Request timed out');
    };
    const output = await executeExternalEvent({ handler });

    expect(output.result).toEqual({ status: 'error', error: 'event-timeout' });
  });

  it('should map ETIMEDOUT errors', async () => {
    const handler = async () => {
      throw new Error('ETIMEDOUT');
    };
    const output = await executeExternalEvent({ handler });

    expect(output.result).toEqual({ status: 'error', error: 'event-timeout' });
  });

  it('should map rejected errors', async () => {
    const handler = async () => {
      throw new Error('Request was rejected');
    };
    const output = await executeExternalEvent({ handler });

    expect(output.result).toEqual({ status: 'error', error: ERROR_EVENT_REJECTED });
  });

  it('should map denied errors', async () => {
    const handler = async () => {
      throw new Error('Access denied');
    };
    const output = await executeExternalEvent({ handler });

    expect(output.result).toEqual({ status: 'error', error: ERROR_EVENT_REJECTED });
  });

  it('should map refused errors', async () => {
    const handler = async () => {
      throw new Error('Connection refused');
    };
    const output = await executeExternalEvent({ handler });

    expect(output.result).toEqual({ status: 'error', error: ERROR_EVENT_REJECTED });
  });

  it('should map invalid response errors', async () => {
    const handler = async () => {
      throw new Error('Invalid response format');
    };
    const output = await executeExternalEvent({ handler });

    expect(output.result).toEqual({ status: 'error', error: ERROR_EVENT_INVALID_RESPONSE });
  });

  it('should map malformed errors', async () => {
    const handler = async () => {
      throw new Error('Malformed data');
    };
    const output = await executeExternalEvent({ handler });

    expect(output.result).toEqual({ status: 'error', error: ERROR_EVENT_INVALID_RESPONSE });
  });

  it('should map parse errors', async () => {
    const handler = async () => {
      throw new Error('Failed to parse response');
    };
    const output = await executeExternalEvent({ handler });

    expect(output.result).toEqual({ status: 'error', error: ERROR_EVENT_INVALID_RESPONSE });
  });

  it('should default to event-unavailable for unknown errors', async () => {
    const handler = async () => {
      throw new Error('Something unexpected');
    };
    const output = await executeExternalEvent({ handler });

    expect(output.result).toEqual({ status: 'error', error: 'event-unavailable' });
  });

  it('should include error message in metadata', async () => {
    const handler = async () => {
      throw new Error('Test error');
    };
    const output = await executeExternalEvent({ handler });

    expect(output.metadata).toMatchObject({
      errorMessage: 'Test error',
    });
  });

  it('should log error with context', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = async () => {
      throw new Error('Handler error');
    };

    await executeExternalEvent({
      handler,
      errorContext: ERROR_CONTEXT,
    });

    expect(warnSpy).toHaveBeenCalledWith(`${ERROR_CONTEXT} error:`, 'Handler error');
    warnSpy.mockRestore();
  });
});
