/**
 * Whose failure an archive extraction is, decided from the error alone: bytes that are no
 * archive are the input's; an errno that names no path happened in VAT's own staging; and a
 * tarball that "extracted" while node-tar warned of a failed entry is refused all the same,
 * the machine's failure first. The tar library is replaced: nothing here reads a disk.
 */

import { isFsFaultError } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { __internal, type ArchiveEntry, archiveFailure, entryClash, extractTarball, extractTarballSync } from '../../src/utils/archive-staging.js';
import { CommandRefusalError } from '../../src/utils/command-refusal.js';

const { keepingEntryFailures, openFailureBehind, zipEntries } = __internal;

type Onwarn = (code: string, message: string, data: unknown) => void;
const { extract, list } = vi.hoisted(() => ({ extract: vi.fn(), list: vi.fn() }));
vi.mock('tar', () => ({ extract, list }));

afterEach(() => {
  extract.mockReset();
  list.mockReset();
});

const errno = (code: string, extra: Record<string, unknown> = {}): Error => Object.assign(new Error(`${code}: failed`), { code, ...extra });
const rejectedSync = (work: () => unknown): unknown => {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
};
const rejectionOf = async (work: () => Promise<unknown>): Promise<unknown> => {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};

describe('archiveFailure', () => {
  it('bytes that are no archive are the input\'s, with nothing changed', () => {
    const cause = new Error('invalid distance too far back');
    const failure = archiveFailure('/in/pkg.tgz', ['/tmp/stage'], cause) as CommandRefusalError;
    expect(failure).toBeInstanceOf(CommandRefusalError);
    expect(failure.refusal).toBe('INPUT_UNREADABLE');
    expect(failure.message).toBe('/in/pkg.tgz could not be extracted, nothing was changed: invalid distance too far back');
    expect(failure.cause).toBe(cause);
  });

  it('a thrown non-error is still worded', () => {
    expect((archiveFailure('/in/pkg.zip', [], 'bad zip') as Error).message).toContain(': bad zip');
  });

  it('an errno that names no path happened while writing into staging: VAT\'s own scratch, never the archive', () => {
    const failure = archiveFailure('/in/pkg.tgz', ['/tmp/stage'], errno('ENOSPC'));
    expect(isFsFaultError(failure)).toBe(true);
    expect(failure).toMatchObject({ side: 'environment', faultClass: 'exhausted', path: '/tmp/stage' });
  });
});

describe('keepingEntryFailures', () => {
  it('hands node-tar the archive, the staging directory and a warning sink', () => {
    const { options, firstFailure } = keepingEntryFailures('/in/pkg.tgz', '/tmp/stage');
    expect(options).toMatchObject({ file: '/in/pkg.tgz', cwd: '/tmp/stage' });
    expect(firstFailure()).toBeUndefined();
  });

  it('an absolute path made relative is information, not a failure', () => {
    const { options, firstFailure } = keepingEntryFailures('/a.tgz', '/s');
    (options.onwarn as Onwarn)('TAR_ENTRY_INFO', 'stripping / from absolute path', {});
    expect(firstFailure()).toBeUndefined();
  });

  it('keeps the error a warning carries, and makes a coded one of a warning that carries none', () => {
    const carried = errno('EISDIR');
    const first = keepingEntryFailures('/a.tgz', '/s');
    (first.options.onwarn as Onwarn)('TAR_ENTRY_ERROR', 'is a directory', carried);
    expect(first.firstFailure()).toBe(carried);

    const second = keepingEntryFailures('/a.tgz', '/s');
    (second.options.onwarn as Onwarn)('TAR_BAD_ARCHIVE', 'Unrecognized archive format', { recoverable: false });
    expect(second.firstFailure()).toMatchObject({ message: 'TAR_BAD_ARCHIVE: Unrecognized archive format', code: 'TAR_BAD_ARCHIVE' });
  });

  it('puts the machine\'s failure first: a full disk explains the entries that failed around it', () => {
    const { options, firstFailure } = keepingEntryFailures('/a.tgz', '/s');
    const full = errno('ENOSPC');
    (options.onwarn as Onwarn)('TAR_ENTRY_ERROR', 'clash', errno('EISDIR'));
    (options.onwarn as Onwarn)('TAR_ENTRY_ERROR', 'no space', full);
    (options.onwarn as Onwarn)('TAR_ENTRY_ERROR', 'clash', errno('ENOTDIR'));
    expect(firstFailure()).toBe(full);
  });
});

