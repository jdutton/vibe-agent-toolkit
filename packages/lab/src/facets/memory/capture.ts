/**
 * Capturing a `memory` report: run each command N times with the RSS probe
 * injected, and report the distribution of each repeat's peak.
 *
 * The loop is `captureCommandRows`, shared with `parse` and `crawl`: commands in
 * order, a fresh dump directory per repeat, and the instrument switched on
 * through `envFor` so a `warm` arm's priming run is never measured. What this
 * facet adds is the preload — on `NODE_OPTIONS`, appended and quoted by the same
 * `harness/preload.ts` the `io` counter uses — and the rule for reducing a
 * repeat's dumps to one number (the largest vat process's peak; see `types.ts`).
 * A repeat is launched straight from the lab: the probe's figure excludes what
 * a parent held (see `rss-probe.cts`). An `npx:` build is too: it resolves to its install's entry (`harness/npx-install.ts`).
 *
 * Every repeat counts, as in `perf`: there is no warm-up to discard, because a
 * peak is not a cache-sensitive count, and a `warm` arm is already primed by an
 * unmeasured run before it.
 */

import { resolveFromImportMeta } from '@vibe-agent-toolkit/utils';

import type { ReportEnvelope } from '../../envelope/envelope.js';
import { buildArmEnv } from '../../harness/arm-env.js';
import { captureCommandRows } from '../../harness/dump-capture.js';
import { type DumpKind, readDumpFiles } from '../../harness/dumps.js';
import { judgeLoad, readLoad } from '../../harness/load-guard.js';
import { nodeOptionsWith, resolvePreloadPath } from '../../harness/preload.js';
import type { SpecMeasurement } from '../../harness/repeat.js';
import { buildReportEnvelope } from '../../harness/report.js';
import type { SequenceResult } from '../../harness/sequence.js';
import type { CaptureRequest } from '../../harness/types.js';
import { summarize } from '../perf/stats.js';

import {
  MEMORY_FACET,
  type MemoryBody,
  type MemoryCommandStats,
  type RssDump,
  RssDumpSchema,
} from './types.js';

/**
 * The probe's activation variable. A literal rather than an import, as in `io`:
 * importing from the probe would load it here. Pinned against the probe's own
 * value by `test/integration/memory-probe.integration.test.ts`.
 */
const RSS_LOG_DIR_ENV = 'VAT_LAB_RSS_LOG';

/** The emitted probe, beside this module once both are built. */
const PROBE_FILE = './rss-probe.cjs';

/** Prefix for a repeat's dump directory, so a stray one names its owner. */
const DUMP_DIR_PREFIX = 'vat-lab-memory-';

/**
 * What a process-fatal run out of heap leaves on stderr: V8's abort (`FATAL ERROR: … JavaScript
 * heap out of memory`) and Node's message for a worker thread that reached its heap limit
 * (`Worker terminated due to reaching memory limit: JS heap out of memory` — "JS heap", so the V8
 * spelling never matches it). Stderr is all the lab has of a child, so the signature is read there.
 */
const HEAP_EXHAUSTED: readonly string[] = ['JavaScript heap out of memory', 'reaching memory limit'];

/**
 * Vat's population warning saying a parse failed (`… (3 parse failed [...])`). The lab's own
 * pattern over vat's stderr, for every build: the lab imports nothing of vat's to read it.
 */
const POPULATION_PARSE_FAILED = /\b\d+ parse failed\b/;

/**
 * Did this run run out of heap — whatever it exited with? Read off every stderr line but vat's
 * parse-failed warning, which may quote a message holding a heap signature: a parse vat caught
 * is {@link parseFailed}, never out of heap.
 */
function ranOutOfHeap(result: SequenceResult): boolean {
  return result.stderr.split('\n')
    .some((line) => !POPULATION_PARSE_FAILED.test(line) && HEAP_EXHAUSTED.some((signature) => line.includes(signature)));
}

/**
 * Did vat say a parse failed — for any reason, a worker vat caught at its heap limit included?
 * Documents went unparsed, so the run did less work than the command asks for, whatever it exited
 * with, and its peak is no measurement.
 */
