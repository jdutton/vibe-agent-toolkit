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
 * A path segment as a filesystem that folds names compares it: the stream suffix and trailing dots
 * and spaces cut (NTFS), decomposed, then case-folded UP and then down — NTFS compares upper-cased
 * names, so `ß` and `SS` are one name, and a dotless `ı` (U+0131) is `I` there, which lower-casing
 * alone leaves apart from `i`. The cut is made on every host, so a POSIX directory really named
 * `skills:notes` compares as `skills` too.
 *
 * STRICTER than any one volume, on purpose. The decomposition is by compatibility (NFKD), where
 * the volumes that normalise (APFS, HFS+) do so canonically: `x².md` and `x2.md` fold together
 * here and are two names everywhere. And the stream cut makes `10:00.log` and `10:30.log` one
 * name, which they are only on NTFS. A caller that refuses on equal folds over-refuses those, and
 * says which rule matched.
 *
 * @param segment - One path segment, never a path
 * @returns The segment's fold: equal for two names that are one entry on some volume
 */
export function foldedSegment(segment: string): string {
  return win32Name(segment).normalize('NFKD').toUpperCase().toLowerCase();
}
