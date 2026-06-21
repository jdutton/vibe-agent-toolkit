import { AuthPreflightError } from '@vibe-agent-toolkit/utils';

import { GradingSkewError } from './grading-adapter.js';
import { HarnessLocationError } from './harness-location.js';

/** Exit codes for `vat skill test` (spec §6d). */
export const SkillTestExitCode = {
  Ok: 0,
  Internal: 1,
  Preflight: 2,
  Bootstrap: 3,
} as const;

export type SkillTestExitCodeValue = (typeof SkillTestExitCode)[keyof typeof SkillTestExitCode];

/**
 * A required input is absent in a way vat can scaffold (missing evals.json).
 * Exit 3, NOT a failure. `expectedPath` is the real, persistent location where
 * the harness wrote the annotated starter template for the user to fill in.
 */
export class BootstrapNeededError extends Error {
  readonly exitCode = 3 as const;
  constructor(public readonly expectedPath: string) {
    super(`Wrote an evals.json template at ${expectedPath} — fill it in and re-run.`);
    this.name = 'BootstrapNeededError';
  }
}

/** Internal harness failure (incl. experimenter exiting without valid grading.json). Exit 1. */
export class InternalHarnessError extends Error {
  readonly exitCode = 1 as const;
  constructor(message: string) {
    super(message);
    this.name = 'InternalHarnessError';
  }
}

/**
 * Map any thrown error to the process exit code. Errors that carry their own
 * `exitCode` (Bootstrap/Auth/HarnessLocation/Internal) are authoritative;
 * GradingSkewError is a parse failure → 1; everything unknown → 1.
 */
export function mapErrorToExitCode(err: unknown): number {
  if (err instanceof BootstrapNeededError) return SkillTestExitCode.Bootstrap;
  if (err instanceof AuthPreflightError || err instanceof HarnessLocationError) return SkillTestExitCode.Preflight;
  if (err instanceof GradingSkewError || err instanceof InternalHarnessError) return SkillTestExitCode.Internal;
  return SkillTestExitCode.Internal;
}
