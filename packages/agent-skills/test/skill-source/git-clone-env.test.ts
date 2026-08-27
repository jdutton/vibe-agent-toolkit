/**
 * Unit test for the ENV/config `cloneGitSource` hands to `git clone`.
 *
 * `git clone` against a nonexistent or private HTTPS URL blocks on an
 * interactive credential prompt. When the user typed bare `owner/repo` and got
 * it wrong, that is a ~60s apparent hang for a typo, so the clone must run
 * non-interactively. When the user typed a full URL, interactive auth may be
 * exactly what they intended, so it must be left alone.
 *
 * `spawnSync` is mocked — this test must NEVER touch the network. Every prompt
 * hook is stubbed to a sentinel first, so the assertions describe *our* changes
 * to the environment rather than whatever the host machine happens to export.
 */

import { spawnSync } from 'node:child_process';

import { parseGitUrl } from '@vibe-agent-toolkit/utils/git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cloneGitSource } from '../../src/skill-source/git-clone.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

const spawnSyncMock = vi.mocked(spawnSync);

/**
 * Never created: `spawnSync` is mocked, so nothing here reaches the filesystem.
 */
const CLONE_TARGET = '/vat-git-clone-env-test/never-created';
const EXPLICIT_HTTPS_URL = 'https://github.com/foo/bar.git';

/** Ambient values we must be able to see being overridden (or left alone). */
const SENTINEL = '/sentinel/interactive-askpass.sh';
const PROMPT_HOOKS = ['GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_TERMINAL_PROMPT', 'GCM_INTERACTIVE'];

/** A non-zero `git clone` result: enough to stop the pipeline after the spawn. */
const FAILED_CLONE = { status: 1, stdout: '', stderr: 'simulated clone failure' };

/**
 * Drive `cloneGitSource` far enough to capture the `git clone` spawn. The mocked
 * `spawnSync` reports failure, so the call throws — the spawn arguments are
 * already captured by then, and nothing touches the filesystem or the network.
 */
function captureCloneSpawn(ref: string): { args: string[]; env: NodeJS.ProcessEnv } {
  expect(() => cloneGitSource(parseGitUrl(ref), CLONE_TARGET)).toThrow(
    /Clone failed/i,
  );
  const call = spawnSyncMock.mock.calls[0];
  expect(call).toBeDefined();
  const [, args, options] = call as unknown as [string, string[], { env?: NodeJS.ProcessEnv }];
  return { args, env: options.env ?? {} };
}

beforeEach(() => {
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue(FAILED_CLONE as unknown as ReturnType<typeof spawnSync>);
  for (const key of PROMPT_HOOKS) vi.stubEnv(key, SENTINEL);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('cloneGitSource — non-interactive clone for inferred shorthand URLs', () => {
  it('disables the terminal prompt and the whole askpass chain', () => {
    const { args, env } = captureCloneSpawn('foo/bar');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_ASKPASS).toBe('');
    expect(env.SSH_ASKPASS).toBe('');
    expect(env.GCM_INTERACTIVE).toBe('never');
    // `-c` must precede the subcommand for git to accept it.
    expect(args.slice(0, 3)).toEqual(['-c', 'core.askPass=', 'clone']);
  });

  it('still inherits the ambient environment (helpers can answer non-interactively)', () => {
    const { env } = captureCloneSpawn('foo/bar');
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('applies to shorthand with a ref', () => {
    const { args, env } = captureCloneSpawn('foo/bar#main');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(args).toContain('--branch');
  });
});

describe('cloneGitSource — explicitly supplied URLs keep interactive auth', () => {
  it('leaves every prompt hook untouched for a full HTTPS URL', () => {
    const { args, env } = captureCloneSpawn(EXPLICIT_HTTPS_URL);
    for (const key of PROMPT_HOOKS) expect(env[key]).toBe(SENTINEL);
    expect(args[0]).toBe('clone');
    expect(args).not.toContain('core.askPass=');
  });

  it('leaves every prompt hook untouched for an SSH URL', () => {
    const { env } = captureCloneSpawn('git@github.com:foo/bar.git');
    for (const key of PROMPT_HOOKS) expect(env[key]).toBe(SENTINEL);
  });

  it('leaves every prompt hook untouched for a GitHub web /tree/ URL', () => {
    const { env } = captureCloneSpawn('https://github.com/foo/bar/tree/main');
    for (const key of PROMPT_HOOKS) expect(env[key]).toBe(SENTINEL);
  });
});

describe('cloneGitSource — failure message names the shorthand expansion', () => {
  const clone = (ref: string): void => {
    cloneGitSource(parseGitUrl(ref), CLONE_TARGET);
  };

  it('tells the user what `owner/repo` was expanded to', () => {
    expect(() => clone('foo/bar')).toThrow(/expanded to https:\/\/github\.com\/foo\/bar\.git/);
    expect(() => clone('foo/bar')).toThrow(/private/i);
  });

  it('adds no expansion hint when the user typed the URL', () => {
    expect(() => clone(EXPLICIT_HTTPS_URL)).toThrow(/Clone failed/);
    expect(() => clone(EXPLICIT_HTTPS_URL)).not.toThrow(/expanded to/);
  });
});
