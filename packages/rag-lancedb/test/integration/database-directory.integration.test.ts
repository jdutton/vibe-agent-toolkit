import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { createSymlink, isVatError, mkdirSyncReal, normalizedTmpdir, RAG_DATABASE_NOT_REMOVABLE_CODE, RAG_DATABASE_REMOVAL_INCOMPLETE_CODE, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { removeRagDatabase } from '../../src/database-directory.js';

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

/** What `removeRagDatabase(path)` threw, or undefined. */
function removalError(path: string): unknown {
  try {
    removeRagDatabase(path);
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('removeRagDatabase', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-rag-remove-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes a database that holds operating-system litter beside its tables', () => {
    const db = database(dir, 'db');
    writeFileSync(safePath.join(db, '.DS_Store'), DS_STORE);
    writeFileSync(safePath.join(db, '._rag_chunks.lance'), APPLE_DOUBLE);
    writeFileSync(safePath.join(db, 'Thumbs.db'), THUMBS_DB);
    writeFileSync(safePath.join(db, 'desktop.ini'), '[.ShellClassInfo]\r\n');

    removeRagDatabase(db);

    expect(existsSync(db)).toBe(false);
  });

  // A litter NAME is not litter: `._notes` is a name a person can give a file. Only the bytes the
  // OS writes at the start of each such file say the OS made it.
  it.each([
    ['._notes', 'my notes'],
    ['._notes', ''],
    ['.DS_Store', 'not finder'],
    ['Thumbs.db', 'not a thumbnail cache'],
  ])('refuses a regular file named %s whose bytes are not the OS signature, and removes nothing', (name, content) => {
    const db = database(dir, 'db');
    writeFileSync(safePath.join(db, name), content);

    const error = removalError(db);

    expect(isVatError(error, RAG_DATABASE_NOT_REMOVABLE_CODE), String(error)).toBe(true);
    expect(String(error)).toContain(name);
    expect(readFileSync(safePath.join(db, name), 'utf8')).toBe(content);
  });

  it('refuses a directory holding anything else, coded, and removes nothing', () => {
    const db = database(dir, 'db');
    writeFileSync(safePath.join(db, 'notes.md'), 'mine');

    expect(isVatError(removalError(db), RAG_DATABASE_NOT_REMOVABLE_CODE)).toBe(true);
    expect(existsSync(safePath.join(db, 'notes.md'))).toBe(true);
  });

  // Litter is a FILE the OS wrote. A directory (or a link) that merely carries a litter name is
  // the user's: `._notes/` full of files once made the whole tree removable.
  it('refuses a directory whose litter-named entries are not regular files, and removes nothing', ({ skip }) => {
    const db = database(dir, 'db');
    mkdirSyncReal(safePath.join(db, '._notes'));
    writeFileSync(safePath.join(db, '._notes', 'a.txt'), 'precious');
    writeFileSync(safePath.join(db, '.DS_Store'), DS_STORE);

    const error = removalError(db);

    expect(isVatError(error, RAG_DATABASE_NOT_REMOVABLE_CODE), String(error)).toBe(true);
    expect(String(error)).toContain('._notes');
    expect(existsSync(safePath.join(db, '._notes', 'a.txt'))).toBe(true);

    const cap = symlinkCapability() ?? skip();
    rmSync(safePath.join(db, '._notes'), { recursive: true });
    createSymlink(cap, safePath.join(dir, 'elsewhere'), safePath.join(db, 'Thumbs.db'), 'file');
    expect(isVatError(removalError(db), RAG_DATABASE_NOT_REMOVABLE_CODE)).toBe(true);
    expect(existsSync(db)).toBe(true);
  });

  // Removing a link removes only the link: the index it names would survive a "cleared" report.
  it('refuses a symbolic link to a database, naming the real path, and removes nothing', ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const real = database(dir, 'real');
    const link = safePath.join(dir, 'link');
    createSymlink(cap, real, link, 'dir');

    const error = removalError(link);

    expect(isVatError(error, RAG_DATABASE_NOT_REMOVABLE_CODE), String(error)).toBe(true);
    expect(String(error)).toContain('real');
    expect(existsSync(link)).toBe(true);
    expect(existsSync(safePath.join(real, 'rag_chunks.lance', 'data', 'a.lance'))).toBe(true);
  });

  it.skipIf(CANNOT_DENY_READS)('codes a removal the OS stopped partway as incomplete, not as a defect', () => {
    const db = database(dir, 'db');
    const locked = safePath.join(db, 'rag_documents.lance', 'data');
    mkdirSyncReal(locked, { recursive: true });
    writeFileSync(safePath.join(locked, 'b.lance'), 'x');
    chmodSync(locked, 0o555);
    let error: unknown;
    try {
      error = removalError(db);
    } finally {
      chmodSync(locked, 0o755);
    }

    expect(isVatError(error, RAG_DATABASE_REMOVAL_INCOMPLETE_CODE), String(error)).toBe(true);
  });
});
