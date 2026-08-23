/**
 * Running one command N times against one subject — the loop every measurement
 * facet needs before it can compute anything.
 *
 * It lives in the harness rather than in a facet because the two things it gets
 * right are not facet-specific, and a second copy would get one of them wrong:
 *
 * 1. **Cold means cold on EVERY repeat.** Clearing the cache once and then
 *    running five times measures one cold run and four warm ones, and any
 *    statistic over that mixture describes nothing. The clear is therefore
 *    inside the loop, not before it.
 * 2. **A repeat's outcome is reported, never filtered.** {@link runRepeats}
 *    hands back what happened, including failures, and {@link classifyRunFailure}
 *    names a failure without deciding what it costs. What a failure means to a
 *    measurement is the facet's call — the `perf` facet, for one, refuses to let
 *    a failed run contribute a timing and poisons the whole row if any repeat
 *    failed, because timing a crash measures how fast vat fails.
 *
 * The clear itself is deliberately untimed and deliberately best-effort: it is
 * setup, not measurement. A failure to clear shows up as the repeat after it
 * being unexpectedly fast, which the spread will show.
 */

import { completedExitCodesOf, type MeasuredCommandSpec } from './commands.js';
import { runCommand } from './run.js';
import type {
  CacheMode,
  CaptureRequest,
  ResolvedInstrument,
  RunOptions,
  RunResult,
} from './types.js';

/** The token replaced with the subject's path in a command's arguments. */
export const SUBJECT_TOKEN = '{subject}';

/** Arguments used to clear vat's caches between cold repeats. */
const CACHE_CLEAR_ARGS = Object.freeze(['cache', 'clear']);

/** How long a single command may run before it is killed. */
const DEFAULT_TIMEOUT_MS = 600_000;

/** How much of a failing command's stderr travels with the failure. */
const STDERR_EXCERPT_CHARS = 200;

