/**
 * The `perf` facet's process probe, run the only way it ever runs: `--require`d
 * into real node processes. The tests run the BUILT `dist/facets/perf/perf-probe.cjs`,
 * because the emitted file is the artifact that ships.
 *
 * The stand-in vat is one script inside a stand-in CLI package. Run plain, it is
 * the parent: it burns a known amount of CPU, writes two `▶ Surface:` banners
 * with a sleep between them, spawns itself as a child that burns CPU too, and
 * leaves a marks file recording the clock either side of each banner write. Every
 * assertion on a time is against those marks, which the stand-in took itself in
 * the same clock the probe reads, so no wall-clock budget decides a pass: the
 * probe's reading must fall inside the interval the stand-in measured around the
 * write, and the gap between the two banners inside what the stand-in measured
 * between them.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { surfaceWalls, totalCpuMs } from '../../src/facets/perf/process-fold.js';
import { type PerfProcessDump, PerfProcessDumpSchema } from '../../src/facets/perf/types.js';

import { cleanupScratch, CLI_PACKAGE, distFile, itKeepsTheProbeContract, mainScript, scratchDir } from './probe-fixtures.js';

/** The emitted probe. */
const PROBE_DIST = distFile('facets/perf/perf-probe.cjs');

/** The activation variable `capture.ts` sets: pinned against the probe's own below. */
const LOG_DIR_ENV = 'VAT_LAB_PERF_LOG';

/** Where the stand-in leaves its marks. */
const MARKS_ENV = 'LAB_STANDIN_MARKS';

/** CPU each stand-in process burns, in microseconds of user time. */
const SPIN_US = 60_000;

/** Pause between the two banners, in milliseconds. */
const BANNER_GAP_MS = 200;

/** Bytes the stand-in writes to stderr besides its banners, so a probe that dropped or reordered them shows. */
const STANDIN = String.raw`
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const stamp = () => performance.timeOrigin + performance.now();
const spin = () => { const t = process.cpuUsage().user; while (process.cpuUsage().user - t < ${String(SPIN_US)}); };
if (process.argv[2] === 'child') { spin(); process.stderr.write('child line\n'); process.exit(0); }
spin();
const marks = [];
const banner = (name) => {
  const before = stamp();
  process.stderr.write('\n\u25b6 Surface: ' + name + '\n');
  marks.push({ name, before, after: stamp() });
};
banner('alpha');
process.stderr.write('h\u00e9llo\n', 'utf8');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${String(BANNER_GAP_MS)});
banner('beta');
process.stderr.write(Buffer.from('raw bytes\n'));
spawnSync(process.execPath, [process.argv[1], 'child'], { stdio: 'inherit' });
process.stderr.write('done\n', () => fs.writeFileSync(process.env.${MARKS_ENV}, JSON.stringify({ marks, callbackFired: true })));
`;

/** What the stand-in recorded about itself. */
interface Marks {
  readonly marks: readonly { readonly name: string; readonly before: number; readonly after: number }[];
  readonly callbackFired: boolean;
}

afterAll(cleanupScratch);

/**
 * A value the stand-in run must have produced.
 *
 * @param value - What was looked for
 * @param what - Its name, for the failure
 * @returns The value
 * @throws When it is absent, which is the failing assertion
 */
