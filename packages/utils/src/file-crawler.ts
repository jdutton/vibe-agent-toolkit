import fs from 'node:fs';

import picomatch from 'picomatch';

import { gitFindRoot, gitLsFiles } from './git-utils.js';
import { toForwardSlash, safePath } from './path-utils.js';

/**
 * Options for directory crawling
 */
export interface CrawlOptions {
  /** Base directory to start crawl */
  baseDir: string;
  /** Include patterns (glob) - default: ['**\/*'] */
  include?: string[];
  /** Exclude patterns (glob) - default: ['**\/node_modules/**', '**\/.git/**'] */
  exclude?: string[];
  /** Follow symbolic links (default: false) */
  followSymlinks?: boolean;
  /** Return absolute paths in results (default: true) */
  absolute?: boolean;
  /** Only return files (not directories) - default: true */
  filesOnly?: boolean;
  /**
   * Respect .gitignore files (default: true).
   *
   * When true (and the baseDir is inside a git repository) the crawl is
   * answered by `git ls-files`, which is orders of magnitude cheaper than
   * walking the tree. Setting this to false forces a full recursive walk of
   * every non-excluded directory — including build caches, nested worktrees
   * and generated output — so only pass it when you genuinely need files git
   * has been told to ignore. To pick up files git simply does not track yet,
   * use {@link CrawlOptions.includeUntracked} instead and keep the fast path.
   */
  respectGitignore?: boolean;
  /**
   * Include untracked (but not ignored) files (default: false).
   *
   * Only meaningful alongside `respectGitignore: true`, where it widens the
   * `git ls-files` query from tracked files to tracked + untracked-not-ignored.
   * This is the right knob for "the author is editing something they have not
   * committed yet"; `respectGitignore: false` is not, and costs the whole walk.
   */
  includeUntracked?: boolean;
}

/**
 * Glob options shared by every pattern this module compiles.
 *
 * `dot: true` is not optional. picomatch's default refuses to let `*` or `**`
 * traverse a segment beginning with a dot, so `**\/*.md` — the include pattern
 * every VAT lane defaults to — cannot see inside `.claude/`, which is Claude's
 * own home for the rules, skills, commands and agents VAT exists to validate.
 * It applies to excludes for the same reason: without it, an exclude aimed at a
 * dot-directory silently never fires. Every other picomatch call site in VAT
 * already compiles this way.
 *
 * Visibility is decided by git (or by the exclude patterns), never by whether a
 * path component happens to start with a dot.
 */
const PICOMATCH_OPTIONS = { dot: true } as const;

/**
 * Directories no VAT crawl should ever walk into. THE canonical list — any lane
 * that needs its own additions should spread this rather than restate it.
 *
 * There were three of these and they disagreed: this one omitted worktrees
 * entirely, the discovery scanner had both worktree paths but not `dist`, and
 * the repo-structure gate used bare basenames. A worktree is a FULL COPY of the
 * repository, so omitting it does not just cost time — it makes a crawl report
 * the same file two or three times under different paths, and this repo keeps its
 * worktrees at `.claude/worktrees/`, inside a dot-directory that `dot: true`
 * (see {@link PICOMATCH_OPTIONS}) deliberately makes reachable.
 *
 * `.turbo` is here rather than in {@link BUILD_OUTPUT_GLOBS}, and the placement
 * is the decision. The line between the two lists is not "who produced it" —
 * `coverage/` is tool output too — it is *does any lane exist precisely to look
 * at it*. Something does walk `dist/`; nothing walks `.turbo`, which holds
 * `turbo-<task>.log` telemetry plus, when `cacheDir` points inside it,
 * hash-keyed cache entries that are COPIES of package build output. That is the
 * `.worktrees` failure two lines up, not the `dist` one: a crawl that descends
 * into it reports the same file twice under two paths. Filing it as build
 * output would have it exactly backwards, since a lane spreading only this list
 * is by definition a lane that wants to see built output — and so is precisely
 * the lane that must not walk a cache of copies. (Turborepo is a common enough
 * monorepo layout that this is not hypothetical: every package in THIS repo has
 * a `.turbo/`.)
 *
 * Note these patterns only bite when `respectGitignore` is false; the fast
 * `git ls-files` path never sees ignored directories in the first place. For
 * `.turbo` that is the only path it could bite on — it is gitignored by every
 * turborepo setup — which is the same position `coverage/` and `.test-output/`
 * are in.
 */
