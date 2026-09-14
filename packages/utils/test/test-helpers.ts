/**
 * Shared test helpers for utils package tests
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';

import { mkdirSyncReal } from '../src/path-utils.js';
import { resetProjectRootCaches } from '../src/project-utils.js';
import { gitExecutable } from '../src/testing/executables.js';

/**
 * Drop comment lines before scanning source for `import`/`require` specifiers.
 *
 * Shared by the two subpath-purity walkers — `test/subpath-purity.test.ts` (the
 * TypeScript entries under `src/`) and `test/eslint/subpath-purity.test.ts` (the
 * hand-written CommonJS under `eslint/`). Both assert that an entry reaches
 * *nothing*, and in both the modules under scan document themselves with examples
 * that look exactly like the thing being counted: `path-core.ts` and
 * `zod-introspection.ts` carry ` * import { z } from 'zod';` in JSDoc, and the
 * ESLint entry's own header says `require('eslint')` precisely to state that it
 * never happens. Counting either would turn a true purity claim into a failure.
 *
 * Line-based rather than a block-comment regex so it stays linear-time and cannot
 * swallow code. A real import or require never begins a line with `*`, `//`, or
 * `/*` — including a multi-line `import {\n  a,\n} from 'x'`, whose continuation
 * lines are also not comment-prefixed.
 */
export function stripCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

/**
 * Initialize a git repository in the specified directory.
 * Required for tests that use git commands (git check-ignore, git ls-files).
 *
 * @param directory - Absolute path to directory to initialize as git repo
 * @returns The directory path (for chaining)
 *
 * @example
 * ```typescript
 * const tempDir = mkdtempSync(safePath.join(tmpdir(), 'my-test-'));
 * createGitRepo(tempDir);
 * // Now tempDir is a valid git repository
 * ```
 */
export function createGitRepo(directory: string): string {
  spawnSync(gitExecutable(), ['init'], { cwd: directory, stdio: 'pipe' });
  // `gitFindRoot()` memoizes `null` for any directory a prior walk climbed
  // through (e.g. before this repo existed). Without this reset, a later
  // crawl in the same process silently keeps answering from that stale
  // memo instead of seeing the repo we just created.
  resetProjectRootCaches();
  return directory;
}

/**
 * Set up a nested directory structure for testing.
 * Creates src/subdir/nestedFile and dest directories.
 *
 * @param tempDir - Base temporary directory
 * @param subdir - Subdirectory name to create under src
 * @param nestedFile - File name to create in subdir
 * @param nestedContent - Content to write to the nested file
 * @returns Object with srcDir and destDir paths
 *
 * @example
 * ```typescript
 * const { srcDir, destDir } = await setupNestedDirectory(
 *   tempDir,
 *   'subdir',
 *   'file.txt',
 *   'content'
 * );
 * // srcDir/subdir/file.txt exists with 'content'
 * // destDir exists but is empty
 * ```
 */
export async function setupNestedDirectory(
  tempDir: string,
  subdir: string,
  nestedFile: string,
  nestedContent: string
): Promise<{ srcDir: string; destDir: string }> {
  const srcDir = safePath.join(tempDir, 'src');
  const destDir = safePath.join(tempDir, 'dest');
  await fs.mkdir(safePath.join(srcDir, subdir), { recursive: true });
  await fs.writeFile(safePath.join(srcDir, subdir, nestedFile), nestedContent);
  return { srcDir, destDir };
}

/**
 * The errno `code` a call throws with, or `undefined` when it does not throw.
 *
 * For asserting that a refusal PROPAGATES with its errno intact — the property
 * every `no-blind-catch` rewrite is pinned by — without a try/catch per test.
 */
export function errnoOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

/**
 * Two files under a common `docs/` parent, one of which a test then makes the
 * OS refuse: `docs/open/ok.md` beside `docs/locked/t.md`. The walk must still
 * find the one it can list.
 *
 * Shared by the crawler refusal suites (`file-crawler-refused-listing`,
 * `file-crawler-realpath-refused`): same tree, different syscall refused.
 */
export function plantOpenAndLockedTree(root: string): { locked: string } {
  const open = safePath.join(root, 'docs', 'open');
  const locked = safePath.join(root, 'docs', 'locked');
  mkdirSyncReal(open, { recursive: true });
  mkdirSyncReal(locked, { recursive: true });
  writeFileSync(safePath.join(open, 'ok.md'), '# ok\n');
  writeFileSync(safePath.join(locked, 't.md'), '# t\n');
  return { locked };
}
