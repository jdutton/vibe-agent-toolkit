/**
 * Archives for tests, written byte by byte — the ONE place a suite builds a tarball or a ZIP.
 *
 * Hand-written on purpose. An archive library writes only what it considers an archive: it
 * strips a leading `/`, folds `..` away, refuses a name listed twice and will not mark an entry
 * a link or a device. Those are exactly the archives an extractor must refuse, so a fixture
 * built with the library under test cannot express them. Nothing here imports `tar` or
 * `adm-zip` — only `packages/utils/src/archive/` does.
 */

import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';

import { safePath } from '../path-core.js';

/** One entry of a fixture archive, exactly as the archive will spell it. */
export interface ArchiveFixtureEntry {
  /** The entry name, verbatim: `../x`, `/abs`, `C:\\x` and a name already listed are all written as given. */
  readonly name: string;
  /** What the entry is; `file` when omitted. `device` is a character device. */
  readonly kind?: 'file' | 'directory' | 'link' | 'hardlink' | 'device' | 'fifo';
  /** A file's bytes. */
  readonly data?: string | Uint8Array;
  /** Where a `link` or `hardlink` points, verbatim. */
  readonly target?: string;
  /** Permission bits (setuid, setgid and sticky included); `0o644`, or `0o755` for a directory, when omitted. */
  readonly mode?: number;
  /** The size the entry's header DECLARES, when it should differ from the data's own length. */
  readonly declaredSize?: number;
  /** When a ZIP entry says it was last modified (local time, two-second resolution); the DOS epoch when omitted. */
  readonly modified?: Date;
  /**
   * Tar only: the header's type byte, verbatim, in place of the one `kind` gives — `x` (a PAX
   * header whose `data` overrides the next entry), `L` (a GNU long name), `S` (sparse), `D` (a GNU
   * dump directory), or a byte no tar defines.
   */
  readonly tarType?: string;
}

