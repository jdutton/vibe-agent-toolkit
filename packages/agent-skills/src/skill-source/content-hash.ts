import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { direntKindFollowing, FollowedWalk, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

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
  const walk = new FollowedWalk();
  walk.enter(dir);
  const files = await collectFiles(dir, dir, walk);
  files.sort((a, b) => {
    if (a.rel < b.rel) return -1;
    if (a.rel > b.rel) return 1;
    return 0;
  });

  const hash = createHash('sha256');
  for (const { rel, abs } of files) {
    hash.update(rel, 'utf-8');
    hash.update('\0');
    hash.update(await readFile(abs));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function collectFiles(
  root: string,
  current: string,
  walk: FollowedWalk,
): Promise<Array<{ rel: string; abs: string }>> {
  const entries = await readdir(current, { withFileTypes: true });
  const out: Array<{ rel: string; abs: string }> = [];
  for (const entry of entries) {
    const abs = safePath.join(current, entry.name);
    // The hash covers what ships, so a link is followed to its bytes. A
    // dangling link or a special file has no bytes to hash and contributes
    // nothing — decided here, by name, rather than by falling off the end.
    // A link back into the tree is refused by the walk guard rather than
    // followed until the stack gives out.
    switch (await direntKindFollowing(current, entry)) {
      case 'directory':
        walk.enter(abs);
        out.push(...(await collectFiles(root, abs, walk)));
        break;
      case 'file':
        out.push({ rel: toForwardSlash(safePath.relative(root, abs)), abs });
        break;
      case 'dangling':
      case 'other':
        break;
    }
  }
  return out;
}
