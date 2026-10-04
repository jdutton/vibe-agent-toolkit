/**
 * The refusals every `vat rag` verb makes before it touches a database path,
 * decided against a FAKE filesystem: each case scripts what `stat`, `lstat`,
 * `readdir` and `access` answer, so every arm — a file, a path under a file, an
 * absent project default, foreign entries, a link, a write the OS refuses — is
 * reached without a real tree, on every platform and under uid 0.
 */

import type * as Fs from 'node:fs';

import type * as Utils from '@vibe-agent-toolkit/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { refusalCodeOf } from '../../src/utils/command-refusal.js';
import { refuseLinkedDatabase, requireExistingDatabase, requireWritableDatabase } from '../../src/utils/rag-database.js';
import { errno } from '../helpers/refusal-doubles.js';

const fakeFs = vi.hoisted(() => ({
  accessSync: vi.fn(),
  lstatSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof Fs>()), ...fakeFs }));

const fakeUtils = vi.hoisted(() => ({ mkdirSyncReal: vi.fn(), normalizePath: vi.fn((p: string) => `/real${p}`) }));
vi.mock('@vibe-agent-toolkit/utils', async (importOriginal) => ({ ...(await importOriginal<typeof Utils>()), ...fakeUtils }));

const DB = '/proj/.rag-db';

/** A typed directory entry as `readdirSync(…, { withFileTypes: true })` gives it. */
function entry(name: string, file = false): { name: string; isFile: () => boolean } {
  return { name, isFile: () => file };
}

function directory(): { isDirectory: () => boolean } {
  return { isDirectory: () => true };
}

/** What `fn` threw: its published refusal code and its message. */
function refusalOf(fn: () => void): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    return { code: refusalCodeOf(error), message: (error as Error).message };
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
    expect(() => requireExistingDatabase(DB, true)).not.toThrow();
    fakeFs.readdirSync.mockReturnValue([entry('rag_chunks.lance'), entry('rag_documents.lance'), entry('.DS_Store', true)]);
    expect(() => requireExistingDatabase(DB, true)).not.toThrow();
  });

  it('refuses foreign entries — USAGE_INVALID for a --db, INPUT_UNREADABLE for the project default — naming five and counting the rest', () => {
    fakeFs.readdirSync.mockReturnValue(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => entry(name, true)));

    const explicit = refusalOf(() => requireExistingDatabase(DB, true));
    expect(explicit.code).toBe('USAGE_INVALID');
    expect(explicit.message).toContain('holds a, b, c, d, e and 2 more');
    expect(explicit.message).toContain('point --db at');

    const implicit = refusalOf(() => requireExistingDatabase(DB, false));
    expect(implicit.code).toBe('INPUT_UNREADABLE');
    expect(implicit.message).toContain("move those entries out of the project's .rag-db");
  });

  it('refuses a path that is a file, and says when it is a path ABOVE it that is one', () => {
    fakeFs.readdirSync.mockImplementation(() => {
      throw errno('ENOTDIR');
    });
    fakeFs.statSync.mockReturnValue({ isDirectory: () => false });
    expect(refusalOf(() => requireExistingDatabase(DB, true))).toMatchObject({ code: 'USAGE_INVALID', message: `Not a RAG database: ${DB} is not a directory.` });

    fakeFs.statSync.mockImplementation(() => {
      throw errno('ENOTDIR');
    });
    expect(refusalOf(() => requireExistingDatabase(DB, false))).toMatchObject({
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
    expect(refusalOf(() => requireExistingDatabase(DB, true))).toMatchObject({ code: 'INPUT_UNREADABLE' });
  });

  it('reports an absent project default as nothing indexed, and an absent --db as a path that does not exist', () => {
    fakeFs.readdirSync.mockImplementation(() => {
      throw errno('ENOENT');
    });
    expect(refusalOf(() => requireExistingDatabase(DB, false)).message).toContain('No data indexed yet');
    expect(refusalOf(() => requireExistingDatabase(DB, true))).toMatchObject({ code: 'USAGE_INVALID', message: `Path does not exist: ${DB}` });
  });

  it('refuses a directory the OS will not list as INPUT_UNREADABLE, naming the errno', () => {
    fakeFs.readdirSync.mockImplementation(() => {
      throw errno('EACCES');
    });
    expect(refusalOf(() => requireExistingDatabase(DB, true))).toMatchObject({ code: 'INPUT_UNREADABLE', message: `Path cannot be read (EACCES): ${DB}` });
  });
});

describe('refuseLinkedDatabase', () => {
  it('passes a real directory', () => {
    fakeFs.lstatSync.mockReturnValue({ isSymbolicLink: () => false });
    expect(() => refuseLinkedDatabase(DB, true)).not.toThrow();
  });

  it('refuses a link, naming the real path to clear instead', () => {
    fakeFs.lstatSync.mockReturnValue({ isSymbolicLink: () => true });

    const explicit = refusalOf(() => refuseLinkedDatabase(DB, true));
    expect(explicit.code).toBe('USAGE_INVALID');
    expect(explicit.message).toContain('vat rag clear --db /real');
    expect(refusalOf(() => refuseLinkedDatabase(DB, false)).code).toBe('INPUT_UNREADABLE');
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

  it('refuses a path the OS will not examine as INPUT_UNREADABLE', () => {
    fakeFs.statSync.mockImplementation(() => {
      throw errno('EACCES');
    });
    expect(refusalOf(() => requireWritableDatabase(DB, true))).toMatchObject({ code: 'INPUT_UNREADABLE' });
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
    expect(refusalOf(() => requireWritableDatabase(DB, true))).toMatchObject({ code: 'RUN_INCOMPLETE', message: expect.stringContaining(`write into the RAG database directory ${DB} (EACCES)`) as unknown });

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
