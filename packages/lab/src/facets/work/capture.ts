/**
 * Capturing a `work` report: run each command at least {@link WORK_MIN_RUNS}
 * times with vat's work-counter dump switched on, discard repeat 0, and report
 * the last repeat — plus whether the repeats after the warm-up agreed.
 *
 * The seam is compiled into vat and switched on by `VAT_WORK_COUNTERS`, as
 * `crawl`'s is by its own variable; the lab injects nothing. The warm-up and
 * the nullable `stable` follow `io` (see `io/capture.ts`): repeat 0 is the
 * capture's first touch of the subject, and below two compared repeats nothing
 * can disagree.
 *
 * Whether a repeat is usable at all — a non-zero or disagreeing exit, a signal,
 * a failed priming run — is {@link measureSpec}'s decision, shared with every
 * facet. A repeat killed by a signal has no exit code and is a violation there,
 * so it arrives here as the measurement's `failure` and no dump is read.
 */

import { WORK_COUNTERS_ENV, type WorkCounter } from '@vibe-agent-toolkit/utils';

import type { ReportEnvelope } from '../../envelope/envelope.js';
import { captureCommandRows } from '../../harness/dump-capture.js';
import { judgeLoad, readLoad } from '../../harness/load-guard.js';
import type { SpecMeasurement } from '../../harness/repeat.js';
import { buildReportEnvelope } from '../../harness/report.js';
import type { CacheMode, CaptureRequest } from '../../harness/types.js';

import { countOf, type MergedWorkDumps, readWorkDumps, variedCounters, type WorkDumpsRead } from './dump.js';
import {
  comparedExactly,
  WORK_FACET,
  WORK_MIN_RUNS,
  type WorkBody,
  type WorkCommandStats,
} from './types.js';

/** Prefix for a repeat's dump directory, so a stray one names its owner. */
const DUMP_DIR_PREFIX = 'vat-lab-work-';

/** Everything a capture needs: exactly the shared request. */
export type CaptureWorkOptions = CaptureRequest;

/** The row a command produces before any measurement is folded into it. */
type RowBase = Pick<WorkCommandStats, 'name' | 'args' | 'cache'>;

/**
 * A row that measured nothing. Empty counters, never zeros: `failed` and
 * `failure` carry the meaning, and a zero would read as no work.
 *
 * @param base - Name, arguments and cache mode
 * @param runs - How many repeats ran
 * @param failure - Why there is no measurement
 * @returns The failed row
 */
function failedRow(base: RowBase, runs: number, failure: string): WorkCommandStats {
  return {
    ...base,
    runs,
    comparedRuns: 0,
    stable: null,
    loadRefusedRepeats: 0,
    processes: 0,
    counters: [],
    varied: [],
    failed: true,
    failure,
  };
}

/**
 * Every counter that differed between adjacent compared repeats, in tuple order.
 *
 * @param merges - The compared repeats' readings, in repeat order
 * @returns The differing counters
 */
function variedAcross(merges: readonly MergedWorkDumps[]): WorkCounter[] {
  const varied = new Set<WorkCounter>();
  for (const [index, merge] of merges.entries()) {
    const previous = merges[index - 1];
    if (previous === undefined) continue;
    for (const name of variedCounters(previous, merge)) varied.add(name);
  }
  return [...varied];
}

/**
 * @param merged - One repeat's merged dumps
 * @returns Whether that repeat refused a parse under machine load
 */
function refusedUnderLoad(merged: MergedWorkDumps): boolean {
  return (countOf(merged, 'parse.refused.load') ?? 0) > 0;
}

/**
 * Whether a warm-mode warm-up refused a parse under machine load: it filled the
 * cache the compared repeats read, so a document it left unparsed is a miss in
 * the first compared repeat and a hit after, and an exact counter moves by
 * load. Read for that alone; a warm-up whose dumps cannot be read changes
 * nothing, as before. In cold mode no compared repeat reads what it cached, so
 * it is not read at all.
 *
 * @param cache - The capture's cache mode
 * @param directories - Every repeat's dump directory, warm-up first
 * @param read - Reads one repeat's directory
 * @returns 1 when it did, else 0
 */
