/**
 * The two format readers, over archives held in memory: what each lists, and what each refuses
 * to read. Nothing here touches a disk — extraction is `integration/archive-extract`.
 */
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { extractedFileMode, listArchive, openArchive } from '../src/archive/archive.js';
import { ARCHIVE_REFUSED_CODE, type ArchiveFormat, type ArchiveLimits } from '../src/archive/entries.js';
import { sameDirectory } from '../src/archive/zip-reader.js';
import { isVatError } from '../src/errors/vat-error.js';
import { type ArchiveFixtureEntry, paxRecord, tarFixture, zipFixture } from '../src/testing/archive-fixtures.js';

const LIMITS: ArchiveLimits = { maxEntries: 20, maxBytes: 1000 };

const FORMATS: ReadonlyArray<{ format: ArchiveFormat; build: (entries: readonly ArchiveFixtureEntry[]) => Buffer }> = [
  { format: 'tar', build: (entries) => tarFixture(entries) },
  { format: 'zip', build: (entries) => zipFixture(entries) },
];

const list = (format: ArchiveFormat, bytes: Buffer, limits = LIMITS): ReturnType<typeof listArchive> =>
  listArchive({ bytes, label: `fixture.${format}` }, { format, limits });

async function refusalOf(work: () => Promise<unknown>): Promise<{ reason?: string; entry?: string; message: string }> {
  try {
    await work();
  } catch (error) {
    expect(isVatError(error, ARCHIVE_REFUSED_CODE), String(error)).toBe(true);
    return error as { reason?: string; entry?: string; message: string };
  }
  throw new Error('expected a refusal, and nothing was thrown');
}

describe.each(FORMATS)('listArchive ($format)', ({ format, build }) => {
  it('lists every entry as the archive spells it, judging nothing', async () => {
    const entries = await list(format, build([
      { name: 'skill/', kind: 'directory' },
      { name: 'skill/SKILL.md', data: 'hello' },
      { name: 'skill/keys', kind: 'link', target: '../../secret' },
      { name: 'skill/dev', kind: 'device' },
      { name: '../up.md', data: 'x' },
      { name: String.raw`C:\x.md`, data: 'x' },
    ]));

    expect(entries.map(({ name, kind, size }) => ({ name, kind, size }))).toEqual([
      { name: 'skill/', kind: 'directory', size: 0 },
      { name: 'skill/SKILL.md', kind: 'file', size: 5 },
      { name: 'skill/keys', kind: 'link', size: 0 },
      { name: 'skill/dev', kind: 'other', size: 0 },
      { name: '../up.md', kind: 'file', size: 1 },
      { name: String.raw`C:\x.md`, kind: 'file', size: 1 },
    ]);
  });

  it('hands back a file\'s bytes', async () => {
    const opened = await openArchive({ bytes: build([{ name: 'a.md', data: 'hello' }]), label: 'fixture' }, { format, limits: LIMITS });
    const [entry] = opened.entries;
    expect(entry === undefined ? undefined : opened.read(entry).toString()).toBe('hello');
  });

  it('refuses bytes that are no archive', async () => {
    expect(await refusalOf(() => list(format, Buffer.from('this is not an archive, of either format, at all')))).toMatchObject({ reason: 'unreadable' });
  });

  it('refuses an empty input', async () => {
    expect(await refusalOf(() => list(format, Buffer.alloc(0)))).toMatchObject({ reason: 'unreadable' });
  });

  it('refuses more entries than the limit, and accepts exactly the limit', async () => {
    const entries = (count: number): ArchiveFixtureEntry[] => Array.from({ length: count }, (_unused, index) => ({ name: `f${index}`, data: '' }));
    expect(await list(format, build(entries(LIMITS.maxEntries)))).toHaveLength(LIMITS.maxEntries);
    expect(await refusalOf(() => list(format, build(entries(LIMITS.maxEntries + 1))))).toMatchObject({ reason: 'too-many-entries' });
  });

  it('refuses more bytes than the limit, summed over its files, and accepts exactly the limit', async () => {
    const half = 'x'.repeat(LIMITS.maxBytes / 2);
    expect(await list(format, build([{ name: 'a', data: half }, { name: 'b', data: half }]))).toHaveLength(2);
    expect(await refusalOf(() => list(format, build([{ name: 'a', data: half }, { name: 'b', data: `${half}x` }])))).toMatchObject({ reason: 'too-large' });
  });

  it('refuses on the size an entry DECLARES, before any of it is inflated', async () => {
    expect(await refusalOf(() => list(format, build([{ name: 'bomb', data: '', declaredSize: LIMITS.maxBytes + 1 }])))).toMatchObject({ reason: 'too-large' });
  });
});

