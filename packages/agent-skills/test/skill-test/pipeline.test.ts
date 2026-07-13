import { describe, expect, it, vi } from 'vitest';

import { RateLimitSignal, runPipeline } from '../../src/skill-test/pipeline.js';

describe('runPipeline', () => {
  it('respects the concurrency ceiling', async () => {
    let live = 0;
    let maxLive = 0;
    const releasers: Array<() => void> = [];

    const worker = (item: number): Promise<number> => {
      live += 1;
      maxLive = Math.max(maxLive, live);
      return new Promise<number>((resolve) => {
        releasers.push(() => {
          live -= 1;
          resolve(item);
        });
      });
    };

    const items = [1, 2, 3, 4, 5, 6, 7];
    const donePromise = runPipeline({ items, concurrency: 3, worker });

    // Let the microtask queue drain so the first wave of workers starts.
    await Promise.resolve();
    await Promise.resolve();

    expect(maxLive).toBe(3);
    expect(live).toBe(3);

    // Release all workers; the pool should backfill up to the ceiling as
    // each slot frees, never exceeding it.
    while (releasers.length > 0 || live > 0) {
      const release = releasers.shift();
      if (release) {
        release();
      }
      await Promise.resolve();
      await Promise.resolve();
    }

    const results = await donePromise;
    expect(results).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(maxLive).toBeLessThanOrEqual(3);
  });

  it('preserves input order even when workers finish out of order', async () => {
    const items = [10, 20, 30, 40];
    // Item value determines "delay": smaller values resolve sooner via fewer
    // microtask hops, so results settle out of order relative to input.
    const worker = async (item: number): Promise<number> => {
      const hops = items.length - items.indexOf(item);
      for (let i = 0; i < hops; i += 1) {
        await Promise.resolve();
      }
      return item * 2;
    };

    const results = await runPipeline({ items, concurrency: 4, worker });
    expect(results).toEqual([20, 40, 60, 80]);
  });

  it('retries on RateLimitSignal using the injected sleep, then succeeds', async () => {
    const sleepCalls: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleepCalls.push(ms);
    };

    let attempts = 0;
    const worker = async (item: string): Promise<string> => {
      attempts += 1;
      if (attempts < 3) {
        throw new RateLimitSignal('rate limited');
      }
      return `${item}-ok`;
    };

    const results = await runPipeline({
      items: ['a'],
      concurrency: 1,
      worker,
      sleep,
    });

    expect(results).toEqual(['a-ok']);
    expect(attempts).toBe(3);
    // Default backoff: min(60_000, base * 2^(attempt-1)) for attempts 1, 2.
    expect(sleepCalls).toHaveLength(2);
    expect(sleepCalls[0]).toBeGreaterThan(0);
    expect(sleepCalls[1]).toBeGreaterThan(sleepCalls[0] ?? 0);
  });

  it('uses a custom onRateLimit and rethrows RateLimitSignal after the retry cap', async () => {
    const sleep = vi.fn(async (): Promise<void> => {});
    const onRateLimit = vi.fn((attempt: number): number => attempt * 100);

    let attempts = 0;
    const worker = async (): Promise<never> => {
      attempts += 1;
      throw new RateLimitSignal('always rate limited');
    };

    await expect(
      runPipeline({
        items: ['x'],
        concurrency: 1,
        worker,
        onRateLimit,
        sleep,
      }),
    ).rejects.toBeInstanceOf(RateLimitSignal);

    // Cap = 5 retries -> 6 total attempts, 5 sleeps.
    expect(attempts).toBe(6);
    expect(sleep).toHaveBeenCalledTimes(5);
    expect(onRateLimit.mock.calls.map((c) => c[0])).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects the whole run when a worker throws a non-rate-limit error', async () => {
    const worker = async (item: number): Promise<number> => {
      if (item === 2) {
        throw new Error('boom');
      }
      return item;
    };

    await expect(
      runPipeline({
        items: [1, 2, 3],
        concurrency: 2,
        worker,
      }),
    ).rejects.toThrow('boom');
  });

  it('throws when concurrency is less than 1', async () => {
    await expect(
      runPipeline({
        items: [1],
        concurrency: 0,
        worker: async (item: number) => item,
      }),
    ).rejects.toThrow(/concurrency/i);
  });
});
