/**
 * Identity minting for the resource projection.
 *
 * One file has exactly one identity, however many names, extents or zones
 * observe it. That is the whole job of this module: turn any spelling of a path
 * into the single canonical spelling identity is derived from, and hash it.
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';

import { type GitTracker, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

/** Hex characters kept from a SHA-256 digest. 128 bits — collision-free at any corpus size. */
const ID_HEX_LENGTH = 32;

/**
 * Stable identifier for a corpus root.
 *
 * A hash rather than the path itself: `roots.path` already carries the absolute
 * path for anyone who needs it, and an id derived from the real path stays
 * stable across two runs that spell the same root differently (a trailing
 * separator, a symlinked home).
 *
 * @param absoluteRootPath - Absolute path the corpus was crawled from
 * @returns Opaque root id, `root-` prefixed
 */
export function rootIdFor(absoluteRootPath: string): string {
  return rootIdForReal(resolveRootPath(absoluteRootPath));
}

/**
 * A corpus root reduced to the one spelling everything else is derived from.
 *
 * Exported because {@link CanonicalPathContext.realRoot} *requires* this
 * spelling and a caller cannot produce it otherwise — `realpathSync` alone is
 * not equivalent, since it throws for a root that does not exist yet while this
 * falls back to the nearest resolvable ancestor.
 *
 * **This is a `realpath` syscall. Call it once per root, not once per path** —
 * re-deriving it inside a per-path helper was measured at ~10k wasted
 * `realpathSync.native` calls on one adopter tree, roughly one per enumerated
 * path, all of them recomputing a value fixed for the run.
 *
 * @param absoluteRootPath - Absolute path the corpus is crawled from
 * @returns Forward-slashed real root, with any unresolvable tail appended
 */
export function resolveRootPath(absoluteRootPath: string): string {
  return realPathOrSelf(safePath.resolve(absoluteRootPath));
}

/**
 * Root id from a root already reduced by {@link resolveRootPath}.
 *
 * @param realRoot - Output of {@link resolveRootPath}
 * @returns Opaque root id, `root-` prefixed
 */
function rootIdForReal(realRoot: string): string {
  return `root-${sha256Hex(realRoot).slice(0, ID_HEX_LENGTH)}`;
}

/** Everything {@link canonicalPathFor} needs to answer the casing question. */
export interface CanonicalPathContext {
  /**
   * Absolute corpus root, **already reduced by {@link resolveRootPath}**.
   *
   * Named `realRoot` rather than `root` so the requirement is unmissable at
   * every call site: this function runs once per path, and a field that merely
   * *accepted* an unresolved root would have to re-resolve it per call — which
   * is exactly the N+1 this spelling exists to make impossible. Passing an
   * unresolved path here does not error, it silently mints identities relative
   * to the wrong base wherever the root is a symlink (`/var` → `/private/var`
   * on macOS makes that the common case, not the corner one).
   */
  realRoot: string;
  /**
   * Supplies git-index casing where the path is tracked. Absent outside a repo.
   *
   * Must be rooted at the same `root`: `indexPathFor` answers relative to the
   * tracker's own project root, so a tracker rooted elsewhere would return a
   * path relative to the wrong base.
   */
  gitTracker?: GitTracker | undefined;
}

/**
 * The one spelling of a path that identity is minted from.
 *
 * **Git-index casing where the path is tracked, otherwise the on-disk casing
 * from `realpathSync.native`, with symlinks resolved.** Not optional precision:
 * `pathLower`/`basenameLower` exist so case-insensitive matching is a column
 * rather than a function call, and hashing a raw path defeats them. On a
 * case-insensitive filesystem `docs/Readme.md` seen through the filesystem
 * extent and `docs/README.md` recorded in git's index would otherwise mint two
 * identities for one inode — and Node's two `realpath` implementations disagree
 * about which casing they return, so this is not hypothetical.
 *
 * Consequences, both intended: a symlink and its target share one identity, and
 * a symlinked directory loop mints one identity per real file rather than one
 * per traversal.
 *
 * @param absolutePath - Path to canonicalize
 * @param context - Corpus root and optional git oracle
 * @returns Root-relative, forward-slashed canonical path
 */
export function canonicalPathFor(absolutePath: string, context: CanonicalPathContext): string {
  const resolved = safePath.resolve(absolutePath);
  const tracked = context.gitTracker?.isUsable() === true
    ? context.gitTracker.indexPathFor(resolved)
    : null;
  if (tracked !== null) {
    return toForwardSlash(tracked);
  }
  return relativeTo(context.realRoot, realPathOrSelf(resolved));
}

