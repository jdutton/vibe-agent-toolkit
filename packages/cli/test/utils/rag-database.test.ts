/**
 * The refusals every `vat rag` verb makes before it touches a database path,
 * decided against a FAKE filesystem: each case scripts what `stat`, `lstat`,
 * `readdir` and `access` answer, so every arm — a file, a path under a file, an
 * absent project default, foreign entries, a write the OS refuses — is
 * reached without a real tree, on every platform and under uid 0.
 */

import type * as Fs from 'node:fs';

import type * as RagLancedb from '@vibe-agent-toolkit/rag-lancedb';
import type * as Utils from '@vibe-agent-toolkit/utils';
import { TREE_DEST_NOT_OWNED_CODE, VatError } from '@vibe-agent-toolkit/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { refusalCodeOf } from '../../src/utils/command-refusal.js';
import { notRemovableRefusal, requireExistingDatabase, requireWritableDatabase } from '../../src/utils/rag-database.js';
import { errno } from '../helpers/refusal-doubles.js';

const fakeFs = vi.hoisted(() => ({
  accessSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof Fs>()), ...fakeFs }));

const fakeUtils = vi.hoisted(() => ({ mkdirSyncReal: vi.fn() }));
vi.mock('@vibe-agent-toolkit/utils', async (importOriginal) => ({ ...(await importOriginal<typeof Utils>()), ...fakeUtils }));

const fakeRag = vi.hoisted(() => ({ linkedDatabasePath: vi.fn() }));
vi.mock('@vibe-agent-toolkit/rag-lancedb', async (importOriginal) => ({ ...(await importOriginal<typeof RagLancedb>()), ...fakeRag }));

const DB = '/proj/.rag-db';

/** A typed directory entry as `readdirSync(…, { withFileTypes: true })` gives it. */
function entry(name: string, file = false): { name: string; isFile: () => boolean } {
  return { name, isFile: () => file };
}

function directory(): { isDirectory: () => boolean } {
  return { isDirectory: () => true };
}

/** What `fn` threw: its published refusal code, its message, and — for a classified fault — its side. */
function refusalOf(fn: () => void): { code: string; message: string; side: unknown } {
  try {
    fn();
  } catch (error) {
    return { code: refusalCodeOf(error), message: (error as Error).message, side: (error as { side?: unknown }).side };
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  for (const fn of Object.values(fakeFs)) fn.mockReset();
  fakeUtils.mkdirSyncReal.mockReset();
  fakeFs.statSync.mockReturnValue(directory());
  fakeFs.readdirSync.mockReturnValue([]);
});

describe('requireExistingDatabase', () => {
  it('passes an empty directory, a RAG database, and one holding only OS litter', () => {
    expect(() => requireExistingDatabase(DB, true, 'source')).not.toThrow();
    fakeFs.readdirSync.mockReturnValue([entry('rag_chunks.lance'), entry('rag_documents.lance'), entry('desktop.ini', true)]);
    expect(() => requireExistingDatabase(DB, true, 'source')).not.toThrow();
  });

  it('refuses foreign entries — USAGE_INVALID for a --db, INPUT_UNREADABLE for the project default — naming five and counting the rest', () => {
    fakeFs.readdirSync.mockReturnValue(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => entry(name, true)));

    const explicit = refusalOf(() => requireExistingDatabase(DB, true, 'source'));
    expect(explicit.code).toBe('USAGE_INVALID');
    expect(explicit.message).toContain('holds a, b, c, d, e and 2 more');
    expect(explicit.message).toContain('point --db at');

    const implicit = refusalOf(() => requireExistingDatabase(DB, false, 'source'));
    expect(implicit.code).toBe('INPUT_UNREADABLE');
    expect(implicit.message).toContain("move those entries out of the project's .rag-db");
  });

  it('refuses a path that is a file, and says when it is a path ABOVE it that is one', () => {
    fakeFs.readdirSync.mockImplementation(() => {
      throw errno('ENOTDIR');
    });
    fakeFs.statSync.mockReturnValue({ isDirectory: () => false });
    expect(refusalOf(() => requireExistingDatabase(DB, true, 'source'))).toMatchObject({ code: 'USAGE_INVALID', message: `Not a RAG database: ${DB} is not a directory.` });

    fakeFs.statSync.mockImplementation(() => {
      throw errno('ENOTDIR');
    });
    expect(refusalOf(() => requireExistingDatabase(DB, false, 'source'))).toMatchObject({
      code: 'INPUT_UNREADABLE',
      message: `Not a RAG database: a path above ${DB} is not a directory.`,
    });
  });

  it('refuses a file whose own stat the OS then refuses as unreadable', () => {
    fakeFs.readdirSync.mockImplementation(() => {
      throw errno('ENOTDIR');
    });
    fakeFs.statSync.mockImplementation(() => {
      throw errno('EACCES');
    });
    expect(refusalOf(() => requireExistingDatabase(DB, true, 'source'))).toMatchObject({ code: 'INPUT_UNREADABLE' });
  });

  it('reports an absent project default as nothing indexed, and an absent --db as a path that does not exist', () => {
    fakeFs.readdirSync.mockImplementation(() => {
      throw errno('ENOENT');
    });
    expect(refusalOf(() => requireExistingDatabase(DB, false, 'source')).message).toContain('No data indexed yet');
    expect(refusalOf(() => requireExistingDatabase(DB, true, 'source'))).toMatchObject({ code: 'USAGE_INVALID', message: `Path does not exist: ${DB}` });
  });

  it('classifies a directory the OS will not list on the verb\'s side: a read verb\'s input, a clear\'s output', () => {
    fakeFs.readdirSync.mockImplementation(() => {
      throw errno('EACCES');
    });
    expect(refusalOf(() => requireExistingDatabase(DB, true, 'source'))).toMatchObject({ code: 'INPUT_UNREADABLE', side: 'source', message: `Could not list the RAG database (EACCES): ${DB}` });
    expect(refusalOf(() => requireExistingDatabase(DB, true, 'destination'))).toMatchObject({ code: 'RUN_INCOMPLETE', side: 'destination' });
  });
});

