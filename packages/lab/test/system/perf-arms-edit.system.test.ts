/**
 * The edit arm, run by the built candidate beside a clean warm arm of the same
 * build in one invocation: every repetition edits its files (untimed), is
 * derived from the store and writes it back, and the report carries each edit
 * arm's gap to the clean arm.
 *
 * System-tier: real git, the built vat, warm arms under a cleared environment.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { cleanupVerdictFixtures } from '../integration/verdict-fixtures.js';

import { captureBuildArms, CI_C_STEPS, counted, repetitionsOf, twelveFileSubject } from './edit-arms.js';

afterAll(cleanupVerdictFixtures);

describe('perf arms: warm-edit arms beside a clean warm arm', () => {
  it('edits every repetition, derives and writes the store each round, and reports each gap', async () => {
    const report = await captureBuildArms(twelveFileSubject(), [
      { arm: 'ci-c', state: 'warm', steps: CI_C_STEPS },
      { arm: 'ci-c', state: { warm: 'edit', count: 1, kind: 'modify' }, steps: CI_C_STEPS },
      { arm: 'ci-c', state: { warm: 'edit', count: 10, kind: 'modify' }, steps: CI_C_STEPS },
    ], null);

    expect(report.arms.map((arm) => [arm.state, arm.failure])).toEqual([
      ['warm', null],
      ['warm-edit1', null],
      ['warm-edit10', null],
    ]);
    for (const [state, files] of [['warm-edit1', 1], ['warm-edit10', 10]] as const) {
      const repetitions = repetitionsOf(report, 'ci-c', state);
      expect(repetitions.map((repetition) => repetition.edits?.changed)).toEqual([files, files, files]);
      // Each round derived and wrote. Distinct bytes per round come from the round marker planEdits appends
      // (pinned in edit-step.test.ts); a delete arm repeating one window was measured served from the store.
      expect(repetitions.map((repetition) => repetition.violation)).toEqual([null, null, null]);
      for (const repetition of repetitions) {
        expect(counted(repetition, 'store.writes.persistent')).toBeGreaterThanOrEqual(1);
        expect(counted(repetition, 'store.reads.extent')).toBeGreaterThanOrEqual(1);
        expect(repetition.steps.map((step) => step.provenance?.resources)).toEqual(['derived']);
      }
    }
    expect(repetitionsOf(report, 'ci-c', 'warm').map((repetition) => repetition.edits)).toEqual([null, null, null]);
    expect(report.gaps.map((gap) => [gap.build, gap.sequence, gap.state])).toEqual([
      ['b', 'ci-c', 'warm-edit1'],
      ['b', 'ci-c', 'warm-edit10'],
    ]);
    expect(report.marginals.map((cost) => cost.state)).toEqual(['warm-edit10']);
  });
});
