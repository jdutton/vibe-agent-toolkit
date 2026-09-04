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

  it.each([
    { label: 'timeout errors', message: 'Request timeout', expected: 'llm-timeout' },
    { label: 'ETIMEDOUT errors', message: 'ETIMEDOUT', expected: 'llm-timeout' },
    { label: 'rate limit errors', message: 'Rate limit exceeded (429)', expected: 'llm-rate-limit' },
    { label: 'content policy errors', message: 'Content policy violation', expected: ERROR_LLM_REFUSAL },
    { label: 'content filter errors', message: 'Blocked by content filter', expected: ERROR_LLM_REFUSAL },
    { label: 'token limit errors', message: 'Token limit exceeded', expected: 'llm-token-limit' },
    { label: '503 service errors', message: 'Service unavailable (503)', expected: ERROR_LLM_UNAVAILABLE },
    { label: '502 bad gateway errors', message: 'Bad gateway (502)', expected: ERROR_LLM_UNAVAILABLE },
    {
      label: 'unknown errors to the llm-unavailable default',
      message: 'Something unexpected happened',
      expected: ERROR_LLM_UNAVAILABLE,
    },
  ])('should map $label', async ({ message, expected }) => {
    const result = await executeLLMCall(async () => {
      throw new Error(message);
    });

    expect(result).toEqual({ status: 'error', error: expected });
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

  it.each([
    { label: 'timeout errors', message: 'Request timed out', expected: 'event-timeout' },
    { label: 'ETIMEDOUT errors', message: 'ETIMEDOUT', expected: 'event-timeout' },
    { label: 'rejected errors', message: 'Request was rejected', expected: ERROR_EVENT_REJECTED },
    { label: 'denied errors', message: 'Access denied', expected: ERROR_EVENT_REJECTED },
    { label: 'refused errors', message: 'Connection refused', expected: ERROR_EVENT_REJECTED },
    {
      label: 'invalid response errors',
      message: 'Invalid response format',
      expected: ERROR_EVENT_INVALID_RESPONSE,
    },
    {
      label: 'malformed errors',
      message: 'Malformed data',
      expected: ERROR_EVENT_INVALID_RESPONSE,
    },
    {
      label: 'parse errors',
      message: 'Failed to parse response',
      expected: ERROR_EVENT_INVALID_RESPONSE,
    },
    {
      label: 'unknown errors to the event-unavailable default',
      message: 'Something unexpected',
      expected: 'event-unavailable',
    },
  ])('should map $label', async ({ message, expected }) => {
    const handler = async () => {
      throw new Error(message);
    };
    const output = await executeExternalEvent({ handler });

    expect(output.result).toEqual({ status: 'error', error: expected });
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
