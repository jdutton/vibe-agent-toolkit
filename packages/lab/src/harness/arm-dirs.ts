/**
 * One timed arm's private directories, and the resets its sequence rule needs.
 *
 * Every (build, arm, cache state) gets `<out>/arms/<build>-<arm>-<state>/` with
 * three children:
 *
 * - `store/` — `VAT_PROJECTION_STORE_DIR`. Left for VAT to create: the parent
 *   must exist (VAT refuses a store whose parent is missing), the store itself
 *   must not, or "the first step wrote a store" could never be observed.
 * - `tmp/` — `TMPDIR`, `TEMP` and `TMP`, so each build's parse cache is private
 *   to the arm too.
 * - `home/` — `HOME` and `CLAUDE_CONFIG_DIR` (and `USERPROFILE` on Windows).
 *   Pointed, not stripped: with `CLAUDE_CONFIG_DIR` unset VAT falls back to
 *   `HOME`, and `~/` imports resolve through `homedir()`, so a stripped variable
 *   would hand the arm the developer's real `~/.claude`.
 *
 * The lab never runs `vat cache clear` and never touches the developer's default
 * store: a cold arm is made cold by deleting its own directories.
 */

import { chmodSync, type Dirent, readdirSync } from 'node:fs';

import { applyTreePlan, isPathAbsentError, mkdirSyncReal, planTreeChanges, safePath } from '@vibe-agent-toolkit/utils';

import type { InstrumentVersion } from '../envelope/coordinate.js';

import type { ArmEnvironment } from './arm-env.js';
import type { CacheMode } from './types.js';

/** Owner-only: an arm's directories hold a store and caches no one else should read or plant. */
const PRIVATE_MODE = 0o700;

/** A directory-name segment: letters, digits, `.`, `_`, `-`, never a leading dot. */
const SEGMENT = /^[\w-][\w.-]*$/u;

/** Which arm a sequence runs in. */
export interface ArmDescriptor {
  /** The lab's `--out` directory; arms live under `<out>/arms/`. */
  readonly out: string;
  /** The build's alias (`rc11`, `cand`), not its path. */
  readonly build: string;
  /** The arm's name (`A`, `B`, `C`, or a measured command's name). */
  readonly arm: string;
  readonly state: CacheMode;
}

/** An arm's directories, absolute. */
export interface ArmDirectories {
  readonly root: string;
  readonly store: string;
  readonly tmp: string;
  readonly home: string;
}

/** Characters of a short commit in a build alias. */
const SHORT_COMMIT_LENGTH = 7;

/**
 * A build's alias for its arm directories, from its coordinate: the version, and
 * for a checkout the short commit too, so two checkouts of one version keep
 * separate warm stores.
 *
 * @param version - The instrument's coordinate
 * @returns A plain directory-name segment
 */
export function buildAlias(version: InstrumentVersion): string {
  const raw = version.commit === null ? version.version : `${version.version}-${version.commit.slice(0, SHORT_COMMIT_LENGTH)}`;
  return raw.replaceAll(/[^\w.-]/gu, '-').replace(/^\.+/u, '');
}

/**
 * @param descriptor - The arm
 * @returns Its directories; nothing is created
 * @throws {Error} when the build or arm name is not a plain directory-name segment
 */
export function armDirectories(descriptor: ArmDescriptor): ArmDirectories {
  for (const [field, value] of [['build', descriptor.build], ['arm', descriptor.arm]] as const) {
    if (!SEGMENT.test(value)) {
      throw new Error(`arm directories: ${field} '${value}' is not a plain directory-name segment`);
    }
  }
  return armDirectoriesAt(
    safePath.join(descriptor.out, 'arms', `${descriptor.build}-${descriptor.arm}-${descriptor.state}`),
  );
}

/**
 * @param root - A directory to lay an arm out under
 * @returns The arm's directories under `root`; nothing is created
 */
