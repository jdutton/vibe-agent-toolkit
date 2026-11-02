/**
 * A measured subject never receives anything: an arm whose steps WRITE the tree
 * they run in runs in its own copy of the subject, with the written directories
 * deleted before every repeat and the copy removed afterwards.
 *
 * No vat binary is spawned. The instrument is `node <probe.cjs>` from
 * `command-probe.ts`, told by {@link PROBE_WRITES_ENV} to write `dist/` in its
 * working directory and to report whether `dist/` was there when it started.
 *
 * Integration-tier: every case spawns real child processes or reads a real tree.
 */

import { existsSync, readdirSync, writeFileSync } from 'node:fs';

import { createSymlink, mkdirSyncReal, normalizedTmpdir, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { afterAll, describe, expect, it } from 'vitest';

import { armDirectories } from '../../src/harness/arm-dirs.js';
import { runInterleaved, runRepeats } from '../../src/harness/repeat.js';
import { planSubjectCopy, writtenDirectories } from '../../src/harness/subject-copy.js';
import { cleanupProbes, PROBE_NO_LOG_ENV, PROBE_WRITES_ENV, probeSpec, probeStep, setupProbe } from '../command-probe.js';

afterAll(cleanupProbes);

/** Temp-directory prefix, so a stray directory names this suite. */
const PREFIX = 'lab-subject-copy-';

/** What the probe's stdout says about `dist/` at the start of each measured repeat. */
function distExistedPerRepeat(run: Awaited<ReturnType<typeof runRepeats>>): unknown[] {
  return run.results.map((result) => (JSON.parse(result.steps[0]?.stdout ?? '{}') as Record<string, unknown>)['existed:dist']);
}

describe.skipIf(process.platform === 'win32')('a step that writes its subject', () => {
  it("leaves the real subject's dist/ untouched, and removes its copy afterwards", async () => {
    const probe = setupProbe(PREFIX);
    const dist = mkdirSyncReal(safePath.join(probe.cwd, 'dist'));
    writeFileSync(safePath.join(dist, 'marker'), 'real');
    const before = readdirSync(probe.cwd).sort((a, b) => a.localeCompare(b));

    const spec = probeSpec(probe, {
      runs: 2,
      cache: 'cold',
      steps: [probeStep(['build'], { writes: ['dist'] })],
      // No probe.log: it lands in the cwd, which is a write outside `dist/`.
      env: { [PROBE_WRITES_ENV]: 'dist', [PROBE_NO_LOG_ENV]: '1' },
    });
    const run = await runRepeats(spec);

    expect(run.results).toHaveLength(2);
    expect(run.results.every((result) => result.violation === null)).toBe(true); // positive control: it ran
    expect(readdirSync(dist)).toEqual(['marker']);
    expect(readdirSync(probe.cwd).sort((a, b) => a.localeCompare(b))).toEqual(before); // not even a probe.log
    expect(existsSync(armDirectories(spec.arm).subject)).toBe(false);
  });

  it("starts every repeat with no dist/ — not the copied one, not the warm priming run's, not the last repeat's", async () => {
    const probe = setupProbe(PREFIX);
    writeFileSync(safePath.join(mkdirSyncReal(safePath.join(probe.cwd, 'dist')), 'marker'), 'real');

    const spec = probeSpec(probe, {
      runs: 2,
      cache: 'warm',
      steps: [probeStep(['build'], { writes: ['dist'] })],
      env: { [PROBE_WRITES_ENV]: 'dist' },
    });
    const run = await runRepeats(spec);

    expect(distExistedPerRepeat(run)).toEqual([false, false]);
  });

  it('runs in the real subject when no step writes it', async () => {
    const probe = setupProbe(PREFIX);
    const spec = probeSpec(probe, { runs: 1, cache: 'cold', env: { [PROBE_WRITES_ENV]: 'dist' } });
    await runRepeats(spec);

    expect(readdirSync(safePath.join(probe.cwd, 'dist'))).toHaveLength(1);
  });

  it('fails a repeat that changed its copy outside the directories its steps declare they write', async () => {
    const probe = setupProbe(PREFIX);
    const spec = probeSpec(probe, {
      runs: 1,
      cache: 'cold',
      steps: [probeStep(['build'], { writes: ['dist'] })],
      env: { [PROBE_WRITES_ENV]: 'stray', [PROBE_NO_LOG_ENV]: '1' },
    });
    const run = await runRepeats(spec);

    expect(run.results[0]?.violation).toMatch(/outside what its steps declare they write \(dist\)/u);
  });

  it('refuses a writing arm whose step names the real subject through a link to it', async ({ skip }) => {
    const probe = setupProbe(PREFIX);
    const link = safePath.join(probe.armsRoot, '..', 'link');
    createSymlink(symlinkCapability() ?? skip(), probe.cwd, link, 'dir');
    const spec = probeSpec(probe, { runs: 1, cache: 'cold', steps: [probeStep(['build', `--out=${safePath.join(link, 'out')}`], { writes: ['dist'] })] });

    await expect(runRepeats(spec)).rejects.toThrow(/names the subject in its arguments/u);
  });

  it('refuses a writing arm whose step names the real subject in its arguments', async () => {
    const probe = setupProbe(PREFIX);
    const spec = probeSpec(probe, { runs: 1, cache: 'cold', steps: [probeStep(['build', probe.cwd], { writes: ['dist'] })] });

    await expect(runRepeats(spec)).rejects.toThrow(/names the subject in its arguments/u);
  });

  it('removes a copy it already made when a later arm\'s copy throws', async () => {
    const copied = setupProbe(PREFIX);
    const refused = setupProbe(PREFIX);
    writeFileSync(safePath.join(refused.cwd, '.git'), 'gitdir: /elsewhere\n');
    const writing = { runs: 1, cache: 'cold', steps: [probeStep(['build'], { writes: ['dist'] })] } as const;
    const first = probeSpec(copied, { ...writing, arm: 'first' });
    const second = probeSpec(refused, { ...writing, arm: 'second' });

    await expect(runInterleaved([first, second], 1)).rejects.toThrow(/git worktree/u);
    // Positive control: the first arm's copy is where the run would have put it, and is gone.
    expect(armDirectories(first.arm).subject).not.toBe(armDirectories(second.arm).subject);
    expect(existsSync(armDirectories(first.arm).subject)).toBe(false);
  });
});

describe('writtenDirectories', () => {
  const step = (writes: string[]) => ({ name: 'build', writes });

  it('names each written directory once, in first-named order', () => {
    expect(writtenDirectories([step(['dist', 'out']), step(['dist'])])).toEqual(['dist', 'out']);
    expect(writtenDirectories([step([])])).toEqual([]);
  });

  it.each(['', safePath.join(normalizedTmpdir(), 'dist'), '../dist', 'a/../../dist'])('refuses %j, which is not a directory inside the subject', (relative) => {
    expect(() => writtenDirectories([step([relative])])).toThrow(/not a directory inside the subject/u);
  });
});

describe('planSubjectCopy', () => {
  it('refuses Windows', () => {
    const probe = setupProbe(PREFIX);
    expect(planSubjectCopy(probe.cwd, safePath.join(probe.armsRoot, 'copy'), 'win32')).toMatchObject({ ok: false, refusal: expect.stringContaining('Windows') });
  });

  it('refuses a git worktree subject, whose .git is a file', () => {
    const probe = setupProbe(PREFIX);
    writeFileSync(safePath.join(probe.cwd, '.git'), 'gitdir: /elsewhere\n');
    expect(planSubjectCopy(probe.cwd, safePath.join(probe.armsRoot, 'copy'), 'darwin')).toMatchObject({ ok: false, refusal: expect.stringContaining('git worktree') });
  });

  it('refuses a subject nested below its repository\'s top level, whose copy would carry no .git', () => {
    const probe = setupProbe(PREFIX);
    const repository = safePath.join(probe.cwd, '..');
    mkdirSyncReal(safePath.join(repository, '.git'));
    expect(planSubjectCopy(probe.cwd, safePath.join(probe.armsRoot, 'copy'), 'darwin')).toMatchObject({
      ok: false,
      refusal: expect.stringContaining('not its top level'),
    });
    // The top level itself is copied.
    expect(planSubjectCopy(repository, safePath.join(probe.armsRoot, 'copy'), 'darwin')).toMatchObject({ ok: true });
  });

  it('clones copy-on-write on macOS and copies for real elsewhere', () => {
    const probe = setupProbe(PREFIX);
    const flags = (platform: NodeJS.Platform) => {
      const plan = planSubjectCopy(probe.cwd, safePath.join(probe.armsRoot, 'copy'), platform);
      if (!plan.ok) throw new Error(plan.refusal);
      return plan.steps.flatMap((s) => (s.kind === 'spawn' ? [s.args.slice(0, -2)] : []));
    };
    expect(new Set(flags('darwin').map((f) => f.join(' ')))).toEqual(new Set(['-c -R']));
    expect(new Set(flags('linux').map((f) => f.join(' ')))).toEqual(new Set(['-R']));
  });
});
