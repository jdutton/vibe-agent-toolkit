/**
 * The cold and warm rules a repetition is judged by, and interleaving arms by round.
 *
 * Cold: the first populating step must leave the store and a parse shard.
 * Warm: the priming run must leave both, and every measured repetition's
 * document must report the population it was served from.
 *
 * No vat binary is spawned. The instrument is `node <probe.cjs>` from
 * `command-probe.ts`, a stand-in that logs its argv and environment into its
 * working directory.
 *
 * Integration-tier: every case spawns real child processes.
 */

import { rmSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { runInterleaved, runRepeats } from '../../src/harness/repeat.js';
import {
  argsOf,
  cleanupProbes,
  PROBE_POPULATE_EMPTY_SHARD_DIR,
  PROBE_POPULATE_ENV,
  PROBE_POPULATE_STORE_ONLY,
  PROBE_STDOUT_ENV,
  probeSpec,
  probeStep,
  setupProbe,
} from '../command-probe.js';

afterAll(cleanupProbes);
afterEach(() => {
  vi.unstubAllEnvs();
});

/** Temp-directory prefix, so a stray directory names this suite. */
const PREFIX = 'lab-repeat-';

describe('runRepeats — the cold rule after the first step', () => {
  const populating = probeStep(['audit'], { populates: true });

  it('passes when the first step leaves a store and a shard in the build-resolved parse directory', async () => {
    const probe = setupProbe(PREFIX);
    const run = await runRepeats(
      probeSpec(probe, { runs: 2, cache: 'cold', steps: [populating], env: { [PROBE_POPULATE_ENV]: '1' } }),
    );
    expect(run.results.map((sequenceRun) => sequenceRun.violation)).toEqual([null, null]);
  });

  it('fails a populating step that leaves the store and parse directory empty', async () => {
    const probe = setupProbe(PREFIX);
    const run = await runRepeats(probeSpec(probe, { runs: 1, cache: 'cold', steps: [populating] }));
    expect(run.results[0]?.violation).toMatch(/^cold rule: after step 'audit' the store .* is empty/);
  });

  it.for([
    ['writes the store and no parse directory at all', PROBE_POPULATE_STORE_ONLY],
    ['writes the store and a parse directory holding only an empty subdirectory', PROBE_POPULATE_EMPTY_SHARD_DIR],
  ])('fails a populating step that %s', async ([, populate]) => {
    const probe = setupProbe(PREFIX);
    const env = { [PROBE_POPULATE_ENV]: populate };
    const run = await runRepeats(probeSpec(probe, { runs: 1, cache: 'cold', steps: [populating], env }));
    expect(run.results[0]?.violation).toMatch(/^cold rule: after step 'audit' the build's parse directory '.*' holds no shard$/u);
  });

  it('refuses the arm before any run when the build cannot say where its parse directory is, rather than guessing', async () => {
    const probe = setupProbe(PREFIX);
    // The probe build's stand-in resources package is gone: its parse directory is unresolvable.
    rmSync(safePath.join(probe.cwd, 'node_modules'), { recursive: true });
    const env = { [PROBE_POPULATE_ENV]: '1' };
    await expect(runRepeats(probeSpec(probe, { runs: 1, cache: 'cold', steps: [populating], env }))).rejects.toThrow(
      /^arm '.*': the build at '.*' does not resolve @vibe-agent-toolkit\/resources/u,
    );
    // Refused whole: not one child ran.
    expect(probe.entries()).toEqual([]);
  });

  it('fails a warm priming run that leaves the caches empty', async () => {
    const probe = setupProbe(PREFIX);
    const run = await runRepeats(probeSpec(probe, { runs: 1, steps: [populating] }));
    expect(run.priming?.violation).toMatch(/^priming run: warm rule: after priming the store .* is empty/);
  });
});

describe('runRepeats — the warm rule on every measured repetition', () => {
  const STORE = JSON.stringify({ status: 'success', examined: 1, findings: [], summary: {}, data: { population: 'store' } });
  const ABSENT = JSON.stringify({ status: 'success', examined: 1, findings: [], summary: {}, data: {} });
  const check = probeStep(['check'], { provenance: 'resources-check' });

  it('records the provenance and passes a repetition served from the store', async () => {
    const probe = setupProbe(PREFIX);
    const run = await runRepeats(probeSpec(probe, { runs: 1, steps: [check], env: { [PROBE_STDOUT_ENV]: JSON.stringify([STORE]) } }));
    expect(run.results[0]?.violation).toBeNull();
    expect(run.results[0]?.steps[0]?.provenance).toEqual({ resources: 'store', checks: null, lens: null });
  });

  it('fails a repetition whose document carries no population', async () => {
    const probe = setupProbe(PREFIX);
    const run = await runRepeats(probeSpec(probe, { runs: 1, steps: [check], env: { [PROBE_STDOUT_ENV]: JSON.stringify([ABSENT]) } }));
    expect(run.results[0]?.violation).toMatch(/absent is never a pass/);
  });

});

describe('runInterleaved', () => {
  it('primes every warm arm, then runs one repetition of each arm per round', async () => {
    const probe = setupProbe(PREFIX);
    const x = probeSpec(probe, { args: ['x'], arm: 'x' });
    const y = probeSpec(probe, { args: ['y'], arm: 'y' });

    const runs = await runInterleaved([x, y], 2);

    expect(runs.map((run) => run.results.length)).toEqual([2, 2]);
    expect(argsOf(probe.entries())).toEqual([['x'], ['y'], ['x'], ['y'], ['x'], ['y']]);
  });

  it('refuses two arms that would share directories', async () => {
    const probe = setupProbe(PREFIX);
    const x = probeSpec(probe, { args: ['x'], arm: 'x' });
    await expect(runInterleaved([x, x], 1)).rejects.toThrow(/share/);
  });

  it('refuses two arms whose directories differ only in case — one directory on a case-insensitive disk', async () => {
    const probe = setupProbe(PREFIX);
    const lower = probeSpec(probe, { args: ['x'], arm: 'x' });
    const upper = probeSpec(probe, { args: ['x'], arm: 'X' });
    await expect(runInterleaved([lower, upper], 1)).rejects.toThrow(/share/);
    // …and nothing ran: the refusal comes before any arm's first step.
    expect(probe.entries()).toEqual([]);
  });
});
