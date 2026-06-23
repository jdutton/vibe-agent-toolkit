import { AuthPreflightError } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  BootstrapNeededError,
  InternalHarnessError,
  mapErrorToExitCode,
  SkillBuildError,
  SkillTestExitCode,
} from '../../src/skill-test/exit-codes.js';
import { PromptInvariantError } from '../../src/skill-test/experimenter-prompt.js';
import { GradingSkewError } from '../../src/skill-test/grading-adapter.js';
import { HarnessLocationError } from '../../src/skill-test/harness-location.js';

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
  it('GradingSkewError → 1 (parse failure surfaced, never success)', () => {
    expect(mapErrorToExitCode(new GradingSkewError('x'))).toBe(SkillTestExitCode.Internal);
  });
  it('InternalHarnessError → 1', () => {
    expect(mapErrorToExitCode(new InternalHarnessError('x'))).toBe(SkillTestExitCode.Internal);
  });
  it('unknown error → 1', () => {
    expect(mapErrorToExitCode(new Error('boom'))).toBe(SkillTestExitCode.Internal);
  });
  it('exposes Ok = 0', () => {
    expect(SkillTestExitCode.Ok).toBe(0);
  });
});
