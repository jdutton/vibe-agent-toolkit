/**
 * git's `strerror` text → errno. The one place a line of git's stderr becomes an
 * errno, so the classifier (`fsFaultOf`) can judge it like any `node:fs` error.
 * This module PARSES text into errnos; it classifies nothing.
 */

/**
 * C-locale `strerror` text → errno, for the reasons git can print here.
 *
 * git does not print the errno name, only its message; every listing in `git-utils.ts`
 * runs with `LC_ALL=C` so the message is the C-locale one and this table can
 * be short. An unlisted reason is still a refusal — it becomes `UNKNOWN`, the
 * same answer `listingFailure` gives an error carrying no errno — because
 * dropping the line would reinstate the silent gap for exactly the errnos
 * nobody thought of.
 *
 * The two ABSENCE reasons are listed so that `listingFailure` — the one owner
 * of the absent/unreadable split — can recognise them and the line can be
 * skipped: git prints "No such file or directory" for an untracked directory
 * deleted between its parent's `readdir` and its own `opendir` (a concurrent
 * `rm -rf tmp/`), and the walk route treats that same race as "no longer in
 * the population" rather than as a refusal. Left unmapped it read as an
 * `UNKNOWN` refusal, and the git route aborted a run the walk completed.
 */
const ERRNO_BY_STRERROR: ReadonlyMap<string, string> = new Map([
  ['Permission denied', 'EACCES'],
  ['Too many open files', 'EMFILE'],
  ['Too many open files in system', 'ENFILE'],
  ['Too many levels of symbolic links', 'ELOOP'],
  ['Resource temporarily unavailable', 'EAGAIN'],
  ['Input/output error', 'EIO'],
  ['Stale file handle', 'ESTALE'],
  ['Stale NFS file handle', 'ESTALE'],
  ['No such file or directory', 'ENOENT'],
  ['Not a directory', 'ENOTDIR'],
]);

/**
 * The errno git's C-locale `strerror` text names, or `undefined` for a reason
 * this table does not know.
 *
 * @param reason - The text after the colon on git's `could not open directory` line
 */
export function errnoForGitReason(reason: string): string | undefined {
  return ERRNO_BY_STRERROR.get(reason);
}
