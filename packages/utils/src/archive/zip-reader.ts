/**
 * The ZIP reader and writer: every entry of a ZIP's central directory, each inflated only when
 * asked, and the one ZIP VAT writes. One of the two files in VAT that import an archive library.
 */

import AdmZip from 'adm-zip';

import { decodeTextContent } from '../text-content.js';

import { type ArchiveEntryKind, type ArchiveLimits, ArchiveRefusedError, entryNameOf } from './entries.js';
import { assertWithinLimits, tooManyEntries, unreadableArchive } from './limits.js';
import type { ArchiveRecord } from './records.js';

type ZipEntry = ReturnType<AdmZip['getEntries']>[number];

/** The host a ZIP entry was made on, in the high byte of `version made by`; 3 is Unix. */
const MADE_ON_UNIX = 3;
/** The file-type bits of a Unix mode, and the types among them. */
const TYPE_MASK = 0o170000;
const TYPE_REGULAR = 0o100000;
const TYPE_DIRECTORY = 0o040000;
const TYPE_LINK = 0o120000;
/** Any of the owner, group or other execute bits. */
const EXECUTE_BITS = 0o111;
/** The permission bits a ZIP VAT writes gives a directory, an executable file and any other file. */
const DIRECTORY_MODE = 0o755;
const EXECUTABLE_MODE = 0o755;
const FILE_MODE = 0o644;

/** The Unix mode an entry made on Unix carries in its external attributes; `undefined` for any other host. */
function unixModeOf(entry: ZipEntry): number | undefined {
  return entry.header.made >>> 8 === MADE_ON_UNIX ? entry.attr >>> 16 : undefined;
}

function kindOf(entry: ZipEntry, mode: number | undefined): ArchiveEntryKind {
  const type = (mode ?? 0) & TYPE_MASK;
  if (type === TYPE_LINK) return 'link';
  if (entry.isDirectory || type === TYPE_DIRECTORY) return 'directory';
  // No type bits: a ZIP made where there are none, or by a writer that set only permissions.
  return type === 0 || type === TYPE_REGULAR ? 'file' : 'other';
}

function recordOf(entry: ZipEntry): ArchiveRecord {
  const mode = unixModeOf(entry);
  const kind = kindOf(entry, mode);
  return {
    name: entryNameOf(entry.entryName),
    kind,
    size: kind === 'file' ? entry.header.size : 0,
    executable: ((mode ?? 0) & EXECUTE_BITS) !== 0,
    read: () => entry.getData(),
  };
}

/** The end-of-central-directory record and one central-directory record: their signatures and fixed sizes. */
const END_SIGNATURE = 0x06054b50;
const END_SIZE = 22;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_SIZE = 46;
/** A local file header's fixed size, before its name. */
const LOCAL_HEADER_SIZE = 30;
/** The longest comment that may follow the end record, so how far back from the end it can start. */
const MAX_COMMENT = 0xffff;
/** The 16-bit entry count a ZIP64 archive writes in place of its real one. */
const COUNT_IN_ZIP64 = 0xffff;
/** The ZIP64 end-of-central-directory locator and record: their signatures, and how far before the end record the ZIP library looks for either. */
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_RECORD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIZE = 20;

const NO_ZIP64 = 'which VAT does not read: no skill or plugin archive needs one';

/**
 * The refusal of a ZIP VAT found the end of and will not take — `unsupported`, never `unreadable`:
 * `unreadable` is kept for bytes that are no ZIP at all, the one thing a lane may choose to pass
 * on to a service that is the authority on them. This is a ZIP, and VAT's answer to it is no.
 */
function unsupportedZip(archive: string, why: string, cause?: unknown): ArchiveRefusedError {
  return new ArchiveRefusedError(archive, { reason: 'unsupported', why }, { cause });
}

/** The two signatures that make bytes a ZIP, as bytes to search for anywhere in them: a local file header's, and the end record's. */
const LOCAL_SIGNATURE_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const END_SIGNATURE_BYTES = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/**
 * Whether `bytes` carry a ZIP signature at all: a local file header or an end record, ANYWHERE.
 * Bytes with neither are no ZIP (`unreadable`); bytes with either and no end record a reader finds
 * where every reader looks are a ZIP VAT will not take — one padded past that window, cut short,
 * or behind other bytes, which a reader that searches further back, or scans forward for a local
 * header, still takes.
 */
function holdsZipSignature(bytes: Buffer): boolean {
  return bytes.includes(LOCAL_SIGNATURE_BYTES) || bytes.includes(END_SIGNATURE_BYTES);
}

