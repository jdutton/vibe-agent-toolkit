/**
 * One timed arm's private directories, and the resets its sequence rule needs.
 *
 * Every (build, arm, cache state) gets `<out>/arms/<build>-<arm>-<state>/` with
 * three children:
 *
 * - `store/` — `VAT_PROJECTION_STORE_DIR`. Left for VAT to create, so "the
 *   first step wrote a store" can be observed.
 * - `tmp/` — `TMPDIR`, `TEMP` and `TMP`, so each build's parse cache is private
 *   to the arm too.
 * - `home/` — `HOME` and `CLAUDE_CONFIG_DIR` (and `USERPROFILE` on Windows).
 *   Pointed, not stripped: with `CLAUDE_CONFIG_DIR` unset VAT falls back to
 *   `HOME`, and `~/` imports resolve through `homedir()`, so a stripped variable
 *   would hand the arm the developer's real `~/.claude`.
 *
 * ## The lab deletes and chmods only what it provably made
 *
 * - **Absolute, always.** A relative root would be resolved by each child from
 *   ITS cwd — the subject — while the lab resets its own; the arm would run
 *   warm, inside the measured tree. Every root is refused unless absolute.
 * - **Marked at creation.** The lab writes {@link ARM_MARKER} into an arm
 *   directory the moment it creates it, and refuses to reset, chmod or reuse an
 *   existing directory that lacks it: an `--out` that happens to name a real
 *   checkout is refused, never emptied.
 * - **No links.** Each component the lab owns (`<out>/arms`, the arm directory,
 *   its `store/`, `tmp/`, `home/`) is `lstat`ed; a link is refused, so no chmod or
 *   delete is ever carried to its target.
 * - **Never in a subject.** {@link armPlacementRefusal} is the one test every
 *   facet applies: an arm directory may neither be, lie inside, nor contain a
 *   measured tree.
 *
 * The lab never runs `vat cache clear` and never touches the developer's default
 * store: a cold arm is made cold by deleting its own directories.
 */

import { chmodSync, type Dirent, lstatSync, readdirSync, writeFileSync } from 'node:fs';

import {
  applyTreePlan,
  canonicalPath,
  isAbsolutePath,
  isPathAbsentError,
  isUnderRoot,
  mkdirSyncReal,
  type Ownership,
  planTreeChanges,
  safePath,
  VatError,
} from '@vibe-agent-toolkit/utils';

import type { InstrumentVersion } from '../envelope/coordinate.js';

import { type ArmEnvironment, clearedEnvironment, mergeArmEnvironments } from './arm-env.js';
import type { CacheMode } from './types.js';

/** The code of every refusal to lay out, reset or place an arm — what a CLI dispatches on. */
export const ARM_REFUSED_CODE = 'LAB_ARM_REFUSED';

/** The file the lab writes into every arm directory it creates; its absence means "not ours". */
const ARM_MARKER = '.vat-lab-arm';

/** Owner-only: an arm's directories hold a store and caches no one else should read or plant. */
const PRIVATE_MODE = 0o700;

/** A directory-name segment: letters, digits, `.`, `_`, `-`, never a leading dot. */
const SEGMENT = /^[\w-][\w.-]*$/u;

/** Which arm a sequence runs in. */
export interface ArmDescriptor {
  /** The lab's `--out` directory, absolute; arms live under `<out>/arms/`. */
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
  /** Every directory above the children that the lab owns, outermost first; each must be a real directory. */
  readonly owned: readonly string[];
}

/** Characters of a short commit in a build alias. */
const SHORT_COMMIT_LENGTH = 7;

/**
 * @param message - What was refused, and why
 * @returns The refusal, coded {@link ARM_REFUSED_CODE}
 */
export function armRefusal(message: string): VatError {
  return new VatError(ARM_REFUSED_CODE, message);
}

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
 * @throws {VatError} {@link ARM_REFUSED_CODE} when `out` is not absolute, or the
 *   build or arm name is not a plain directory-name segment
 */
export function armDirectories(descriptor: ArmDescriptor): ArmDirectories {
  requireAbsolute(descriptor.out, '--out');
  for (const [field, value] of [['build', descriptor.build], ['arm', descriptor.arm]] as const) {
    if (!SEGMENT.test(value)) {
      throw armRefusal(`arm directories: ${field} '${value}' is not a plain directory-name segment`);
    }
  }
  const arms = safePath.join(descriptor.out, 'arms');
  return layout(safePath.join(arms, `${descriptor.build}-${descriptor.arm}-${descriptor.state}`), [arms]);
}

