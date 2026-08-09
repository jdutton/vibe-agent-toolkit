/**
 * Capturing a `perf` report: run each command N times, and report the
 * distribution rather than a sample.
 *
 * Three things here are not incidental, and removing any of them turns the
 * numbers into decoration:
 *
 * 1. **A failed run contributes no timing.** Timing a crash measures how fast
 *    vat fails. Worse, the failures are *fast* — a command that cannot resolve
 *    returns in a fraction of a millisecond — so admitting them would drag a
 *    median down and read as an improvement.
 * 2. **Cold means cold on every repeat.** Clearing the cache once and then
 *    running five times measures one cold run and four warm ones, and reports
 *    the median of a mixture that describes nothing.
 * 3. **Load is read around the whole capture**, and travels in the report. A
 *    number taken on a busy machine is not wrong so much as unattributable, and
 *    the reader has to be able to see that.
 */

import type { ReportEnvelope } from '../../envelope/envelope.js';
import { REPORT_FORMAT_VERSION } from '../../envelope/envelope.js';
import { judgeLoad, readLoad } from '../../harness/load-guard.js';
import { runCommand } from '../../harness/run.js';
import type { ResolvedInstrument, ResolvedSubject } from '../../harness/types.js';

import { summarize } from './stats.js';
import {
  type CacheMode,
  PERF_FACET,
  PERF_FACET_VERSION,
  type PerfBody,
  type PerfCommandSpec,
  type PerfCommandStats,
} from './types.js';

/** The token replaced with the subject's path in a command's arguments. */
const SUBJECT_TOKEN = '{subject}';

/** Arguments used to clear vat's caches between cold repeats. */
const CACHE_CLEAR_ARGS = Object.freeze(['cache', 'clear']);

/** How long a single command may run before it is killed. */
const DEFAULT_TIMEOUT_MS = 600_000;

/** Everything a capture needs. */
export interface CapturePerfOptions {
  readonly instrument: ResolvedInstrument;
  readonly subject: ResolvedSubject;
  readonly commands: readonly PerfCommandSpec[];
  /** Repeats per command. One repeat yields an IQR of 0 and a weak measurement. */
  readonly runs: number;
  readonly cache: CacheMode;
  readonly timeoutMs?: number;
  /** Extra environment for every child, merged over `process.env`. */
  readonly env?: Readonly<Record<string, string>>;
  /** Wall-clock stamp for the report, supplied so the caller owns the clock. */
  readonly capturedAt: string;
}

/** One repeat's outcome, before it is allowed near a statistic. */
interface Sample {
  readonly wallMs: number;
  readonly exitCode: number | null;
  readonly failure: string | null;
}

/**
 * Substitute the subject path into a command's arguments.
 *
 * @param args - Argument template
 * @param subjectPath - Absolute path being measured
 * @returns Arguments as they will actually be run
 */
function materializeArgs(args: readonly string[], subjectPath: string): readonly string[] {
  return args.map((arg) => arg.replaceAll(SUBJECT_TOKEN, subjectPath));
}

/**
 * Run one repeat, classifying it before its duration is trusted.
 *
 * @param options - The capture's options
 * @param args - Fully materialized arguments
 * @returns The sample, with a failure reason when it must not be timed
 */
function runOnce(options: CapturePerfOptions, args: readonly string[]): Sample {
  const result = runCommand(options.instrument, args, {
    cwd: options.subject.path,
    ...(options.env === undefined ? {} : { env: options.env }),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (result.spawnError !== null) {
    return { wallMs: result.wallMs, exitCode: null, failure: result.spawnError };
  }
  if (result.exitCode !== 0) {
    return {
      wallMs: result.wallMs,
      exitCode: result.exitCode,
      failure: `exited ${String(result.exitCode)}: ${result.stderr.trim().slice(0, 200)}`,
    };
  }
  return { wallMs: result.wallMs, exitCode: 0, failure: null };
}

/**
 * Clear vat's caches so the next repeat starts cold.
 *
 * Deliberately untimed and deliberately best-effort: this is setup, not
 * measurement. A failure to clear is reported by the repeat that follows it
 * being unexpectedly fast, which the spread will show.
 *
 * @param options - The capture's options
 */
function clearCache(options: CapturePerfOptions): void {
  runCommand(options.instrument, CACHE_CLEAR_ARGS, {
    cwd: options.subject.path,
    ...(options.env === undefined ? {} : { env: options.env }),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}

/**
 * Turn a command's repeats into a report row.
 *
 * @param spec - What was asked for
 * @param args - What was actually run
 * @param cache - Which cache mode the repeats used
 * @param samples - Every repeat's outcome
 * @returns The row, marked failed when no usable measurement exists
 */
function rowFor(
  spec: PerfCommandSpec,
  args: readonly string[],
  cache: CacheMode,
  samples: readonly Sample[],
): PerfCommandStats {
  const failed = samples.filter((sample) => sample.failure !== null);
  const empty = { medianMs: 0, minMs: 0, maxMs: 0, iqrMs: 0 };

  if (samples.length === 0) {
    return {
      name: spec.name,
      args,
      cache,
      runs: 0,
      ...empty,
      samplesMs: [],
      exitCode: null,
      failed: true,
      failure: 'no repeats were requested',
    };
  }

  if (failed.length > 0) {
    // Any failure poisons the row. A set of repeats where some worked and some
    // did not is not timing one behaviour, and reporting the median of the
    // survivors would quietly answer a different question than the one asked.
    return {
      name: spec.name,
      args,
      cache,
      runs: samples.length,
      ...empty,
      samplesMs: [],
      exitCode: null,
      failed: true,
      failure: `${String(failed.length)} of ${String(samples.length)} repeats failed — ${failed[0]?.failure ?? 'unknown'}`,
    };
  }

  const samplesMs = samples.map((sample) => sample.wallMs);
  return {
    name: spec.name,
    args,
    cache,
    runs: samples.length,
    ...summarize(samplesMs),
    samplesMs,
    exitCode: 0,
    failed: false,
    failure: null,
  };
}

/**
 * Capture a `perf` report.
 *
 * @param options - See {@link CapturePerfOptions}
 * @returns A complete report envelope, ready to store
 */
export function capturePerf(options: CapturePerfOptions): ReportEnvelope<PerfBody> {
  const loadBefore = readLoad();

  const commands = options.commands.map((spec) => {
    const args = materializeArgs(spec.args, options.subject.path);
    const samples: Sample[] = [];
    for (let repeat = 0; repeat < options.runs; repeat++) {
      // Every repeat, not once before the loop: clearing once would measure one
      // cold run and the rest warm, and report the median of the mixture.
      if (options.cache === 'cold') clearCache(options);
      samples.push(runOnce(options, args));
    }
    return rowFor(spec, args, options.cache, samples);
  });

  const loadAfter = readLoad();
  const load = judgeLoad(loadBefore.loadAvg1, loadAfter.loadAvg1, loadAfter.cpus);

  return {
    formatVersion: REPORT_FORMAT_VERSION,
    facet: PERF_FACET,
    facetVersion: PERF_FACET_VERSION,
    coordinate: {
      subject: options.subject.ref,
      subjectVersion: options.subject.version,
      instrument: options.instrument.version,
    },
    capturedAt: options.capturedAt,
    body: { commands, load },
  };
}
