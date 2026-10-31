/**
 * Running one arm's sequence N times — the loop every measurement facet needs
 * before it can compute anything.
 *
 * It lives in the harness rather than in a facet because what it gets right is
 * not facet-specific, and a second copy would get one of these wrong:
 *
 * 1. **Every arm runs in its own directories, from a cleared environment.**
 *    A REQUIRED {@link ArmDescriptor} names `<out>/arms/<build>-<arm>-<state>/`,
 *    whose `store/`, `tmp/` and `home/` are the child's
 *    `VAT_PROJECTION_STORE_DIR`, `TMPDIR`/`TEMP`/`TMP` and
 *    `HOME`/`CLAUDE_CONFIG_DIR` (see `arm-dirs.ts`), and every VAT step starts
 *    from the developer's environment minus every `VAT_*` name and the git and
 *    claude state in `CLEARED_ENV_NAMES` (see `arm-env.ts`). A developer's
 *    leftover `VAT_PROJECTION_STORE=off` would otherwise silently change a
 *    baseline arm's lane. The lab never runs `vat cache clear` and never touches
 *    the developer's default store.
 * 2. **Cold means cold on EVERY repeat**: the arm's store is deleted and its
 *    `tmp/` emptied inside the loop, not once before it. **Warm means one
 *    exit-checked priming run**, then measured repeats with nothing deleted.
 *    Each state's rule is checked, and a violation fails the measurement.
 * 3. **A repeat's outcome is reported, never filtered.** {@link runRepeats}
 *    hands back every repetition, failures included; what a failure costs is
 *    the facet's call — the `perf` facet refuses to let a failed run contribute
 *    a timing, because timing a crash measures how fast vat fails.
 */

import { forEachInOrder, mapInOrder } from '@vibe-agent-toolkit/utils';

import {
  type ArmDescriptor,
  armDirectories,
  armOwnedEnvRefusal,
  armPlacementRefusal,
  armRefusal,
  armStepEnvironment,
  prepareArmDirectories,
} from './arm-dirs.js';
import { type ArmEnvironment, clearedEnvironment, mergeArmEnvironments } from './arm-env.js';
import { completedExitCodesOf, type MeasuredCommandSpec } from './commands.js';
import { type ParseDirectoryResolution, resolveParseCacheDirectory } from './parse-cache.js';
import {
  assertCommittedExits,
  runSequence,
  type SequenceContext,
  type SequenceResult,
  type SequenceStep,
} from './sequence.js';
import type { CacheMode, CaptureRequest, ResolvedInstrument } from './types.js';

/** The token replaced with the subject's path in a command's arguments. */
export const SUBJECT_TOKEN = '{subject}';

/** How long a single step may run before it is killed. */
const DEFAULT_TIMEOUT_MS = 600_000;

/** One arm's sequence, repeated against one subject. */
export interface RepeatSpec {
  readonly instrument: ResolvedInstrument;
  /** Working directory for every step — the subject's root. */
  readonly cwd: string;
  /** The sequence, in order. One step for a single measured command. */
  readonly steps: readonly SequenceStep[];
  /** Measured repeats. Zero spawns nothing and creates nothing, priming included. */
  readonly runs: number;
  /** Which arm, and so which directories and which cache state. Required: an arm with no directories is the developer's. */
  readonly arm: ArmDescriptor;
  readonly timeoutMs?: number;
  /**
   * The caller's own environment (`--env`/`--unset`), layered over the arm's
   * for every VAT step, the priming run included. It may not name a variable
   * the arm's directories own.
   */
  readonly env: ArmEnvironment;
  /**
   * Variables SET for the VAT steps of MEASURED repeat `index` only, layered
   * over {@link RepeatSpec.env} — the `io` facet gives each repeat its own
   * syscall-log directory, and instrumenting the priming run with it would fold
   * setup's I/O into a repeat's measurement.
   */
  readonly envFor?: RepeatEnvFor;
}

/** Per-repeat variables for the measured run; see {@link RepeatSpec.envFor}. */
export type RepeatEnvFor = (index: number) => ArmEnvironment['set'] | undefined;

/** One arm's repeats, and what the arm was run under. */
export interface ArmRun {
  /** Inherited names the arm's VAT steps did not receive — recorded in the run report. */
  readonly removed: readonly string[];
  /** Inherited names the arm's tool steps did not receive (every `VAT_*` and repo-locating git name). */
  readonly removedTool: readonly string[];
  /** The warm arm's priming run, or `null` for a cold arm (or no repeats). */
  readonly priming: SequenceResult | null;
  /** One result per measured repeat, in order; empty when priming failed. */
  readonly results: readonly SequenceResult[];
}

/**
 * Substitute the subject path into a command's arguments.
 *
 * @param args - Argument template
 * @param subjectPath - Absolute path being measured
 * @returns Arguments as they will actually be run
 */