describe('extractTarball', () => {
  it('resolves when node-tar extracted every entry', async () => {
    extract.mockResolvedValue(undefined);
    await expect(extractTarball('/in/pkg.tgz', '/tmp/stage')).resolves.toBeUndefined();
    expect(extract).toHaveBeenCalledWith(expect.objectContaining({ file: '/in/pkg.tgz', cwd: '/tmp/stage' }));
  });

  it('refuses an extraction node-tar resolved but warned about: a truncated package is never installed', async () => {
    extract.mockImplementation(async (options: { onwarn: Onwarn }) => {
      options.onwarn('TAR_ENTRY_ERROR', 'no space left', errno('ENOSPC'));
    });
    const failure = await rejectionOf(() => extractTarball('/in/pkg.tgz', '/tmp/stage'));
    expect(failure).toMatchObject({ side: 'environment', faultClass: 'exhausted' });
  });

  it('refuses a tarball node-tar rejects as the input\'s', async () => {
    extract.mockRejectedValue(new Error('TAR_BAD_ARCHIVE: Unrecognized archive format'));
    const failure = await rejectionOf(() => extractTarball('/in/not-a.tgz', '/tmp/stage'));
    expect(failure).toMatchObject({ refusal: 'INPUT_UNREADABLE' });
  });
});

describe('extractTarballSync', () => {
  it('asks node-tar for a synchronous extraction and refuses on a warned entry the same way', () => {
    extract.mockImplementation((options: { onwarn: Onwarn; sync?: boolean }) => {
      expect(options.sync).toBe(true);
      options.onwarn('TAR_ENTRY_ERROR', 'no space left', errno('EDQUOT'));
    });
    expect(() => extractTarballSync('/in/pkg.tgz', '/tmp/stage')).toThrow(expect.objectContaining({ side: 'environment', faultClass: 'exhausted' }));
  });

  it('refuses a tarball node-tar throws on as the input\'s, and returns for a clean one', () => {
    extract.mockImplementation(() => {
      throw new Error('zlib: unexpected end of file');
    });
    expect(() => extractTarballSync('/in/cut.tgz', '/tmp/stage')).toThrow(expect.objectContaining({ refusal: 'INPUT_UNREADABLE' }));
    extract.mockImplementation(() => undefined);
    expect(() => extractTarballSync('/in/ok.tgz', '/tmp/stage')).not.toThrow();
  });
});

describe('openFailureBehind', () => {
  const opened = new Map<string, unknown>([['/tmp/stage/a.md', errno('EMFILE', { syscall: 'open', path: '/tmp/stage/a.md' })]]);

  it('names the failed open behind adm-zip\'s chmod retry, which would blame the archive with ENOENT', () => {
    const chmod = errno('ENOENT', { syscall: 'chmod', path: '/tmp/stage/a.md' });
    expect(openFailureBehind(chmod, opened)).toBe(opened.get('/tmp/stage/a.md'));
  });

  it('keeps the error itself for a chmod of another path, another syscall, or an error that names no path', () => {
    const elsewhere = errno('ENOENT', { syscall: 'chmod', path: '/tmp/stage/b.md' });
    const write = errno('ENOSPC', { syscall: 'write', path: '/tmp/stage/a.md' });
    const pathless = errno('ENOENT', { syscall: 'chmod' });
    expect(openFailureBehind(elsewhere, opened)).toBe(elsewhere);
    expect(openFailureBehind(write, opened)).toBe(write);
    expect(openFailureBehind(pathless, opened)).toBe(pathless);
  });
});

