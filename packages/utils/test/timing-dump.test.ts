/**
 * The dump file's name has to be CLAIMED, not merely observed to be free.
 *
 * ## What went wrong
 *
 * `writeTimingDump` used to pick a name with `existsSync` and write it a moment
 * later. Between those two operations any other writer could pick — and write —
 * the same name, and the loser's dump vanished with no error anywhere: last
 * writer wins, silently.
 *
 * Nothing forced the two writers to be simultaneous until VAT gained a
 * worker-thread parse pool. Worker threads SHARE their parent's pid, so every
 * worker competes for the same `<stem>-<pid>` sequence, and they all dump at the
 * same instant because they all shut down together. Measured with 8 workers:
 * **6 of 9 dumps were silently overwritten** — 172 documents parsed, 44
 * accounted for.
 *
 * That is not untidiness. These dumps are the input to the lab's `parse` facet,
 * the instrument that decides whether the worker pool pays for itself, so a
 * lossy dump makes the pool look cheaper than it is in the one measurement that
 * judges it.
 *
 * ## Why the load-bearing test spawns real threads
 *
 * The race is the only thing the old code got wrong. Single-threaded, it lands
 * on exactly the same filenames as the fixed code and cannot be told apart from
 * it by any observation — so a deterministic test alone would have passed
 * against the defect. {@link WORKER_COUNT} threads write {@link ROUNDS_PER_WORKER}
 * dumps each through an `Atomics` barrier that releases them together; every
 * body is distinguishable, so a lost dump is detectable by CONTENT and not only
 * by a file count.
 *
 * ## Why the workers import `dist/` and not `src/`
 *
 * A worker thread gets no help from vitest's transform pipeline. Node 24 strips
 * types but does NOT remap a `.js` specifier onto a `.ts` file, and
 * `timing-dump.ts` imports `./path-core.js` and `./path-utils.js` — so a worker
 * started on the TypeScript source dies on its first import. The built module is
 * therefore the subject, and {@link assertBuiltModuleIsCurrent} turns a stale or
 * missing `dist/` into a red with the command to fix it rather than into a pass
 * that measured last week's code. Every other test here drives `src/` directly.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizedTmpdir, safePath } from '../src/path-utils.js';
import { MAX_DUMP_COLLISIONS, writeTimingDump } from '../src/timing-dump.js';

/** The seam name every dump here is filed under; only ever read back off stderr. */
const NOUN = 'race-probe';

/** Basename stem the dumps use; the pid and any collision counter follow it. */
const BASENAME = 'race';

/** Threads racing for one name sequence. Eight is what the measured loss used. */
const WORKER_COUNT = 8;

/**
 * Dumps each worker writes.
 *
 * One apiece would already race, but the window between `existsSync` and
 * `writeFileSync` is microseconds wide and a single volley can miss it. Rounds
 * make the collision near-certain against the defect while staying well under
 * {@link MAX_DUMP_COLLISIONS}.
 */
const ROUNDS_PER_WORKER = 25;

/** Every dump the whole race should produce. */
const EXPECTED_DUMPS = WORKER_COUNT * ROUNDS_PER_WORKER;

/** `Int32Array` slot holding how many workers have reached the barrier. */
const BARRIER_ARRIVED = 0;

/** `Int32Array` slot the barrier's release is published on. */
const BARRIER_GATE = 1;

/** Byte length of the barrier's two `Int32Array` slots. */
const BARRIER_BYTES = 8;

/** What {@link BARRIER_GATE} holds until the last worker arrives. */
const GATE_CLOSED = 0;

/** What the last worker to arrive stores in {@link BARRIER_GATE}. */
const GATE_OPEN = 1;

/** The built module the worker threads load. */
const BUILT_MODULE_URL = new URL('../dist/timing-dump.js', import.meta.url);

/** The source the built module is compiled from, for the staleness check. */
const SOURCE_MODULE_URL = new URL('../src/timing-dump.ts', import.meta.url);

/** One worker's report: the paths `writeTimingDump` handed back, in order. */
interface WorkerReport {
  readonly id: number;
  readonly paths: readonly (string | null)[];
}

/** One dump body, as written by a worker. */
interface RaceDump {
  readonly worker: number;
  readonly round: number;
}

/**
 * The worker body, as CommonJS source for `eval: true`.
 *
 * Deliberately not a file: a `.ts` worker entry could not be imported (see the
 * module docstring) and a committed `.js` one would be a second build artifact
 * to keep in step. Everything it needs arrives through `workerData`.
 */
