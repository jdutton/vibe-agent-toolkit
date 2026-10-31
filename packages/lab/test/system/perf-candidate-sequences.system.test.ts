/**
 * Every registered CI sequence, timed by `captureArms` with the candidate build
 * against a clean neutral committed subject, completes with each step at its
 * committed exit (0). A sequence that cannot complete on a clean subject would
 * make every arm built on it a FAILED row, never a time.
 *
 * System-tier: real git, the built vat, cold arms under a cleared environment.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { captureArms, sequenceSteps } from '../../src/facets/perf/arms.js';
import { MEASURABLE_SEQUENCES } from '../../src/harness/commands.js';
import { cleanupVerdictFixtures, tempDir } from '../integration/verdict-fixtures.js';

import { CANDIDATE_VAT, cleanSubject } from './candidate-subject.js';

afterAll(cleanupVerdictFixtures);

describe('the candidate CI sequences on a clean subject', () => {
  it('completes every registered sequence with each step at its committed exit', async () => {
    const root = cleanSubject();
    const sequences = Object.values(MEASURABLE_SEQUENCES);

    const report = await captureArms({
      out: tempDir('lab-arms-candidate-out-'),
      cwd: root,
      builds: [{ alias: 'candidate', instrument: CANDIDATE_VAT }],
      arms: sequences.map((sequence) => ({
        build: 'candidate',
        arm: sequence.name,
        state: 'cold' as const,
        steps: sequenceSteps(sequence, 'candidate', []),
      })),
      rounds: 1,
      env: { set: {}, unset: [] },
    });

    expect(report.arms.map((arm) => [arm.arm, arm.failure])).toEqual(sequences.map((sequence) => [sequence.name, null]));
    const exits = report.arms.flatMap((arm) => (arm.repetitions[0]?.steps ?? []).map((step) => [arm.arm, step.name, step.exitCode]));
    expect(exits).toEqual(
      sequences.flatMap((sequence) => sequence.steps.map((step) => [sequence.name, step.name, 0])),
    );
  }, 30_000);
});
