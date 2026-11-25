/**
 * The touched-LFS arm, run by the built candidate: after a touch git re-cleans
 * every filtered file once per snapshot (the tree hash is unchanged, so the run
 * is a store hit), and after `git update-index --refresh` it re-cleans none.
 *
 * System-tier: real git running the lab's filter script, the built vat.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { LFS_FILTER_SCRIPT, runLfsTouchArm } from '../../src/facets/perf/lfs-touch.js';
import { cleanupVerdictFixtures, tempDir } from '../integration/verdict-fixtures.js';

import { CANDIDATE_VAT } from './candidate-subject.js';

afterAll(cleanupVerdictFixtures);

/** N filtered files of S bytes: small, so the file stays inside the system tier's budget. */
const FILES = 3;
const SIZE = 64 * 1024;

describe('perf lfs-touch: a touched LFS file costs a clean-filter pass per snapshot', () => {
  it('re-cleans every touched file on a store hit, and none once the index is refreshed', async () => {
    const report = await runLfsTouchArm(
      { alias: 'b', instrument: CANDIDATE_VAT },
      { armsRoot: tempDir('lab-lfs-touch-'), files: FILES, size: SIZE, rounds: 2, filterScript: LFS_FILTER_SCRIPT, timeoutMs: undefined },
    );

    expect(report.rounds).toHaveLength(2);
    for (const { touched, refreshed } of report.rounds) {
      expect(touched.bytes).toBeGreaterThanOrEqual(FILES * SIZE);
      expect(touched.workRefusal).toBeNull();
      // A store hit takes one snapshot; a miss would take another and re-clean every file again.
      expect(touched.population).toBe('store');
      expect(touched.gitSnapshots).toBe(1);
      expect(touched.invocations).toBe(FILES);
      expect(refreshed.population).toBe('store');
      expect(refreshed.invocations).toBe(0);
      expect(refreshed.bytes).toBe(0);
    }
  });
});
