/**
 * Capturing a `crawl` report: run each command N times with the crawl-timing
 * seam switched on, and report the repeat that landed in the middle.
 *
 * ## Why `warm` is the default here and `cold` is `parse`'s
 *
 * `parse` must run cold because vat's parse cache short-circuits the parse
 * function entirely on a hit, so a warm run has nothing to attribute. There is no
 * such cache in front of a crawl: a link walk and a closure traversal do their
 * work every time. What a cold run adds is the cost of re-reading the corpus,
 * which lands in the parse path and shows up here only as waiting inside the
 * wall-timed brackets. So warm is the steady state, and it is what the comparison
 * this facet exists for — one crawler against the other — should be taken over.
 *
 * ## Why no repeat is discarded
 *
 * `io` treats repeat 0 as a warm-up. This facet does not need to: with `--cache
 * warm` every repeat crawls the same graph, and if repeat 0 genuinely differs
 * that is a finding the `stable` flag should report rather than something to
 * quietly drop.
 *
 * ## Why one repeat is reported whole
 *
 * Every figure on a row comes from a single repeat — the one whose `totalMs` is
 * the median. Averaging per row across repeats would produce a breakdown no run
 * ever exhibited, and the strata would stop summing to the total. The spread
 * survives separately as `totalMsSamples`, which is also what `ab` reduces (by
 * minimum, not by median — see the CLI wiring).
 */

import type { ReportEnvelope } from '../../envelope/envelope.js';
import { captureCommandRows } from '../../harness/dump-capture.js';
import { judgeLoad, readLoad } from '../../harness/load-guard.js';
import type { SpecMeasurement } from '../../harness/repeat.js';
import { buildReportEnvelope } from '../../harness/report.js';
import type { CaptureRequest } from '../../harness/types.js';

import {
  CRAWL_TIMING_DIR_ENV,
  crawlAttributionOf,
  type MergedCrawlDumps,
  readCrawlDumps,
  sameCrawlWork,
} from './dump.js';
import {
  CRAWL_FACET,
  type CrawlBody,
  type CrawlCommandStats,
} from './types.js';

/** Prefix for a repeat's dump directory, so a stray one names its owner. */
const DUMP_DIR_PREFIX = 'vat-lab-crawl-';

/**
 * Everything a capture needs.
 *
 * Exactly the shared request. The seam is compiled into the vat being measured
 * rather than injected by the lab, so — unlike `io`, which has to be told where
 * its counter is — there is nothing of this facet's own to configure.
 */
export type CaptureCrawlOptions = CaptureRequest;

/**
 * The row a command produces before any measurement is folded into it.
 *
 * A `Pick` of the published row rather than a fresh interface, so the identity a
 * failed row keeps and the identity a measured row keeps cannot drift apart.
 */
type RowBase = Pick<CrawlCommandStats, 'name' | 'args' | 'cache'>;

/**
 * A row that measured nothing, with every measurement zeroed and `failed` set.
 *
 * Zeros rather than absent fields: the schema is strict and a reader must not
 * have to guess. `attribution: 'not-measured'`, `failed` and `failure` carry the
 * meaning — an empty measurement must never be readable as a fast one.
 *
 * @param base - Name, arguments and cache mode
 * @param runs - How many repeats actually ran
 * @param failure - Why there is no measurement
 * @returns The failed row
 */
function failedRow(base: RowBase, runs: number, failure: string): CrawlCommandStats {
  return {
    ...base,
    runs,
    stable: null,
    attribution: 'not-measured',
    // Empty, not the running build's constants: a row that never produced a
    // dump has no evidence of what the MEASURED build could charge, and filling
    // it in from the lab's own imports would state the reader's capabilities as
    // if they were the instrument's. The comparison refuses such a row on
    // `failed` before it ever reads this.
    charges: { strata: [], syntheticIds: [] },
    entries: [],
    strata: [],
    totalCalls: 0,
    totalMs: 0,
    totalMsSamples: [],
    processes: [],
    failed: true,
    failure,
  };
}

/**
 * Fold one repeat's merge into the published row.
 *
 * @param base - Name, arguments and cache mode
 * @param runs - How many repeats ran
 * @param reported - The representative repeat
 * @param samples - Every repeat's total, in capture order
 * @param stable - Whether the repeats agreed, or `null` below two repeats
 * @returns The measured row
 */
