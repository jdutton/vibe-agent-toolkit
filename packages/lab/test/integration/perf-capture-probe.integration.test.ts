/**
 * `capturePerf` against the stand-in vat, with the REAL built perf probe loaded
 * through the production `NODE_OPTIONS` contract: what a row says about CPU,
 * surfaces and whether the checks child overlapped.
 *
 * A preload supplied as the arm's own `NODE_OPTIONS` plays the part of a build:
 * at exit (the probe is appended behind it, so it has wrapped stderr by then;
 * the stand-in vat ends the process synchronously, so a timer would never fire) it writes two surface banners a known pause apart and,
 * when asked, a debug-facts dump into the directory `VAT_VALIDATE_DEBUG_FACTS`
 * names, as `writeTimingDump` lays one out. Asking for nothing is main: no dump.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ReportEnvelope } from '../../src/envelope/envelope.js';
import { capturePerf, type CapturePerfOptions } from '../../src/facets/perf/capture.js';
import { type PerfBody, PerfBodySchema, type PerfCommandStats } from '../../src/facets/perf/types.js';
import { expectBodyMatchesSchema, probeSubject } from '../capture-fixtures.js';
import { cleanupProbes, probeCaptureDefaults, setupProbe, type Probe } from '../command-probe.js';

import { cleanupScratch, scratchDir } from './probe-fixtures.js';

/** Temp-directory prefix, so a stray directory names this suite. */
const PREFIX = 'lab-perf-facts-';

/** The caller owns the clock. */
const CAPTURED_AT = '2026-11-02T12:00:00.000Z';

/** The emitted probe: the artifact that ships. */
const PROBE_DIST = toForwardSlash(fileURLToPath(new URL('../../dist/facets/perf/perf-probe.cjs', import.meta.url)));

/** What the preload writes as the debug-facts dump, as JSON; absent means "write none". */
const FACTS_ENV = 'LAB_STANDIN_FACTS';

/** Pause the preload takes between its two banners, in milliseconds. */
const SURFACE_GAP_MS = 100;

/** The debug-facts file name the stand-in's build chooses; the reader must not depend on it. */
const FACTS_FILE = 'a-build-chosen-name-1234.json';

/** An overlapped run's facts. */
const OVERLAPPED = {
  checksOverlapped: 1,
  gateDeclinedBy: null,
  childStderrBytesAtTurn: 0,
  parentStoreWritesUntilChildExit: 0,
  parentParseCacheWritesUntilChildExit: 0,
};

let preloadPath: string;

beforeAll(() => {
  preloadPath = safePath.join(scratchDir(PREFIX), 'standin-build.cjs');
  writeFileSync(
    preloadPath,
    [
      "const fs = require('node:fs'); const path = require('node:path');",
      "const live = process.argv.length > 1 && !process.argv.includes('--version');",
      // At exit, because the stand-in vat ends the process synchronously: a timer would never fire.
      "if (live) process.on('exit', () => {",
      String.raw`  process.stderr.write('\n\u25b6 Surface: first\n');`,
      `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${String(SURFACE_GAP_MS)});`,
      String.raw`  process.stderr.write('\n\u25b6 Surface: second\n');`,
      '});',
      `const facts = process.env.${FACTS_ENV};`,
      "const dir = process.env.VAT_VALIDATE_DEBUG_FACTS;",
      "if (live && facts !== undefined && dir !== undefined) process.on('exit', () => {",
      "  fs.mkdirSync(dir, { recursive: true });",
      `  fs.writeFileSync(path.join(dir, ${JSON.stringify(FACTS_FILE)}), facts);`,
      '});',
      '',
    ].join('\n'),
  );
});

afterAll(() => {
  cleanupProbes();
  cleanupScratch();
});

/**
 * Capture against a stand-in build that writes `facts` (or none).
 *
 * @param probe - Supplies the instrument and subject path
 * @param facts - The debug-facts JSON the build writes, or `undefined` for a build that writes none
 * @param overrides - What the case varies
 * @returns The report
 */
