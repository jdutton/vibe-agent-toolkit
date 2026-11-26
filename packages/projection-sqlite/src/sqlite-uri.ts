/**
 * The URI SQLite opens a database file read-only by. Not `pathToFileURL`: it gives a Windows UNC
 * path an authority (`file://server/share/…`), which SQLite refuses; SQLite's form keeps the whole
 * path after an empty one (`file:////server/share/…`, `file:///C:/…`).
 */

import { toForwardSlashAnyPlatform } from '@vibe-agent-toolkit/utils/path';

/** A Windows path: a drive (`C:\` or `C:/`) or a UNC share (`\\server\share`). */
const WIN32_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * A SQLite URI for `path`, opened read-only (`mode=ro`). The path is percent-encoded as a URL path
 * (`%` first, so a literal one survives), which SQLite decodes. A Windows path is forward-slashed;
 * any other keeps its backslashes, a filename character on POSIX.
 *
 * @param path - An absolute file path: POSIX, a Windows drive path, or a Windows UNC path
 * @returns The URI
 * @throws Error When `path` is not absolute: a URI cannot name a path relative to nothing
 */
export function readOnlyDatabaseUri(path: string): string {
  const win32 = WIN32_PATH.test(path);
  if (!win32 && !path.startsWith('/')) {
    throw new Error(`"${path}" is not an absolute path, so there is no file URI for SQLite to open.`);
  }
  // A backslash left (POSIX) is encoded: the URL parser would read it as a separator.
  const forward = (win32 ? toForwardSlashAnyPlatform(path) : path).replaceAll('%', '%25').replaceAll('\\', '%5C');
  // An empty authority, the whole path after it: a UNC path keeps its `//server` in the path.
  const uri = new URL('file:///');
  uri.pathname = forward.startsWith('/') ? forward : `/${forward}`;
  uri.searchParams.set('mode', 'ro');
  return uri.href;
}