export function materializeArgs(
  args: readonly string[],
  subjectPath: string,
): readonly string[] {
  return args.map((arg) => arg.replaceAll(SUBJECT_TOKEN, subjectPath));
}

/**
 * Say whether a set of repeats can produce a measurement at all, and why not.
 *
 * **1. Any violation poisons the whole set.** A statistic over the survivors
 * quietly answers a different question — with `perf` backwards, because a failed
 * run returns fast and would read as an improvement.
 *
 * **2. The exit codes must be uniform across the set.** A findings command
 * completes at `0` and at `1` alike, and two repeats that did different amounts
 * of work describe two behaviours; a median over the mixture describes neither.
 *
 * @param results - Every repeat's outcome, raw
 * @returns The failure to record, or `null` when every repeat completed alike
 */
export function summarizeRepeatFailures(results: readonly SequenceResult[]): string | null {
  const reasons = results
    .map((result) => result.violation)
    .filter((reason): reason is string => reason !== null);
  if (reasons.length > 0) {
    return `${String(reasons.length)} of ${String(results.length)} repeats failed — ${reasons[0] ?? 'unknown'}`;
  }

  const observed = [...new Set(results.map((result) => result.exitCode))];
  if (observed.length > 1) {
    const codes = observed.map((code) => String(code)).join(' and ');
    return (
      `${String(results.length)} repeats exited ${codes} — every repeat completed, but not ` +
      'with the same amount of work done, so a statistic over them describes neither run'
    );
  }
  return null;
}

/**
 * One command's repeats, run and judged: everything a facet needs before it can
 * start computing whatever makes it that facet.
 */
export interface SpecMeasurement {
  /** The command that was measured, carried so a row can name itself. */
  readonly spec: MeasuredCommandSpec;
  /** Arguments as actually run, with `{subject}` substituted. */
  readonly args: readonly string[];
  /** Which cache state the repeats ran under. */
  readonly cache: CacheMode;
  /** Every measured repeat's outcome, raw and unfiltered. */
  readonly results: readonly SequenceResult[];
  /** Why these repeats yield no usable measurement, or `null`. */
  readonly failure: string | null;
}

/**
 * The one step a single measured command is.
 *
 * @param spec - The command
 * @param args - Its arguments, materialized
 * @returns A timed VAT step accepting the command's completed exits
 */
export function commandStep(spec: MeasuredCommandSpec, args: readonly string[]): SequenceStep {
  return {
    name: spec.name,
    command: { kind: 'vat', args },
    timed: true,
    expectedExits: completedExitCodesOf(spec),
    provenance: spec.provenance,
    populates: spec.populates,
  };
}

/**
 * Materialize one command's arguments, run its repeats in the command's own arm,
 * and say whether they are usable — the whole preamble a measurement facet
 * performs before it measures, assembled once so no two facets can disagree
 * about which repeats they admitted.
 *
 * The arm is `<out>/arms/<build>-<command>-<cache>`: each command of a capture
 * gets its own store, so one command's warm store never primes another's.
 *
 * @param request - What the capture was asked to do
 * @param spec - The command to measure
 * @param envFor - Per-repeat environment for the MEASURED run only
 * @returns The repeats and the verdict on them; see {@link SpecMeasurement}
 */
export async function measureSpec(
  request: CaptureRequest,
  spec: MeasuredCommandSpec,
  envFor?: RepeatEnvFor,
): Promise<SpecMeasurement> {
  const args = materializeArgs(spec.args, request.subject.path);
  const run = await runRepeats({
    instrument: request.instrument,
    cwd: request.subject.path,
    steps: [commandStep(spec, args)],
    runs: request.runs,
    arm: { out: request.arms.out, build: request.arms.build, arm: spec.name, state: request.cache },
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    env: request.env,
    ...(envFor === undefined ? {} : { envFor }),
  });
  return { spec, args, cache: request.cache, results: run.results, failure: armRunFailure(run) };
}

/**
 * Why an arm's run yields no measurement — the one rule every facet that
 * measures an arm applies, in order: a failed priming run (a warm arm that never
 * primed measured nothing, and its empty result list is not "no repeats were
 * requested"); then {@link summarizeRepeatFailures}; then no repeats at all.
 *
 * @param run - The arm's priming run and measured repeats
 * @returns The failure to record, or `null` when the repeats are a measurement
 */
export function armRunFailure(run: Pick<ArmRun, 'priming' | 'results'>): string | null {
  const primingFailure = run.priming?.violation ?? null;
  if (primingFailure !== null) return `priming failed — ${primingFailure}`;
  return summarizeRepeatFailures(run.results) ?? (run.results.length === 0 ? 'no repeats were requested' : null);
}

/**
 * Run one arm's sequence `runs` times.
 *
 * @param spec - See {@link RepeatSpec}
 * @returns The arm's run; see {@link ArmRun}
 */
