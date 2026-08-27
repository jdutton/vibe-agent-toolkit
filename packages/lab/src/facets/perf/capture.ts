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
 *    median down and read as an improvement. "Failed" means *did not complete*,
 *    which is not the same as "exited non-zero": a validator exiting 1 because
 *    it has findings did all of its work, and refusing to time that made three
 *    of vat's commands unmeasurable on every real project. The command declares
 *    which of its codes mean completed; see `harness/commands.ts`.
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
import { judgeLoad, readLoad } from '../../harness/load-guard.js';
import { measureSpec, type SpecMeasurement } from '../../harness/repeat.js';
import { buildReportEnvelope } from '../../harness/report.js';
import type { CaptureRequest } from '../../harness/types.js';

import { summarize } from './stats.js';
import {
  PERF_FACET,
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
 * @param measurement - What was asked for, what ran, and whether it is usable
 * @returns The row, marked failed when no usable measurement exists
 */
function rowFor(measurement: SpecMeasurement): PerfCommandStats {
  const { spec, args, cache, results, failure } = measurement;
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
    // The code the repeats actually produced, not a hard-coded 0: a findings
    // command completes at 1 as well, and a reader has to be able to tell those
    // two rows apart. Reading the first repeat is sound precisely because
    // `summarizeRepeatFailures` returned null — that is what guarantees every
    // repeat exited with this same accepted code.
    exitCode: results[0]?.exitCode ?? null,
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

  const commands = options.commands.map((spec) => rowFor(measureSpec(options, spec)));

  const loadAfter = readLoad();
  const load = judgeLoad(loadBefore.loadAvg1, loadAfter.loadAvg1, loadAfter.cpus);

  return buildReportEnvelope(PERF_FACET, options, { commands, load });
}
