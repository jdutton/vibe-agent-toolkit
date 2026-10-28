/**
 * The two format readers, over archives held in memory: what each lists, and what each refuses
 * to read. Nothing here touches a disk — extraction is `integration/archive-extract`.
 */
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { extractedFileMode, listArchive, openArchive, zipOfArchive } from '../src/archive/archive.js';
import { ARCHIVE_ENTRY_UNREADABLE_CODE, ARCHIVE_REFUSED_CODE, type ArchiveFormat, type ArchiveLimits, isArchiveEntryReadRefusal } from '../src/archive/entries.js';
import { sameDirectory } from '../src/archive/zip-reader.js';
import { isVatError } from '../src/errors/vat-error.js';
import { type ArchiveFixtureEntry, paxRecord, tarFixture, withUnlistedLocalEntry, withZipStub, zipFixture } from '../src/testing/archive-fixtures.js';

const LIMITS: ArchiveLimits = { maxEntries: 20, maxBytes: 1000 };

const FORMATS: ReadonlyArray<{ format: ArchiveFormat; build: (entries: readonly ArchiveFixtureEntry[]) => Buffer }> = [
  { format: 'tar', build: (entries) => tarFixture(entries) },
  { format: 'zip', build: (entries) => zipFixture(entries) },
];

const list = (format: ArchiveFormat, bytes: Buffer, limits = LIMITS): ReturnType<typeof listArchive> =>
  listArchive({ bytes, label: `fixture.${format}` }, { format, limits });

async function refusalOf(work: () => Promise<unknown>, code = ARCHIVE_REFUSED_CODE): Promise<{ reason?: string; entry?: string; message: string }> {
  try {
    await work();
  } catch (error) {
    expect(isVatError(error, code), String(error)).toBe(true);
    return error as { reason?: string; entry?: string; message: string };
  }
  throw new Error('expected a refusal, and nothing was thrown');
}

