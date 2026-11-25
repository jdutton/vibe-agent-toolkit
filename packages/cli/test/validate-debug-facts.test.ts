/**
 * `vat validate`'s debug-facts dump: the mode the checks child ran in, why the gate declined, and
 * the parent's store and parse-cache writes from the spawn to the child's exit. Pure: the counter
 * snapshots are built here, and nothing is written.
 */

import { WORK_COUNTER_NAMES, type WorkCounter } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  debugFactsDirectory,
  validateDebugFacts,
  VALIDATE_DEBUG_FACTS_ENV,
} from '../src/commands/validate-debug-facts.js';

/** A counter snapshot: every counter at `base`, with `overrides` on top. */
function snapshot(base: number, overrides: Partial<Record<WorkCounter, number>>): Readonly<Record<WorkCounter, number>> {
  return { ...Object.fromEntries(WORK_COUNTER_NAMES.map((name) => [name, base])), ...overrides } as Record<WorkCounter, number>;
}

describe('validateDebugFacts', () => {
  it('writes the dump with the mode and post-spawn write counts', () => {
    const atSpawn = snapshot(7, { 'store.writes.persistent': 3, 'parse.cache.written': 10 });
    const atChildExit = snapshot(40, { 'store.writes.persistent': 5, 'parse.cache.written': 11 });

    expect(validateDebugFacts({ mode: 'overlapped', childStderrBytesAtTurn: 42, atSpawn, atChildExit })).toEqual({
      checksOverlapped: 1,
      gateDeclinedBy: null,
      childStderrBytesAtTurn: 42,
      parentStoreWritesUntilChildExit: 2,
      parentParseCacheWritesUntilChildExit: 1,
    });
  });

  it('states a sequential run with its decline and no post-spawn window', () => {
    expect(validateDebugFacts({
      mode: 'sequential',
      declinedBy: { condition: 'member', member: 'docs/a.md', route: 'readRoute' },
    })).toEqual({
      checksOverlapped: 0,
      gateDeclinedBy: { condition: 'member', member: 'docs/a.md', route: 'readRoute' },
      childStderrBytesAtTurn: 0,
      parentStoreWritesUntilChildExit: 0,
      parentParseCacheWritesUntilChildExit: 0,
    });
  });
});

describe('debugFactsDirectory', () => {
  it('turns the seam off when the env is unset or empty', () => {
    expect(debugFactsDirectory({})).toBeNull();
    expect(debugFactsDirectory({ [VALIDATE_DEBUG_FACTS_ENV]: '' })).toBeNull();
  });

  it('names the directory the env names', () => {
    expect(debugFactsDirectory({ [VALIDATE_DEBUG_FACTS_ENV]: '/tmp/facts' })).toBe('/tmp/facts');
  });
});
