import fs from 'node:fs';
import path from 'node:path';

import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import type { Ignore } from 'ignore';
import picomatch from 'picomatch';

import { findGitRoot, loadGitignoreRules } from './gitignore-checker.js';

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
  /** Respect .gitignore files (default: true) */
  respectGitignore?: boolean;
}

/**
 * Default exclude patterns that are almost always unwanted
 */
const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/coverage/**'];

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
  } = options;

  // Resolve base directory to absolute path
  const resolvedBaseDir = path.resolve(baseDir);

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

  // Load gitignore rules if requested
  let gitignoreChecker: Ignore | null = null;
  let gitRoot: string | null = null;

  if (respectGitignore) {
    gitRoot = findGitRoot(resolvedBaseDir);
    if (gitRoot) {
      gitignoreChecker = loadGitignoreRules(gitRoot, resolvedBaseDir);
    }
  }

  // Compile glob patterns using picomatch
  const isIncluded = picomatch(include);
  const isExcluded = exclude.length > 0 ? picomatch(exclude) : (): boolean => false;

  const results: string[] = [];

  /**
   * Check if a path should be excluded based on patterns and gitignore
   */
  function shouldExclude(normalizedPath: string, fullPath: string): boolean {
    // Check explicit exclude patterns
    if (isExcluded(normalizedPath) || isExcluded(normalizedPath + '/')) {
      return true;
    }

    // Check gitignore rules if enabled
    if (gitignoreChecker && gitRoot) {
      // Get path relative to git root for gitignore checking
      const relativeToGitRoot = path.relative(gitRoot, fullPath);
      const normalizedGitPath = toForwardSlash(relativeToGitRoot);

      if (gitignoreChecker.ignores(normalizedGitPath)) {
        return true;
      }
    }

    return false;
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
    let entries: fs.Dirent[];

    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from validated baseDir, recursively walking
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      // Skip directories we don't have permission to read
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(resolvedBaseDir, fullPath);
      const normalizedPath = toForwardSlash(relativePath);

      // Skip excluded paths
      if (shouldExclude(normalizedPath, fullPath)) {
        continue;
      }

      // Dispatch to appropriate handler based on entry type
      if (entry.isSymbolicLink()) {
        processSymlink(fullPath, normalizedPath, relativePath);
      } else if (entry.isDirectory()) {
        processDirectory(fullPath, normalizedPath, relativePath);
      } else if (entry.isFile()) {
        processFile(normalizedPath, fullPath, relativePath);
      }
    }
  }

  // Start recursive walk from base directory
  walkDirectory(resolvedBaseDir);

  return results;
}
