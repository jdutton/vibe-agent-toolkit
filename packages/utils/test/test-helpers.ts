/**
 * Shared test helpers for utils package tests
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';

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
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- test setup uses git from PATH
  spawnSync('git', ['init'], { cwd: directory, stdio: 'pipe' });
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
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is controlled temp directory in tests
  await fs.mkdir(safePath.join(srcDir, subdir), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is controlled temp directory in tests
  await fs.writeFile(safePath.join(srcDir, subdir, nestedFile), nestedContent);
  return { srcDir, destDir };
}
