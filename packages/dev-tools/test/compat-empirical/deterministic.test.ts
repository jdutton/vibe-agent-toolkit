import { describe, expect, it } from 'vitest';

import { classifyDeterministic } from '../../src/compat-empirical/judge/deterministic.js';
import type { RuntimeObservation } from '../../src/compat-empirical/types.js';

function baseObservation(overrides: Partial<RuntimeObservation> = {}): RuntimeObservation {
  return {
    skillId: 'test-skill',
    target: 'claude-code',
    startedAt: '2026-05-22T00:00:00.000Z',
    durationMs: 100,
    exitStatus: 'completed',
    invocationDetected: true,
    outputText: 'some output',
    toolUseEvents: [],
    errors: [],
    installResult: { ok: true, notes: '' },
    transcriptPath: 'tests/fake-transcript.log',
    driverMode: 'scripted',
    promptId: 'fixture-prompt',
    attemptIdx: 0,
    ...overrides,
  };
}

describe('classifyDeterministic', () => {
  it('marks skipped runs as skipped', () => {
    expect(classifyDeterministic(baseObservation({ exitStatus: 'skipped' }))).toBe('skipped');
    expect(classifyDeterministic(baseObservation({ exitStatus: 'user-aborted' }))).toBe('skipped');
  });

  it('marks timeout exits as timeout regardless of output', () => {
    expect(
      classifyDeterministic(baseObservation({ exitStatus: 'timeout', outputText: 'partial' })),
    ).toBe('timeout');
  });

  it('marks error exits as runtime-error', () => {
    // TASK-5-WILL-REPLACE: classifier currently maps any error exit with ok install
    // to runtime-error; Task 5 splits install-failed vs runtime-error properly.
    expect(classifyDeterministic(baseObservation({ exitStatus: 'error' }))).toBe('runtime-error');
  });

  it('marks completed runs with no invocation as not-invoked-engaged', () => {
    // TASK-5-WILL-REPLACE: classifier currently distinguishes not-invoked-engaged
    // (output present) from not-invoked-empty by trimmed output length; Task 5
    // refines this with proper engagement detection.
    expect(
      classifyDeterministic(baseObservation({ invocationDetected: false, outputText: 'noise' })),
    ).toBe('not-invoked-engaged');
  });

  it('distinguishes invoked-output from invoked-no-output', () => {
    expect(
      classifyDeterministic(baseObservation({ invocationDetected: true, outputText: '   ' })),
    ).toBe('invoked-no-output');
    expect(
      classifyDeterministic(baseObservation({ invocationDetected: true, outputText: 'real' })),
    ).toBe('invoked-output');
  });
});
