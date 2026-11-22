/**
 * The sandbox and readers shared by the system files that run `vat-lab perf arms`
 * and `perf run` in-process: the developer's own state pointed at a temp directory,
 * output captured, and every stub undone after each test.
 */

import { statSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, type MockInstance, vi } from 'vitest';

import { cleanupVerdictFixtures, tempDir } from '../integration/verdict-fixtures.js';

import { CANDIDATE_SOURCE } from './candidate-subject.js';

/** POSIX modes only where a mode is asserted: a Windows host has no group or other bits. */
export const POSIX = process.platform !== 'win32';

/** Undo every stub, spy and exit code after each test, and remove the fixtures after the file. */
export function restoreAfterEachArmsTest(): void {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });
  afterAll(cleanupVerdictFixtures);
}

/**
 * @param path - A file or directory
 * @returns Its permission bits
 */
export function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

/**
 * Point everything the lab or vat could reach of the developer's own state at a sandbox.
 *
 * @returns The sandbox, which is also the OS temp directory for the run
 */
export function sandboxed(): string {
  const sandbox = tempDir('lab-arms-private-env-');
  // Both: Windows' os.homedir() reads USERPROFILE, never HOME.
  for (const name of ['HOME', 'USERPROFILE']) vi.stubEnv(name, safePath.join(sandbox, 'home'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', safePath.join(sandbox, 'claude'));
  for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, sandbox);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  return sandbox;
}

/** @returns The candidate's `dist:` specifier */
export function candidate(): string {
  if (CANDIDATE_SOURCE.kind !== 'dist') throw new Error('the candidate is a dist: build');
  return `dist:${CANDIDATE_SOURCE.path}`;
}

/**
 * @param spy - The stderr spy
 * @returns Everything written to it
 */
export function written(spy: MockInstance): string {
  return spy.mock.calls.map(([chunk]) => String(chunk)).join('');
}
