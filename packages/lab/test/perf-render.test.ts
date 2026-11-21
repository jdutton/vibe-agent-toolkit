/**
 * What a `perf` report says about CPU, surfaces and the overlap gate.
 *
 * Each assertion is paired with its negative: a gate line that printed on every
 * row would be no evidence that the gate declined on one.
 */

import { describe, expect, it } from 'vitest';

import type { ReportEnvelope } from '../src/envelope/envelope.js';
import { renderPerfReport } from '../src/facets/perf/render.js';
import { GateDeclinedBySchema, PERF_FACET, type PerfBody, type PerfCommandStats } from '../src/facets/perf/types.js';

import { NO_PROBE_DATA } from './perf-fixtures.js';
import { CLEAN_LOAD, makeReport } from './report-fixtures.js';

const STATS = { medianMs: 5, minMs: 4, maxMs: 6, iqrMs: 1 };

/**
 * A completed row, defaulting what a case ignores.
 *
 * @param over - Fields to replace
 * @returns A complete row
 */
function row(over: Partial<PerfCommandStats> = {}): PerfCommandStats {
  return {
    name: 'validate',
    args: ['validate'],
    cache: 'warm',
    runs: 3,
    ...STATS,
    medianMs: 1000,
    samplesMs: [1000, 1000, 1000],
    exitCode: 0,
    failed: false,
    failure: null,
    ...NO_PROBE_DATA,
    ...over,
  };
}

/**
 * Render one-row reports.
 *
 * @param over - The row's fields
 * @returns The rendered text
 */
function render(over: Partial<PerfCommandStats>): string {
  const report = makeReport({ facet: PERF_FACET, body: { commands: [row(over)], load: CLEAN_LOAD } }) as ReportEnvelope<PerfBody>;
  return renderPerfReport(report);
}

describe('renderPerfReport, the probe fields', () => {
  it('says CPU was not measured, not zero, when no process wrote a record', () => {
    expect(render({})).toContain('CPU: NOT MEASURED');
  });

  it('shows CPU with its spread and the process count, and each surface', () => {
    const text = render({
      cpuMs: STATS,
      processes: [[], []].map(() => [
        { pid: 1, ppid: 0, startMs: 0, endMs: 1, userCpuUs: 1, systemCpuUs: 1, banners: [] },
        { pid: 2, ppid: 1, startMs: 0, endMs: 1, userCpuUs: 1, systemCpuUs: 1, banners: [] },
      ]),
      surfaces: { resources: STATS, checks: { ...STATS, medianMs: 9 } },
    });

    expect(text).toContain('CPU: 5.0ms median');
    expect(text).toContain('summed over 2 vat process(es)');
    expect(text).toContain('surface resources: 5.0ms median');
    expect(text).toContain('surface checks: 9.0ms median');
  });

  it('puts a declined gate, with its member and route, before any timing', () => {
    const text = render({ checksOverlapped: 0, gateDeclinedBy: { condition: 'member', member: 'docs/a.md', route: 'readRoute' } });

    expect(text).toContain('GATE DID NOT FIRE: validate (warm)');
    expect(text.indexOf('GATE DID NOT FIRE')).toBeLessThan(text.indexOf('1000.0ms median'));
    expect(text).toContain('member (member docs/a.md, route readRoute)');
  });

  it('shows the error a rejected gate carried beside its condition, as the dump states it', () => {
    const declined = GateDeclinedBySchema.parse({ condition: 'rejected', error: 'the blob tier could not be read' });
    const text = render({ checksOverlapped: 0, gateDeclinedBy: declined });

    expect(text).toContain('rejected (error: the blob tier could not be read)');
    expect(render({ checksOverlapped: 0, gateDeclinedBy: { condition: 'limits' } })).not.toContain('error:');
  });

  it('says an overlapped run overlapped, with no gate line, and an unknown one is unknown', () => {
    const overlapped = render({ checksOverlapped: 1 });
    const unknown = render({});

    expect(overlapped).toContain('checks child: overlapped');
    expect(overlapped).not.toContain('GATE DID NOT FIRE');
    expect(unknown).toContain('checks child: unknown');
    expect(unknown).not.toContain('GATE DID NOT FIRE');
  });
});

describe('GateDeclinedBySchema', () => {
  it('accepts exactly the shapes the cli writes', () => {
    for (const condition of ['debug', 'cores', 'not-hit', 'limits', 'disarmed', 'not-settled'] as const) {
      expect(GateDeclinedBySchema.safeParse({ condition }).success).toBe(true);
    }
    expect(GateDeclinedBySchema.safeParse({ condition: 'rejected', error: 'EMFILE' }).success).toBe(true);
    expect(GateDeclinedBySchema.safeParse({ condition: 'member', member: 'docs/a.md', route: 'storedRoute' }).success).toBe(true);
  });

  it('refuses a condition the cli never writes, and fields on a condition that never carries them', () => {
    for (const declined of [
      { condition: 'hydration' },
      { condition: 'debug', member: 'docs/a.md' },
      { condition: 'cores', error: 'EMFILE' },
      { condition: 'rejected' },
      { condition: 'member', member: 'docs/a.md' },
      { condition: 'member', member: 'docs/a.md', route: 'compute' },
      { condition: 'member', member: 'docs/a.md', route: 'readRoute', error: 'EMFILE' },
    ]) {
      expect(GateDeclinedBySchema.safeParse(declined).success, JSON.stringify(declined)).toBe(false);
    }
  });
});