/** Where the last end-of-central-directory record starts, searching back from the end as every reader does; `undefined` when there is none. */
function endRecordAt(bytes: Buffer): number | undefined {
  const last = bytes.length - END_SIZE;
  for (let at = last; at >= Math.max(0, last - MAX_COMMENT); at--) {
    if (bytes.readUInt32LE(at) === END_SIGNATURE) return at;
  }
  return undefined;
}

/** Why a signature at `at` is refused, or `undefined` for bytes that are none of the three a reader looks for. */
function signatureRefusal(bytes: Buffer, at: number): string | undefined {
  const signature = bytes.readUInt32LE(at);
  if (signature === ZIP64_LOCATOR_SIGNATURE || signature === ZIP64_RECORD_SIGNATURE) return `it is a ZIP64 archive (a ZIP64 end-of-central-directory record or locator stands beside its end record), ${NO_ZIP64}`;
  return signature === END_SIGNATURE ? 'it holds more than one end-of-central-directory record where two readers would choose differently' : undefined;
}

/**
 * Refuse a ZIP whose end record a second reader could find differently — the first of the two
 * locks on "which directory is this archive's" (the second is {@link sameDirectory}).
 *
 * The ZIP library scans back from 22 bytes before the end of the bytes and takes the FIRST
 * signature it knows: an end record, or a ZIP64 record — which it meets first when one stands in
 * the archive comment — and having found an end record it looks on through the 20 bytes before it
 * for a ZIP64 locator or another end record. VAT's own reading is of the last end record. So the
 * bytes around that record must hold nothing a scan could mistake for one:
 *
 * - the record is the END of the archive: it, and exactly the comment it declares, and nothing after;
 * - no end-record, ZIP64-record or ZIP64-locator signature anywhere after the record's own
 *   first byte (its fields, its comment) nor in the 20 bytes before it;
 * - the central directory it names ends exactly where it starts.
 *
 * No archive within this module's limits needs ZIP64, so its frame is refused outright.
 *
 * @throws ArchiveRefusedError `unsupported`
 */
function refuseAmbiguousEndRecord(bytes: Buffer, archive: string, end: number): void {
  if (end + END_SIZE + bytes.readUInt16LE(end + 20) !== bytes.length) {
    throw unsupportedZip(archive, 'its end-of-central-directory record is not the end of the archive: the comment it declares and the bytes that follow it disagree');
  }
  for (let at = Math.max(0, end - ZIP64_LOCATOR_SIZE); at <= bytes.length - 4; at++) {
    const refusal = at === end ? undefined : signatureRefusal(bytes, at);
    if (refusal !== undefined) throw unsupportedZip(archive, refusal);
  }
  if (bytes.readUInt32LE(end + 16) + bytes.readUInt32LE(end + 12) !== end) {
    throw unsupportedZip(archive, 'its central directory does not end where its end-of-central-directory record begins');
  }
}

/**
 * One central-directory record as VAT reads it off the bytes: the name, and every field the ZIP
 * library extracts the entry by — where its local header is, the two sizes, and the method.
 */
interface CentralRecord {
  readonly name: Buffer;
  readonly offset: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly method: number;
}

/** The fields of a {@link CentralRecord} beside its name, as the ZIP library's entry header carries them. */
const EXTENT_FIELDS = ['offset', 'compressedSize', 'size', 'method'] as const;

/**
 * The records the central directory lists, read off the bytes — before the ZIP library builds
 * a record for each, and whether or not it would accept them: the count is held to `limits`
 * here, and a name listed twice is found here, by VAT's own reading and not the library's prose.
 * `undefined` for bytes with no end record where a reader looks for one, for {@link readZip} to judge.
 *
 * The count read is the one the library loops over ("entries on this disk"); an end record whose
 * two counts differ, or that defers them to ZIP64 fields, is refused, and so is a directory whose
 * records do not run exactly from its start to the end record — so what is bounded and compared
 * here is exactly what the library goes on to build ({@link refuseAmbiguousEndRecord}).
 *
 * @returns Each record, its name as the bytes the directory holds, in directory order; and where the directory starts
 * @throws ArchiveRefusedError `too-many-entries`; `unsupported` for a ZIP64 archive, or an end
 *   record or directory two readers would read differently
 */
