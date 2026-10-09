/**
 * `refusalOfRecord`: which refusal (and message) a matrix run is judged by. A non-composite verb is
 * judged by its top-level refusal, always. A DECLARED composite verb (an orchestrator folding its
 * phases) is judged by its one failed phase, and only when the top level is exactly the fold.
 * Pure — hand-built outcomes.
 */
import { describe, expect, it } from 'vitest';

import { refusalOfRecord } from './fault-matrix/composite.js';
import type { VerbOutcome } from './fault-matrix/invariants.js';

const FOLD = "The run did not finish: phase 'skills build' (INPUT_UNREADABLE) stopped before it did.";
const phase = (name: string, code: string, message: string) => ({ name, code, message });

const outcome = (o: Partial<VerbOutcome>): VerbOutcome => ({
  exitCode: 2, refusal: 'RUN_INCOMPLETE', message: FOLD, warnings: [], stdout: '', stderr: '',
  phaseRefusals: [phase('skills build', 'INPUT_UNREADABLE', 'Could not read x')],
  ...o,
});

describe('refusalOfRecord', () => {
  it('a declared composite is judged by its one failed phase', () => {
    expect(refusalOfRecord(outcome({}), true)).toEqual({ refusal: 'INPUT_UNREADABLE', message: 'Could not read x', via: "phase 'skills build'" });
  });

  it('a non-composite verb is judged by its top level even when its report carries phases: it cannot take the phase route', () => {
    expect(refusalOfRecord(outcome({}), false)).toEqual({ refusal: 'RUN_INCOMPLETE', message: FOLD, via: 'top level' });
  });

  it('a composite whose top-level refusal beside a failed phase is not exactly RUN_INCOMPLETE is a problem, not a phase route', () => {
    expect(refusalOfRecord(outcome({ refusal: 'USAGE_INVALID' }), true)).toEqual({ problem: expect.stringContaining('USAGE_INVALID with a failed phase, not the fold') });
  });

  it('a composite\'s own refusal, with no failed phase (the config would not load), is judged at the top level', () => {
    const own = outcome({ refusal: 'INPUT_UNREADABLE', message: 'Failed to load config', phaseRefusals: [] });
    expect(refusalOfRecord(own, true)).toEqual({ refusal: 'INPUT_UNREADABLE', message: 'Failed to load config', via: 'top level' });
    const noPhases: VerbOutcome = { exitCode: 2, refusal: 'INPUT_UNREADABLE', message: 'Failed to load config', warnings: [], stdout: '', stderr: '' };
    expect(refusalOfRecord(noPhases, true)).toMatchObject({ via: 'top level' });
  });

  it('a composite fold must name exactly one failed phase', () => {
    const two = [phase('a', 'RUN_INCOMPLETE', 'x'), phase('b', 'INPUT_UNREADABLE', 'y')];
    expect(refusalOfRecord(outcome({ phaseRefusals: two }), true)).toEqual({ problem: expect.stringContaining('2 failed phases (a, b)') });
  });

  it('a composite that succeeded, or ended with no report or an escaped throw, is judged at the top level (I1 owns those)', () => {
    for (const refusal of [undefined, 'NO_REPORT', 'INTERNAL_ERROR']) {
      expect(refusalOfRecord(outcome({ refusal, phaseRefusals: [] }), true)).toMatchObject({ via: 'top level', refusal });
    }
  });
});