function measuredRow(
  base: RowBase,
  runs: number,
  reported: MergedCrawlDumps,
  samples: readonly number[],
  stable: boolean | null,
): CrawlCommandStats {
  return {
    ...base,
    runs,
    stable,
    attribution: crawlAttributionOf(reported),
    charges: reported.charges,
    entries: reported.entries,
    strata: reported.strata,
    totalCalls: reported.totalCalls,
    totalMs: reported.totalMs,
    totalMsSamples: samples,
    processes: reported.processes,
    failed: false,
    failure: null,
  };
}

/**
 * Read every repeat's dumps, in repeat order.
 *
 * @param directories - Dump directories, in repeat order
 * @returns Every merge, or the first refusal
 */
async function readEveryRepeat(
  directories: readonly string[],
): Promise<readonly MergedCrawlDumps[] | { readonly refusal: string }> {
  const results = await Promise.all(
    directories.map((directory) => readCrawlDumps(directory)),
  );
  const merges: MergedCrawlDumps[] = [];
  for (const result of results) {
    if (!result.ok) return { refusal: result.refusal };
    merges.push(result.merged);
  }
  return merges;
}

/**
 * Did every repeat crawl the same work?
 *
 * Checked against each repeat's PREDECESSOR: equality of the compared fields is
 * transitive, so adjacent equality throughout is equality throughout.
 *
 * @param merges - Every repeat's merge, in capture order
 * @returns True when all agreed, or `null` when fewer than two repeats ran
 */
function agreementOf(merges: readonly MergedCrawlDumps[]): boolean | null {
  if (merges.length < 2) return null;
  return merges.every(
    (merge, index) => index === 0 || sameCrawlWork(merges[index - 1] as MergedCrawlDumps, merge),
  );
}

/**
 * The repeat whose total sits in the middle.
 *
 * The lower of the two middles on an even count, deliberately: interpolating
 * would invent a repeat, and the point of picking one is that every number
 * reported describes a run that actually happened.
 *
 * @param merges - Every repeat's merge, in capture order
 * @returns The representative repeat, or `undefined` when there were none
 */
function medianRepeat(merges: readonly MergedCrawlDumps[]): MergedCrawlDumps | undefined {
  const ordered = [...merges].sort((a, b) => a.totalMs - b.totalMs);
  return ordered[Math.floor((ordered.length - 1) / 2)];
}

/**
 * Fold what the repeats wrote to disk into a report row.
 *
 * Whether the repeats are usable at all is already decided — {@link measureSpec}
 * owns that, so every measurement facet refuses exactly the same repeats for
 * exactly the same reasons, phrased the same way. What is left here is this
 * facet's own question: which layer spent the time, and did the repeats agree.
 *
 * @param measurement - What was asked for, what ran, and whether it is usable
 * @param directories - The repeats' dump directories, in repeat order
 * @returns The row, marked failed when no usable measurement exists
 */
async function rowFromDumps(
  measurement: SpecMeasurement,
  directories: readonly string[],
): Promise<CrawlCommandStats> {
  const { results, failure } = measurement;
  const base: RowBase = {
    name: measurement.spec.name,
    args: measurement.args,
    cache: measurement.cache,
  };

  if (directories.length === 0) return failedRow(base, 0, 'no repeats were requested');
  if (failure !== null) return failedRow(base, results.length, failure);

  const merges = await readEveryRepeat(directories);
  if ('refusal' in merges) return failedRow(base, results.length, merges.refusal);

  const reported = medianRepeat(merges);
  if (reported === undefined) return failedRow(base, results.length, 'no repeats produced dumps');

  return measuredRow(
    base,
    results.length,
    reported,
    merges.map((merge) => merge.totalMs),
    agreementOf(merges),
  );
}

/**
 * Capture a `crawl` report.
 *
 * Commands are measured one after another, never concurrently: two vat processes
 * racing for the same machine would each measure the other's interference, and
 * these are durations.
 *
 * @param options - See {@link CaptureCrawlOptions}
 * @returns A complete report envelope, ready to store
 */
export async function captureCrawl(
  options: CaptureCrawlOptions,
): Promise<ReportEnvelope<CrawlBody>> {
  const loadBefore = readLoad();
  const commands = await captureCommandRows(options, DUMP_DIR_PREFIX, CRAWL_TIMING_DIR_ENV, rowFromDumps);
  const loadAfter = readLoad();

  return buildReportEnvelope(CRAWL_FACET, options, {
    commands,
    load: judgeLoad(loadBefore.loadAvg1, loadAfter.loadAvg1, loadAfter.cpus),
  });
}
