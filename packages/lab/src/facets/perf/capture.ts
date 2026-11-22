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
 * 2. **Cold means cold on every repeat, in the command's own arm.** Resetting
 *    once and then running five times measures one cold run and four warm ones.
 *    That loop, the arm's private store/`TMPDIR`/home and the cleared
 *    environment belong to the harness — see `harness/repeat.ts`, which every
 *    measurement facet shares so the property cannot hold in one facet and not
 *    another.
 * 3. **Load is read around the whole capture**, and travels in the report. A
 *    number taken on a busy machine is not wrong so much as unattributable, and
 *    the reader has to be able to see that.
 *
 * What stays here is everything about wall-clock statistics: which repeats are
 * allowed near a median, and what a row says when none are.
 *
 * ## What the probe adds
 *
 * The wall is still `measureSpec`'s own clock around the launch. Beside it the
 * capture injects `perf-probe.cts` (see there) into every vat process, through
 * the shared per-repeat dump loop, and reads back one record per process: that
 * is where total CPU and per-surface wall come from. It also points
 * `VAT_VALIDATE_DEBUG_FACTS` at a directory of its own, so a build that writes
 * the debug-facts dump says whether `vat validate` overlapped its checks child;
 * a build that does not (main) leaves it empty, and the row says unknown.
 */

import { readdir } from 'node:fs/promises';

import { isPathAbsentError, resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';

import type { ReportEnvelope } from '../../envelope/envelope.js';
import { buildArmEnv } from '../../harness/arm-env.js';
import { captureDumpReport } from '../../harness/dump-capture.js';
import { type DumpKind, readDumpFiles, refuseDumps } from '../../harness/dumps.js';
import { nodeOptionsWith, resolvePreloadPath } from '../../harness/preload.js';
import type { SpecMeasurement } from '../../harness/repeat.js';
import type { CaptureRequest } from '../../harness/types.js';

import { foldDebugFacts, foldProcessRepeats } from './process-fold.js';
import { summarize } from './stats.js';
import {
  PERF_FACET,
  type PerfBody,
  type PerfCommandStats,
  type PerfProcessDump,
  PerfProcessDumpSchema,
  type ValidateDebugFacts,
  ValidateDebugFactsSchema,
} from './types.js';

/**
 * The probe's activation variable. A literal rather than an import, as in
 * `memory`: importing from the probe would load it here. Pinned against the
 * probe's own value by `test/integration/perf-probe.integration.test.ts`.
 */
const PERF_LOG_DIR_ENV = 'VAT_LAB_PERF_LOG';

/** The variable that makes `vat validate` write its debug-facts dump into the directory it names. */
const DEBUG_FACTS_ENV = 'VAT_VALIDATE_DEBUG_FACTS';

/** The debug-facts directory's name inside a repeat's dump directory: beside the probe's records, never among them. */
const DEBUG_FACTS_DIRECTORY = 'debug-facts';

/** The emitted probe, beside this module once both are built. */
const PROBE_FILE = './perf-probe.cjs';

/** Prefix for a repeat's dump directory, so a stray one names its owner. */
const DUMP_DIR_PREFIX = 'vat-lab-perf-';

/** How the probe's process records are read and refused. */
const PROCESS_RECORD_KIND: DumpKind<PerfProcessDump> = {
  noun: 'perf process record',
  producer: 'perf probe',
  schema: PerfProcessDumpSchema,
  // Never read: an empty directory is answered before this is asked (see `readOptionalDumps`).
  emptyDirectory: (directory) => `no perf process records in '${directory}'`,
};

/** How `vat validate`'s debug-facts dump is read and refused. */
const DEBUG_FACTS_KIND: DumpKind<ValidateDebugFacts> = {
  noun: 'validate debug-facts dump',
  producer: 'vat validate',
  schema: ValidateDebugFactsSchema,
  emptyDirectory: (directory) => `no debug-facts dump in '${directory}'`,
};

/**
 * Everything a capture needs: the shared request, plus where the probe is.
 *
 * `probePath` exists for the reason `CaptureMemoryOptions.probePath` does: the
 * default resolves beside this module, which under a test runner is the source
 * tree, where only `perf-probe.cts` exists. It is not a mock seam: whatever is
 * named is loaded by the same `NODE_OPTIONS` string production uses.
 */
export interface CapturePerfOptions extends CaptureRequest {
  readonly probePath?: string;
}

/**
 * Every dump in a directory, where an absent or empty directory is a legitimate
 * "none": a build may write no debug facts, and a command may run no vat process.
 *
 * @param directory - Where an instrument may have written
 * @param kind - How its dumps are read
 * @returns Every dump (none when there are none), or the refusal
 */
async function readOptionalDumps<TDump>(
  directory: string,
  kind: DumpKind<TDump>,
): Promise<{ readonly ok: true; readonly dumps: readonly TDump[] } | { readonly ok: false; readonly refusal: string }> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isPathAbsentError(error)) return { ok: true, dumps: [] };
    return refuseDumps(`could not read the ${kind.noun} directory '${directory}': ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!entries.some((name) => name.endsWith('.json'))) return { ok: true, dumps: [] };
  return readDumpFiles(directory, kind);
}

/**
 * A row that measured nothing: zeros, `failed` set, and the reason.
 *
 * @param measurement - What was asked for and what ran
 * @param failure - Why there is no measurement
 * @returns The failed row
 */
function failedRow(measurement: SpecMeasurement, failure: string): PerfCommandStats {
  return {
    name: measurement.spec.name,
    args: measurement.args,
    cache: measurement.cache,
    runs: measurement.results.length,
    medianMs: 0,
    minMs: 0,
    maxMs: 0,
    iqrMs: 0,
    samplesMs: [],
    exitCode: null,
    failed: true,
    failure,
    surfaces: {},
    cpuMs: null,
    processes: [],
    checksOverlapped: null,
    gateDeclinedBy: null,
  };
}

/**
 * What the probe and the build wrote in one repeat's directory.
 *
 * @param directory - The repeat's dump directory
 * @returns Its process records and its debug facts (`null` where the build wrote none), or why they cannot be read
 */
async function readRepeat(
  directory: string,
): Promise<{ readonly records: readonly PerfProcessDump[]; readonly facts: ValidateDebugFacts | null } | string> {
  const records = await readOptionalDumps(directory, PROCESS_RECORD_KIND);
  if (!records.ok) return records.refusal;
  const facts = await readOptionalDumps(safePath.join(directory, DEBUG_FACTS_DIRECTORY), DEBUG_FACTS_KIND);
  if (!facts.ok) return facts.refusal;
  if (facts.dumps.length > 1) {
    return `${String(facts.dumps.length)} processes wrote a debug-facts dump into one repeat's directory; the mode of the run is not one answer`;
  }
  return { records: records.dumps, facts: facts.dumps[0] ?? null };
}

