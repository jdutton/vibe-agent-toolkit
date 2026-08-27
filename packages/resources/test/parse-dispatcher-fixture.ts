/**
 * The two doubles a `ParseDispatcher` policy test needs, and nothing more.
 *
 * Both suites that drive activation directly — the environment surface and the
 * byte sizing — need a cache whose outcomes they control and a pool the
 * dispatcher can merely hold. Neither wants a REAL one: a real `ParseCache`
 * cannot be given a miss count without doing real parses, which would make an
 * activation test depend on the parser rather than on the policy, and a real
 * pool would own a thread.
 *
 * Distinct from `parse-pool-fixture.ts`, deliberately. That file's `fakePool`
 * runs the real parsers and records how the loop drove it, because the suites it
 * serves assert on derived rows and on fan-out. Nothing here is ever dispatched
 * to; {@link inertPool} exists only so `considerActivation` has something to
 * assign.
 */

import type { ParseResult } from '../src/link-parser.js';
import type { ParseCache } from '../src/parse-cache.js';
import type { ParsePool } from '../src/parse-pool.js';

/**
 * A parse that costs no parser.
 *
 * Answered for every lookup by {@link mutableCache}, so a document handed to
 * `ParseDispatcher.parse()` is RECORDED as a sample without remark running over
 * it — the subject of these suites is the policy arithmetic, and a test that had
 * to parse hundreds of real documents to reach it would be measuring remark.
 */
const CANNED_PARSE = {
  content: '',
  sizeBytes: 0,
  links: [],
  headings: [],
  estimatedTokenCount: 0,
} as unknown as ParseResult;

/** Cache outcomes a run has accrued. `misses` is what clears the threshold. */
export interface CacheOutcomes {
  hits?: number;
  misses: number;
}

/**
 * A cache stand-in exposing only what `ParseDispatcher` reads from one.
 *
 * Four members, verified against the class: `enabled` (the transport falls back
 * to the wire without a cache), `stats` (the activation threshold and the hit
 * rate the sizing discounts by), `directory` (handed to the pool), and `get`
 * (so `parse()` can record a sample and return).
 *
 * ⚠️ The counts must ACCRUE after construction. The dispatcher takes a baseline
 * in its constructor and works on the DELTA — deliberately, so an earlier lane's
 * outcomes cannot decide this run's pool — so a double reporting a fixed number
 * always presents a delta of zero and never activates anything.
 *
 * @returns The double, plus the setter that accrues outcomes against it
 */
export function mutableCache(): {
  cache: ParseCache;
  accrue: (outcomes: CacheOutcomes) => void;
} {
  const stats = { hits: 0, misses: 0 };
  const cache = {
    enabled: true,
    directory: '/nowhere/cache',
    stats,
    get: async (): Promise<ParseResult> => CANNED_PARSE,
    set: async (): Promise<void> => undefined,
  } as unknown as ParseCache;
  return {
    cache,
    accrue: ({ hits = 0, misses }: CacheOutcomes): void => {
      stats.hits = hits;
      stats.misses = misses;
    },
  };
}

/**
 * A pool the dispatcher can hold but must never dispatch to.
 *
 * `parse` REJECTS rather than answering, so a change that starts routing
 * documents here fails loudly instead of quietly succeeding against a double
 * that was never meant to serve one.
 *
 * @returns The double
 */
export function inertPool(): ParsePool {
  return {
    size: 1,
    parse: () => Promise.reject(new Error('this pool exists to be held, not used')),
    shutdown: () => Promise.resolve(),
  } as unknown as ParsePool;
}