function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the stand-in run produced no ${what}`);
  return value;
}

/**
 * The environment that switches the probe on into `dir` and loads it, or leaves it inert.
 *
 * @param dir - The dump directory, or `undefined` for none
 * @param preload - Whether the probe is loaded at all
 * @param marksFile - Where the stand-in leaves its marks
 * @returns The child's environment
 */
function probeEnv(dir: string | undefined, preload: boolean, marksFile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, [MARKS_ENV]: marksFile };
  delete env['NODE_OPTIONS'];
  delete env[LOG_DIR_ENV];
  if (preload) env['NODE_OPTIONS'] = `--require "${PROBE_DIST}"`;
  if (dir !== undefined) env[LOG_DIR_ENV] = dir;
  return env;
}

/** Every dump in `dir`, parsed. */
function dumpsIn(dir: string): PerfProcessDump[] {
  return readdirSync(dir).map((name) => PerfProcessDumpSchema.parse(JSON.parse(readFileSync(safePath.join(dir, name), 'utf-8'))));
}

/** One run of the stand-in vat. */
interface StandInRun {
  readonly stderr: Buffer;
  readonly dumps: PerfProcessDump[];
  readonly marks: Marks;
}

/**
 * Run the stand-in vat.
 *
 * @param probe - `'on'` loads the probe and activates it; `'loaded-inert'` loads it without its variable; `'off'` does neither
 * @returns Its stderr bytes, the dumps the probe wrote, and the stand-in's own marks
 */
function runStandIn(probe: 'on' | 'loaded-inert' | 'off'): StandInRun {
  const script = mainScript(CLI_PACKAGE, 'dist/bin.js', STANDIN);
  const dir = scratchDir('lab-perf-probe-');
  const marksFile = safePath.join(scratchDir('lab-perf-marks-'), 'marks.json');
  const result = spawnSync(NODE_EXECUTABLE, [script], {
    env: probeEnv(probe === 'on' ? dir : undefined, probe !== 'off', marksFile),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  expect(result.status, result.stderr.toString()).toBe(0);
  return { stderr: result.stderr, dumps: dumpsIn(dir), marks: JSON.parse(readFileSync(marksFile, 'utf-8')) as Marks };
}

describe('the perf probe', () => {
  let run: StandInRun;
  let alpha: Marks['marks'][number] | undefined;
  let beta: Marks['marks'][number] | undefined;
  let parent: PerfProcessDump | undefined;
  let child: PerfProcessDump | undefined;

  beforeAll(() => {
    run = runStandIn('on');
    [alpha, beta] = run.marks.marks;
    parent = run.dumps.find((dump) => dump.banners.length > 0);
    child = run.dumps.find((dump) => dump.banners.length === 0);
  });

  it('writes one schema-valid record per vat process, the child pointing at its parent', () => {
    expect(run.dumps).toHaveLength(2);
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(child?.ppid).toBe(parent?.pid);
    // Lifetimes nest: the child started after the parent and was gone before it.
    expect(child?.startMs ?? 0).toBeGreaterThanOrEqual(parent?.startMs ?? Infinity);
    expect(child?.endMs ?? Infinity).toBeLessThanOrEqual(parent?.endMs ?? 0);
    for (const dump of run.dumps) expect(dump.endMs).toBeGreaterThan(dump.startMs);
  });

  it('reads each banner inside the interval the stand-in measured around writing it', () => {
    expect(parent?.banners.map((banner) => banner.name)).toEqual(['alpha', 'beta']);
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    const [first, second] = parent?.banners ?? [];
    expect(first?.atMs ?? 0).toBeGreaterThanOrEqual(alpha?.before ?? Infinity);
    expect(first?.atMs ?? Infinity).toBeLessThanOrEqual(alpha?.after ?? 0);
    expect(second?.atMs ?? 0).toBeGreaterThanOrEqual(beta?.before ?? Infinity);
    expect(second?.atMs ?? Infinity).toBeLessThanOrEqual(beta?.after ?? 0);
  });

  it('puts the banners as far apart as the stand-in slept, to within what it measured', () => {
    const [first, second] = parent?.banners ?? [];
    const gap = (second?.atMs ?? 0) - (first?.atMs ?? 0);
    // The stand-in's own bounds on the gap: from the end of the first write to the start of the second, and from the start of the first to the end of the second.
    const lowest = (beta?.before ?? 0) - (alpha?.after ?? 0);
    const highest = (beta?.after ?? 0) - (alpha?.before ?? 0);

    expect(gap).toBeGreaterThanOrEqual(lowest);
    expect(gap).toBeLessThanOrEqual(highest);
    // The sleep itself: the tolerance is how far the stand-in measured the gap to be from its request.
    expect(lowest).toBeGreaterThanOrEqual(BANNER_GAP_MS - 1);
  });

  it('measures per-surface wall as banner to next banner, the last to its process\'s exit', () => {
    const walls = surfaceWalls(need(parent, 'the bannering process'));
    const [first, second] = parent?.banners ?? [];

    expect(walls).toEqual([
      { name: 'alpha', wallMs: (second?.atMs ?? 0) - (first?.atMs ?? 0) },
      { name: 'beta', wallMs: (parent?.endMs ?? 0) - (second?.atMs ?? 0) },
    ]);
    // The second surface held the child's whole run, so it is at least the child's lifetime.
    expect(walls[1]?.wallMs ?? 0).toBeGreaterThanOrEqual((child?.endMs ?? 0) - (child?.startMs ?? 0));
  });

  it('records CPU per process and sums it over both, never summing wall', () => {
    for (const dump of run.dumps) expect(dump.userCpuUs).toBeGreaterThanOrEqual(SPIN_US);
    const summed = run.dumps.reduce((sum, dump) => sum + dump.userCpuUs + dump.systemCpuUs, 0) / 1000;

    expect(totalCpuMs(run.dumps)).toBe(summed);
    expect(totalCpuMs(run.dumps)).toBeGreaterThanOrEqual((2 * SPIN_US) / 1000);
    // One process's CPU is strictly less than the total: the child's was added, not dropped.
    expect(totalCpuMs([need(parent, 'the bannering process')])).toBeLessThan(totalCpuMs(run.dumps));
  });

  it('leaves stderr byte-identical to a run without the probe, and still calls the write\'s callback', () => {
    const without = runStandIn('off');
    const inert = runStandIn('loaded-inert');

    expect(run.marks.callbackFired).toBe(true);
    expect(without.stderr.equals(run.stderr)).toBe(true);
    expect(inert.stderr.equals(run.stderr)).toBe(true);
    // The comparison can fail: the banners really are in those bytes.
    expect(run.stderr.toString('utf-8')).toContain('▶ Surface: alpha');
  });
});

describe('the perf probe, what it must not do', () => {
  it('is inert without its variable', () => {
    expect(runStandIn('loaded-inert').dumps).toEqual([]);
  });

  it('writes nothing for a script no vat package owns, or node -e', () => {
    const dir = scratchDir('lab-perf-probe-');
    for (const args of [[mainScript('npm', 'bin/npm-cli.js', '')], [mainScript(null, 'loose.js', '')], ['-e', '0']]) {
      const result = spawnSync(NODE_EXECUTABLE, args, { env: probeEnv(dir, true, safePath.join(dir, 'unused')) });
      expect(result.status, result.stderr.toString()).toBe(0);
    }

    expect(readdirSync(dir)).toEqual([]);
  });

  it('writes one record for a process that runs a worker thread, not one per thread', () => {
    const worker =
      "const { Worker } = require('node:worker_threads');" +
      String.raw`new Worker('process.stderr.write("\\n\\u25b6 Surface: from-worker\\n")', { eval: true });`;
    const script = mainScript(CLI_PACKAGE, 'dist/bin.js', worker);
    const dir = scratchDir('lab-perf-probe-');
    const result = spawnSync(NODE_EXECUTABLE, [script], { env: probeEnv(dir, true, safePath.join(dir, 'unused')) });
    expect(result.status, result.stderr.toString()).toBe(0);

    expect(dumpsIn(dir)).toHaveLength(1);
  });

  itKeepsTheProbeContract(PROBE_DIST, LOG_DIR_ENV);
});
