/**
 * Enumerate the documents an OKF bundle is judged over.
 *
 * ## Why this is a bare recursive walk and not `crawlDirectory`
 *
 * OKF's conformance population is **spec-defined and maximal**: §3.1 reserves
 * exactly `index.md` and `log.md` and then says *"All other `.md` files are
 * concept documents"*, and §11 requires every one of them to carry parseable
 * frontmatter with a non-empty `type`. Anything that narrows the walk is
 * therefore not an optimisation but a correctness hole — VAT would report a
 * clean bundle while a file it never opened broke conformance.
 *
 * `crawlDirectory` narrows in two ways that matter here. It answers from
 * `git ls-files` by default, so an untracked concept document is invisible (the
 * documented `git-route-hides-untracked` trap), and its `NEVER_CRAWL_GLOBS`
 * drop whole subtrees on a relevance judgement that has no standing inside a
 * bundle root. Neither is wrong for a project scan; both are wrong for this.
 *
 * So: `readdir` with `withFileTypes`, every directory, no excludes, no globs.
 * If a subtree must not be part of a bundle, it must not be under the bundle
 * root — see the `OkfBundleConfigSchema` docstring for the ruling.
 *
 * ## The two case rules point in opposite directions, deliberately
 *
 * Extension matching is case-**insensitive** (`.MD` counts) because that widens
 * the population — a file a consumer would read as markdown cannot slip past
 * the checks. Reserved-name matching is case-**sensitive** (`Index.md` is a
 * concept document) because being reserved *exempts* a file from those checks,
 * and an exemption inferred from a case fold is an exemption VAT invented.
 */

import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';

import { compareCodeUnits, safePath } from '@vibe-agent-toolkit/utils';

import { isWithinProject } from '../utils.js';

/**
 * The filenames §3.1 reserves, at any level of the hierarchy.
 *
 * Not a configuration surface: a bundle whose author repurposes `log.md` as a
 * concept is not an OKF bundle, so there is nothing to make adjustable.
 */
const RESERVED_FILENAMES: ReadonlySet<string> = new Set(['index.md', 'log.md']);

/**
 * The errno of a filesystem failure, and nothing else.
 *
 * ⚠️ The `Error.message` is deliberately NOT used: Node writes the full absolute
 * path into it (`ENOENT: … scandir '/Users/…/nowhere'`), which is the
 * home-directory leak the findings that quote this exist to avoid. The code says
 * what went wrong — absent, not a directory, not permitted — and the
 * bundle-relative path says where.
 *
 * @param error - Whatever the filesystem threw
 * @returns The errno string, or a neutral word when there is none
 */
export function fsErrorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'unreadable';
}

/** A `.md` entry whose bytes do not travel with the bundle, and why. */
export interface OkfUnpackableDocument {
  /** Bundle-relative, forward-slashed path of the entry. */
  document: string;
  /** `outside` — a symlink out of the root; `dangling` — a symlink to nothing. */
  reason: 'outside' | 'dangling';
}

/** A directory beneath the root that could not be listed. */
export interface OkfUnreadableDirectory {
  /** Bundle-relative, forward-slashed path of the directory. */
  directory: string;
  /** The errno, for the finding to quote without a path in it. */
  code: string;
}

/** The documents beneath a bundle root, split by what the spec makes of them. */
export interface OkfBundleFiles {
  /**
   * Every non-reserved `.md`, bundle-relative with forward slashes, sorted.
   * These are the documents §11's items 1 and 2 apply to.
   */
  conceptDocuments: string[];
  /**
   * Every `index.md` / `log.md`, bundle-relative with forward slashes, sorted.
   * Exempt from the concept-document requirement — but the bundle-root
   * `index.md` is still read, for the `okf_version` cross-check (§12).
   */
  reservedDocuments: string[];
  /**
   * Every `.md` entry that is NOT a bundle member, with the reason.
   *
   * Reported rather than silently dropped: a symlink out of the bundle is the
   * real defect (a member that does not travel), and silence about it is what
   * let the two lanes disagree in the first place.
   */
  unpackableDocuments: OkfUnpackableDocument[];
  /**
   * Every directory beneath the root that could not be listed.
   *
   * ⚠️ Collected rather than thrown, and that distinction is the whole fix for
   * the root-vs-subdirectory confusion: a throw from three levels down is
   * indistinguishable, at the caller, from a throw on the root itself. Only the
   * ROOT's own listing failure still propagates.
   */
  unreadableDirectories: OkfUnreadableDirectory[];
}

/** Whether a filename is markdown, judged case-insensitively (widens). */
function isMarkdownFilename(name: string): boolean {
  return name.toLowerCase().endsWith('.md');
}

/** What a `.md` symlink is, once followed. */
type SymlinkVerdict = 'member' | 'outside' | 'dangling' | 'not-a-file';

/**
 * Classify a symlinked `.md` entry: is it a bundle member, and if not, why not?
 *
 * ⛔ **A bundle member is a file whose BYTES live under the root**, judged by
 * the very predicate the link lane judges with (`isWithinProject`, which
 * realpaths). One predicate, so the two lanes cannot disagree — before this,
 * discovery admitted a symlinked `.md` into the population while `links.ts`
 * reported a link to that same file as escaping the bundle, and VAT called one
 * file both inside and outside at once.
 *
 * ⚠️ **The justification this replaced was false.** It said `stat` was right
 * because it is "the thing `tar` dereferences into the bundle" — but default
 * `tar -cf` stores a symlink AS a symlink; only `-h`/`--dereference` copies the
 * bytes. So the file whose conformance VAT reported arrives at the consumer as a
 * dangling link, and the real defect — a member that does not travel — was the
 * one thing never reported.
 *
 * @param root - Absolute bundle root
 * @param candidate - Absolute path of the symlink
 * @returns Whether it is a member, and the reason when it is not
 */
