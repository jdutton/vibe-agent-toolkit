/**
 * Absolute paths for the executables test fixtures spawn.
 *
 * A test that spawns `'git'` or `'node'` by bare name asks the OS to search
 * `PATH`, and a writable directory on `PATH` turns that into a place to plant
 * a binary (the class SonarCloud's S4036 flags). Fixtures resolve the binary
 * ONCE, here, to an absolute path and spawn that: `node` is the process that
 * is running the test (`process.execPath`, which is also the only node whose
 * version the test can vouch for), and `git` is found by walking `PATH` with
 * `accessSync` — the filesystem, not a `which` spawn that would itself search
 * `PATH`.
 */

import { accessSync, constants } from 'node:fs';
import { delimiter } from 'node:path';

import { isFilesystemAccessError } from '../errors/errno.js';
import { safePath } from '../path-core.js';

/** The `node` running this test, absolute. */
export const NODE_EXECUTABLE: string = process.execPath;

/**
 * The first executable named `name` on `PATH`, absolute.
 *
 * @throws {Error} when nothing on `PATH` is executable under that name — a
 *   fixture that needs `git` and has none should fail at the first spawn with
 *   the reason, not with the OS's `ENOENT` for a bare word.
 */
export function resolveExecutable(name: string): string {
  const candidates = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const candidate of candidates) {
      const full = safePath.join(dir, candidate);
      try {
        accessSync(full, constants.X_OK);
        return full;
      } catch (error) {
        // Absent or not executable here: the next directory on PATH may have it.
        if (!isFilesystemAccessError(error)) throw error;
      }
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
