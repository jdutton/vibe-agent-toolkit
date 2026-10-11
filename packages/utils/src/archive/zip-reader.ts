/**
 * The ZIP reader and writer: every entry of a ZIP's central directory, each inflated only when
 * asked, and the one ZIP VAT writes. One of the two files in VAT that import an archive library.
 */

import AdmZip from 'adm-zip';

import { decodeTextContent } from '../text-content.js';

import { type ArchiveEntryKind, type ArchiveLimits, ArchiveRefusedError } from './entries.js';
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
    name: entry.entryName,
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
 * The entry names the central directory lists, read off the bytes — before the ZIP library builds
 * a record for each, and whether or not it would accept them: the count is held to `limits`
 * here, and a name listed twice is found here, by VAT's own reading and not the library's prose.
 * `undefined` for bytes that hold no end record at all — not a ZIP — which the library then refuses.
 *
 * The count read is the one the library loops over ("entries on this disk"); an end record whose
 * two counts differ, or that defers them to ZIP64 fields, is refused, and so is a directory whose
 * records do not run exactly from its start to the end record — so what is bounded and compared
 * here is exactly what the library goes on to build ({@link refuseAmbiguousEndRecord}).
 *
 * @returns Each name as the bytes the directory holds, in directory order
 * @throws ArchiveRefusedError `too-many-entries`; `unsupported` for a ZIP64 archive, or an end
 *   record or directory two readers would read differently
 */
function directoryNames(bytes: Buffer, archive: string, limits: ArchiveLimits): Buffer[] | undefined {
  const end = endRecordAt(bytes);
  if (end === undefined) return undefined;
  refuseAmbiguousEndRecord(bytes, archive, end);
  const count = bytes.readUInt16LE(end + 8);
  if (count !== bytes.readUInt16LE(end + 10)) throw unsupportedZip(archive, 'its end-of-central-directory record counts its entries two ways (on this disk, and in total)');
  if (count === COUNT_IN_ZIP64) throw unsupportedZip(archive, `it is a ZIP64 archive (its end record defers the entry count to ZIP64 fields), ${NO_ZIP64}`);
  if (count > limits.maxEntries) throw tooManyEntries(archive, limits);
  const names: Buffer[] = [];
  let at = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    if (at + CENTRAL_SIZE > end || bytes.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw unsupportedZip(archive, `its central directory holds no record where its entry ${index + 1} of ${count} should be`);
    const nameEnd = at + CENTRAL_SIZE + bytes.readUInt16LE(at + 28);
    names.push(bytes.subarray(at + CENTRAL_SIZE, nameEnd));
    at = nameEnd + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  if (at !== end) throw unsupportedZip(archive, `its central directory holds more than the ${count} entries its end record counts`);
  return names;
}

/**
 * The second lock on "which directory is this archive's": the ZIP library's OWN answer, held to
 * VAT's. Whatever the two scans do, the entries the library built must be the entries VAT read
 * off the bytes — the same count, the same names in the same order — or the archive is refused.
 * A differential neither reading anticipated lands here instead of in an install.
 *
 * @throws ArchiveRefusedError `unsupported`
 */
export function sameDirectory(archive: string, names: readonly Buffer[], entries: ReadonlyArray<{ readonly rawEntryName: Buffer }>): void {
  const agree = entries.length === names.length && entries.every((entry, index) => names[index]?.equals(entry.rawEntryName) === true);
  if (!agree) throw unsupportedZip(archive, 'its central directory reads two ways: the entries the ZIP reader built are not the ones its end record names');
}

/**

 * Refuse a ZIP whose directory lists one name twice: the archive's own clash — two readers resolve
 * the name to different bytes — and the same `name-clash` a tarball listing a name twice is.
 *
 * @throws ArchiveRefusedError `name-clash`, naming the entry
 */
function refuseNameListedTwice(archive: string, names: readonly Buffer[]): void {
  const seen = new Set<string>();
  for (const raw of names) {
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
 * @throws ArchiveRefusedError `unreadable` for bytes that are no ZIP archive at all (they hold no
 *   end record); `unsupported` for a ZIP VAT will not take — ZIP64, an end record or a directory
 *   two readers would read differently, one the ZIP reader cannot parse; `name-clash` for one
 *   listing a name twice; `too-many-entries` or `too-large` for one past `limits`
 */
export function readZip(bytes: Buffer, archive: string, limits: ArchiveLimits): ArchiveRecord[] {
  const names = bytes.length < END_SIZE ? undefined : directoryNames(bytes, archive, limits);
  if (names === undefined) throw unreadableArchive(archive, 'it is not a ZIP archive (its bytes hold no end-of-central-directory record)');
  refuseNameListedTwice(archive, names);
  let entries: ZipEntry[];
  try {
    // The central directory is parsed at the first read of the entries, not when the archive is opened.
    entries = new AdmZip(bytes).getEntries();
  } catch (error: unknown) {
    throw unsupportedZip(archive, `the ZIP reader cannot read it (${String(error)})`, error);
  }
  sameDirectory(archive, names, entries);
  const records = entries.map(recordOf);
  assertWithinLimits(archive, records, limits);
  return records;
}

/**
 * The ZIP of a directory tree VAT built, in memory: every file under `sourceDir`, named relative
 * to it.
 *
 * @param sourceDir - The directory to archive
 * @returns The archive's bytes
 * @throws the raw errno of a listing or a read the OS refuses, for the caller to classify
 */
export function zipOfDirectory(sourceDir: string): Buffer {
  const zip = new AdmZip();
  zip.addLocalFolder(sourceDir);
  return zip.toBuffer();
}
