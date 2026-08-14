/**
 * Capturing an `io` report: run each command N times with the counter injected,
 * and report what the LAST repeat did — plus whether the repeats before it did
 * the same thing.
 *
 * ## Why this one is async and `capturePerf` is not
 *
 * `capturePerf` is synchronous: its measurement is `performance.now()` around a
 * `spawnSync`, and there is nothing to await. This facet's measurement is on
 * disk — the counter writes a JSON dump per process and {@link readDumps} is
 * async — so `captureIo` returns a promise. The asymmetry is real and is left
 * visible rather than papered over: making one look like the other would mean
 * either blocking on the reads or pretending the timings needed an event loop,
 * and a caller that knows which facet does I/O to produce its numbers is better
 * informed than one that does not.
 *
 * ## The warm-up, and why `stable` is nullable
 *
 * The first repeat populates vat's on-disk cache and therefore systematically
 * differs from every repeat after it. It is a warm-up: excluded from the
 * stability comparison, and reported only when it is also the last repeat
 * (`runs: 1`). Everything else compares repeats `1 … runs-1` and reports the
 * last of them.
 *
 * Below two compared repeats nothing can disagree, so `stable` is `null` rather
 * than `true` — see {@link IoCommandStats.stable}. A boolean there would report
 * a determinism that was never tested, and a comparator would trust an
 * exact-equality delta it has no warrant for.
 *
 * ## Four ways to get a confident wrong number here
 *
 * Each of these was measured, not imagined, and each produces a well-formed
 * report that says nothing about being wrong:
 *
 * 1. **A dump directory reused across repeats.** Nothing downstream can tell a
 *    leftover dump from an earlier repeat apart from a descendant process of
 *    this one — both are files with distinct PIDs — so reuse inflates both the
 *    call counts and `processes`. Hence {@link makeDumpDirs}: a fresh `mkdtemp`
 *    per repeat, freshness by construction rather than by deleting first.
 * 2. **`NODE_OPTIONS` assigned instead of appended.** `runRepeats` merges the
 *    capture's environment OVER `process.env`, so an assignment silently drops
 *    whatever the surrounding shell or CI had set — changing the process being
 *    measured while reporting it as the same one. See {@link nodeOptionsWith}.
 * 3. **The preload on `env` instead of `envFor`.** `env` reaches every child,
 *    including the `vat cache clear` that `cold` mode runs between repeats.
 *    Instrumenting the clear folds setup's own I/O into the measurement.
 * 4. **Running uninstrumented when the counter cannot be found.** That reports
 *    zero I/O, which is the worst output this module can produce: a plausible,
 *    schema-valid report with nothing in it saying it is a lie. See
 *    {@link resolveCounterPath} — it throws.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';

import { normalizedTmpdir, resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';

import type { ReportEnvelope } from '../../envelope/envelope.js';
import { judgeLoad, readLoad } from '../../harness/load-guard.js';
import { measureSpec, type SpecMeasurement } from '../../harness/repeat.js';
import { buildReportEnvelope } from '../../harness/report.js';
import type { CacheMode, CaptureRequest } from '../../harness/types.js';

import { type MergedDumps, readDumps, sameBuckets, type SiteRoots } from './dump.js';
import { IO_FACET, IO_FACET_VERSION, type IoBody, type IoCommandStats } from './types.js';

/**
 * The counter's activation variable.
 *
 * A literal rather than an import: the counter is `counter.cts`, emitted as
 * CommonJS, and it is loaded by path into someone else's process — importing a
 * constant from it would mean loading it here, which is exactly what must not
 * happen. The other half of this contract is pinned by
 * `test/io-counter.test.ts`, which asserts the counter activates on this name.
 */
const COUNTER_LOG_DIR_ENV = 'VAT_LAB_IO_LOG';

/** The emitted counter, beside this module once both are built. */
const COUNTER_FILE = './counter.cjs';

/** What to run when the counter has not been built. Named in the error, not implied. */
const BUILD_COMMAND = 'bunx tsc --build packages/lab/tsconfig.json';

/** Prefix for a repeat's dump directory, so a stray one names its owner. */
const DUMP_DIR_PREFIX = 'vat-lab-io-';

/** The row a command produces before any measurement is folded into it. */
interface RowBase {
  readonly name: string;
  readonly args: readonly string[];
  readonly cache: CacheMode;
}

/**
 * Everything a capture needs: the shared request, plus the one thing that is
 * genuinely this facet's own.
 *
 * `runs` counts repeats INCLUDING the warm-up. Three is the smallest value that
 * tests determinism at all: one repeat is warmed up and never compared, two
 * leaves a single compared repeat with nothing to disagree with.
 */