/**
 * @param root - A directory to lay an arm out under, absolute
 * @returns The arm's directories under `root`; nothing is created
 * @throws {VatError} {@link ARM_REFUSED_CODE} when `root` is not absolute
 */
export function armDirectoriesAt(root: string): ArmDirectories {
  requireAbsolute(root, 'an arm directory');
  return layout(root, []);
}

/**
 * Where an arm directory may not be: equal to a subject, inside one, or
 * containing one. Lab output inside a measured tree changes the next
 * measurement, and an arm directory that IS a checkout is one reset away from
 * deleting it.
 *
 * @param dir - An arm directory (or `--out`) the lab is about to write under
 * @param subjects - Every tree the run measures
 * @returns The refusal, or `null`
 */
export function armPlacementRefusal(dir: string, subjects: readonly string[]): string | null {
  for (const subject of subjects) {
    // The subject is the operator's own tree: its own path is the edge it is judged from.
    if (canonicalPath(subject, subject) === canonicalPath(dir, subject)) {
      return `'${dir}' is the subject '${subject}' itself; the lab's directories must lie outside every measured tree`;
    }
    if (isUnderRoot(subject, dir) !== 'outside') {
      return `'${dir}' lies inside the subject '${subject}'; the lab's directories must lie outside every measured tree`;
    }
    if (isUnderRoot(dir, subject) !== 'outside') {
      return `'${dir}' contains the subject '${subject}'; the lab's directories must lie outside every measured tree`;
    }
  }
  return null;
}

/**
 * Create the arm directory — marked as the lab's — and its `tmp/` at 0700,
 * before the first run; or confirm an existing one is the lab's. The store is
 * left for VAT.
 *
 * @param dirs - The arm's directories
 * @throws {VatError} {@link ARM_REFUSED_CODE} when a component is a link, or
 *   the arm directory exists without the lab's marker
 */
export function prepareArmDirectories(dirs: ArmDirectories): void {
  requireNoLinks(dirs);
  if (kindOf(dirs.root) === 'absent') {
    makePrivate(dirs.root);
    writeFileSync(safePath.join(dirs.root, ARM_MARKER), 'vat-lab arm directory\n', { flag: 'wx' });
  } else {
    requireMarked(dirs);
  }
  makePrivate(dirs.tmp);
}

/**
 * Delete and re-create the arm's home, empty, at 0700 — before each sequence,
 * so nothing one sequence wrote there (a Claude config, a git config) reaches
 * the next.
 *
 * @param dirs - The arm's directories, prepared by {@link prepareArmDirectories}
 * @throws {VatError} {@link ARM_REFUSED_CODE} when the arm is not provably the lab's
 */
export async function resetArmHome(dirs: ArmDirectories): Promise<void> {
  await removeArmTrees(dirs, [dirs.home], 'arm home');
  makePrivate(dirs.home);
}

/**
 * Make a cold arm cold: delete its store, empty its `tmp/`, and assert both.
 *
 * @param dirs - The arm's directories, prepared by {@link prepareArmDirectories}
 * @returns `null`, or the violation that fails the measurement
 * @throws {VatError} {@link ARM_REFUSED_CODE} when the arm is not provably the lab's
 */
