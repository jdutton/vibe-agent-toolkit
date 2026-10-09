/**
 * Content fingerprints — one algorithm for every "are these the same bytes?"
 * question the lab asks.
 *
 * Two callers, two populations, one manifest construction: axis B's subject
 * fingerprint (`subject.ts`) and axis C's closure digest (`closure.ts`). They
 * share this module rather than each carrying a copy because the properties
 * below are the whole value of a fingerprint, and a copy is free to lose one:
 * a closure digest that sorted by locale, or skipped an unreadable file, would
 * call two different builds the same instrument.
 */

import { createHash } from 'node:crypto';

import { fileContentHash, isPathAbsentError, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { crawlDirectorySync } from '@vibe-agent-toolkit/utils/crawl';

/**
 * Separates the fields of one manifest record from the next.
 *
 * A NUL cannot occur in a path on any filesystem VAT supports, so the framing
 * is unambiguous: no two distinct file sets can produce the same byte stream by
 * a path that happens to contain the separator.
 */
const RECORD_SEPARATOR = Buffer.from([0]);

/**
 * Stands in for a file the population listed but that is not there — a
 * tracked file deleted from the working tree, or a dangling symlink.
 *
 * Recorded rather than skipped, and rather than allowed to throw. Throwing
 * would make one of the commonest dirty states of all (`rm` a tracked file)
 * crash the run, since `git ls-files` still lists a deleted-but-tracked path.
 * Skipping would drop the path from the manifest, which reads as "this file
 * never existed" rather than "this file is gone". It cannot collide with a real
 * digest, which is always 64 hex characters.
 *
 * Absence is the ONLY case it stands in for. A file that is there but cannot
 * be read (a permission denial) throws instead — see {@link contentDigest}.
 */
const ABSENT = '<absent>';

/**
 * What a fingerprint covers.
 *
 * The manifest construction is identical for every scope — same crawl, same
 * sorted order, same content hashing — and only the *population* differs,
 * which is why this is a parameter rather than a second algorithm.
 */
export interface FingerprintScope {
  /**
   * Take git's own population (tracked, plus untracked-but-not-ignored) rather
   * than walking the filesystem.
   *
   * This is not an optimisation. It is what makes the subject's
   * `workingFingerprint` cohere with `dirty`: `git status --porcelain` decides
   * dirtiness over exactly this set, so a filesystem walk would fingerprint a
   * *different* population than the one the label was computed from.
   *
   * `false` is a plain folder walk that never takes git's route
   * (`respectGitignore: false`): it runs for folders with no repository, for
   * repositories with an unborn HEAD, and over a package's `dist/` — which is
   * gitignored in a checkout and has no git at all under an npm prefix — so
   * letting a `.git` above the path change which files are counted would make
   * the fingerprint mean two different things.
   */
  readonly fromGit: boolean;
  /**
   * Globs excluded from the population. Required: each caller's exclusions are
   * a decision about what its fingerprint claims, never a default to inherit.
   */
  readonly exclude: readonly string[];
}

/**
 * Order two strings deterministically, by UTF-16 code unit.
 *
 * Explicit rather than relying on the default sort so nothing locale-aware can
 * creep in: a fingerprint must be identical on every machine that hashes the
 * same bytes.
 *
 * @param a - One string
 * @param b - The other
 * @returns Negative, zero, or positive per the comparator contract
 */
export function compareByCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * The SHA-256 of a file's raw bytes, or {@link ABSENT} when the file is gone.
 *
 * A file that is there but REFUSES to be read throws, for the reason a
 * directory that refuses to be listed does: a placeholder in its slot would
 * make two different contents behind the lock fingerprint identically, which
 * is the one thing a fingerprint exists to catch.
 *
 * @param root - The tree being fingerprinted, for the error message
 * @param relativePath - The file, relative to `root`
 * @returns A 64-character hex digest, or the absent sentinel
 * @throws {Error} naming the file when it exists and cannot be read
 */
export function contentDigest(root: string, relativePath: string): string {
  try {
    return fileContentHash(safePath.join(root, relativePath));
  } catch (cause) {
    if (isPathAbsentError(cause)) return ABSENT;
    throw new Error(
      `Cannot fingerprint ${root}: ${relativePath} could not be read ` +
        `(${cause instanceof Error ? cause.message : String(cause)}). ` +
        'Fix the permissions on that file: a tree the lab cannot read in full cannot be fingerprinted.',
      { cause },
    );
  }
}

/**
 * Fingerprint the files under `root` that `scope` selects.
 *
 * The digest is taken over a manifest of one record per file — the file's
 * **relative path** (forward-slash, UTF-8 bytes) followed by the SHA-256 of its
 * **raw content bytes**, never a decoded string, so encoding and line endings
 * are covered rather than normalised away. Records are emitted in sorted path
 * order, which makes the result order-independent by construction rather than
 * by hoping the crawler is stable. The path is part of the record because
 * moving a file changes the tree even when no byte of content does.
 *
 * @param root - Absolute path to fingerprint
 * @param scope - Which population to cover
 * @returns The hex digest and the number of files it covers
 */
export function fingerprintFiles(
  root: string,
  scope: FingerprintScope,
): { fingerprint: string; fileCount: number } {
  // `refuse`, deliberately: a fingerprint over a tree the walk could not
  // fully list is not a fingerprint of that tree — it would match the same
  // tree with the directory readable and its contents changed, which is the
  // one thing a fingerprint exists to catch. So a refused directory throws
  // `DirectoryListingRefusedError` — on BOTH scopes. The plain walk meets it
  // in `readdir`. The git scope asks `git ls-files --cached --others` (that is
  // what `includeUntracked: true` selects), and `--others` walks the working
  // tree: git omits the subtree, warns on stderr, and the crawler reads that
  // warning and raises the same refusal. Pinned by `subject.test.ts`.
  //
  // 🪤 An earlier version of this comment said the git scope "refuses nothing"
  // and resolves. That describes the TRACKED-ONLY listing (`includeUntracked:
  // false`), which opens no directory because the index names every member —
  // a listing this function never asks for. What is still true of the git
  // scope: a tracked file that is GONE from the working tree is recorded by
  // `contentDigest` as `<absent>` rather than thrown, because that route lists
  // tracked-but-deleted paths (`ENOENT`). A locked FILE refuses exactly as a
  // locked directory does — the same hole, one level down.
  const relativePaths = crawlDirectorySync({
    outputs: [],
    baseDir: root,
    include: ['**/*'],
    exclude: [...scope.exclude],
    absolute: false,
    filesOnly: true,
    followSymlinks: false,
    respectGitignore: scope.fromGit,
    includeUntracked: scope.fromGit,
    unreadable: {
      refuse: {
        root,
        remedy: 'Fix the permissions on that directory: a tree the lab cannot list in full cannot be fingerprinted.',
        side: 'source',
      },
    },
  }).map((relativePath) => toForwardSlash(relativePath));

  relativePaths.sort(compareByCodeUnit);

  const digest = createHash('sha256');
  for (const relativePath of relativePaths) {
    digest.update(relativePath, 'utf8');
    digest.update(RECORD_SEPARATOR);
    digest.update(contentDigest(root, relativePath), 'utf8');
    digest.update(RECORD_SEPARATOR);
  }

  return { fingerprint: digest.digest('hex'), fileCount: relativePaths.length };
}