export interface CaptureIoOptions extends CaptureRequest {
  /**
   * Where the built counter is, when it is not beside this module.
   *
   * Exists because the default resolves relative to `import.meta.url`, which is
   * `dist/facets/io/capture.js` in a built package and `src/facets/io/capture.ts`
   * under a test runner — and the source tree holds `counter.cts`, never the
   * emitted `.cjs`. A test therefore has to say where its counter is. It is not
   * a mock seam: whatever is named here is loaded by the same `NODE_OPTIONS`
   * string production uses, into the same child, through the same env contract.
   */
  readonly counterPath?: string;
}

/**
 * Locate the counter, or refuse to measure.
 *
 * Never falls back to running vat uninstrumented. A capture with no counter
 * produces a report of zero calls, and zero is a number a reader has no way to
 * distinguish from a real measurement — unlike a thrown error, which costs one
 * run and names its own remedy.
 *
 * @param override - See {@link CaptureIoOptions.counterPath}
 * @returns Absolute path to the counter, forward-slashed
 * @throws {Error} when nothing is at that path
 */
function resolveCounterPath(override: string | undefined): string {
  const counter = safePath.resolve(
    override ?? resolveFromImportMeta(import.meta.url, COUNTER_FILE),
  );
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the module's own sibling, or a caller-supplied path
  if (existsSync(counter)) return counter;

  throw new Error(
    `captureIo: no I/O counter at ${counter}. Build it with \`${BUILD_COMMAND}\`, or pass ` +
      'counterPath. The capture will not run vat uninstrumented instead: that reports zero ' +
      'filesystem calls, and nothing in such a report says it is a lie.',
  );
}

/**
 * Build the `NODE_OPTIONS` for a measured run: whatever was already there, plus
 * the preload.
 *
 * **Appended, never assigned.** `runRepeats` merges this over `process.env`, so
 * an assignment drops an inherited `--max-old-space-size` or `--no-warnings` and
 * measures a differently-configured process while reporting it as the same one.
 *
 * **Quoted, and forward-slashed.** Both halves are required and neither is
 * obvious. Unquoted, `--require /Some Path/counter.cjs` parses as two arguments
 * and node dies looking for `/Some`. Quoted, Node's `NODE_OPTIONS` parser treats
 * a backslash inside the quotes as an escape — measured on Node 24.13.1,
 * `--require "/tmp/labq\back/x.cjs"` resolves to `/tmp/labqback/x.cjs` — so a
 * native Windows path would be silently mangled into one that does not exist.
 * `safePath.resolve` already yields forward slashes, which Node accepts on
 * Windows, and this is the reason it must.
 *
 * @param counterPath - Absolute, forward-slashed path to the counter
 * @param base - `NODE_OPTIONS` as the child would otherwise have seen it
 * @returns The value to set for the measured run
 */
function nodeOptionsWith(counterPath: string, base: string | undefined): string {
  const preload = `--require "${counterPath}"`;
  const existing = (base ?? '').trim();
  return existing === '' ? preload : `${existing} ${preload}`;
}

/**
 * One fresh dump directory per repeat.
 *
 * `mkdtemp` per repeat rather than one directory emptied between them: emptying
 * is a step that can fail, be skipped, or race a descendant process that has not
 * exited yet, and every one of those failures adds calls to the next repeat's
 * numbers without adding anything that says so.
 *
 * @param runs - How many repeats will run
 * @returns One directory per repeat, in repeat order
 */
async function makeDumpDirs(runs: number): Promise<string[]> {
  const prefix = safePath.join(normalizedTmpdir(), DUMP_DIR_PREFIX);
  return Promise.all(Array.from({ length: Math.max(0, runs) }, () => mkdtemp(prefix)));
}

/**
 * A row that measured nothing, with every measurement zeroed and `failed` set.
 *
 * Zeros rather than absent fields: the schema is strict and a reader must not
 * have to guess. `failed` and `failure` are what carry the meaning — an empty
 * measurement must never be readable as a quiet one.
 *
 * @param base - Name, arguments and cache mode
 * @param runs - How many repeats actually ran
 * @param failure - Why there is no measurement
 * @returns The failed row
 */
function failedRow(base: RowBase, runs: number, failure: string): IoCommandStats {
  return {
    ...base,
    runs,
    comparedRuns: 0,
    stable: null,
    processes: 0,
    loaderCalls: 0,
    userCalls: 0,
    sites: [],
    failed: true,
    failure,
  };
}

/**
 * Read the repeats that count, and decide whether they agreed.
 *
 * The window is non-empty by type, which is what lets the reported repeat be
 * "the last one read" without a defensive branch for a case that cannot happen.
 * Agreement is checked against each repeat's PREDECESSOR rather than against all
 * pairs: bucket equality is transitive, so adjacent equality throughout is
 * equality throughout, at a fraction of the comparisons.
 *
 * @param window - Dump directories of the repeats to read, in repeat order
 * @param roots - See {@link SiteRoots}
 * @returns The last repeat's numbers and whether all of them matched, or the
 *   first refusal encountered
 */
