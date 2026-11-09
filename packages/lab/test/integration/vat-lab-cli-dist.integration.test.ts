/**
 * The CLI cases that resolve THIS checkout's built CLI as a real `dist:`
 * instrument — its version run and its whole module-closure digest — before
 * they refuse or accept. Each spawns the built CLI, so they live in the
 * integration tier rather than in the unit file beside the parsers they share.
 *
 * Integration-tier: spawns the built CLI.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { normalizedTmpdir, resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { abArmFlags, createProgram, resolveAbArms } from '../../src/bin/vat-lab.js';
import { npxInstallSite } from '../../src/harness/npx-install.js';

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'lab-cli-dist-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  // The actions set this on the real process object; a value leaked from one
  // test would let the next test's assertion pass on its own.
  process.exitCode = undefined;
});

/** Where an `npx:` arm would install — never reached: every arm here is `dist:`. */
const NO_NPX = npxInstallSite(safePath.join(normalizedTmpdir(), 'lab-cli-dist-never'), () => {
  throw new Error('a dist: arm installs nothing');
});

/** This checkout's own built CLI — the one `dist:` arm every unit test can rely on. */
const REPO_CLI_DIST = safePath.join(
  resolveFromImportMeta(import.meta.url, '../../../..'),
  'packages/cli/dist',
);

/**
 * `ab` options as Commander would hand them to the action: both arms named
 * `dist:` at the same built CLI, nothing else set.
 *
 * @param over - What the case varies
 * @returns The options object
 */
function sameDistArms(over: Record<string, unknown> = {}): Parameters<typeof resolveAbArms>[0] {
  return {
    instrumentA: { kind: 'dist', path: REPO_CLI_DIST },
    instrumentB: { kind: 'dist', path: REPO_CLI_DIST },
    pairs: 1,
    runs: 1,
    cache: 'warm',
    out: tempDir,
    control: false,
    ...over,
  };
}

/**
 * @param over - What the case varies over {@link sameDistArms}
 * @returns The arms `ab` resolves from those flags, or `null` when it refused
 */
async function abArms(over: Record<string, unknown> = {}): ReturnType<typeof resolveAbArms> {
  const flags = abArmFlags(sameDistArms(over));
  return flags === null ? null : resolveAbArms(flags, NO_NPX);
}

describe('vat-lab <facet> ab — indistinguishable arms', () => {
  it('refuses two spellings of one build without --control, once resolved', async () => {
    // The dist directory and its bin.js: two names, one build — same version, same
    // closure digest, same (empty) environment. Run as an A/B, every effect it printed
    // would be the machine's noise published as a difference between builds.
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const arms = await abArms({ instrumentB: { kind: 'dist', path: safePath.join(REPO_CLI_DIST, 'bin.js') } });

    expect(arms).toBeNull();
    expect(process.exitCode).toBe(ExitCode.ERROR);
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain(
      'REFUSED: the two arms are indistinguishable',
    );
  });

  it('accepts one build in two configurations', async () => {
    // The positive control: the same instrument on both arms IS an A/B when the
    // environments differ — the pool-on/pool-off run one build exists to make.
    const arms = await abArms({ envA: { X: '1' } });

    expect(arms).not.toBeNull();
    expect(arms?.envA).toStrictEqual({ set: { X: '1' }, unset: [] });
    expect(process.exitCode).toBeUndefined();
  });

  it('accepts one build where only an UNSET differs', async () => {
    const arms = await abArms({ unsetB: ['XDG_DATA_HOME'] });

    expect(arms).not.toBeNull();
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses an arm that sets and unsets one variable, before resolving anything', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const flags = abArmFlags(sameDistArms({ envA: { X: '1' }, unsetA: ['X'], instrumentA: { kind: 'dist', path: '/nowhere' } }));

    expect(flags).toBeNull();
    expect(process.exitCode).toBe(ExitCode.ERROR);
  });
});

