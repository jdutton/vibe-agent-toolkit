/**
 * Filesystem utilities
 */

import fs from 'node:fs/promises';
import path from 'node:path';

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
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Verify that a file exists with the exact case-sensitive filename.
 *
 * On case-insensitive filesystems (Windows, macOS), a file might be found even if
 * the case doesn't match. This function checks that the actual filename on disk
 * matches the requested path exactly (case-sensitive).
 *
 * @param filePath - Absolute path to the file to verify
 * @returns Object with exists flag and actual filename (or null if not found)
 *
 * @example
 * ```typescript
 * // On case-insensitive filesystem with file "README.md"
 * const result1 = await verifyCaseSensitiveFilename('/project/README.md');
 * // { exists: true, actualName: 'README.md' }
 *
 * const result2 = await verifyCaseSensitiveFilename('/project/readme.md');
 * // { exists: false, actualName: 'README.md' } - case mismatch!
 * ```
 */
export async function verifyCaseSensitiveFilename(
  filePath: string
): Promise<{ exists: boolean; actualName: string | null }> {
  // Get parent directory and expected filename
  const parentDir = path.dirname(filePath);
  const expectedName = path.basename(filePath);

  // Read actual directory entries
  let entries: string[];
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- parentDir from validated path
    entries = await fs.readdir(parentDir);
  } catch {
    // Parent directory doesn't exist
    return { exists: false, actualName: null };
  }

  // Find the actual filename (case-sensitive exact match)
  const exactMatch = entries.find(entry => entry === expectedName);

  if (exactMatch) {
    // Found exact case match - file exists with correct case
    return { exists: true, actualName: exactMatch };
  }

  // No exact match - check for case-insensitive match
  const caseInsensitiveMatch = entries.find(
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
