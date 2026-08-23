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
 * says so. Under `--dry-run` the TEMPLATE is not written, so the message instead
 * describes what a real run *would* scaffold and where, while surfacing the same
 * exit-3 "bootstrap needed" signal.
 *
 * That scope is exact, and it used to read "a dry run must never touch the
 * filesystem", which is not true of this command. A dry run is not a read-only
 * mode: it takes the harness lock, creates the harness root, stages BOTH arms'
 * per-eval workspaces, and — once `--i-understand-this-runs-skill-code` is passed —
 * runs the repo's `test.build` hook and builds the subject. What it never does is
 * SPAWN: no executor session, no grader session, no tokens.
 *
 * It also never touches `results/`: it neither creates the directory, nor writes
 * `provenance.json`, nor wipes the previous run's artifacts. That last one is the
 * reason the ordering matters — the wipe used to sit AHEAD of the dry-run
 * short-circuit, so a free `--dry-run` (or any failure after it) destroyed the
 * `grading.json` / `baseline.json` / `friction.json` / `tool-eval.json` of the
 * expensive real run an operator was about to read. The summary now names the
 * provenance path it WOULD write rather than writing it.
 *
 * The scaffold is the other filesystem effect a dry run deliberately withholds,
 * and for a different reason: that write lands in the AUTHOR's source
 * tree rather than in vat's own scratch space.
 */
export class BootstrapNeededError extends Error {
  readonly exitCode = 3 as const;
  constructor(public readonly expectedPath: string, opts?: { dryRun?: boolean }) {
    super(
      opts?.dryRun === true
        ? `[dry-run] No evals.json found. A real run would scaffold an annotated template at ${expectedPath} — fill it in and re-run. (dry-run: nothing was written to your source tree.)`
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
 * The codes an error is allowed to declare for itself. `Ok` is not a failure and
 * `EvalFailure` is an outcome rather than a throw (see below), so neither may be
 * claimed by a thrown object — that also keeps a stray `exitCode: 0` from turning a
 * crash into a green build.
 */
const SELF_DECLARED_EXIT_CODES: ReadonlySet<number> = new Set<number>([
  SkillTestExitCode.Internal,
  SkillTestExitCode.Preflight,
  SkillTestExitCode.Bootstrap,
]);

/**
 * The error's own declared exit code, if it has a usable one.
 *
 * Narrow ON PURPOSE. `exitCode` is a common property name on foreign errors (child
 * processes, HTTP clients), so an unrestricted read would let an unrelated throw pick
 * the process's exit code. Requiring an `Error` whose value is one of the three
 * throwable codes above keeps the mechanism to errors that meant to opt in, and
 * leaves everything else on the `instanceof` fallback below.
 */
function selfDeclaredExitCode(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const declared = (err as { exitCode?: unknown }).exitCode;
  return typeof declared === 'number' && SELF_DECLARED_EXIT_CODES.has(declared) ? declared : undefined;
}

/**
 * Map any thrown error to the process exit code.
 *
 * ⚠️ THE `exitCode` FIELD IS THE PRIMARY MECHANISM, and until this rewrite it was
 * not a mechanism at all. Ten error classes across five modules carried a
 * `readonly exitCode`, this docblock called them "authoritative", and NOTHING read
 * one: dispatch was a hand-maintained `instanceof` chain that happened to agree with
 * every field. Deleting any of those fields changed nothing, so each new class added
 * a fifth, then a sixth member to an inert pattern — and the two lists could have
 * disagreed at any time with no test able to tell.
 *
 * So: an error that declares one of the three throwable codes ({@link
 * selfDeclaredExitCode}) decides its own exit code, and the `instanceof` chain now
 * covers only the classes that declare nothing —
 * `PromptInvariantError` (a defense-in-depth failure over VAT's OWN generated
 * executor/grader prompts: a required safety directive missing from a prompt VAT
 * built, surfaced as a user-visible preflight-class problem) → 2, and
 * `GradingSkewError` (aggregate grading.json shape skew), `EvalFragmentError`
 * (per-eval grader fragment parse failure) and `GradingNonceError`
 * (forged/mismatched per-fragment grader nonce) → 1. Everything unknown → 1.
 *
 * A side benefit of reading the field: it works across a `src`/`dist` boundary, where
 * `instanceof` silently cannot — a `dist` copy of a class never matches a `src`
 * instance of it, and this module is imported from both.
 *
 * Note: SkillTestExitCode.EvalFailure (4) is NOT produced here — it is an
 * outcome of a completed run (an eval failed, the fail-closed default unless
 * `--allow-eval-failure`), not a thrown error, so the harness returns it
 * directly (see verdictExitCode).
 */
export function mapErrorToExitCode(err: unknown): number {
  const declared = selfDeclaredExitCode(err);
  if (declared !== undefined) return declared;
  if (err instanceof PromptInvariantError) return SkillTestExitCode.Preflight;
  return SkillTestExitCode.Internal;
}
