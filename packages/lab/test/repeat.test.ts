/**
 * The repeat runner is shared by every measurement facet, so a mistake here is a
 * wrong number in every report — the same stake `run.test.ts` opens with, one
 * level up.
 *
 * A repetition is a SEQUENCE of steps run in its own arm: its own store, `TMPDIR`
 * and home, from an environment cleared of the developer's VAT, git and claude
 * state. The properties that carry the weight, each pinned by a fixture that can
 * tell the two answers apart:
 *
 * 1. **Cold means cold on EVERY repeat, by deleting the arm's own store.** The
 *    probe records whether the store existed when it started, so "the store was
 *    reset before each cold repeat" and "it was reset once" are different logs.
 *    The lab never runs `vat cache clear`: the probe's argv log shows no such child.
 * 2. **Warm means one exit-checked priming run, then measured repeats.**
 * 3. **A step that exits otherwise than committed fails the measurement.**
 * 4. **The arm's home is empty at the start of every sequence.**
 *
 * The pure classifiers are exercised on synthetic results rather than on spawned
 * children, because what they decide is arithmetic over exit codes.
 *
 * No vat binary is spawned. The instrument is `node <probe.cjs>` from
 * `command-probe.ts`, a stand-in that logs its argv and environment into its
 * working directory.
 */

import { readdirSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { armDirectories } from '../src/harness/arm-dirs.js';
import {
  classifyRunFailure,
  materializeArgs,
  runInterleaved,
  runRepeats,
  SUBJECT_TOKEN,
  summarizeRepeatFailures,
} from '../src/harness/repeat.js';
import type { SequenceResult } from '../src/harness/sequence.js';
import type { RunResult } from '../src/harness/types.js';

import {
  argsOf,
  cleanupProbes,
  PROBE_BASE_ENV,
  PROBE_ECHO_ENV,
  PROBE_EXIT_CODE_ENV,
  PROBE_FAIL_EXIT,
  PROBE_FAIL_TOKEN,
  PROBE_POPULATE_ENV,
  PROBE_REPEAT_ENV,
  PROBE_STDOUT_ENV,
  probeSpec,
  probeStep,
  setupProbe,
} from './command-probe.js';

afterAll(cleanupProbes);
afterEach(() => {
  vi.unstubAllEnvs();
});

/** Temp-directory prefix, so a stray directory names this suite. */
const PREFIX = 'lab-repeat-';

/** The value set for {@link PROBE_BASE_ENV}, asserted in every child's log line. */
const BASE_VALUE = 'base-value';

/** What a command that only completes at 0 accepts. */
const ONLY_ZERO: readonly number[] = [0];

/** What a findings command accepts: 0 (nothing to report) and 1 (findings). */
const ZERO_OR_FINDINGS: readonly number[] = [0, 1];

/**
 * Build a `RunResult` for the pure classification tests.
 *
 * @param overrides - The fields a case actually varies
 * @returns A complete result
 */
function result(overrides: Partial<RunResult> = {}): RunResult {
  return { wallMs: 1, exitCode: 0, stdout: '', stderr: '', spawnError: null, ...overrides };
}

/**
 * Build a `SequenceResult` for the summary tests.
 *
 * @param exitCode - Its aggregate exit code
 * @param violation - Why it fails the measurement, or `null`
 * @returns A complete result with no steps
 */
function sequence(exitCode: number, violation: string | null = null): SequenceResult {
  return { ...result({ exitCode }), steps: [], violation };
}

describe('materializeArgs', () => {
  it('substitutes EVERY occurrence of the subject token, in every argument', () => {
    // Two tokens in one string on purpose: an implementation using `replace`
    // rather than `replaceAll` passes a one-token fixture and fails this one.
    const args = materializeArgs(
      ['audit', SUBJECT_TOKEN, `${SUBJECT_TOKEN}/a/${SUBJECT_TOKEN}`],
      '/p',
    );

    expect(args).toEqual(['audit', '/p', '/p/a//p']);
  });

  it('leaves arguments without the token exactly as they were', () => {
    expect(materializeArgs(['audit', '--json'], '/p')).toEqual(['audit', '--json']);
  });
});

describe('classifyRunFailure', () => {
  it('calls a clean exit no failure', () => {
    expect(classifyRunFailure(result(), ONLY_ZERO)).toBeNull();
  });

  it('reports a spawn failure IN PREFERENCE to any exit code', () => {
    // A process that never ran has no exit code worth reporting. The fixture
    // supplies both, so a classifier testing them in the wrong order returns
    // the 'exited 3' string and fails here.
    const failure = classifyRunFailure(
      result({ exitCode: 3, spawnError: 'ENOENT: no such file' }),
      ONLY_ZERO,
    );

    expect(failure).toBe('ENOENT: no such file');
  });

  it('reports a spawn failure even when the exit code it carries is an ACCEPTED one', () => {
    // The ordering guarantee where it actually bites now that codes can be
    // accepted: a classifier that consulted `completedExitCodes` before
    // `spawnError` would return null here and admit a process that never ran
    // into a median.
    const failure = classifyRunFailure(
      result({ exitCode: 1, spawnError: 'killed after timeout' }),
      ZERO_OR_FINDINGS,
    );

    expect(failure).toBe('killed after timeout');
  });

  it('reports a non-zero exit with the code and the start of stderr', () => {
    const failure = classifyRunFailure(
      result({ exitCode: 3, stderr: '  no config found\n' }),
      ONLY_ZERO,
    );

    expect(failure).toBe('exited 3: no config found');
  });

  it('treats a code the command declared as completed as no failure at all', () => {
    // The defect this replaces: `vat validate` exits 1 on any project with
    // findings, which is every real project, so its every repeat was a
    // "failure" and its row could never carry a number.
    expect(classifyRunFailure(result({ exitCode: 1 }), ZERO_OR_FINDINGS)).toBeNull();
  });

  it('still fails the same exit 1 when the command did NOT declare it completed', () => {
    // The pair to the case above, on the identical result: only the accepted
    // set differs, so the fixture can genuinely tell the two answers apart.
    const failure = classifyRunFailure(result({ exitCode: 1, stderr: 'broken' }), ONLY_ZERO);

    expect(failure).toBe('exited 1: broken');
  });

  it('never accepts exit 2 — a system error is a run that did not complete', () => {
    const failure = classifyRunFailure(
      result({ exitCode: 2, stderr: 'no config found' }),
      ZERO_OR_FINDINGS,
    );

    expect(failure).toBe('exited 2: no config found');
  });

  it('fails a run with no exit code at all, whatever is accepted', () => {
    expect(classifyRunFailure(result({ exitCode: null }), ZERO_OR_FINDINGS)).toBe('exited null: ');
  });

  it('caps the stderr excerpt so one loud failure cannot swamp a report', () => {
    const failure = classifyRunFailure(result({ exitCode: 1, stderr: 'x'.repeat(500) }), ONLY_ZERO);

    expect(failure).toBe(`exited 1: ${'x'.repeat(200)}`);
  });
});

describe('summarizeRepeatFailures', () => {
  it('says nothing when every repeat completed with the same code', () => {
    expect(summarizeRepeatFailures([sequence(1), sequence(1), sequence(1)])).toBeNull();
  });

  it('counts the violations against the whole set', () => {
    expect(summarizeRepeatFailures([sequence(0), sequence(3, "step 'audit' exited 3: boom"), sequence(0)])).toBe(
      "1 of 3 repeats failed — step 'audit' exited 3: boom",
    );
  });

  it('fails a row whose repeats completed with DIFFERENT codes, naming both', () => {
    expect(summarizeRepeatFailures([sequence(0), sequence(1), sequence(0)])).toBe(
      '3 repeats exited 0 and 1 — every repeat completed, but not with the same amount of work ' +
        'done, so a statistic over them describes neither run',
    );
  });

  it('reports the violation, not the disagreement, when both are present', () => {
    expect(summarizeRepeatFailures([sequence(0), sequence(1), sequence(2, 'gone')])).toBe('1 of 3 repeats failed — gone');
  });

  it("says nothing about a set with no repeats — that is the facet's own case", () => {
    expect(summarizeRepeatFailures([])).toBeNull();
  });
});

describe('runRepeats', () => {
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
    expect(readdirSync(probe.cwd)).not.toContain('out');
  });

  it('gives the measured run its per-repeat environment and the priming run only the base', async () => {
    const probe = setupProbe(PREFIX);

    await runRepeats(
      probeSpec(probe, {
        runs: 2,
        env: { [PROBE_BASE_ENV]: BASE_VALUE },
        envFor: (index) => ({ [PROBE_REPEAT_ENV]: `repeat-${String(index)}` }),
      }),
    );

    expect(probe.entries().map(({ base, perRepeat }) => ({ base, perRepeat }))).toEqual([
      { base: BASE_VALUE, perRepeat: null },
      { base: BASE_VALUE, perRepeat: 'repeat-0' },
      { base: BASE_VALUE, perRepeat: 'repeat-1' },
    ]);
  });

  it('keeps going after a failed cold repeat and reports every one, each a violation', async () => {
    const probe = setupProbe(PREFIX);

    const run = await runRepeats(probeSpec(probe, { args: [PROBE_FAIL_TOKEN], runs: 2, cache: 'cold' }));

    expect(run.results.map((sequenceRun) => sequenceRun.exitCode)).toEqual([PROBE_FAIL_EXIT, PROBE_FAIL_EXIT]);
    expect(run.results.map((sequenceRun) => sequenceRun.violation)).toEqual([
      `step 'boom' exited ${String(PROBE_FAIL_EXIT)}: probe was asked to fail`,
      `step 'boom' exited ${String(PROBE_FAIL_EXIT)}: probe was asked to fail`,
    ]);
  });

  it('fails a warm arm whose priming run exits otherwise than committed, and measures nothing', async () => {
    const probe = setupProbe(PREFIX);

    const run = await runRepeats(probeSpec(probe, { args: [PROBE_FAIL_TOKEN], runs: 3 }));

    expect(run.priming?.violation).toMatch(/^priming run: step 'boom' exited 3/);
    expect(run.results).toEqual([]);
    expect(probe.entries()).toHaveLength(1);
  });

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

  it("fails a sequence whose later step never ran because an earlier one's committed exit was non-zero", async () => {
    const probe = setupProbe(PREFIX);
    const steps = [probeStep([PROBE_FAIL_TOKEN], { expectedExits: [1] }), probeStep(['after'])];

    const run = await runRepeats(probeSpec(probe, { runs: 1, cache: 'cold', steps, env: { [PROBE_EXIT_CODE_ENV]: '1' } }));

    expect(run.results[0]?.exitCode).toBe(1);
    expect(run.results[0]?.violation).toBe("step 'after' did not run: an earlier step exited 1");
  });

  it('refuses a step that commits to exit 2', async () => {
    const probe = setupProbe(PREFIX);
    await expect(runRepeats(probeSpec(probe, { steps: [probeStep(['audit'], { expectedExits: [0, 2] })] }))).rejects.toThrow(/exit 2/);
  });

  it('refuses a caller environment that names a variable the arm owns', async () => {
    const probe = setupProbe(PREFIX);
    await expect(runRepeats(probeSpec(probe, { env: { VAT_PROJECTION_STORE_DIR: probe.cwd } }))).rejects.toThrow(
      /VAT_PROJECTION_STORE_DIR/,
    );
  });
});

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

  it('captures every repetition\'s stderr per step', async () => {
    const probe = setupProbe(PREFIX);
    const run = await runRepeats(probeSpec(probe, { args: [PROBE_FAIL_TOKEN], runs: 2, cache: 'cold' }));
    expect(run.results.map((sequenceRun) => sequenceRun.steps[0]?.stderr)).toEqual(['probe was asked to fail', 'probe was asked to fail']);
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
});
