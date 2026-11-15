/**
 * What `extractArchive` asks of the filesystem, and in what order — with the two write primitives
 * and the reading handle replaced, so the decisions are seen without a tree: an accepted archive is
 * one `mkdir` per directory and one exclusive create per file, each file chmod-ed on its handle to
 * the executable bit alone; a refused one asks for nothing; an omitted entry is listed, not
 * written; and every refusal the OS gives is classified on the side that owns it. The integration
 * suite runs the same lane against a real tree.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ArchiveFixtureEntry } from '../src/testing/archive-fixtures.js';

/** One fake handle per file created: what was written to it, and what was asked of it. */
interface FakeHandle {
  readonly path: string;
  written?: Buffer;
  mode?: number;
  closed: boolean;
  writeFile(data: Buffer): Promise<void>;
  stat(): Promise<{ mode: number; size: number }>;
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
  readFile(): Promise<Buffer>;
}

const calls: string[] = [];
const handles: FakeHandle[] = [];
const faults: { open?: Error; write?: Error; read?: Error } = {};
let fileOnDisk = Buffer.alloc(0);
/** The mode an exclusive create gives a file: `0644` under `umask 022`, unless a test says otherwise. */
let createdMode = 0o100644;

function fakeHandle(path: string): FakeHandle {
  const handle: FakeHandle = {
    path,
    closed: false,
    async writeFile(data) {
      if (faults.write !== undefined) throw faults.write;
      handle.written = data;
    },
    // The mode the create gave, and the size of the archive file this handle reads.
    async stat() { return { mode: createdMode, size: fileOnDisk.length }; },
    async chmod(mode) { handle.mode = mode; },
    async close() { handle.closed = true; },
    async readFile() { return fileOnDisk; },
  };
  handles.push(handle);
  return handle;
}

vi.mock('../src/tree-change/files.js', () => ({
  makeDirectoryUnder: vi.fn(async (_root: string, relative: string) => {
    calls.push(`mkdir ${relative}`);
    return relative;
  }),
  openFileUnder: vi.fn(async (_root: string, relative: string, options: { existing: string }) => {
    if (faults.open !== undefined) throw faults.open;
    calls.push(`create ${relative} (${options.existing})`);
    return fakeHandle(relative);
  }),
}));

vi.mock('../src/text-file.js', () => ({
  openForReading: vi.fn(async (file: string) => {
    if (faults.read !== undefined) throw faults.read;
    calls.push(`read ${file}`);
    return fakeHandle(file);
  }),
}));

const { extractArchive } = await import('../src/archive/archive.js');
const { ARCHIVE_REFUSED_CODE } = await import('../src/archive/entries.js');
const { isFsFaultError } = await import('../src/errors/fs-fault.js');
const { isVatError } = await import('../src/errors/vat-error.js');
const { tarFixture, zipFixture } = await import('../src/testing/archive-fixtures.js');

const LIMITS = { maxEntries: 20, maxBytes: 4096 } as const;

const SOUND: readonly ArchiveFixtureEntry[] = [
  { name: './', kind: 'directory' },
  { name: 'skill/', kind: 'directory' },
  { name: 'skill/SKILL.md', data: '# skill\n' },
  { name: 'skill/run.sh', data: 'echo\n', mode: 0o4755 },
];

const errno = (code: string, path: string): Error => Object.assign(new Error(`${code}: refused, '${path}'`), { code, path });

async function rejectionOf(work: () => Promise<unknown>): Promise<unknown> {
  return await work().then(() => { throw new Error('expected a rejection'); }, (error: unknown) => error);
}

/** Forget what the previous test asked for. */
function reset(): void {
  calls.length = 0;
  handles.length = 0;
  delete faults.open;
  delete faults.write;
  delete faults.read;
  fileOnDisk = Buffer.alloc(0);
  createdMode = 0o100644;
}

