/**
 * Filesystem utilities
 */

// ⚠️ The sync half is reached through the DEFAULT object (`nodeFs.existsSync`),
// not as named imports, and that is load-bearing rather than stylistic. Node
// snapshots a builtin's named ESM exports at import time, so `vi.spyOn(fs,
// 'existsSync')` cannot see a call made through a named binding — the spy
// attaches and counts zero, which reads exactly like "this function performs no
// I/O". `classifyFilenameCaseFrom` is guarded by precisely that assertion (it
// must reach neither `readdir` nor this pair), so a "tidy-up" back to named
// imports would silently disarm the guard. The async half below already uses the
// default object for the same reason.
import nodeFs from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { toForwardSlash } from './path-core.js';
import { safePath } from './path-utils.js';

/**
 * What one path looked like the first time this run asked.
 *
 * The two fields are deliberately NOT collapsed into a single `stat` result:
 * they record the outcome of `existsSync` and of `statSync` *separately*,
 * because callers distinguish three states and only two of them are "the stat
 * worked". See {@link FsLookupCache.probe}.
 */
export interface PathProbe {
  /** `existsSync` — follows symlinks, so a dangling link reads as absent. */
  readonly exists: boolean;
  /**
   * `statSync().isDirectory()`.
   *
   * `null` means *no answer*, which happens two ways: the path is absent, or
   * it exists and `statSync` threw anyway (a permission change or a delete
   * between the two calls). Callers that must tell those apart read
   * {@link PathProbe.exists} alongside it.
   */
  readonly isDirectory: boolean | null;
}

/** How many probes a {@link FsLookupCache} answered, and how many cost syscalls. */
export interface PathProbeStats {
  /** Probe calls received. */
  readonly probes: number;
  /** Probes that were not already memoized, i.e. that hit the filesystem. */
  readonly misses: number;
}

/**
 * Per-run memo for the two filesystem lookups that validation repeats on values
 * which are constant for the whole run: `realpath` of roots, and `readdir` of the
 * directories link targets live in.
 *
 * A markdown corpus resolves thousands of links into a few hundred directories, so
 * the uncached form is an N+1: measured at 9,963 `readdir` calls on a 3,437-document
 * tree and 7,443 on a 1,132-document monorepo. Concurrent callers share the
 * in-flight promise rather than each starting their own syscall.
 *
 * **Instance-based on purpose — never make this a module-level singleton.** The
 * cache holds a *snapshot* of directory contents, and a long-lived process (watch
 * mode, a language server, a daemon) would then answer from a listing taken
 * arbitrarily long ago. The intended lifetime is one instance per validation run,
 * constructed as a local and collected with the run.
 *
 * Fill first, then judge. The loop holds no `await`, because every listing the
 * loop could have needed was already taken:
 *
 * @example
 * ```typescript
 * const fsCache = new FsLookupCache();          // one per run
 * const targets = links.map((link) => link.target);
 * const siblingNames = await fillSiblingNames(targets, fsCache);  // all the I/O, once
 * for (const target of targets) {
 *   classifyFilenameCaseFrom(siblingNames, target);               // pure — no syscall
 * }
 * ```
 */
export class FsLookupCache {
  /** Directory path → its entry names, or `null` when the directory is unreadable. */
  readonly #listings = new Map<string, Promise<string[] | null>>();

  /** Path → its canonical path, falling back to the resolved path. */
  readonly #realpaths = new Map<string, Promise<string>>();

  /** Path → the existence/kind pair recorded the first time it was probed. */
  readonly #probes = new Map<string, PathProbe>();

  /** Probe calls received, and how many of them reached the filesystem. */
  #probeCount = 0;
  #probeMisses = 0;

  /**
   * Probe counters, for tests and `--debug` output.
   *
   * A memo whose tests never assert its hit count is theatre: every assertion
   * about *values* still passes when the memo is disabled, because an
   * always-miss cache returns the same answers — only more slowly. This is the
   * one observable that dies when the memo does.
   */
  get probeStats(): PathProbeStats {
    return { probes: this.#probeCount, misses: this.#probeMisses };
  }

  /**
   * Does this path exist, and is it a directory — asked once per run.
   *
   * **Both syscalls are preserved, in order, exactly as an uncached caller
   * would make them.** `existsSync` then `statSync` is not the same as one
   * `statSync`: the pair distinguishes "absent" from "present but unstattable",
   * and the link walker's classifier branches differently on each. Collapsing
   * them would be a behaviour change wearing the shape of an optimization, so
   * this method deduplicates the pair rather than replacing it.
   *
   * Synchronous, unlike this class's other two lookups, because its caller (the
   * skill link-graph walker) is synchronous throughout. One oracle answering
   * both shapes beats a second class that differs only in colour.
   *
   * @param targetPath - Path to probe
   * @returns The recorded existence/kind pair
   */
  probe(targetPath: string): PathProbe {
    this.#probeCount++;
    const cached = this.#probes.get(targetPath);
    if (cached !== undefined) return cached;

    this.#probeMisses++;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-validated path
    const exists = nodeFs.existsSync(targetPath);
    let isDirectory: boolean | null = null;
    if (exists) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-validated path
        isDirectory = nodeFs.statSync(targetPath).isDirectory();
      } catch {
        // Present to `existsSync` but unstattable. `null` records "no answer"
        // rather than guessing `false`, which would read as "it is a file".
        isDirectory = null;
      }
    }