describe('notRemovableRefusal', () => {
  const notOwned = new VatError(TREE_DEST_NOT_OWNED_CODE, 'RAG database: refusing to remove /proj/.rag-db: it is a symbolic link to /elsewhere');

  it('is the invocation\'s for a --db, and the project\'s state for its own .rag-db', () => {
    fakeRag.linkedDatabasePath.mockReturnValue(undefined);
    expect(refusalOf(() => {
      throw notRemovableRefusal(notOwned, DB, true);
    })).toMatchObject({ code: 'USAGE_INVALID', message: expect.stringContaining('/elsewhere') });
    expect(refusalOf(() => {
      throw notRemovableRefusal(notOwned, DB, false);
    }).code).toBe('INPUT_UNREADABLE');
  });

  it('ends a link\'s refusal with the command that clears the real database', () => {
    fakeRag.linkedDatabasePath.mockReturnValue('/real/db');
    expect(refusalOf(() => {
      throw notRemovableRefusal(notOwned, DB, true);
    }).message).toContain('Run vat rag clear --db /real/db to clear the database itself.');
    expect(fakeRag.linkedDatabasePath).toHaveBeenCalledWith(DB);
  });

  it('leaves every other error as it is', () => {
    const other = errno('EACCES');
    expect(notRemovableRefusal(other, DB, true)).toBe(other);
  });
});

describe('requireWritableDatabase', () => {
  it('creates an absent database directory, and probes an existing one for writing', () => {
    fakeFs.statSync.mockImplementation(() => {
      throw errno('ENOENT');
    });
    requireWritableDatabase(DB, true);
    expect(fakeUtils.mkdirSyncReal).toHaveBeenCalledWith(DB, { recursive: true });

    fakeFs.statSync.mockReturnValue(directory());
    requireWritableDatabase(DB, true);
    expect(fakeFs.accessSync).toHaveBeenCalledTimes(1);
  });

  it('refuses a path under a file, and a file itself, by who named it', () => {
    fakeFs.statSync.mockImplementation(() => {
      throw errno('ENOTDIR');
    });
    expect(refusalOf(() => requireWritableDatabase(DB, true))).toMatchObject({ code: 'USAGE_INVALID', message: `Cannot index into ${DB}: a path above it is not a directory.` });

    fakeFs.statSync.mockReturnValue({ isDirectory: () => false });
    expect(refusalOf(() => requireWritableDatabase(DB, false))).toMatchObject({
      code: 'INPUT_UNREADABLE',
      message: `Cannot index into ${DB}: it is not a directory, so it cannot hold a RAG database.`,
    });
  });

  it('classifies a path the OS will not examine as a destination fault: the database is what index writes', () => {
    fakeFs.statSync.mockImplementation(() => {
      throw errno('EACCES');
    });
    expect(refusalOf(() => requireWritableDatabase(DB, true))).toMatchObject({ code: 'RUN_INCOMPLETE', side: 'destination' });
  });

  it('refuses a directory holding foreign entries before writing anything', () => {
    fakeFs.readdirSync.mockReturnValue([entry('keep.txt', true)]);

    expect(refusalOf(() => requireWritableDatabase(DB, true))).toMatchObject({ code: 'USAGE_INVALID', message: expect.stringContaining('Nothing was indexed') as unknown });
    expect(fakeFs.accessSync).not.toHaveBeenCalled();
  });

  it('ends a create or write the OS refuses as RUN_INCOMPLETE, and lets a defect through', () => {
    fakeFs.accessSync.mockImplementation(() => {
      throw errno('EACCES');
    });
    expect(refusalOf(() => requireWritableDatabase(DB, true))).toMatchObject({ code: 'RUN_INCOMPLETE', side: 'destination', message: expect.stringContaining(`write into the RAG database directory (EACCES): ${DB}`) as unknown });

    fakeFs.statSync.mockImplementation(() => {
      throw errno('ENOENT');
    });
    fakeUtils.mkdirSyncReal.mockImplementation(() => {
      throw errno('EROFS');
    });
    expect(refusalOf(() => requireWritableDatabase(DB, true))).toMatchObject({ code: 'RUN_INCOMPLETE', message: expect.stringContaining('Could not create') as unknown });

    const defect = new TypeError('defect');
    fakeUtils.mkdirSyncReal.mockImplementation(() => {
      throw defect;
    });
    expect(() => requireWritableDatabase(DB, true)).toThrow(defect);
  });
});
