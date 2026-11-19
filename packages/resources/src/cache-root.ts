/**
 * Where VAT keeps its persistable cache, and how a directory is recognised as
 * that cache before anything deletes it.
 *
 * ## One variable, one directory, two tenants
 *
 * `VAT_CACHE_DIR` names the directory that holds exactly the **parse cache**
 * and the **projection store**, both under the per-build namespace
 * (`<root>/<namespace>/parse/`, `<root>/<namespace>/projection-<shape>/`).
 * Unset (or empty) it is `<normalizedTmpdir()>/.vat-cache`. A relative value is
 * resolved against the current directory of the process that reads it.
 *
 * It exists so CI can save and restore the cache. Every tier lives under VAT's
 * build namespace, so another VAT build never reads it; within a build each
 * tier has its own key. The parse cache and the store's blob tier are keyed by
 * file content, so they hit on any machine that holds the same bytes. The
 * store's extent (which files a scan saw) is keyed by the scanned root's
 * identity and path, so it misses when the checkout moves or the line endings
 * change the bytes. That is by design: line endings are not semantic, and a
 * miss is only a cold scan, never a wrong answer.
 *
 * ## What is deliberately NOT in it
 *
 * The external-link verdict caches (`external-links.json`, and
 * `auth-<osUser>/external-links.json`) are facts about the network at the time
 * of the check, with a 24 h TTL. Persisting them across CI runs would carry
 * day-old "this link is alive" verdicts into a run that should re-check, so they
 * live in a sibling temp directory, {@link vatLinkCacheDirectory}, which
 * `VAT_CACHE_DIR` never moves.
 *
 * ## Recognising the directory before deleting it
 *
 * `vat cache clear` and `vat cache prune` delete under this root. With a fixed
 * `<tmpdir>/.vat-cache` the name alone was the guard; with an operator-chosen
 * directory of any name it cannot be. The guard is therefore a **tag file VAT
 * writes itself**: `CACHEDIR.TAG` in the Cache Directory Tagging format
 * (https://bford.info/cachedir/, so backup tools skip it too), carrying a
 * VAT-specific comment line. Another tool's `CACHEDIR.TAG` (cargo's `target/`,
 * for one) does not have that line and is refused.
 *
 * VAT tags a root only when it creates it or finds it **empty** — never a
 * directory that already holds something. Pointing `VAT_CACHE_DIR` at a
 * working directory that already held files therefore leaves it untagged, and
 * a clear of it refuses. An EMPTY directory is tagged on first use, after which
 * VAT owns it: `VAT_CACHE_DIR` must name a directory used only by VAT.
 *
 * The default location is the one exception: it is recognised by where it is,
 * because trees written by older VAT releases carry no tag — but only when it
 * is a real directory (never a symbolic link) and, on POSIX, owned by this
 * user. On a shared `/tmp` anyone can create `<tmpdir>/.vat-cache`; a link
 * planted there must not lend its target the default location's standing, so
 * such a root is refused and never tagged. Only an exact spelling of the
 * default path is granted; case-folding is used only to refuse.
 *
 * Whatever the tag says, a root that is the filesystem root, the home
 * directory, the temp directory itself, or that contains the current directory
 * is always refused.
 */

import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

