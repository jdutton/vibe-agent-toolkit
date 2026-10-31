/**
 * An arms report says what it measured: per alias, the instrument as the
 * operator named it and what it resolved to, and the machine load the arms
 * ran under — so a bar read later can tell which bytes it judged.
 *
 * Integration-tier: the arms spawn the shared probe.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { captureArms } from '../../src/facets/perf/arms.js';
import { cleanupProbes, probeArmsRoot, probeStep, setupProbe } from '../command-probe.js';

afterAll(cleanupProbes);

describe('captureArms provenance', () => {
  it('records every build: its coordinate as given, its resolved version, and the load reading', async () => {
    const probe = setupProbe('lab-perf-arms-provenance-');
    const source = { kind: 'dist', path: '/builds/old' } as const;

    const report = await captureArms({
      armsRoot: probeArmsRoot(probe),
      cwd: probe.cwd,
      builds: [{ alias: 'old', source, instrument: probe.instrument }],
      arms: [{ build: 'old', arm: 'A', state: 'cold', steps: [probeStep(['a'])] }],
      rounds: 1,
      env: { set: {}, unset: [] },
    });

    expect(report.builds).toEqual([{ alias: 'old', source, instrument: probe.instrument.version }]);
    expect(report.load.cpus).toBeGreaterThanOrEqual(1);
    expect(typeof report.load.available).toBe('boolean');
  });
});