describe('listArchive (tar)', () => {
  it('reads a plain tar as well as a gzipped one', async () => {
    expect(await list('tar', tarFixture([{ name: 'a.md', data: 'hi' }], { gzip: false }))).toHaveLength(1);
  });

  it('lists a hard link as one', async () => {
    expect(await list('tar', tarFixture([{ name: 'a', data: 'x' }, { name: 'b', kind: 'hardlink', target: 'a' }]))).toMatchObject([{ kind: 'file' }, { kind: 'hardlink' }]);
  });

  it('refuses a gzip stream that inflates past what the limits allow, without holding it', async () => {
    // A sound one-entry archive, then 8 MiB of zeros AFTER its end marker: no header declares a byte
    // of them, so no per-entry bound sees them — only the bound on the inflation itself can refuse.
    const sound = tarFixture([{ name: 'a', data: 'tiny' }], { gzip: false });
    const bomb = gzipSync(Buffer.concat([sound, Buffer.alloc(8 * 1024 * 1024)]));
    const tight: ArchiveLimits = { maxEntries: 1, maxBytes: 10 };

    // The control: the same archive without the trailing zeros is within the same limits.
    expect(await list('tar', gzipSync(sound), tight)).toHaveLength(1);
    expect(await refusalOf(() => list('tar', bomb, tight))).toMatchObject({ reason: 'too-large' });
  });

  // One decompression layer, and it is VAT's own, bounded. The tar library sniffs its input for a
  // compression magic of its own and would inflate a second layer with no bound of VAT's.
  it('refuses a tarball compressed twice, rather than hand the inner layer to an unbounded inflate', async () => {
    const twice = gzipSync(tarFixture([{ name: 'a.md', data: 'hello' }]));
    expect(await refusalOf(() => list('tar', twice))).toMatchObject({ reason: 'unreadable', message: expect.stringContaining('compressed more than once') });
  });

  it.each([
    ['plain', (bytes: Buffer): Buffer => bytes],
    ['inside a gzip layer', (bytes: Buffer): Buffer => gzipSync(bytes)],
  ])('refuses a stream that begins with the zstd magic, %s', async (_where, wrap) => {
    const zstd = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.alloc(1024)]);
    expect(await refusalOf(() => list('tar', wrap(zstd)))).toMatchObject({ reason: 'unreadable', message: expect.stringContaining('zstd') });
  });

  // What `npm pack` may write beside files and directories, and VAT must keep accepting.
  it('lists a GNU dump directory as the directory it is', async () => {
    expect(await list('tar', tarFixture([{ name: 'dir/', kind: 'directory', tarType: 'D' }, { name: 'dir/a.md', data: 'x' }]))).toMatchObject([
      { name: 'dir/', kind: 'directory' },
      { name: 'dir/a.md', kind: 'file' },
    ]);
  });

  // The tar library skips an entry of a type it does not model and says nothing; an archive that
  // installs without one of its entries is a different tree than `tar xf` makes of it.
  it.each([['a sparse file', 'S'], ['a continuation', 'M'], ['a tape volume header', 'V'], ['a type no tar defines', 'Z']])('lists %s as an entry it does not read, never drops it', async (_what, tarType) => {
    const entries = await list('tar', tarFixture([{ name: 'a.md', data: 'x' }, { name: 'odd.bin', tarType, data: 'body' }, { name: 'b.md', data: 'y' }]));
    expect(entries.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: 'a.md', kind: 'file' },
      { name: 'odd.bin', kind: 'other' },
      { name: 'b.md', kind: 'file' },
    ]);
  });

  it('names an entry by what a PAX header or a GNU long-name record renames it to', async () => {
    const nul = String.fromCodePoint(0);
    const entries = await list('tar', tarFixture([
      { name: 'PaxHeader/one.md', tarType: 'x', data: paxRecord('path', '../pax.md') },
      { name: 'one.md', data: 'x' },
      { name: '././@LongLink', tarType: 'L', data: `../gnu.md${nul}` },
      { name: 'two.md', data: 'y' },
    ]));
    expect(entries.map((entry) => entry.name)).toEqual(['../pax.md', '../gnu.md']);
  });

  it('refuses a gzip stream cut short', async () => {
    const whole = tarFixture([{ name: 'a.md', data: 'hello' }]);
    expect(await refusalOf(() => list('tar', whole.subarray(0, whole.length - 8)))).toMatchObject({ reason: 'unreadable' });
  });

  it('refuses a tar stream cut short inside an entry', async () => {
    const whole = tarFixture([{ name: 'a.md', data: 'x'.repeat(600) }], { gzip: false });
    expect(await refusalOf(() => list('tar', whole.subarray(0, 512 + 100)))).toMatchObject({ reason: 'unreadable' });
  });
});