function parseFailed(result: SequenceResult): boolean {
  return POPULATION_PARSE_FAILED.test(result.stderr);
}

/** Every run of `measurement`, a warm arm's unmeasured priming run included. */
function everyRun(measurement: SpecMeasurement): readonly SequenceResult[] {
  return [...measurement.results, ...(measurement.priming === null ? [] : [measurement.priming])];
}

/** How this facet's dumps are read and refused. */
const RSS_DUMP_KIND: DumpKind<RssDump> = {
  noun: 'RSS dump',
  producer: 'rss probe',
  schema: RssDumpSchema,
  emptyDirectory: (directory) =>
    `no RSS dumps in '${directory}'. No vat process in this repeat reached its exit handler with ` +
    'the probe loaded, so it was killed, ran out of heap, the preload never reached it, or no process ' +
    "it ran had a main script inside vat's launcher or CLI package. Reporting a peak here would " +
    'describe a process that did not finish.',
};

/**
 * Everything a capture needs: the shared request, plus where the probe is.
 *
 * `probePath` exists for the reason `CaptureIoOptions.counterPath` does: the
 * default resolves beside this module, which under a test runner is the source
 * tree, where only `rss-probe.cts` exists. It is not a mock seam — whatever is
 * named is loaded by the same `NODE_OPTIONS` string production uses.
 */
export interface CaptureMemoryOptions extends CaptureRequest {
  readonly probePath?: string;
}

/**
 * A row that measured nothing: zeros, `failed` set, and the reason.
 *
 * @param measurement - What was asked for and what ran
 * @param failure - Why there is no measurement
 * @returns The failed row
 */
function failedRow(measurement: SpecMeasurement, failure: string): MemoryCommandStats {
  return {
    name: measurement.spec.name,
    args: measurement.args,
    cache: measurement.cache,
    runs: measurement.results.length,
    medianKb: 0,
    minKb: 0,
    maxKb: 0,
    iqrKb: 0,
    samplesKb: [],
    processesPerRepeat: [],
    exitCode: null,
    failed: true,
    failure,
    // Read once, here, so a comparator dispatches on a field rather than on stderr. A warm arm's
    // priming run too: one out of heap leaves no measured repeat to read it from.
    outOfHeap: everyRun(measurement).some(ranOutOfHeap),
  };
}

/**
 * One repeat's dumps, reduced: the largest vat process's peak and how many vat
 * processes wrote one — or why the repeat is no measurement. Only vat's own
 * processes dump, so a repeat with none was killed, ran out of heap, or was
 * not vat at all (a command whose main script no vat package owns).
 *
 * @param dumps - The repeat's dumps
 * @param index - Its position, for the message
 * @returns The reduction, or the refusal
 */
export function foldRepeat(
  dumps: readonly RssDump[],
  index: number,
): { readonly peakKb: number; readonly processes: number } | string {
  if (dumps.length === 0) {
    return (
      `repeat ${String(index + 1)}: no vat process wrote a peak — it was killed, ran out of heap, or no process ` +
      "it ran had a main script inside vat's launcher or CLI package"
    );
  }
  return { peakKb: Math.max(...dumps.map((dump) => dump.maxRssKb)), processes: dumps.length };
}

/**
 * Every repeat of one command, folded with {@link foldRepeat} — or the first
 * repeat's refusal, or a refusal when the repeats disagree on how many vat
 * processes ran: their largest-process peaks are then not samples of one thing.
 *
 * @param dumpsPerRepeat - Each repeat's dumps, in repeat order
 * @returns The samples and process counts, or the refusal
 */
export function foldRepeats(
  dumpsPerRepeat: readonly (readonly RssDump[])[],
): { readonly samplesKb: number[]; readonly processesPerRepeat: number[] } | string {
  const samplesKb: number[] = [];
  const processesPerRepeat: number[] = [];
  for (const [index, dumps] of dumpsPerRepeat.entries()) {
    const repeat = foldRepeat(dumps, index);
    if (typeof repeat === 'string') return repeat;
    samplesKb.push(repeat.peakKb);
    processesPerRepeat.push(repeat.processes);
  }
  if (new Set(processesPerRepeat).size > 1) {
    return (
      `the repeats disagree on how many vat processes ran (${processesPerRepeat.join('/')}) — a repeat whose ` +
      'process wrote no peak, or a vat that ran differently from one repeat to the next; either way the ' +
      'largest-process peaks are not samples of one thing'
    );
  }
  return { samplesKb, processesPerRepeat };
}