describe('entryClash', () => {
  const file = (name: string): ArchiveEntry => ({ name, directory: false });
  const dir = (name: string): ArchiveEntry => ({ name, directory: true });

  it.each([
    ['a file beside a file under it', [file('a'), file('a/b')], { file: 'a', under: 'a/b' }],
    ['the same two in the other order', [file('a/b'), file('a')], { file: 'a', under: 'a/b' }],
    ['a file under it at any depth', [file('pkg/a'), file('pkg/a/b/c/d')], { file: 'pkg/a', under: 'pkg/a/b/c/d' }],
    ['a directory entry under it', [file('a'), dir('a/b/')], { file: 'a', under: 'a/b/' }],
    ['a directory entry at its own place', [dir('a/'), file('a')], { file: 'a', under: 'a/' }],
    ['names spelled with `.`, `..` and doubled separators', [file('./x/../a'), file('a//b')], { file: './x/../a', under: 'a//b' }],
  ])('names %s', (_label, entries, clash) => {
    expect(entryClash(entries)).toEqual(clash);
  });

  it.each([
    ['siblings, and a name that only starts like another', [file('a'), file('ab'), file('a.d/b'), dir('c/'), file('c/d')]],
    ['the same file twice', [file('a/b'), file('a/b')]],
    ['a directory entry twice, with the files in it', [dir('a'), dir('a/'), file('a/b')]],
    ['two names that differ only in letter case: one place on some volumes only', [file('A'), file('a/b')]],
    ['no entry at all', []],
  ])('finds none among %s', (_label, entries) => {
    expect(entryClash(entries)).toBeUndefined();
  });
});

describe('zipEntries', () => {
  // adm-zip parses the central directory at the first read of the entries, not when the archive is opened.
  it('a central directory adm-zip cannot parse is the archive\'s, with nothing changed', () => {
    const cause = new Error('ADM-ZIP: Duplicate entry name');
    const unparsable = { getEntries: (): never => { throw cause; } };
    const failure = rejectedSync(() => zipEntries(unparsable, 'in/pkg.zip', 'stage/x'));
    expect(failure).toBeInstanceOf(CommandRefusalError);
    expect(failure).toMatchObject({ refusal: 'INPUT_UNREADABLE', message: 'in/pkg.zip could not be extracted, nothing was changed: ADM-ZIP: Duplicate entry name', cause });
  });

  it('names each entry with `/` between segments, as adm-zip extracts a backslash', () => {
    const zip = { getEntries: () => [{ entryName: String.raw`a\b`, isDirectory: false }, { entryName: 'd/', isDirectory: true }] };
    expect(zipEntries(zip, 'in/pkg.zip', 'stage/x')).toEqual([{ name: 'a/b', directory: false }, { name: 'd/', directory: true }]);
  });
});

describe('a tarball whose entries cannot coexist', () => {
  type Listing = { onReadEntry: (entry: { path: string; type: string }) => void; sync?: boolean };
  const listingAClash = (options: Listing): void => {
    expect(options.sync).toBe(true);
    options.onReadEntry({ path: 'package/a', type: 'File' });
    options.onReadEntry({ path: 'package/a/b', type: 'File' });
  };
  const CLASH = '/in/pkg.tgz could not be extracted, nothing was changed: it holds both `package/a` and `package/a/b`, and `package/a` is a file, so no directory can hold the two';

  it('is refused from its listing as the archive\'s, naming both entries, before extractTarballSync writes anything', () => {
    list.mockImplementation(listingAClash);
    expect(() => extractTarballSync('/in/pkg.tgz', '/tmp/stage')).toThrow(expect.objectContaining({ refusal: 'INPUT_UNREADABLE', message: CLASH }));
    expect(extract).not.toHaveBeenCalled();
  });

  it('is refused the same way before extractTarball writes anything', async () => {
    list.mockImplementation(listingAClash);
    expect(await rejectionOf(() => extractTarball('/in/pkg.tgz', '/tmp/stage'))).toMatchObject({ refusal: 'INPUT_UNREADABLE', message: CLASH });
    expect(extract).not.toHaveBeenCalled();
  });

  // `GNUDumpDir` is how an incremental GNU tar spells a directory; node-tar extracts it as one.
  it.each(['Directory', 'GNUDumpDir'])('a %s entry is no file: the files under it are extracted', (type) => {
    list.mockImplementation((options: Listing) => {
      options.onReadEntry({ path: 'package/a/', type });
      options.onReadEntry({ path: 'package/a/b', type: 'File' });
    });
    expect(() => extractTarballSync('/in/pkg.tgz', '/tmp/stage')).not.toThrow();
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('a listing the OS refuses is classified as the extraction\'s own read of the archive would be, and nothing is extracted', () => {
    list.mockImplementation(() => {
      throw errno('ENOSPC');
    });
    expect(() => extractTarballSync('/in/pkg.tgz', '/tmp/stage')).toThrow(expect.objectContaining({ side: 'environment', faultClass: 'exhausted', path: '/tmp/stage' }));
    expect(extract).not.toHaveBeenCalled();
  });
});
