/**
 * Internal utility functions for the resources package.
 * These are not exported from the public API.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  toForwardSlash,
  safePath,
  realpathFrom,
  type RealpathTable,
} from '@vibe-agent-toolkit/utils';
import picomatch from 'picomatch';

/**
 * The root a `ValidationIssue.location` is expressed against when the caller
 * did not supply one.
 *
 * `location` is contractually project-relative, so "no root" is not an option —
 * something has to be chosen. The process CWD is the honest default for a
 * library entry point invoked without a project: it is the directory the paths
 * a user would type are relative to. Every VAT-internal caller passes a real
 * root, so this only ever applies to direct library consumers.
 */
export function locationRoot(projectRoot: string | undefined): string {
  return projectRoot ?? process.cwd();
}

/**
 * Check if a file path matches a glob pattern.
 *
 * Uses picomatch with Unix-style paths for cross-platform compatibility.
 * Implements two matching strategies:
 * 1. matchBase for simple filename patterns
 * 2. Segment-based matching for directory patterns
 *
 * @param filePath - File path to match (will be normalized to Unix-style)
 * @param pattern - Glob pattern to match against
 * @returns True if the path matches the pattern
 *
 * @example
 * ```typescript
 * matchesGlobPattern('/project/docs/README.md', 'docs/**')  // true
 * matchesGlobPattern('/project/src/index.ts', '*.md')       // false
 * ```
 */
export function matchesGlobPattern(filePath: string, pattern: string): boolean {
  const matcherWithBase = picomatch(pattern, { matchBase: true });
  const matcher = picomatch(pattern);
  const unixPath = toForwardSlash(filePath);

  // Strategy 1: Try with matchBase for simple filename matching
  if (matcherWithBase(unixPath)) {
    return true;
  }

  // Strategy 2: For directory patterns, try matching against path segments
  const segments = unixPath.split('/');
  for (let i = Math.min(10, segments.length); i > 0; i--) {
    const partialPath = segments.slice(-i).join('/');
    if (matcher(partialPath)) {
      return true;
    }
  }

  return false;
}

/**
 * Split an href into file path and anchor parts.
 *
 * @param href - The href to split (e.g., "./file.md#anchor")
 * @returns Tuple of [filePath, anchor], where anchor is undefined if no anchor exists
 *
 * @example
 * ```typescript
 * splitHrefAnchor('./file.md#heading')  // ['./file.md', 'heading']
 * splitHrefAnchor('./file.md')          // ['./file.md', undefined]
 * ```
 */
export function splitHrefAnchor(href: string): [string, string | undefined] {
  const anchorIndex = href.indexOf('#');
  if (anchorIndex === -1) {
    return [href, undefined];
  }

  const filePath = href.slice(0, anchorIndex);
  const anchor = href.slice(anchorIndex + 1);
  return [filePath, anchor];
}

/**
 * Discriminated union returned by {@link resolveLocalHref}.
 *
 * - `anchor_only` — the href was `#fragment` only (no file component).
 * - `resolved` — the href resolved to an absolute filesystem path.
 * - `absolute_no_root` — the href is an RFC 3986 §4.2 absolute-path
 *   reference (starts with `/`) but no `projectRoot` was supplied.
 * - `absolute_escapes_root` — the absolute-path reference resolved to a
 *   location outside `projectRoot` (e.g., via `..` traversal or a symlink
 *   pointing outside the project).
 */
export type ResolveLocalHrefResult =
  | { kind: 'anchor_only' }
  | { kind: 'resolved'; resolvedPath: string; anchor: string | undefined }
  | { kind: 'absolute_no_root'; href: string; anchor: string | undefined }
  | { kind: 'absolute_escapes_root'; href: string; anchor: string | undefined };

/**
 * Resolve a markdown link href to a filesystem path or a typed failure.
 *
 * Performs the standard href → path conversion used by both audit and validate:
 * 1. Strips anchor fragment (`#section`)
 * 2. Decodes URL-encoded characters (`%20` → space, `%26` → `&`)
 * 3. Resolves the path:
 *    - Leading `/` (RFC 3986 §4.2 absolute-path reference) → resolve against
 *      `projectRoot`. Requires a `projectRoot`; must not escape it.
 *    - Otherwise → resolve relative to the source file's directory.
 *
 * @param href - Raw href from a markdown link
 * @param sourceFilePath - Absolute path of the file containing the link
 * @param projectRoot - Optional project root for absolute-path references.
 * @returns A {@link ResolveLocalHrefResult} discriminating success vs failure modes.
 *
 * @example
 * ```typescript
 * resolveLocalHref('My%20Folder/doc.md#intro', '/project/README.md')
 * // { kind: 'resolved', resolvedPath: '/project/My Folder/doc.md', anchor: 'intro' }
 *
 * resolveLocalHref('#heading', '/project/README.md')
 * // { kind: 'anchor_only' }
 *
 * resolveLocalHref('/docs/foo.md', '/project/docs/sub/page.md', '/project')
 * // { kind: 'resolved', resolvedPath: '/project/docs/foo.md', anchor: undefined }
 * ```
 */
