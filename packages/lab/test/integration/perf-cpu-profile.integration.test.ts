/**
 * `capturePerf` with `cpuProfileDir`, against the stand-in vat with the REAL
 * built perf probe: one V8 CPU profile kept per vat process per repeat, and
 * none for a node process vat is not.
 *
 * A preload supplied as the arm's own `NODE_OPTIONS` plays the part of a build
 * that runs a node child of its own (`node -e 0`, which inherits the profiler
 * flags and writes a profile, but is not vat), so the keep rule has something to
 * drop.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { capturePerf } from '../../src/facets/perf/capture.js';
import { keepRepeatProfiles, parseProfileName } from '../../src/facets/perf/cpu-profiles.js';
import { CpuProfileSchema } from '../../src/facets/perf/profile-attribution.js';
import { VALIDATE_PHASE_BUCKETS } from '../../src/facets/perf/profile-buckets.js';
import { attributeReport } from '../../src/facets/perf/profile-report.js';
import { probeSubject } from '../capture-fixtures.js';
import { cleanupProbes, probeCaptureDefaults, setupProbe } from '../command-probe.js';

import { cleanupScratch, scratchDir } from './probe-fixtures.js';

/** Temp-directory prefix, so a stray directory names this suite. */
const PREFIX = 'lab-perf-cpuprof-';

/** Numeric ascending order, for comparing pid lists. */
const byNumber = (a: number, b: number): number => a - b;

/** The emitted probe: the artifact that ships. */
const PROBE_DIST = toForwardSlash(fileURLToPath(new URL('../../dist/facets/perf/perf-probe.cjs', import.meta.url)));

let preloadPath: string;

beforeAll(() => {
  preloadPath = safePath.join(scratchDir(PREFIX), 'standin-build.cjs');
  writeFileSync(
    preloadPath,
    [
      "const childProcess = require('node:child_process');",
      "const live = process.argv.length > 1 && !process.argv.includes('--version');",
      // A node child that is not vat: it inherits NODE_OPTIONS, so it is profiled too.
      "if (live) childProcess.spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' });",
      '',
    ].join('\n'),
  );
});

afterAll(() => {
  cleanupProbes();
  cleanupScratch();
});

/**
 * One profiled capture against the stand-in vat.
 *
 * @param cpuProfileDir - Where the profiles are kept
 * @returns The report
 */
async function profiledCapture(cpuProfileDir: string): ReturnType<typeof capturePerf> {
  const probe = setupProbe(PREFIX);
  return await capturePerf({
    ...probeCaptureDefaults(probe, probeSubject(probe.cwd, 'perf-cpuprof-subject', 'd'.repeat(16)), '2026-11-21T12:00:00.000Z'),
    probePath: PROBE_DIST,
    env: { set: { NODE_OPTIONS: `--require "${preloadPath}"` }, unset: [] },
    runs: 2,
    cpuProfileDir,
  });
}

describe('capturePerf with cpuProfileDir', () => {
  it('keeps exactly one main-thread profile per vat process per repeat, and none for a node process vat is not', async () => {
    const cpuProfileDir = scratchDir(`${PREFIX}out-`);
    const report = await profiledCapture(cpuProfileDir);
    const [row] = report.body.commands;
    if (row === undefined) throw new Error('capturePerf produced no rows');

    expect(row.failed, row.failure ?? '').toBe(false);
    expect(row.processes).toHaveLength(2);
    for (const [index, records] of row.processes.entries()) {
      const directory = safePath.join(cpuProfileDir, row.name, `repeat-${String(index + 1)}`);
      const owners = readdirSync(directory).map((name) => ({ name, owner: parseProfileName(name) }));
      const mains = owners.filter(({ owner }) => owner?.tid === 0);

      // One per vat process, each named by a pid the probe recorded; the `node -e 0` child's is gone.
      expect(mains.map(({ owner }) => owner?.pid ?? -1).sort(byNumber)).toEqual(records.map((record) => record.pid).sort(byNumber));
      expect(owners.every(({ owner }) => owner !== null && records.some((record) => record.pid === owner.pid))).toBe(true);
      for (const { name } of mains) {
        expect(CpuProfileSchema.safeParse(JSON.parse(readFileSync(safePath.join(directory, name), 'utf-8'))).success).toBe(true);
      }
    }
  });

  it('attributes the kept profiles, and refuses a kept profile that is not JSON rather than throwing', async () => {
    const cpuProfileDir = scratchDir(`${PREFIX}attr-`);
    const report = await profiledCapture(cpuProfileDir);
    const [row] = report.body.commands;
    if (row === undefined) throw new Error('capturePerf produced no rows');

    const attributed = await attributeReport(report.body, cpuProfileDir, VALIDATE_PHASE_BUCKETS);
    expect(typeof attributed === 'string' ? attributed : attributed.map((command) => command.repeats)).toEqual([2]);

    const repeat = safePath.join(cpuProfileDir, row.name, 'repeat-2');
    const main = readdirSync(repeat).find((name) => parseProfileName(name)?.tid === 0);
    if (main === undefined) throw new Error('no main-thread profile kept');
    writeFileSync(safePath.join(repeat, main), '{ truncated');

    expect(await attributeReport(report.body, cpuProfileDir, VALIDATE_PHASE_BUCKETS)).toMatch(/repeat 2: '.*\.cpuprofile': cannot read it as JSON/u);
  });

  it('fails the row when --cpu-prof-dir already holds a run, rather than mixing two runs', async () => {
    const cpuProfileDir = scratchDir(`${PREFIX}reuse-`);
    expect((await profiledCapture(cpuProfileDir)).body.commands[0]?.failed).toBe(false);

    const [again] = (await profiledCapture(cpuProfileDir)).body.commands;
    expect(again?.failure).toMatch(/already holds files; give --cpu-prof-dir a fresh directory/u);
  });

  it('keeps nothing, and refuses nothing, for a repeat that ran no vat process', async () => {
    const destination = safePath.join(scratchDir(`${PREFIX}none-`), 'repeat-1');
    const emptyRepeat = scratchDir(`${PREFIX}repeat-`);

    expect(await keepRepeatProfiles(emptyRepeat, destination, [])).toEqual([]);
  });
});
