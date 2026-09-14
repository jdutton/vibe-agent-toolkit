import { isVatError, VatError } from '@vibe-agent-toolkit/utils';

/**
 * WHY a `vat skill test run` ended on `ExitCode.ERROR`.
 *
 * This used to be three exit codes — 1 internal, 2 preflight, 3 bootstrap —
 * beside 4 for "an eval failed". Under the one exit-code contract every verb
 * shares (`ExitCode` in `@vibe-agent-toolkit/schema`) a failed eval is
 * `FINDINGS` (1) like every other gate that ran and did not pass, and every way
 * the harness could NOT run is `ERROR` (2). The distinction a CI author still
 * needs — "did the harness break, or is my environment wrong?" — is said on
 * stderr as `Reason: <reason>`, never in a fourth number a wrapper would have
 * to look up per command.
 *
 * - `internal` — the harness broke: a spawn failure, a watchdog stall, a grader
 *   fragment that did not parse, a forged nonce. VAT's fault until proven
 *   otherwise.
 * - `preflight` — the operator can fix it: a bad config, a missing binary, an
 *   absent security ack, a held lock, a companion that would not build.
 * - `bootstrap` — nothing was wrong; the run scaffolded an `evals.json`
 *   template and stopped so the author can fill it in.
 */
export type SkillTestFailureReason = 'internal' | 'preflight' | 'bootstrap';

const FAILURE_REASONS: ReadonlySet<string> = new Set<SkillTestFailureReason>([
  'internal',
  'preflight',
  'bootstrap',
]);

/**
 * The reason an error, thrown out of the harness, gives for the run's `ERROR`.
 *
 * An error DECLARES its reason with a `readonly reason` field — every VAT error
 * class in this feature carries one — and this reads it. Only a VAT error is
 * consulted (the `Symbol.for('vat.error')` brand, which survives the
 * `src`/`dist` boundary that `instanceof` does not): a foreign error carrying
 * `reason` is not opting in to anything, and a foreign error carrying nothing
 * is the harness's own fault, `internal`. That closes the residual the old
 * `exitCode` read left open, where `commander`'s `CommanderError` carried a 2
 * and would have reported "your environment is wrong" for a crash.
 *
 * The read is guarded: a getter or `Proxy` that throws on `reason` is a foreign
 * object misbehaving, and this runs inside the CLI's own `catch`, where a
 * rethrow escapes the handler entirely — no summary, no exit code, a bare
 * stack.
 */
export function skillTestFailureReason(err: unknown): SkillTestFailureReason {
  if (!isVatError(err)) return 'internal';
  let declared: unknown;
  try {
    declared = (err as { reason?: unknown }).reason;
    // eslint-disable-next-line local/no-blind-catch -- a property read throws only from a getter or Proxy trap on a misbehaving object, and "the read itself threw" is exactly "declared nothing": there is no second case to tell apart, and this runs inside the CLI's own catch, where a rethrow escapes the handler entirely (pinned in failure-reason.test.ts).
  } catch {
    return 'internal';
  }
  return typeof declared === 'string' && FAILURE_REASONS.has(declared)
    ? (declared as SkillTestFailureReason)
    : 'internal';
}

/**
 * A required input is absent in a way vat can scaffold (missing evals.json).
 * Reason `bootstrap`, NOT a failure. `expectedPath` is the persistent location
 * of the annotated starter template.
 *
 * In a real run the harness has already written that template, and the message
 * says so. Under `--dry-run` the TEMPLATE is not written, so the message instead
 * describes what a real run *would* scaffold and where, while surfacing the same
 * "bootstrap needed" signal.
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
export class BootstrapNeededError extends VatError {
  readonly reason = 'bootstrap' as const;
  constructor(public readonly expectedPath: string, opts?: { dryRun?: boolean }) {
    super(
      'SKILL_TEST_BOOTSTRAP_NEEDED',
      opts?.dryRun === true
        ? `[dry-run] No evals.json found. A real run would scaffold an annotated template at ${expectedPath} — fill it in and re-run. (dry-run: nothing was written to your source tree.)`
        : `Wrote an evals.json template at ${expectedPath} — fill it in and re-run.`,
    );
  }
}

/** Thrown when building a declared skill (pool packageSkill or plugin build) fails. Reason `preflight`. */
export class SkillBuildError extends VatError {
  readonly reason = 'preflight' as const;
  constructor(message: string) {
    super('SKILL_TEST_BUILD_FAILED', message);
  }
}

/**
 * The §12 security acknowledgment is required but absent, thrown BEFORE any
 * build/pre-stage command (which executes untrusted repo code) runs for a
 * buildable subject. Reason `preflight`. Mirrors the harness Step-6 ack
 * message wording so the two enforcement points read identically.
 */
export class SecurityAckError extends VatError {
  readonly reason = 'preflight' as const;
  constructor() {
    super(
      'SKILL_TEST_SECURITY_ACK_MISSING',
      'Security acknowledgment required. Pass --i-understand-this-runs-skill-code to proceed.',
    );
  }
}

/**
 * A skill name is staged more than once in a single run — the subject, a
 * `--with` companion, and a `--with-optional` companion must all have distinct
 * names. Both `--with` and `--with-optional` STAGE the named companion and make
 * it invocable (they differ only in required-vs-optional resolution, not in
 * whether they are staged), so a colliding name would silently overwrite an
 * earlier staged copy under the same slot — never an error, never a manifest
 * trace — which makes a routing/deferral eval look correct while testing
 * something else. Reason `preflight`: user-correctable input, like a bad env
 * token or missing security ack.
 */
export class DuplicateStagedSkillError extends VatError {
  readonly reason = 'preflight' as const;
  constructor(public readonly skillName: string) {
    super(
      'SKILL_TEST_DUPLICATE_STAGED_SKILL',
      `Skill name "${skillName}" is staged more than once (subject / --with / --with-optional). ` +
        `Each staged skill must have a unique name.`,
    );
  }
}

/** Internal harness failure (an executor/grader spawn error, watchdog timeout/stall, or a missing grader fragment). Reason `internal`. */
export class InternalHarnessError extends VatError {
  readonly reason = 'internal' as const;
  constructor(message: string) {
    super('SKILL_TEST_INTERNAL', message);
  }
}
