/**
 * A registered CI sequence as the steps an arm times: each step's command,
 * timing, reader and committed exits — which the operator may set per
 * (build, sequence, step) and which default to 0.
 *
 * What timing those steps does is pinned in `integration/perf-arms.integration.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { expectedExitRefusal, sequenceSteps } from '../src/facets/perf/arms.js';
import { MEASURABLE_SEQUENCES } from '../src/harness/commands.js';

describe('sequenceSteps', () => {
  it('turns a CI sequence into timed steps carrying each command’s reader, each committed to exit 0 by default', () => {
    const steps = sequenceSteps(MEASURABLE_SEQUENCES['ci-b'], 'cand', []);

    expect(steps.map((step) => [step.name, step.command, step.timed, step.expectedExits, step.provenance])).toEqual([
      ['resources-validate-ci', { kind: 'vat', args: ['resources', 'validate'] }, true, [0], 'none'],
      ['resources-check-ci', { kind: 'vat', args: ['resources', 'check'] }, true, [0], 'resources-check'],
      ['skills-validate-ci', { kind: 'vat', args: ['skills', 'validate'] }, true, [0], 'none'],
    ]);
  });

  it('commits a step to the ONE exit set for exactly its (build, sequence, step), and no other arm’s', () => {
    const expected = [{ build: 'cand', sequence: 'ci-b', step: 'resources-check-ci', exit: 1 }];

    expect(sequenceSteps(MEASURABLE_SEQUENCES['ci-b'], 'cand', expected).map((step) => step.expectedExits)).toEqual([
      [0],
      [1],
      [0],
    ]);
    // Another build of the same sequence keeps the default.
    expect(sequenceSteps(MEASURABLE_SEQUENCES['ci-b'], 'rc11', expected).map((step) => step.expectedExits)).toEqual([
      [0],
      [0],
      [0],
    ]);
  });
});

describe('expectedExitRefusal', () => {
  const arms = [{ build: 'cand', sequence: MEASURABLE_SEQUENCES['ci-c'] }];

  it('accepts an expectation naming an arm’s build, sequence and one of its steps', () => {
    expect(expectedExitRefusal(arms, [{ build: 'cand', sequence: 'ci-c', step: 'validate-ci', exit: 1 }])).toBeNull();
  });

  it('refuses an expectation that names no --arm, or a step its sequence does not run', () => {
    expect(expectedExitRefusal(arms, [{ build: 'rc11', sequence: 'ci-c', step: 'validate-ci', exit: 1 }])).toMatch(
      /rc11:ci-c.*no --arm/u,
    );
    expect(expectedExitRefusal(arms, [{ build: 'cand', sequence: 'ci-c', step: 'skills-validate-ci', exit: 1 }])).toMatch(
      /'skills-validate-ci'.*validate-ci/u,
    );
  });
});