export const NEVER_CRAWL_GLOBS = [
  '**/node_modules/**',      // Dependencies (40K+ files), never user content
  '**/.git/**',              // Git objects, never user content
  '**/coverage/**',          // Test coverage reports
  '**/.test-output/**',      // Test artifacts
  '**/.worktrees/**',        // Git worktrees are full repo copies — never traverse
  '**/.claude/worktrees/**', // Claude Code worktrees, same reason
  '**/.turbo/**',            // turborepo task logs + cache — see below
] as const;

/**
 * Build output — excluded by DEFAULT, but deliberately NOT part of
 * {@link NEVER_CRAWL_GLOBS}.
 *
 * The distinction is real, and collapsing it is a bug: everything in
 * `NEVER_CRAWL_GLOBS` is "never user content, no lane wants it", while `dist/` is
 * content VAT itself produced and some lanes exist precisely to look at. Skill
 * discovery CLASSIFIES what it finds as source or build output, so it must walk
 * `dist/`; a crawl for authored markdown must not. Two different questions, so
 * two lists — a lane spreads whichever ones apply.
 */
export const BUILD_OUTPUT_GLOBS = ['**/dist/**'] as const;

const DEFAULT_EXCLUDE: string[] = [...NEVER_CRAWL_GLOBS, ...BUILD_OUTPUT_GLOBS];

/**
 * Crawl a directory tree and return matching files (async)
 *
 * Uses picomatch for glob pattern matching (same as Vitest)
 * Cross-platform compatible
 *
 * @param options - Crawl options
 * @returns Promise resolving to array of matching file paths
 *
 * @example
 * const files = await crawlDirectory({
 *   baseDir: '/project',
 *   include: ['**\/*.md'],
 *   exclude: ['**\/node_modules/**'],
 * });
 */
export async function crawlDirectory(options: CrawlOptions): Promise<string[]> {
  return crawlDirectorySync(options);
}

/**
 * Crawl a directory tree and return matching files (synchronous)
 *
 * Uses picomatch for glob pattern matching (same as Vitest)
 * Cross-platform compatible
 *
 * @param options - Crawl options
 * @returns Array of matching file paths
 *
 * @example
 * const files = crawlDirectorySync({
 *   baseDir: '/project',
 *   include: ['**\/*.md'],
 *   exclude: ['**\/node_modules/**'],
 * });
 */
