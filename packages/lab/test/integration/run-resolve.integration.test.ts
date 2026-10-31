/**
 * A bare command name resolves from the CHILD's PATH, and only from it.
 *
 * Two lookups used to consult a directory PATH never named, both on Windows:
 * `which` searches the lab's own working directory first, and a bare token
 * handed to `cmd.exe` is searched for in the child's working directory first —
 * which for a prerequisite or a preparation git is the subject's clone. A
 * `git.cmd` or `pnpm.cmd` committed to the subject would have run in place of
 * the real one. Resolution is therefore the lab's: absolute PATH entries, in
 * order, with `PATHEXT` on Windows, and the shell line names the file found.
 *
 * Both platforms' rules are exercised on every platform: the platform is a
 * parameter, and the directories are real ones under a scratch root.
 *
 * Integration-tier: real directories and files.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { isAbsolutePath, mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveOnPath, windowsShellLine } from '../../src/harness/run.js';

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(safePath.join(normalizedTmpdir(), 'lab-run-resolve-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * @param name - Directory under the scratch root
 * @param files - Files to create in it
 * @param mode - Their mode
 * @returns The directory
 */
function dirWith(name: string, files: readonly string[], mode = 0o755): string {
  const dir = safePath.join(scratch, name);
  mkdirSyncReal(dir, { recursive: true });
  for (const file of files) {
    writeFileSync(safePath.join(dir, file), '');
    chmodSync(safePath.join(dir, file), mode);
  }
  return dir;
}

describe('resolveOnPath on win32', () => {
  it('takes the first PATH entry holding the name under a PATHEXT extension, read from a Path spelled any case', () => {
    const empty = dirWith('a', []);
    const holder = dirWith('b', ['tool.CMD']);
    const later = dirWith('c', ['tool.exe']);

    const env = { Path: [empty, holder, later].join(';'), PathExt: '.EXE;.CMD' };

    expect(resolveOnPath('tool', env, 'win32')).toBe(safePath.join(holder, 'tool.CMD'));
  });

  it('resolves a name that already carries its extension exactly', () => {
    const holder = dirWith('b', ['tool.cmd']);

    expect(resolveOnPath('tool.cmd', { PATH: holder, PATHEXT: '.EXE;.CMD' }, 'win32')).toBe(safePath.join(holder, 'tool.cmd'));
  });

  it('never searches a relative or empty PATH entry, which the OS would read against a working directory', (context) => {
    const planted = dirWith('planted', ['tool.cmd']);
    // A relative entry that DOES reach the planted file from this process's cwd —
    // so only the refusal to read it can make the answer undefined. '' is the cwd itself.
    const relative = safePath.relative(process.cwd(), planted);
    // A scratch root on another drive than the cwd (a Windows runner's D: workspace, C: temp) has no relative spelling.
    if (isAbsolutePath(relative)) context.skip();
    const env = { PATH: [relative, '', safePath.join(scratch, 'missing')].join(';'), PATHEXT: '.CMD' };

    expect(resolveOnPath('tool', env, 'win32')).toBeUndefined();
  });
});

describe('resolveOnPath on posix', () => {
  // A Windows host has no execute bit: `X_OK` there checks existence only.
  it.skipIf(process.platform === 'win32')('skips a file it could not execute and takes the next executable one', () => {
    const plain = dirWith('a', ['tool'], 0o644);
    const runnable = dirWith('b', ['tool']);

    expect(resolveOnPath('tool', { PATH: [plain, runnable].join(':') }, 'linux')).toBe(safePath.join(runnable, 'tool'));
  });

  it('is undefined for a name on no PATH entry', () => {
    expect(resolveOnPath('tool', { PATH: dirWith('a', []) }, 'darwin')).toBeUndefined();
    expect(resolveOnPath('tool', {}, 'darwin')).toBeUndefined();
  });
});

describe('windowsShellLine', () => {
  it('names the resolved file, never the bare name cmd.exe would look up in the child’s cwd', () => {
    const line = windowsShellLine(String.raw`C:\Program Files\nodejs\pnpm.cmd`, ['install', '--frozen-lockfile']);

    expect(line).toBe(String.raw`"C:\Program Files\nodejs\pnpm.cmd" install --frozen-lockfile`);
  });
});
