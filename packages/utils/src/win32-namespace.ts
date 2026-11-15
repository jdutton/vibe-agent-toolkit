/**
 * The win32 namespace prefix Node may report a path with. A leaf that imports NOTHING, so the
 * errno table — itself a leaf, for the reason its header gives — can read every errno's path
 * through it, once.
 *
 * Module-internal to `utils`: no barrel and no subpath re-exports it; its two callers are the
 * errno table and the tree-change apply.
 */

const WIN32_NAMESPACE = String.raw`\\?` + '\\';
const WIN32_UNC_NAMESPACE = `${WIN32_NAMESPACE}UNC\\`;

/**
 * A path without the win32 namespace prefix Node may report it with. Under win32 Node hands the OS
 * a namespaced path (`\\?\C:\…`, `\\?\UNC\server\share\…`) and reports some paths back in
 * that form — the first directory a recursive `mkdir` made, an errno's `path` and `dest`. Held
 * against a plain `C:\…` path such a report reads as another root, and displayed it names
 * `//?/C:/…`. Pure and the same on every host; every other path is returned as it is.
 *
 * @param reported - A native path, as Node reported it
 * @returns The path in the spelling the caller's own paths have (native separators kept)
 *
 * @example
 * withoutWin32Namespace('\\\\?\\C:\\a') // 'C:\\a'
 * withoutWin32Namespace('\\\\?\\UNC\\host\\share') // '\\\\host\\share'
 */
export function withoutWin32Namespace(reported: string): string {
  // Matched on the NATIVE spelling, before any separator conversion: the prefix exists only there.
  if (reported.startsWith(WIN32_UNC_NAMESPACE)) return `\\\\${reported.slice(WIN32_UNC_NAMESPACE.length)}`;
  return reported.startsWith(WIN32_NAMESPACE) ? reported.slice(WIN32_NAMESPACE.length) : reported;
}