/** One command, repeated against one subject. */
export interface RepeatSpec {
  readonly instrument: ResolvedInstrument;
  /** Working directory for every child — normally the subject's path. */
  readonly cwd: string;
  /** Arguments as they will actually be run: {@link materializeArgs} first. */
  readonly args: readonly string[];
  /** Repeats to perform. Zero spawns nothing at all, including no cache clear. */
  readonly runs: number;
  readonly cache: CacheMode;
  readonly timeoutMs?: number;
  /**
   * Environment for EVERY child, the cache clear included, merged over
   * `process.env` by {@link runCommand}.
   *
   * The clear needs this: a variable that redirects vat's cache or config (a
   * `VAT_*` root, an XDG override) has to reach the clear too, or the run clears
   * a cache the measured command never uses and every "cold" repeat is warm.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Extra environment for the MEASURED run of repeat `index` only, merged over
   * {@link RepeatSpec.env}.
   *
   * Separate from `env` because of what it is for: the `io` facet gives each
   * repeat its own syscall-log directory, and instrumenting the cache clear with
   * the same one would fold setup's I/O into the repeat's measurement. The clear
   * gets the base environment and nothing more, so it stays uninstrumented.
   */
  readonly envFor?: (index: number) => Readonly<Record<string, string>> | undefined;
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
 * Say whether a run failed, and why, without saying what that costs.
 *
 * The order is the content. A process that never ran has no exit code worth
 * reporting, so `spawnError` is tested first; a non-zero exit is a real run and
 * keeps its code. A caller that reversed these would report `exited null` for
 * an ENOENT.
 *
 * "Failed" means **did not complete**, which is not the same as "did not exit
 * zero". The accepted codes come from the command being measured — see
 * `MeasuredCommandSpec.completedExitCodes` in `commands.ts` — because only the command
 * knows that its `1` means "ran everything, found something to report" rather
 * than "gave up". They are a required parameter rather than a defaulted one: a
 * caller that forgot to pass them would get the old behaviour silently, which is
 * the defect this replaces.
 *
 * @param result - One repeat's raw outcome
 * @param completedExitCodes - Codes that denote a run that finished its work
 * @returns The reason it must not be treated as a completed run, or `null`
 */
export function classifyRunFailure(
  result: RunResult,
  completedExitCodes: readonly number[],
): string | null {
  if (result.spawnError !== null) return result.spawnError;
  if (result.exitCode === null || !completedExitCodes.includes(result.exitCode)) {
    return `exited ${String(result.exitCode)}: ${result.stderr.trim().slice(0, STDERR_EXCERPT_CHARS)}`;
  }
  return null;
}

/**
 * Run one command's repeats from what the capture was asked for.
 *
 * Every measurement facet needs exactly this translation, and two hand-written
 * copies of it is not a stylistic problem: under `exactOptionalPropertyTypes`
 * each optional field has to be spread conditionally, so the copies are long
 * enough to drift and mechanical enough that a drift reads as a typo rather
 * than as a difference in meaning. A facet that forgot to forward `timeoutMs`
 * would silently measure under a different limit than the one requested, and
 * its report would look exactly as trustworthy as one that had not.
 *
 * Building the spec and running it are one step rather than two because no
 * caller wants a {@link RepeatSpec} it does not then run — splitting them only
 * creates a state where a facet has described a measurement it never took.
 *
 * `cwd` is the subject's path, always. A facet does not get to choose where the
 * measured command runs — that is the coordinate's axis A made real, and a
 * facet running vat somewhere else would stamp a subject it did not measure.
 *
 * @param request - What the capture was asked to do
 * @param args - This command's arguments, already materialized
 * @param envFor - Per-repeat environment for the MEASURED run only; see
 *   {@link RepeatSpec.envFor} for why this is separate from `env`
 * @returns One raw result per repeat, in the order they ran
 */
export function runRepeatsFor(
  request: CaptureRequest,
  args: readonly string[],
  envFor?: (index: number) => Readonly<Record<string, string>> | undefined,
): RunResult[] {
  return runRepeats({
    instrument: request.instrument,
    cwd: request.subject.path,
    args,
    runs: request.runs,
    cache: request.cache,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.env === undefined ? {} : { env: request.env }),
    ...(envFor === undefined ? {} : { envFor }),
  });
}

/**
 * Say whether a set of repeats can produce a measurement at all, and why not.
 *
 * Two rules, both of which poison the whole set rather than filtering it, and
 * both of which are shared rather than written per facet — the *sentence* is
 * part of the contract, because two facets that phrase this differently make one
 * report look more broken than another describing the identical outcome.
 *
 * **1. Any failure poisons the whole set.** A run of repeats where some
 * completed and some did not is not measuring one behaviour, and reporting a
 * statistic over the survivors quietly answers a different question than the one
 * asked — with `perf` that is actively backwards, because a command that fails
 * to resolve returns in a fraction of a millisecond and would drag a median down
 * into looking like an improvement.
 *
 * **2. The accepted exit codes must be uniform across the set.** Accepting more
 * than one code (a findings command completes at `0` and at `1` alike) makes it
 * possible for every repeat to succeed while the repeats did *different amounts
 * of work*: one run that found nothing and one that rendered a page of findings
 * are two behaviours, and a median over the mixture describes neither. Such a
 * row is failed, and the failure names both codes — the usual cause is the
 * measured command mutating its own subject between repeats, which is worth
 * saying out loud rather than averaging away.
 *
 * @param results - Every repeat's outcome, raw
 * @param completedExitCodes - Codes that denote a run that finished its work
 * @returns The failure to record, or `null` when every repeat completed alike
 */
export function summarizeRepeatFailures(
  results: readonly RunResult[],
  completedExitCodes: readonly number[],
): string | null {
  const reasons = results
    .map((result) => classifyRunFailure(result, completedExitCodes))
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
  /** Which cache mode the repeats ran under. */
  readonly cache: CacheMode;
  /** Every repeat's outcome, raw and unfiltered. */
  readonly results: readonly RunResult[];
  /** Why these repeats yield no usable measurement, or `null`. */
  readonly failure: string | null;
}

