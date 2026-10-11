/**
 * The ONE way VAT reads or extracts an archive — an npm tarball, a skill ZIP, a ZIP fetched from
 * a URL. Every lane goes through here, so every lane has the same answer to the same archive:
 *
 * - The archive is read whole, in memory, bounded by the caller's {@link ArchiveLimits}.
 * - Which archives are extracted is decided from the entry list, before anything is written
 *   ({@link archiveEntryRefusal}): only regular files and directories, each named inside the
 *   archive, no two of them one name.
 * - What is written is written by VAT, never by an archive library: each directory a plain
 *   `mkdir`, each file an exclusive create that no link satisfies (`openFileUnder`), with mode
 *   `0644` or `0755` by the archive's executable bit and nothing else of its mode — narrowed by
 *   the process's umask, as any file it creates is.
 *
 * So an extracted tree holds no link, no special file and no setuid bit, whatever the archive said.
 */

import { classifyFsFault, type FsSide, withFsFault } from '../errors/fs-fault.js';
import { forEachInOrder } from '../in-order.js';
import { toForwardSlash } from '../path-core.js';
import { openForReading } from '../text-file.js';
import { makeDirectoryUnder, openFileUnder } from '../tree-change/files.js';

import { type ArchiveEntry, type ArchiveFormat, type ArchiveLimits, ArchiveRefusedError, archiveEntryRefusal, placeOf } from './entries.js';
import { archiveBytesCap, tooLarge, unreadableArchive } from './limits.js';
import type { ArchiveRecord } from './records.js';
import { readTar } from './tar-reader.js';
import { readZip } from './zip-reader.js';

/**
 * Where an archive is: a file — on the `side` of the verb that named it, an operator's argument
 * (`source`) or VAT's own download (`environment`) — or bytes already in hand, with the `label`
 * a refusal names them by.
 */
export type ArchiveSource =
  | { readonly file: string; readonly side: FsSide }
  | { readonly bytes: Uint8Array; readonly label: string };

/** What every read of an archive is told. Both are required: an omitted bound is the failure. */
export interface ArchiveReadOptions {
  readonly format: ArchiveFormat;
  readonly limits: ArchiveLimits;
}

/** What an extraction is told: how to read the archive, and which of its entries not to write. */
export interface ArchiveExtractOptions extends ArchiveReadOptions {
  /**
   * Entries to leave out of what is written (a host's own litter beside a skill). They are still
   * read and still JUDGED: an archive is refused for a link among them like any other.
   */
  readonly omit?: (entry: ArchiveEntry) => boolean;
}

/** An archive read into memory: what it lists, and each file's bytes on request. */
export interface OpenedArchive {
  /** What a refusal names the archive by: its path, or the label its bytes came with. */
  readonly label: string;
  /** Every entry, in archive order, as the archive spells it. Nothing here has been judged. */
  readonly entries: readonly ArchiveEntry[];
  /**
   * The bytes of one of {@link entries} (a file).
   *
   * @throws ArchiveRefusedError `unreadable`, naming the entry, when it does not inflate to the size it declares
   */
  read(entry: ArchiveEntry): Buffer;
}

const READERS: Readonly<Record<ArchiveFormat, (bytes: Buffer, archive: string, limits: ArchiveLimits) => ArchiveRecord[]>> = {
  tar: readTar,
  zip: readZip,
};

/** The widest mode an extracted file gets: the executable bit is all an archive's mode decides. */
const FILE_MODE = 0o644;
const EXECUTABLE_MODE = 0o755;
const PERMISSION_BITS = 0o777;
const READ_BITS = 0o444;

/**
 * The mode of an extracted file: what the process's own umask gave the file when it was created,
 * never wider — `0644` at most, or `0755` for an executable entry, with execute granted exactly
 * where the umask left read. Under `umask 077` an extracted file is `0600` / `0700`, as a file
 * the user made any other way is.
 *
 * @param created - The mode the exclusive create gave the file
 * @param executable - Whether the archive marked the entry executable
 */
export function extractedFileMode(created: number, executable: boolean): number {
  const granted = created & PERMISSION_BITS;
  return executable ? (granted | ((granted & READ_BITS) >> 2)) & EXECUTABLE_MODE : granted & FILE_MODE;
}

const labelOf = (source: ArchiveSource): string => ('file' in source ? toForwardSlash(source.file) : source.label);

/**
 * The archive file's bytes, through a handle opened without blocking (a named pipe is refused,
 * never waited on) and sized by `fstat` on that handle before a byte is read.
 *
 * @throws FsFaultError on `side` for a read the OS refuses; ArchiveRefusedError `too-large` for a
 *   file no archive within `limits` can be
 */
