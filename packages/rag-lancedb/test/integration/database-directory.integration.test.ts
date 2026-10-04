import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

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
    writeFileSync(safePath.join(db, '.DS_Store'), '');

    removeRagDatabase(db);

    expect(existsSync(db)).toBe(false);
  });

  it('refuses a directory holding anything else, coded, and removes nothing', () => {
    const db = database(dir, 'db');
    writeFileSync(safePath.join(db, 'notes.md'), 'mine');

    expect(isVatError(removalError(db), RAG_DATABASE_NOT_REMOVABLE_CODE)).toBe(true);
    expect(existsSync(safePath.join(db, 'notes.md'))).toBe(true);
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