/**
 * Mint the opaque identity for a canonical path under a root.
 *
 * **There is deliberately no zone parameter.** Hashing the originating zone
 * failed twice: a single file is simultaneously in `filesystem`, `git`,
 * `tree:source`, `package:X` and `skill:Y` with nothing defining which wins, and
 * `vat build` populates twice, so a stale artifact under `dist/` would mint two
 * ids inside one run — across exactly the two populations the survival lens
 * joins. Nothing ever read the zone back out of an opaque hash, so it was doing
 * no work while creating two failure modes. Origin is an attribute on
 * `resources.origin` instead.
 *
 * @param rootId - From {@link rootIdFor}
 * @param canonicalPath - From {@link canonicalPathFor}
 * @returns Opaque resource id, `res-` prefixed
 */
export function mintResourceId(rootId: string, canonicalPath: string): string {
  // The space is a separator, not decoration: without it ('ab' + 'c/d.md') and
  // ('a' + 'bc/d.md') would hash the same bytes.
  const material = `${rootId} ${canonicalPath}`;
  return `res-${sha256Hex(material).slice(0, ID_HEX_LENGTH)}`;
}

/**
 * Memoized identity minting for one root.
 *
 * Memoized because `canonicalPathFor` costs a `realpath` per call and the same
 * path is offered by several contributors — the filesystem extent, the git
 * extent and any package extent all observe most files.
 */
export class ResourceIdentityMap {
  readonly #rootId: string;
  readonly #context: CanonicalPathContext;
  readonly #byAbsolutePath = new Map<string, string>();
  readonly #canonicalById = new Map<string, string>();

  /**
   * @param root - Absolute corpus root
   * @param gitTracker - Optional git oracle supplying index casing
   */
  constructor(root: string, gitTracker?: GitTracker | undefined) {
    // ONE `realpath` for the whole map. Both the id and every canonical path
    // are derived from this single reduction rather than each redoing it.
    const realRoot = resolveRootPath(root);
    this.#rootId = rootIdForReal(realRoot);
    this.#context = { realRoot, ...(gitTracker !== undefined && { gitTracker }) };
  }

  /** The root id every identity in this map is scoped to. */
  get rootId(): string {
    return this.#rootId;
  }

  /** How many distinct identities have been minted. */
  get size(): number {
    return this.#canonicalById.size;
  }

  /**
   * The identity for an absolute path, minting it on first observation.
   *
   * @param absolutePath - Path to identify
   * @returns The resource id
   */
  idFor(absolutePath: string): string {
    const key = toForwardSlash(safePath.resolve(absolutePath));
    const cached = this.#byAbsolutePath.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const canonical = canonicalPathFor(absolutePath, this.#context);
    const id = mintResourceId(this.#rootId, canonical);
    this.#byAbsolutePath.set(key, id);
    this.#canonicalById.set(id, canonical);
    return id;
  }

  /**
   * The canonical path an id was minted from.
   *
   * @param resourceId - An id previously returned by {@link idFor}
   * @returns The canonical path, or undefined for an unknown id
   */
  canonicalPathOf(resourceId: string): string | undefined {
    return this.#canonicalById.get(resourceId);
  }
}

/**
 * Resolve a path, falling back to the nearest ancestor that does resolve.
 *
 * A path that does not exist yet is a legal input — a `files:` declared build
 * artifact is the motivating case — and must still get a stable identity, one
 * that will not move when the file appears. Resolving the deepest existing
 * ancestor and re-appending the tail is what makes that true: on macOS the temp
 * root is itself a symlink (`/var` → `/private/var`), so falling back to the
 * unresolved path would put an absent file "outside" the very root it is under.
 *
 * @param absolutePath - Absolute path to resolve
 * @returns Forward-slashed real path, with any unresolvable tail appended
 */
function realPathOrSelf(absolutePath: string): string {
  const forward = toForwardSlash(absolutePath);
  const direct = tryRealPath(forward);
  if (direct !== null) {
    return direct;
  }

  const lastSlash = forward.lastIndexOf('/');
  if (lastSlash <= 0) {
    return forward;
  }
  return `${realPathOrSelf(forward.slice(0, lastSlash))}/${forward.slice(lastSlash + 1)}`;
}

/** The real path, or null when it cannot be resolved. */
function tryRealPath(absolutePath: string): string | null {
  try {
    return toForwardSlash(realpathSync.native(absolutePath));
  } catch {
    return null;
  }
}

/**
 * Root-relative, forward-slashed. Falls back to the absolute path when outside
 * the root.
 *
 * Takes the ALREADY-resolved root and does no `realpath` of its own — see
 * {@link CanonicalPathContext.realRoot}. This function runs once per enumerated
 * path, so a resolve here is a syscall per path.
 */
function relativeTo(realRoot: string, absolutePath: string): string {
  const rel = safePath.relative(realRoot, absolutePath);
  if (rel === '' || rel.startsWith('..')) {
    return toForwardSlash(absolutePath);
  }
  return toForwardSlash(rel);
}

/** Hex SHA-256 of a UTF-8 string. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