export function crawlDirectorySync(options: CrawlOptions): string[] {
  const {
    baseDir,
    include = ['**/*'],
    exclude = DEFAULT_EXCLUDE,
    followSymlinks = false,
    absolute = true,
    filesOnly = true,
    respectGitignore = true,
    includeUntracked = false,
  } = options;

  const picoOptions = PICOMATCH_OPTIONS;

  // Resolve base directory to absolute path
  const resolvedBaseDir = safePath.resolve(baseDir);

  // Ensure base directory exists
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- baseDir is from controlled config, not user input
  if (!fs.existsSync(resolvedBaseDir)) {
    throw new Error(`Base directory does not exist: ${resolvedBaseDir}`);
  }

  // Ensure base directory is actually a directory
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved path validated above
  const baseStat = fs.statSync(resolvedBaseDir);
  if (!baseStat.isDirectory()) {
    throw new Error(`Base path is not a directory: ${resolvedBaseDir}`);
  }

  // Try using git ls-files for performance when in a git repo
  if (respectGitignore) {
    const gitRoot = gitFindRoot(resolvedBaseDir);
    if (gitRoot) {
      // Use git ls-files - much faster and authoritative
      // Don't pass patterns to git - glob patterns don't work as git pathspecs
      // Get all tracked files, then filter using glob patterns below
      const gitFiles = gitLsFiles({
        cwd: resolvedBaseDir,
        includeUntracked,
      });

      if (gitFiles !== null) {
        // ⚠️ KNOWN DIVERGENCE: this branch ignores `followSymlinks`.
        //
        // `git ls-files` returns symlinks as mode-120000 entries like any other
        // path, and nothing below filters them out — whereas the manual walk
        // (see `processSymlink`) returns early unless `followSymlinks` is set.
        // So the SAME tree with the SAME options has a different population
        // depending only on whether a `.git` exists above it.
        //
        // A committed dangling `*.md` symlink returned from here no longer
        // terminates the command: `ResourceRegistry.addResources` records the
        // read failure and reports it as RESOURCE_UNREADABLE. The population
        // divergence itself is still live.
        //
        // Pinned (as today's behaviour, deliberately) by
        // packages/cli/test/integration/enumeration-symlink-divergence.integration.test.ts.
        // Making the two routes agree changes enumeration on real corpora — in
        // one of two opposite directions, since excluding symlinks here drops
        // committed content while including them in the walk grows the off-git
        // population — so it is a product decision with its own changelog
        // entry, not a drive-by fix here.
        //
        // Git ls-files succeeded - filter using glob patterns
        const isIncluded = picomatch(include, picoOptions);
        const isExcluded = exclude.length > 0 ? picomatch(exclude, picoOptions) : (): boolean => false;

        return gitFiles
          .filter((relativePath) => {
            const normalizedPath = toForwardSlash(relativePath);
            // Check both include and exclude patterns
            return isIncluded(normalizedPath) && !isExcluded(normalizedPath) && !isExcluded(normalizedPath + '/');
          })
          .map((relativePath) => {
            // git ls-files returns paths relative to cwd
            return absolute ? safePath.resolve(resolvedBaseDir, relativePath) : relativePath;
          });
      }
      // Git ls-files failed - fall through to manual crawling
    }
  }

  // Fall back to manual directory crawling (not in git repo or git ls-files failed)
  // Compile glob patterns using picomatch
  const isIncluded = picomatch(include, picoOptions);
  const isExcluded = exclude.length > 0 ? picomatch(exclude, picoOptions) : (): boolean => false;

  const results: string[] = [];

  /**
   * Real paths of directories already walked, maintained ONLY when following
   * symlinks — it is what makes a directory symlink safe to traverse.
   *
   * A symlinked directory can be re-entered without limit (`a/loop -> a`) and
   * can be reached under two names (`alias-one -> real`, `alias-two -> real`).
   * Both enumerate one blob many times under distinct paths, so each row gets
   * its own generated id and its own bundle entry. The loop terminated before
   * this guard existed, but only because the kernel eventually refuses to
   * resolve further symlinks — a limit that is 32 on macOS and 40 on Linux, so
   * the POPULATION depended on the operating system, and the walk ended inside
   * `processSymlink`'s catch for BROKEN links, which reported nothing.
   *
   * Left empty when `followSymlinks` is false: without symlink traversal a
   * directory cannot be reached twice, so the default path pays no `realpath`.
   */
  const visitedRealDirs = new Set<string>();

  /**
   * Check if a path should be excluded based on patterns
   */
  function shouldExclude(normalizedPath: string): boolean {
    // Check explicit exclude patterns
    return isExcluded(normalizedPath) || isExcluded(normalizedPath + '/');
  }

  /**
   * Add a path to results if it matches include patterns
   */
  function addToResults(normalizedPath: string, fullPath: string, relativePath: string): void {
    if (isIncluded(normalizedPath)) {
      results.push(absolute ? fullPath : relativePath);
    }
  }

  /**
   * Record a directory as walked, reporting whether it had already been seen.
   *
   * Identity is `realpathSync.native`, not the traversal path: two names for
   * one directory must collide here or the alias is enumerated twice. A
   * directory whose real path cannot be read is treated as already-walked —
   * refusing to descend into something we cannot identify is the safe side of
   * a guard whose whole job is bounding traversal.
   *
   * @param dir - Directory about to be walked
   * @returns True when this directory has been walked before
   */
  function alreadyWalked(dir: string): boolean {
    let realPath: string;
    try {
      realPath = fs.realpathSync.native(dir);
    } catch {
      return true;
    }

    if (visitedRealDirs.has(realPath)) {
      return true;
    }
    visitedRealDirs.add(realPath);
    return false;
  }

  /**
   * Process a symbolic link entry
   */
  function processSymlink(fullPath: string, normalizedPath: string, relativePath: string): void {
    if (!followSymlinks) {
      return;
    }

    // Resolve symlink and check if it's a directory or file
    let targetStat: fs.Stats;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from validated baseDir + entries
      targetStat = fs.statSync(fullPath);
    } catch {
      // Skip broken symlinks
      return;
    }

    if (targetStat.isDirectory()) {
      walkDirectory(fullPath);
    } else if (targetStat.isFile()) {
      addToResults(normalizedPath, fullPath, relativePath);
    }
  }

  /**
   * Process a directory entry
   */
  function processDirectory(fullPath: string, normalizedPath: string, relativePath: string): void {
    // Recurse into subdirectory
    walkDirectory(fullPath);

    // Add directory to results if not filesOnly
    if (!filesOnly) {
      addToResults(normalizedPath, fullPath, relativePath);
    }
  }

  /**
   * Process a file entry
   */
  function processFile(normalizedPath: string, fullPath: string, relativePath: string): void {
    addToResults(normalizedPath, fullPath, relativePath);
  }

  /**
   * Recursively walk directory tree
   */
  function walkDirectory(currentDir: string): void {
    if (followSymlinks && alreadyWalked(currentDir)) {
      return;
    }

    let entries: fs.Dirent[];

    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from validated baseDir, recursively walking
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      // Skip directories we don't have permission to read
      return;
    }

    // Two passes, not one: `readdirSync` order is filesystem-defined (see
    // the comment on `alreadyWalked`), and both a real directory and a
    // symlink alias pointing at it go through the same `alreadyWalked` gate,
    // keyed only on realpath. Whichever spelling is dispatched FIRST claims
    // that realpath in `visitedRealDirs`, and the second is then skipped as
    // "already walked" — so if the alias happened to sort first, the
    // directory's contents would be recorded under the alias's name and the
    // real directory would be skipped entirely. Walking every non-symlink
    // entry to completion before any symlink entry guarantees a real
    // directory always claims its own realpath first; an alias reaching the
    // same realpath afterward is correctly skipped by `alreadyWalked`. Only
    // the ORDER of dispatch changes here — per-entry logic is unchanged.
    const symlinkEntries: fs.Dirent[] = [];

    for (const entry of entries) {
      const fullPath = safePath.join(currentDir, entry.name);
      const relativePath = safePath.relative(resolvedBaseDir, fullPath);
      const normalizedPath = toForwardSlash(relativePath);

      // Skip excluded paths
      if (shouldExclude(normalizedPath)) {
        continue;
      }

      // Defer symlinks to the second pass; dispatch everything else now.
      if (entry.isSymbolicLink()) {
        symlinkEntries.push(entry);
      } else if (entry.isDirectory()) {
        processDirectory(fullPath, normalizedPath, relativePath);
      } else if (entry.isFile()) {
        processFile(normalizedPath, fullPath, relativePath);
      }
    }

    for (const entry of symlinkEntries) {
      const fullPath = safePath.join(currentDir, entry.name);
      const relativePath = safePath.relative(resolvedBaseDir, fullPath);
      const normalizedPath = toForwardSlash(relativePath);
      processSymlink(fullPath, normalizedPath, relativePath);
    }
  }

  // Start recursive walk from base directory
  walkDirectory(resolvedBaseDir);

  return results;
}
