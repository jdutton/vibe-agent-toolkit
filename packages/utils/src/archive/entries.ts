/**
 * What an archive holds, and the ONE policy for which archives VAT extracts — decided from the
 * entry list alone, before anything is written. Pure: nothing here reads or writes.
 */

import { isVatError, VatError } from '../errors/vat-error.js';
import { foldedSegment } from '../name-fold.js';
import { hasParentTraversalSegment, toForwardSlashAnyPlatform } from '../path-core.js';

/** The archive formats VAT reads: a ZIP, or a tar stream (gzipped or plain). */
export type ArchiveFormat = 'zip' | 'tar';

/** What one entry of an archive is. `other` is a device, a FIFO, a socket or a type VAT does not know. */
export type ArchiveEntryKind = 'file' | 'directory' | 'link' | 'hardlink' | 'other';

/** One entry of an archive, as the archive spells it. */
export interface ArchiveEntry {
  /** The entry's name as the archive spells it, every backslash read as `/` ({@link entryNameOf}). */
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
 * - `unreadable`: its bytes are no archive of the format;
 * - `unsupported`: it IS an archive, and one VAT will not take — a ZIP64 ZIP, an end record or
 *   directory two readers would read differently, or a tarball cut short inside an entry
 *   (`entry` names it). Never passed on by any lane, where `unreadable` bytes may be. One entry
 *   that does not inflate or hold what it declares, asked for after the archive opened, is
 *   {@link ArchiveEntryReadError} instead;
 * - `link`, `hardlink`, `special`: it holds an entry that is not a file or a directory;
 * - `unsafe-name`: an entry is named outside the directory it is extracted into;
 * - `name-clash`: two entries are one name, or one is a file with another at or under it;
 * - `too-many-entries`, `too-large`: it is past an {@link ArchiveLimits} bound.
 */
export type ArchiveRefusalReason = 'unreadable' | 'unsupported' | 'link' | 'hardlink' | 'special' | 'unsafe-name' | 'name-clash' | 'too-many-entries' | 'too-large';

/** The sentence every archive refusal is: the archive named, then why. */
function refusalMessage(archive: string, why: string): string {
  return `${archive} is not an archive VAT accepts, nothing was changed: ${why}`;
}

/** An archive VAT will not read, extract or pass on: the input's refusal, never the run's. */
export class ArchiveRefusedError extends VatError {
  readonly reason: ArchiveRefusalReason;
  /**
   * The entry the refusal is about, as the archive spells it: the first offending one for a
   * `link`, `hardlink`, `special`, `unsafe-name` or `name-clash`, and the cut-short entry of an
   * `unsupported` tarball — the archive is refused as a whole all the same. None when no one entry
   * is to blame (`unreadable`, a limit, a ZIP structure two readers would read differently).
   */
  readonly entry: string | undefined;

  /**
   * @param archive - What the operator named: the archive's path or URL
   * @param refusal - Why, and the entry it is about
   */
  constructor(archive: string, refusal: { readonly reason: ArchiveRefusalReason; readonly entry?: string; readonly why: string }, options?: ErrorOptions) {
    super(ARCHIVE_REFUSED_CODE, refusalMessage(archive, refusal.why), options);
    this.reason = refusal.reason;
    this.entry = refusal.entry;
  }
}

/** The code of every {@link ArchiveEntryReadError}. */
export const ARCHIVE_ENTRY_UNREADABLE_CODE = 'ARCHIVE_ENTRY_UNREADABLE';

/**
 * The refusal of ONE entry an opened archive was asked to read: it does not inflate, or does not
 * hold what it declares. Its own code ({@link ARCHIVE_ENTRY_UNREADABLE_CODE}), so a lane that may
 * skip one member tells it from every refusal of the whole archive by
 * {@link isArchiveEntryReadRefusal} — the brand and the code, never the prototype chain and never
 * whether an `entry` happens to be set (a clash, a link and a cut-short tarball name one too).
 */
export class ArchiveEntryReadError extends VatError {
  readonly entry: string;

