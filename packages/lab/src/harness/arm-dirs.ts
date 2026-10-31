/**
 * One timed arm's private directories, and the resets its sequence rule needs.
 *
 * Every (build, arm, cache state) gets `<arms root>/<build>-<arm>-<state>/`
 * with four children:
 *
 * - `store/` — `VAT_PROJECTION_STORE_DIR`. Left for VAT to create, so "the
 *   first step wrote a store" can be observed.
 * - `tmp/` — `TMPDIR`, `TEMP` and `TMP`, so each build's parse cache is private
 *   to the arm too.
 * - `home/` — `HOME` and `CLAUDE_CONFIG_DIR` (and `USERPROFILE` on Windows).
 *   Pointed, not stripped: with `CLAUDE_CONFIG_DIR` unset VAT falls back to
 *   `HOME`, and `~/` imports resolve through `homedir()`, so a stripped variable
 *   would hand the arm the developer's real `~/.claude`.
 * - `npm-cache/` — `npm_config_cache`, where an `npx` build keeps what it
 *   fetched. Never reset: the build's own bytes, fetched once in its untimed
 *   start, never in a timed repetition.
 *
 * ## The arms root lies outside every subject
 *
 * Reports go to `--out`; arm directories never do. {@link openArmsRoot} picks
 * one root per invocation — `--arms-dir` when given, else a fresh run directory
 * under `<os tmpdir>/vat-lab-arms-<user>/` — and refuses it when it is, lies
 * inside, or contains a measured tree. An `--out` inside the subject (the
 * default `.vat-lab` run from a checkout) therefore holds only reports, which
 * no measured command reads.
 *
 * ## The lab deletes and chmods only what it provably made
 *
 * - **Absolute, always.** A relative root would be resolved by each child from
 *   ITS cwd — the subject — while the lab resets its own; the arm would run
 *   warm, inside the measured tree. Every root is refused unless absolute.
 * - **Marked at creation.** The lab writes {@link ARM_MARKER} into an arm
 *   directory the moment it creates it, and refuses to reset, chmod or reuse an
 *   existing directory that lacks it: an `--arms-dir` that happens to name a
 *   real checkout is refused, never emptied.
 * - **No links.** Each component the lab owns (the arms root, the arm directory,
 *   its `store/`, `tmp/`, `home/`, `npm-cache/`) is `lstat`ed; a link is refused, so no chmod or
 *   delete is ever carried to its target.
 * - **Never in a subject.** {@link armPlacementRefusal} is the one test every
 *   facet applies: an arm directory may neither be, lie inside, nor contain a
 *   measured tree.
 * - **Chmodded only when created.** A directory the lab creates is narrowed to
 *   0700 through a descriptor opened without following links; one it finds is
 *   never chmodded. The arms root carries {@link ROOT_MARKER}: an existing,
 *   non-empty `--arms-dir` without it is refused, and {@link closeArmsRoot}
 *   removes only a marked default run directory. Every `--out` goes through
 *   {@link openOutDirectory}, and reports through {@link writePrivateFile}.
 *
 * The lab never runs `vat cache clear` and never touches the developer's default
 * store: a cold arm is made cold by deleting its own directories.
 */

