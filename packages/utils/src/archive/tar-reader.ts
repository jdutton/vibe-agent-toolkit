/**
 * The tar reader: every entry of a tar stream (gzipped or plain), parsed in memory and bounded
 * while it is parsed. One of the two files in VAT that import an archive library.
 */

import { gunzipSync } from 'node:zlib';

import { Parser, type ReadEntry } from 'tar';

import { isVatError } from '../errors/vat-error.js';

import { ARCHIVE_REFUSED_CODE, type ArchiveEntryKind, type ArchiveLimits } from './entries.js';
import { archiveBytesCap, tooLarge, tooManyEntries, unreadableArchive } from './limits.js';
import type { ArchiveRecord } from './records.js';

/** The tar entry types that are a regular file, and the ones that are a directory. */
const FILE_TYPES: ReadonlySet<string> = new Set(['File', 'OldFile', 'ContiguousFile']);
const DIRECTORY_TYPES: ReadonlySet<string> = new Set(['Directory', 'GNUDumpDir']);

/**
 * What an entry is. One the tar library would SKIP — a sparse file, a continuation, a tape volume
 * header, a type byte no tar defines, a metadata record too large to read — is `other`: dropping
 * it silently would install the archive without one of its entries, where `tar xf` writes a file.
 */
function kindOf(entry: ReadEntry): ArchiveEntryKind {
  if (entry.ignore) return 'other';
  const type: string = entry.type;
  if (FILE_TYPES.has(type)) return 'file';
  if (DIRECTORY_TYPES.has(type)) return 'directory';
  if (type === 'SymbolicLink') return 'link';
  if (type === 'Link') return 'hardlink';
  return 'other';
}

/** Any of the owner, group or other execute bits. */
const EXECUTE_BITS = 0o111;

/** Whether zlib refused to inflate past the cap it was given. */
function exceededOutputCap(error: unknown): boolean {
  return (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE';
}

/** The magic numbers a compressed stream begins with. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;

const beginsWith = (bytes: Buffer, magic: readonly number[]): boolean => magic.every((byte, index) => bytes[index] === byte);

/**
 * The tar stream itself: `bytes` inflated when they are gzip (by their magic number), bounded by
 * what an archive within `limits` can be — so a stream that inflates without end is refused at
 * the bound, never held.
 *
 * ONE layer, and it is this one. The tar library sniffs whatever it is handed for a gzip or a zstd
 * magic of its own and inflates it with no bound of VAT's, so a stream that is still compressed
 * here — a tarball gzipped twice, a zstd stream — is refused, never passed on.
 */
function tarStream(bytes: Buffer, archive: string, limits: ArchiveLimits): Buffer {
  let stream = bytes;
  if (beginsWith(bytes, GZIP_MAGIC)) {
    try {
      stream = gunzipSync(bytes, { maxOutputLength: archiveBytesCap(limits) });
    } catch (error: unknown) {
      throw exceededOutputCap(error) ? tooLarge(archive, limits, error) : unreadableArchive(archive, `it is not a gzip stream that inflates (${String(error)})`, error);
    }
    if (beginsWith(stream, GZIP_MAGIC)) throw unreadableArchive(archive, 'it is compressed more than once (a gzip stream inside a gzip stream), and VAT inflates one layer');
  }
  if (beginsWith(stream, ZSTD_MAGIC)) throw unreadableArchive(archive, 'it is a zstd stream, and VAT reads a tar archive plain or gzipped');
  return stream;
}

/** One parse of a tar stream, holding the entries and the bounds they are held to. */
class TarListing {
  readonly records: ArchiveRecord[] = [];
  /** The first thing the parser said is wrong with the stream. */
  problem: string | undefined;
  #bytes = 0;
  readonly #archive: string;
  readonly #limits: ArchiveLimits;

  constructor(archive: string, limits: ArchiveLimits) {
    this.#archive = archive;
    this.#limits = limits;
  }

  /** Take one entry at its header — bounded there, before its body is read. */
  readonly take = (entry: ReadEntry): void => {
    const kind = kindOf(entry);
    const size = kind === 'file' ? entry.size : 0;
    this.#bytes += size;
    if (this.records.length >= this.#limits.maxEntries) throw tooManyEntries(this.#archive, this.#limits);
    if (this.#bytes > this.#limits.maxBytes) throw tooLarge(this.#archive, this.#limits);
    // The body arrives as slices of the stream this module holds: kept, not copied. A skipped entry's body is the library's to drain.
    const chunks: Buffer[] = [];
    if (!entry.ignore) entry.on('data', (chunk: Buffer) => chunks.push(chunk));
    this.records.push({
      name: entry.path,
      kind,
      size,
      executable: ((entry.mode ?? 0) & EXECUTE_BITS) !== 0,
      read: () => (chunks.length === 1 && chunks[0] !== undefined ? chunks[0] : Buffer.concat(chunks)),
    });
  };

  readonly warn = (_code: string, message: string): void => {
    this.problem ??= message;
  };
}

/**
 * Every entry of the tar archive `bytes`, in archive order, each as the archive spells it — links,
 * devices and unsafe names included: listing judges nothing. Synchronous and in memory.
 *
 * @param bytes - The archive, gzipped or plain
 * @param archive - What the operator named, for a refusal's message
 * @param limits - The bounds the archive is held to as it is parsed
 * @throws ArchiveRefusedError `unreadable` for bytes that are no tar archive (or a truncated one),
 *   `too-many-entries` or `too-large` for one past `limits`
 */
export function readTar(bytes: Buffer, archive: string, limits: ArchiveLimits): ArchiveRecord[] {
  const listing = new TarListing(archive, limits);
  const stream = tarStream(bytes, archive, limits);
  // The library is told to inflate nothing: `tarStream` has refused every stream it would sniff as compressed.
  const parser = new Parser({ onReadEntry: listing.take, onwarn: listing.warn, brotli: false, zstd: false });
  parser.on('ignoredEntry', listing.take);
  try {
    // In memory the parse is synchronous: every entry has been taken, whole, when `end` returns.
    parser.end(stream);
  } catch (error: unknown) {
    // A bound `take` raised is the refusal; anything else is the library giving up on the bytes.
    if (isVatError(error, ARCHIVE_REFUSED_CODE)) throw error;
    throw unreadableArchive(archive, `it is not a tar archive VAT can read (${String(error)})`, error);
  }
  if (listing.problem !== undefined) throw unreadableArchive(archive, `it is not a tar archive VAT can read (${listing.problem})`);
  for (const record of listing.records) {
    if (record.kind === 'file' && record.read().length !== record.size) {
      throw unreadableArchive(archive, `its entry \`${record.name}\` is cut short`, undefined, record.name);
    }
  }
  return listing.records;
}
