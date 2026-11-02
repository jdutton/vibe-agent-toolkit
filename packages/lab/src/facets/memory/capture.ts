/**
 * Capturing a `memory` report: run each command N times with the RSS probe
 * injected, and report the distribution of each repeat's peak.
 *
 * The loop is `captureCommandRows`, shared with `parse` and `crawl`: commands in
 * order, a fresh dump directory per repeat, and the instrument switched on
 * through `envFor` so a `warm` arm's priming run is never measured. What this
 * facet adds is the preload — on `NODE_OPTIONS`, appended and quoted by the same
 * `harness/preload.ts` the `io` counter uses — and the rule for reducing a
 * repeat's dumps to one number (the largest process's peak; see `types.ts`).
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
 * value by `test/memory-probe.test.ts`.
 */
const RSS_LOG_DIR_ENV = 'VAT_LAB_RSS_LOG';

/** The emitted probe, beside this module once both are built. */
const PROBE_FILE = './rss-probe.cjs';

/** Prefix for a repeat's dump directory, so a stray one names its owner. */
const DUMP_DIR_PREFIX = 'vat-lab-memory-';

/** How this facet's dumps are read and refused. */
const RSS_DUMP_KIND: DumpKind<RssDump> = {
  noun: 'RSS dump',
  producer: 'rss probe',
  schema: RssDumpSchema,
  emptyDirectory: (directory) =>
    `no RSS dumps in '${directory}'. No node process in this repeat reached its exit handler with ` +
    'the probe loaded — it was killed, ran out of heap, or the preload never reached it. Reporting ' +
    'a peak here would describe a process that did not finish.',
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
  };
}

/**
 * Fold one command's repeats and their dumps into a row.
 *
 * Whether the repeats are usable at all is `measureSpec`'s decision, shared with
 * every facet. What is left here: every repeat must have left at least one peak,
 * and the repeat's sample is the largest.
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

  const reads = await Promise.all(directories.map((directory) => readDumpFiles(directory, RSS_DUMP_KIND)));
  const samplesKb: number[] = [];
  const processesPerRepeat: number[] = [];
  for (const read of reads) {
    if (!read.ok) return failedRow(measurement, read.refusal);
    samplesKb.push(Math.max(...read.dumps.map((dump) => dump.maxRssKb)));
    processesPerRepeat.push(read.dumps.length);
  }

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
  const { rows: commands, measured } = await captureCommandRows(
    options,
    DUMP_DIR_PREFIX,
    (directory) => ({ [RSS_LOG_DIR_ENV]: directory, NODE_OPTIONS: nodeOptions }),
    rowFromDumps,
  );
  const loadAfter = readLoad();

  return buildReportEnvelope(MEMORY_FACET, options, {
    commands,
    load: judgeLoad(loadBefore.loadAvg1, loadAfter.loadAvg1, loadAfter.cpus),
  }, measured);
}
