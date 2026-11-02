/**
 * Capturing a `memory` report: run each command N times with the RSS probe
 * injected, and report the distribution of each repeat's peak.
 *
 * The loop is `captureCommandRows`, shared with `parse` and `crawl`: commands in
 * order, a fresh dump directory per repeat, and the instrument switched on
 * through `envFor` so a `warm` arm's priming run is never measured. What this
 * facet adds is the preload — on `NODE_OPTIONS`, appended and quoted by the same
 * `harness/preload.ts` the `io` counter uses — the spawner every measured repeat
 * is launched through (`rss-spawner.ts`: on Linux a child's peak includes what
 * its parent held at `fork()`, so the parent must be a bare node, not the lab),
 * and the rule for reducing a repeat's dumps to one number (the largest vat
 * process's peak; see `types.ts`).
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
 * value by `test/integration/memory-probe.integration.test.ts`.
 */
const RSS_LOG_DIR_ENV = 'VAT_LAB_RSS_LOG';

/** The emitted probe, beside this module once both are built. */
const PROBE_FILE = './rss-probe.cjs';

/** The emitted spawner, beside the probe. */
const SPAWNER_FILE = './rss-spawner.js';

/** Prefix for a repeat's dump directory, so a stray one names its owner. */
const DUMP_DIR_PREFIX = 'vat-lab-memory-';

/** How this facet's dumps are read and refused. */
const RSS_DUMP_KIND: DumpKind<RssDump> = {
  noun: 'RSS dump',
  producer: 'rss probe',
  schema: RssDumpSchema,
  emptyDirectory: (directory) =>
    `no RSS dumps in '${directory}'. No node process in this repeat reached its exit handler with ` +
    'the probe loaded — not even the spawner — so it was killed, ran out of heap, or the preload never ' +
    'reached it. Reporting a peak here would describe a process that did not finish.',
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
  /** Where the spawner is, for the same reason as {@link probePath}. */
  readonly spawnerPath?: string;
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
    spawnerKb: [],
    exitCode: null,
    failed: true,
    failure,
  };
}

/**
 * One repeat's dumps, reduced: the largest vat process's peak, how many vat
 * processes wrote one, and the spawner's own peak — or why the repeat is no
 * measurement.
 *
 * Every repeat must carry exactly one spawner dump (the spawner always exits
 * through the probe; a missing one is a repeat that did not end normally) and
 * at least one vat dump. A vat that wrote none was killed, ran out of heap, or
 * was not vat at all (a command whose main script no vat package owns) — and
 * the spawner's peak alone is not vat's.
 *
 * @param dumps - The repeat's dumps
 * @param index - Its position, for the message
 * @returns The reduction, or the refusal
 */
export function foldRepeat(
  dumps: readonly RssDump[],
  index: number,
): { readonly peakKb: number; readonly processes: number; readonly spawnerKb: number } | string {
  const repeat = `repeat ${String(index + 1)}`;
  const vat = dumps.filter((dump) => dump.role === 'vat');
  const spawner = dumps.filter((dump) => dump.role === 'spawner');
  const [only] = spawner;
  if (spawner.length !== 1 || only === undefined) {
    return `${repeat}: the spawner wrote ${String(spawner.length)} peaks, not 1 — the repeat did not run through it, or did not end normally`;
  }
  if (vat.length === 0) {
    return (
      `${repeat}: no vat process wrote a peak — it was killed, ran out of heap, or no process it ran had a ` +
      "main script inside vat's launcher or CLI package"
    );
  }
  return { peakKb: Math.max(...vat.map((dump) => dump.maxRssKb)), processes: vat.length, spawnerKb: only.maxRssKb };
}

/**
 * Every repeat of one command, folded with {@link foldRepeat} — or the first
 * repeat's refusal, or a refusal when the repeats disagree on how many vat
 * processes ran: their largest-process peaks are then not samples of one thing.
 *
 * @param dumpsPerRepeat - Each repeat's dumps, in repeat order
 * @returns The samples, process counts and floors, or the refusal
 */
export function foldRepeats(
  dumpsPerRepeat: readonly (readonly RssDump[])[],
): { readonly samplesKb: number[]; readonly processesPerRepeat: number[]; readonly spawnerKb: number[] } | string {
  const samplesKb: number[] = [];
  const processesPerRepeat: number[] = [];
  const spawnerKb: number[] = [];
  for (const [index, dumps] of dumpsPerRepeat.entries()) {
    const repeat = foldRepeat(dumps, index);
    if (typeof repeat === 'string') return repeat;
    samplesKb.push(repeat.peakKb);
    processesPerRepeat.push(repeat.processes);
    spawnerKb.push(repeat.spawnerKb);
  }
  if (new Set(processesPerRepeat).size > 1) {
    return (
      `the repeats disagree on how many vat processes ran (${processesPerRepeat.join('/')}) — a repeat whose ` +
      'process wrote no peak, or a vat that ran differently from one repeat to the next; either way the ' +
      'largest-process peaks are not samples of one thing'
    );
  }
  return { samplesKb, processesPerRepeat, spawnerKb };
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

  const reads = await Promise.all(directories.map((directory) => readDumpFiles(directory, RSS_DUMP_KIND)));
  const dumpsPerRepeat: (readonly RssDump[])[] = [];
  for (const read of reads) {
    if (!read.ok) return failedRow(measurement, read.refusal);
    dumpsPerRepeat.push(read.dumps);
  }
  const folded = foldRepeats(dumpsPerRepeat);
  if (typeof folded === 'string') return failedRow(measurement, folded);
  const { samplesKb, processesPerRepeat, spawnerKb } = folded;

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
    spawnerKb,
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
  const spawnerPath = resolvePreloadPath(
    'captureMemory',
    'RSS spawner',
    options.spawnerPath ?? resolveFromImportMeta(import.meta.url, SPAWNER_FILE),
    'a peak that includes the lab',
  );
  // From the environment the child would actually get, so an arm's own
  // NODE_OPTIONS (a raised `--max-old-space-size`, say) survives under the probe.
  const nodeOptions = nodeOptionsWith(probePath, buildArmEnv(process.env, options.env)['NODE_OPTIONS']);

  const loadBefore = readLoad();
  const { rows: commands, measured } = await captureCommandRows(
    options,
    DUMP_DIR_PREFIX,
    (directory) => ({ [RSS_LOG_DIR_ENV]: directory, NODE_OPTIONS: nodeOptions }),
    spawnerPath,
    rowFromDumps,
  );
  const loadAfter = readLoad();

  return buildReportEnvelope(MEMORY_FACET, options, {
    commands,
    load: judgeLoad(loadBefore.loadAvg1, loadAfter.loadAvg1, loadAfter.cpus),
  }, measured);
}
