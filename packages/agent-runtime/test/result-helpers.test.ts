import type { OneShotAgentOutput } from '@vibe-agent-toolkit/agent-schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { andThen, mapResult, match, unwrap, withRetry, withTiming } from '../src/result-helpers.js';

// Test constants
const ERROR_LLM_TIMEOUT = 'llm-timeout';

// Test helpers
function createSuccessAgent(data: string): () => Promise<OneShotAgentOutput<string, string>> {
  return async () => ({ result: { status: 'success', data } });
}

function createRetryAgent(
  attemptsToFail: number,
  error: string,
  successData: string = 'success'
): { fn: () => Promise<OneShotAgentOutput<string, string>>; attempts: { value: number } } {
  const attempts = { value: 0 };
  const fn = async (): Promise<OneShotAgentOutput<string, string>> => {
    attempts.value++;
    if (attempts.value < attemptsToFail) {
      return { result: { status: 'error', error } };
    }
    return { result: { status: 'success', data: successData } };
  };
  return { fn, attempts };
}

async function testRetryOnError(errorType: string) {
  const { fn, attempts } = createRetryAgent(2, errorType);
  const retryPromise = withRetry(fn, 3);
  await vi.runAllTimersAsync();
  const output = await retryPromise;

  expect(attempts.value).toBe(2);
  expect(output.result.execution?.retryCount).toBe(1);
}

describe('mapResult', () => {
  it('should map success data', () => {
    const result = { status: 'success' as const, data: 5 };
    const doubled = mapResult(result, (x) => x * 2);

    expect(doubled).toEqual({ status: 'success', data: 10 });
  });

  it('should propagate errors unchanged', () => {
    const result = { status: 'error' as const, error: 'failed' };
    const doubled = mapResult(result, (x: number) => x * 2);

    expect(doubled).toEqual({ status: 'error', error: 'failed' });
  });

  it('should preserve confidence', () => {
    const result = { status: 'success' as const, data: 5, confidence: 0.95 };
    const doubled = mapResult(result, (x) => x * 2);

    expect(doubled).toEqual({ status: 'success', data: 10, confidence: 0.95 });
  });

  it('should preserve warnings', () => {
    const result = { status: 'success' as const, data: 5, warnings: ['warning1'] };
    const doubled = mapResult(result, (x) => x * 2);

    expect(doubled).toEqual({ status: 'success', data: 10, warnings: ['warning1'] });
  });

  it('should preserve execution metadata', () => {
    const result = {
      status: 'success' as const,
      data: 5,
      execution: { durationMs: 100, timestamp: '2024-01-01T00:00:00Z' },
    };
    const doubled = mapResult(result, (x) => x * 2);

    expect(doubled).toEqual({
      status: 'success',
      data: 10,
      execution: { durationMs: 100, timestamp: '2024-01-01T00:00:00Z' },
    });
  });
});

describe('andThen', () => {
  it('should chain successful operations', async () => {
    const result1 = { status: 'success' as const, data: 5 };

    const result2 = await andThen(result1, async (data) => ({
      status: 'success' as const,
      data: data * 2,
    }));

    expect(result2).toEqual({ status: 'success', data: 10 });
  });

  it('should not run next operation on error', async () => {
    const result1 = { status: 'error' as const, error: 'failed' };
    let called = false;

    const result2 = await andThen(result1, async (data: number) => {
      called = true;
      return { status: 'success' as const, data: data * 2 };
    });

    expect(called).toBe(false);
    expect(result2).toEqual({ status: 'error', error: 'failed' });
  });
});

describe('match', () => {
  it('should handle success case', () => {
    const result = { status: 'success' as const, data: 'hello' };

    const message = match(result, {
      success: (data) => `Success: ${data}`,
      error: (err) => `Error: ${err}`,
    });

    expect(message).toBe('Success: hello');
  });

  it('should handle error case', () => {
    const result = { status: 'error' as const, error: 'failed' };

    const message = match(result, {
      success: (data) => `Success: ${String(data)}`,
      error: (err) => `Error: ${String(err)}`,
    });

    expect(message).toBe('Error: failed');
  });

  it('should handle in-progress case', () => {
    const result = { status: 'in-progress' as const, metadata: { progress: 50 } };

    const message = match(result, {
      success: (data) => `Success: ${String(data)}`,
      error: (err) => `Error: ${String(err)}`,
      inProgress: (meta) => {
        const progress = (meta as { progress?: number } | undefined)?.progress ?? 0;
        return `Progress: ${progress}%`;
      },
    });

    expect(message).toBe('Progress: 50%');
  });
});

