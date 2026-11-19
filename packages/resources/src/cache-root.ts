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
 * It exists so CI can save and restore the cache per runner kind: both tenants
 * are keyed by content and by VAT's own build, so a restored directory is a
 * hit when the inputs match and a miss when they do not — a cache written on
 * another machine kind is simply cold, never wrong.
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
 * directory that already holds something — so pointing `VAT_CACHE_DIR` at a
 * working directory by mistake leaves that directory untagged, and a clear of
 * it refuses rather than deleting someone's work. The default location is the
 * one exception: it is recognised by where it is, because trees written by
 * older VAT releases carry no tag.
 *
 * Whatever the tag says, a root that is the filesystem root, the home
 * directory, the temp directory itself, or that contains the current directory
 * is always refused.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
 * Two paths name the same place, compared case-insensitively.
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
    readdirSync(root);
    return true;
  } catch (error) {
    // Present but not listable (a file, a link to one, a permission refusal):
    // there is something there, and the tag check decides what it is.
    return !isPathAbsentError(error);
  }
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
  if (hasVatTag(root)) return { kind: 'recognised', by: 'tag' };
  if (samePath(root, defaultVatCacheRoot())) return { kind: 'recognised', by: 'default-location' };
  return {
    kind: 'refused',
    reason: `${toForwardSlash(root)} is not recognisably a VAT cache: it has no ${VAT_CACHE_TAG_FILE} written by VAT. `
      + 'VAT tags a cache directory only when it creates it or finds it empty, so a directory that already held other files is never deleted. '
      + `Point ${VAT_CACHE_DIR_ENV} at a new or empty directory, or delete this one yourself.`,
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
    if (hasVatTag(root)) return;
    const tagless = readdirSync(root);
    if (tagless.length > 0 && !samePath(root, defaultVatCacheRoot())) return;
    writeFileSync(safePath.join(root, VAT_CACHE_TAG_FILE), VAT_TAG_CONTENT, { encoding: 'utf-8', flag: 'wx' });
  } catch (error) {
    // Another process tagged it first: the same bytes are there.
    if (isAlreadyExistsError(error)) return;
    // Best-effort by design — see the docstring.
  }
}