/**
 * Fold one command's repeats and their dumps into a row.
 *
 * Whether the repeats are usable at all is `measureSpec`'s decision, shared with
 * every facet. What is left here is {@link foldRepeats}.
 *
 * @param measurement - What was asked for, what ran, and whether it is usable
 * @param directories - The repeats' dump directories, in repeat order
 * @returns The row, marked failed when no usable measurement exists
 */
async function rowFromDumps(
  measurement: SpecMeasurement,
  directories: readonly string[],
): Promise<MemoryCommandStats> {
  if (directories.length === 0) return failedRow(measurement, 'no repeats were requested');
  if (measurement.failure !== null) return failedRow(measurement, measurement.failure);
  // Asked of EVERY run, a clean exit included: a process that lost a worker to its heap and went on
  // exited 0, and its peak is of a run that did not do the work. Never a measurement.
  if (everyRun(measurement).some(ranOutOfHeap)) {
    return failedRow(measurement, 'a run ran out of heap (a worker thread at its limit, or the process) and exited anyway: its peak is not a measurement of the command');
  }
  if (everyRun(measurement).some(parseFailed)) {
    return failedRow(measurement, "a run's population warning says a parse failed: the run did less work than the command, so its peak is not a measurement");
  }

  const reads = await Promise.all(directories.map((directory) => readDumpFiles(directory, RSS_DUMP_KIND)));
  const dumpsPerRepeat: (readonly RssDump[])[] = [];
  for (const read of reads) {
    if (!read.ok) return failedRow(measurement, read.refusal);
    dumpsPerRepeat.push(read.dumps);
  }
  const folded = foldRepeats(dumpsPerRepeat);
  if (typeof folded === 'string') return failedRow(measurement, folded);
  const { samplesKb, processesPerRepeat } = folded;

  // perf's statistics, in perf's field names: the arithmetic has no unit.
  const { medianMs, minMs, maxMs, iqrMs } = summarize(samplesKb);
  return {
    name: measurement.spec.name,
    args: measurement.args,
    cache: measurement.cache,
    runs: measurement.results.length,
    medianKb: medianMs,
    minKb: minMs,
    maxKb: maxMs,
    iqrKb: iqrMs,
    samplesKb,
    processesPerRepeat,
    // Sound for the reason it is in `perf`: `measureSpec` returned no failure,
    // so every repeat exited with this same accepted code.
    exitCode: measurement.results[0]?.exitCode ?? null,
    failed: false,
    failure: null,
    outOfHeap: false,
  };
}

/**
 * Capture a `memory` report.
 *
 * @param options - See {@link CaptureMemoryOptions}
 * @returns A complete report envelope, ready to store
 * @throws {Error} when the probe cannot be found — see `resolvePreloadPath`
 */
export async function captureMemory(options: CaptureMemoryOptions): Promise<ReportEnvelope<MemoryBody>> {
  const probePath = resolvePreloadPath(
    'captureMemory',
    'RSS probe',
    options.probePath ?? resolveFromImportMeta(import.meta.url, PROBE_FILE),
    'no peak at all',
  );
  // From the environment the child would actually get, so an arm's own
  // NODE_OPTIONS (a raised `--max-old-space-size`, say) survives under the probe.
  const nodeOptions = nodeOptionsWith(probePath, buildArmEnv(process.env, options.env)['NODE_OPTIONS']);

  const loadBefore = readLoad();
  const { rows, measured } = await captureCommandRows(
    options,
    DUMP_DIR_PREFIX,
    (directory) => ({ [RSS_LOG_DIR_ENV]: directory, NODE_OPTIONS: nodeOptions }),
    rowFromDumps,
  );
  const loadAfter = readLoad();

  return buildReportEnvelope(MEMORY_FACET, options, {
    commands: rows,
    load: judgeLoad(loadBefore.loadAvg1, loadAfter.loadAvg1, loadAfter.cpus),
  }, measured);
}