async function readWindow(
  window: readonly [string, ...string[]],
  roots: SiteRoots,
): Promise<{ reported: MergedDumps; allSame: boolean } | { refusal: string }> {
  const [head, ...tail] = window;
  const [first, ...rest] = await Promise.all([
    readDumps(head, roots),
    ...tail.map((directory) => readDumps(directory, roots)),
  ]);

  if (!first.ok) return { refusal: first.refusal };
  let reported = first.merged;
  let allSame = true;
  for (const result of rest) {
    if (!result.ok) return { refusal: result.refusal };
    allSame &&= sameBuckets(reported, result.merged);
    reported = result.merged;
  }
  return { reported, allSame };
}

/**
 * Fold what the repeats wrote to disk into a report row.
 *
 * Whether the repeats are usable at all is already decided — {@link measureSpec}
 * owns that, so this facet and `perf` refuse exactly the same repeats for
 * exactly the same reasons, phrased the same way. What is left here is this
 * facet's own question: what did the dumps say, and did they agree.
 *
 * @param measurement - What was asked for, what ran, and whether it is usable
 * @param directories - The repeats' dump directories, in repeat order
 * @param roots - See {@link SiteRoots}
 * @returns The row, marked failed when no usable measurement exists
 */
async function rowFromDumps(
  measurement: SpecMeasurement,
  directories: readonly string[],
  roots: SiteRoots,
): Promise<IoCommandStats> {
  const { results, failure } = measurement;
  const base: RowBase = {
    name: measurement.spec.name,
    args: measurement.args,
    cache: measurement.cache,
  };

  // Repeat 0 is the warm-up and is compared with nothing — except when it is
  // also the only repeat, and therefore the one reported.
  const [head, ...tail] = directories.length <= 1 ? directories : directories.slice(1);
  if (head === undefined) return failedRow(base, 0, 'no repeats were requested');
  if (failure !== null) return failedRow(base, results.length, failure);

  const read = await readWindow([head, ...tail], roots);
  if ('refusal' in read) return failedRow(base, results.length, read.refusal);

  const comparedRuns = Math.max(0, results.length - 1);
  return {
    ...base,
    runs: results.length,
    comparedRuns,
    // Below two compared repeats there is nothing to disagree, so there is
    // nothing to report. `null` is not `false` and emphatically not `true`.
    stable: comparedRuns < 2 ? null : read.allSame,
    processes: read.reported.processes,
    loaderCalls: read.reported.loaderCalls,
    userCalls: read.reported.userCalls,
    sites: read.reported.sites,
    failed: false,
    failure: null,
  };
}

/**
 * Capture an `io` report.
 *
 * Commands are measured one after another, never concurrently: two vat
 * processes racing for the same disk would each measure the other's
 * interference, and the counts are only comparable across reports if each one
 * described a machine doing one thing.
 *
 * @param options - See {@link CaptureIoOptions}
 * @returns A complete report envelope, ready to store
 * @throws {Error} when the counter cannot be found — see {@link resolveCounterPath}
 */
export async function captureIo(options: CaptureIoOptions): Promise<ReportEnvelope<IoBody>> {
  const counterPath = resolveCounterPath(options.counterPath);
  const roots: SiteRoots = {
    // Empty for an `npx` instrument, and handled: a published package is
    // unpacked under an arbitrary cache path and every file in it sits under
    // `node_modules`, which the site normalizer already keys on.
    instrumentRoot: options.instrument.root ?? '',
    subjectPath: options.subject.path,
  };

  const nodeOptions = nodeOptionsWith(
    counterPath,
    options.env?.['NODE_OPTIONS'] ?? process.env['NODE_OPTIONS'],
  );

  const loadBefore = readLoad();
  const commands: IoCommandStats[] = [];
  for (const spec of options.commands) {
    // Sequential on purpose — see this function's doc. Awaiting inside the loop
    // is the mechanism, not an oversight.
    const directories = await makeDumpDirs(options.runs);
    try {
      // Per repeat, and on `envFor` rather than `env`: only the measured run is
      // instrumented, so `cold` mode's cache clear cannot contribute its own I/O.
      const perRepeat = directories.map((directory) => ({
        [COUNTER_LOG_DIR_ENV]: directory,
        NODE_OPTIONS: nodeOptions,
      }));
      const measurement = measureSpec(options, spec, (index) => perRepeat[index]);
      commands.push(await rowFromDumps(measurement, directories, roots));
    } finally {
      await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
      );
    }
  }
  const loadAfter = readLoad();

  return buildReportEnvelope(IO_FACET, IO_FACET_VERSION, options, {
    commands,
    load: judgeLoad(loadBefore.loadAvg1, loadAfter.loadAvg1, loadAfter.cpus),
  });
}
