/**
 * The bounds on what an archive may hold, and the refusals for one past them. An archive past a
 * bound is the INPUT's refusal: a tarball that would fill the disk is refused for what it is,
 * before a byte of it is written, never reported as VAT's staging running out.
 */

import { ArchiveRefusedError, type ArchiveLimits } from './entries.js';

const MIB = 1024 * 1024;

/**
 * What an archive VAT installs from — an npm package tarball, a skill ZIP — may hold. Two orders
 * of magnitude above any real skill package, and small enough to read in memory.
 */
export const ARCHIVE_LIMITS: ArchiveLimits = { maxEntries: 50_000, maxBytes: 256 * MIB };

/** The most bytes VAT downloads for an archive it is given a URL for. */
export const ARCHIVE_DOWNLOAD_MAX_BYTES = 100 * MIB;

/** What an archive's own structure may add per entry (headers, padding, a long-name record) on top of its files' bytes. */
const OVERHEAD_PER_ENTRY = 2048;

/**
 * The most bytes an archive within `limits` can be, read whole — as a file, or as a tar stream
 * once inflated: its files' bytes and its own structure.
 */
export function archiveBytesCap(limits: ArchiveLimits): number {
  return limits.maxBytes + limits.maxEntries * OVERHEAD_PER_ENTRY + MIB;
}

/** The refusal of an archive listing more entries than `limits` allows. */
export function tooManyEntries(archive: string, limits: ArchiveLimits): ArchiveRefusedError {
  return new ArchiveRefusedError(archive, { reason: 'too-many-entries', why: `it holds more than ${limits.maxEntries} entries, the most VAT reads from one archive` });
}

/** The refusal of an archive that expands past `limits`. */
export function tooLarge(archive: string, limits: ArchiveLimits, cause?: unknown): ArchiveRefusedError {
  return new ArchiveRefusedError(archive, { reason: 'too-large', why: `it expands to more than ${limits.maxBytes} bytes, the most VAT reads from one archive` }, { cause });
}

/** The refusal of bytes that are no archive of the format, or of an entry that does not inflate. */
export function unreadableArchive(archive: string, why: string, cause?: unknown, entry?: string): ArchiveRefusedError {
  return new ArchiveRefusedError(archive, { reason: 'unreadable', why, ...(entry === undefined ? {} : { entry }) }, { cause });
}

/**
 * Hold an entry list to `limits`: its count, and the sum of the sizes its files declare.
 *
 * @throws ArchiveRefusedError `too-many-entries` or `too-large`
 */
export function assertWithinLimits(archive: string, entries: ReadonlyArray<{ readonly size: number }>, limits: ArchiveLimits): void {
  if (entries.length > limits.maxEntries) throw tooManyEntries(archive, limits);
  let total = 0;
  for (const entry of entries) {
    total += entry.size;
    if (total > limits.maxBytes) throw tooLarge(archive, limits);
  }
}
