/**
 * Capturing a `perf` report: run each command N times, and report the
 * distribution rather than a sample.
 *
 * Three things are not incidental, and removing any of them turns the numbers
 * into decoration:
 *
 * 1. **A failed run contributes no timing.** Timing a crash measures how fast
 *    vat fails. Worse, the failures are *fast* — a command that cannot resolve
 *    returns in a fraction of a millisecond — so admitting them would drag a
 *    median down and read as an improvement.
 * 2. **Cold means cold on every repeat.** Clearing the cache once and then
 *    running five times measures one cold run and four warm ones, and reports
 *    the median of a mixture that describes nothing. That loop belongs to the
 *    harness now — see `harness/repeat.ts`, which every measurement facet
 *    shares so the property cannot hold in one facet and not another.
 * 3. **Load is read around the whole capture**, and travels in the report. A
 *    number taken on a busy machine is not wrong so much as unattributable, and
 *    the reader has to be able to see that.
 *
 * What stays here is everything about wall-clock statistics: which repeats are
 * allowed near a median, and what a row says when none are.
 */

import type { ReportEnvelope } from '../../envelope/envelope.js';
import { REPORT_FORMAT_VERSION } from '../../envelope/envelope.js';
import { judgeLoad, readLoad } from '../../harness/load-guard.js';
import { classifyRunFailure, materializeArgs, runRepeats } from '../../harness/repeat.js';
import type {
  CacheMode,
  ResolvedInstrument,
  ResolvedSubject,
  RunResult,
} from '../../harness/types.js';

import { summarize } from './stats.js';
import {
  PERF_FACET,
  PERF_FACET_VERSION,
  type PerfBody,
  type PerfCommandSpec,
  type PerfCommandStats,
} from './types.js';

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

/**
 * Turn a command's repeats into a report row.
 *
 * @param spec - What was asked for
 * @param args - What was actually run
 * @param cache - Which cache mode the repeats used
 * @param results - Every repeat's outcome, raw
 * @returns The row, marked failed when no usable measurement exists
 */
function rowFor(
  spec: PerfCommandSpec,
  args: readonly string[],
  cache: CacheMode,
  results: readonly RunResult[],
): PerfCommandStats {
  const failures = results
    .map((result) => classifyRunFailure(result))
    .filter((failure): failure is string => failure !== null);
  const empty = { medianMs: 0, minMs: 0, maxMs: 0, iqrMs: 0 };

  if (results.length === 0) {
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

  if (failures.length > 0) {
    // Any failure poisons the row. A set of repeats where some worked and some
    // did not is not timing one behaviour, and reporting the median of the
    // survivors would quietly answer a different question than the one asked.
    return {
      name: spec.name,
      args,
      cache,
      runs: results.length,
      ...empty,
      samplesMs: [],
      exitCode: null,
      failed: true,
      failure: `${String(failures.length)} of ${String(results.length)} repeats failed — ${failures[0] ?? 'unknown'}`,
    };
  }

  const samplesMs = results.map((result) => result.wallMs);
  return {
    name: spec.name,
    args,
    cache,
    runs: results.length,
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
    const results = runRepeats({
      instrument: options.instrument,
      cwd: options.subject.path,
      args,
      runs: options.runs,
      cache: options.cache,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    return rowFor(spec, args, options.cache, results);
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