export function armDirectoriesAt(root: string): ArmDirectories {
  return {
    root,
    store: safePath.join(root, 'store'),
    tmp: safePath.join(root, 'tmp'),
    home: safePath.join(root, 'home'),
  };
}

/**
 * Create the arm directory and its `tmp/` at 0700, before the first run. The
 * store is left for VAT.
 *
 * @param dirs - The arm's directories
 */
export function prepareArmDirectories(dirs: ArmDirectories): void {
  makePrivate(dirs.root);
  makePrivate(dirs.tmp);
}

/**
 * Delete and re-create the arm's home, empty, at 0700 — before each sequence,
 * so nothing one sequence wrote there (a Claude config, a git config) reaches
 * the next.
 *
 * @param dirs - The arm's directories
 */
export async function resetArmHome(dirs: ArmDirectories): Promise<void> {
  await removeArmTrees([dirs.home], 'arm home');
  makePrivate(dirs.home);
}

/**
 * Make a cold arm cold: delete its store, empty its `tmp/`, and assert both.
 *
 * @param dirs - The arm's directories
 * @returns `null`, or the violation that fails the measurement
 */
export async function resetColdArm(dirs: ArmDirectories): Promise<string | null> {
  await removeArmTrees([dirs.store, dirs.tmp], 'cold arm store and tmp');
  makePrivate(dirs.tmp);
  if (entriesOf(dirs.store).length > 0) return `cold rule: the store '${dirs.store}' is not empty before the sequence`;
  if (entriesOf(dirs.tmp).length > 0) return `cold rule: tmp '${dirs.tmp}' is not empty before the sequence`;
  return null;
}

/**
 * What a VAT step of this arm sets: its store, its temp directory and its home.
 *
 * @param dirs - The arm's directories
 * @param platform - Whose home variable to set as well (`USERPROFILE` on Windows)
 * @returns The variables to set
 */
export function armDirectoryEnvironment(dirs: ArmDirectories, platform: NodeJS.Platform): ArmEnvironment {
  return {
    set: {
      VAT_PROJECTION_STORE_DIR: dirs.store,
      TMPDIR: dirs.tmp,
      TEMP: dirs.tmp,
      TMP: dirs.tmp,
      HOME: dirs.home,
      CLAUDE_CONFIG_DIR: dirs.home,
      ...(platform === 'win32' ? { USERPROFILE: dirs.home } : {}),
    },
    unset: [],
  };
}

/** The variables {@link armDirectoryEnvironment} owns; a caller's own environment may not name one. */
export const ARM_DIRECTORY_ENV_KEYS: readonly string[] = Object.freeze([
  'VAT_PROJECTION_STORE_DIR',
  'TMPDIR',
  'TEMP',
  'TMP',
  'HOME',
  'CLAUDE_CONFIG_DIR',
  'USERPROFILE',
]);

/**
 * @param dir - A directory
 * @returns Its entries, typed by `lstat` (a link is never followed), or none when it does not exist
 * @throws {Error} when the OS refuses to list it for any other reason
 */
export function entriesOf(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error: unknown) {
    if (isPathAbsentError(error)) return [];
    throw error;
  }
}

/**
 * Remove trees the arm owns outright, through the one tree-change protocol.
 *
 * @param dests - The arm's own directories; an absent one is left as it is
 * @param label - What they are, in any failure
 */
async function removeArmTrees(dests: readonly string[], label: string): Promise<void> {
  const plan = await planTreeChanges(dests.map((dest) => ({ op: 'remove' as const, dest, ownership: { kind: 'vat-state' as const }, label })));
  await applyTreePlan(plan);
}

/**
 * Create a directory (and missing parents) and force it to 0700, whatever the umask.
 *
 * @param dir - The directory
 */
function makePrivate(dir: string): void {
  mkdirSyncReal(dir, { recursive: true, mode: PRIVATE_MODE });
  chmodSync(dir, PRIVATE_MODE);
}
