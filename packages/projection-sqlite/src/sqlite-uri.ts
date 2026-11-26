/**
 * The URI SQLite opens a database file read-only by. Not `pathToFileURL`: it gives a Windows UNC
 * path an authority (`file://server/share/…`), which SQLite refuses; SQLite's form keeps the whole
 * path after an empty one (`file:////server/share/…`, `file:///C:/…`).
 */

import { toForwardSlashAnyPlatform } from '@vibe-agent-toolkit/utils/path';

/**
 * A SQLite URI for `path`, opened read-only (`mode=ro`). The path is percent-encoded as a URL path
 * (`%` first, so a literal one survives), which SQLite decodes.
 *
 * @param path - An absolute file path: POSIX, a Windows drive path, or a Windows UNC path
 * @returns The URI
 * @throws Error When `path` is not absolute: a URI cannot name a path relative to nothing
 */
export function readOnlyDatabaseUri(path: string): string {
  const forward = toForwardSlashAnyPlatform(path).replaceAll('%', '%25');
  const drive = /^[A-Za-z]:\//.test(forward);
  if (!forward.startsWith('/') && !drive) {
    throw new Error(`"${path}" is not an absolute path, so there is no file URI for SQLite to open.`);
  }
  // An empty authority, the whole path after it: a UNC path keeps its `//server` in the path.
  const uri = new URL('file:///');
  uri.pathname = drive ? `/${forward}` : forward;
  uri.searchParams.set('mode', 'ro');
  return uri.href;
}
