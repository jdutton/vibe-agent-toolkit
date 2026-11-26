/**
 * A parse pool that stands in for a real one: every member delegates to `real`, except the
 * ones a test overrides to observe or refuse what the pool is handed.
 *
 * Every member is delegated rather than omitted: the wrapper stands in for a REAL pool, and a
 * member it silently lacks would make a run fail on the wrapper instead of on the thing under
 * test. Written once, a member added to `ParsePool` is delegated for every test double at once.
 */

import type { ParsePool } from '../../src/parse-pool.js';

/** The members a test may intercept. */
export type ParsePoolOverrides = Partial<Pick<ParsePool, 'parse' | 'parseIntoCache'>>;

/**
 * @param real - The pool every member not overridden delegates to
 * @param overrides - The members the test intercepts
 * @returns The wrapping pool
 */
export function delegatingParsePool(real: ParsePool, overrides: ParsePoolOverrides = {}): ParsePool {
  return {
    size: real.size,
    parse: (kind, content, byteLength) => real.parse(kind, content, byteLength),
    parseIntoCache: (kind, content, byteLength, cacheKey) => real.parseIntoCache(kind, content, byteLength, cacheKey),
    harnessFacts: (harness, content, byteLength) => real.harnessFacts(harness, content, byteLength),
    dataRows: (variant, content, byteLength, bom) => real.dataRows(variant, content, byteLength, bom),
    shutdown: () => real.shutdown(),
    ...overrides,
  };
}