/** The end-of-central-directory record's size, and where `bytes` (a `zipFixture`, which writes no comment) keeps it. */
const END_RECORD = 22;
const endRecordOf = (bytes: Buffer): number => bytes.length - END_RECORD;

/** `bytes` with `inserted` placed directly before its end record: after the directory, so no offset in it moves. */
function beforeEndRecord(bytes: Buffer, inserted: Buffer): Buffer {
  const end = endRecordOf(bytes);
  return Buffer.concat([bytes.subarray(0, end), inserted, bytes.subarray(end)]);
}

/** A four-byte little-endian signature, then zeros up to `length`. */
function signed(signature: number, length: number): Buffer {
  const record = Buffer.alloc(length);
  record.writeUInt32LE(signature, 0);
  return record;
}

describe('listArchive (zip)', () => {
  const TWO = [{ name: 'a.md', data: '1' }, { name: 'b.md', data: '2' }] as const;

  // The ZIP library honours a ZIP64 locator before the end record at ANY entry count, and reads the
  // directory the ZIP64 record names — not the one the plain end record names, which is the one
  // VAT's own reading of the count and the names is taken from. Two readers, two directories. No
  // archive within this module's limits needs ZIP64, so one that carries its frame is refused.
  it.each([
    ['a ZIP64 end-of-central-directory locator', 0x07064b50, 20],
    ['a ZIP64 end-of-central-directory record', 0x06064b50, 20],
  ])('refuses a ZIP carrying %s before its end record, at a small entry count', async (_what, signature, length) => {
    const framed = beforeEndRecord(zipFixture(TWO), signed(signature, length));

    expect(await refusalOf(() => list('zip', framed))).toMatchObject({ reason: 'unsupported', message: expect.stringContaining('ZIP64') });
  });

  it('refuses a ZIP whose end record says its entries are in ZIP64 fields', async () => {
    const bytes = zipFixture(TWO);
    bytes.writeUInt16LE(0xffff, endRecordOf(bytes) + 8);
    bytes.writeUInt16LE(0xffff, endRecordOf(bytes) + 10);

    expect(await refusalOf(() => list('zip', bytes, { maxEntries: 100_000, maxBytes: 1000 }))).toMatchObject({ reason: 'unsupported', message: expect.stringContaining('ZIP64') });
  });

  // A second end-record signature within reach of the first makes the ZIP library take IT for the
  // end record, and VAT the last one: refused, rather than parsed two ways.
  it('refuses a ZIP with a second end-record signature just before its end record', async () => {
    const twice = beforeEndRecord(zipFixture(TWO), signed(0x06054b50, 10));

    expect(await refusalOf(() => list('zip', twice))).toMatchObject({ reason: 'unsupported', message: expect.stringContaining('more than one end-of-central-directory record') });
  });

  // The end record VAT reads must be the END of the archive, and the directory must end where it
  // begins: nothing stands between them, and nothing after it but the comment it declares.
  it('refuses a ZIP whose last end record is not where its central directory ends (an earlier end record before it)', async () => {
    const sound = zipFixture(TWO);
    const second = Buffer.from(sound.subarray(endRecordOf(sound)));
    const outer = Buffer.from(sound);
    outer.writeUInt16LE(END_RECORD, endRecordOf(outer) + 20);

    expect(await refusalOf(() => list('zip', Buffer.concat([outer, second])))).toMatchObject({ reason: 'unsupported' });
  });

  // The reviewer's layout. The ZIP library scans back from the end and stops at the FIRST signature
  // it knows — so a ZIP64 record in the comment, after the end record, is what it reads, and the
  // directory THAT names is what it builds. VAT read the end record's.
  it('refuses a ZIP whose comment holds a ZIP64 record naming a second directory', async () => {
    const sound = zipFixture(TWO);
    const end = endRecordOf(sound);
    const directory = sound.readUInt32LE(end + 16);
    // A second directory listing only the first entry, after the real one; the end record names IT.
    const first = sound.subarray(directory, directory + 46 + sound.readUInt16LE(directory + 28));
    const record = signed(0x06064b50, 56);
    record.writeUInt32LE(44, 4);
    record.writeUInt32LE(2, 24);
    record.writeUInt32LE(2, 32);
    record.writeUInt32LE(end - directory, 40);
    record.writeUInt32LE(directory, 48);
    const tail = Buffer.from(sound.subarray(end));
    tail.writeUInt16LE(1, 8);
    tail.writeUInt16LE(1, 10);
    tail.writeUInt32LE(first.length, 12);
    tail.writeUInt32LE(end, 16);
    tail.writeUInt16LE(record.length, 20);

    const refusal = await refusalOf(() => list('zip', Buffer.concat([sound.subarray(0, end), first, tail, record])));

    expect(refusal).toMatchObject({ reason: 'unsupported', message: expect.stringContaining('ZIP64') });
  });

  it.each([
    ['a comment shorter than its end record declares', (bytes: Buffer): Buffer => { const lying = Buffer.from(bytes); lying.writeUInt16LE(10, endRecordOf(lying) + 20); return lying; }],
    ['bytes after its end record that no comment accounts for', (bytes: Buffer): Buffer => Buffer.concat([bytes, Buffer.from('trailing')])],
    ['an end-record signature in its comment', (bytes: Buffer): Buffer => { const framed = Buffer.concat([bytes, signed(0x06054b50, 30)]); framed.writeUInt16LE(30, endRecordOf(bytes) + 20); return framed; }],
    ['a central directory that stops short of its end record', (bytes: Buffer): Buffer => beforeEndRecord(bytes, Buffer.alloc(8))],
  ])('refuses a ZIP with %s', async (_what, mangle) => {
    expect(await refusalOf(() => list('zip', mangle(zipFixture(TWO))))).toMatchObject({ reason: 'unsupported' });
  });

  // A comment that is only a comment is no reason to refuse.
  it('reads a ZIP with an archive comment', async () => {
    const sound = zipFixture(TWO);
    const commented = Buffer.concat([sound, Buffer.from('made by hand')]);
    commented.writeUInt16LE('made by hand'.length, endRecordOf(sound) + 20);

    expect(await list('zip', commented)).toHaveLength(2);
  });

  // `unreadable` is kept for bytes that are no ZIP at all — the one thing a lane may choose to pass
  // on. A ZIP VAT found the end of and will not take is `unsupported`, refused everywhere.
  it('calls bytes with no end record unreadable, and a ZIP it parsed and will not take unsupported', async () => {
    const corrupt = zipFixture(TWO);
    corrupt.writeUInt32LE(0xdeadbeef, corrupt.readUInt32LE(endRecordOf(corrupt) + 16));

    expect(await refusalOf(() => list('zip', Buffer.from('these bytes hold no end record at all, of any kind')))).toMatchObject({ reason: 'unreadable' });
    expect(await refusalOf(() => list('zip', corrupt))).toMatchObject({ reason: 'unsupported' });
  });

  // The ZIP library loops over the "entries on this disk" count; a reader of the "total" count
  // beside it would bound, and compare the names of, a different number of records.
  it('refuses a ZIP whose end record counts its entries two ways', async () => {
    const bytes = zipFixture(TWO);
    bytes.writeUInt16LE(1, endRecordOf(bytes) + 10);

    expect(await refusalOf(() => list('zip', bytes))).toMatchObject({ reason: 'unsupported', message: expect.stringContaining('counts its entries two ways') });
  });

  // The count is read off the end record: with it understated, the entries past it are not the
  // archive's, to either reader — and with the bound deleted, nothing here would refuse.
  it('holds the entry count the end record declares to the limit, before a record is built', async () => {
    const entries: ArchiveFixtureEntry[] = Array.from({ length: LIMITS.maxEntries + 1 }, (_unused, index) => ({ name: `f${index}`, data: '' }));
    const over = zipFixture(entries);
    // Understating the count does not buy a shorter directory: the records must end at the end record.
    const understated = Buffer.from(over);
    understated.writeUInt16LE(LIMITS.maxEntries, endRecordOf(understated) + 8);
    understated.writeUInt16LE(LIMITS.maxEntries, endRecordOf(understated) + 10);

    expect(await refusalOf(() => list('zip', over))).toMatchObject({ reason: 'too-many-entries' });
    expect(await refusalOf(() => list('zip', understated))).toMatchObject({ reason: 'unsupported' });
    expect(await list('zip', zipFixture(entries.slice(1)))).toHaveLength(LIMITS.maxEntries);
  });

  // One contract with tar: a name listed twice is the archive's own clash, not bytes that are no ZIP.
  it('refuses a ZIP that lists one name twice as a name clash, naming it', async () => {
    expect(await refusalOf(() => list('zip', zipFixture([{ name: 'a', data: '1' }, { name: 'b', data: '0' }, { name: 'a', data: '2' }])))).toMatchObject({ reason: 'name-clash', entry: 'a' });
  });

  it('refuses a ZIP whose directory declares more entries than the limit before any entry is built', async () => {
    const entries: ArchiveFixtureEntry[] = Array.from({ length: LIMITS.maxEntries + 1 }, () => ({ name: 'same', data: '' }));
    // Every name is the same: only a count read before the names are compared answers `too-many-entries`.
    expect(await refusalOf(() => list('zip', zipFixture(entries)))).toMatchObject({ reason: 'too-many-entries' });
  });

  it('refuses to hand back an entry that holds more than it declares', async () => {
    const opened = await openArchive({ bytes: zipFixture([{ name: 'a', data: 'hello', declaredSize: 3 }], { compress: false }), label: 'fixture.zip' }, { format: 'zip', limits: LIMITS });
    const [entry] = opened.entries;
    expect(entry).toBeDefined();
    expect(await refusalOf(() => Promise.resolve().then(() => (entry === undefined ? undefined : opened.read(entry))))).toMatchObject({ reason: 'unreadable', entry: 'a' });
  });
});