    const result: PathProbe = { exists, isDirectory };
    this.#probes.set(targetPath, result);
    return result;
  }

  /**
   * Canonical path for `targetPath`, falling back to `safePath.resolve()` when the
   * path does not exist or cannot be resolved (a non-existent file has no realpath,
   * and callers comparing paths still need an answer).
   *
   * @param targetPath - Path to canonicalize
   * @returns Canonical path with forward slashes on every platform
   */
  realpath(targetPath: string): Promise<string> {
    const cached = this.#realpaths.get(targetPath);
    if (cached !== undefined) return cached;

    // Stored before the first `await` anywhere can run, so concurrent callers
    // reaching this method share the one in-flight promise.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-validated path
    const pending = fs
      .realpath(targetPath)
      .then(toForwardSlash)
      .catch(() => safePath.resolve(targetPath));
    this.#realpaths.set(targetPath, pending);
    return pending;
  }

  /**
   * Entry names of `dirPath`, or `null` when it cannot be read (missing directory,
   * no permission). The unreadable answer is cached too — re-asking is the same
   * failed syscall.
   *
   * @param dirPath - Directory to list
   * @returns Entry names, or `null` if the directory could not be read
   */
  readdir(dirPath: string): Promise<string[] | null> {
    const cached = this.#listings.get(dirPath);
    if (cached !== undefined) return cached;

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-validated path
    const pending = fs.readdir(dirPath).catch(() => null);
    this.#listings.set(dirPath, pending);
    return pending;
  }
}

/**
 * Recursively copy a directory
 *
 * @param src - Source directory path
 * @param dest - Destination directory path
 *
 * @example
 * await copyDirectory('/source/dir', '/dest/dir');
 */
