/**
 * Absolute paths for the executables test fixtures spawn.
 *
 * A test that spawns `'git'` or `'node'` by bare name asks the OS to search
 * `PATH`, and a writable directory on `PATH` turns that into a place to plant
 * a binary (the class SonarCloud's S4036 flags). Fixtures resolve the binary
 * ONCE, here, to an absolute path and spawn that: `node` is the process that
 * is running the test (`process.execPath`, the only node whose version the
 * test can vouch for), and `git` is found by walking `PATH`.
 *
 * Why a second `PATH` walk beside `safe-exec.ts`'s `which`: `which` resolves
 * in-process too, but it is a third-party package, and the `./testing` subpath
 * is pinned dependency-free (`subpath-purity.test.ts`) — an adopter's test
 * suite pulls nothing in. This walk answers the same question under that
 * constraint: the first REGULAR FILE on `PATH` named `name` (with a `PATHEXT`
 * extension on Windows) that the process may execute.
 */

import { accessSync, constants, statSync } from 'node:fs';
import { delimiter } from 'node:path';

import { isFilesystemAccessError } from '../errors/errno.js';
import { safePath } from '../path-core.js';

/** The `node` running this test, absolute. */
export const NODE_EXECUTABLE: string = process.execPath;

/** The names to try in one `PATH` directory: `PATHEXT` variants on Windows, the bare name elsewhere. */
export function executableCandidates(name: string, platform: NodeJS.Platform, pathext: string | undefined): string[] {
  if (platform !== 'win32') return [name];
  const extensions = (pathext ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((ext) => ext !== '');
  return [...extensions.map((ext) => `${name}${ext}`), name];
}

/** Is `full` a regular file the process may execute? A directory named `git` passes `X_OK` (search permission) and is not one. */
function isExecutableFile(full: string): boolean {
  try {
    accessSync(full, constants.X_OK);
    return statSync(full).isFile();
  } catch (error) {
    // Absent or not executable here: the next directory on PATH may have it.
    if (isFilesystemAccessError(error)) return false;
    throw error;
  }
}

/**
 * The first executable named `name` on `PATH`, absolute.
 *
 * @throws {Error} when nothing on `PATH` is executable under that name — a
 *   fixture that needs `git` and has none should fail at the first spawn with
 *   the reason, not with the OS's `ENOENT` for a bare word.
 */
export function resolveExecutable(name: string): string {
  const candidates = executableCandidates(name, process.platform, process.env['PATHEXT']);
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const candidate of candidates) {
      const full = safePath.join(dir, candidate);
      if (isExecutableFile(full)) return full;
    }
  }
  throw new Error(`No executable named "${name}" on PATH (${process.env['PATH'] ?? '<unset>'})`);
}

let resolvedGit: string | undefined;

/** `git`, absolute, resolved on first use and cached for the process. */
export function gitExecutable(): string {
  resolvedGit ??= resolveExecutable('git');
  return resolvedGit;
}
