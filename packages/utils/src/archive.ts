/**
 * @vibe-agent-toolkit/utils/archive
 *
 * The one archive primitive: read, list, extract and create. It is the only module in VAT that
 * imports `tar` or `adm-zip` (`no-restricted-imports` holds every other file to that), so it is
 * quarantined behind its own subpath — a command that touches no archive never loads either.
 */

export { extractArchive, listArchive, openArchive } from './archive/archive.js';
export type { ArchiveExtractOptions, ArchiveReadOptions, ArchiveSource, OpenedArchive } from './archive/archive.js';
export { ARCHIVE_REFUSED_CODE, archiveEntryRefusal, ArchiveRefusedError } from './archive/entries.js';
export type { ArchiveEntry, ArchiveEntryKind, ArchiveFormat, ArchiveLimits, ArchiveRefusalReason, EntryRefusal } from './archive/entries.js';
export { ARCHIVE_DOWNLOAD_MAX_BYTES, ARCHIVE_LIMITS } from './archive/limits.js';
export { zipOfDirectory } from './archive/zip-reader.js';
