/**
 * One repetition as a SEQUENCE of steps: which environment each kind of step starts from, which steps are timed, and where a sequence stops.
 *
 * A VAT step starts from the developer's environment cleared of VAT, git and
 * claude state; a tool step from it minus `VAT_*` only. A sequence stops at
 * the first non-zero exit, as CI does — a violation when the exit was not the
 * step's committed one, a completed sequence when it was.
 *
 * No vat binary is spawned. The instrument is `node <probe.cjs>` from
 * `command-probe.ts`, a stand-in that logs its argv and environment into its
 * working directory.
 *
 * Integration-tier: every case spawns real child processes.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { armDirectories } from '../../src/harness/arm-dirs.js';
import { runRepeats } from '../../src/harness/repeat.js';
import {
  argsOf,
  cleanupProbes,
  PROBE_ECHO_ENV,
  PROBE_EXIT_CODE_ENV,
  PROBE_FAIL_EXIT,
  PROBE_FAIL_TOKEN,
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

describe('runRepeats — sequences', () => {
  it("starts a VAT step from the developer's environment minus VAT_*, git and claude state, and records what it removed", async () => {
    const probe = setupProbe(PREFIX);
    const developerConfig = safePath.join(probe.cwd, 'developer-config');
    vi.stubEnv('VAT_PROJECTION_STORE', 'off');
    vi.stubEnv('XDG_CONFIG_HOME', developerConfig);
    vi.stubEnv('CLAUDE_CONFIG_DIR', safePath.join(probe.cwd, 'developer-claude'));
    vi.stubEnv('GIT_CONFIG_GLOBAL', safePath.join(probe.cwd, 'developer-gitconfig'));
    const echoed = ['VAT_PROJECTION_STORE', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'CLAUDE_CONFIG_DIR', 'HOME', 'TMPDIR', 'VAT_PROJECTION_STORE_DIR', 'PATH'];

    const spec = probeSpec(probe, { runs: 1, cache: 'cold', env: { [PROBE_ECHO_ENV]: echoed.join(',') } });
    const run = await runRepeats(spec);

    const dirs = armDirectories(spec.arm);
    const seen = JSON.parse(run.results[0]?.steps[0]?.stdout ?? '{}') as Record<string, string | null>;
    expect(seen).toMatchObject({
      VAT_PROJECTION_STORE: null,
      XDG_CONFIG_HOME: null,
      GIT_CONFIG_GLOBAL: null,
      CLAUDE_CONFIG_DIR: dirs.home,
      HOME: dirs.home,
      TMPDIR: dirs.tmp,
      VAT_PROJECTION_STORE_DIR: dirs.store,
    });
    expect(seen['PATH']).toBe(process.env['PATH']); // positive control
    expect(run.removed).toEqual(expect.arrayContaining(['VAT_PROJECTION_STORE', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL']));
    expect(run.removed).not.toContain('CLAUDE_CONFIG_DIR'); // pointed, not removed
  });

  it("runs a non-VAT step in the developer's environment minus VAT_* only", async () => {
    const probe = setupProbe(PREFIX);
    const developerConfig = safePath.join(probe.cwd, 'developer-config');
    vi.stubEnv('VAT_PROJECTION_STORE', 'off');
    vi.stubEnv('XDG_CONFIG_HOME', developerConfig);
    const tool = probeStep(['tool'], {
      command: { kind: 'tool', command: process.execPath, args: [...probe.instrument.leadingArgs, 'tool'] },
      timed: false,
    });

    // Asked through the developer's own environment: a tool step inherits it.
    vi.stubEnv(PROBE_ECHO_ENV, 'VAT_PROJECTION_STORE,XDG_CONFIG_HOME');

    const run = await runRepeats(probeSpec(probe, { runs: 1, cache: 'cold', steps: [tool] }));

    expect(run.results[0]?.violation).toBeNull();
    expect(JSON.parse(run.results[0]?.steps[0]?.stdout ?? '{}')).toEqual({
      VAT_PROJECTION_STORE: null,
      XDG_CONFIG_HOME: developerConfig,
    });
  });

  it('times only the timed steps, records every step, and stops at the first non-zero exit as CI does', async () => {
    const probe = setupProbe(PREFIX);
    const steps = [
      probeStep(['untimed'], { timed: false }),
      probeStep(['timed']),
      probeStep([PROBE_FAIL_TOKEN]),
      probeStep(['never']),
    ];

    const run = await runRepeats(probeSpec(probe, { runs: 1, cache: 'cold', steps }));
    const [only] = run.results;

    expect(only?.steps.map((step) => step.name)).toEqual(['untimed', 'timed', 'boom']);
    expect(only?.wallMs).toBe((only?.steps[1]?.wallMs ?? 0) + (only?.steps[2]?.wallMs ?? 0));
    expect(only?.exitCode).toBe(PROBE_FAIL_EXIT);
    expect(only?.violation).toMatch(/^step 'boom' exited 3/);
    expect(argsOf(probe.entries())).toEqual([['untimed'], ['timed'], ['boom']]);
  });

  it('ends a sequence as COMPLETED when an early step exits non-zero with its committed exit, running nothing after it, as CI does', async () => {
    const probe = setupProbe(PREFIX);
    const steps = [probeStep([PROBE_FAIL_TOKEN], { expectedExits: [0, 1] }), probeStep(['after'])];

    const run = await runRepeats(probeSpec(probe, { runs: 1, cache: 'cold', steps, env: { [PROBE_EXIT_CODE_ENV]: '1' } }));

    expect(run.results[0]?.exitCode).toBe(1);
    expect(run.results[0]?.violation).toBeNull();
    expect(argsOf(probe.entries())).toEqual([['boom']]);
  });
});
