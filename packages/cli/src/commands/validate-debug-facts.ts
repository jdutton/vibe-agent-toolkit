/**
 * `vat validate`'s debug-facts dump: what the run says about its own checks phase when
 * `VAT_VALIDATE_DEBUG_FACTS` names a directory. A mode and post-spawn facts, not work counters:
 *
 * - `checksOverlapped`: 1 when the checks child was spawned during the resources phase, else 0;
 * - `gateDeclinedBy`: the overlap gate's first failing condition (for a member, the member and the
 *   route that sends it cold), or `null` when the run overlapped;
 * - `childStderrBytesAtTurn`: the bytes the child had written to its held stderr when the checks
 *   turn started copying it (0 when sequential);
 * - `parentStoreWritesUntilChildExit`, `parentParseCacheWritesUntilChildExit`: this process's
 *   `store.writes.persistent` and `parse.cache.written` counts from the spawn to the child's exit
 *   (0 when sequential: there is no window). The window ends at the CHILD's exit, not this
 *   process's, because the skills phase may parse and write after it. The store count is 0 in
 *   every overlapped run: the gate admits the overlap only when the parent computes nothing after
 *   the spawn. The parse-cache count is 0 too, unless a member the gate admitted became unreadable
 *   before admission probed it: that member is computed after the spawn and its parse-cache write
 *   (an atomic rename beside the child's) is counted here.
 *
 * 🔑 The reader is the lab's `ValidateDebugFactsSchema` (`packages/lab/src/facets/perf/types.ts`), a
 * strict schema. Neither package depends on the other; the lab's
 * `test/system/validate-debug-facts.system.test.ts` runs the built vat and parses its dumps with that
 * schema, so {@link ValidateDebugFacts} and the schema change together or that test fails.
 *
 * Written through `writeTimingDump`, as every VAT dump seam is: a failure is a stderr line, never a
 * throw, and the name is claimed per pid.
 */

import {
  ensureTimingDirectory,
  normalizeTimingDirectory,
  writeTimingDump,
  type WorkCounter,
} from '@vibe-agent-toolkit/utils';

import type { GateDecline } from './checks-overlap-gate.js';

/** The variable naming the directory the dump is written to. */
export const VALIDATE_DEBUG_FACTS_ENV = 'VAT_VALIDATE_DEBUG_FACTS';

/** What the seam is called in a failure line. */
const DUMP_NOUN = 'validate debug-facts';

/** Basename stem of a dump; the pid and any collision counter follow it. */
const DUMP_BASENAME = 'validate-debug-facts';

/** The dump body. Agrees with the lab's `ValidateDebugFactsSchema`, field for field. */
export interface ValidateDebugFacts {
  readonly checksOverlapped: 0 | 1;
  readonly gateDeclinedBy: GateDecline | null;
  readonly childStderrBytesAtTurn: number;
  readonly parentStoreWritesUntilChildExit: number;
  readonly parentParseCacheWritesUntilChildExit: number;
}

/** This process's work counters at one instant (`readWorkCounters`). */
export type CounterSnapshot = Readonly<Record<WorkCounter, number>>;

/** What the run observed about its checks phase, from which the facts are stated. */
export type ChecksPhaseObservation =
  | { readonly mode: 'sequential'; readonly declinedBy: GateDecline }
  | {
      readonly mode: 'overlapped';
      readonly childStderrBytesAtTurn: number;
      /** The counters immediately before the synchronous spawn. */
      readonly atSpawn: CounterSnapshot;
      /** The counters at the child's exit (or at the run's ending, for a child that never exits). */
      readonly atChildExit: CounterSnapshot;
    };

/**
 * State the facts.
 *
 * @param observed - What the run observed
 * @returns The dump body
 */
export function validateDebugFacts(observed: ChecksPhaseObservation): ValidateDebugFacts {
  if (observed.mode === 'sequential') {
    return {
      checksOverlapped: 0,
      gateDeclinedBy: observed.declinedBy,
      childStderrBytesAtTurn: 0,
      parentStoreWritesUntilChildExit: 0,
      parentParseCacheWritesUntilChildExit: 0,
    };
  }
  const since = (counter: WorkCounter): number => observed.atChildExit[counter] - observed.atSpawn[counter];
  return {
    checksOverlapped: 1,
    gateDeclinedBy: null,
    childStderrBytesAtTurn: observed.childStderrBytesAtTurn,
    parentStoreWritesUntilChildExit: since('store.writes.persistent'),
    parentParseCacheWritesUntilChildExit: since('parse.cache.written'),
  };
}

/**
 * The directory the dump goes to, or `null` when the seam is off (unset or empty).
 *
 * @param env - The process environment
 * @returns The directory, as named
 */
export function debugFactsDirectory(env: NodeJS.ProcessEnv): string | null {
  return normalizeTimingDirectory(env[VALIDATE_DEBUG_FACTS_ENV]);
}

/**
 * Turn the seam on: make the directory now, while a bad path can still be reported before the
 * run, as every dump seam does.
 *
 * @param env - The process environment
 * @returns The directory to write to, or `null` when the seam is off or the directory could not
 *   be made (reported once)
 */
export function openDebugFacts(env: NodeJS.ProcessEnv): string | null {
  return ensureTimingDirectory(DUMP_NOUN, debugFactsDirectory(env));
}

/**
 * Write the dump, if the seam is on. Never throws.
 *
 * @param directory - From {@link openDebugFacts}
 * @param observed - What the run observed
 * @returns The path written, or `null` when the seam is off or the write failed (said on stderr)
 */
export function writeDebugFacts(directory: string | null, observed: ChecksPhaseObservation): string | null {
  return writeTimingDump(DUMP_NOUN, directory, DUMP_BASENAME, () => validateDebugFacts(observed));
}