const WORKER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
const { moduleUrl, directory, noun, basename, id, rounds, workerCount, barrier } = workerData;
const gate = new Int32Array(barrier);

import(moduleUrl).then((module) => {
  // Release everyone at once: a staggered start is not the failure being tested.
  const arrived = Atomics.add(gate, ${String(BARRIER_ARRIVED)}, 1) + 1;
  if (arrived === workerCount) {
    Atomics.store(gate, ${String(BARRIER_GATE)}, ${String(GATE_OPEN)});
    Atomics.notify(gate, ${String(BARRIER_GATE)});
  } else {
    Atomics.wait(gate, ${String(BARRIER_GATE)}, ${String(GATE_CLOSED)});
  }

  const paths = [];
  for (let round = 0; round < rounds; round += 1) {
    paths.push(module.writeTimingDump(noun, directory, basename, () => ({ worker: id, round })));
  }
  parentPort.postMessage({ id, paths });
}).catch((error) => {
  parentPort.postMessage({ id, error: String(error && error.stack ? error.stack : error) });
});
`;

/**
 * Fail loudly when `dist/` cannot be trusted to be the code under test.
 *
 * A missing build would otherwise fail the race test with an import error that
 * reads like a defect, and a build older than the source would let the race test
 * pass against code that is no longer in the tree — the worse of the two, since
 * it is green.
 */
function assertBuiltModuleIsCurrent(): void {
  const built = fileURLToPath(BUILT_MODULE_URL);
  const source = fileURLToPath(SOURCE_MODULE_URL);
  const remedy = 'run `bunx tsc --build packages/utils` first';
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- both paths are derived from this test file's own URL
  const builtStat = statSync(built, { throwIfNoEntry: false });
  expect(builtStat, `${built} is not built — ${remedy}`).toBeDefined();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- both paths are derived from this test file's own URL
  const sourceStat = statSync(source);
  expect(
    builtStat === undefined ? 0 : builtStat.mtimeMs,
    `${built} is older than its source — ${remedy}`,
  ).toBeGreaterThanOrEqual(sourceStat.mtimeMs);
}

/**
 * Run one worker to completion.
 *
 * @param options - Everything the worker body reads out of `workerData`
 * @returns What the worker reported before it exited
 */
async function runWorker(options: Record<string, unknown>): Promise<WorkerReport> {
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: options });
  try {
    return await new Promise<WorkerReport>((resolve, reject) => {
      worker.on('message', (message: WorkerReport & { error?: string }) => {
        if (message.error === undefined) resolve(message);
        else reject(new Error(message.error));
      });
      worker.on('error', reject);
      worker.on('exit', (code) => {
        reject(new Error(`worker exited with ${String(code)} before reporting`));
      });
    });
  } finally {
    // A leaked worker hangs the run; terminate whatever the outcome was.
    await worker.terminate();
  }
}

/**
 * Every dump file in a directory, keyed by filename.
 *
 * @param directory - Directory to read
 * @returns Parsed bodies by filename
 */
function readDumps(directory: string): Map<string, RaceDump> {
  const dumps = new Map<string, RaceDump>();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a mkdtemp directory this file created
  for (const name of readdirSync(directory)) {
    const file = safePath.join(directory, name);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a mkdtemp directory this file created
    dumps.set(name, JSON.parse(readFileSync(file, 'utf-8')) as RaceDump);
  }
  return dumps;
}

/**
 * The identity of every dump the race should have produced.
 *
 * Content, not just count: a worker whose file was overwritten by another
 * worker's leaves the count intact whenever some other name was skipped, so only
 * the bodies prove nothing was lost.
 *
 * @returns One `worker:round` key per expected dump
 */
function expectedDumpKeys(): string[] {
  return Array.from({ length: EXPECTED_DUMPS }, (_unused, index) => {
    const worker = Math.floor(index / ROUNDS_PER_WORKER);
    return `${String(worker)}:${String(index % ROUNDS_PER_WORKER)}`;
  });
}

/**
 * The `worker:round` key of a dump body.
 *
 * @param dump - A parsed dump body
 * @returns Its identity key
 */
function dumpKey(dump: RaceDump): string {
  return `${String(dump.worker)}:${String(dump.round)}`;
}

/** Every chunk the seam wrote to stderr in the current test. */
let captured: string[] = [];

/**
 * Whatever the seam wrote to stderr during the test.
 *
 * @returns Every captured chunk, joined
 */
function stderrText(): string {
  return captured.join('');
}

/**
 * Sort keys the same way on every platform and locale.
 *
 * @param left - One key
 * @param right - The other
 * @returns Their ordering
 */
function byKey(left: string, right: string): number {
  return left.localeCompare(right);
}

describe('writeTimingDump', () => {
  let directory = '';

  beforeEach(() => {
    directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'timing-dump-'));
    captured = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
      captured.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it('loses no dump when threads sharing one pid all write at the same instant', async () => {
    assertBuiltModuleIsCurrent();

    const barrier = new SharedArrayBuffer(BARRIER_BYTES);
    const reports = await Promise.all(
      Array.from({ length: WORKER_COUNT }, (_unused, id) =>
        runWorker({
          moduleUrl: BUILT_MODULE_URL.href,
          directory,
          noun: NOUN,
          basename: BASENAME,
          id,
          rounds: ROUNDS_PER_WORKER,
          workerCount: WORKER_COUNT,
          barrier,
        }),
      ),
    );

    const claimed = reports.flatMap((report) => report.paths);
    // Two writers handed the SAME path is the defect stated in its own terms:
    // the second write destroyed the first, and both callers were told they had
    // filed a dump.
    expect(claimed.filter((path) => path === null)).toEqual([]);
    expect(new Set(claimed).size).toBe(EXPECTED_DUMPS);

    const dumps = readDumps(directory);
    expect(dumps.size).toBe(EXPECTED_DUMPS);
    expect([...dumps.values()].map(dumpKey).sort(byKey)).toEqual(expectedDumpKeys().sort(byKey));
  });

  it('claims the first free name and leaves the taken ones byte-unchanged', () => {
    const stem = `${BASENAME}-${String(process.pid)}`;
    const taken = [`${stem}.json`, `${stem}-1.json`];
    for (const [index, name] of taken.entries()) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a mkdtemp directory this file created
      writeFileSync(safePath.join(directory, name), `occupied-${String(index)}\n`, 'utf-8');
    }

    const written = writeTimingDump(NOUN, directory, BASENAME, () => ({ mine: true }));

    expect(written).toBe(safePath.join(directory, `${stem}-2.json`));
    for (const [index, name] of taken.entries()) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a mkdtemp directory this file created
      expect(readFileSync(safePath.join(directory, name), 'utf-8')).toBe(`occupied-${String(index)}\n`);
    }
    expect(stderrText()).toBe('');
  });

  it('reports the collision ceiling as its own condition, and does not overwrite the last slot', () => {
    const stem = `${BASENAME}-${String(process.pid)}`;
    for (let collision = 0; collision <= MAX_DUMP_COLLISIONS; collision += 1) {
      const suffix = collision === 0 ? '' : `-${String(collision)}`;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a mkdtemp directory this file created
      writeFileSync(safePath.join(directory, `${stem}${suffix}.json`), 'occupied\n', 'utf-8');
    }

    expect(writeTimingDump(NOUN, directory, BASENAME, () => ({ mine: true }))).toBeNull();

    // "Every name was taken" and "the disk refused the write" are different
    // operator problems: one is a runaway dump directory, the other is a broken
    // one. Reporting them with the same line makes the first look like the
    // second.
    expect(stderrText()).toContain(String(MAX_DUMP_COLLISIONS));
    expect(stderrText()).toContain('claimed');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a mkdtemp directory this file created
    const last = readFileSync(safePath.join(directory, `${stem}-${String(MAX_DUMP_COLLISIONS)}.json`), 'utf-8');
    expect(last).toBe('occupied\n');
  });

  it('reports a real I/O failure with the OS error, not as a collision', () => {
    const missing = safePath.join(directory, 'no', 'such', 'place');

    expect(writeTimingDump(NOUN, missing, BASENAME, () => ({ mine: true }))).toBeNull();

    expect(stderrText()).toContain('ENOENT');
    expect(stderrText()).not.toContain('claimed');
  });

  it('never throws when the body cannot be built, because it runs from an exit listener', () => {
    const explode = (): unknown => {
      throw new Error('accumulators exploded');
    };

    expect(writeTimingDump(NOUN, directory, BASENAME, explode)).toBeNull();

    expect(stderrText()).toContain('accumulators exploded');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a mkdtemp directory this file created
    expect(readdirSync(directory)).toEqual([]);
  });

  it('does not build the body at all when the seam is off', () => {
    const build = vi.fn();

    expect(writeTimingDump(NOUN, null, BASENAME, build)).toBeNull();

    expect(build).not.toHaveBeenCalled();
  });
});
