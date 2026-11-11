/**
 * A cold `vat build` starts a parse thread per pool it holds open AT ONCE, not one per pool.
 *
 * Every parse runs in a worker pool (ADR I8), and the command builds a pool per lane and per
 * single-file parse. Before shut-down pools parked their healthy idle thread for the next one,
 * each of those pools started its own thread and loaded its parser for one or two documents:
 * eleven starts per run, about 1.1 s of a run that otherwise takes 60 ms, which made the fault
 * matrix (14,000 runs) seventeen times slower. The parse cache is off here (`makeCaseRoot` stubs
 * `VAT_CACHE=0`), so every parse is a miss: the coldest a run gets.
 *
 * Counted on the `worker_threads` diagnostics channel, which publishes one message per thread
 * constructed, so a thread started and closed between two samples is still counted.
 */

import diagnosticsChannel from 'node:diagnostics_channel';

import { installFaultFs } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { BUILD_FAMILY_SHARDS } from '../fault-matrix/cases/build-family.js';
import { runOnce } from '../fault-matrix/matrix.js';
import { cleanupTestTempDir, createTestTempDir } from '../system/test-common.js';

/** The most parse pools one `vat build` of this fixture holds open at the same time. */
const MOST_POOLS_OPEN_AT_ONCE = 2;

describe('a cold vat build', () => {
  let base: string | undefined;

  afterEach(() => {
    if (base !== undefined) cleanupTestTempDir(base);
    base = undefined;
  });

  it('starts no more parse threads than it holds pools open at once', async () => {
    base = createTestTempDir('vat-parse-threads-');
    let started = 0;
    const onWorker = (): void => {
      started += 1;
    };
    diagnosticsChannel.subscribe('worker_threads', onWorker);
    let exitCode: number | undefined;
    try {
      const { outcome } = await runOnce(BUILD_FAMILY_SHARDS['top-level-build'].make(), base, (r) => installFaultFs({ within: r.root }));
      exitCode = outcome.exitCode;
    } finally {
      diagnosticsChannel.unsubscribe('worker_threads', onWorker);
    }

    // A parked thread serves the NEXT pool, never one open beside its own: the run holds two pools
    // open at once at most (skill discovery's, and the projection's inside it), so two threads is
    // the floor, against eleven when every pool started its own. Never zero: that would be a run
    // that parsed nothing, and proved nothing. No thread an earlier file parked can serve this
    // run — the case root stubs HOME and TMPDIR to a fresh directory, and a parked thread serves
    // only a pool started under its own environment.
    expect(exitCode).toBe(0);
    expect(started).toBeGreaterThanOrEqual(1);
    expect(started).toBeLessThanOrEqual(MOST_POOLS_OPEN_AT_ONCE);
  });
});
