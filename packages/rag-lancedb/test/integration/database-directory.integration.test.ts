import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { createSymlink, FS_FAULT_CODE, isVatError, mkdirSyncReal, safePath, symlinkCapability, TREE_DEST_NOT_OWNED_CODE } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS, registerScratchTmpdir } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { linkedDatabasePath, removeRagDatabase } from '../../src/database-directory.js';

/** A database directory at `<dir>/<name>` holding one table with one data file. */
function database(dir: string, name: string): string {
  const db = safePath.join(dir, name);
  mkdirSyncReal(safePath.join(db, 'rag_chunks.lance', 'data'), { recursive: true });
  writeFileSync(safePath.join(db, 'rag_chunks.lance', 'data', 'a.lance'), 'x');
  return db;
}

/** The first bytes the OS writes into each litter file it makes — what makes a file litter, not its name. */
const APPLE_DOUBLE = Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00]);
const DS_STORE = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x42, 0x75, 0x64, 0x31, 0x00]);
const THUMBS_DB = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]);

/** What `removeRagDatabase(path)` rejected with, or undefined. */
async function removalError(path: string): Promise<unknown> {
  try {
    await removeRagDatabase(path);
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('removeRagDatabase', () => {
  let dir = '';
  // Every case can reach the primitive's recursive removal: the temp root it could touch is this scratch tree.
  const scratch = registerScratchTmpdir('vat-rag-remove-', { beforeEach, afterEach });
  beforeEach(() => {
    dir = scratch();
  });

  it('removes a database that holds operating-system litter beside its tables', async () => {
    const db = database(dir, 'db');
    writeFileSync(safePath.join(db, '.DS_Store'), DS_STORE);
    writeFileSync(safePath.join(db, '._rag_chunks.lance'), APPLE_DOUBLE);
    writeFileSync(safePath.join(db, 'Thumbs.db'), THUMBS_DB);
    writeFileSync(safePath.join(db, 'desktop.ini'), '[.ShellClassInfo]\r\n');

    await removeRagDatabase(db);

    expect(existsSync(db)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('removes nothing, and refuses nothing, where no database is', async () => {
    await removeRagDatabase(safePath.join(dir, 'never-made'));

    expect(readdirSync(dir)).toEqual([]);
  });

  // A litter NAME is not litter: `._notes` is a name a person can give a file. Only the bytes the
  // OS writes at the start of each such file say the OS made it.
  it.each([
    ['._notes', 'my notes'],
    ['._notes', ''],
    ['.DS_Store', 'not finder'],
    ['Thumbs.db', 'not a thumbnail cache'],
  ])('refuses a regular file named %s whose bytes are not the OS signature, and removes nothing', async (name, content) => {
    const db = database(dir, 'db');
    writeFileSync(safePath.join(db, name), content);

    const error = await removalError(db);

    expect(isVatError(error, TREE_DEST_NOT_OWNED_CODE), String(error)).toBe(true);
    expect(String(error)).toContain(name);
    expect(readFileSync(safePath.join(db, name), 'utf8')).toBe(content);
  });

  it.skipIf(CANNOT_DENY_READS)('classifies a database the OS will not list as a refused destination fault, and removes nothing', async () => {
    const db = database(dir, 'db');
    chmodSync(db, 0o000);
    let error: unknown;
    try {
      error = await removalError(db);
    } finally {
      chmodSync(db, 0o755);
    }
    expect(error).toMatchObject({ code: FS_FAULT_CODE, side: 'destination', faultClass: 'refused', errno: 'EACCES' });
    expect(existsSync(safePath.join(db, 'rag_chunks.lance', 'data', 'a.lance'))).toBe(true);
  });

  it('refuses a directory holding anything else, coded, and removes nothing', async () => {
    const db = database(dir, 'db');
    writeFileSync(safePath.join(db, 'notes.md'), 'mine');

    expect(isVatError(await removalError(db), TREE_DEST_NOT_OWNED_CODE)).toBe(true);
    expect(existsSync(safePath.join(db, 'notes.md'))).toBe(true);
  });

  // Litter is a FILE the OS wrote. A directory (or a link) that merely carries a litter name is
  // the user's: `._notes/` full of files once made the whole tree removable.
  it('refuses a directory whose litter-named entries are not regular files, and removes nothing', async ({ skip }) => {
    const db = database(dir, 'db');
    mkdirSyncReal(safePath.join(db, '._notes'));
    writeFileSync(safePath.join(db, '._notes', 'a.txt'), 'precious');
    writeFileSync(safePath.join(db, '.DS_Store'), DS_STORE);

    const error = await removalError(db);

    expect(isVatError(error, TREE_DEST_NOT_OWNED_CODE), String(error)).toBe(true);
    expect(String(error)).toContain('._notes');
    expect(existsSync(safePath.join(db, '._notes', 'a.txt'))).toBe(true);

    const cap = symlinkCapability() ?? skip();
    rmSync(safePath.join(db, '._notes'), { recursive: true });
    createSymlink(cap, safePath.join(dir, 'elsewhere'), safePath.join(db, 'Thumbs.db'), 'file');
    expect(isVatError(await removalError(db), TREE_DEST_NOT_OWNED_CODE)).toBe(true);
    expect(existsSync(db)).toBe(true);
  });

  // Removing a link removes only the link: the index it names would survive a "cleared" report.
  it('refuses a symbolic link to a database, naming the real path, and removes nothing', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const real = database(dir, 'real');
    const link = safePath.join(dir, 'link');
    createSymlink(cap, real, link, 'dir');

    const error = await removalError(link);

    expect(isVatError(error, TREE_DEST_NOT_OWNED_CODE), String(error)).toBe(true);
    expect(String(error)).toContain(`refusing to remove ${link}`);
    expect(String(error)).toContain(real);
    expect(existsSync(link)).toBe(true);
    expect(existsSync(safePath.join(real, 'rag_chunks.lance', 'data', 'a.lance'))).toBe(true);
  });

  // A relative link is named by where it really leads, absolute — a path the user can pass to --db.
  it('names a relative link\'s resolved real path, never its raw target', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const real = database(dir, 'real');
    const link = safePath.join(dir, 'link');
    createSymlink(cap, 'real', link, 'dir');

    expect(linkedDatabasePath(link)).toBe(real);
    expect(String(await removalError(link))).toContain(`symbolic link to ${real},`);
    expect(linkedDatabasePath(real)).toBeUndefined();
    expect(linkedDatabasePath(safePath.join(dir, 'none'))).toBeUndefined();
  });

  // A read-only directory the user owns is still theirs to remove: the removal grants itself the
  // owner's rwx on the way down, so it does not stop on it.
  it.skipIf(CANNOT_DENY_READS)('removes a database holding a read-only directory', async () => {
    const db = database(dir, 'db');
    chmodSync(safePath.join(db, 'rag_chunks.lance', 'data'), 0o555);

    await removeRagDatabase(db);

    expect(readdirSync(dir)).toEqual([]);
  });
});