import {
  closeSync,
  constants,
  type Dirent,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { userInfo } from 'node:os';

import {
  applyTreePlan,
  canonicalPath,
  isAbsolutePath,
  isPathAbsentError,
  isUnderRoot,
  mkdirSyncReal,
  normalizedTmpdir,
  type Ownership,
  planTreeChanges,
  safePath,
  VatError,
} from '@vibe-agent-toolkit/utils';

import type { InstrumentVersion } from '../envelope/coordinate.js';

import { type ArmEnvironment, clearedEnvironment, envNameSpelling, mergeArmEnvironments } from './arm-env.js';
import type { CacheMode } from './types.js';

/** The code of every refusal to lay out, reset or place an arm — what a CLI dispatches on. */
export const ARM_REFUSED_CODE = 'LAB_ARM_REFUSED';

/** The file the lab writes into every arm directory it creates; its absence means "not ours". */
const ARM_MARKER = '.vat-lab-arm';

/** The file the lab writes into every arms root it creates or adopts empty; its absence means "not ours". */
const ROOT_MARKER = '.vat-lab-root';

/** Owner-only, for a file the lab writes. */
const PRIVATE_FILE_MODE = 0o600;

/** Owner-only: an arm's directories hold a store and caches no one else should read or plant. */
const PRIVATE_MODE = 0o700;

/** A directory-name segment: letters, digits, `.`, `_`, `-`, never a leading dot. */
const SEGMENT = /^[\w-][\w.-]*$/u;

/** Which arm a sequence runs in. */
export interface ArmDescriptor {
  /** The invocation's arms root, absolute ({@link openArmsRoot}); the arm is a directory directly under it. */
  readonly root: string;
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
  /**
   * npm's cache (`npm_config_cache`), where an `npx` build keeps what it
   * fetched. Never reset: it holds the build's own bytes, not VAT's state, and
   * an emptied one would time a download in every repetition.
   */
  readonly npmCache: string;
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
  // The closure digest tells two builds of one version (two `dist:` directories) apart.
  const raw = [version.version, version.commit, version.closure]
    .flatMap((part, index) => (part === null ? [] : [index === 0 ? part : part.slice(0, SHORT_COMMIT_LENGTH)]))
    .join('-');
  return raw.replaceAll(/[^\w.-]/gu, '-').replace(/^\.+/u, '');
}

/**
 * @param descriptor - The arm
 * @returns Its directories; nothing is created
 * @throws {VatError} {@link ARM_REFUSED_CODE} when `root` is not absolute, or the
 *   build or arm name is not a plain directory-name segment
 */
export function armDirectories(descriptor: ArmDescriptor): ArmDirectories {
  requireAbsolute(descriptor.root, 'the arms root');
  for (const [field, value] of [['build', descriptor.build], ['arm', descriptor.arm]] as const) {
    if (!SEGMENT.test(value)) {
      throw armRefusal(`arm directories: ${field} '${value}' is not a plain directory-name segment`);
    }
  }
  return layout(safePath.join(descriptor.root, `${descriptor.build}-${descriptor.arm}-${descriptor.state}`), [descriptor.root]);
}

/** An invocation's arms root, and whether it is the lab's to remove when the capture ends. */
interface ArmsRoot {
  readonly path: string;
  /** True for the default fresh run directory; an `--arms-dir` the operator named is never removed. */
  readonly temporary: boolean;
}

/** What {@link openArmsRoot} needs. */
interface ArmsRootRequest {
  /** `--arms-dir`, as given; `null` for the default. */
  readonly override: string | null;
  /** Every tree the invocation measures. */
  readonly subjects: readonly string[];
}

/**
 * The one root every arm directory of an invocation lives under — never inside
 * a subject, and marked {@link ROOT_MARKER} as the lab's.
 *
 * `--arms-dir` when given: absolute, never a link, through
 * {@link openOwnedDirectory} — created owner-only when absent; an existing one
 * is used only when it carries the marker or is empty (then marked), and never
 * chmodded, because the lab did not create it. Otherwise a fresh `run-*`
 * directory under `<os tmpdir>/vat-lab-arms-<user>/`, whose base must be a real
 * directory this user owns that no one else can write into.
 *
 * @param request - See {@link ArmsRootRequest}
 * @returns The root; it exists and is marked
 * @throws {VatError} {@link ARM_REFUSED_CODE} when the root is relative, a link,
 *   not a directory, misplaced against a subject, an unmarked non-empty
 *   directory, or its default base is not provably this user's alone
 */
export function openArmsRoot(request: ArmsRootRequest): ArmsRoot {
  if (request.override !== null) {
    const override = request.override;
    const created = openOwnedDirectory(override, '--arms-dir', placementOf('the arms root', armPlacementRefusal(override, request.subjects)));
    if (created || (!isRootMarked(override) && entriesOf(override).length === 0)) writeMarker(override, ROOT_MARKER);
    if (!isRootMarked(override)) {
      throw armRefusal(
        `--arms-dir '${override}' is not empty and carries no ${ROOT_MARKER}: the lab did not make it, so it will neither write into nor chmod it. Choose a fresh or empty --arms-dir.`,
      );
    }
    return { path: override, temporary: false };
  }
  const base = safePath.join(normalizedTmpdir(), `vat-lab-arms-${userSegment()}`);
  requireDirectoryOrAbsent(base, 'the arms base');
  if (kindOf(base) === 'absent') createPrivateDirectory(base);
  requireOwnPrivate(base);
  const run = mkdtempSync(safePath.join(base, 'run-'));
  narrowToOwner(run);
  writeMarker(run, ROOT_MARKER);
  requirePlaced(run, request.subjects);
  return { path: run, temporary: true };
}

/**
 * End an invocation's arms root: remove a temporary one through the
 * marker-gated tree-change protocol, unless the caller keeps it; an
 * `--arms-dir` the operator named is always kept.
 *
 * @param root - From {@link openArmsRoot}
 * @param keep - `--keep-arms`
 * @returns What happened, naming the root, for the operator
 * @throws {VatError} {@link ARM_REFUSED_CODE} when a temporary root no longer carries its marker
 */
export async function closeArmsRoot(root: ArmsRoot, keep: boolean): Promise<string> {
  if (!root.temporary || keep) return `Kept arms under ${root.path}`;
  const ownership: Ownership = {
    kind: 'vat-made',
    recognise: () => (isRootMarked(root.path) ? { owned: true } : { owned: false, reason: `'${root.path}' carries no ${ROOT_MARKER}` }),
  };
  if (!isRootMarked(root.path)) {
    throw armRefusal(`'${root.path}' carries no ${ROOT_MARKER}: it is no longer provably the lab's, so it is left in place`);
  }
  await applyTreePlan(await planTreeChanges([{ op: 'remove', dest: root.path, ownership, label: 'arms root' }]));
  return `Removed arms under ${root.path}`;
}

/**
 * Open the directory a report is written into — the one gate every `--out`
 * goes through: absolute, never a link, never a subject itself (\`--out .\`
 * from the subject root), created owner-only only when the lab creates it.
 * An existing `--out` is written into and never chmodded. Reports may live
 * INSIDE a subject (the default `.vat-lab` from a checkout): no measured
 * command reads them.
 *
 * @param out - `--out`, absolute
 * @param subjects - Every tree the invocation measures
 * @returns `out`
 * @throws {VatError} {@link ARM_REFUSED_CODE} when it is refused
 */
export function openOutDirectory(out: string, subjects: readonly string[]): string {
  const itself = subjects.find((subject) => isSubjectItself(out, subject));
  openOwnedDirectory(out, '--out', itself === undefined ? null : `--out '${out}' is the subject '${itself}' itself; reports must not be written into the measured tree's root`);
  return out;
}

/**
 * Write a file owner-only, never through a link: opened `O_NOFOLLOW` (where the
 * platform has it), and narrowed through the descriptor, not the path.
 *
 * @param path - The file
 * @param content - Its content
 */
export function writePrivateFile(path: string, content: string): void {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags, PRIVATE_FILE_MODE);
  try {
    if (process.platform !== 'win32') fchmodSync(fd, PRIVATE_FILE_MODE);
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

/**
 * The one placement and ownership gate every `--out` and `--arms-dir` goes
 * through: absolute, placed, never a link or a non-directory, and created
 * owner-only when absent. An existing directory is left exactly as it is.
 *
 * @param path - The directory
 * @param what - Its flag, in any refusal
 * @param placement - The placement refusal for it, or `null`
 * @returns Whether the lab created it
 * @throws {VatError} {@link ARM_REFUSED_CODE} when it is refused
 */
function openOwnedDirectory(path: string, what: string, placement: string | null): boolean {
  requireAbsolute(path, what);
  if (placement !== null) throw armRefusal(placement);
  requireDirectoryOrAbsent(path, what);
  if (kindOf(path) !== 'absent') return false;
  createPrivateDirectory(path);
  return true;
}

/**
 * @param label - What the directory is
 * @param placement - A placement refusal, or `null`
 * @returns The refusal labelled, or `null`
 */
function placementOf(label: string, placement: string | null): string | null {
  return placement === null ? null : `${label}: ${placement}`;
}

/** @returns This user's directory-name segment: the uid where there is one, else the sanitised user name */
function userSegment(): string {
  const uid = process.getuid?.();
  return uid === undefined ? userInfo().username.replaceAll(/[^\w.-]/gu, '-') : String(uid);
}

/**
 * @param dir - The arms root
 * @param subjects - Every measured tree
 * @throws {VatError} {@link ARM_REFUSED_CODE} when {@link armPlacementRefusal} refuses it
 */
function requirePlaced(dir: string, subjects: readonly string[]): void {
  const placement = armPlacementRefusal(dir, subjects);
  if (placement !== null) throw armRefusal(`the arms root: ${placement}`);
}

/**
 * @param path - A directory the lab is about to create or use
 * @param what - What it is, in the refusal
 * @throws {VatError} {@link ARM_REFUSED_CODE} when it is a link or a non-directory
 */
function requireDirectoryOrAbsent(path: string, what: string): void {
  const kind = kindOf(path);
  if (kind === 'link' || kind === 'other') {
    throw armRefusal(`${what} '${path}' is a ${kind === 'link' ? 'symbolic link' : 'non-directory'}; the lab never writes through a component it did not make`);
  }
}

/**
 * The shared temp directory is everyone's: a base someone else made, or can
 * write into, could hold a planted run. Windows has no POSIX owner or mode
 * bits, so the check is POSIX-only there.
 *
 * @param base - The default arms base
 * @throws {VatError} {@link ARM_REFUSED_CODE} when it is not this user's, owner-only
 */
function requireOwnPrivate(base: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  const stats = lstatSync(base);
  if (stats.uid !== uid || (stats.mode & 0o077) !== 0) {
    throw armRefusal(`the arms base '${base}' is not owner-only and this user's (uid ${String(stats.uid)}, mode ${(stats.mode & 0o777).toString(8)}); remove it or pass --arms-dir`);
  }
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
    if (isSubjectItself(dir, subject)) {
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
 * @param dir - A directory
 * @param subject - A measured tree
 * @returns Whether `dir` IS the subject
 */
function isSubjectItself(dir: string, subject: string): boolean {
  // The subject is the operator's own tree: its own path is the edge it is judged from.
  return canonicalPath(subject, subject) === canonicalPath(dir, subject);
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
    createPrivateDirectory(dirs.root);
    writeMarker(dirs.root, ARM_MARKER);
  } else {
    requireMarked(dirs);
  }
  ensurePrivateChild(dirs.tmp);
  ensurePrivateChild(dirs.npmCache);
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
  ensurePrivateChild(dirs.home);
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
  ensurePrivateChild(dirs.tmp);
  if (entriesOf(dirs.store).length > 0) return `cold rule: the store '${dirs.store}' is not empty before the sequence`;
  if (entriesOf(dirs.tmp).length > 0) return `cold rule: tmp '${dirs.tmp}' is not empty before the sequence`;
  return null;
}

/**
 * What a VAT step of this arm sets: its store, its temp directory, its home and npm's cache.
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
      // No system config or attributes reach an arm's vat or the commands preparing its clone.
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ATTR_NOSYSTEM: '1',
      // An npx build fetches into the arm's own cache, once, and never asks the registry again.
      npm_config_cache: dirs.npmCache,
      npm_config_prefer_offline: 'true',
      npm_config_update_notifier: 'false',
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
 * @param env - A caller's arm environment
 * @returns The refusal naming the first variable {@link armDirectoryEnvironment} owns that it sets or unsets, or `null`
 */
export function armOwnedEnvRefusal(env: ArmEnvironment, platform: NodeJS.Platform = process.platform): string | null {
  const spell = envNameSpelling(platform);
  const ownedKeys = new Set(armDirectoryEnvKeys().map(spell));
  const owned = [...Object.keys(env.set), ...env.unset].find((name) => ownedKeys.has(spell(name)));
  return owned === undefined
    ? null
    : `${owned} is set by the lab itself on every arm (a private projection store, temp directory, home and npm cache under its arms root); an arm cannot choose it`;
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
    npmCache: safePath.join(root, 'npm-cache'),
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
  for (const path of [...dirs.owned, dirs.store, dirs.tmp, dirs.home, dirs.npmCache]) {
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
      `'${dirs.root}' exists but carries no ${ARM_MARKER}: the lab did not make it, so it will neither reset nor chmod it. Choose a fresh --arms-dir.`,
    );
  }
}

/** @returns Whether the lab's root marker is in `root` */
function isRootMarked(root: string): boolean {
  return kindOf(safePath.join(root, ROOT_MARKER)) === 'other';
}

/**
 * @param dir - A directory the lab just created or adopted empty
 * @param marker - Which marker
 */
function writeMarker(dir: string, marker: string): void {
  writeFileSync(safePath.join(dir, marker), 'vat-lab\n', { flag: 'wx', mode: PRIVATE_FILE_MODE });
}

/**
 * Create a directory the lab will own — its missing parents at the umask, the
 * directory itself exclusively (an existing one is a race, and refused) — then
 * narrow it to 0700 through {@link narrowToOwner}.
 *
 * @param dir - The directory, absent
 */
function createPrivateDirectory(dir: string): void {
  const parent = safePath.resolve(dir, '..');
  if (kindOf(parent) === 'absent') mkdirSyncReal(parent, { recursive: true });
  mkdirSyncReal(dir, { mode: PRIVATE_MODE });
  narrowToOwner(dir);
}

/**
 * A child of a marked arm (links already refused): create it owner-only, or
 * narrow the one the lab made before.
 *
 * @param dir - `tmp/`, `home/` or `npm-cache/`
 */
function ensurePrivateChild(dir: string): void {
  if (kindOf(dir) === 'absent') createPrivateDirectory(dir);
  else narrowToOwner(dir);
}

/**
 * Force a directory the lab just created to 0700, whatever the umask, through a
 * descriptor opened without following a link — so a directory swapped for a
 * link between the creation and the chmod fails closed, never carrying the
 * chmod to its target. Windows has no POSIX mode bits to narrow.
 *
 * @param dir - The directory
 * @throws {VatError} {@link ARM_REFUSED_CODE} when it is no longer a directory this user owns
 */
function narrowToOwner(dir: string): void {
  if (process.platform === 'win32') return;
  let fd: number;
  try {
      fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    throw armRefusal(`'${dir}' changed under the lab before it was made private (${String(error)}); nothing was chmodded`);
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isDirectory() || stats.uid !== process.getuid?.()) {
      throw armRefusal(`'${dir}' is not a directory this user owns; nothing was chmodded`);
    }
    fchmodSync(fd, PRIVATE_MODE);
  } finally {
    closeSync(fd);
  }
}
