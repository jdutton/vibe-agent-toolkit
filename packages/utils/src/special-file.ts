/**
 * The one special-file policy: what a read does with an entry that is not a
 * regular file. Internal, and off the barrel: `openForReading` and the
 * tree-change walk both judge by it, so a named pipe is refused the same way
 * whether one file is read or a whole tree is.
 */

/** An OS errno (BSD's "inappropriate file type"), not a VAT code: the shape every errno predicate reads. */
const NOT_A_REGULAR_FILE_ERRNO = 'EFTYPE';

/**
 * Refuse, before reading a byte, something that is not a regular file: a named
 * pipe, socket or device has no content to read, only a stream that may never
 * end. It is an `EFTYPE` errno ("inappropriate file type"), so every caller's
 * own environmental-refusal convention codes it. A directory is left to the
 * read, which raises the OS's own `EISDIR`.
 */
export function refuseSpecialFile(stats: { isFile(): boolean; isDirectory(): boolean }, filePath: string): void {
  if (stats.isFile() || stats.isDirectory()) return;
  throw Object.assign(
    new Error(`${NOT_A_REGULAR_FILE_ERRNO}: not a regular file (a named pipe, socket or device), refused unread: ${filePath}`),
    { code: NOT_A_REGULAR_FILE_ERRNO, path: filePath, syscall: 'open' },
  );
}
