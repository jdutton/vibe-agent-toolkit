/**
 * The work counters a warm admission must leave untouched, and the one it moves, read as one
 * snapshot so a suite can take a difference across a run.
 *
 * Framework-free, like everything under `testing/`: no `vitest` import.
 */

import { readWorkCounters } from '../work-counters.js';

/** The counters a store-hydration suite reads. */
export interface WorkSpent {
  readonly reads: number;
  readonly hashed: number;
  readonly parseLookups: number;
  readonly admitted: number;
}

/** @returns The counters now, every parse lookup (`parse.*`) summed into `parseLookups` */
export function workSpentNow(): WorkSpent {
  const counters = readWorkCounters();
  const parseLookups = Object.entries(counters)
    .filter(([name]) => name.startsWith('parse.'))
    .reduce((sum, [, value]) => sum + value, 0);
  return { reads: counters['content.read'], hashed: counters['content.hashed'], parseLookups, admitted: counters['registry.admitted'] };
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
