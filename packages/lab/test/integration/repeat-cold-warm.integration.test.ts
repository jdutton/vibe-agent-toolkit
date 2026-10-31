/**
 * Cold and warm repetitions of one arm: what each repeat starts from.
 *
 * 1. **Cold means cold on EVERY repeat, by deleting the arm's own store.** The
 *    probe records whether the store existed when it started, so "the store was
 *    reset before each cold repeat" and "it was reset once" are different logs.
 *    The lab never runs `vat cache clear`: the probe's argv log shows no such child.
 * 2. **Warm means one exit-checked priming run, then measured repeats.**
 * 3. **The arm's home is empty at the start of every sequence.**
 *
 * No vat binary is spawned. The instrument is `node <probe.cjs>` from
 * `command-probe.ts`, a stand-in that logs its argv and environment into its
 * working directory.
 *
 * Integration-tier: every case spawns real child processes.
 */

import { everywhere, pathPresent } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { runRepeats } from '../../src/harness/repeat.js';
import {
  argsOf,
  cleanupProbes,
  PROBE_POPULATE_ENV,
  probeSpec,
  setupProbe,
} from '../command-probe.js';

afterAll(cleanupProbes);
afterEach(() => {
  vi.unstubAllEnvs();
});

/** Temp-directory prefix, so a stray directory names this suite. */
const PREFIX = 'lab-repeat-';

describe('runRepeats — cold and warm', () => {
  it('primes a warm arm once, exit-checked, then runs one measured sequence per repeat', async () => {
    const probe = setupProbe(PREFIX);

    const run = await runRepeats(probeSpec(probe, { runs: 3 }));

    expect(run.priming?.violation).toBeNull();
    expect(run.results).toHaveLength(3);
    expect(run.results.every((sequenceRun) => sequenceRun.violation === null && sequenceRun.exitCode === 0)).toBe(true);
    expect(argsOf(probe.entries())).toEqual([['audit'], ['audit'], ['audit'], ['audit']]);
  });

  it('deletes the store before EVERY cold repeat, and never runs vat cache clear', async () => {
    const probe = setupProbe(PREFIX);

    await runRepeats(probeSpec(probe, { runs: 3, cache: 'cold', env: { [PROBE_POPULATE_ENV]: '1' } }));

    // Each repeat writes a store; a reset hoisted out of the loop shows `true` from the second on.
    expect(probe.entries().map((entry) => entry.storeExisted)).toEqual([false, false, false]);
    expect(argsOf(probe.entries())).toEqual([['audit'], ['audit'], ['audit']]);
  });

  it('keeps a warm store between measured repeats', async () => {
    const probe = setupProbe(PREFIX);

    await runRepeats(probeSpec(probe, { runs: 2, env: { [PROBE_POPULATE_ENV]: '1' } }));

    expect(probe.entries().map((entry) => entry.storeExisted)).toEqual([false, true, true]);
  });

  it('hands every sequence an EMPTY home, whatever the previous one left there', async () => {
    const probe = setupProbe(PREFIX);

    await runRepeats(probeSpec(probe, { runs: 2, cache: 'cold' }));

    // The probe writes into the arm home on every run, so only a reset reads 0 twice.
    expect(probe.entries().map((entry) => entry.homeEntries)).toEqual([0, 0]);
  });

  it('spawns nothing and creates nothing when no repeats were requested, even cold', async () => {
    const probe = setupProbe(PREFIX);
    const spec = probeSpec(probe, { runs: 0, cache: 'cold' });

    const run = await runRepeats(spec);

    expect(run.results).toEqual([]);
    expect(probe.entries()).toEqual([]);
    expect(pathPresent(probe.out, 'entry', everywhere('destination'), 'confirmed')).toBe(false);
  });
});
