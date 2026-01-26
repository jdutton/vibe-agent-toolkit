import { describe, expect, it } from 'vitest';

import { andThen, mapResult, match, unwrap } from '../src/result-helpers.js';

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
      success: (data) => `Success: ${data}`,
      error: (err) => `Error: ${err}`,
    });

    expect(message).toBe('Error: failed');
  });

  it('should handle in-progress case', () => {
    const result = { status: 'in-progress' as const, metadata: { progress: 50 } };

    const message = match(result, {
      success: (data) => `Success: ${data}`,
      error: (err) => `Error: ${err}`,
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
