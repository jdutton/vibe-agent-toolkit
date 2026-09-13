/**
 * `skillTestFailureReason` reads WHY a `vat skill test run` ended on `ERROR`
 * from the thrown error's own `reason` field — the answer that used to be three
 * exit codes (1 internal, 2 preflight, 3 bootstrap). Every VAT error class in
 * the feature declares one; a foreign error declares nothing and is the
 * harness's own fault, `internal`.
 */

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { isVatError } from '@vibe-agent-toolkit/utils';
import { AuthPreflightError } from '@vibe-agent-toolkit/utils/skill-test';
import { describe, expect, it } from 'vitest';

import { BuildHookError } from '../../src/skill-test/build-hook.js';
import { UnknownEnvTokenError } from '../../src/skill-test/declared-env.js';
import { EvalFragmentError } from '../../src/skill-test/eval-fragment.js';
import { EvalInputError } from '../../src/skill-test/eval-inputs.js';
import {
  BootstrapNeededError,
  DuplicateStagedSkillError,
  InternalHarnessError,
  SecurityAckError,
  SkillBuildError,
  skillTestFailureReason,
} from '../../src/skill-test/failure-reason.js';
import { GradingNonceError, GradingSkewError } from '../../src/skill-test/grading-adapter.js';
import { HarnessLocationError } from '../../src/skill-test/harness-location.js';
import { HarnessLockBusyError } from '../../src/skill-test/lock.js';
import { PromptInvariantError } from '../../src/skill-test/prompt-invariants.js';
import { verdictExitCode } from '../../src/skill-test/run-harness.js';

describe('skillTestFailureReason', () => {
  /**
   * Every row is a live pin on the class's own `reason` field: delete the field
   * and the row falls through to `internal`.
   */
  it.each([
    ['BootstrapNeededError', new BootstrapNeededError('/p/evals/evals.json'), 'bootstrap'],
    ['AuthPreflightError', new AuthPreflightError('x'), 'preflight'],
    ['HarnessLocationError', new HarnessLocationError('x'), 'preflight'],
    ['PromptInvariantError (a VAT-built prompt lost a safety directive)', new PromptInvariantError('x'), 'preflight'],
    ['SkillBuildError', new SkillBuildError('build blew up'), 'preflight'],
    ['SecurityAckError (missing ack before a build)', new SecurityAckError(), 'preflight'],
    ['DuplicateStagedSkillError (a staged name collides)', new DuplicateStagedSkillError('helper'), 'preflight'],
    ['HarnessLockBusyError (harness root held by another run)', new HarnessLockBusyError('/t/.lock'), 'preflight'],
    ['BuildHookError (the repo\'s own pre-stage build command failed)', new BuildHookError('hook failed', 1), 'preflight'],
    ['UnknownEnvTokenError (bad ${token} in a declared env value)', new UnknownEnvTokenError('nope', 'API_URL'), 'preflight'],
    ['EvalInputError (on EVERY route, not just the staging handler)', new EvalInputError('bad suite'), 'preflight'],
    ['GradingSkewError (parse failure surfaced, never success)', new GradingSkewError('x'), 'internal'],
    ['EvalFragmentError (per-eval fragment shape skew)', new EvalFragmentError('x'), 'internal'],
    ['GradingNonceError (forged/mismatched per-fragment grader nonce)', new GradingNonceError('nonce mismatch'), 'internal'],
    ['InternalHarnessError', new InternalHarnessError('x'), 'internal'],
  ] as const)('%s → %s', (_label, err, expected) => {
    expect(skillTestFailureReason(err)).toBe(expected);
    expect(isVatError(err)).toBe(true);
  });

  it('a foreign error is the harness\'s own fault: internal', () => {
    expect(skillTestFailureReason(new Error('boom'))).toBe('internal');
    expect(skillTestFailureReason('boom')).toBe('internal');
    expect(skillTestFailureReason({ reason: 'bootstrap' })).toBe('internal');
  });

  /**
   * The residual the old `exitCode` read left open, now closed: a FOREIGN error
   * carrying a plausible value is not opting in to anything. `commander`'s
   * `CommanderError` carries `exitCode: 2` and, under `exitOverride()`, exists
   * in-process; under the old read it reported "your environment is wrong" for
   * a crash. Only the VAT brand is consulted.
   */
  it.each(['preflight', 'bootstrap', 'internal'])(
    'ignores a foreign Error carrying reason %s — no VAT brand, no opt-in',
    (reason) => {
      expect(skillTestFailureReason(Object.assign(new Error('execa-shaped'), { reason }))).toBe('internal');
    },
  );

  it('ignores a VAT error whose reason is not one of the three', () => {
    const err = Object.assign(new InternalHarnessError('x'), { reason: 'sideways' });
    expect(skillTestFailureReason(err)).toBe('internal');
  });

  /**
   * Reading a property is not a total operation. Both call sites in
   * `packages/cli/src/commands/skill/test/run.ts` are inside `catch` blocks, so a
   * throw from the read escapes the handler entirely: no summary line, no chosen exit
   * code, a bare stack.
   */
  it('a throwing reason getter maps to internal instead of escaping the handler', () => {
    const err = new InternalHarnessError('getter');
    Object.defineProperty(err, 'reason', {
      get() { throw new Error('BOOM from getter'); },
    });
    expect(() => skillTestFailureReason(err)).not.toThrow();
    expect(skillTestFailureReason(err)).toBe('internal');
  });

  it('a Proxy that throws on get maps to internal instead of escaping the handler', () => {
    const err = new Proxy(new InternalHarnessError('proxy'), {
      get(target, key, receiver): unknown {
        if (key === 'reason') throw new Error('BOOM from proxy');
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    expect(() => skillTestFailureReason(err)).not.toThrow();
    expect(skillTestFailureReason(err)).toBe('internal');
  });
});

describe('verdictExitCode', () => {
  it('a failed eval is FINDINGS — the harness ran and what it examined did not pass', () => {
    expect(verdictExitCode(false, false)).toBe(ExitCode.FINDINGS);
  });
  it('every eval passing is OK', () => {
    expect(verdictExitCode(true, false)).toBe(ExitCode.OK);
  });
  it('--allow-eval-failure downgrades a failing verdict to OK', () => {
    expect(verdictExitCode(false, true)).toBe(ExitCode.OK);
  });
  it('never answers ERROR — a completed run is not a broken one', () => {
    expect(verdictExitCode(false, false)).not.toBe(ExitCode.ERROR);
  });
});

describe('BootstrapNeededError message', () => {
  const path = '/p/evals/evals.json';

  it('real run: states the template was written', () => {
    const err = new BootstrapNeededError(path);
    expect(err.expectedPath).toBe(path);
    expect(err.message).toContain('Wrote an evals.json template');
    expect(err.message).toContain(path);
  });

  it('dry run: states nothing was written and names where it would scaffold', () => {
    const err = new BootstrapNeededError(path, { dryRun: true });
    expect(err.expectedPath).toBe(path);
    expect(err.message).toContain('[dry-run]');
    expect(err.message).toContain('nothing was written');
    expect(err.message).toContain(path);
    expect(err.message).not.toContain('Wrote an evals.json template');
    // Same bootstrap-needed signal regardless of mode.
    expect(err.reason).toBe('bootstrap');
  });
});
