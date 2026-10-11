/**
 * What an archive holds, and the ONE policy for which archives VAT extracts — decided from the
 * entry list alone, before anything is written. Pure: nothing here reads or writes.
 */

import { VatError } from '../errors/vat-error.js';
import { foldedSegment } from '../name-fold.js';
import { hasParentTraversalSegment, toForwardSlashAnyPlatform } from '../path-core.js';

/** The archive formats VAT reads: a ZIP, or a tar stream (gzipped or plain). */
export type ArchiveFormat = 'zip' | 'tar';

/** What one entry of an archive is. `other` is a device, a FIFO, a socket or a type VAT does not know. */
export type ArchiveEntryKind = 'file' | 'directory' | 'link' | 'hardlink' | 'other';

/** One entry of an archive, as the archive spells it. */
export interface ArchiveEntry {
  /** The entry's name, verbatim. */
  readonly name: string;
  readonly kind: ArchiveEntryKind;
  /** The uncompressed size the entry's header declares, in bytes; `0` for anything but a file. */
  readonly size: number;
}

/** How much an archive may hold. Every reader is given one: there is no default, because an omitted bound is the failure. */
export interface ArchiveLimits {
  /** The most entries — files, directories and everything else — the archive may list. */
  readonly maxEntries: number;
  /** The most bytes its files may expand to, summed. */
  readonly maxBytes: number;
}

/** The code of every {@link ArchiveRefusedError}. */
export const ARCHIVE_REFUSED_CODE = 'ARCHIVE_REFUSED';

/**
 * Why an archive was refused:
 * - `unreadable`: its bytes are no archive of the format, or an entry does not inflate;
 * - `unsupported`: it IS a ZIP, and one VAT will not take — ZIP64, or an end record or directory
 *   two readers would read differently. Never passed on by any lane, where `unreadable` bytes may be;
 * - `link`, `hardlink`, `special`: it holds an entry that is not a file or a directory;
 * - `unsafe-name`: an entry is named outside the directory it is extracted into;
 * - `name-clash`: two entries are one name, or one is a file with another at or under it;
 * - `too-many-entries`, `too-large`: it is past an {@link ArchiveLimits} bound.
 */
export type ArchiveRefusalReason = 'unreadable' | 'unsupported' | 'link' | 'hardlink' | 'special' | 'unsafe-name' | 'name-clash' | 'too-many-entries' | 'too-large';

/** An archive VAT will not read, extract or pass on: the input's refusal, never the run's. */
export class ArchiveRefusedError extends VatError {
  readonly reason: ArchiveRefusalReason;
  /** The first offending entry, as the archive spells it; none when the archive as a whole is refused. */
  readonly entry: string | undefined;

  /**
   * @param archive - What the operator named: the archive's path or URL
   * @param refusal - Why, and the entry it is about
   */
  constructor(archive: string, refusal: { readonly reason: ArchiveRefusalReason; readonly entry?: string; readonly why: string }, options?: ErrorOptions) {
    super(ARCHIVE_REFUSED_CODE, `${archive} is not an archive VAT accepts, nothing was changed: ${refusal.why}`, options);
    this.reason = refusal.reason;
    this.entry = refusal.entry;
  }
}

/** A refusal before it names its archive: what {@link archiveEntryRefusal} answers. */
export interface EntryRefusal {
  readonly reason: ArchiveRefusalReason;
  readonly entry: string;
  readonly why: string;
}

/** A Windows drive prefix (`C:`), which makes a name absolute or drive-relative there. */
const DRIVE_PREFIX = /^[A-Za-z]:/;

/**
 * Where an entry lands under the directory it is extracted into: its segments, a backslash read
 * as a separator on every host (as a ZIP written on Windows spells one), empty and `.` segments
 * dropped. Only for a name {@link unsafeNameReason} accepts.
 */
export function placeOf(name: string): string[] {
  return toForwardSlashAnyPlatform(name).split('/').filter((segment) => segment !== '' && segment !== '.');
}

/** Why `name` would land outside the extraction directory on some host, or `undefined`. */
function unsafeNameReason(name: string): string | undefined {
  if (name.includes('\0')) return 'holds a NUL character';
  const spelled = toForwardSlashAnyPlatform(name);
  if (spelled.startsWith('/')) return 'is an absolute path';
  if (DRIVE_PREFIX.test(spelled)) return 'begins with a drive letter';
  if (hasParentTraversalSegment(name)) return 'holds a `..` segment';
  return undefined;
}

