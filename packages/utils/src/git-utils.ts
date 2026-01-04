import { spawnSync } from 'node:child_process';

import which from 'which';

/**
 * Check if a file path is ignored by git
 *
 * Uses git check-ignore which respects .gitignore, .git/info/exclude, and global gitignore
 *
 * @param filePath - Absolute or relative path to check
 * @param cwd - Working directory (defaults to process.cwd())
 * @returns true if file is gitignored, false otherwise
 */
export function isGitIgnored(filePath: string, cwd: string = process.cwd()): boolean {
  try {
    // Resolve git path using which for security (avoids PATH manipulation)
    const gitPath = which.sync('git');

    // git check-ignore returns exit code 0 if file is ignored, 1 if not
    const result = spawnSync(gitPath, ['check-ignore', '-q', filePath], {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
      shell: false, // No shell interpreter for security
    });

    return result.status === 0;
  } catch {
    // If git is not available or other error, assume not ignored
    return false;
  }
}
