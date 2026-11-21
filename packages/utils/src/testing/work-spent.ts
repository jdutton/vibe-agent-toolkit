/**
 * The work counters a warm admission must leave untouched, and the one it moves, read as one
 * snapshot so a suite can take a difference across a run.
 *
 * Framework-free, like everything under `testing/`: no `vitest` import.
 */

import { readWorkCounters, type WorkCounter } from '../work-counters.js';

/**
 * The counters that are a parse lookup: one per document the parse lane answered, whichever way
 * it answered (a cache hit, a dispatch to a parser, or a refusal). The one definition every
 * work-counter suite sums.
 *
 * `parse.redispatched` is not one. It counts a SECOND dispatch of a document `parse.dispatched`
 * already counted (its cache entry vanished between the worker's write and the read-back), so
 * summing it would count that document twice and break "one lookup per parsed document". A suite
 * asserting no parse work loses nothing by leaving it out: a redispatch only ever follows a
 * dispatch of the same document, which this sum counts.
 */
export const PARSE_LOOKUP_COUNTERS: readonly WorkCounter[] = [
  'parse.cache.hit',
  'parse.dispatched',
  'parse.refused.keyDetermined',
  'parse.refused.inputCap.read',
  'parse.refused.inputCap.dispatch',
  'parse.refused.load',
];

/**
 * @param counts - Counter values (a thread's counters, or one phase's)
 * @returns The parse lookups among them ({@link PARSE_LOOKUP_COUNTERS})
 */
export function parseLookupsIn(counts: Readonly<Record<WorkCounter, number>>): number {
  return PARSE_LOOKUP_COUNTERS.reduce((sum, name) => sum + counts[name], 0);
}

/** The counters a store-hydration suite reads. */
export interface WorkSpent {
  readonly reads: number;
  readonly hashed: number;
  readonly parseLookups: number;
  readonly admitted: number;
}

/** @returns The counters now, the parse lookups summed into `parseLookups` ({@link parseLookupsIn}) */
export function workSpentNow(): WorkSpent {
  const counters = readWorkCounters();
  return { reads: counters['content.read'], hashed: counters['content.hashed'], parseLookups: parseLookupsIn(counters), admitted: counters['registry.admitted'] };
}

/**
 * @param after - A reading taken after the work
 * @param before - A reading taken before it
 * @returns What the work spent
 */
export function workSpentSince(after: WorkSpent, before: WorkSpent): WorkSpent {
  return {
    reads: after.reads - before.reads,
    hashed: after.hashed - before.hashed,
    parseLookups: after.parseLookups - before.parseLookups,
    admitted: after.admitted - before.admitted,
  };
}