export async function runRepeats(spec: RepeatSpec): Promise<ArmRun> {
  const [run] = await runInterleaved([spec], spec.runs);
  /* c8 ignore next -- one spec in, one run out; guards noUncheckedIndexedAccess */
  if (run === undefined) throw new Error('runRepeats: no run for the one arm');
  return run;
}

/**
 * Run several arms INTERLEAVED by round — A, B, C, then the next round — never
 * as sequential blocks, so thermal drift or a background process lands on every
 * arm alike. Every warm arm is primed before round 1.
 *
 * @param specs - The arms; each one's `runs` is ignored in favour of `rounds`
 * @param rounds - Measured repetitions per arm
 * @returns One run per arm, in `specs` order
 * @throws {Error} when two arms would share directories, a caller environment
 *   names an arm-owned variable, or a step commits to exit 2
 */
export async function runInterleaved(specs: readonly RepeatSpec[], rounds: number): Promise<ArmRun[]> {
  const arms = specs.map((spec) => prepareArm(spec));
  refuseSharedDirectories(arms.map((arm) => arm.context.dirs.root));
  if (rounds === 0) return arms.map((arm) => ({ removed: arm.removed, removedTool: arm.removedTool, priming: null, results: [] }));

  for (const arm of arms) prepareArmDirectories(arm.context.dirs);
  // One sequence at a time, never concurrently: a measurement shares the machine with nothing of its own.
  const priming = await mapInOrder(arms, (arm) => (arm.context.state === 'warm' ? primed(arm) : null));
  const results = arms.map((): SequenceResult[] => []);
  const roundNumbers = Array.from({ length: rounds }, (_, round) => round);
  await forEachInOrder(roundNumbers, (round) =>
    forEachInOrder(arms, async (arm, index) => {
      if ((priming[index]?.violation ?? null) !== null) return;
      results[index]?.push(await runSequence(arm.context, { kind: 'measured', vatEnv: arm.measuredEnv(round) }));
    }),
  );
  return arms.map((arm, index) => ({
    removed: arm.removed,
    removedTool: arm.removedTool,
    priming: priming[index] ?? null,
    results: results[index] ?? [],
  }));
}

/** One arm, prepared to run. */
interface PreparedArm {
  readonly context: SequenceContext;
  readonly removed: readonly string[];
  readonly removedTool: readonly string[];
  readonly measuredEnv: (round: number) => ArmEnvironment;
}

/**
 * Build an arm's context: its directories, its two environments, and its
 * build-resolved parse directory (asked once, and only when a rule needs it).
 *
 * @param spec - The arm
 * @returns The prepared arm
 */
function prepareArm(spec: RepeatSpec): PreparedArm {
  for (const step of spec.steps) assertCommittedExits(step);
  const owned = armOwnedEnvRefusal(spec.env);
  if (owned !== null) throw armRefusal(`arm '${spec.arm.arm}': ${owned}`);
  const dirs = armDirectories(spec.arm);
  const placement = armPlacementRefusal(dirs.root, [spec.cwd]);
  if (placement !== null) throw armRefusal(`arm '${spec.arm.arm}': ${placement}`);
  const vat = armStepEnvironment(dirs, spec.env);
  const tool = clearedEnvironment(process.env, 'tool', { set: {}, unset: [] }, process.platform);
  let parse: ParseDirectoryResolution | undefined;
  const context: SequenceContext = {
    instrument: spec.instrument,
    cwd: spec.cwd,
    steps: spec.steps,
    dirs,
    state: spec.arm.state,
    vatEnv: vat.env,
    toolEnv: tool.env,
    timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    parseDirectory: () => (parse ??= resolveParseCacheDirectory(spec.instrument, dirs.tmp)),
  };
  return {
    context,
    removed: vat.removed,
    removedTool: tool.removed,
    measuredEnv: (round) => {
      const own = spec.envFor?.(round);
      return own === undefined ? vat.env : mergeArmEnvironments(vat.env, { set: own, unset: [] });
    },
  };
}

/**
 * Run a warm arm's priming sequence, its violation labelled as the priming run's.
 *
 * @param arm - The arm
 * @returns The priming run
 */
async function primed(arm: PreparedArm): Promise<SequenceResult> {
  const run = await runSequence(arm.context, { kind: 'priming' });
  return run.violation === null ? run : { ...run, violation: `priming run: ${run.violation}` };
}

/**
 * @param roots - Every arm's directory
 * @throws {Error} when two arms would share one
 */
function refuseSharedDirectories(roots: readonly string[]): void {
  const shared = roots.find((root, index) => roots.indexOf(root) !== index);
  if (shared !== undefined) {
    throw armRefusal(`two arms would share '${shared}' — each (build, arm, state) runs in its own directories`);
  }
}
