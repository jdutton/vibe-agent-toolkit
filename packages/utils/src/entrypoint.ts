/**
 * The one answer to "am I the script Node was asked to run?"
 *
 * Lives here, in the package every other one already depends on, because there
 * has to be exactly one: the question was previously answered three different
 * ways across this monorepo (`import.meta.main`, a raw `pathToFileURL` string
 * compare, and this function), and two of those three answer `false` for the
 * script they guard — which makes the process exit 0 having run nothing.
 */

import { fileURLToPath } from 'node:url';

import { safePath, toForwardSlash } from './path-core.js';
import { normalizePath } from './path-utils.js';

/**
 * Was this module invoked as the process entrypoint, rather than imported?
 *
 * ⛔ **Do not reach for `import.meta.main` here.** It shipped in Node 24.2 and
 * 22.18; this repo declares a floor of `>=22.13.0`, and on a real 22.13.0 the
 * property is `undefined`:
 *
 * ```
 * $ node-v22.13.0 --input-type=module -e "console.log(import.meta.main)"  -> undefined
 * ```
 *
 * That is not a cosmetic gap. Every `if (import.meta.main)` guard in the
 * dev-tools package was silently dead on the declared floor — running
 * `validate-repo-structure.ts` under 22.13.0 printed nothing and exited 0, so a
 * contributor sitting exactly on the supported Node got a green pre-commit
 * structure gate that had run no rule at all. Raising the floor to 22.18 would
 * have hidden the defect behind the number instead of fixing it.
 *
 * ⛔ **Nor the raw string compare it replaced**, which was the other seven
 * guards in this repo:
 *
 * ```ts
 * import.meta.url === pathToFileURL(process.argv[1]).href   // ❌
 * ```
 *
 * A `node_modules/.bin` entry is a SYMLINK to the real script, so `argv[1]` is
 * the link and `import.meta.url` is the resolved target. The two strings differ
 * and the guard is false — measured false through a `.bin`-style symlink on both
 * Node 22.14.0 and 24.13.1, where this function is true.
 *
 * `process.argv[1]` is defined on every Node this repo supports, so the
 * comparison below is the portable form of the same question. The realpath pass
 * covers the case where the script is reached through a symlink on one side of
 * the comparison but not the other.
 *
 * `local/no-fragile-entrypoint-guard` (shipped on this package's `./eslint`
 * subpath) is what keeps either of the two banned spellings from coming back —
 * the prose comments that used to stand in for it did not.
 *
 * @param importMetaUrl - The calling module's `import.meta.url`
 * @param entryPath - The invoked script path; defaults to `process.argv[1]`
 * @returns `true` only when this module is the script Node was asked to run
 */
export function isEntrypoint(
  importMetaUrl: string,
  entryPath: string | undefined = process.argv[1],
): boolean {
  // An empty argv[1] would resolve to the cwd and could then match a module by
  // accident; `undefined` happens under `node -e`. Neither is an entrypoint.
  if (entryPath === undefined || entryPath === '') return false;

  const modulePath = safePath.resolve(fileURLToPath(importMetaUrl));
  const invokedPath = safePath.resolve(entryPath);
  if (modulePath === invokedPath) return true;

  // `normalizePath` resolves symlinks and Windows 8.3 short names, and returns
  // the path unchanged when it cannot — which is the right answer here, since
  // the string comparison above has already decided the two differ and an
  // unresolvable path carries no symlink information to compare.
  return toForwardSlash(normalizePath(modulePath)) === toForwardSlash(normalizePath(invokedPath));
}
