/**
 * Generic, pure, unit-testable bounded-parallel pipeline runner.
 *
 * Runs `worker` over `items` with at most `concurrency` in flight at once.
 * Results are returned in input order regardless of completion order. A
 * worker may throw {@link RateLimitSignal} to back off and retry: the affected
 * item sleeps (per-item, via the injected `sleep`) then retries, bounded by a
 * retry cap; other in-flight workers are NOT paused. Any other thrown error
 * propagates and fails the whole run.
 *
 * Zero claude/network dependency: callers inject `sleep` for deterministic
 * tests (no real timers, no `Math.random`).
 */

/** Thrown by a worker to back off (sleep) and retry the current item. */
export class RateLimitSignal extends Error {}

export interface RunPipelineOptions<T, R> {
  readonly items: readonly T[];
  /** Max number of workers in flight at once. Must be >= 1. */
  readonly concurrency: number;
  readonly worker: (item: T, index: number) => Promise<R>;
  /** ms to wait before retrying, given the 1-based retry attempt number.
   *  Default: exponential backoff, min(60_000, 1000 * 2^(attempt-1)). */
  readonly onRateLimit?: (attempt: number) => number;
  /** Injectable for tests; defaults to a real `setTimeout`-based sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Bounded retries on RateLimitSignal before giving up and rethrowing. */
const MAX_RATE_LIMIT_RETRIES = 5;

const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_CAP_MS = 60_000;

function defaultOnRateLimit(attempt: number): number {
  return Math.min(DEFAULT_BACKOFF_CAP_MS, DEFAULT_BACKOFF_BASE_MS * 2 ** (attempt - 1));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Runs a single item to completion, retrying on {@link RateLimitSignal} up to
 * {@link MAX_RATE_LIMIT_RETRIES} times using the provided backoff + sleep.
 */
async function runItemWithRetry<T, R>(
  item: T,
  index: number,
  worker: (item: T, index: number) => Promise<R>,
  onRateLimit: (attempt: number) => number,
  sleep: (ms: number) => Promise<void>,
): Promise<R> {
  let attempt = 0;
  for (;;) {
    try {
      return await worker(item, index);
    } catch (error) {
      if (!(error instanceof RateLimitSignal)) {
        throw error;
      }
      attempt += 1;
      if (attempt > MAX_RATE_LIMIT_RETRIES) {
        throw error;
      }
      await sleep(onRateLimit(attempt));
    }
  }
}

export async function runPipeline<T, R>(o: RunPipelineOptions<T, R>): Promise<R[]> {
  const { items, concurrency, worker } = o;
  const onRateLimit = o.onRateLimit ?? defaultOnRateLimit;
  const sleep = o.sleep ?? defaultSleep;

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`runPipeline: concurrency must be an integer >= 1 (got ${concurrency})`);
  }

  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runWorkerLoop(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      // Non-null: index < items.length was just checked above.
      const item = items[index] as T;
      results[index] = await runItemWithRetry(item, index, worker, onRateLimit, sleep);
    }
  }

  const poolSize = Math.min(concurrency, items.length);
  const pool = Array.from({ length: poolSize }, () => runWorkerLoop());
  await Promise.all(pool);

  return results;
}
