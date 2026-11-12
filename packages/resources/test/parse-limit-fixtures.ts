/**
 * Documents that drive the SHIPPED markdown parser past each parse limit.
 *
 * Real inputs, not a misbehaving test worker: each one is a document a corpus
 * can contain, and each was measured against the built parser before it became a
 * fixture. The limits a test runs them under are tightened so the suite pays
 * milliseconds, not the seconds the defaults allow.
 */

import { afterEach } from 'vitest';

import { isParseLimitError, MIN_HEAP_MB, type ParseLimitName, type ParseLimits } from '../src/parse-limits.js';
import { createParsePool, type ParsePool, type ParsePoolOptions } from '../src/parse-pool.js';

/**
 * A list nested `depth` levels deep. The parser's cost is quadratic in the depth:
 * 1,000 levels measured 9.3 s, so 1,500 runs for ~20 s — an order of magnitude
 * past the test's wall-clock bound, so a kill at the bound is unmistakable.
 *
 * @param depth - Nesting levels
 * @returns The document
 */
export function deeplyNestedList(depth = 1500): string {
  const lines = Array.from({ length: depth }, (_, level) => `${' '.repeat(level * 2)}- x`);
  return `${lines.join('\n')}\n`;
}

/**
 * `depth` nested block quotes. 10,000 overflow a 1 MiB stack (measured on the main thread:
 * `RangeError: Maximum call stack size exceeded` after ~100 ms).
 *
 * @param depth - Nesting levels
 * @returns The document
 */
export function deeplyNestedQuote(depth = 10_000): string {
  return `${'>'.repeat(depth)} x\n`;
}

/**
 * `count` paragraphs, each one link: a syntax tree that grows with the count, so
 * enough of them outgrow a small heap, and any number past a row cap breaches it.
 *
 * @param count - Paragraphs
 * @returns The document
 */
export function manyLinks(count: number): string {
  return Array.from({ length: count }, (_, index) => `[link ${index}](./target-${index}.md)\n`).join('\n');
}

/**
 * Limits tight enough for a test to breach quickly, loose enough for a normal
 * document. `timeMs` covers a cold worker's first parser load as well as the
 * parse, so it keeps room for a slow CI box to load the parser.
 */
export const TIGHT_LIMITS: ParseLimits = {
  timeMs: 2000,
  heapMb: MIN_HEAP_MB,
  stackMb: 1,
  outputRows: 1000,
  outputBytes: 256 * 1024,
  outputDepth: 1000,
  inputBytes: 8 * 1024 * 1024,
};

/**
 * Register a suite's pool lifecycle: every pool the returned factory opens is
 * shut down after the test that opened it.
 *
 * @returns A factory for pools under {@link TIGHT_LIMITS} with `limits` named over
 *   them, one thread unless `options` says otherwise
 */
export function limitedPools(): (limits?: Partial<ParseLimits>, options?: Omit<ParsePoolOptions, 'limits'>) => ParsePool {
  const open: ParsePool[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0, open.length).map((pool) => pool.shutdown()));
  });
  return (limits = {}, options = {}) => {
    const pool = createParsePool({ size: 1, ...options, limits: { ...TIGHT_LIMITS, ...limits } });
    open.push(pool);
    return pool;
  };
}

/**
 * The limit a pool job was stopped at.
 *
 * @param job - The job's promise
 * @returns The name of the limit it crossed
 * @throws If the job completed, or failed for any reason but a limit
 */
export async function limitStoppedAt(job: Promise<unknown>): Promise<ParseLimitName> {
  const error: unknown = await job.then(
    () => new Error('the job completed; it was meant to be stopped at a limit'),
    (rejection: unknown) => rejection,
  );
  if (!isParseLimitError(error)) throw error;
  return error.limit;
}