async function fileBytes(file: string, side: FsSide, limits: ArchiveLimits): Promise<Buffer> {
  return await withFsFault({ side, origin: 'argument', action: `read the archive ${toForwardSlash(file)}`, path: file }, async () => {
    const handle = await openForReading(file);
    try {
      if ((await handle.stat()).size > archiveBytesCap(limits)) throw tooLarge(toForwardSlash(file), limits);
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  });
}

async function bytesOf(source: ArchiveSource, limits: ArchiveLimits): Promise<Buffer> {
  if ('file' in source) return await fileBytes(source.file, source.side, limits);
  if (source.bytes.byteLength > archiveBytesCap(limits)) throw tooLarge(source.label, limits);
  return Buffer.from(source.bytes.buffer, source.bytes.byteOffset, source.bytes.byteLength);
}

/** One record's bytes, held to the size its entry declared. */
function bytesOfRecord(archive: string, record: ArchiveRecord): Buffer {
  let data: Buffer;
  try {
    data = record.read();
  } catch (error: unknown) {
    throw unreadableArchive(archive, `its entry \`${record.name}\` does not inflate (${String(error)})`, error, record.name);
  }
  if (data.length !== record.size) {
    throw unreadableArchive(archive, `its entry \`${record.name}\` declares ${record.size} bytes and holds ${data.length}`, undefined, record.name);
  }
  return data;
}

interface OpenedRecords extends OpenedArchive {
  readonly records: readonly ArchiveRecord[];
}

async function openRecords(source: ArchiveSource, options: ArchiveReadOptions): Promise<OpenedRecords> {
  const label = labelOf(source);
  const records = READERS[options.format](await bytesOf(source, options.limits), label, options.limits);
  const byEntry = new Map<ArchiveEntry, ArchiveRecord>(records.map((record) => [record, record]));
  return {
    label,
    entries: records,
    records,
    read(entry) {
      const record = byEntry.get(entry);
      if (record === undefined) throw new TypeError(`"${entry.name}" is not an entry of ${label}`);
      return bytesOfRecord(label, record);
    },
  };
}

/**
 * Read an archive into memory and list it. Nothing is judged: a caller that only inspects an
 * archive (an upload's preflight) sees its links and unsafe names as entries.
 *
 * @param source - The archive
 * @param options - Its `format`, and the `limits` it is held to as it is read
 * @throws FsFaultError on the source's side when the OS refuses the read; ArchiveRefusedError
 *   `unreadable` for bytes that are no archive of the format, `too-many-entries` / `too-large`
 *   for one past `limits`
 */
export async function openArchive(source: ArchiveSource, options: ArchiveReadOptions): Promise<OpenedArchive> {
  return await openRecords(source, options);
}

/**
 * Every entry of an archive, in archive order ({@link openArchive}).
 *
 * @throws as {@link openArchive}
 */
export async function listArchive(source: ArchiveSource, options: ArchiveReadOptions): Promise<readonly ArchiveEntry[]> {
  return (await openRecords(source, options)).entries;
}

/** Write one accepted entry under `into`: a directory made plainly, a file created exclusively with only its executable bit kept. */
async function writeRecord(archive: string, into: string, record: ArchiveRecord): Promise<void> {
  const relative = placeOf(record.name).join('/');
  const writing = `the entry ${record.name} of ${archive}`;
  if (record.kind === 'directory') {
    // The archive's own root (`./`) is the directory the caller made.
    if (relative !== '') await makeDirectoryUnder(into, relative, writing);
    return;
  }
  const data = bytesOfRecord(archive, record);
  const handle = await openFileUnder(into, relative, { existing: 'refuse', writing });
  try {
    await handle.writeFile(data);
    // On the handle, never by path: nothing swapped in after the create is examined or chmod-ed through.
    await handle.chmod(extractedFileMode((await handle.stat()).mode, record.executable));
  } finally {
    await handle.close();
  }
}

/**
 * Extract an archive into `into`, a directory the caller just made — every entry, or a refusal.
 *
 * The whole entry list is judged first ({@link archiveEntryRefusal}); an archive that passes is
 * written one entry at a time, in archive order, so when this throws nothing is still being
 * written and the caller may dispose of `into`.
 *
 * @param source - The archive
 * @param into - A fresh directory VAT owns (staging, a cache entry): every write is VAT's own scratch
 * @param options - The archive's `format`, the `limits` it is held to, and any entries to `omit`
 * @returns Every entry of the archive, in archive order — an omitted one included
 * @throws ArchiveRefusedError — the input's refusal — for an archive that is unreadable, past
 *   `limits`, or holds an entry the policy refuses, with nothing written; FsFaultError on the
 *   source's side for a read the OS refuses, and side `environment` for a write it refuses
 */
export async function extractArchive(source: ArchiveSource, into: string, options: ArchiveExtractOptions): Promise<readonly ArchiveEntry[]> {
  const opened = await openRecords(source, options);
  const refusal = archiveEntryRefusal(opened.entries);
  if (refusal !== undefined) throw new ArchiveRefusedError(opened.label, refusal);
  try {
    // In order: a directory before what goes in it, and the first failure the only one.
    const written = options.omit === undefined ? opened.records : opened.records.filter((record) => options.omit?.(record) !== true);
    await forEachInOrder(written, (record) => writeRecord(opened.label, into, record));
  } catch (error: unknown) {
    throw classifyFsFault(error, { side: 'environment', action: `extract ${opened.label}`, path: into });
  }
  return opened.entries;
}
