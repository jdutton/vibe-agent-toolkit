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

import { runCommand } from './run.js';
import type { CacheMode, ResolvedInstrument, RunOptions, RunResult } from './types.js';

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
 * @param result - One repeat's raw outcome
 * @returns The reason it must not be treated as a clean run, or `null`
 */
export function classifyRunFailure(result: RunResult): string | null {
  if (result.spawnError !== null) return result.spawnError;
  if (result.exitCode !== 0) {
    return `exited ${String(result.exitCode)}: ${result.stderr.trim().slice(0, STDERR_EXCERPT_CHARS)}`;
  }
  return null;
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