async function classifySymlink(root: string, candidate: string): Promise<SymlinkVerdict> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- an entry name read from a bundle root the adopter's own config named
    if (!(await stat(candidate)).isFile()) return 'not-a-file';
  } catch {
    // No target at all: nothing to pack, and nothing to parse either.
    return 'dangling';
  }

  return isWithinProject(candidate, root) ? 'member' : 'outside';
}

/** File this entry into the population it belongs to, by name. */
function record(root: string, absolute: string, name: string, found: OkfBundleFiles): void {
  const relative = safePath.relative(root, absolute);
  if (RESERVED_FILENAMES.has(name)) {
    found.reservedDocuments.push(relative);
  } else {
    found.conceptDocuments.push(relative);
  }
}

/**
 * Decide what one `.md` entry is, and record it.
 *
 * ⚠️ `isFile()` alone is FALSE for a symlink, because `readdir`'s Dirent is
 * built from `lstat`. Testing only that silently dropped every symlinked
 * concept document from the population — a §11.1 violation inside the root
 * reported as a conformant bundle.
 *
 * @param root - Absolute bundle root
 * @param absolute - Absolute path of the entry
 * @param entry - The Dirent `readdir` returned
 * @param found - Accumulators, mutated in place
 */
async function recordMarkdownEntry(
  root: string,
  absolute: string,
  entry: Dirent,
  found: OkfBundleFiles,
): Promise<void> {
  if (entry.isFile()) {
    record(root, absolute, entry.name, found);
    return;
  }

  // A socket, a fifo, a device: not a document and not a link to one.
  if (!entry.isSymbolicLink()) return;

  const verdict = await classifySymlink(root, absolute);
  if (verdict === 'member') {
    record(root, absolute, entry.name, found);
    return;
  }

  // A `.md` name pointing at a DIRECTORY is not a document by any reading, and
  // nothing downstream would know what to do with it. It is the doorway
  // {@link walkInto} deliberately does not walk through, wearing a markdown
  // extension, so it is dropped rather than reported.
  if (verdict === 'not-a-file') return;

  found.unpackableDocuments.push({ document: safePath.relative(root, absolute), reason: verdict });
}

/**
 * Walk one directory and everything beneath it, appending to the accumulators.
 *
 * Symlinked directories are not followed: a bundle is a distributable tree, and
 * a link out of it does not travel with the tarball. A symlinked *file* is read
 * like any other **when its bytes are under the root** — see
 * {@link classifySymlink} for why that qualifier is load-bearing.
 *
 * ⚠️ **A failure to list a SUBdirectory is recorded, not thrown.** Only the
 * root's own listing failure propagates, because that is the one a caller can
 * honestly report as "the configured root is unreadable". A throw from three
 * levels down is indistinguishable from it at the caller, and was reported as
 * one: an adopter was told to re-point `okf.bundles.<name>.root` at a root that
 * was perfectly readable, while the documents beside the bad subtree went
 * unjudged.
 *
 * @param root - Absolute bundle root, for computing relative paths
 * @param dir - Absolute directory to walk
 * @param found - Accumulators, mutated in place
 * @throws Only when `dir` IS the root and cannot be listed
 */
async function walkInto(root: string, dir: string, found: OkfBundleFiles): Promise<void> {
  let entries: Dirent[];
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a bundle root the adopter's own config named, plus directory names read from it
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (dir === root) throw error;
    found.unreadableDirectories.push({
      directory: safePath.relative(root, dir),
      code: fsErrorCode(error),
    });
    return;
  }

  for (const entry of entries) {
    const absolute = safePath.join(dir, entry.name);

    if (entry.isDirectory()) {
      await walkInto(root, absolute, found);
    } else if (isMarkdownFilename(entry.name)) {
      await recordMarkdownEntry(root, absolute, entry, found);
    }
  }
}

/**
 * Enumerate every markdown document beneath a bundle root.
 *
 * @param root - Absolute path to the bundle root
 * @returns Concept and reserved documents, bundle-relative and sorted, plus the
 *   entries that are not members and the subdirectories that could not be read
 * @throws If the ROOT itself cannot be read — an unreadable root is a finding
 *   about the configuration, never an empty (and therefore trivially
 *   conformant) bundle. A subdirectory failure is returned, not thrown
 */
export async function discoverOkfBundle(root: string): Promise<OkfBundleFiles> {
  const found: OkfBundleFiles = {
    conceptDocuments: [],
    reservedDocuments: [],
    unpackableDocuments: [],
    unreadableDirectories: [],
  };
  await walkInto(root, root, found);

  // `compareCodeUnits`, never a bare `.sort()`: order here is machine order, and
  // a locale collation would make two machines report the same bundle differently.
  found.conceptDocuments.sort(compareCodeUnits);
  found.reservedDocuments.sort(compareCodeUnits);
  return found;
}