/**
 * Turn a command's repeats and their directories into a report row.
 *
 * Whether the repeats are usable at all is `measureSpec`'s decision, shared with
 * every facet; what is added here is the probe's records and the build's facts.
 *
 * @param measurement - What was asked for, what ran, and whether it is usable
 * @param directories - The repeats' dump directories, in repeat order
 * @returns The row, marked failed when no usable measurement exists
 */
async function rowFromDumps(measurement: SpecMeasurement, directories: readonly string[]): Promise<PerfCommandStats> {
  const { spec, args, cache, results, failure } = measurement;

  // Any failure poisons the row — `armRunFailure` owns that rule and its wording.
  if (failure !== null) return failedRow(measurement, failure);

  const repeats = await Promise.all(directories.map((directory) => readRepeat(directory)));
  const recordsPerRepeat: (readonly PerfProcessDump[])[] = [];
  const factsPerRepeat: (ValidateDebugFacts | null)[] = [];
  for (const repeat of repeats) {
    if (typeof repeat === 'string') return failedRow(measurement, repeat);
    recordsPerRepeat.push(repeat.records);
    factsPerRepeat.push(repeat.facts);
  }
  const processes = foldProcessRepeats(recordsPerRepeat);
  if (typeof processes === 'string') return failedRow(measurement, processes);
  const mode = foldDebugFacts(factsPerRepeat);
  if (typeof mode === 'string') return failedRow(measurement, mode);

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
    surfaces: processes.surfaces,
    cpuMs: processes.cpuMs,
    processes: processes.cpuMs === null ? [] : recordsPerRepeat,
    checksOverlapped: mode.checksOverlapped,
    gateDeclinedBy: mode.gateDeclinedBy,
  };
}

/**
 * Capture a `perf` report.
 *
 * @param options - See {@link CapturePerfOptions}
 * @returns A complete report envelope, ready to store
 * @throws {Error} when the probe cannot be found — see `resolvePreloadPath`
 */
export async function capturePerf(options: CapturePerfOptions): Promise<ReportEnvelope<PerfBody>> {
  const probePath = resolvePreloadPath(
    'capturePerf',
    'perf probe',
    options.probePath ?? resolveFromImportMeta(import.meta.url, PROBE_FILE),
    'wall only, with no CPU and no surfaces',
  );
  // From the environment the child would actually get, so an arm's own
  // NODE_OPTIONS survives under the probe.
  const nodeOptions = nodeOptionsWith(probePath, buildArmEnv(process.env, options.env)['NODE_OPTIONS']);

  return await captureDumpReport(
    PERF_FACET,
    options,
    DUMP_DIR_PREFIX,
    (directory) => ({
      [PERF_LOG_DIR_ENV]: directory,
      [DEBUG_FACTS_ENV]: safePath.join(directory, DEBUG_FACTS_DIRECTORY),
      NODE_OPTIONS: nodeOptions,
    }),
    rowFromDumps,
  );
}