describe('vat-lab <facet> ab — flag refusals come before any setup', () => {
  it.for([
    ['an arm that sets and unsets one variable', ['--instrument-b', 'npx:vibe-agent-toolkit@0.1.43', '--env-a', 'X=1', '--unset-a', 'X'], /--env-a and --unset-a/u],
    ['two identical arms', ['--instrument-b', 'npx:vibe-agent-toolkit@0.1.42'], /indistinguishable/u],
    ['--control with --instrument-b', ['--instrument-b', 'npx:vibe-agent-toolkit@0.1.43', '--control'], /--control runs one instrument/u],
    ['no --instrument-b and no --control', [], /an A\/B needs two arms/u],
  ] as const)('refuses %s before resolving the subject, opening --out, creating --arms-dir or installing', async ([, flags, refusal]) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const missing = safePath.join(tempDir, 'ab-flags-never');
    const out = safePath.join(tempDir, 'ab-flags-out');
    const armsDir = safePath.join(tempDir, 'ab-flags-arms');

    await createProgram().parseAsync([
      'node', 'vat-lab', 'perf', 'ab', missing,
      '--instrument-a', 'npx:vibe-agent-toolkit@0.1.42', ...flags,
      '--out', out, '--arms-dir', armsDir,
    ]);

    expect(process.exitCode).toBe(ExitCode.ERROR);
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).toMatch(refusal);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(armsDir)).toBe(false);
  });
});

describe('vat-lab <facet> run — an arm-owned variable on a real build', () => {
  it.for([
    ['run', 'TMPDIR', () => ['--instrument', `dist:${REPO_CLI_DIST}`, '--env', 'TMPDIR=/elsewhere']],
    ['ab', 'HOME', () => ['--instrument-a', `dist:${REPO_CLI_DIST}`, '--instrument-b', `dist:${REPO_CLI_DIST}`, '--env-a', 'HOME=/elsewhere']],
  ] as const)('refuses an arm-owned variable on perf %s cleanly, as REFUSED, rather than throwing out of the action', async ([subcommand, name, flags]) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await createProgram().parseAsync(['node', 'vat-lab', 'perf', subcommand, tempDir, ...flags(), '--out', safePath.join(tempDir, 'out')]);

    expect(process.exitCode).toBe(ExitCode.ERROR);
    const written = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).toMatch(/^REFUSED: /mu);
    expect(written).toContain(`${name} is set by the lab itself`);
  });
});

/**
 * Run `perf arms` over `tempDir` with these extra flags, into a fresh --out.
 *
 * @param flags - The case's flags
 * @returns What it wrote to stderr, and the --out it was given
 */
async function perfArms(flags: readonly string[]): Promise<{ readonly stderr: string; readonly out: string }> {
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const out = await mkdtemp(safePath.join(normalizedTmpdir(), 'lab-cli-arms-out-'));
  await createProgram().parseAsync(['node', 'vat-lab', 'perf', 'arms', tempDir, '--out', out, ...flags]);
  return { stderr: stderr.mock.calls.map(([chunk]) => String(chunk)).join(''), out };
}

describe('vat-lab perf arms — refusals before any clone is prepared', () => {
  it('refuses a LATER --arm naming a build no --build declares, and prepares nothing', async () => {
    const { stderr, out } = await perfArms([
      '--build',
      `cand=dist:${REPO_CLI_DIST}`,
      '--arm',
      'cand:ci-c:cold',
      '--arm',
      'rc11:ci-a:cold',
    ]);

    expect(process.exitCode).toBe(ExitCode.ERROR);
    expect(stderr).toMatch(/^REFUSED: --arm names build 'rc11'/mu);
    expect(await readdir(out)).toEqual([]);
  });

  it('refuses an --expect-exit that matches no arm, and prepares nothing', async () => {
    const { stderr, out } = await perfArms([
      '--build',
      `cand=dist:${REPO_CLI_DIST}`,
      '--arm',
      'cand:ci-c:cold',
      '--expect-exit',
      'cand:ci-a:resources-validate-ci=1',
    ]);

    expect(process.exitCode).toBe(ExitCode.ERROR);
    expect(stderr).toMatch(/^REFUSED: --expect-exit cand:ci-a names no --arm/mu);
    expect(await readdir(out)).toEqual([]);
  });
});