function directoryRecords(bytes: Buffer, archive: string, limits: ArchiveLimits): { records: CentralRecord[]; directoryAt: number } | undefined {
  const end = endRecordAt(bytes);
  if (end === undefined) return undefined;
  refuseAmbiguousEndRecord(bytes, archive, end);
  const count = bytes.readUInt16LE(end + 8);
  if (count !== bytes.readUInt16LE(end + 10)) throw unsupportedZip(archive, 'its end-of-central-directory record counts its entries two ways (on this disk, and in total)');
  if (count === COUNT_IN_ZIP64) throw unsupportedZip(archive, `it is a ZIP64 archive (its end record defers the entry count to ZIP64 fields), ${NO_ZIP64}`);
  if (count > limits.maxEntries) throw tooManyEntries(archive, limits);
  const records: CentralRecord[] = [];
  let at = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    if (at + CENTRAL_SIZE > end || bytes.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw unsupportedZip(archive, `its central directory holds no record where its entry ${index + 1} of ${count} should be`);
    const nameEnd = at + CENTRAL_SIZE + bytes.readUInt16LE(at + 28);
    records.push({
      name: bytes.subarray(at + CENTRAL_SIZE, nameEnd),
      method: bytes.readUInt16LE(at + 10),
      compressedSize: bytes.readUInt32LE(at + 20),
      size: bytes.readUInt32LE(at + 24),
      offset: bytes.readUInt32LE(at + 42),
    });
    at = nameEnd + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  if (at !== end) throw unsupportedZip(archive, `its central directory holds more than the ${count} entries its end record counts`);
  return { records, directoryAt: bytes.readUInt32LE(end + 16) };
}

/**
 * Refuse a ZIP whose first byte is not the first local header its directory names (or, holding
 * no entries, its directory): a self-extracting stub, or any other bytes put before the archive —
 * whether or not its offsets were moved to step over them (`zip -A`): a ZIP no writer VAT takes
 * from makes. ({@link refuseRecordWithoutItsLocalHeader} makes "the first local header its
 * directory names" a header that is really there.)
 *
 * This closes unlisted bytes at the FRONT only: an unlisted local entry between listed ones, or
 * after the last, is not refused. It is no defence on its own and need not be — no lane forwards
 * an operator's ZIP bytes: every lane reads entries by the directory, and `zipOfArchive` re-writes
 * only the entries it judged, so no unlisted entry leaves VAT.
 *
 * @throws ArchiveRefusedError `unsupported`
 */
function refuseDataBeforeFirstEntry(archive: string, { records, directoryAt }: { readonly records: readonly CentralRecord[]; readonly directoryAt: number }): void {
  const first = records.reduce((lowest, record) => Math.min(lowest, record.offset), directoryAt);
  if (first !== 0) throw unsupportedZip(archive, `it holds ${first} bytes before its first local file header (a self-extracting stub, or other data put before the archive), which a reader that reads local headers from the front would read`);
}

/** What a central record holds in a size or offset it defers to a ZIP64 extra field. */
const DEFERRED_TO_ZIP64 = 0xff_ff_ff_ff;

/**
 * Refuse a ZIP one of whose central records holds {@link DEFERRED_TO_ZIP64} for a size or its
 * offset. With a ZIP64 extra field the ZIP library reads another value than VAT and
 * {@link sameDirectory} refuses it; with none both read `0xFFFFFFFF` and agree — and a directory,
 * whose sizes are never used and whose data is never read, would pass. ZIP64 is refused outright.
 *
 * @throws ArchiveRefusedError `unsupported` (the archive as a whole; its message names the record)
 */
function refuseZip64Fields(archive: string, records: readonly CentralRecord[]): void {
  const deferred = records.find((record) => [record.compressedSize, record.size, record.offset].includes(DEFERRED_TO_ZIP64));
  if (deferred !== undefined) throw unsupportedZip(archive, `it is a ZIP64 archive (the central record of \`${decodeTextContent(deferred.name).text}\` holds 0xFFFFFFFF for a size or its offset), ${NO_ZIP64}`);
}

/** Whether a local file header for `record` — its signature, then its own name — starts at the offset the record names, before the directory. */
function holdsItsLocalHeader(bytes: Buffer, record: CentralRecord, directoryAt: number): boolean {
  const { offset, name } = record;
  if (offset + LOCAL_HEADER_SIZE > directoryAt || !bytes.subarray(offset, offset + LOCAL_SIGNATURE_BYTES.length).equals(LOCAL_SIGNATURE_BYTES)) return false;
  const nameAt = offset + LOCAL_HEADER_SIZE;
  return nameAt + name.length <= directoryAt && bytes.readUInt16LE(offset + 26) === name.length && bytes.subarray(nameAt, nameAt + name.length).equals(name);
}

/**
 * Refuse a ZIP one of whose central records names an offset that does not hold that entry's own
 * local header. The ZIP library reads a local header only when it inflates a file — never for a
 * directory — so without this a directory record "at byte 0" stands over whatever is there, and
 * the directory would be one two readers read differently. Like {@link refuseDataBeforeFirstEntry}
 * it refuses only what a record points at: no lane forwards the operator's bytes, so an unlisted
 * entry elsewhere is dropped by the re-zip, not refused here.
 *
 * @throws ArchiveRefusedError `unsupported` (the archive as a whole; its message names the record)
 */
function refuseRecordWithoutItsLocalHeader(bytes: Buffer, archive: string, { records, directoryAt }: { readonly records: readonly CentralRecord[]; readonly directoryAt: number }): void {
  const headerless = records.find((record) => !holdsItsLocalHeader(bytes, record, directoryAt));
  if (headerless !== undefined) throw unsupportedZip(archive, `its central directory says the local file header of \`${decodeTextContent(headerless.name).text}\` is at byte ${headerless.offset}, and that entry's local header does not start there`);
}

/**
 * The second lock on "which directory is this archive's": the ZIP library's OWN answer, held to
 * VAT's. Whatever the two scans do, the entries the library built must be the entries VAT read
 * off the bytes — the same count, the same names in the same order, and each extracted by the
 * same local-header offset, sizes and method — or the archive is refused. A differential neither
 * reading anticipated lands here instead of in an install: so does a per-entry ZIP64 extra field,
 * which the library reads a size or an offset from wherever the central record holds 0xFFFFFFFF.
 *
 * @throws ArchiveRefusedError `unsupported`
 */
export function sameDirectory(
  archive: string,
  records: readonly CentralRecord[],
  entries: ReadonlyArray<{ readonly rawEntryName: Buffer; readonly header: Readonly<Record<(typeof EXTENT_FIELDS)[number], number>> }>,
): void {
  const agree = entries.length === records.length && entries.every((entry, index) => {
    const record = records[index];
    return record?.name.equals(entry.rawEntryName) === true && EXTENT_FIELDS.every((field) => entry.header[field] === record[field]);
  });
  if (!agree) throw unsupportedZip(archive, 'its central directory reads two ways: the entries the ZIP reader built are not the ones its end record names');
}

/**

 * Refuse a ZIP whose directory lists one name twice: the archive's own clash — two readers resolve
 * the name to different bytes — and the same `name-clash` a tarball listing a name twice is.
 *
 * @throws ArchiveRefusedError `name-clash`, naming the entry
 */
function refuseNameListedTwice(archive: string, records: readonly CentralRecord[]): void {
  const seen = new Set<string>();
  for (const { name: raw } of records) {
    // Compared byte for byte: two names that only DECODE alike are two names.
    const key = raw.toString('hex');
    if (seen.has(key)) {
      const name = decodeTextContent(raw).text;
      throw new ArchiveRefusedError(archive, { reason: 'name-clash', entry: name, why: `it lists \`${name}\` twice` });
    }
    seen.add(key);
  }
}

/**
 * Every entry of the ZIP archive `bytes`, in central-directory order, each as the archive spells
 * it — links, devices and unsafe names included: listing judges nothing. Nothing is inflated
 * until a record is read, and the reader caps each inflation at the size the entry declares.
 *
 * @param bytes - The archive
 * @param archive - What the operator named, for a refusal's message
 * @param limits - The bounds the archive is held to, by what its entries declare
 * @throws ArchiveRefusedError `unreadable` for bytes that are no ZIP archive at all (they hold
 *   neither a local-file-header nor an end-record signature anywhere); `unsupported` for a ZIP VAT
 *   will not take — no end record in the last 64 KiB, data before its first local header, ZIP64,
 *   an end record or a directory two readers would read differently, one the ZIP reader cannot parse; `name-clash` for one
 *   listing a name twice; `too-many-entries` or `too-large` for one past `limits`
 */
export function readZip(bytes: Buffer, archive: string, limits: ArchiveLimits): ArchiveRecord[] {
  const directory = bytes.length < END_SIZE ? undefined : directoryRecords(bytes, archive, limits);
  if (directory === undefined) {
    if (holdsZipSignature(bytes)) throw unsupportedZip(archive, 'it carries a ZIP signature and no end-of-central-directory record where every reader looks for one (in its last 64 KiB): it is padded, cut short, or buried under other bytes, and a reader that looks elsewhere would read it');
    throw unreadableArchive(archive, 'it is not a ZIP archive (its bytes hold neither a local file header nor an end-of-central-directory record)');
  }
  const { records } = directory;
  refuseNameListedTwice(archive, records);
  let entries: ZipEntry[];
  try {
    // The central directory is parsed at the first read of the entries, not when the archive is opened.
    entries = new AdmZip(bytes).getEntries();
  } catch (error: unknown) {
    throw unsupportedZip(archive, `the ZIP reader cannot read it (${String(error)})`, error);
  }
  sameDirectory(archive, records, entries);
  refuseZip64Fields(archive, records);
  // After the library's offsets are held to VAT's: an offset deferred to ZIP64 is that refusal, not this one.
  refuseDataBeforeFirstEntry(archive, directory);
  refuseRecordWithoutItsLocalHeader(bytes, archive, directory);
  const listed = entries.map((entry) => recordOf(entry));
  assertWithinLimits(archive, listed, limits);
  return listed;
}

/** `version made by` in every entry VAT writes: host 3 (Unix), spec version 2.0. */
const VERSION_MADE_ON_UNIX = (MADE_ON_UNIX << 8) | 20;
/** The MS-DOS directory flag, in the low byte of an entry's external attributes. */
const DOS_DIRECTORY = 0x10;

/**
 * The one mode policy of a ZIP VAT writes: a directory `0755`, a file `0755` when it is executable
 * and `0644` otherwise — never a mode the host's `stat` made up.
 *
 * @returns The entry's external attributes: the Unix type and permission bits high, the DOS directory flag low
 */
function writtenAttributesOf(directory: boolean, executable: boolean): number {
  if (directory) return (((TYPE_DIRECTORY | DIRECTORY_MODE) << 16) | DOS_DIRECTORY) >>> 0;
  return ((TYPE_REGULAR | (executable ? EXECUTABLE_MODE : FILE_MODE)) << 16) >>> 0;
}

/**
 * The bytes of `zip`, every entry made on Unix and holding the mode {@link writtenAttributesOf}
 * gives it. The ZIP library stamps the host it RUNS on (NTFS on Windows) and copies whatever mode
 * `stat` reports — on Windows a directory `0o40666`, a file `0o100666`, never an execute bit. A
 * host-aware reader (VAT's own {@link unixModeOf}, Info-ZIP) applies the Unix mode only under host
 * 3, so both are fixed here together: one archive is the same bytes wherever VAT writes it, and no
 * directory in it is one a Unix reader cannot enter.
 */
function bytesMadeOnUnix(zip: AdmZip): Buffer {
  for (const entry of zip.getEntries()) {
    entry.header.made = VERSION_MADE_ON_UNIX;
    entry.attr = writtenAttributesOf(entry.isDirectory, ((entry.attr >>> 16) & EXECUTE_BITS) !== 0);
  }
  return zip.toBuffer();
}

/**
 * The ZIP of a directory tree VAT built, in memory: every file under `sourceDir`, named relative
 * to it, each entry made on Unix with a directory `0755` and a file `0644`, or `0755` when the host
 * marks it executable ({@link bytesMadeOnUnix}).
 *
 * @param sourceDir - The directory to archive
 * @returns The archive's bytes
 * @throws the raw errno of a listing or a read the OS refuses, for the caller to classify
 */
export function zipOfDirectory(sourceDir: string): Buffer {
  const zip = new AdmZip();
  zip.addLocalFolder(sourceDir);
  return bytesMadeOnUnix(zip);
}

/** One entry of a ZIP VAT writes from entries it judged: a directory has no `data`. */
interface WrittenZipEntry {
  /** Where the entry lands: its segments joined with `/`, no empty, `.` or `..` segment. */
  readonly place: string;
  readonly data: Buffer | undefined;
  readonly executable: boolean;
}

/**
 * The ZIP of `entries`, in order, in memory — each a directory or a file with mode `0755` or
 * `0644` by its executable bit, made on Unix on every host ({@link bytesMadeOnUnix}), nothing else
 * of what an archive it came from said.
 *
 * @param entries - The entries, each named by the place it was judged at
 * @returns The archive's bytes
 */
export function zipOfEntries(entries: readonly WrittenZipEntry[]): Buffer {
  const zip = new AdmZip();
  for (const { place, data, executable } of entries) {
    // Only the execute bit is read from what is added here; the mode itself is {@link bytesMadeOnUnix}'s.
    if (data === undefined) zip.addFile(`${place}/`, Buffer.alloc(0), '', DIRECTORY_MODE);
    else zip.addFile(place, data, '', executable ? EXECUTABLE_MODE : FILE_MODE);
  }
  return bytesMadeOnUnix(zip);
}