export async function resetColdArm(dirs: ArmDirectories): Promise<string | null> {
  await removeArmTrees(dirs, [dirs.store, dirs.tmp], 'cold arm store and tmp');
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

/**
 * The one environment every VAT-kind child of an arm runs under — its timed and
 * untimed VAT steps, and the git that prepares and proves its clone: the
 * developer's environment cleared of VAT, git and Claude state, then the arm's
 * directories, then what the caller sets.
 *
 * @param dirs - The arm's directories
 * @param own - What the caller sets and removes on top
 * @returns The environment, and the inherited names it removed
 */
export function armStepEnvironment(
  dirs: ArmDirectories,
  own: ArmEnvironment,
): { readonly env: ArmEnvironment; readonly removed: readonly string[] } {
  return clearedEnvironment(
    process.env,
    'vat',
    mergeArmEnvironments(armDirectoryEnvironment(dirs, process.platform), own),
    process.platform,
  );
}

/**
 * The inherited names every VAT step of an arm run under `own` goes without —
 * what a facet's report records. It is {@link armStepEnvironment}'s own
 * `removed`, which depends on the variables' NAMES alone, so any absolute arm
 * root yields it; the filesystem root is only joined, never touched.
 *
 * @param own - The caller's arm environment
 * @returns The removed names, sorted
 */
export function armRemovedEnv(own: ArmEnvironment): readonly string[] {
  return armStepEnvironment(armDirectoriesAt(safePath.resolve('/')), own).removed;
}

/**
 * @param env - A caller's arm environment
 * @returns The refusal naming the first variable {@link armDirectoryEnvironment} owns that it sets or unsets, or `null`
 */
export function armOwnedEnvRefusal(env: ArmEnvironment): string | null {
  const owned = armDirectoryEnvKeys().find((key) => Object.hasOwn(env.set, key) || env.unset.includes(key));
  return owned === undefined
    ? null
    : `${owned} is set by the lab itself on every arm (a private projection store, temp directory and home under --out); an arm cannot choose it`;
}

/**
 * The variables {@link armDirectoryEnvironment} owns on ANY platform (Windows
 * owns the most), read off the function itself so no second list can drift.
 *
 * @returns Their names
 */
function armDirectoryEnvKeys(): readonly string[] {
  return Object.keys(armDirectoryEnvironment(armDirectoriesAt(safePath.resolve('/')), 'win32').set);
}

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
 * Remove trees of an arm the lab provably made, through the one tree-change protocol.
 *
 * @param dirs - The arm
 * @param dests - Its own children; an absent one is left as it is
 * @param label - What they are, in any failure
 */
async function removeArmTrees(dirs: ArmDirectories, dests: readonly string[], label: string): Promise<void> {
  requireNoLinks(dirs);
  requireMarked(dirs);
  // The primitive's own gate, on the same fact: only a child of a marked arm is the lab's.
  const ownership: Ownership = {
    kind: 'vat-made',
    recognise: () => (isMarked(dirs.root) ? { owned: true } : { owned: false, reason: `'${dirs.root}' carries no ${ARM_MARKER}` }),
  };
  await applyTreePlan(await planTreeChanges(dests.map((dest) => ({ op: 'remove' as const, dest, ownership, label }))));
}

/**
 * @param path - A path
 * @param what - What it is, in the refusal
 * @throws {VatError} {@link ARM_REFUSED_CODE} when it is not absolute
 */
function requireAbsolute(path: string, what: string): void {
  if (!isAbsolutePath(path)) {
    throw armRefusal(`${what} '${path}' is not absolute: a child running in the subject would resolve it inside the subject`);
  }
}

/**
 * @param root - The arm directory
 * @param above - The lab-owned directories above it, outermost first
 * @returns The arm's directories under `root`, with every owned component
 */
function layout(root: string, above: readonly string[]): ArmDirectories {
  return {
    root,
    store: safePath.join(root, 'store'),
    tmp: safePath.join(root, 'tmp'),
    home: safePath.join(root, 'home'),
    owned: [...above, root],
  };
}

/** What `lstat` finds at a path — a link is never followed. */
function kindOf(path: string): 'absent' | 'directory' | 'link' | 'other' {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) return 'link';
    return stats.isDirectory() ? 'directory' : 'other';
  } catch (error: unknown) {
    if (isPathAbsentError(error)) return 'absent';
    throw error;
  }
}

/**
 * @param dirs - An arm
 * @throws {VatError} {@link ARM_REFUSED_CODE} when any component the lab owns is a link or not a directory
 */
function requireNoLinks(dirs: ArmDirectories): void {
  for (const path of [...dirs.owned, dirs.store, dirs.tmp, dirs.home]) {
    const kind = kindOf(path);
    if (kind === 'link' || kind === 'other') {
      throw armRefusal(`'${path}' is a ${kind === 'link' ? 'symbolic link' : 'non-directory'}; the lab never writes through a component it did not make`);
    }
  }
}

/** @returns Whether the lab's marker is in `root` */
function isMarked(root: string): boolean {
  return kindOf(safePath.join(root, ARM_MARKER)) === 'other';
}

/**
 * @param dirs - An existing arm
 * @throws {VatError} {@link ARM_REFUSED_CODE} when the lab's marker is missing
 */
function requireMarked(dirs: ArmDirectories): void {
  if (!isMarked(dirs.root)) {
    throw armRefusal(
      `'${dirs.root}' exists but carries no ${ARM_MARKER}: the lab did not make it, so it will neither reset nor chmod it. Choose a fresh --out.`,
    );
  }
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