export function resolveLocalHref(
  href: string,
  sourceFilePath: string,
  projectRoot?: string,
): ResolveLocalHrefResult {
  const [fileHref, anchor] = splitHrefAnchor(href);
  if (fileHref === '') {
    return { kind: 'anchor_only' };
  }

  let decodedHref: string;
  try {
    decodedHref = decodeURIComponent(fileHref);
  } catch {
    decodedHref = fileHref;
  }

  // RFC 3986 §4.2 absolute-path reference — resolve against projectRoot.
  if (decodedHref.startsWith('/')) {
    if (!projectRoot) {
      return { kind: 'absolute_no_root', href: fileHref, anchor };
    }
    const candidate = safePath.resolve(projectRoot, decodedHref.slice(1));
    if (!isWithinProject(candidate, projectRoot)) {
      return { kind: 'absolute_escapes_root', href: fileHref, anchor };
    }
    return { kind: 'resolved', resolvedPath: candidate, anchor };
  }

  // Relative reference — resolve against the source file's directory.
  const sourceDir = path.dirname(sourceFilePath);
  const resolvedPath = safePath.resolve(sourceDir, decodedHref);
  return { kind: 'resolved', resolvedPath, anchor };
}

/**
 * The containment rule itself: is `normalizedFile` at or under `normalizedRoot`?
 *
 * Pure — **both arguments must already be canonical and forward-slashed**; this
 * normalizes nothing and touches no filesystem. The parameter names say so, and
 * are also what satisfies the `local/no-path-startswith` rule: the guarantee it
 * enforces is discharged by the two callers below, which canonicalize through
 * `toForwardSlash` (`canonicalizeSync`) or read an already-forward-slashed row
 * out of the filled table (`realpathFrom`).
 *
 * It exists so the two `isWithinProject*` forms share **one** definition of
 * containment. Two copies of the `startsWith(root + '/') || === root` pair would
 * be free to drift, and a drift here silently changes which links are reported
 * as gitignored leaks.
 */
function isUnderRoot(normalizedFile: string, normalizedRoot: string): boolean {
  // The trailing slash prevents false positives like `/project-other` reading
  // as being inside `/project`.
  return normalizedFile.startsWith(normalizedRoot + '/') || normalizedFile === normalizedRoot;
}

/**
 * Canonicalize one path synchronously. A path that cannot be canonicalized is
 * answered from its **deepest existing ancestor** — that ancestor's realpath with
 * the missing remainder re-appended — because a path that does not exist has no
 * realpath and a caller comparing paths still needs an answer.
 *
 * ⚠️ **The fallback has to land in the same NAMESPACE as the success path, and a
 * lexical `safePath.resolve()` does not.** Every consumer here compares one
 * canonical path against another, so where the root traverses a symlink — macOS
 * `/tmp → /private/tmp`, a bind mount, a worktree under a symlinked path — the
 * lexical answer keeps the link's spelling while the root gains the target's, and
 * the comparison is nonsense. It was user-visible: a merely BROKEN root-absolute
 * markdown link came back as *escaping the project*. `FsLookupCache.realpath` in
 * `packages/utils/src/fs-utils.ts` carries the measured truth table; this is its
 * synchronous twin.
 *
 * The walk widens containment nowhere, because the deepest existing ancestor is
 * exactly where an escaping directory symlink lives — a missing file behind one
 * still canonicalizes outside the root. Errno is deliberately not inspected:
 * EACCES on an existing file and ELOOP on a cycle land in the same catch as
 * ENOENT, and the ancestor's namespace beats the lexical answer for all three.
 *
 * **The fixpoint guard is mandatory.** `path.dirname` is idempotent at a
 * filesystem root (`'/'` on posix, `'C:/'` for a drive, `'//server/share/'` for a
 * UNC share), so without it the walk never terminates — it fails by hanging, not
 * by asserting.
 *
 * ⚠️ **Answers byte for byte what `FsLookupCache.realpath` answers, and that
 * equivalence is what makes {@link isWithinProject} and
 * {@link isWithinProjectFrom} interchangeable.** The reason is a deliberate
 * choice on the async side, not an accident of shape: **Node ships two different
 * realpaths and they do not agree.** `fs.realpathSync` (used here) and the
 * `fs.realpath` *callback* form run Node's own JS implementation — an
 * lstat/readlink walk that preserves the casing the caller asked for.
 * `fs/promises.realpath` and `fs.realpath.native` call `uv_fs_realpath`, which
 * reports the casing **on disk**. On a case-insensitive filesystem — macOS and
 * Windows — those are different strings, so a column filled through the native
 * route flips containment verdicts against this function and emits findings the
 * un-refactored code never emitted. `FsLookupCache.realpath` therefore
 * canonicalizes with `promisify(nodeFs.realpath)` **on purpose**; its docblock in
 * `packages/utils/src/fs-utils.ts` carries the measured three-way comparison and
 * names the test that pins it.
 *
 * Secondary observation, and explicitly NOT the argument: the *fallback*
 * branches agree too — both compose the deepest existing ancestor's canonical
 * path with the missing remainder, and `safePath.join` associates, so this
 * function's single join answers what the async form's per-level recursion does.
 * Comparing only the fallbacks and assuming the success paths were the same
 * function is exactly how the native-route divergence above shipped green. The
 * success paths are where this equivalence has to be argued.
 *
 * Change either form and you must change the other, or the filled column and the
 * live syscall start answering differently.
 *
 * Exported **only so that equivalence can be asserted on the string itself**.
 * Every other consumer reaches this function through a boolean containment
 * verdict, and a verdict cannot observe the remainder: a walk that re-appended
 * nothing answers the same `true`/`false` on every fixture that can be built,
 * because dropping components off a path's tail never moves it across a root
 * boundary. `src/index.ts` does not re-export it, so the package's public API is
 * unchanged.
 */
