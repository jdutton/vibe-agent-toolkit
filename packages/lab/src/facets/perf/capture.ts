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
import type { MeasuredCommandSpec } from '../../harness/commands.js';
import { judgeLoad, readLoad } from '../../harness/load-guard.js';
import { materializeArgs, runRepeatsFor, summarizeRepeatFailures } from '../../harness/repeat.js';
import { buildReportEnvelope } from '../../harness/report.js';
import type { CacheMode, CaptureRequest, RunResult } from '../../harness/types.js';

import { summarize } from './stats.js';
import {
  PERF_FACET,
  PERF_FACET_VERSION,
  type PerfBody,
  type PerfCommandStats,
} from './types.js';

/**
 * Everything a capture needs.
 *
 * Exactly the shared request — `perf` adds nothing of its own, because what
 * makes it `perf` is what it records, not what it is pointed at.
 */
export type CapturePerfOptions = CaptureRequest;

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
  spec: MeasuredCommandSpec,
  args: readonly string[],
  cache: CacheMode,
  results: readonly RunResult[],
): PerfCommandStats {
  const failure = summarizeRepeatFailures(results);
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

  if (failure !== null) {
    // Any failure poisons the row — see `summarizeRepeatFailures`, which owns
    // that rule and its wording so both measurement facets state it alike.
    return {
      name: spec.name,
      args,
      cache,
      runs: results.length,
      ...empty,
      samplesMs: [],
      exitCode: null,
      failed: true,
      failure,
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
    const results = runRepeatsFor(options, args);
    return rowFor(spec, args, options.cache, results);
  });

  const loadAfter = readLoad();
  const load = judgeLoad(loadBefore.loadAvg1, loadAfter.loadAvg1, loadAfter.cpus);

  return buildReportEnvelope(PERF_FACET, PERF_FACET_VERSION, options, { commands, load });
}
