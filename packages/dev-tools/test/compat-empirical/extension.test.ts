/**
 * Unit tests for the adaptive extension decision evaluator.
 *
 * The evaluator is a pure function over the first 3 RuntimeObservations of a
 * cell. It uses ONLY deterministic signals (no judge verdicts) so the
 * extension decision fits inside the run phase without coupling to the judge
 * phase. These tests pin the 4 ambiguity criteria and the 3 skip conditions.
 */

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { evaluateExtensionDecision } from '../../src/compat-empirical/run/extension.js';
import type { ExitStatus, RuntimeObservation } from '../../src/compat-empirical/types.js';

const FAKE_TRANSCRIPT_PATH = safePath.join(normalizedTmpdir(), 'vat-extension-test-fake.log');
const INSTALL_FAIL_NOTES = 'missing bundle';
const INSTALL_FAIL_ERROR = `install failed: ${INSTALL_FAIL_NOTES}`;

function obs(
  exitStatus: ExitStatus,
  partial: Partial<RuntimeObservation> = {},
): RuntimeObservation {
  const invocationDetected = exitStatus === 'completed';
  return {
    skillId: 's',
    target: 'claude-code',
    startedAt: new Date().toISOString(),
    durationMs: 1,
    exitStatus,
    invocationDetected,
    outputText: invocationDetected ? 'fake' : '',
    toolUseEvents: [],
    errors: [],
    installResult: { ok: true, notes: 'ok' },
    transcriptPath: FAKE_TRANSCRIPT_PATH,
    driverMode: 'scripted',
    promptId: 'p',
    attemptIdx: 0,
    ...partial,
  };
}

describe('evaluateExtensionDecision', () => {
  it('extends when 1 of 3 attempts is not-invoked', () => {
    const observations: RuntimeObservation[] = [
      obs('completed', { attemptIdx: 0 }),
      obs('completed', { attemptIdx: 1 }),
      obs('completed', {
        attemptIdx: 2,
        invocationDetected: false,
        outputText: 'agent ignored skill',
      }),
    ];
    const result = evaluateExtensionDecision(observations, 3);
    expect(result.extend).toBe(true);
    expect(result.reason).toMatch(/mixed trigger/i);
  });

  it('does not extend when all 3 attempts triggered identically', () => {
    const observations = [obs('completed'), obs('completed'), obs('completed')];
    const result = evaluateExtensionDecision(observations, 3);
    expect(result.extend).toBe(false);
    expect(result.reason).toBe('unanimous');
  });

  it('extends when 1 of 3 attempts had a transient runtime-error', () => {
    const observations: RuntimeObservation[] = [
      obs('completed'),
      obs('completed'),
      obs('error', {
        attemptIdx: 2,
        errors: ['ENOENT'],
        installResult: { ok: true, notes: 'ok' },
      }),
    ];
    const result = evaluateExtensionDecision(observations, 3);
    expect(result.extend).toBe(true);
    expect(result.reason).toMatch(/transient failure/i);
  });

  it('does not extend when any attempt was install-failed', () => {
    const installFailed = { ok: false, notes: INSTALL_FAIL_NOTES } as const;
    const installFailErrors = [INSTALL_FAIL_ERROR];
    const observations: RuntimeObservation[] = [
      obs('error', { attemptIdx: 0, installResult: installFailed, errors: installFailErrors }),
      obs('error', { attemptIdx: 1, installResult: installFailed, errors: installFailErrors }),
      obs('error', { attemptIdx: 2, installResult: installFailed, errors: installFailErrors }),
    ];
    const result = evaluateExtensionDecision(observations, 3);
    expect(result.extend).toBe(false);
    expect(result.reason).toBe('install-failed');
  });

  it('does not extend when repeatN is not 3', () => {
    const observations = [
      obs('completed'),
      obs('completed'),
      obs('completed'),
      obs('completed'),
      obs('completed'),
    ];
    const result = evaluateExtensionDecision(observations, 5);
    expect(result.extend).toBe(false);
    expect(result.reason).toBe('repeatN-not-3');
  });

  it('extends when triggered attempts have mixed deterministic class', () => {
    const observations: RuntimeObservation[] = [
      obs('completed', { attemptIdx: 0, outputText: 'output here' }),
      obs('completed', { attemptIdx: 1, outputText: '' }),
      obs('completed', { attemptIdx: 2, outputText: 'more output' }),
    ];
    const result = evaluateExtensionDecision(observations, 3);
    expect(result.extend).toBe(true);
    expect(result.reason).toMatch(/mixed deterministic class/i);
  });

  it('extends when refusal is inconsistent', () => {
    const observations: RuntimeObservation[] = [
      obs('completed', { attemptIdx: 0 }),
      obs('completed', {
        attemptIdx: 1,
        outputText: "I'm not able to help with that",
      }),
      obs('completed', { attemptIdx: 2 }),
    ];
    const result = evaluateExtensionDecision(observations, 3);
    expect(result.extend).toBe(true);
    expect(result.reason).toMatch(/inconsistent refusal/i);
  });
});
