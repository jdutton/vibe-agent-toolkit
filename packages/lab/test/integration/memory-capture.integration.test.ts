/**
 * `captureMemory` against the stand-in vat, with the REAL built RSS probe
 * loaded through the production `NODE_OPTIONS` contract.
 *
 * The stand-in allocates nothing itself, so a second preload — supplied as the
 * arm's own `NODE_OPTIONS` — makes it hold a chosen amount. That one fixture
 * proves two things at once: the peak follows the allocation (a capture against
 * a no-allocation baseline, a gap the size of the allocation), and the arm's
 * `NODE_OPTIONS` was APPENDED to rather than replaced, because a replaced one
 * would leave both captures at a bare node's size. Never an absolute bound: a
 * bare node's footprint differs by platform, so only a difference says what the
 * child held.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ReportEnvelope } from '../../src/envelope/envelope.js';
import { captureMemory, type CaptureMemoryOptions } from '../../src/facets/memory/capture.js';
import { MEMORY_FACET, type MemoryBody, MemoryBodySchema, type MemoryCommandStats } from '../../src/facets/memory/types.js';
import { expectBodyMatchesSchema, probeSubject } from '../capture-fixtures.js';
import { cleanupProbes, PROBE_FAILS, probeCaptureDefaults, setupProbe, type Probe } from '../command-probe.js';

/** Temp-directory prefix, so a stray directory names this suite. */
const PREFIX = 'lab-memory-capture-';

/** The caller owns the clock. */
const CAPTURED_AT = '2026-11-02T12:00:00.000Z';

/** The emitted probe — the artifact that ships. */
const PROBE_DIST = toForwardSlash(fileURLToPath(new URL('../../dist/facets/memory/rss-probe.cjs', import.meta.url)));

/** How many MiB the allocating preload holds. */
const ALLOC_ENV = 'LAB_MEMORY_ALLOC_MIB';

/** Kilobytes in a mebibyte. */
const MIB_KB = 1024;

const scratch: string[] = [];

/** A preload that allocates and fills `LAB_MEMORY_ALLOC_MIB` MiB and keeps it. */
let allocPath: string;

/** A preload that loads and writes nothing — a probe that never reached the process. */
let silentPath: string;

/** A preload that grows the V8 heap until V8 aborts the process. */
let exhaustPath: string;

beforeAll(() => {
  const dir = mkdtempSync(safePath.join(normalizedTmpdir(), PREFIX));
  scratch.push(dir);
  allocPath = safePath.join(dir, 'alloc.cjs');
  writeFileSync(allocPath, `globalThis.kept = Buffer.alloc(Number(process.env.${ALLOC_ENV} ?? 0) * 1024 * 1024, 1);\n`);
  silentPath = safePath.join(dir, 'silent.cjs');
  writeFileSync(silentPath, '\n');
  exhaustPath = safePath.join(dir, 'exhaust.cjs');
  // Only in a measured run (the probe's directory is set): the build's untimed start must succeed.
  writeFileSync(exhaustPath, 'if (process.env.VAT_LAB_RSS_LOG) { const kept = []; for (;;) kept.push(new Array(1e5).fill(1)); }\n');
});

afterAll(() => {
  cleanupProbes();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/**
 * Capture against a probe whose children hold `mib` MiB.
 *
 * @param probe - Supplies the instrument and subject path
 * @param mib - What the allocating preload holds
 * @param overrides - What the case varies
 * @returns The report
 */
function capture(probe: Probe, mib: number, overrides: Partial<CaptureMemoryOptions> = {}): Promise<ReportEnvelope<MemoryBody>> {
  return captureMemory({
    ...probeCaptureDefaults(probe, probeSubject(probe.cwd, 'memory-probe-subject', 'b'.repeat(16)), CAPTURED_AT),
    probePath: PROBE_DIST,
    env: { set: { NODE_OPTIONS: `--require "${allocPath}"`, [ALLOC_ENV]: String(mib) }, unset: [] },
    ...overrides,
  });
}

/**
 * The single row of a one-command capture.
 *
 * @param report - A one-command report
 * @returns Its row
 */
function onlyRow(report: ReportEnvelope<MemoryBody>): MemoryCommandStats {
  const [row] = report.body.commands;
  if (row === undefined) throw new Error('captureMemory produced no rows');
  return row;
}

describe('captureMemory', () => {
  it('reports a peak that follows what the measured process held, above a no-allocation baseline', async () => {
    const baseline = await capture(setupProbe(PREFIX), 0);
    const large = await capture(setupProbe(PREFIX), 320);
    const baselineRow = onlyRow(baseline);
    const largeRow = onlyRow(large);

    expect(baseline.facet).toBe(MEMORY_FACET);
    expectBodyMatchesSchema(MemoryBodySchema, baseline.body);
    expect(baselineRow.failed, baselineRow.failure ?? '').toBe(false);
    expect(baselineRow.samplesKb).toHaveLength(3);
    expect(baselineRow.processesPerRepeat).toEqual([1, 1, 1]);
    // The gap is the allocation, give or take what node itself moved — and the
    // SMALLEST allocating repeat clears the LARGEST baseline one.
    expect(largeRow.medianKb - baselineRow.medianKb).toBeGreaterThan(290 * MIB_KB);
    expect(largeRow.minKb - baselineRow.maxKb).toBeGreaterThan(250 * MIB_KB);
  });

  it('marks the row failed, with the probe named, when no repeat left a peak', async () => {
    const row = onlyRow(await capture(setupProbe(PREFIX), 1, { probePath: silentPath, runs: 1 }));

    expect(row.failed).toBe(true);
    expect(row.failure).toContain('no RSS dumps');
    expect(row.samplesKb).toEqual([]);
  });

  it('marks the row failed, and records no peak, when the command failed', async () => {
    const row = onlyRow(await capture(setupProbe(PREFIX), 1, { commands: [PROBE_FAILS], runs: 1 }));

    expect(row.failed).toBe(true);
    expect(row.medianKb).toBe(0);
    expect(row.exitCode).toBeNull();
    expect(row.outOfHeap).toBe(false);
  });

  it('marks a row whose vat ran out of heap as out of heap, not merely failed', async () => {
    const env = { set: { NODE_OPTIONS: `--max-old-space-size=16 --require "${exhaustPath}"` }, unset: [] };
    const row = onlyRow(await capture(setupProbe(PREFIX), 0, { env, runs: 1 }));

    expect(row.failed).toBe(true);
    expect(row.outOfHeap).toBe(true);
  });

  it("records the arm's NODE_OPTIONS in the host, without the facet's own probe", async () => {
    const report = await capture(setupProbe(PREFIX), 0, { runs: 1 });

    expect(report.host.nodeOptions).toBe(`--require "${allocPath}"`);
  });

  it('throws naming the build command rather than measuring uninstrumented', async () => {
    const probe = setupProbe(PREFIX);
    const missing = safePath.join(probe.cwd, 'no-probe.cjs');

    await expect(capture(probe, 1, { probePath: missing, runs: 1 })).rejects.toThrow(
      /bunx tsc --build packages\/lab\/tsconfig\.json/,
    );
  });
});