/**
 * One PAX extended-header record, `<length> <key>=<value>\n`, the length counting itself: the
 * `data` of a `tarType: 'x'` entry, which overrides that field of the entry after it.
 *
 * @param key - The field: `path`, `linkpath`, `size`
 * @param value - Its value, verbatim
 */
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${length}${body}`) !== length) length += 1;
  return `${length}${body}`;
}

const BLOCK = 512;

/** The tar type flag of each entry kind. */
const TAR_TYPE: Readonly<Record<NonNullable<ArchiveFixtureEntry['kind']>, string>> = {
  file: '0',
  hardlink: '1',
  link: '2',
  device: '3',
  directory: '5',
  fifo: '6',
};

/** The file-type bits of a Unix mode, as a ZIP made on Unix keeps them in an entry's external attributes. */
const ZIP_TYPE_BITS: Readonly<Record<Exclude<NonNullable<ArchiveFixtureEntry['kind']>, 'hardlink'>, number>> = {
  file: 0o100000,
  link: 0o120000,
  device: 0o020000,
  directory: 0o040000,
  fifo: 0o010000,
};

const bytesOf = (data: string | Uint8Array | undefined): Buffer => Buffer.from(data ?? '');

const permissionsOf = (entry: ArchiveFixtureEntry): number => entry.mode ?? (entry.kind === 'directory' ? 0o755 : 0o644);

/** An octal header field: `width - 1` digits and a NUL. */
const octal = (value: number, width: number): string => `${value.toString(8).padStart(width - 1, '0')}\0`;

/**
 * Where a tar name is cut between the header's `prefix` (155 bytes) and `name` (100 bytes) fields.
 *
 * @throws When the name fits neither way: a fixture needing a longer name needs a PAX header, which this does not write
 */
function splitTarName(name: string): { prefix: string; name: string } {
  if (Buffer.byteLength(name) <= 100) return { prefix: '', name };
  for (let cut = name.indexOf('/'); cut !== -1; cut = name.indexOf('/', cut + 1)) {
    const prefix = name.slice(0, cut);
    const rest = name.slice(cut + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100 && rest !== '') return { prefix, name: rest };
  }
  throw new Error(`tarFixture: the entry name does not fit a ustar header: ${name}`);
}

/** One ustar header block. */
function tarHeader(entry: ArchiveFixtureEntry, size: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  const { prefix, name } = splitTarName(entry.name);
  block.write(name, 0, 100, 'utf8');
  block.write(octal(permissionsOf(entry), 8), 100, 8, 'latin1');
  block.write(octal(0, 8), 108, 8, 'latin1');
  block.write(octal(0, 8), 116, 8, 'latin1');
  block.write(octal(size, 12), 124, 12, 'latin1');
  block.write(octal(0, 12), 136, 12, 'latin1');
  // The checksum is summed with its own field as spaces.
  block.fill(' ', 148, 156);
  block.write(entry.tarType ?? TAR_TYPE[entry.kind ?? 'file'], 156, 1, 'latin1');
  block.write(entry.target ?? '', 157, 100, 'utf8');
  block.write('ustar\0' + '00', 257, 8, 'latin1');
  block.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return block;
}

/**
 * A tar archive of `entries`, in order, gzipped unless `options.gzip` is `false`.
 *
 * @param entries - The entries, written exactly as given
 * @param options - `gzip: false` for a plain tar
 * @returns The archive's bytes
 */
export function tarFixture(entries: readonly ArchiveFixtureEntry[], options: { readonly gzip?: boolean } = {}): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = bytesOf(entry.data);
    blocks.push(tarHeader(entry, entry.declaredSize ?? data.length), data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
  }
  // Two empty blocks end a tar archive.
  const plain = Buffer.concat([...blocks, Buffer.alloc(2 * BLOCK)]);
  return options.gzip === false ? plain : gzipSync(plain);
}

/** The `version made by` of a ZIP entry: host 3 (Unix), so a reader takes the external attributes for a Unix mode. */
const ZIP_MADE_BY_UNIX = (3 << 8) | 20;
/** General-purpose bit 11: the entry name is UTF-8. */
const ZIP_UTF8_NAMES = 0x0800;

/** A date as a ZIP header's two 16-bit fields, time then date, packed as the one 32-bit value they are stored as. */
function dosTimestamp(at: Date | undefined): number {
  if (at === undefined) return 0;
  const time = (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1);
  const date = ((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate();
  return ((date << 16) | time) >>> 0;
}

/** The bytes a ZIP entry stores, and how: a link stores its target, a file its (deflated) data. */
function zipPayload(entry: ArchiveFixtureEntry, compress: boolean): { stored: Buffer; raw: Buffer; method: number } {
  if (entry.kind === 'hardlink') throw new Error('zipFixture: a ZIP has no hard-link entry');
  const raw = entry.kind === 'link' ? Buffer.from(entry.target ?? '') : bytesOf(entry.data);
  const deflate = compress && raw.length > 0;
  return { stored: deflate ? deflateRawSync(raw) : raw, raw, method: deflate ? 8 : 0 };
}

/**
 * A ZIP archive of `entries`, in order, each as a ZIP made on Unix records it (so a link, a
 * device and an executable bit are all expressible).
 *
 * @param entries - The entries, written exactly as given; a `hardlink` throws (a ZIP has none)
 * @param options - `compress: false` to store every entry instead of deflating it
 * @returns The archive's bytes
 */
export function zipFixture(entries: readonly ArchiveFixtureEntry[], options: { readonly compress?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const kind = entry.kind ?? 'file';
    const { stored, raw, method } = zipPayload(entry, options.compress !== false);
    const name = Buffer.from(entry.name, 'utf8');
    const size = entry.declaredSize ?? raw.length;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(ZIP_UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(dosTimestamp(entry.modified), 10);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(ZIP_MADE_BY_UNIX, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(ZIP_UTF8_NAMES, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(dosTimestamp(entry.modified), 12);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((((kind === 'hardlink' ? 0 : ZIP_TYPE_BITS[kind]) | permissionsOf(entry)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, stored);
    centrals.push(central, name);
    offset += local.length + name.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * A directory tree as fixture entries, in listing order: each directory, then what it holds; a
 * file with its bytes and permission bits; a symbolic link as a link entry with its target
 * verbatim (never followed). What a test that used to `tar` or `zip` a directory hands
 * {@link tarFixture} or {@link zipFixture}.
 *
 * @param dir - The directory to read
 * @param prefix - What each entry name begins with: `''`, or a directory name ending in `/` (`package/`)
 * @returns The entries of `dir`, `dir` itself not among them
 */
export function archiveEntriesOfDirectory(dir: string, prefix = ''): ArchiveFixtureEntry[] {
  const entries: ArchiveFixtureEntry[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = safePath.join(dir, entry.name);
    const name = `${prefix}${entry.name}`;
    if (entry.isSymbolicLink()) {
      entries.push({ name, kind: 'link', target: readlinkSync(path) });
    } else if (entry.isDirectory()) {
      entries.push({ name: `${name}/`, kind: 'directory' }, ...archiveEntriesOfDirectory(path, `${name}/`));
    } else {
      entries.push({ name, data: readFileSync(path), mode: statSync(path).mode & 0o777 });
    }
  }
  return entries;
}

/**
 * An archive of `format` holding `entries` — {@link tarFixture} (gzipped) or {@link zipFixture}
 * (deflated) — for a suite that runs the same rows through both formats.
 */
export function archiveFixture(format: 'tar' | 'zip', entries: readonly ArchiveFixtureEntry[]): Buffer {
  return format === 'tar' ? tarFixture(entries) : zipFixture(entries);
}

/** One archive an extractor must refuse: what makes it hostile, and the entries that do. */
export interface HostileArchiveRow {
  /** What the archive holds, for a test's title. */
  readonly what: string;
  /** The formats that can express it (a ZIP has no hard link). */
  readonly formats: ReadonlyArray<'tar' | 'zip'>;
  /** The `ArchiveRefusedError` reason the archive module gives. */
  readonly reason: 'link' | 'hardlink' | 'special' | 'unsafe-name' | 'name-clash' | 'unreadable' | 'unsupported' | 'too-many-entries' | 'too-large';
  /**
   * The offending entries, to add to an otherwise sound archive.
   *
   * @param prefix - Where inside the archive they go: `''`, or a directory name ending in `/`
   */
  readonly entries: (prefix: string) => ArchiveFixtureEntry[];
  /**
   * For a row that is hostile in its FRAMING rather than its entries: what to do to the built
   * archive's bytes. A suite hands every archive it builds for a row through {@link hostileArchive}.
   */
  readonly mangle?: (archive: Buffer) => Buffer;
}

/**
 * The archive a row stands for: `built` — the suite's sound archive with the row's entries — as
 * the row frames it. Every suite that runs {@link hostileArchiveRows} passes its bytes through here.
 *
 * @param row - The row
 * @param built - The archive the suite built from the row's entries
 */
export function hostileArchive(row: HostileArchiveRow, built: Buffer): Buffer {
  return row.mangle === undefined ? built : row.mangle(built);
}

/** A ZIP's end-of-central-directory record: its size, and where {@link zipFixture} — which writes no comment — keeps it. */
const ZIP_END_SIZE = 22;
const zipEndOf = (archive: Buffer): number => archive.length - ZIP_END_SIZE;

/** A four-byte little-endian signature, then zeros up to `length`. */
function signed(signature: number, length: number): Buffer {
  const record = Buffer.alloc(length);
  record.writeUInt32LE(signature, 0);
  return record;
}

/** `archive` (a {@link zipFixture}) with `comment` as its archive comment, the end record declaring its length. */
function withZipComment(archive: Buffer, comment: Buffer): Buffer {
  const commented = Buffer.concat([archive, comment]);
  commented.writeUInt16LE(comment.length, zipEndOf(archive) + 20);
  return commented;
}

/** `archive` (a {@link zipFixture}) with its end record's two entry counts made to differ. */
function withTwoCounts(archive: Buffer): Buffer {
  const counted = Buffer.from(archive);
  counted.writeUInt16LE(counted.readUInt16LE(zipEndOf(counted) + 10) + 1, zipEndOf(counted) + 10);
  return counted;
}

/** Where a ZIP's central directory begins, as the end record of a {@link zipFixture} names it. */
const zipDirectoryOf = (archive: Buffer): number => archive.readUInt32LE(zipEndOf(archive) + 16);

/**
 * `archive` (a {@link zipFixture}) with `stub` before its first local header: a self-extracting
 * ZIP. `adjusted` moves every offset its central directory and end record hold by the stub's
 * length, as `zip -A` and an SFX builder do, so the directory still names each local header.
 *
 * @param archive - The ZIP
 * @param stub - The bytes to put before it
 * @param adjusted - Whether the offsets are moved to match
 */
export function withZipStub(archive: Buffer, stub: Buffer, adjusted: boolean): Buffer {
  const out = Buffer.concat([stub, archive]);
  if (!adjusted) return out;
  const end = zipEndOf(out);
  const directory = zipDirectoryOf(archive);
  let at = stub.length + directory;
  for (let index = 0; index < out.readUInt16LE(end + 8); index++) {
    out.writeUInt32LE(out.readUInt32LE(at + 42) + stub.length, at + 42);
    at += 46 + out.readUInt16LE(at + 28) + out.readUInt16LE(at + 30) + out.readUInt16LE(at + 32);
  }
  out.writeUInt32LE(directory + stub.length, end + 16);
  return out;
}

/**
 * `archive` (a {@link zipFixture}) carrying `entry` as a local header and its data after its last
 * listed entry, before a central directory that does not list it: an entry only a reader that
 * walks local headers from the front sees. Every offset still agrees, so a reader that holds the
 * directory to its own reading takes the archive.
 *
 * @param archive - The ZIP
 * @param entry - The entry its local headers hold and its directory does not
 */
export function withUnlistedLocalEntry(archive: Buffer, entry: ArchiveFixtureEntry): Buffer {
  const lone = zipFixture([entry]);
  const local = lone.subarray(0, zipDirectoryOf(lone));
  const directory = zipDirectoryOf(archive);
  const out = Buffer.concat([archive.subarray(0, directory), local, archive.subarray(directory)]);
  out.writeUInt32LE(directory + local.length, zipEndOf(out) + 16);
  return out;
}

const PLANTED_DIRECTORY = 'planted/';

/**
 * `archive` (a {@link zipFixture}) with one more central record, listed first: a directory,
 * `planted/`, whose local header the record says is at `offset`. Nothing checks a directory's local
 * header when the entry is read — a directory has no data — so the record can name any bytes.
 *
 * @param archive - The ZIP
 * @param offset - Where the record says its local header is
 */
function withDirectoryRecordAt(archive: Buffer, offset: number): Buffer {
  const name = Buffer.from(PLANTED_DIRECTORY, 'utf8');
  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE(ZIP_MADE_BY_UNIX, 4);
  record.writeUInt16LE(20, 6);
  record.writeUInt16LE(ZIP_UTF8_NAMES, 8);
  record.writeUInt16LE(name.length, 28);
  record.writeUInt32LE(((ZIP_TYPE_BITS.directory | 0o755) << 16) >>> 0, 38);
  record.writeUInt32LE(offset, 42);
  const directory = zipDirectoryOf(archive);
  const out = Buffer.concat([archive.subarray(0, directory), record, name, archive.subarray(directory)]);
  const end = zipEndOf(out);
  out.writeUInt16LE(out.readUInt16LE(end + 8) + 1, end + 8);
  out.writeUInt16LE(out.readUInt16LE(end + 10) + 1, end + 10);
  out.writeUInt32LE(out.readUInt32LE(end + 12) + record.length + name.length, end + 12);
  return out;
}

/** What a self-extracting ZIP carries before its first local header: an executable's first bytes. */
const SFX_STUB = Buffer.from('MZ self-extracting stub, standing in for an executable');
/** A stub that is itself a local header and its data: an entry a reader walking from the front takes, and no directory lists. */
const localHeaderStub = (): Buffer => {
  const lone = zipFixture([{ name: 'evals/planted.md', data: 'planted' }]);
  return lone.subarray(0, zipDirectoryOf(lone));
};

/** The signatures a ZIP reader scans for: the end record, the ZIP64 end record, and the ZIP64 locator. */
const ZIP_END = 0x06054b50;
const ZIP64_END = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;

/**
 * A ZIP that is sound in every entry and hostile in its FRAME: built so that two readers find two
 * different central directories, or so that the count VAT bounds is not the count a library
 * builds. Each is a ZIP VAT parsed and will not take (`unsupported`) — refused in every lane,
 * the one that passes `unreadable` bytes on included.
 */
const ZIP_FRAMINGS: ReadonlyArray<readonly [what: string, mangle: (archive: Buffer) => Buffer]> = [
  ['a ZIP64 locator before its end record', (archive: Buffer): Buffer => Buffer.concat([archive.subarray(0, zipEndOf(archive)), signed(ZIP64_LOCATOR, 20), archive.subarray(zipEndOf(archive))])],
  ['a ZIP64 record in its comment', (archive: Buffer): Buffer => withZipComment(archive, signed(ZIP64_END, 56))],
  ['a second end record in its comment', (archive: Buffer): Buffer => withZipComment(archive, signed(ZIP_END, ZIP_END_SIZE))],
  ['an end record that counts its entries two ways', withTwoCounts],
  ['bytes after its end record', (archive: Buffer): Buffer => Buffer.concat([archive, Buffer.from('trailing bytes')])],
  // Data before the first local header is refused whether or not the offsets were moved for it.
  ['a self-extracting stub, its offsets not adjusted', (archive: Buffer): Buffer => withZipStub(archive, SFX_STUB, false)],
  ['a self-extracting stub, its offsets adjusted', (archive: Buffer): Buffer => withZipStub(archive, SFX_STUB, true)],
  ['an unlisted local entry before its first listed one, its offsets adjusted', (archive: Buffer): Buffer => withZipStub(archive, localHeaderStub(), true)],
  // A record naming offset 0 is not a local header AT offset 0: a directory's header is never read.
  ['an unlisted local entry at offset 0, under a directory record that names it', (archive: Buffer): Buffer => withDirectoryRecordAt(withZipStub(archive, localHeaderStub(), true), 0)],
  ['a directory record naming bytes that are no local header', (archive: Buffer): Buffer => withDirectoryRecordAt(archive, 1)],
];
const ZIP_FRAMING_ROWS: readonly HostileArchiveRow[] = ZIP_FRAMINGS.map(([what, mangle]) => ({ what, formats: ['zip'], reason: 'unsupported', entries: () => [], mangle }));

/** One byte more than a reader's end-record search window (the record, plus the longest comment it may declare) holds after the record. */
const PAST_END_RECORD_WINDOW = 0x1_00_00;
/** `archive` with zeros appended past the window, so a reader searching back from the end finds no end record — and the bytes are still a ZIP. */
const padPastEndRecordWindow = (archive: Buffer): Buffer => Buffer.concat([archive, Buffer.alloc(PAST_END_RECORD_WINDOW)]);

/** A ZIP whose end record lies beyond the search window: still a ZIP (`unsupported`), never bytes that are none (`unreadable`) — refused whether its entries are hostile or sound. */
const ZIP_PADDED_ROWS: readonly HostileArchiveRow[] = [
  { what: 'a symbolic link, padded past the end-record search window', formats: ['zip'], reason: 'unsupported', entries: (prefix) => [{ name: `${prefix}keys`, kind: 'link', target: 'SKILL.md' }], mangle: padPastEndRecordWindow },
  { what: 'nothing hostile, padded past the end-record search window', formats: ['zip'], reason: 'unsupported', entries: () => [], mangle: padPastEndRecordWindow },
];

const BOTH = ['tar', 'zip'] as const;
/** The two reasons most rows share. */
const UNSAFE_NAME = 'unsafe-name';
const NAME_CLASH = 'name-clash';

/** `e` with an acute accent, precomposed and as `e` + a combining accent: one name on a normalising volume. */
const E_ACUTE_COMPOSED = String.fromCodePoint(0xe9);
const E_ACUTE_DECOMPOSED = `e${String.fromCodePoint(0x301)}`;

/**
 * A ZIP member that holds more than its directory declares: the archive parses and its entry list
 * passes the policy, and the member is refused only when it is READ — `ArchiveEntryReadError`,
 * `ARCHIVE_ENTRY_UNREADABLE`, never an `ArchiveRefusedError`, so it is no row of
 * {@link hostileArchiveRows} (whose rows each name an `ArchiveRefusedError` reason). Each lane that
 * reads a ZIP's members runs it beside that table, so the CLI's mapping of the code to
 * `INPUT_UNREADABLE` is held by every lane that can raise it.
 *
 * @param prefix - Where inside the archive it goes: `''`, or a directory name ending in `/`
 */
export function entryHoldingMoreThanDeclared(prefix: string): ArchiveFixtureEntry[] {
  return [{ name: `${prefix}guide.md`, data: 'this member holds more than it declares', declaredSize: 3 }];
}

/**
 * Every shape of archive VAT refuses to extract, as rows a suite runs through each lane that
 * extracts one: the same table for the archive module's own tests and for every verb's.
 *
 * @param limits - The bounds the lane under test holds an archive to; the last two rows are built just past them
 */
export function hostileArchiveRows(limits: { readonly maxEntries: number; readonly maxBytes: number }): HostileArchiveRow[] {
  return [
    { what: 'a symbolic link', formats: BOTH, reason: 'link', entries: (prefix) => [{ name: `${prefix}keys`, kind: 'link', target: 'SKILL.md' }] },
    { what: 'a hard link', formats: ['tar'], reason: 'hardlink', entries: (prefix) => [{ name: `${prefix}twin`, kind: 'hardlink', target: `${prefix}SKILL.md` }] },
    {
      what: 'a symbolic link and a file under it',
      formats: BOTH,
      reason: 'link',
      entries: (prefix) => [{ name: `${prefix}out`, kind: 'link', target: '..' }, { name: `${prefix}out/planted.txt`, data: 'planted' }],
    },
    { what: 'a `..` name', formats: BOTH, reason: UNSAFE_NAME, entries: (prefix) => [{ name: `${prefix}../../../planted.txt`, data: 'planted' }] },
    { what: 'an absolute name', formats: BOTH, reason: UNSAFE_NAME, entries: () => [{ name: '/planted.txt', data: 'planted' }] },
    { what: 'a drive-letter name', formats: BOTH, reason: UNSAFE_NAME, entries: () => [{ name: String.raw`C:\planted.txt`, data: 'planted' }] },
    { what: 'a UNC name', formats: BOTH, reason: UNSAFE_NAME, entries: () => [{ name: String.raw`\\host\share\planted.txt`, data: 'planted' }] },
    // Names Windows cannot hold as spelled — refused on every host, so one archive has one verdict everywhere.
    { what: 'a name holding a `:` (an NTFS stream)', formats: BOTH, reason: UNSAFE_NAME, entries: (prefix) => [{ name: `${prefix}notes:v2.md`, data: 'planted' }] },
    { what: 'a directory named with a `:`', formats: BOTH, reason: UNSAFE_NAME, entries: (prefix) => [{ name: `${prefix}a:b/x.md`, data: 'planted' }] },
    { what: 'a Windows device name', formats: BOTH, reason: UNSAFE_NAME, entries: (prefix) => [{ name: `${prefix}aux`, data: 'planted' }] },
    { what: 'a Windows device name with an extension', formats: BOTH, reason: UNSAFE_NAME, entries: (prefix) => [{ name: `${prefix}docs/Con.md`, data: 'planted' }] },
    { what: 'a name ending in a dot', formats: BOTH, reason: UNSAFE_NAME, entries: (prefix) => [{ name: `${prefix}notes.md.`, data: 'planted' }] },
    { what: 'a directory name ending in a space', formats: BOTH, reason: UNSAFE_NAME, entries: (prefix) => [{ name: `${prefix}docs /x.md`, data: 'planted' }] },
    { what: 'a name holding a `?`', formats: BOTH, reason: UNSAFE_NAME, entries: (prefix) => [{ name: `${prefix}faq?.md`, data: 'planted' }] },
    { what: 'a name holding a `|`', formats: BOTH, reason: UNSAFE_NAME, entries: (prefix) => [{ name: `${prefix}a|b.md`, data: 'planted' }] },
    { what: 'a directory named with a `<`, a `>` and a `"`', formats: BOTH, reason: UNSAFE_NAME, entries: (prefix) => [{ name: `${prefix}<"x">/a.md`, data: 'planted' }] },
    { what: 'a name holding a control character', formats: BOTH, reason: UNSAFE_NAME, entries: (prefix) => [{ name: `${prefix}a${String.fromCodePoint(0x1f)}b.md`, data: 'planted' }] },
    { what: 'one name listed twice', formats: BOTH, reason: NAME_CLASH, entries: (prefix) => [{ name: `${prefix}twice.txt`, data: '1' }, { name: `${prefix}twice.txt`, data: '2' }] },
    {
      what: 'two names differing only in letter case',
      formats: BOTH,
      reason: NAME_CLASH,
      entries: (prefix) => [{ name: `${prefix}Notes.md`, data: '1' }, { name: `${prefix}notes.md`, data: '2' }],
    },
    {
      what: 'two names differing only in Unicode form',
      formats: BOTH,
      reason: NAME_CLASH,
      entries: (prefix) => [{ name: `${prefix}caf${E_ACUTE_COMPOSED}.md`, data: '1' }, { name: `${prefix}caf${E_ACUTE_DECOMPOSED}.md`, data: '2' }],
    },
    { what: 'a device', formats: BOTH, reason: 'special', entries: (prefix) => [{ name: `${prefix}dev`, kind: 'device' }] },
    { what: 'a named pipe', formats: BOTH, reason: 'special', entries: (prefix) => [{ name: `${prefix}pipe`, kind: 'fifo' }] },
    // A ustar name field ends at its first NUL, so only a ZIP can spell one.
    { what: 'a name holding a NUL', formats: ['zip'], reason: UNSAFE_NAME, entries: (prefix) => [{ name: `${prefix}a${String.fromCodePoint(0)}.md`, data: 'planted' }] },
    // The header spells a harmless name; the record before it says what the entry is really called.
    {
      what: 'a PAX header renaming a harmless entry to a `..` name',
      formats: ['tar'],
      reason: UNSAFE_NAME,
      entries: (prefix) => [{ name: 'PaxHeader/harmless.txt', tarType: 'x', data: paxRecord('path', `${prefix}../../../planted.txt`) }, { name: `${prefix}harmless.txt`, data: 'planted' }],
    },
    {
      what: 'a GNU long-name record renaming a harmless entry to a `..` name',
      formats: ['tar'],
      reason: UNSAFE_NAME,
      entries: (prefix) => [{ name: '././@LongLink', tarType: 'L', data: `${prefix}../../../planted.txt${String.fromCodePoint(0)}` }, { name: `${prefix}harmless.txt`, data: 'planted' }],
    },
    // An entry of a type the tar reader's library skips: dropped silently, the archive would install without it.
    { what: 'a sparse file', formats: ['tar'], reason: 'special', entries: (prefix) => [{ name: `${prefix}sparse.bin`, tarType: 'S', data: 'x' }] },
    { what: 'an entry of a type no tar defines', formats: ['tar'], reason: 'special', entries: (prefix) => [{ name: `${prefix}odd.bin`, tarType: 'Z', data: 'x' }] },
    {
      what: 'more entries than the limit',
      formats: BOTH,
      reason: 'too-many-entries',
      entries: (prefix) => Array.from({ length: limits.maxEntries + 1 }, (_unused, index) => ({ name: `${prefix}f${index}`, data: '' })),
    },
    // Declared, never held: the archive is refused on what its header says, before any of it is inflated.
    { what: 'more bytes than the limit', formats: BOTH, reason: 'too-large', entries: (prefix) => [{ name: `${prefix}big.bin`, data: '', declaredSize: limits.maxBytes + 1 }] },
    ...ZIP_FRAMING_ROWS,
    ...ZIP_PADDED_ROWS,
  ];
}