function capture(probe: Probe, facts: unknown, overrides: Partial<CapturePerfOptions> = {}): Promise<ReportEnvelope<PerfBody>> {
  const set: Record<string, string> = { NODE_OPTIONS: `--require "${preloadPath}"` };
  if (facts !== undefined) set[FACTS_ENV] = typeof facts === 'string' ? facts : JSON.stringify(facts);
  return capturePerf({
    ...probeCaptureDefaults(probe, probeSubject(probe.cwd, 'perf-facts-subject', 'c'.repeat(16)), CAPTURED_AT),
    probePath: PROBE_DIST,
    env: { set, unset: [] },
    ...overrides,
  });
}

/**
 * The single row of a one-command capture.
 *
 * @param report - A one-command report
 * @returns Its row
 */
function onlyRow(report: ReportEnvelope<PerfBody>): PerfCommandStats {
  const [row] = report.body.commands;
  if (row === undefined) throw new Error('capturePerf produced no rows');
  return row;
}

describe('capturePerf with the probe', () => {
  it('reports CPU over the vat processes, and per-surface wall from the banners it observed', async () => {
    const report = await capture(setupProbe(PREFIX), undefined, { runs: 3 });
    const row = onlyRow(report);

    expectBodyMatchesSchema(PerfBodySchema, report.body);
    expect(row.failed, row.failure ?? '').toBe(false);
    expect(row.processes.map((repeat) => repeat.length)).toEqual([1, 1, 1]);
    expect(row.cpuMs?.minMs ?? -1).toBeGreaterThanOrEqual(0);
    expect(Object.keys(row.surfaces)).toEqual(['first', 'second']);
    // `first` ends where `second` begins, and the build paused between them.
    expect(row.surfaces['first']?.minMs ?? 0).toBeGreaterThanOrEqual(SURFACE_GAP_MS - 1);
    // `second` runs to the process's exit, so it is not the interval to a next banner.
    expect(row.surfaces['second']?.minMs ?? -1).toBeGreaterThanOrEqual(0);
  });

  it('says whether the checks child overlapped, as the build said, whatever file name it chose', async () => {
    const row = onlyRow(await capture(setupProbe(PREFIX), OVERLAPPED, { runs: 2 }));

    expect(row.failed, row.failure ?? '').toBe(false);
    expect(row.checksOverlapped).toBe(1);
    expect(row.gateDeclinedBy).toBeNull();
  });

  it('names the member and route that declined the gate when the build says 0', async () => {
    // As the cli's gate words a member decline: the member, and which of admission's routes computed.
    const declined = { condition: 'member', member: 'docs/a.md', route: 'readRoute' };
    const row = onlyRow(await capture(setupProbe(PREFIX), { ...OVERLAPPED, checksOverlapped: 0, gateDeclinedBy: declined }, { runs: 2 }));

    expect(row.failed, row.failure ?? '').toBe(false);
    expect(row.checksOverlapped).toBe(0);
    expect(row.gateDeclinedBy).toEqual(declined);
  });

  it('says the mode is unknown, not 0, for a build that writes no debug facts', async () => {
    const row = onlyRow(await capture(setupProbe(PREFIX), undefined, { runs: 2 }));

    expect(row.failed, row.failure ?? '').toBe(false);
    expect(row.checksOverlapped).toBeNull();
    expect(row.gateDeclinedBy).toBeNull();
  });

  it('refuses a debug-facts dump this lab does not model, naming the dump', async () => {
    const row = onlyRow(await capture(setupProbe(PREFIX), { checksOverlapped: 2 }, { runs: 1 }));

    expect(row.failed).toBe(true);
    expect(row.failure).toContain('validate debug-facts dump');
    expect(row.checksOverlapped).toBeNull();
  });
});
