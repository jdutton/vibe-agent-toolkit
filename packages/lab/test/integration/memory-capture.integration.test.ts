/**
 * `captureMemory` against the stand-in vat, with the REAL built RSS probe
 * loaded through the production `NODE_OPTIONS` contract.
 *
 * The stand-in allocates nothing itself, so a second preload — supplied as the
 * arm's own `NODE_OPTIONS` — makes it hold a chosen amount. That one fixture
 * proves two things at once: the peak follows the allocation (two captures, two
 * sizes, a gap the size of the difference), and the arm's `NODE_OPTIONS` was
 * APPENDED to rather than replaced, because a replaced one would leave both
 * captures at a bare node's size.
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

beforeAll(() => {
  const dir = mkdtempSync(safePath.join(normalizedTmpdir(), PREFIX));
  scratch.push(dir);
  allocPath = safePath.join(dir, 'alloc.cjs');
  writeFileSync(allocPath, `globalThis.kept = Buffer.alloc(Number(process.env.${ALLOC_ENV} ?? 0) * 1024 * 1024, 1);\n`);
  silentPath = safePath.join(dir, 'silent.cjs');
  writeFileSync(silentPath, '\n');
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
  it('reports a peak that follows what the measured process held', async () => {
    const small = await capture(setupProbe(PREFIX), 32);
    const large = await capture(setupProbe(PREFIX), 320);
    const smallRow = onlyRow(small);
    const largeRow = onlyRow(large);

    expect(small.facet).toBe(MEMORY_FACET);
    expectBodyMatchesSchema(MemoryBodySchema, small.body);
    expect(smallRow.failed).toBe(false);
    expect(smallRow.samplesKb).toHaveLength(3);
    expect(smallRow.processesPerRepeat).toEqual([1, 1, 1]);
    expect(largeRow.minKb).toBeGreaterThan(320 * MIB_KB);
    // The gap is the allocation difference, give or take what node itself moved.
    expect(largeRow.medianKb - smallRow.medianKb).toBeGreaterThan(250 * MIB_KB);
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
  });

  it('throws naming the build command rather than measuring uninstrumented', async () => {
    const probe = setupProbe(PREFIX);
    const missing = safePath.join(probe.cwd, 'no-probe.cjs');

    await expect(capture(probe, 1, { probePath: missing, runs: 1 })).rejects.toThrow(
      /bunx tsc --build packages\/lab\/tsconfig\.json/,
    );
  });
});