describe('unwrap', () => {
  it('should extract data from success', () => {
    const result = { status: 'success' as const, data: 'hello' };

    expect(unwrap(result)).toBe('hello');
  });

  it('should throw on error', () => {
    const result = { status: 'error' as const, error: 'failed' };

    expect(() => unwrap(result)).toThrow('Agent error: failed');
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should succeed without retries', async () => {
    const agentFn = createSuccessAgent('success');
    const output = await withRetry(agentFn, 3);

    expect(output.result.status).toBe('success');
    if (output.result.status === 'success') {
      expect(output.result.data).toBe('success');
    }
    expect(output.result.execution?.retryCount).toBe(0);
  });

  it('should retry on retryable errors', async () => {
    const { fn, attempts } = createRetryAgent(3, ERROR_LLM_TIMEOUT, 'success after retry');
    const retryPromise = withRetry(fn, 5);

    // Fast-forward through retry delays (1000ms each for LLM_TIMEOUT)
    await vi.runAllTimersAsync();
    const output = await retryPromise;

    expect(attempts.value).toBe(3);
    expect(output.result.status).toBe('success');
    if (output.result.status === 'success') {
      expect(output.result.data).toBe('success after retry');
    }
    expect(output.result.execution?.retryCount).toBe(2);
  });

  it('should not retry on non-retryable errors', async () => {
    const { fn, attempts } = createRetryAgent(999, 'llm-refusal'); // Never succeeds
    const output = await withRetry(fn, 5);

    expect(attempts.value).toBe(1);
    expect(output.result.status).toBe('error');
    if (output.result.status === 'error') {
      expect(output.result.error).toBe('llm-refusal');
    }
    expect(output.result.execution?.retryCount).toBe(0);
  });

  it('should accumulate metrics across retries', async () => {
    let attempts = 0;
    const agentFn = async (): Promise<OneShotAgentOutput<string, string>> => {
      attempts++;
      if (attempts < 3) {
        return {
          result: {
            status: 'error',
            error: ERROR_LLM_TIMEOUT,
            execution: { durationMs: 100, tokensUsed: 50, cost: 0.01 },
          },
        };
      }
      return {
        result: {
          status: 'success',
          data: 'success',
          execution: { durationMs: 150, tokensUsed: 75, cost: 0.015 },
        },
      };
    };

    const retryPromise = withRetry(agentFn, 5);
    await vi.runAllTimersAsync();
    const output = await retryPromise;

    expect(output.result.execution).toMatchObject({
      retryCount: 2,
      durationMs: 350, // 100 + 100 + 150
      tokensUsed: 175, // 50 + 50 + 75
      cost: 0.035, // 0.01 + 0.01 + 0.015
    });
  });

  it('should cap retries at max attempts', async () => {
    const { fn, attempts } = createRetryAgent(999, ERROR_LLM_TIMEOUT); // Never succeeds
    const retryPromise = withRetry(fn, 2);
    await vi.runAllTimersAsync();
    const output = await retryPromise;

    expect(attempts.value).toBe(2);
    expect(output.result.status).toBe('error');
    if (output.result.status === 'error') {
      expect(output.result.error).toBe(ERROR_LLM_TIMEOUT);
    }
    expect(output.result.execution?.retryCount).toBe(1);
  });

  it('should handle missing execution metadata', async () => {
    const agentFn = createSuccessAgent('success');
    const output = await withRetry(agentFn, 3);

    expect(output.result.execution).toMatchObject({
      retryCount: 0,
      durationMs: 0,
      tokensUsed: 0,
      cost: 0,
    });
  });

  it('should retry on event-timeout errors', async () => {
    await testRetryOnError('event-timeout');
  });

  it('should retry on event-unavailable errors', async () => {
    await testRetryOnError('event-unavailable');
  });
});

describe('withTiming', () => {
  it('should inject timing metadata', async () => {
    const agentFn = async (): Promise<OneShotAgentOutput<string, string>> => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { result: { status: 'success', data: 'result' } };
    };

    const output = await withTiming(agentFn);

    expect(output.result).toMatchObject({
      status: 'success',
      data: 'result',
    });
    expect(output.result.execution?.durationMs).toBeGreaterThanOrEqual(45);
    expect(output.result.execution?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('should preserve existing execution metadata', async () => {
    const agentFn = async (): Promise<OneShotAgentOutput<string, string>> => ({
      result: {
        status: 'success',
        data: 'result',
        execution: { tokensUsed: 100, cost: 0.05 },
      },
    });

    const output = await withTiming(agentFn);

    expect(output.result.execution).toMatchObject({
      tokensUsed: 100,
      cost: 0.05,
      durationMs: expect.any(Number),
      timestamp: expect.any(String),
    });
  });

  it('should work with error results', async () => {
    const agentFn = async (): Promise<OneShotAgentOutput<string, string>> => ({
      result: { status: 'error', error: 'failed' },
    });

    const output = await withTiming(agentFn);

    expect(output.result).toMatchObject({
      status: 'error',
      error: 'failed',
    });
    expect(output.result.execution?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should measure timing accurately', async () => {
    const agentFn = async (): Promise<OneShotAgentOutput<string, string>> => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { result: { status: 'success', data: 'result' } };
    };

    const output = await withTiming(agentFn);

    // Allow some tolerance for timing (90-110ms range)
    expect(output.result.execution?.durationMs).toBeGreaterThanOrEqual(90);
    expect(output.result.execution?.durationMs).toBeLessThan(150);
  });
});
