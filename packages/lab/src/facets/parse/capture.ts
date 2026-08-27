/**
 * Capturing a `parse` report: run each command N times with the timing seam
 * switched on, and report the repeat that landed in the middle.
 *
 * ## Why COLD is the default and not a preference
 *
 * vat's parse cache short-circuits the parse function entirely on a hit, so a
 * warm run produces a dump with nine zeroes in it. Those zeroes are perfectly
 * well-formed and read exactly like "parsing is free". Sub-phase attribution
 * exists **only on cache misses**, which is why the CLI defaults this facet to
 * `cold` and why a row that parsed nothing publishes an `attribution` saying so
 * rather than nine zeroes and a shrug.
 *
 * ## Why no repeat is discarded
 *
 * `io` treats repeat 0 as a warm-up because it wants the steady state. This
 * facet must not: in `warm` mode repeat 0 is the *only* repeat that parses
 * anything, so discarding it would throw away the entire measurement and report
 * the empty steady state as the answer.
 *
 * ## Why one repeat is reported whole, rather than an average of all of them
 *
 * Every figure on a row comes from a single repeat — the one whose `total` is
 * the median. Averaging per pass across repeats would produce a breakdown no run
 * ever exhibited: the shares would no longer sum to the total, and the
 * unattributed remainder — the number that says whether the attribution is
 * complete — would become an artifact of the averaging. The spread survives
 * separately as `totalMsSamples`, so nothing is hidden by the choice.
 */

import type { ReportEnvelope } from '../../envelope/envelope.js';
import { captureCommandRows } from '../../harness/dump-capture.js';
import { judgeLoad, readLoad } from '../../harness/load-guard.js';
import type { SpecMeasurement } from '../../harness/repeat.js';
import { buildReportEnvelope } from '../../harness/report.js';
import type { CaptureRequest } from '../../harness/types.js';

import {
  attributionOf,
  type MergedParseDumps,
  PARSE_TIMING_DIR_ENV,
  readParseDumps,
  sameParseWork,
} from './dump.js';
import {
  PARSE_FACET,
  type ParseBody,
  type ParseCommandStats,
} from './types.js';

/** Prefix for a repeat's dump directory, so a stray one names its owner. */
const DUMP_DIR_PREFIX = 'vat-lab-parse-';

/**
 * Everything a capture needs.
 *
 * Exactly the shared request. The seam is compiled into the vat being measured
 * rather than injected by the lab, so — unlike `io`, which has to be told where
 * its counter is — there is nothing of this facet's own to configure.
 */
export type CaptureParseOptions = CaptureRequest;

/**
 * The row a command produces before any measurement is folded into it.
 *
 * A `Pick` of the published row rather than a fresh interface: the identity a
 * failed row keeps and the identity a measured row keeps cannot drift apart if
 * only one of them is written down.
 */
type RowBase = Pick<ParseCommandStats, 'name' | 'args' | 'cache'>;

/**
 * A row that measured nothing, with every measurement zeroed and `failed` set.
 *
 * Zeros rather than absent fields: the schema is strict and a reader must not
 * have to guess. `attribution: 'not-measured'`, `failed` and `failure` are what
 * carry the meaning — an empty measurement must never be readable as a fast one.
 *
 * @param base - Name, arguments and cache mode
 * @param runs - How many repeats actually ran
 * @param failure - Why there is no measurement
 * @returns The failed row
 */
function failedRow(base: RowBase, runs: number, failure: string): ParseCommandStats {
  return {
    ...base,
    runs,
    stable: null,
    attribution: 'not-measured',
    processes: 0,
    mainThreads: 0,
    workerThreads: 0,
    kinds: [],
    tier: [],
    documents: 0,
    bytes: 0,
    cacheHits: 0,
    cacheMisses: 0,
    uncachedParses: 0,
    totalCalls: 0,
    totalMs: 0,
    unattributedMs: 0,
    totalMsSamples: [],
    wallMs: 0,
    cpuUserMs: 0,
    cpuSystemMs: 0,
    failed: true,
    failure,
  };
}

/** Every repeat's merge, plus whether they agreed with each other. */
interface RepeatWindow {
  readonly merges: readonly [MergedParseDumps, ...MergedParseDumps[]];
  readonly allSame: boolean;
}

/**
 * Read every repeat's dumps, and decide whether they did the same work.
 *
 * The window is non-empty by type, which is what lets the reported repeat be
 * chosen without a defensive branch for a case that cannot happen. Agreement is
 * checked against each repeat's PREDECESSOR: equality of the compared fields is
 * transitive, so adjacent equality throughout is equality throughout.
 *
 * @param directories - Dump directories, in repeat order; at least one
 * @returns Every merge and whether they matched, or the first refusal
 */
