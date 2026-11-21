/**
 * `plantFiles` - write a literal tree of files under a root.
 *
 * Framework-free, like everything under `testing/`: no `vitest` import, so the `./testing`
 * subpath keeps the empty third-party set its purity pin asserts.
 */

import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '../path-utils.js';

/**
 * Write `files` under `root`, creating each file's parent directories.
 *
 * @param root - The directory to write under
 * @param files - Root-relative path to contents
 */
export function plantFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [relative, content] of Object.entries(files)) {
    const path = safePath.join(root, relative);
    mkdirSyncReal(safePath.join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
}