/** What each entry kind that is not extracted is called, and its reason. */
const UNEXTRACTED: Readonly<Record<Exclude<ArchiveEntryKind, 'file' | 'directory'>, { reason: ArchiveRefusalReason; what: string }>> = {
  link: { reason: 'link', what: 'a symbolic link' },
  hardlink: { reason: 'hardlink', what: 'a hard link' },
  other: { reason: 'special', what: 'a device, a named pipe or another special file' },
};

/** The refusal of an entry for what it is or how it is named, or `undefined`. */
function entryRefusal(entry: ArchiveEntry): EntryRefusal | undefined {
  if (entry.kind !== 'file' && entry.kind !== 'directory') {
    const { reason, what } = UNEXTRACTED[entry.kind];
    return { reason, entry: entry.name, why: `its entry \`${entry.name}\` is ${what}, and an archive may hold only files and directories` };
  }
  const unsafe = unsafeNameReason(entry.name);
  if (unsafe !== undefined) return { reason: 'unsafe-name', entry: entry.name, why: `its entry \`${entry.name}\` ${unsafe}, so it names a place outside the archive` };
  if (entry.kind === 'file' && placeOf(entry.name).length === 0) {
    return { reason: 'unsafe-name', entry: entry.name, why: `its entry \`${entry.name}\` is a file that names no place inside the archive` };
  }
  return undefined;
}

/** A place an earlier entry claimed: how it was spelled, what stands there, and the entry that claimed it. */
interface Claim {
  readonly spelled: string;
  readonly kind: 'file' | 'directory';
  readonly entry: string;
}

/**
 * Claim every place `entry` needs — each directory above it, and its own — refusing the first one
 * an earlier entry holds differently: under another spelling of one folded name, or as a file
 * where this entry needs a directory (or the reverse), or as the very same file.
 */
function claimPlaces(entry: ArchiveEntry, claims: Map<string, Claim>): EntryRefusal | undefined {
  const place = placeOf(entry.name);
  for (let depth = 1; depth <= place.length; depth += 1) {
    const segments = place.slice(0, depth);
    const kind = depth === place.length && entry.kind === 'file' ? 'file' : 'directory';
    const key = segments.map(foldedSegment).join('/');
    const spelled = segments.join('/');
    const held = claims.get(key);
    if (held === undefined) {
      claims.set(key, { spelled, kind, entry: entry.name });
    } else if (held.spelled !== spelled) {
      // Which rule of the fold matched: on NTFS, `name:stream` is the file `name`.
      const rule = held.spelled.includes(':') || spelled.includes(':')
        ? 'on NTFS, where what follows a `:` names a stream of the file before it'
        : 'where a volume folds letter case, Unicode form or trailing dots';
      return {
        reason: 'name-clash',
        entry: entry.name,
        why: `its entries \`${held.entry}\` and \`${entry.name}\` are one name ${rule} (\`${held.spelled}\` and \`${spelled}\`), so one would overwrite the other`,
      };
    } else if (held.kind === 'file' || kind === 'file') {
      const why = held.kind === kind
        ? `it lists \`${entry.name}\` twice`
        : `it holds both \`${held.entry}\` and \`${entry.name}\`, and \`${spelled}\` is a file in one and a directory in the other, so no directory can hold the two`;
      return { reason: 'name-clash', entry: entry.name, why };
    }
  }
  return undefined;
}

/**
 * The first reason `entries` cannot be extracted, or `undefined` when every entry may be. An
 * archive is extracted whole or not at all, so one offending entry refuses it:
 *
 * - an entry that is not a regular file or a directory — a symbolic link, a hard link, a device,
 *   a FIFO (`npm pack` and a skill ZIP hold none);
 * - a name that is absolute, begins with a drive letter, is a UNC path, holds a `..` segment or a
 *   NUL (a backslash is read as a separator on every host);
 * - two entries that are one name — exactly, or once folded as a case-insensitive or
 *   normalising volume folds them ({@link foldedSegment}) — or a file with another entry under it.
 *
 * @param entries - Every entry of the archive, in archive order
 * @returns The refusal of the first offending entry, in archive order
 */
export function archiveEntryRefusal(entries: readonly ArchiveEntry[]): EntryRefusal | undefined {
  const claims = new Map<string, Claim>();
  for (const entry of entries) {
    const refusal = entryRefusal(entry) ?? claimPlaces(entry, claims);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

/**
 * Refuse `archive` when its entries cannot all be extracted ({@link archiveEntryRefusal}).
 *
 * @param archive - What the operator named, for the message
 * @param entries - Every entry of the archive, in archive order
 * @throws ArchiveRefusedError naming the first offending entry
 */
export function assertArchiveExtractable(archive: string, entries: readonly ArchiveEntry[]): void {
  const refusal = archiveEntryRefusal(entries);
  if (refusal !== undefined) throw new ArchiveRefusedError(archive, refusal);
}