import {
  decodeTextContent,
  isAlreadyExistsError,
  isPathAbsentError,
  isUnderRoot,
  mkdirSyncReal,
  normalizedTmpdir,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';

/** The environment variable naming the persistable cache directory. */
export const VAT_CACHE_DIR_ENV = 'VAT_CACHE_DIR';

/** The tag file's name, fixed by the Cache Directory Tagging specification. */
export const VAT_CACHE_TAG_FILE = 'CACHEDIR.TAG';

/** The specification's signature line: every conforming tag starts with it. */
const CACHEDIR_SIGNATURE = 'Signature: 8a477f597d28d172789f06886806bc55';

/** The line that makes a tag VAT's own rather than any tool's. */
const VAT_TAG_LINE = '# This file is a cache directory tag created by vibe-agent-toolkit (VAT).';

/** What VAT writes into {@link VAT_CACHE_TAG_FILE}. */
const VAT_TAG_CONTENT = [
  CACHEDIR_SIGNATURE,
  VAT_TAG_LINE,
  '# vat cache clear deletes this whole directory; vat cache prune deletes what this VAT build does not use.',
  '# For information about cache directory tags, see https://bford.info/cachedir/',
  '',
].join('\n');

/** Directory 0o700: the caches hold link text, headings and frontmatter from possibly private corpora. */
const CACHE_ROOT_MODE = 0o700;

/** Roots this process has already marked, so a tag is checked once per root per process. */
const marked = new Set<string>();

/**
 * The default persistable cache root, `<normalizedTmpdir()>/.vat-cache`.
 *
 * @returns Absolute path, forward-slashed
 */
function defaultVatCacheRoot(): string {
  return safePath.join(normalizedTmpdir(), '.vat-cache');
}

/**
 * Root of VAT's persistable cache: `VAT_CACHE_DIR` when set and non-empty,
 * resolved against the current directory when relative; otherwise
 * `<normalizedTmpdir()>/.vat-cache`.
 *
 * Read from the environment on every call, so a test or a harness that sets
 * the variable later is honoured.
 *
 * @returns Absolute path, forward-slashed
 */
export function vatCacheRoot(): string {
  const configured = process.env[VAT_CACHE_DIR_ENV];
  if (configured === undefined || configured === '') return defaultVatCacheRoot();
  return safePath.resolve(configured);
}

/**
 * Where the external-link verdict caches live: `<normalizedTmpdir()>/.vat-link-cache`.
 *
 * Never under {@link vatCacheRoot}, so persisting `VAT_CACHE_DIR` never carries
 * link verdicts. See this module's header.
 *
 * @returns Absolute path, forward-slashed
 */
export function vatLinkCacheDirectory(): string {
  return safePath.join(normalizedTmpdir(), '.vat-link-cache');
}

/** How a candidate cache root was judged. */
export type CacheRootRecognition =
  | { readonly kind: 'absent' }
  | { readonly kind: 'recognised'; readonly by: 'tag' | 'default-location' }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Two paths name the same place, compared case-insensitively. Used only to REFUSE.
 *
 * Over-matching on a case-sensitive filesystem only refuses more, which is the
 * safe direction for a guard in front of a recursive delete.
 */
function samePath(left: string, right: string): boolean {
  return toForwardSlash(safePath.resolve(left)).toLowerCase() === toForwardSlash(safePath.resolve(right)).toLowerCase();
}

/**
 * Why `root` may never be treated as a cache, whatever it holds — or `undefined`.
 *
 * @param root - Absolute candidate root
 * @returns The reason, or `undefined` when the location itself is acceptable
 */
function protectedLocationReason(root: string): string | undefined {
  if (samePath(root, safePath.resolve(root, '..'))) return 'it is the filesystem root';
  if (samePath(root, homedir())) return 'it is the home directory';
  if (samePath(root, normalizedTmpdir())) return 'it is the temp directory itself';
  const cwd = process.cwd();
  if (samePath(root, cwd) || containsPath(root, cwd)) return `it contains the current directory (${toForwardSlash(cwd)})`;
  return undefined;
}

/**
 * Whether `child` is inside `ancestor`: lexically (case-insensitive), or as the
 * filesystem resolves the two (a symlinked temp dir). A filesystem probe the OS
 * refuses only drops the second answer: the root it was asked about is then
 * judged by the lexical one, and the delete that follows meets the refusal
 * itself and reports it as the fault it is.
 */
function containsPath(ancestor: string, child: string): boolean {
  const lexicalAncestor = `${toForwardSlash(safePath.resolve(ancestor)).toLowerCase().replace(/\/$/u, '')}/`;
  if (toForwardSlash(safePath.resolve(child)).toLowerCase().startsWith(lexicalAncestor)) return true;
  try {
    return isUnderRoot(ancestor, child) === 'inside';
  } catch (error) {
    // An OS refusal only drops the filesystem answer — see the docstring. Anything else is a defect.
    if (isSystemError(error)) return false;
    throw error;
  }
}

/** Whether `error` is one the OS raised (it carries an errno `code`), as opposed to a defect in VAT. */
function isSystemError(error: unknown): boolean {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
}

/**
 * Whether `root` holds VAT's own tag. Absent or unreadable reads as untagged:
 * the answer only ever withholds recognition, never grants it.
 */
function hasVatTag(root: string): boolean {
  let content: string;
  try {
    content = decodeTextContent(readFileSync(safePath.join(root, VAT_CACHE_TAG_FILE))).text;
  } catch (error) {
    // Unreadable (absent, a directory, refused) withholds recognition; anything else is a defect.
    if (isSystemError(error)) return false;
    throw error;
  }
  return content.startsWith(`${CACHEDIR_SIGNATURE}\n`) && content.split('\n').includes(VAT_TAG_LINE);
}

/** Whether anything is at `root` at all, without following a link. */
function entryPresent(root: string): boolean {
  try {
    lstatSync(root);
    return true;
  } catch (error) {
    // Present but not statable (a permission refusal): there is something
    // there, and the checks that follow decide what it is.
    return !isPathAbsentError(error);
  }
}

/** Whether `root` is, spelled exactly, the default location. Case is never folded to GRANT. */
function isDefaultLocation(root: string): boolean {
  return toForwardSlash(safePath.resolve(root)) === defaultVatCacheRoot();
}

/**
 * Why the default location may not be trusted untagged — or `undefined` when
 * it is a real directory this user owns. See the header: anyone can create
 * `<tmpdir>/.vat-cache` on a shared temp directory.
 */
function defaultLocationHazard(root: string): string | undefined {
  let stats;
  try {
    stats = lstatSync(root);
  } catch (error) {
    if (isPathAbsentError(error)) return undefined;
    if (isSystemError(error)) return 'its type and owner cannot be read';
    throw error;
  }
  if (stats.isSymbolicLink()) return 'it is a symbolic link, and the default location must be a real directory';
  if (!stats.isDirectory()) return 'it is not a directory';
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) return `it is owned by another user (uid ${stats.uid})`;
  return undefined;
}