describe.each([
  ['tar', tarFixture],
  ['zip', zipFixture],
] as const)('extractArchive (%s), its writes', (format, build) => {
  it('makes each directory and creates each file exclusively, in archive order, the archive\'s own root not made', async () => {
    reset();
    const listed = await extractArchive({ bytes: build(SOUND), label: `fixture.${format}` }, '/into', { format, limits: LIMITS });

    expect(listed.map((entry) => entry.name)).toEqual(['./', 'skill/', 'skill/SKILL.md', 'skill/run.sh']);
    expect(calls).toEqual(['mkdir skill', 'create skill/SKILL.md (refuse)', 'create skill/run.sh (refuse)']);
    expect(handles.map(({ path, written, mode, closed }) => ({ path, data: written?.toString(), mode, closed }))).toEqual([
      { path: 'skill/SKILL.md', data: '# skill\n', mode: 0o644, closed: true },
      // Executable, never setuid: the bit the archive set beside it is dropped.
      { path: 'skill/run.sh', data: 'echo\n', mode: 0o755, closed: true },
    ]);
  });

  // The created mode decides, the archive's only by its executable bit: an archive `0777` file
  // under `umask 077` is `0700`, an archive `0600` file executable nowhere is `0600` — never a
  // constant mode, and never the archive's own bits with only the special ones dropped.
  it('chmods each file to what the create gave it, with execute only where the archive set it', async () => {
    reset();
    createdMode = 0o100600;
    await extractArchive({ bytes: build([{ name: 'wide.sh', data: 'x', mode: 0o777 }, { name: 'narrow.md', data: 'y', mode: 0o600 }]), label: 'fixture' }, '/into', { format, limits: LIMITS });

    expect(handles.map(({ path, mode }) => [path, mode])).toEqual([['wide.sh', 0o700], ['narrow.md', 0o600]]);
  });

  it('asks for nothing when one entry is refused, however late it comes', async () => {
    reset();
    const error = await rejectionOf(() => extractArchive({ bytes: build([...SOUND, { name: 'skill/../../x', data: 'x' }]), label: 'hostile' }, '/into', { format, limits: LIMITS }));

    expect(isVatError(error, ARCHIVE_REFUSED_CODE)).toBe(true);
    expect(error).toMatchObject({ reason: 'unsafe-name', entry: 'skill/../../x' });
    expect(calls).toEqual([]);
  });

  it('lists an omitted entry and writes none of it', async () => {
    reset();
    const listed = await extractArchive({ bytes: build(SOUND), label: 'fixture' }, '/into', { format, limits: LIMITS, omit: (entry) => entry.name.endsWith('.sh') });

    expect(listed).toHaveLength(4);
    expect(calls).toEqual(['mkdir skill', 'create skill/SKILL.md (refuse)']);
  });

  it('classifies a create the OS refuses on the environment\'s side, naming the extraction', async () => {
    reset();
    faults.open = errno('EACCES', '/into/skill/SKILL.md');
    const error = await rejectionOf(() => extractArchive({ bytes: build(SOUND), label: 'fixture' }, '/into', { format, limits: LIMITS }));

    expect(isFsFaultError(error)).toBe(true);
    expect(error).toMatchObject({ side: 'environment', faultClass: 'refused', errno: 'EACCES' });
  });

  it('closes a file whose write the OS refuses, and classifies the refusal', async () => {
    reset();
    faults.write = errno('ENOSPC', '/into/skill/SKILL.md');
    const error = await rejectionOf(() => extractArchive({ bytes: build(SOUND), label: 'fixture' }, '/into', { format, limits: LIMITS }));

    expect(error).toMatchObject({ side: 'environment', faultClass: 'exhausted' });
    expect(handles.map((handle) => handle.closed)).toEqual([true]);
  });
});

describe('extractArchive from a file', () => {
  it('reads the archive through its handle and closes it', async () => {
    reset();
    fileOnDisk = tarFixture(SOUND);
    await extractArchive({ file: '/in/pkg.tgz', side: 'source' }, '/into', { format: 'tar', limits: LIMITS });

    expect(calls[0]).toBe('read /in/pkg.tgz');
    expect(handles[0]).toMatchObject({ path: '/in/pkg.tgz', closed: true });
  });

  it('refuses a file larger than any archive within the limits before reading a byte of it, and closes it', async () => {
    reset();
    fileOnDisk = Buffer.alloc(2 * 1024 * 1024);
    const error = await rejectionOf(() => extractArchive({ file: '/in/big.tgz', side: 'source' }, '/into', { format: 'tar', limits: LIMITS }));

    expect(error).toMatchObject({ code: ARCHIVE_REFUSED_CODE, reason: 'too-large' });
    expect(handles[0]?.closed).toBe(true);
    expect(calls).toEqual(['read /in/big.tgz']);
  });

  it('classifies a read the OS refuses on the side that named the file', async () => {
    reset();
    faults.read = errno('ENOENT', '/in/missing.zip');
    const error = await rejectionOf(() => extractArchive({ file: '/in/missing.zip', side: 'source' }, '/into', { format: 'zip', limits: LIMITS }));

    expect(isFsFaultError(error)).toBe(true);
    expect(error).toMatchObject({ side: 'source', faultClass: 'absent', errno: 'ENOENT' });
  });
});
