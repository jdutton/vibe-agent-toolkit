/**
 * Pure string helpers for glob pattern analysis.
 *
 * No filesystem access. These are building blocks for higher-level glob
 * expansion utilities. Glob patterns always use forward slashes by convention —
 * this module treats `/` as the only path separator (never `\`).
 *
 * ### Escape semantics
 * A backslash immediately preceding a metachar (`*`, `?`, `[`) neutralises it.
 * Any other backslash is left as-is. The algorithm scans left-to-right and
 * sets an `escaped` flag when it sees `\`; the *next* character is skipped for
 * magic detection if `escaped` is true.
 */

import { toForwardSlash } from '../path-utils.js';

/** The glob metacharacters recognised by this module. */
const MAGIC_CHARS = new Set(['*', '?', '[']);

/** Sentinel returned by {@link staticGlobBase} when the first segment is magic. */
const DOT = '.';

/**
 * Returns `true` iff `source` contains at least one unescaped glob metachar
 * (`*`, `?`, `[`). A backslash immediately before a metachar escapes it.
 *
 * @example
 * isGlob('a/b/*.mjs')    // true  — unescaped *
 * isGlob('packs/**\/*')  // true  — unescaped **
 * isGlob('x?.txt')       // true  — unescaped ?
 * isGlob('files[1].txt') // true  — unescaped [
 * isGlob('foo\\*.txt')   // false — * is backslash-escaped
 * isGlob('foo/bar.txt')  // false — no metachar
 */
export function isGlob(source: string): boolean {
  let escaped = false;
  for (const ch of source) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (MAGIC_CHARS.has(ch)) {
      return true;
    }
  }
  return false;
}

/**
 * The longest leading path prefix of `pattern` that contains no glob magic —
 * i.e. the static directory base suitable as a `cwd` for a glob runner.
 *
 * Algorithm:
 * 1. Split pattern on `/` (glob patterns always use forward slashes).
 * 2. Accumulate segments until (and **excluding**) the first magic segment.
 * 3. Join accumulated segments with `/`.
 * 4. If the very first segment is magic → return `'.'`.
 * 5. If the joined base is empty but the pattern is absolute (leading `/`,
 *    first real segment magic, e.g. `'/*.mjs'`) → return the root `'/'`.
 * 6. If NO segment is magic (not a glob at all) → return the whole pattern.
 *
 * Output always uses forward slashes (pure string ops, no `node:path`).
 *
 * @example
 * staticGlobBase('modules/packs/**\/*')    // 'modules/packs'
 * staticGlobBase('a/b/*.mjs')              // 'a/b'
 * staticGlobBase('*.mjs')                  // '.'
 * staticGlobBase('/*.mjs')                 // '/'   (absolute root, not '')
 * staticGlobBase('../mycli/dist/*.mjs')    // '../mycli/dist'
 * staticGlobBase('foo/bar.txt')            // 'foo/bar.txt'
 */
export function staticGlobBase(pattern: string): string {
  // Glob patterns are always forward-slash; toForwardSlash() satisfies the
  // no-hardcoded-path-split lint rule while being a no-op in practice.
  const normalized = toForwardSlash(pattern);
  const segments = normalized.split('/');
  const staticSegments: string[] = [];

  for (const segment of segments) {
    if (isGlob(segment)) {
      break;
    }
    staticSegments.push(segment);
  }

  if (staticSegments.length === 0) {
    return DOT;
  }
  if (staticSegments.length === segments.length) {
    // No magic found — return the whole (normalized) pattern unchanged.
    return normalized;
  }

  const joined = staticSegments.join('/');
  if (joined === '') {
    // Every static segment was empty — the only static prefix is a leading
    // slash (e.g. '/*.mjs' → segments ['', '*.mjs']). A glob runner handed
    // cwd:'' misbehaves; the correct base is the absolute root '/' for an
    // absolute pattern, '.' otherwise (defensive — relative-first-magic is
    // already handled by the length-0 guard above).
    return normalized.startsWith('/') ? '/' : DOT;
  }
  return joined;
}

/**
 * The sub-pattern remaining after stripping the static base, with no leading
 * `/`. This is the pattern to pass to a glob runner with `cwd` set to the base.
 *
 * Only meaningful when `isGlob(pattern)` is true — for a non-glob input the
 * return value is `''` (the whole pattern was consumed as the base).
 *
 * @example
 * globMagicRemainder('modules/packs/**\/*')   // '**\/*'
 * globMagicRemainder('a/b/*.mjs')             // '*.mjs'
 * globMagicRemainder('*.mjs')                 // '*.mjs'
 * globMagicRemainder('../mycli/dist/*.mjs')   // '*.mjs'
 */
export function globMagicRemainder(pattern: string): string {
  const forward = toForwardSlash(pattern);
  const base = staticGlobBase(pattern);
  if (base === DOT) {
    // First segment was magic — the remainder is the full (forward-slash) pattern.
    return forward;
  }
  if (base === forward) {
    // No magic at all — degenerate case: remainder is empty.
    return '';
  }
  if (base === '/') {
    // Absolute-root base ('/*.mjs'): the leading slash IS the base, so strip
    // just that one char (there is no separator between base and remainder).
    return forward.slice(1);
  }
  // Strip the base prefix and the trailing '/' separator.
  return forward.slice(base.length + 1);
}
