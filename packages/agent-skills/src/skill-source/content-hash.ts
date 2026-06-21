import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

/**
 * Deterministic SHA-256 content hash of a directory tree.
 *
 * Walks the tree, sorts entries by forward-slash relative path, and feeds each
 * relative path plus its bytes into a single hash. Order-independent and
 * platform-independent (forward-slash keys). Symlinks are followed only via
 * the directory listing; callers that need symlink rejection use stageDirInto.
 *
 * @param dir Absolute path to the directory to hash.
 * @returns 64-char lowercase hex SHA-256.
 */
export async function hashDirectory(dir: string): Promise<string> {
  const files = await collectFiles(dir, dir);
  files.sort((a, b) => {
    if (a.rel < b.rel) return -1;
    if (a.rel > b.rel) return 1;
    return 0;
  });

  const hash = createHash('sha256');
  for (const { rel, abs } of files) {
    hash.update(rel, 'utf-8');
    hash.update('\0');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- abs derived from caller-provided dir
    hash.update(await readFile(abs));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function collectFiles(
  root: string,
  current: string,
): Promise<Array<{ rel: string; abs: string }>> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- current derived from caller-provided root
  const entries = await readdir(current, { withFileTypes: true });
  const out: Array<{ rel: string; abs: string }> = [];
  for (const entry of entries) {
    const abs = safePath.join(current, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(root, abs)));
    } else if (entry.isFile()) {
      out.push({ rel: toForwardSlash(safePath.relative(root, abs)), abs });
    }
  }
  return out;
}