async function readWindow(
  directories: readonly [string, ...string[]],
): Promise<RepeatWindow | { readonly refusal: string }> {
  const [head, ...tail] = directories;
  const [first, ...rest] = await Promise.all([
    readParseDumps(head),
    ...tail.map((directory) => readParseDumps(directory)),
  ]);

  if (!first.ok) return { refusal: first.refusal };
  const merges: [MergedParseDumps, ...MergedParseDumps[]] = [first.merged];
  let previous = first.merged;
  let allSame = true;
  for (const result of rest) {
    if (!result.ok) return { refusal: result.refusal };
    allSame &&= sameParseWork(previous, result.merged);
    previous = result.merged;
    merges.push(result.merged);
  }
  return { merges, allSame };
}

/**
 * The repeat whose total sits in the middle.
 *
 * The lower of the two middles on an even count, deliberately: interpolating
 * would invent a repeat, and the whole point of picking one is that every number
 * reported describes a run that actually happened.
 *
 * @param merges - Every repeat's merge, in capture order; at least one
 * @returns The representative repeat
 */
function medianRepeat(merges: readonly [MergedParseDumps, ...MergedParseDumps[]]): MergedParseDumps {
  const ordered = [...merges].sort((a, b) => a.totalMs - b.totalMs);
  const middle = ordered[Math.floor((ordered.length - 1) / 2)];
  return middle ?? merges[0];
}

/**
 * Fold what the repeats wrote to disk into a report row.
 *
 * Whether the repeats are usable at all is already decided — {@link measureSpec}
 * owns that, so every measurement facet refuses exactly the same repeats for
 * exactly the same reasons, phrased the same way. What is left here is this
 * facet's own question: where did the time go, and does it add up.
 *
 * @param measurement - What was asked for, what ran, and whether it is usable
 * @param directories - The repeats' dump directories, in repeat order
 * @returns The row, marked failed when no usable measurement exists
 */
async function rowFromDumps(
  measurement: SpecMeasurement,
  directories: readonly string[],
): Promise<ParseCommandStats> {
  const { results, failure } = measurement;
  const base: RowBase = {
    name: measurement.spec.name,
    args: measurement.args,
    cache: measurement.cache,
  };

  const [head, ...tail] = directories;
  if (head === undefined) return failedRow(base, 0, 'no repeats were requested');
  if (failure !== null) return failedRow(base, results.length, failure);

  const read = await readWindow([head, ...tail]);
  if ('refusal' in read) return failedRow(base, results.length, read.refusal);

  const reported = medianRepeat(read.merges);
  return {
    ...base,
    runs: results.length,
    // Below two repeats there is nothing to disagree, so there is nothing to
    // report. `null` is not `false` and emphatically not `true`.
    stable: read.merges.length < 2 ? null : read.allSame,
    attribution: attributionOf(reported),
    processes: reported.processes,
    mainThreads: reported.mainThreads,
    workerThreads: reported.workerThreads,
    tier: reported.tier,
    kinds: reported.kinds.map((kind) => ({
      kind: kind.kind,
      documents: kind.documents,
      bytes: kind.bytes,
      passes: kind.passes,
      totalCalls: kind.total.calls,
      totalMs: kind.total.elapsedMs,
      unattributedMs: kind.unattributedMs,
    })),
    documents: reported.documents,
    bytes: reported.bytes,
    cacheHits: reported.cacheHits,
    cacheMisses: reported.cacheMisses,
    uncachedParses: reported.uncachedParses,
    totalCalls: reported.totalCalls,
    totalMs: reported.totalMs,
    unattributedMs: reported.unattributedMs,
    totalMsSamples: read.merges.map((merge) => merge.totalMs),
    wallMs: reported.wallMs,
    cpuUserMs: reported.cpuUserMs,
    cpuSystemMs: reported.cpuSystemMs,
    failed: false,
    failure: null,
  };
}

/**
 * Capture a `parse` report.
 *
 * Commands are measured one after another, never concurrently: two vat processes
 * racing for the same machine would each measure the other's interference, and
 * these are durations.
 *
 * @param options - See {@link CaptureParseOptions}
 * @returns A complete report envelope, ready to store
 */
export async function captureParse(
  options: CaptureParseOptions,
): Promise<ReportEnvelope<ParseBody>> {
  const loadBefore = readLoad();
  const commands = await captureCommandRows(options, DUMP_DIR_PREFIX, PARSE_TIMING_DIR_ENV, rowFromDumps);
  const loadAfter = readLoad();

  return buildReportEnvelope(PARSE_FACET, options, {
    commands,
    load: judgeLoad(loadBefore.loadAvg1, loadAfter.loadAvg1, loadAfter.cpus),
  });
}