describe.each(FORMATS)('listArchive ($format)', ({ format, build }) => {
  // One contract for both formats on every host: a backslash in a name is the separator VAT reads
  // it as everywhere. The tar library already reads it so on win32, and only there; VAT does on all.
  it('lists every entry as the archive spells it, a backslash read as `/`, judging nothing', async () => {
    const entries = await list(format, build([
      { name: 'skill/', kind: 'directory' },
      { name: 'skill/SKILL.md', data: 'hello' },
      { name: 'skill/keys', kind: 'link', target: '../../secret' },
      { name: 'skill/dev', kind: 'device' },
      { name: '../up.md', data: 'x' },
      { name: String.raw`C:\x.md`, data: 'x' },
      { name: String.raw`skill\docs\a.md`, data: 'x' },
    ]));

    expect(entries.map(({ name, kind, size }) => ({ name, kind, size }))).toEqual([
      { name: 'skill/', kind: 'directory', size: 0 },
      { name: 'skill/SKILL.md', kind: 'file', size: 5 },
      { name: 'skill/keys', kind: 'link', size: 0 },
      { name: 'skill/dev', kind: 'other', size: 0 },
      { name: '../up.md', kind: 'file', size: 1 },
      { name: 'C:/x.md', kind: 'file', size: 1 },
      { name: 'skill/docs/a.md', kind: 'file', size: 1 },
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

  // One meaning for one fact, whichever layer the cut falls in: a tarball cut short is `unsupported`,
  // naming the entry, gzipped (every npm or `url:` download) as plain.
  it('refuses a gzip stream cut short inside an entry as unsupported, naming the entry, as it does a plain one', async () => {
    // Bytes that do not compress, so half the gzip stream inflates past the header and into the body.
    let seed = 1;
    const data = Array.from({ length: 900 }, () => {
      seed = (seed * 48_271) % 2_147_483_647;
      return String.fromCodePoint(33 + (seed % 94));
    }).join('');
    const tar = tarFixture([{ name: 'a.md', data }], { gzip: false });
    const plain = tar.subarray(0, 512 + 100);
    const gzipped = gzipSync(tar);
    const cut = gzipped.subarray(0, Math.floor(gzipped.length / 2));
    const fromPlain = await refusalOf(() => list('tar', plain));
    const fromGzip = await refusalOf(() => list('tar', cut));
    expect(fromGzip).toMatchObject({ reason: 'unsupported', entry: 'a.md' });
    expect({ reason: fromGzip.reason, entry: fromGzip.entry }).toEqual({ reason: fromPlain.reason, entry: fromPlain.entry });
  });

  it('refuses a gzip stream cut short after its last whole entry as unsupported, naming that entry', async () => {
    const whole = tarFixture([{ name: 'a.md', data: 'hello' }]);
    expect(await refusalOf(() => list('tar', whole.subarray(0, whole.length - 8)))).toMatchObject({ reason: 'unsupported', entry: 'a.md' });
  });

  it('refuses a gzip stream cut short before any tar entry as unreadable', async () => {
    const whole = tarFixture([{ name: 'a.md', data: 'hello' }]);
    expect(await refusalOf(() => list('tar', whole.subarray(0, 12)))).toMatchObject({ reason: 'unreadable' });
  });

  // The header parsed, so the bytes ARE a tarball: one whose entry does not hold what it declares,
  // the same `unsupported` a ZIP entry that does not inflate is — never `unreadable`, the one reason a lane may pass on.
  it('refuses a tar stream cut short inside an entry as unsupported, naming the entry', async () => {
    const whole = tarFixture([{ name: 'a.md', data: 'x'.repeat(600) }], { gzip: false });
    const refusal = await refusalOf(() => list('tar', whole.subarray(0, 512 + 100)));
    expect(refusal).toMatchObject({ reason: 'unsupported', entry: 'a.md' });
    // Refused as the archive is opened, so it is no refusal of one entry's read.
    expect(isArchiveEntryReadRefusal(refusal)).toBe(false);
  });

  // The documented asymmetry (INPUT_UNREADABLE, docs/validation-codes.md): a plain tar records no end, and
  // the reader does not require its end-of-archive blocks, so a cut on an entry boundary reads every
  // entry before it whole — where a gzip stream cut on the same boundary is refused (above).
  it('accepts a plain tar stream cut on an entry boundary, reading every entry before the cut', async () => {
    const whole = tarFixture([{ name: 'a.md', data: 'hello' }, { name: 'b.md', data: 'world' }], { gzip: false });
    const entries = await list('tar', whole.subarray(0, 512 + 512));
    expect(entries.map((entry) => entry.name)).toEqual(['a.md']);
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

  // "No ZIP at all" is decided by the bytes holding no ZIP signature, not by an end record missing
  // from the window a reader searches: a reader that searches further back, or reads local headers
  // from the front, takes these.
  it.each([
    ['a ZIP padded past the end-record search window', Buffer.concat([zipFixture(TWO), Buffer.alloc(65_536)])],
    ['a ZIP cut short before its end record', zipFixture(TWO).subarray(0, 40)],
    ['an end record behind 64 KiB of other bytes', Buffer.concat([Buffer.alloc(100), zipFixture([]), Buffer.alloc(65_536, 0x20)])],
    ['a local-file-header signature and nothing more', Buffer.from([0x50, 0x4b, 0x03, 0x04])],
    // A local header ANYWHERE is a ZIP signature, as an end record anywhere is: one leading byte does not make it none.
    ['a local header after one leading byte, its end record cut away', Buffer.concat([Buffer.from([0]), zipFixture(TWO).subarray(0, 40)])],
    ['an executable stub, then local headers, its end record cut away', Buffer.concat([Buffer.from('MZ stub'), zipFixture(TWO).subarray(0, 40)])],
  ])('calls %s unsupported, never unreadable', async (_what, bytes) => {
    expect(await refusalOf(() => list('zip', bytes))).toMatchObject({ reason: 'unsupported' });
  });

  // A reader that walks local headers from the front reads whatever stands before the first one
  // the directory names: refused whether or not the offsets were moved to step over it.
  it.each([
    ['holding entries', TWO],
    ['holding none', []],
  ] as const)('refuses a ZIP %s with data before its first local header, its offsets adjusted for it', async (_what, entries) => {
    const stubbed = withZipStub(zipFixture(entries), Buffer.from('MZ stub'), true);

    expect(await refusalOf(() => list('zip', stubbed))).toMatchObject({ reason: 'unsupported', message: expect.stringContaining('before its first local file header') });
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
    const refusal = await refusalOf(() => Promise.resolve().then(() => (entry === undefined ? undefined : opened.read(entry))), ARCHIVE_ENTRY_UNREADABLE_CODE);
    expect(refusal).toMatchObject({ reason: 'unsupported', entry: 'a' });
    expect(isArchiveEntryReadRefusal(refusal)).toBe(true);
  });

  // "One entry failed" is the error's own type, not whether an optional `entry` happens to be set:
  // every refusal of a whole archive that names an entry (a clash, a link, a cut-short tarball) is not it.
  it('tells a refusal of one entry\'s read from every refusal of the whole archive, entry named or not', async () => {
    const clash = await refusalOf(() => list('zip', zipFixture([{ name: 'a', data: '1' }, { name: 'a', data: '2' }])));
    const link = await refusalOf(() => zipOfArchive({ bytes: tarFixture([{ name: 'l', kind: 'link', target: 'x' }]), label: 'fixture.tar' }, { format: 'tar', limits: LIMITS }));
    expect(clash).toMatchObject({ entry: 'a' });
    expect(link).toMatchObject({ reason: 'link', entry: 'l' });
    expect(isArchiveEntryReadRefusal(clash)).toBe(false);
    expect(isArchiveEntryReadRefusal(link)).toBe(false);
    expect(isArchiveEntryReadRefusal(new Error('x'))).toBe(false);
  });

  // The two rows the clash and the link cannot be: one that a predicate reading `unsupported` + an
  // `entry` gets wrong (a whole tarball refused naming its cut-short entry), and one that a predicate
  // reading the prototype gets wrong (a `dist` copy of the class: the brand and the code, no shared prototype).
  it('reads the brand and the code, never the reason, the entry or the prototype', async () => {
    const cutShort = await refusalOf(() => list('tar', tarFixture([{ name: 'a.md', data: 'x'.repeat(600) }], { gzip: false }).subarray(0, 612)));
    expect(cutShort).toMatchObject({ reason: 'unsupported', entry: 'a.md' });
    expect(isArchiveEntryReadRefusal(cutShort)).toBe(false);

    const fromAnotherCopy = Object.assign(new Error('x'), { [Symbol.for('vat.error')]: true, code: ARCHIVE_ENTRY_UNREADABLE_CODE, reason: 'unsupported', entry: 'a' });
    expect(isArchiveEntryReadRefusal(fromAnotherCopy)).toBe(true);
  });
});

/**
 * `bytes` (a one-entry `zipFixture`) with its central record's field at `at` set to 0xFFFFFFFF and
 * a ZIP64 extra field carrying `fields` — which the library reads by position: the size, then the
 * compressed size, then the offset.
 */
function deferredToZip64(bytes: Buffer, at: number, fields: readonly bigint[]): Buffer {
  const end = endRecordOf(bytes);
  const central = bytes.readUInt32LE(end + 16);
  const nameEnd = central + 46 + bytes.readUInt16LE(central + 28);
  const extra = Buffer.alloc(4 + 8 * fields.length);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(8 * fields.length, 2);
  for (const [index, field] of fields.entries()) extra.writeBigUInt64LE(field, 4 + 8 * index);
  const out = Buffer.concat([bytes.subarray(0, nameEnd), extra, bytes.subarray(nameEnd)]);
  out.writeUInt32LE(0xff_ff_ff_ff, central + at);
  out.writeUInt16LE(extra.length, central + 30);
  out.writeUInt32LE(bytes.readUInt32LE(end + 12) + extra.length, end + extra.length + 12);
  return out;
}

// A per-entry ZIP64 extra field: the library takes a size, a compressed size or an offset from it
// wherever the central record holds 0xFFFFFFFF, so what it extracts by is not what VAT read.
describe('a ZIP whose entry defers a field to a ZIP64 extra field', () => {
  it('is refused as unsupported, whichever field it defers', async () => {
    const sound = zipFixture([{ name: 'a.md', data: 'hello' }], { compress: false });

    expect(await list('zip', sound)).toHaveLength(1);
    // The uncompressed size (central offset 24), the compressed size (20), the local-header offset (42): each the truth.
    expect(await refusalOf(() => list('zip', deferredToZip64(sound, 24, [5n])))).toMatchObject({ reason: 'unsupported', message: expect.stringContaining('reads two ways') });
    expect(await refusalOf(() => list('zip', deferredToZip64(sound, 20, [5n, 5n])))).toMatchObject({ reason: 'unsupported', message: expect.stringContaining('reads two ways') });
    expect(await refusalOf(() => list('zip', deferredToZip64(sound, 42, [5n, 5n, 0n])))).toMatchObject({ reason: 'unsupported', message: expect.stringContaining('reads two ways') });
  });

  // No extra field, so both readers see 0xFFFFFFFF and agree; a directory is never read, so nothing else would refuse it.
  it('is refused as unsupported when a directory\'s central record holds 0xFFFFFFFF for its sizes and no extra field', async () => {
    const archive = zipFixture([{ name: 'skill/', kind: 'directory' }, { name: 'skill/SKILL.md', data: '# skill' }]);
    const directoryAt = archive.readUInt32LE(archive.length - 22 + 16);
    const marked = Buffer.from(archive);
    marked.writeUInt32LE(0xff_ff_ff_ff, directoryAt + 20);
    marked.writeUInt32LE(0xff_ff_ff_ff, directoryAt + 24);

    expect(await list('zip', archive)).toHaveLength(2);
    expect(await refusalOf(() => list('zip', marked))).toMatchObject({ reason: 'unsupported', message: expect.stringContaining('ZIP64') });
  });
});

// The second lock on which directory a ZIP's is: whatever VAT's reading and the ZIP library's scan
// each did, what the library BUILT must be what VAT read off the bytes.
describe('sameDirectory', () => {
  /** What extraction is decided by, besides the name: where the local header is, the two sizes, and the method. */
  const EXTENT = { offset: 0, compressedSize: 1, size: 1, method: 0 } as const;
  const named = (...names: string[]): Array<{ name: Buffer } & typeof EXTENT> => names.map((name) => ({ name: Buffer.from(name), ...EXTENT }));
  const built = (...names: string[]): Array<{ rawEntryName: Buffer; header: typeof EXTENT }> => names.map((name) => ({ rawEntryName: Buffer.from(name), header: EXTENT }));
  const builtWith = (header: Partial<Record<keyof typeof EXTENT, number>>): Array<{ rawEntryName: Buffer; header: Record<keyof typeof EXTENT, number> }> =>
    [{ rawEntryName: Buffer.from('a'), header: { ...EXTENT, ...header } }, ...built('b')];

  it('passes when the library built exactly the entries VAT read, in order', () => {
    expect(() => { sameDirectory('x.zip', named('a', 'b'), built('a', 'b')); }).not.toThrow();
    expect(() => { sameDirectory('x.zip', [], []); }).not.toThrow();
  });

  it.each([
    ['more entries', built('a', 'b', 'c')],
    ['fewer entries', built('a')],
    ['another name', built('a', 'c')],
    ['another order', built('b', 'a')],
    ['another local-header offset', builtWith({ offset: 7 })],
    ['another compressed size', builtWith({ compressedSize: 2 })],
    ['another size', builtWith({ size: 2 })],
    ['another method', builtWith({ method: 8 })],
  ])('refuses as unsupported when the library built %s', (_what, entries) => {
    expect(() => { sameDirectory('x.zip', named('a', 'b'), entries); }).toThrow(expect.objectContaining({ reason: 'unsupported', message: expect.stringContaining('reads two ways') }));
  });
});

// The ZIP VAT writes of an archive it accepts: what a lane that SENDS an archive on sends, so the
// bytes that leave are exactly the entries that were judged.
describe('zipOfArchive', () => {
  const zip = (bytes: Buffer, omit?: (entry: { readonly name: string }) => boolean): Promise<Buffer> =>
    zipOfArchive({ bytes, label: 'fixture.zip' }, omit === undefined ? { format: 'zip', limits: LIMITS } : { format: 'zip', limits: LIMITS, omit });
  const namesIn = async (bytes: Buffer): Promise<string[]> => (await list('zip', bytes)).map((entry) => entry.name);

  it('writes the entries the central directory lists, and never a local entry it does not', async () => {
    const bytes = withUnlistedLocalEntry(zipFixture([{ name: 'skill/SKILL.md', data: '# skill' }]), { name: 'evals/answers.json', data: 'key' });
    // The control: VAT takes the operator's bytes, and they carry the unlisted entry.
    expect(await namesIn(bytes)).toEqual(['skill/SKILL.md']);
    expect(bytes.toString('latin1')).toContain('evals/answers.json');

    const written = await zip(bytes);

    expect(written.toString('latin1')).not.toContain('evals/answers.json');
    expect(await namesIn(written)).toEqual(['skill/SKILL.md']);
  });

  // Not pinned here: that each entry is NAMED by its place. The ZIP library normalises every name it
  // writes (`zipnamefix`: separators, `.` and empty segments) the way `placeOf` does, so naming an
  // entry by its raw spelling instead writes the same bytes — a row claiming to tell the two apart
  // stays green with the naming reverted.
  it('leaves out what it is told to, and keeps each file and its executable bit', async () => {
    const bytes = zipFixture([
      { name: 'skill/SKILL.md', data: '# skill' },
      { name: 'skill/run.sh', data: 'echo', mode: 0o755 },
      { name: '.DS_Store', data: 'store' },
    ]);

    const written = await zip(bytes, (entry) => entry.name === '.DS_Store');
    const opened = await openArchive({ bytes: written, label: 'written.zip' }, { format: 'zip', limits: LIMITS });

    // In no particular order: the ZIP library orders what it writes.
    expect(opened.entries.map((entry) => [entry.name, opened.read(entry).toString(), (entry as { executable?: boolean }).executable]).toSorted((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1))).toEqual([
      ['skill/SKILL.md', '# skill', false],
      ['skill/run.sh', 'echo', true],
    ]);
  });

  it('refuses an archive the entry policy refuses, writing nothing', async () => {
    expect(await refusalOf(() => zip(zipFixture([{ name: 'skill/SKILL.md', data: '# skill' }, { name: 'skill/keys', kind: 'link', target: '../x' }])))).toMatchObject({ reason: 'link' });
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