export function canonicalizeSync(filePath: string): string {
  // Resolve up front so the walk only ever sees absolute, `..`-free paths.
  // Costs nothing: Node's `fs.realpathSync` opens with the same `path.resolve`.
  const absolutePath = safePath.resolve(filePath);
  // Components peeled off so far, nearest-the-root first — re-appended to
  // whichever ancestor finally canonicalizes.
  const missingRemainder: string[] = [];
  let candidate = absolutePath;

  for (;;) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- candidate derives from the validated path parameter
      return safePath.join(toForwardSlash(fs.realpathSync(candidate)), ...missingRemainder);
    } catch {
      const parent = toForwardSlash(path.dirname(candidate));
      // Fixpoint at a filesystem root, where `dirname` returns its own input.
      // Nothing left to walk, and nothing on the path resolved, so the lexical
      // form is the right answer — and the only one available.
      if (parent === candidate) return absolutePath;

      missingRemainder.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

/**
 * Check if a file path is within a project directory — **the fill-pass form: it
 * costs two `fs.realpathSync`, one of them on the run-constant project root.**
 *
 * Canonicalizes both sides symmetrically before comparing. Asymmetric handling
 * (realpath one side, resolve the other) false-flags legitimate matches when
 * `projectRoot` traverses a symlink — e.g. macOS /tmp → /private/tmp, bind
 * mounts.
 *
 * ⚠️ **Judgement-time callers must use {@link isWithinProjectFrom} instead.**
 * This form is for the fill pass, where I/O is legal — today that means
 * {@link resolveLocalHref}'s absolute-path branch, which cannot be made
 * table-driven: the candidate path it asks about is derived by the resolution
 * itself, so no fill can know it in advance. Calling this from the judge is the
 * per-link syscall the realpath column exists to remove.
 *
 * ⚠️ **It canonicalizes the run-constant project root once per call, and no
 * caller hoists it.** Measured on the crucible adopter (`vat audit .` over a
 * ~1,500-document corpus, 2026-08-09): 1,231 `realpathSync` calls on the project
 * root string, **one** distinct value, 100% of them attributed to
 * `canonicalizeSync ← isWithinProject ← resolveLocalHref` — 834 under
 * `ResourceRegistry.resolveRelativeLinkPath`, 397 under `walk-link-graph`'s
 * `resolveHrefToPath`. So 1,230 of the 1,231 are redundant: ≈17 ms of a ≈13 s
 * run at ≈14 µs/call, and ≈0.1 ms on VAT's own corpus (8 calls).
 *
 * **The hoist does not belong in this file.** Both hot callers loop over links
 * holding one fixed root, so the fix is to canonicalize once per loop and pass
 * the canonical root down — a signature change to `resolveLocalHref` across two
 * packages. Two shortcuts that would have stayed inside this file were measured
 * and rejected: a module-level memo of the root (process-lifetime hidden state
 * in the one function obliged to answer byte for byte what
 * `FsLookupCache.realpath` answers), and skipping the root's realpath whenever
 * the canonical file already sits lexically under the RAW root (sound only while
 * `realpathSync` SUCCEEDS on the file, so it flips the missing-file row below,
 * and it rests on a prefix-of-a-realpath-is-its-own-realpath theorem that holds
 * on macOS but cannot be pinned on Windows from here). A hoist reuses the very
 * same canonical root, so it preserves every row; either shortcut does not.
 *
 * ⚠️ **A path that does not exist is canonicalized from its deepest existing
 * ancestor, not lexically** — see {@link canonicalizeSync}. Reaching the root
 * through a symlink used to flip this answer: an EXISTING file under a
 * `link → real` root was `true`, the same file MISSING was `false`, and missing
 * under the real root was `true`, so `resolveLocalHref('/docs/gone.md', …)`
 * reported `absolute_escapes_root` for a merely-broken link. The ancestor walk
 * puts both sides in one namespace and the middle row is now `true` like the
 * other two. Containment is not widened by it: a missing file behind a directory
 * symlink that leaves the root is still outside, because the ancestor the walk
 * lands on IS that escaping link.
 *
 * @param filePath - Absolute path to check
 * @param projectRoot - Absolute path to project root
 * @returns True if filePath is under projectRoot (after symlink resolution)
 *
 * @example
 * ```typescript
 * isWithinProject('/project/docs/guide.md', '/project')  // true
 * isWithinProject('/external/data.md', '/project')       // false
 * isWithinProject('/project/link', '/project')           // depends on symlink target
 * ```
 */
export function isWithinProject(filePath: string, projectRoot: string): boolean {
  return isUnderRoot(canonicalizeSync(filePath), canonicalizeSync(projectRoot));
}

/**
 * The same containment question, answered out of an already-filled realpath
 * column. **Pure: no filesystem, no cache** — both canonical paths are read from
 * the table with `realpathFrom`.
 *
 * The judgement-time form. `projectRoot` is looked up like any other row, which
 * is the point: canonicalizing the run-constant root once per run instead of
 * once per link is half the syscalls this column removes.
 *
 * Exactly equivalent to {@link isWithinProject} — same comparison
 * ({@link isUnderRoot}), same canonicalization contract (see
 * {@link canonicalizeSync}).
 *
 * @param table - Table filled by `fillRealpaths`, covering BOTH paths
 * @param filePath - Absolute path to check
 * @param projectRoot - Absolute path to project root
 * @returns True if filePath is under projectRoot (after symlink resolution)
 * @throws If the table holds no row for either path — see `realpathFrom`
 */
export function isWithinProjectFrom(
  table: RealpathTable,
  filePath: string,
  projectRoot: string,
): boolean {
  return isUnderRoot(realpathFrom(table, filePath), realpathFrom(table, projectRoot));
}

/**
 * Escape a property name as a JSON Pointer segment per RFC 6901:
 * `~` -> `~0`, `/` -> `~1`. Order matters (escape `~` first).
 */
export function encodeJsonPointerSegment(name: string): string {
  return name.replaceAll('~', '~0').replaceAll('/', '~1');
}

/**
 * Reverse RFC 6901 escapes: `~1` -> `/`, `~0` -> `~`. Order matters
 * (unescape `~1` first).
 */
export function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

/**
 * Format a JSON Pointer (RFC 6901) as developer-friendly dotted notation.
 *
 * Numeric segments become bracketed array indices (`0` → `[0]`); non-numeric
 * segments are dot-joined. Reverses RFC 6901 escapes inside segments.
 *
 * @example
 *   formatJsonPointerAsDotted('/adr-citations/0/adr')  // 'adr-citations[0].adr'
 *   formatJsonPointerAsDotted('')                       // ''
 */
export function formatJsonPointerAsDotted(pointer: string): string {
  if (pointer === '') return '';
  // eslint-disable-next-line local/no-hardcoded-path-split -- JSON Pointer RFC 6901 delimiter, not a file path
  const segments = pointer.slice(1).split('/').map(decodeJsonPointerSegment);

  let out = '';
  for (const seg of segments) {
    if (isCanonicalArrayIndex(seg)) {
      out += `[${seg}]`;
    } else {
      out += out === '' ? seg : `.${seg}`;
    }
  }
  return out;
}

export function isCanonicalArrayIndex(s: string): boolean {
  // Canonical integer per RFC 6901 §4 + JSON canonical form: no leading zeros
  // except for "0" itself.
  if (s === '') return false;
  if (s === '0') return true;
  if (s.startsWith('0')) return false;
  for (const ch of s) {
    if (ch < '0' || ch > '9') return false;
  }
  return true;
}
