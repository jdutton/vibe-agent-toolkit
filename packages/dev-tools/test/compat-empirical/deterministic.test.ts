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

  it('returns install-failed when installResult.ok is false', () => {
    expect(
      classifyDeterministic(
        baseObservation({
          exitStatus: 'error',
          installResult: { ok: false, notes: 'missing bundle' },
        }),
      ),
    ).toBe('install-failed');
  });

  it('install-failed takes precedence even when exit completed', () => {
    expect(
      classifyDeterministic(
        baseObservation({
          exitStatus: 'completed',
          installResult: { ok: false, notes: 'pre-install failure' },
        }),
      ),
    ).toBe('install-failed');
  });

  it('returns runtime-error when install succeeded but exit was error', () => {
    expect(
      classifyDeterministic(baseObservation({ exitStatus: 'error', errors: ['ENOENT'] })),
    ).toBe('runtime-error');
  });

  it('returns not-invoked-engaged when output exists but no invocation', () => {
    expect(
      classifyDeterministic(
        baseObservation({ invocationDetected: false, outputText: 'agent did something else' }),
      ),
    ).toBe('not-invoked-engaged');
  });

  it('returns not-invoked-empty when transcript is empty', () => {
    expect(
      classifyDeterministic(baseObservation({ invocationDetected: false, outputText: '' })),
    ).toBe('not-invoked-empty');
  });

  it('returns not-invoked-empty when transcript is whitespace only', () => {
    expect(
      classifyDeterministic(baseObservation({ invocationDetected: false, outputText: '   \n\t' })),
    ).toBe('not-invoked-empty');
  });

  it('returns refused when refusal pattern matches in the not-invoked path', () => {
    expect(
      classifyDeterministic(
        baseObservation({
          invocationDetected: false,
          outputText: "I'm not able to help with that request.",
        }),
      ),
    ).toBe('refused');
  });

  it('returns refused when refusal pattern matches in the invoked path', () => {
    expect(
      classifyDeterministic(
        baseObservation({
          invocationDetected: true,
          outputText: 'I cannot perform this action.',
        }),
      ),
    ).toBe('refused');
  });

  it('refusal regex does not match incidental phrases like "I will help"', () => {
    expect(
      classifyDeterministic(
        baseObservation({ outputText: 'I will help by running the skill now.' }),
      ),
    ).toBe('invoked-output');
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