// The second lock on which directory a ZIP's is: whatever VAT's reading and the ZIP library's scan
// each did, what the library BUILT must be what VAT read off the bytes.
describe('sameDirectory', () => {
  const named = (...names: string[]): Buffer[] => names.map((name) => Buffer.from(name));
  const built = (...names: string[]): Array<{ rawEntryName: Buffer }> => names.map((name) => ({ rawEntryName: Buffer.from(name) }));

  it('passes when the library built exactly the entries VAT read, in order', () => {
    expect(() => { sameDirectory('x.zip', named('a', 'b'), built('a', 'b')); }).not.toThrow();
    expect(() => { sameDirectory('x.zip', [], []); }).not.toThrow();
  });

  it.each([
    ['more entries', built('a', 'b', 'c')],
    ['fewer entries', built('a')],
    ['another name', built('a', 'c')],
    ['another order', built('b', 'a')],
  ])('refuses as unsupported when the library built %s', (_what, entries) => {
    expect(() => { sameDirectory('x.zip', named('a', 'b'), entries); }).toThrow(expect.objectContaining({ reason: 'unsupported', message: expect.stringContaining('reads two ways') }));
  });
});

describe('extractedFileMode', () => {
  // [what the umask left the created file, plain, executable]
  it.each([
    [0o644, 0o644, 0o755],
    [0o600, 0o600, 0o700],
    [0o640, 0o640, 0o750],
    // No umask at all: still never wider than 0644 / 0755.
    [0o666, 0o644, 0o755],
    // Bits a create never sets are never kept.
    [0o104644, 0o644, 0o755],
  ])('gives a file created %o the mode %o, or %o when the entry is executable', (created, plain, executable) => {
    expect([extractedFileMode(created, false), extractedFileMode(created, true)]).toEqual([plain, executable]);
  });
});