  /**
   * @param archive - What the operator named: the archive's path or URL
   * @param entry - The entry, as the archive spells it
   * @param what - What is wrong with it, completing "its entry `x` …"
   */
  constructor(archive: string, entry: string, what: string, options?: ErrorOptions) {
    super(ARCHIVE_ENTRY_UNREADABLE_CODE, refusalMessage(archive, `its entry \`${entry}\` ${what}`), options);
    this.entry = entry;
  }
}

/**
 * Whether `error` is the archive module refusing one entry's read ({@link ArchiveEntryReadError}):
 * by the brand and {@link ARCHIVE_ENTRY_UNREADABLE_CODE}, so a `dist` copy of the class answers as a
 * `src` one does.
 */
export function isArchiveEntryReadRefusal(error: unknown): error is ArchiveEntryReadError {
  return isVatError(error, ARCHIVE_ENTRY_UNREADABLE_CODE);
}

/** A refusal before it names its archive: what {@link archiveEntryRefusal} answers. */
export interface EntryRefusal {
  readonly reason: ArchiveRefusalReason;
  readonly entry: string;
  readonly why: string;
}

/**
 * An entry's name as both readers hand it on, on every host: the archive's spelling with every
 * backslash read as `/` — the separator VAT reads it as everywhere, in a tarball as in a ZIP. The
 * tar library already does this on win32, and only there; doing it here for both formats on every
 * host keeps one listing, so a refusal names an entry the same way wherever VAT runs.
 *
 * @param spelled - The name as the format's library decoded it
 * @returns The name with forward slashes
 */
export function entryNameOf(spelled: string): string {
  return toForwardSlashAnyPlatform(spelled);
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

/**
 * A Windows device name, whatever follows it after a `.` and whatever its case: `CON`, `prn.txt`,
 * `Aux.tar.gz` (Microsoft: "NUL.txt and NUL.tar.gz are both equivalent to NUL"), `COM1`…`COM9`,
 * `LPT1`…`LPT9`, and the superscript-digit forms `COM¹` `LPT³`, which Windows reads as digits. A
 * space before the `.` is over-refused on purpose: Win32 drops it, so `con .md` may be `CON`.
 *
 * @vendor-claim reviewed=2026-10-26 verify=Re-read https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file — "File and Directory Names", the reserved-names list (item 9) and the trailing space or period rule (item 10)
 */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i;

/**
 * The other characters Windows reserves in a name (item 1 of the same page): `<` `>` `"` `|` `?`
 * `*`, and the code points 1–31. (NUL, code point 0, has its own refusal; `/` and `\` are
 * separators; `:` has its own reason.)
 */
const WINDOWS_RESERVED_CHARACTERS: ReadonlySet<string> = new Set(['<', '>', '"', '|', '?', '*', ...Array.from({ length: 31 }, (_unused, index) => String.fromCodePoint(index + 1))]);

/**
 * Why one segment of a name is one Windows cannot hold as spelled, or `undefined`. Refused on EVERY
 * host, so one archive has one verdict wherever VAT runs: on NTFS a `:` names a stream of the file
 * before it (`notes:v2.md` writes into `notes`), a reserved character cannot be written at all, a
 * device name opens the device, and a trailing `.` or space is dropped from the name a Win32 tool sees.
 */
function windowsSegmentReason(segment: string): string | undefined {
  if (segment.includes(':')) return 'holds a `:`, which on NTFS names a stream of the file before it';
  if ([...segment].some((character) => WINDOWS_RESERVED_CHARACTERS.has(character))) return 'holds a character Windows does not allow in a name (`<` `>` `"` `|` `?` `*`, or a control character)';
  if (segment.endsWith('.') || segment.endsWith(' ')) return 'ends in a `.` or a space, which Windows drops from a name';
  return WINDOWS_DEVICE_NAME.test(segment) ? 'is a Windows device name' : undefined;
}

/** Why `name` would land outside the extraction directory, or somewhere other than it says, on some host; or `undefined`. */
function unsafeNameReason(name: string): string | undefined {
  if (name.includes('\0')) return 'holds a NUL character';
  const spelled = toForwardSlashAnyPlatform(name);
  if (spelled.startsWith('/')) return 'is an absolute path';
  if (DRIVE_PREFIX.test(spelled)) return 'begins with a drive letter';
  if (hasParentTraversalSegment(name)) return 'holds a `..` segment';
  for (const segment of placeOf(name)) {
    const reason = windowsSegmentReason(segment);
    if (reason !== undefined) return reason;
  }
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
  if (unsafe !== undefined) return { reason: 'unsafe-name', entry: entry.name, why: `its entry \`${entry.name}\` ${unsafe}, so it names no place inside the archive that every host can write` };
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
    const key = segments.map((segment) => foldedSegment(segment)).join('/');
    const spelled = segments.join('/');
    const held = claims.get(key);
    if (held === undefined) {
      claims.set(key, { spelled, kind, entry: entry.name });
    } else if (held.spelled !== spelled) {
      // A `:` and a trailing dot or space were refused with the name, so only the case and Unicode folds are left.
      return {
        reason: 'name-clash',
        entry: entry.name,
        why: `its entries \`${held.entry}\` and \`${entry.name}\` are one name where a volume folds letter case or Unicode form (\`${held.spelled}\` and \`${spelled}\`), so one would overwrite the other`,
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
 *   NUL (a backslash is read as a separator on every host); or one with a segment Windows cannot
 *   hold as spelled — a `:`, one of `<` `>` `"` `|` `?` `*`, a control character (code points
 *   1–31), a trailing `.` or space, a device name (`CON`, `com1.txt`) — on every host;
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
