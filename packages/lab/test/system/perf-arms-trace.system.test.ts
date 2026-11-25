/**
 * Every arm repetition is traced: `GIT_TRACE2_EVENT` reaches VAT's own git
 * processes and a tool step's alike, so an arm that adds one timed
 * `git status` counts exactly one more git spawn in every round.
 *
 * System-tier: real git, the built vat, warm arms under a cleared environment.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { cleanupVerdictFixtures } from '../integration/verdict-fixtures.js';

import { captureBuildArms, CI_C_STATUS, CI_C_STEPS, repetitionsOf, twelveFileSubject } from './edit-arms.js';

afterAll(cleanupVerdictFixtures);

describe('perf arms: git spawns per repetition', () => {
  it('counts one more spawn per round for a timed git status, and the clean arm alike every round', async () => {
    const report = await captureBuildArms(twelveFileSubject(), [
      { arm: 'ci-c', state: 'warm', steps: CI_C_STEPS },
      { arm: CI_C_STATUS.arm, state: 'warm', steps: CI_C_STATUS.steps },
    ], null);

    expect(report.arms.map((arm) => arm.failure)).toEqual([null, null]);
    const clean = repetitionsOf(report, 'ci-c', 'warm');
    const status = repetitionsOf(report, CI_C_STATUS.arm, 'warm');
    expect(status.map((repetition, round) => (repetition.gitSpawns ?? 0) - (clean[round]?.gitSpawns ?? 0))).toEqual([1, 1, 1]);
    const [first] = clean;
    expect(new Set(clean.map((repetition) => repetition.gitSpawns)).size).toBe(1);
    // At least what one snapshot of VAT's own costs: its `add` into a temporary index and its `write-tree`.
    const add = first?.gitByVerb?.['add'] ?? 0;
    const writeTree = first?.gitByVerb?.['write-tree'] ?? 0;
    expect(add).toBeGreaterThanOrEqual(1);
    expect(writeTree).toBeGreaterThanOrEqual(1);
    expect(first?.gitSpawns).toBeGreaterThanOrEqual(add + writeTree);
  });
});