async function warmUpRefusedUnderLoad(
  cache: CacheMode,
  directories: readonly string[],
  read: (directory: string) => Promise<WorkDumpsRead>,
): Promise<number> {
  const [warmUp] = directories;
  if (cache !== 'warm' || warmUp === undefined) return 0;
  const reading = await read(warmUp);
  return reading.ok && refusedUnderLoad(reading.merged) ? 1 : 0;
}

/**
 * Fold one command's repeats into its row.
 *
 * Takes the repeat reader as an argument so the fold can be exercised without
 * a disk; {@link captureWork} passes {@link readWorkDumps}.
 *
 * @param measurement - What ran, and whether the repeats are usable
 * @param directories - The repeats' dump directories, in repeat order
 * @param read - Reads one repeat's directory
 * @returns The row, marked failed when no usable measurement exists
 */
export async function workRowFromRepeats(
  measurement: SpecMeasurement,
  directories: readonly string[],
  read: (directory: string) => Promise<WorkDumpsRead>,
): Promise<WorkCommandStats> {
  const { results, failure, cache } = measurement;
  const base: RowBase = { name: measurement.spec.name, args: measurement.args, cache };
  if (failure !== null) return failedRow(base, results.length, failure);

  // Repeat 0 is the warm-up: never compared, never reported.
  const warmUpLoadRefusals = await warmUpRefusedUnderLoad(cache, directories, read);
  const reads = await Promise.all(directories.slice(1).map((directory) => read(directory)));
  const merges: MergedWorkDumps[] = [];
  for (const each of reads) {
    if (!each.ok) return failedRow(base, results.length, each.refusal);
    merges.push(each.merged);
  }
  const reported = merges.at(-1);
  if (reported === undefined) return failedRow(base, results.length, 'no compared repeat ran');

  const varied = variedAcross(merges);
  const loadRefusedRepeats =
    merges.filter((merge) => refusedUnderLoad(merge)).length + warmUpLoadRefusals;
  return {
    ...base,
    runs: results.length,
    comparedRuns: merges.length,
    // A reported-only counter moving is not a disagreement about the code, but
    // a load refusal moves exact counters downstream of it: no warrant either way.
    stable:
      merges.length < 2 || loadRefusedRepeats > 0 ? null : varied.every((name) => !comparedExactly(name, cache)),
    loadRefusedRepeats,
    processes: reported.processes,
    counters: reported.counters,
    varied,
    failed: false,
    failure: null,
  };
}

/**
 * Capture a `work` report. Commands run one after another, never concurrently.
 *
 * @param options - See {@link CaptureWorkOptions}
 * @returns A complete report envelope, ready to store
 * @throws {RangeError} when fewer than {@link WORK_MIN_RUNS} repeats are asked
 *   for, before anything runs
 */
export async function captureWork(options: CaptureWorkOptions): Promise<ReportEnvelope<WorkBody>> {
  if (options.runs < WORK_MIN_RUNS) {
    throw new RangeError(
      `the work facet needs at least ${String(WORK_MIN_RUNS)} repeats (got ${String(options.runs)}): ` +
        'repeat 0 is a warm-up, and stability needs two compared repeats after it',
    );
  }
  const loadBefore = readLoad();
  const { rows: commands, measured } = await captureCommandRows(
    options,
    DUMP_DIR_PREFIX,
    (directory) => ({ [WORK_COUNTERS_ENV]: directory }),
    (measurement, directories) => workRowFromRepeats(measurement, directories, readWorkDumps),
  );
  const loadAfter = readLoad();

  return buildReportEnvelope(WORK_FACET, options, {
    commands,
    load: judgeLoad(loadBefore.loadAvg1, loadAfter.loadAvg1, loadAfter.cpus),
  }, measured);
}
