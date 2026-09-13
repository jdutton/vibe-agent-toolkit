/**
 * `isToolAvailable` / `getToolVersion` used to `catch { return false/null }`
 * around the whole probe, so "not installed" was the answer to everything:
 * the binary missing from PATH (the case the sentinel means), the binary
 * running and exiting non-zero (the other case it means — a tool with no
 * `--version`), AND the OS refusing to execute a file `which` had just found,
 * a spawn that could not start, or a bug in the exec layer. `vat doctor`
 * reporting "claude: not installed" for an `EACCES` sends the adopter to
 * reinstall a tool that is there.
 *
 * `which` and `spawnSync` are mocked so every arm is reachable on every OS:
 * `which` decides "on PATH or not", `spawnSync` decides what running it did.
 */
import type childProcess from 'node:child_process';
import { spawnSync } from 'node:child_process';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import which from 'which';

import { getToolVersion, isToolAvailable } from '../src/safe-exec.js';

import { errnoOf } from './test-helpers.js';

vi.mock('which', () => ({ default: { sync: vi.fn() } }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawnSync: vi.fn(),
}));

const TOOL = 'some-tool';
const RESOLVED = '/opt/bin/some-tool';

function errno(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(`${message}: simulated`), { code });
}

/** What `spawnSync` answers: a completed run, or a spawn that never started. */
function spawnAnswers(answer: { status: number; stdout?: string } | { error: Error }): void {
  vi.mocked(spawnSync).mockReturnValue(
    'error' in answer
      ? { error: answer.error, status: null, signal: null, stdout: '', stderr: '', pid: 0, output: [] }
      : { status: answer.status, signal: null, stdout: answer.stdout ?? '', stderr: '', pid: 1, output: [] },
  );
}

describe('tool probes: "not installed" is an answer to two failures, not to every failure', () => {
  beforeEach(() => {
    vi.mocked(which.sync).mockReset();
    vi.mocked(spawnSync).mockReset();
    vi.mocked(which.sync).mockReturnValue(RESOLVED);
  });

  it('reports a tool that runs and prints its version (positive control)', () => {
    spawnAnswers({ status: 0, stdout: 'v1.2.3\n' });
    expect(isToolAvailable(TOOL)).toBe(true);
    expect(getToolVersion(TOOL)).toBe('v1.2.3');
  });

  it('reports a tool `which` cannot find as not installed', () => {
    vi.mocked(which.sync).mockImplementation(() => {
      throw errno('ENOENT', `not found: ${TOOL}`);
    });
    expect(isToolAvailable(TOOL)).toBe(false);
    expect(getToolVersion(TOOL)).toBeNull();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('reports a binary that vanished between `which` and `spawn` as not installed', () => {
    spawnAnswers({ error: errno('ENOENT', 'spawn') });
    expect(isToolAvailable(TOOL)).toBe(false);
    expect(getToolVersion(TOOL)).toBeNull();
  });

  it('reports a tool that runs and exits non-zero as not installed (the documented sentinel)', () => {
    spawnAnswers({ status: 1 });
    expect(isToolAvailable(TOOL)).toBe(false);
    expect(getToolVersion(TOOL)).toBeNull();
  });

  it.each(['EACCES', 'EPERM', 'ENOMEM'])('lets the OS refusing to start a found binary (%s) stay loud', (code) => {
    spawnAnswers({ error: errno(code, 'spawn') });
    expect(errnoOf(() => isToolAvailable(TOOL))).toBe(code);
    expect(errnoOf(() => getToolVersion(TOOL))).toBe(code);
  });

  it('lets a bug in the exec layer stay loud', () => {
    vi.mocked(spawnSync).mockImplementation(() => {
      throw new TypeError('spawnSync is not a function');
    });
    expect(() => isToolAvailable(TOOL)).toThrow(TypeError);
    expect(() => getToolVersion(TOOL)).toThrow(TypeError);
  });
});
