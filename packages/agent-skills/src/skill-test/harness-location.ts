import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, statSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';

/** Harness-location failure — maps to exit code 2. */
export class HarnessLocationError extends Error {
  readonly exitCode = 2 as const;
  constructor(message: string) {
    super(message);
    this.name = 'HarnessLocationError';
  }
}

/** Sanitize a skill name to a path-safe token (no separators, no traversal). */
function sanitize(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Deterministic harness key for a subject set: sorted, sanitized names plus a
 * short content hash of the joined raw names (so distinct sets that sanitize
 * to the same tokens still differ).
 */
export function deriveHarnessKey(skillNames: string[]): string {
  if (skillNames.length === 0) {
    throw new HarnessLocationError('Cannot derive a harness key from an empty skill set.');
  }
  const sorted = [...skillNames].sort((a, b) => a.localeCompare(b));
  const tokens = sorted.map(sanitize).join('+');
  const hash = createHash('sha256').update(sorted.join('\0')).digest('hex').slice(0, 8);
  return `${tokens}-${hash}`;
}

/** Resolve the deterministic harness root under the OS tmp dir. */
export function resolveHarnessRoot(skillNames: string[], tmpRoot?: string): string {
  const base = tmpRoot ?? normalizedTmpdir();
  return safePath.join(base, 'vat-skill-test', deriveHarnessKey(skillNames));
}

/**
 * Refuse a --workdir whose ancestry contains CLAUDE.md or .claude/ — cwd
 * discovery would re-pollute the run (spec §7). Defense in depth with
 * --setting-sources "".
 */
export function assertSafeWorkdir(dir: string): void {
  let current = safePath.resolve(dir);
  let previous = '';
  while (current !== previous) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- ancestry walk over a user-supplied workdir
    if (existsSync(safePath.join(current, 'CLAUDE.md'))) {
      throw new HarnessLocationError(`--workdir is inside a project: CLAUDE.md found at ${current}. Use an OS-tmp location.`);
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- ancestry walk over a user-supplied workdir
    if (existsSync(safePath.join(current, '.claude'))) {
      throw new HarnessLocationError(`--workdir is inside a project: .claude/ found at ${current}. Use an OS-tmp location.`);
    }
    previous = current;
    current = safePath.join(current, '..');
  }
}

/**
 * Prepare the harness root directory so that `assertSafeHarnessRoot` will
 * pass on the next call. If the path does not exist, this is a no-op (the
 * caller creates it at 0700 via mkdirSyncReal). If it exists:
 *
 * - Symlink → throw HarnessLocationError (security gate; never relax).
 * - Real directory whose mode != 0700 → chmod to 0700. Removing group/other
 *   access is strictly safer, never a relaxation.
 *
 * Mode checks/changes are only performed on non-win32 (matching
 * assertSafeHarnessRoot's platform guard).
 */
export function prepareHarnessRoot(dir: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived harness root
  if (!existsSync(dir)) return;

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived harness root
  const ls = lstatSync(dir);
  if (ls.isSymbolicLink()) {
    throw new HarnessLocationError(`Refusing to use a symlinked harness root: ${dir}.`);
  }

  if (process.platform !== 'win32') {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived harness root
    const mode = statSync(dir).mode & 0o777;
    if (mode !== 0o700) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived harness root
      chmodSync(dir, 0o700);
    }
  }
}

/**
 * FS-bound hardening for the shared-tmp harness root (spec §7): the root must
 * be 0700 and owned by the current uid, and no path component may be a symlink.
 * Integration-tested (requires real lstat/stat). On Windows, uid checks are
 * skipped (process.getuid is undefined) but the symlink refusal still applies.
 */
export function assertSafeHarnessRoot(dir: string, currentUid: number): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived harness root
  if (!existsSync(dir)) return; // not yet created — caller creates it 0700
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived harness root
  const ls = lstatSync(dir);
  if (ls.isSymbolicLink()) {
    throw new HarnessLocationError(`Refusing to use a symlinked harness root: ${dir}.`);
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived harness root
  const st = statSync(dir);
  if (typeof st.uid === 'number' && st.uid !== currentUid) {
    throw new HarnessLocationError(`Harness root ${dir} is not owned by the current user (uid ${st.uid} != ${currentUid}).`);
  }
  const mode = st.mode & 0o777;
  if (mode !== 0o700 && process.platform !== 'win32') {
    throw new HarnessLocationError(`Harness root ${dir} must be 0700 (found ${mode.toString(8)}).`);
  }
}
