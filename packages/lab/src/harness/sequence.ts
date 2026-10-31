/**
 * One repetition of an arm: a SEQUENCE of steps, run in order, in the arm's own
 * store, `TMPDIR` and home — and judged by the one rule its cache state names.
 *
 * - **A step is any command.** A VAT step runs the build under the arm's
 *   cleared environment; a `tool` step (`pnpm install`, a build) runs under the
 *   developer's minus every `VAT_*` name (see `arm-env.ts`).
 * - **The time is the sum of the TIMED steps.** An untimed step is setup.
 * - **Every step has a committed expected exit**, and exit 2 is never one. A
 *   repetition whose any step exits otherwise is a failed measurement, never a
 *   time: a fast broken run (a child that cannot spawn, a refused store) must not
 *   pass a time bar.
 * - **The steps run as CI's `&&` chain does**: the first non-zero exit ends the
 *   sequence, and that exit is the sequence's own. A step that never ran is a
 *   violation — the committed sequence did not happen.
 * - **One rule per cache state.** Cold: the store is deleted and `tmp/` emptied
 *   before the sequence (asserted), and a populating first step must leave the
 *   store non-empty and at least one shard in the build's parse directory.
 *   Warm: one priming run leaves both non-empty, and every MEASURED step that
 *   reads a population must report `store` (see `provenance.ts`).
 */

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';

import { type ArmDirectories, armRefusal, entriesOf, resetArmHome, resetColdArm } from './arm-dirs.js';
import type { ArmEnvironment } from './arm-env.js';
import { type ParseDirectoryResolution } from './parse-cache.js';
import { type ProvenanceReader, provenanceViolation, readProvenance, type StepProvenance } from './provenance.js';
import { runCommand } from './run.js';
import type { CacheMode, ResolvedInstrument, RunResult } from './types.js';

/** How much of a failing step's stderr travels with the violation — the one excerpt length every lab failure uses. */
const STDERR_EXCERPT_CHARS = 200;

/** What one step runs. */
export type StepCommand =
  /** The arm's build, with these arguments. */
  | { readonly kind: 'vat'; readonly args: readonly string[] }
  /** Any other command, resolved like any spawn (a bare name is looked up on PATH). */
  | { readonly kind: 'tool'; readonly command: string; readonly args: readonly string[] };

/** One step of a sequence. */
export interface SequenceStep {
  /** The step's name in the report and in every violation. */
  readonly name: string;
  readonly command: StepCommand;
  /** Whether the step's wall time counts toward the sequence's time. */
  readonly timed: boolean;
  /** The committed exits — what this step exits when it did its work. Never 2. */
  readonly expectedExits: readonly number[];
  /** Which document reader the step's stdout goes through. */
  readonly provenance: ProvenanceReader;
  /**
   * Whether a cold run of this step, as the FIRST step, must leave the store and
   * a parse shard. True for every verb that populates a projection.
   */
  readonly populates: boolean;
}

/** One step's outcome. */
export interface StepResult extends RunResult {
  readonly name: string;
  readonly timed: boolean;
  /** What the step's document says about its population; `null` for a step with no reader. */
  readonly provenance: StepProvenance | null;
}

/**
 * One repetition's outcome.
 *
 * As a {@link RunResult}: `wallMs` is the sum of the timed steps; `exitCode` the
 * first non-zero step exit (0 when all are 0, `null` when a step produced none);
 * `stdout`/`stderr` the steps' streams joined; `spawnError` the first.
 */
export interface SequenceResult extends RunResult {
  /** Every step that ran, in order. */
  readonly steps: readonly StepResult[];
  /** Why this repetition fails the measurement, or `null`. */
  readonly violation: string | null;
}

/** Everything one repetition needs, prepared once per arm. */
export interface SequenceContext {
  readonly instrument: ResolvedInstrument;
  readonly cwd: string;
  readonly steps: readonly SequenceStep[];
  readonly dirs: ArmDirectories;
  readonly state: CacheMode;
  /** The environment for VAT steps. */
  readonly vatEnv: ArmEnvironment;
  /** The environment for tool steps. */
  readonly toolEnv: ArmEnvironment;
  readonly timeoutMs: number;
  /** The build's parse directory under the arm's `tmp`, resolved lazily and once. */
  readonly parseDirectory: () => ParseDirectoryResolution;
}

/** Which run of an arm this is: the priming run, or a measured one. */
type SequenceRole = { readonly kind: 'priming' } | { readonly kind: 'measured'; readonly vatEnv: ArmEnvironment };

/**
 * Refuse a step whose committed exits include vat's system-error exit.
 *
 * @param step - A step
 * @throws {Error} when the step commits to exit 2
 */
export function assertCommittedExits(step: SequenceStep): void {
  // vat's system-error exit: a run that did not complete, and so never a committed exit.
  if (step.expectedExits.includes(ExitCode.ERROR)) {
    throw armRefusal(`step '${step.name}' commits to exit 2 — a system error is never an expected exit`);
  }
}