export async function copyDirectory(src: string, dest: string): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths from validated sources
  await fs.mkdir(dest, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths from validated sources
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = safePath.join(src, entry.name);
    const destPath = safePath.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * The one fact on disk that a case-sensitivity question turns on: what the
 * parent directory actually contains, paired with the name being asked about.
 *
 * A row, not an answer — {@link classifyFilenameCase} turns it into a verdict.
 * Splitting the two is what lets the verdict be tested against listings that no
 * filesystem will hand you on demand, entry ORDER in particular.
 */
export interface SiblingNames {
  /** Basename being asked about, i.e. `path.basename(filePath)`. */
  readonly expectedName: string;
  /**
   * The parent directory's entry names, or `null` when it could not be read.
   *
   * `null` is not `[]` — an unreadable or absent directory versus a readable
   * empty one. {@link classifyFilenameCase} deliberately collapses them (both
   * are "no such entry"), but the distinction is kept in the row because it is
   * a *fact*, and the judge that wants it — a check that says "the directory
   * itself is missing" rather than "the file is missing" — cannot recover it
   * once the fill has thrown it away.
   */
  readonly names: readonly string[] | null;
}

/**
 * The materialized listing column: parent directory → that directory's entry
 * names, or `null` when it could not be read.
 *
 * `null` carries exactly the meaning {@link SiblingNames.names} documents — an
 * unreadable or absent directory, which is *not* the same fact as a readable
 * empty one (`[]`), even though {@link classifyFilenameCase} collapses the two
 * into one verdict.
 *
 * A *missing key* is a third thing again, and never a legal input to judgement:
 * see {@link siblingNamesFrom}.
 */
export type SiblingNamesTable = ReadonlyMap<string, readonly string[] | null>;

/**
 * List the parent directory of every path in `filePaths` — the only place I/O is
 * legal for this fact, and the pass that must run *before* any judging.
 *
 * ⚠️ **It takes FILE paths, not directory paths, deliberately.** It derives each
 * parent with `path.dirname` itself, so exactly one function in the system owns
 * the key derivation and a caller cannot construct a key that
 * {@link siblingNamesFrom} then misses. Do not "simplify" this to take
 * directories: that hands the derivation back to every call site and reopens the
 * silent-miss class this shape closes.
 *
 * Distinct parents are listed **concurrently**: the shape this replaced asked one
 * link at a time at judgement time, which serialised every `readdir` behind the
 * previous link's `await`. De-duplication is by parent, so N files in one
 * directory cost one listing; the listing itself goes through
 * {@link FsLookupCache.readdir}, which memoizes and shares in-flight promises
 * across fills.
 *
 * @param filePaths - File paths whose parent directories should be listed
 * @param fsCache - Per-run lookup cache (one instance per validation run)
 * @returns The filled table; empty input yields an empty table with no syscalls
 */
export async function fillSiblingNames(
  filePaths: Iterable<string>,
  fsCache: FsLookupCache
): Promise<SiblingNamesTable> {
  const parentDirs = new Set<string>();
  for (const filePath of filePaths) {
    parentDirs.add(path.dirname(filePath));
  }

  const table = new Map<string, readonly string[] | null>();
  await Promise.all(
    [...parentDirs].map(async (parentDir) => {
      table.set(parentDir, await fsCache.readdir(parentDir));
    })
  );

  return table;
}

/**
 * Read the row for `filePath` out of an already-filled table. Pure.
 *
 * **A miss throws rather than degrading to `names: null`.** The fill set is
 * derived from exactly the paths the judge will be asked about, so a missing
 * parent is a programming error — a path judged that nobody filled. The `null`
 * fallback would answer it as "the directory is unreadable", which reports every
 * file under that directory as *missing*: a wrong answer wearing the shape of a
 * graceful degradation, and one no test of the verdict would catch.
 *
 * Internal on purpose — {@link classifyFilenameCaseFrom} is the public judge.
 *
 * @param table - Table filled by {@link fillSiblingNames}
 * @param filePath - Path being asked about
 * @returns The row: the expected basename plus the parent's entries
 * @throws If `table` holds no entry for the path's parent directory
 */
export function siblingNamesFrom(table: SiblingNamesTable, filePath: string): SiblingNames {
  const parentDir = path.dirname(filePath);
  // `undefined` can only mean "absent key": a filled entry is an array or an
  // explicit `null`, never `undefined`.
  const names = table.get(parentDir);
  if (names === undefined) {
    throw new Error(
      `No sibling listing for directory "${parentDir}" (asked about "${filePath}"). ` +
        `Fill it with fillSiblingNames() before judging.`
    );
  }

  return { expectedName: path.basename(filePath), names };
}

/**
 * Decide whether `row.expectedName` names a real entry, at the exact case asked for.
 *
 * Pure: no filesystem, no cache, no path parsing — it reads only the columns it
 * is handed, which is what makes hand-written listings a legitimate test input.
 *
 * **First match wins, and the exact-match pass runs first — that order IS the
 * contract.** On a case-insensitive filesystem a listing can hold both
 * `readme.md` and `README.md`, in either order; asking for `README.md` must
 * report it present regardless of which one `readdir` happened to return first.
 * Searching case-insensitively first would report the very file that exists as a
 * case mismatch, purely on directory-entry order.
 *
 * ⚠️ **Comparison is raw UTF-16, so Unicode normalization is not handled** — and
 * neither did the code this was extracted from. macOS hands back decomposed
 * names (`e` + U+0301) where a markdown link usually carries the composed form
 * (`é`); the two are `!==` and case-folding does not reconcile them, so an
 * accented file that exists is reported as flatly missing, without even the
 * case-mismatch hint. Ledger entry D7. Fixing it means normalizing both sides in
 * the fill, which moves output and so wants its own commit.
 *
 * @param row - The listing row, read out of a filled table by {@link siblingNamesFrom}
 * @returns Whether the exact name exists, and the entry actually on disk (or `null`)
 */
export function classifyFilenameCase(row: SiblingNames): {
  exists: boolean;
  actualName: string | null;
} {
  const { expectedName, names } = row;

  if (names === null) {
    // Parent directory doesn't exist (or can't be read)
    return { exists: false, actualName: null };
  }

  // Find the actual filename (case-sensitive exact match).
  // Tested against `undefined` rather than for truthiness: `readdir` never
  // yields an empty entry name, but hand-written rows are this function's
  // advertised input now that it is pure, and `''` is falsy — it would fall
  // through to the case-insensitive branch and come back as `actualName: ''`.
  const exactMatch = names.find(entry => entry === expectedName);

  if (exactMatch !== undefined) {
    // Found exact case match - file exists with correct case
    return { exists: true, actualName: exactMatch };
  }

  // No exact match - check for case-insensitive match
  const caseInsensitiveMatch = names.find(
    entry => entry.toLowerCase() === expectedName.toLowerCase()
  );

  // Return result:
  // - If case-insensitive match found: exists=false (wrong case), actualName=<actual>
  // - If no match at all: exists=false, actualName=null
  return {
    exists: false,
    actualName: caseInsensitiveMatch ?? null,
  };
}

/**
 * Judge `filePath` against an already-filled {@link SiblingNamesTable}.
 *
 * This is the judging half of the two-pass shape: {@link fillSiblingNames} does
 * every listing first, then this runs over as many paths as you like with no
 * interleaved I/O.
 *
 * **Its signature takes no {@link FsLookupCache} and no `fs` — that is the
 * property, not an omission.** A judge that cannot reach the filesystem cannot
 * quietly reintroduce a per-path syscall at judgement time, which is exactly what
 * this refactor removed. Keep it that way: if a future check needs another fact
 * about the parent directory, widen the *table*, never this parameter list.
 *
 * @param table - Table filled by {@link fillSiblingNames}
 * @param filePath - Absolute path to judge
 * @returns Whether the exact name exists, and the entry actually on disk (or `null`)
 * @throws If `table` holds no entry for the path's parent directory — see
 *   {@link siblingNamesFrom}
 */
export function classifyFilenameCaseFrom(
  table: SiblingNamesTable,
  filePath: string
): { exists: boolean; actualName: string | null } {
  return classifyFilenameCase(siblingNamesFrom(table, filePath));
}
