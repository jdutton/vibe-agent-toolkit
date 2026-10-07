import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { direntKindFollowing, FollowedWalk, forEachInOrder, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { readingSkillSource } from './source-unreadable.js';

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
 * @throws {SkillSourceUnreadableError} When the OS will not read a file or list a directory in it.
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
  // In order: `hash.update` order is the digest, and one file's bytes are held at a time.
  await forEachInOrder(files, async ({ rel, abs }) => {
    hash.update(rel, 'utf-8');
    hash.update('\0');
    hash.update(await readingSkillSource(abs, () => readFile(abs)));
    hash.update('\0');
  });
  return hash.digest('hex');
}

async function collectFiles(
  root: string,
  current: string,
  walk: FollowedWalk,
): Promise<Array<{ rel: string; abs: string }>> {
  const entries = await readingSkillSource(current, () => readdir(current, { withFileTypes: true }));
  const out: Array<{ rel: string; abs: string }> = [];
  // In order: the walk guard's cycle detection depends on it.
  await forEachInOrder(entries, async (entry) => {
    const abs = safePath.join(current, entry.name);
    // The hash covers what ships, so a link is followed to its bytes. A
    // dangling link or a special file has no bytes to hash and contributes
    // nothing — decided here, by name, rather than by falling off the end.
    // A link back into the tree is refused by the walk guard rather than
    // followed until the stack gives out.
    switch (await readingSkillSource(abs, () => direntKindFollowing(current, entry))) {
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
  });
  return out;
}