/**
 * Materialize one command's arguments, run its repeats, and say whether they are
 * usable — the whole preamble a measurement facet performs before it measures.
 *
 * The three steps are one concept, not three, and the reason they are assembled
 * here rather than at each facet is the third one. Whether a set of repeats is
 * usable is the single property the facets must **not** be allowed to differ on:
 * two hand-written copies of this preamble are free to disagree about which exit
 * codes count as completed, or to pass the accepted codes at one call site and
 * forget them at the other, and the resulting reports stay well-formed while
 * describing different populations. A `perf` row and an `io` row of the same
 * command have to have refused or admitted the same repeats, or holding one
 * beside the other means nothing.
 *
 * The narrower pieces stay exported and separately tested — {@link
 * materializeArgs}, {@link runRepeatsFor}, {@link summarizeRepeatFailures} and
 * {@link classifyRunFailure} each answer a question worth asking alone. This
 * only fixes the order they are asked in.
 *
 * @param request - What the capture was asked to do
 * @param spec - The command to measure
 * @param envFor - Per-repeat environment for the MEASURED run only; see
 *   {@link RepeatSpec.envFor} for why this is separate from `env`
 * @returns The repeats and the verdict on them; see {@link SpecMeasurement}
 */
export function measureSpec(
  request: CaptureRequest,
  spec: MeasuredCommandSpec,
  envFor?: (index: number) => Readonly<Record<string, string>> | undefined,
): SpecMeasurement {
  const args = materializeArgs(spec.args, request.subject.path);
  const results = runRepeatsFor(request, args, envFor);
  return {
    spec,
    args,
    cache: request.cache,
    results,
    failure: summarizeRepeatFailures(results, completedExitCodesOf(spec)),
  };
}

/**
 * Run one command `runs` times, clearing vat's caches before each cold repeat.
 *
 * @param spec - See {@link RepeatSpec}
 * @returns One raw result per repeat, in the order they ran
 */
export function runRepeats(spec: RepeatSpec): RunResult[] {
  const results: RunResult[] = [];
  for (let index = 0; index < spec.runs; index++) {
    // Every repeat, not once before the loop: clearing once would measure one
    // cold run and the rest warm, and report a statistic over the mixture.
    if (spec.cache === 'cold') clearCache(spec);
    results.push(runCommand(spec.instrument, spec.args, runOptions(spec, repeatEnv(spec, index))));
  }
  return results;
}

/**
 * Clear vat's caches so the next repeat starts cold.
 *
 * Untimed and best-effort by design — see this module's header. It runs with the
 * base environment only, never a repeat's own.
 *
 * @param spec - The repeats being run
 */
function clearCache(spec: RepeatSpec): void {
  runCommand(spec.instrument, CACHE_CLEAR_ARGS, runOptions(spec, spec.env));
}

/**
 * The environment for one measured repeat: base, with its own layered over.
 *
 * @param spec - The repeats being run
 * @param index - Which repeat is about to run
 * @returns The merged environment, or `undefined` when there is nothing extra
 */
function repeatEnv(
  spec: RepeatSpec,
  index: number,
): Readonly<Record<string, string>> | undefined {
  const own = spec.envFor?.(index);
  if (spec.env === undefined) return own;
  if (own === undefined) return spec.env;
  return { ...spec.env, ...own };
}

/**
 * Assemble the options for one invocation.
 *
 * @param spec - The repeats being run
 * @param env - Environment for this particular child
 * @returns Options for {@link runCommand}
 */
function runOptions(
  spec: RepeatSpec,
  env: Readonly<Record<string, string>> | undefined,
): RunOptions {
  return {
    cwd: spec.cwd,
    ...(env === undefined ? {} : { env }),
    timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}
