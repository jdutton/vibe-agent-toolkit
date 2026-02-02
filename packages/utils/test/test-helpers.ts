/**
 * Shared test helpers for utils package tests
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Initialize a git repository in the specified directory.
 * Required for tests that use git commands (git check-ignore, git ls-files).
 *
 * @param directory - Absolute path to directory to initialize as git repo
 * @returns The directory path (for chaining)
 *
 * @example
 * ```typescript
 * const tempDir = mkdtempSync(path.join(tmpdir(), 'my-test-'));
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
  const srcDir = path.join(tempDir, 'src');
  const destDir = path.join(tempDir, 'dest');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is controlled temp directory in tests
  await fs.mkdir(path.join(srcDir, subdir), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is controlled temp directory in tests
  await fs.writeFile(path.join(srcDir, subdir, nestedFile), nestedContent);
  return { srcDir, destDir };
}
