import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, statSync } from 'node:fs';

import { isAbsolutePath, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';

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

/** True when `child` is a strict descendant of `root` (neither equal nor escaping). */
function isStrictlyUnder(root: string, child: string): boolean {
  if (child === root) return false;
  const rel = safePath.relative(root, child);
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolutePath(rel);
}

/**
 * The harness path components to validate, leaf-first: the leaf and every
 * ancestor strictly between it and `trustedRoot` (exclusive). When the leaf is
 * not a descendant of `trustedRoot` (e.g. an explicit --out elsewhere), only the
 * leaf is returned — we cannot bound the walk without a trusted boundary, so we
 * fall back to leaf-only validation.
 */
function harnessAncestry(leaf: string, trustedRoot: string): string[] {
  if (!isStrictlyUnder(trustedRoot, leaf)) return [leaf];
  const components: string[] = [];
  let current = leaf;
  while (current !== trustedRoot) {
    const parent = safePath.join(current, '..');
    if (parent === current) break; // reached the filesystem root defensively
    components.push(current);
    current = parent;
  }
  return components;
}

/**
 * Reject a single harness path component that is a symlink or not owned by the
 * current user. A non-existent component is skipped (an absent ancestor cannot
 * be a live attacker-controlled symlink). On Windows the ownership check is
 * skipped (no real uids); the symlink refusal still applies.
 */
function assertComponentSafe(component: string, currentUid: number): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived harness path component
  if (!existsSync(component)) return;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived harness path component
  const ls = lstatSync(component);
  if (ls.isSymbolicLink()) {
    throw new HarnessLocationError(`Refusing to use a symlinked harness path component: ${component}.`);
  }
  if (process.platform !== 'win32' && typeof ls.uid === 'number' && ls.uid !== currentUid) {
    throw new HarnessLocationError(
      `Harness path component ${component} is not owned by the current user (uid ${ls.uid} != ${currentUid}).`,
    );
  }
}

/**
 * FS-bound hardening for the shared-tmp harness root (spec §7). Validates EVERY
 * path component from the leaf up to (but excluding) `trustedRoot`: no component
 * may be a symlink, and on POSIX each must be owned by the current uid. This
 * closes the shared-/tmp TOCTOU where the recursively-created intermediate parent
 * (`<tmp>/vat-skill-test`) — not just the leaf — could be pre-created as a symlink
 * or under another user's ownership. The leaf must additionally be 0700.
 *
 * `trustedRoot` (default: the OS tmp dir) is the boundary: it is system-owned
 * (sticky-bit /tmp) so ownership/mode checks are not applied to it. When the leaf
 * is not a descendant of `trustedRoot` (an explicit --out elsewhere), validation
 * degrades to the leaf alone.
 *
 * Integration-tested (requires real lstat/stat). On Windows, uid checks are
 * skipped (process.getuid is undefined) but the symlink refusal still applies.
 */
export function assertSafeHarnessRoot(
  dir: string,
  currentUid: number,
  trustedRoot: string = normalizedTmpdir(),
): void {
  const resolved = safePath.resolve(dir);
  // eslint-disable-next-line local/no-unsafe-root-join -- single-arg normalization of the trusted boundary itself (no caller-controlled segment is joined here); it is only used as an equality boundary for the ancestry walk.
  const root = safePath.resolve(trustedRoot);

  for (const component of harnessAncestry(resolved, root)) {
    assertComponentSafe(component, currentUid);
  }

  // Leaf-only 0700 check (intermediates are created 0700 by recursive mkdir and
  // need only the symlink/ownership guarantees above). Skipped on win32.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived harness root
  if (!existsSync(resolved)) return; // not yet created — caller creates it 0700
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived harness root
  const mode = statSync(resolved).mode & 0o777;
  if (mode !== 0o700 && process.platform !== 'win32') {
    throw new HarnessLocationError(`Harness root ${resolved} must be 0700 (found ${mode.toString(8)}).`);
  }
}
