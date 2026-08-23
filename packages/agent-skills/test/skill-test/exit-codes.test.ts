import { AuthPreflightError } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { BuildHookError } from '../../src/skill-test/build-hook.js';
import { UnknownEnvTokenError } from '../../src/skill-test/declared-env.js';
import { EvalFragmentError } from '../../src/skill-test/eval-fragment.js';
import {
  BootstrapNeededError,
  DuplicateStagedSkillError,
  InternalHarnessError,
  mapErrorToExitCode,
  SecurityAckError,
  SkillBuildError,
  SkillTestExitCode,
} from '../../src/skill-test/exit-codes.js';
import { GradingNonceError, GradingSkewError } from '../../src/skill-test/grading-adapter.js';
import { HarnessLocationError } from '../../src/skill-test/harness-location.js';
import { HarnessLockBusyError } from '../../src/skill-test/lock.js';
import { PromptInvariantError } from '../../src/skill-test/prompt-invariants.js';

describe('mapErrorToExitCode', () => {
  it('BootstrapNeededError → 3', () => {
    expect(mapErrorToExitCode(new BootstrapNeededError('/p/evals/evals.json'))).toBe(SkillTestExitCode.Bootstrap);
  });
  it('AuthPreflightError → 2', () => {
    expect(mapErrorToExitCode(new AuthPreflightError('x'))).toBe(SkillTestExitCode.Preflight);
  });
  it('HarnessLocationError → 2', () => {
    expect(mapErrorToExitCode(new HarnessLocationError('x'))).toBe(SkillTestExitCode.Preflight);
  });
  it('PromptInvariantError → 2 (user-correctable prompt override)', () => {
    expect(mapErrorToExitCode(new PromptInvariantError('x'))).toBe(SkillTestExitCode.Preflight);
  });
  it('maps SkillBuildError to exit 2', () => {
    expect(mapErrorToExitCode(new SkillBuildError('build blew up'))).toBe(2);
  });
  it('SecurityAckError → 2 (missing ack before a build)', () => {
    const err = new SecurityAckError();
    expect(mapErrorToExitCode(err)).toBe(SkillTestExitCode.Preflight);
    expect(err.exitCode).toBe(2);
    expect(err.message).toContain('--i-understand-this-runs-skill-code');
  });
  it('DuplicateStagedSkillError → 2 (a staged name collides across subject/with/optional)', () => {
    const err = new DuplicateStagedSkillError('helper');
    expect(mapErrorToExitCode(err)).toBe(SkillTestExitCode.Preflight);
    expect(err.exitCode).toBe(2);
  });
  it('GradingSkewError → 1 (parse failure surfaced, never success)', () => {
    expect(mapErrorToExitCode(new GradingSkewError('x'))).toBe(SkillTestExitCode.Internal);
  });
  it('EvalFragmentError → 1 (per-eval fragment shape skew, same class as GradingSkewError)', () => {
    expect(mapErrorToExitCode(new EvalFragmentError('x'))).toBe(SkillTestExitCode.Internal);
  });
  it('InternalHarnessError → 1', () => {
    expect(mapErrorToExitCode(new InternalHarnessError('x'))).toBe(SkillTestExitCode.Internal);
  });
  it('unknown error → 1', () => {
    expect(mapErrorToExitCode(new Error('boom'))).toBe(SkillTestExitCode.Internal);
  });

  /**
   * These four were mapped ONLY by the hand-maintained `instanceof` chain, and each
   * also carried a `readonly exitCode` that nothing read. Dispatch now reads the
   * field, so each row here is a live pin: delete the class's `exitCode` and its row
   * falls through to Internal (1).
   */
  it.each([
    ['HarnessLockBusyError (harness root held by another run, or a stale lockfile)', new HarnessLockBusyError('/t/.lock'), SkillTestExitCode.Preflight],
    ['BuildHookError (the repo\'s own pre-stage build command failed)', new BuildHookError('hook failed', 1), SkillTestExitCode.Preflight],
    ['UnknownEnvTokenError (bad ${token} in a declared env value)', new UnknownEnvTokenError('nope', 'API_URL'), SkillTestExitCode.Preflight],
    ['GradingNonceError (forged/mismatched per-fragment grader nonce)', new GradingNonceError('nonce mismatch'), SkillTestExitCode.Internal],
  ])('%s', (_label, err, expected) => {
    expect(mapErrorToExitCode(err)).toBe(expected);
  });

  /**
   * The read is deliberately narrow: `exitCode` is a common property on FOREIGN
   * errors (child processes, HTTP clients), so an unrestricted read would let an
   * unrelated throw choose the process's exit code — including choosing 0 and turning
   * a crash into a green build.
   */
  it.each([
    ['a shell-style exit code no vat error declares', 127],
    ['success, which no throw may ever claim', 0],
    ['EvalFailure, an outcome of a completed run rather than a throw', SkillTestExitCode.EvalFailure],
  ])('ignores a self-declared exitCode that is %s → 1', (_label, exitCode) => {
    expect(mapErrorToExitCode(Object.assign(new Error('foreign'), { exitCode }))).toBe(
      SkillTestExitCode.Internal,
    );
  });

  it('ignores exitCode on a non-Error throw (a bare object cannot claim a code)', () => {
    expect(mapErrorToExitCode({ exitCode: SkillTestExitCode.Bootstrap })).toBe(SkillTestExitCode.Internal);
  });
  it('exposes Ok = 0', () => {
    expect(SkillTestExitCode.Ok).toBe(0);
  });
});

describe('SkillTestExitCode.EvalFailure', () => {
  it('is a distinct, unused numeric code (4)', () => {
    expect(SkillTestExitCode.EvalFailure).toBe(4);
    const values = Object.values(SkillTestExitCode);
    expect(new Set(values).size).toBe(values.length); // all codes distinct
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
    expect(mapErrorToExitCode(err)).toBe(SkillTestExitCode.Bootstrap);
  });
});