/**
 * Judge whether `root` is recognisably VAT's cache, so it may be deleted from.
 *
 * Recognised: a root holding VAT's tag, or the default location (see the
 * header). Refused: a protected location, anything else untagged, and a root
 * holding another tool's tag. Absent: nothing there.
 *
 * @param root - Absolute candidate root
 * @returns The judgement; a refusal carries a sentence naming why
 */
export function recogniseVatCacheRoot(root: string): CacheRootRecognition {
  const protectedReason = protectedLocationReason(root);
  if (protectedReason !== undefined) return { kind: 'refused', reason: `${toForwardSlash(root)} is not a cache directory: ${protectedReason}.` };
  if (!entryPresent(root)) return { kind: 'absent' };
  const isDefault = isDefaultLocation(root);
  if (isDefault) {
    const hazard = defaultLocationHazard(root);
    if (hazard !== undefined) return { kind: 'refused', reason: `${toForwardSlash(root)} is not a cache directory VAT will delete from: ${hazard}.` };
  }
  if (hasVatTag(root)) return { kind: 'recognised', by: 'tag' };
  if (isDefault) return { kind: 'recognised', by: 'default-location' };
  return {
    kind: 'refused',
    reason: `${toForwardSlash(root)} is not recognisably a VAT cache: it has no ${VAT_CACHE_TAG_FILE} written by VAT. `
      + 'VAT tags a cache directory only when it creates it or finds it empty, so a directory that already held other files is never deleted. '
      + `Point ${VAT_CACHE_DIR_ENV} at a directory used only by VAT, or delete this one yourself.`,
  };
}

/**
 * Create the persistable cache root if absent and tag it — when it is safe to.
 *
 * Tags a root it creates, an empty one, and the default location; never a
 * non-empty untagged directory, and never a protected location. Best-effort:
 * a root that cannot be created or tagged is left as it is, and the cache write
 * that follows fails (fail-soft) in its own words; an untagged root only means
 * `vat cache clear` and `prune` refuse it. Checked once per root per process.
 */
export function markVatCacheRoot(): void {
  const root = vatCacheRoot();
  if (marked.has(root)) return;
  marked.add(root);
  if (protectedLocationReason(root) !== undefined) return;
  try {
    mkdirSyncReal(root, { recursive: true, mode: CACHE_ROOT_MODE });
    const isDefault = isDefaultLocation(root);
    if (isDefault && defaultLocationHazard(root) !== undefined) return;
    if (hasVatTag(root)) return;
    const tagless = readdirSync(root);
    if (tagless.length > 0 && !isDefault) return;
    // Known race, accepted: another process can write into the directory between the
    // empty listing above and the tag write below. The window is one syscall wide, and
    // closing it would need a lock no other tool honours.
    writeFileSync(safePath.join(root, VAT_CACHE_TAG_FILE), VAT_TAG_CONTENT, { encoding: 'utf-8', flag: 'wx' });
  } catch (error) {
    // Another process tagged it first: the same bytes are there.
    if (isAlreadyExistsError(error)) return;
    // Best-effort by design — see the docstring.
  }
}