/**
 * Run one repetition of an arm's sequence.
 *
 * @param context - The arm, prepared
 * @param role - Priming (unmeasured) or measured, with the measured run's VAT environment
 * @returns The repetition's outcome
 */
export async function runSequence(context: SequenceContext, role: SequenceRole): Promise<SequenceResult> {
  if (context.state === 'cold') {
    const violation = await resetColdArm(context.dirs);
    if (violation !== null) return aggregate([], violation);
  }
  await resetArmHome(context.dirs);
  const steps: StepResult[] = [];
  for (const [index, step] of context.steps.entries()) {
    const ran = runStep(context, role, step);
    steps.push(ran);
    const violation = stepViolation(context, role, step, ran, index);
    if (violation !== null) return aggregate(steps, violation);
    // A committed non-zero exit ends the sequence as CI's `&&` does: completed, with nothing after it run.
    if (ran.exitCode !== 0) return aggregate(steps, null);
  }
  const primed = role.kind === 'priming' ? populationViolation(context, 'warm rule: after priming') : null;
  return aggregate(steps, primed);
}

/**
 * @param context - The arm
 * @param role - Which run
 * @param step - The step to run
 * @returns Its outcome, with its provenance read
 */
function runStep(context: SequenceContext, role: SequenceRole, step: SequenceStep): StepResult {
  const options = { cwd: context.cwd, timeoutMs: context.timeoutMs };
  const raw =
    step.command.kind === 'vat'
      ? runCommand(context.instrument, step.command.args, {
          ...options,
          env: role.kind === 'measured' ? role.vatEnv : context.vatEnv,
        })
      : runCommand({ command: step.command.command, leadingArgs: [] }, step.command.args, {
          ...options,
          env: context.toolEnv,
        });
  return { ...raw, name: step.name, timed: step.timed, provenance: readProvenance(step.provenance, raw.stdout) };
}

/**
 * Judge one step that just ran.
 *
 * @param context - The arm
 * @param role - Which run
 * @param step - The step
 * @param ran - Its outcome
 * @param index - Its position in the sequence
 * @returns The violation, or `null`
 */
function stepViolation(
  context: SequenceContext,
  role: SequenceRole,
  step: SequenceStep,
  ran: StepResult,
  index: number,
): string | null {
  const failure = exitFailure(ran, step.expectedExits);
  if (failure !== null) return `step '${step.name}' ${failure}`;
  if (index === 0 && step.populates && context.state === 'cold') {
    const violation = populationViolation(context, `cold rule: after step '${step.name}'`);
    if (violation !== null) return violation;
  }
  return role.kind === 'measured' ? provenanceViolation(step.name, step.provenance, ran.provenance, context.state) : null;
}

/**
 * Whether a step's exit is one it committed to.
 *
 * @param ran - The step's outcome
 * @param expected - Its committed exits
 * @returns Why not, or `null`
 */
function exitFailure(ran: RunResult, expected: readonly number[]): string | null {
  if (ran.spawnError !== null) return `did not run: ${ran.spawnError}`;
  if (ran.exitCode === null || !expected.includes(ran.exitCode)) {
    return `exited ${String(ran.exitCode)}: ${ran.stderr.trim().slice(0, STDERR_EXCERPT_CHARS)}`;
  }
  return null;
}

/**
 * Whether the arm's store and the build's parse directory were populated.
 *
 * @param context - The arm
 * @param when - What the message says this was checked after
 * @returns The violation, or `null`
 */
function populationViolation(context: SequenceContext, when: string): string | null {
  if (!context.steps.some((step) => step.populates)) return null;
  if (entriesOf(context.dirs.store).length === 0) return `${when} the store '${context.dirs.store}' is empty`;
  const parse = context.parseDirectory();
  if (!parse.ok) return `${when}: ${parse.reason}`;
  if (!holdsAFile(parse.dir)) return `${when} the build's parse directory '${parse.dir}' holds no shard`;
  return null;
}

/**
 * @param dir - A directory
 * @returns True when it holds at least one non-directory entry at any depth; a link is never followed
 */
function holdsAFile(dir: string): boolean {
  return entriesOf(dir).some((entry) =>
    entry.isDirectory() ? holdsAFile(safePath.join(dir, entry.name)) : true,
  );
}

/**
 * Fold the steps into one repetition's outcome.
 *
 * @param steps - Every step that ran
 * @param violation - Why it fails the measurement, or `null`
 * @returns The repetition
 */
function aggregate(steps: readonly StepResult[], violation: string | null): SequenceResult {
  const exits = steps.map((step) => step.exitCode);
  const exitCode = exits.includes(null) || steps.length === 0 ? null : (exits.find((code) => code !== 0) ?? 0);
  return {
    wallMs: steps.filter((step) => step.timed).reduce((sum, step) => sum + step.wallMs, 0),
    exitCode,
    stdout: steps.map((step) => step.stdout).join(''),
    stderr: steps.map((step) => step.stderr).join(''),
    spawnError: steps.find((step) => step.spawnError !== null)?.spawnError ?? null,
    steps,
    violation,
  };
}
