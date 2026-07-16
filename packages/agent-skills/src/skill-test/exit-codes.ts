import { AuthPreflightError } from '@vibe-agent-toolkit/utils';

import { BuildHookError } from './build-hook.js';
import { UnknownEnvTokenError } from './declared-env.js';
import { EvalFragmentError } from './eval-fragment.js';
import { GradingNonceError, GradingSkewError } from './grading-adapter.js';
import { HarnessLocationError } from './harness-location.js';
import { PromptInvariantError } from './prompt-invariants.js';

/** Exit codes for `vat skill test` (spec §6d). */
export const SkillTestExitCode = {
  Ok: 0,
  Internal: 1,
  Preflight: 2,
  Bootstrap: 3,
  /**
   * At least one eval FAILED. This is the DEFAULT verdict for a completed run
   * whose expectations did not all pass (fail-closed) — suppress it with the
   * interactive opt-out `--allow-eval-failure`. Distinct from the harness-broke
   * codes (1/2/3): the harness ran to completion and produced a valid
   * grading.json — the skill's expectations simply did not all pass. This
   * differentiation lets a CI consumer treat 4 as tolerable while still failing
   * closed on every other non-zero code:
   *   `case $? in 0) ;; 4) tolerate/warn ;; *) hard fail ;; esac`
   * Returned DIRECTLY by the harness verdict (see verdictExitCode in
   * run-harness.ts), not via mapErrorToExitCode, because it is an outcome, not a
   * thrown error.
   */
  EvalFailure: 4,
} as const;

export type SkillTestExitCodeValue = (typeof SkillTestExitCode)[keyof typeof SkillTestExitCode];

/**
 * A required input is absent in a way vat can scaffold (missing evals.json).
 * Exit 3, NOT a failure. `expectedPath` is the persistent location of the
 * annotated starter template.
 *
 * In a real run the harness has already written that template, and the message
 * says so. Under `--dry-run` nothing is written — a dry run must never touch the
 * filesystem — so the message instead describes what a real run *would* scaffold
 * and where, while surfacing the same exit-3 "bootstrap needed" signal.
 */
export class BootstrapNeededError extends Error {
  readonly exitCode = 3 as const;
  constructor(public readonly expectedPath: string, opts?: { dryRun?: boolean }) {
    super(
      opts?.dryRun === true
        ? `[dry-run] No evals.json found. A real run would scaffold an annotated template at ${expectedPath} — fill it in and re-run. (dry-run: nothing was written.)`
        : `Wrote an evals.json template at ${expectedPath} — fill it in and re-run.`,
    );
    this.name = 'BootstrapNeededError';
  }
}

/** Thrown when building a declared skill (pool packageSkill or plugin build) fails. Exit 2 (preflight class). */
export class SkillBuildError extends Error {
  readonly exitCode = 2 as const;
  constructor(message: string) {
    super(message);
    this.name = 'SkillBuildError';
  }
}

/**
 * The §12 security acknowledgment is required but absent, thrown BEFORE any
 * build/pre-stage command (which executes untrusted repo code) runs for a
 * buildable subject. Exit 2 (preflight class). Mirrors the harness Step-6 ack
 * message wording so the two enforcement points read identically.
 */
export class SecurityAckError extends Error {
  readonly exitCode = 2 as const;
  constructor() {
    super('Security acknowledgment required. Pass --i-understand-this-runs-skill-code to proceed.');
    this.name = 'SecurityAckError';
  }
}

/**
 * A skill name is staged more than once in a single run — the subject, a
 * `--with` companion, and a `--with-optional` companion must all have distinct
 * names. Both `--with` and `--with-optional` STAGE the named companion and make
 * it invocable (issue #153: they differ only in required-vs-optional resolution,
 * not in whether they are staged), so a colliding name would silently overwrite
 * an earlier staged copy under the same slot — never an error, never a manifest
 * trace — which makes a routing/deferral eval look correct while testing
 * something else. Exit 2 (preflight class): user-correctable input, like a bad
 * env token or missing security ack.
 */
export class DuplicateStagedSkillError extends Error {
  readonly exitCode = 2 as const;
  constructor(public readonly skillName: string) {
    super(
      `Skill name "${skillName}" is staged more than once (subject / --with / --with-optional). ` +
        `Each staged skill must have a unique name.`,
    );
    this.name = 'DuplicateStagedSkillError';
  }
}

/** Internal harness failure (an executor/grader spawn error, watchdog timeout/stall, or a missing grader fragment). Exit 1. */
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
 * a PromptInvariantError is a defense-in-depth failure over VAT's OWN generated
 * executor/grader prompts (a required safety directive missing from a prompt VAT
 * built) — surfaced as a user-visible preflight-class problem → 2; a BuildHookError
 * is a pre-stage build failure → 2; a SkillBuildError is a declared-skill build
 * failure → 2; a SecurityAckError is a missing security ack before a build → 2;
 * an UnknownEnvTokenError is a bad ${token} in a
 * declared env value → 2; a DuplicateStagedSkillError is a staged-name collision
 * across subject/--with/--with-optional → 2; GradingSkewError (aggregate grading.json shape skew),
 * EvalFragmentError (per-eval grader fragment parse failure), and
 * GradingNonceError (forged/mismatched per-fragment grader nonce) are all → 1;
 * everything unknown → 1.
 *
 * Note: SkillTestExitCode.EvalFailure (4) is NOT produced here — it is an
 * outcome of a completed run (an eval failed, the fail-closed default unless
 * `--allow-eval-failure`), not a thrown error, so the harness returns it
 * directly (see verdictExitCode).
 */
export function mapErrorToExitCode(err: unknown): number {
  if (err instanceof BootstrapNeededError) return SkillTestExitCode.Bootstrap;
  if (
    err instanceof AuthPreflightError ||
    err instanceof BuildHookError ||
    err instanceof HarnessLocationError ||
    err instanceof PromptInvariantError ||
    err instanceof SecurityAckError ||
    err instanceof SkillBuildError ||
    err instanceof UnknownEnvTokenError ||
    err instanceof DuplicateStagedSkillError
  ) {
    return SkillTestExitCode.Preflight;
  }
  if (
    err instanceof EvalFragmentError ||
    err instanceof GradingNonceError ||
    err instanceof GradingSkewError ||
    err instanceof InternalHarnessError
  ) {
    return SkillTestExitCode.Internal;
  }
  return SkillTestExitCode.Internal;
}
