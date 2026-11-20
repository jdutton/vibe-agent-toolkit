/**
 * A cold verb starts a parse thread per pool it holds open AT ONCE, not one per pool.
 *
 * Every parse runs in a worker pool (ADR I8), and a verb's run holds one dispatcher every lane
 * parses on. Before shut-down pools parked their healthy idle thread for the next one, each pool
 * a lane opened beside its run's started its own thread and loaded its parser for one or two
 * documents: eleven starts per `vat build`, about 1.1 s of a run that otherwise takes 60 ms,
 * which made the fault matrix (14,000 runs) seventeen times slower. The parse cache is off here
 * (`makeCaseRoot` stubs `VAT_CACHE=0`), so every parse is a miss: the coldest a run gets.
 *
 * Counted on the `worker_threads` diagnostics channel, which publishes one message per thread
 * constructed, so a thread started and closed between two samples is still counted.
 */

import diagnosticsChannel from 'node:diagnostics_channel';

import { installFaultFs } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { createAuditCommand } from '../../src/commands/audit.js';
import { createSkillCommand } from '../../src/commands/skill/index.js';
import { BUILD_FAMILY_SHARDS } from '../fault-matrix/cases/build-family.js';
import type { VerbCase } from '../fault-matrix/drive.js';
import { runOnce } from '../fault-matrix/matrix.js';
import { cleanupTestTempDir, createTestTempDir } from '../system/test-common.js';

/** The most parse pools one `vat build` of this fixture holds open at the same time. */
const MOST_POOLS_OPEN_AT_ONCE = 2;

/** The build fixture's skill, as the read-only verbs name it. */
const SKILL_DIR = 'skills/fx-skill';

/** The build fixture, run by another verb: same project, same cold cache, only the verb differs. */
function onBuildFixture(id: string, group: VerbCase['group'], argv: readonly string[]): VerbCase {
  return { ...BUILD_FAMILY_SHARDS['top-level-build'].make(), id, group, argv: () => argv };
}

/**
 * Each verb and the exit code its clean run ends on. A read-only verb holds ONE run, so one pool:
 * a second thread is a lane that opened a pool of its own beside its run's.
 */
const VERBS: ReadonlyArray<{ name: string; make: () => VerbCase; exitCode: number; mostPools: number }> = [
  { name: 'vat build', make: () => BUILD_FAMILY_SHARDS['top-level-build'].make(), exitCode: 0, mostPools: MOST_POOLS_OPEN_AT_ONCE },
  { name: 'vat skill review', make: () => onBuildFixture('skill/review', createSkillCommand, ['review', SKILL_DIR]), exitCode: 0, mostPools: 1 },
  { name: 'vat audit', make: () => onBuildFixture('audit', createAuditCommand, [SKILL_DIR]), exitCode: 0, mostPools: 1 },
];

describe('a cold verb', () => {
  let base: string | undefined;

  afterEach(() => {
    if (base !== undefined) cleanupTestTempDir(base);
    base = undefined;
  });

  it.each(VERBS)('$name starts no more parse threads than it holds pools open at once', async ({ make, exitCode, mostPools }) => {
    base = createTestTempDir('vat-parse-threads-');
    let started = 0;
    const onWorker = (): void => {
      started += 1;
    };
    diagnosticsChannel.subscribe('worker_threads', onWorker);
    let outcome: Awaited<ReturnType<typeof runOnce>>['outcome'];
    try {
      ({ outcome } = await runOnce(make(), base, (r) => installFaultFs({ within: r.root })));
    } finally {
      diagnosticsChannel.unsubscribe('worker_threads', onWorker);
    }

    // A parked thread serves the NEXT pool, never one open beside its own: the run holds
    // `mostPools` pools open at once at most, so that many threads is the ceiling, against
    // eleven when every pool started its own. Never zero: that would be a run that parsed
    // nothing, and proved nothing. No thread an earlier test parked can serve this run — the
    // case root stubs HOME and TMPDIR to a fresh directory, and a parked thread serves only a
    // pool started under its own environment.
    expect(outcome.exitCode, outcome.stderr).toBe(exitCode);
    expect(started).toBeGreaterThanOrEqual(1);
    expect(started).toBeLessThanOrEqual(mostPools);
  });
});
