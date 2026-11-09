/**
 * One path segment as the strictest volume VAT writes onto compares it. Pure.
 *
 * Two segments with one fold are ONE entry on some volume, so a set of names holding both lands
 * differently depending on where it is written — an archive's entry list and a plugin's `files:`
 * destinations are both judged by it.
 */

/**
 * A name segment as Win32 keeps it: cut at its first `:` (on NTFS what follows names a stream of
 * the file before it — `skills::$INDEX_ALLOCATION` is the directory `skills`), then without its
 * trailing dots and spaces, which Win32 drops from a name.
 */
function win32Name(segment: string): string {
  const colon = segment.indexOf(':');
  const name = colon === -1 ? segment : segment.slice(0, colon);
  let end = name.length;
  while (end > 0 && (name[end - 1] === '.' || name[end - 1] === ' ')) end -= 1;
  return name.slice(0, end);
}

/**
 * The code points HFS+ ignores when it compares two names, so `.g` + U+200C + `it` IS `.git` there:
 * the zero-width joiners, the directional marks and embeddings, the deprecated format characters
 * and the byte-order mark.
 *
 * @vendor-claim reviewed=2026-11-08 verify=Re-read `next_hfs_char` in https://github.com/git/git/blob/master/utf8.c — the "these code points are ignored completely" switch — and diff its cases against this list
 */
const HFS_IGNORED_CODE_POINTS: ReadonlySet<number> = new Set([
  0x200c, 0x200d, 0x200e, 0x200f, // zero-width non-joiner and joiner, left-to-right and right-to-left marks
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // directional embeddings, pop and overrides
  0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f, // the deprecated format characters
  0xfeff, // zero-width no-break space (the byte-order mark)
]);

/** `segment` without the code points HFS+ ignores in a name. */
function withoutHfsIgnored(segment: string): string {
  return [...segment].filter((character) => !HFS_IGNORED_CODE_POINTS.has(character.codePointAt(0) ?? 0)).join('');
}

/**
 * A path segment as a filesystem that folds names compares it: the code points HFS+ ignores
 * dropped, the stream suffix and trailing dots and spaces cut (NTFS), decomposed, then case-folded
 * UP and then down — NTFS compares upper-cased names, so `ß` and `SS` are one name, and a dotless
 * `ı` (U+0131) is `I` there, which lower-casing alone leaves apart from `i`. The drop comes first,
 * so a trailing dot an ignored code point hid is cut too. Both are made on every host, so a POSIX
 * directory really named `skills:notes` compares as `skills` too.
 *
 * STRICTER than any one volume, on purpose. The decomposition is by compatibility (NFKD), where
 * the volumes that normalise (APFS, HFS+) do so canonically: `x².md` and `x2.md` fold together
 * here and are two names everywhere. And the stream cut makes `10:00.log` and `10:30.log` one
 * name, which they are only on NTFS; the drop makes `a` + U+200C + `b` and `ab` one, which they
 * are only on HFS+. A caller that refuses on equal folds over-refuses those, and says which rule
 * matched.
 *
 * @param segment - One path segment, never a path
 * @returns The segment's fold: equal for two names that are one entry on some volume
 */
export function foldedSegment(segment: string): string {
  return win32Name(withoutHfsIgnored(segment)).normalize('NFKD').toUpperCase().toLowerCase();
}
