/**
 * Realization rows for the resource projection — **one path in one extent**.
 *
 * The cheap per-path attributes a population records once, so later stages do
 * not go and compute them per link, per check, per lane. Moved down here from
 * the CLI's enumeration oracle: the oracle asked exactly the same questions of
 * exactly the same `lstat`, and one fact must have one implementation.
 */

import { lstatSync } from 'node:fs';

import {
  countWork,
  followedStatSync,
  type FsFaultFacts,
  fsFaultOf,
  isLinkChainRefusedError,
  linkResolutionFault,
  realpathNativeSync,
} from '@vibe-agent-toolkit/utils';
import type { GitTracker } from '@vibe-agent-toolkit/utils/git';

import {
  CONDITION_WITHOUT_REFERENCE,
  type RealizationConditionRow,
  type ResourceRealizationRow,
} from '../schemas/projection-resources.js';

import { isSizeRefusal, keyOfContent, type RunContentCache } from './content-cache.js';
import { relativize } from './root-relative-path.js';
import { type CollectionMimeConflict, type CollectionMimeResolver, mimeFor, parserKindForMime } from './router.js';

/**
 * When a realization should pay to read and hash a path's bytes.
 *
 * Three literals rather than a predicate callback, deliberately: a policy has
 * to stay inspectable and serializable — readable off the contributor that set
 * it and reproducible from a recorded population — and a closure here would be
 * a rule nobody can read back out of the projection.
 *
 * - `eager` — key the bytes now. The **default** when the field is absent, so
 *   every caller that has not opted in (including `collectRealization`'s caller
 *   outside any population, the CLI's enumeration-snapshot oracle) is unchanged.
 * - `deferred` — never key here; the row lands as `deferred` and no read
 *   happens.
 * - `deferGitignored` — key unless the row's own `gitignored` column is true.
 */
export const CONTENT_DEMANDS = ['eager', 'deferred', 'deferGitignored'] as const;

/** One of {@link CONTENT_DEMANDS}. */
export type ContentDemand = (typeof CONTENT_DEMANDS)[number];

/**
 * What an enumerator already established about a path, so no `lstat` is needed.
 *
 * Two literals and no third, because the vocabulary is deliberately narrower
 * than `lstat`'s: a source may supply one of these **only** when it knows, for
 * free, that the path is present on disk, is not a symbolic link, and is one of
 * a regular file or a directory. Everything else — a symlink, a path whose
 * shape the source is merely confident about, a path it found by walking —
 * supplies nothing and is stat'ed as before.
 *
 * The narrowness is the safety property. A richer record (`{exists, isSymlink,
 * isDirectory, symlinkResolves}`) could express states no source can actually
 * observe without a stat, and a source that filled one in from a guess would
 * produce a row indistinguishable from an observed one. Here the only thing
 * expressible is what git's index can answer.
 *
 * ⚠️ **A shape carries no `mtime`, and cannot.** Every source able to skip the
 * stat is able to precisely because it never asked the filesystem, and the
 * modification time exists nowhere else — a tree object has none, and the
 * index's stat cache is a deliberately-stale cache-validation stamp rather than
 * the truth. So a realization built from a shape records `mtime: null`, which
 * the column has always allowed.
 */
export type PathShape = 'file' | 'directory';

/** Everything needed to answer the realization questions for a path. */
export interface RealizationContext {
  /** Root every `path` in the resulting rows is relative to. */
  root: string;
  /** The extent this realization is observed in — `resource_realizations.extentId`. */
  extentId: string;
  /** Absent (or unusable) when the root is not a git repository. */
  gitTracker?: GitTracker | undefined;
  /**
   * The run's content cache, so one path keyed in two extents is read once, and
   * every read is held to the run's parse input cap; inside `populate` it is
   * always the builder's, threaded through {@link ProjectionBase.contentCache}.
   * `null` only for a caller outside a population that wants the bytes
   * themselves and parses none of them — the CLI's enumeration oracle, which keys
   * a single path with no run to belong to: such a read has no cap
   * (`readKeyedContent`).
   */
  contentCache: RunContentCache | null;
  /**
   * Whether this extent wants the bytes keyed. Absent means {@link ContentDemand}
   * `'eager'` — the historical behaviour, and the reason no existing caller had
   * to change.
   */
  contentDemand?: ContentDemand | undefined;
  /**
   * The enumerator's own answer to "what is this path", when it had one.
   *
   * Authoritative: supplying this **replaces** the `lstat`, it does not
   * accelerate it. So a source may set it only from
   * something it genuinely observed — see {@link PathShape} for the exact bar —
   * and absence means "ask the filesystem", which is what every caller that has
   * not opted in continues to do.
   */
  observedShape?: PathShape | undefined;
  /**
   * The run's collection-declared MIME types; absent, the row is typed by
   * `mime-type.ts`'s tables alone. A resolver, not the raw collections map, so
   * the run's one conflict accumulator reports each conflicted file once.
   */
  mimeResolver?: CollectionMimeResolver | undefined;
}

/**
 * The five columns a realization gets from looking at a path — by whatever means
 * it looked.
 *
 * Named as one record so the two ways of answering are interchangeable at the
 * call site and cannot drift into filling in different subsets. A column added
 * here must be answerable by BOTH producers or the type stops compiling, which
 * is the property that keeps a shape-sourced row from quietly under-describing
 * a path.
 */
interface PathObservation {
  /** The path is present. */
  exists: boolean;
  /** The path is a directory (following the link, when it is one). */
  isDirectory: boolean;
  /** The path is itself a symbolic link. */
  isSymlink: boolean;
  /** Whether a symlink's target resolves; `null` when the path is not a link. */
  symlinkResolves: boolean | null;
  /** Last modification time; `null` when nothing stat'ed this path. */
  mtime: Date | null;
}

/**
 * Ask the filesystem.
 *
 * @param absolutePath - Path to stat
 * @param root - The corpus root the path is crawled in: a link's chain is read beneath it before
 *   the kernel follows it (`link-following.ts`)
 * @returns What `lstat` (and, for a link, a followed `stat`) said
 */
function statObservation(absolutePath: string, root: string): PathObservation {
  try {
    countWork('fs.lstat', 1);
    const link = lstatSync(absolutePath);
    if (!link.isSymbolicLink()) {
      return {
        exists: true,
        isDirectory: link.isDirectory(),
        isSymlink: false,
        symlinkResolves: null,
        mtime: link.mtime,
      };
    }
    try {
      countWork('fs.stat', 1);
      const target = followedStatSync(absolutePath, root);
      if (target === undefined) return unresolvedLink(link.mtime);
      return {
        exists: true,
        isDirectory: target.isDirectory(),
        isSymlink: true,
        symlinkResolves: true,
        mtime: link.mtime,
      };
    } catch (error) {
      // The OS will not follow the link to its target (EACCES on the target's
      // directory), or VAT will not hand the kernel its chain (a hop naming a
      // network or device path): either way this process cannot resolve it,
      // which is what the column says.
      if (!isLinkChainRefusedError(error) && fsFaultOf(error) === undefined) throw error;
      return unresolvedLink(link.mtime);
    }
  } catch (error) {
    // Absent, or the filesystem refused to look — `exists` is false and every
    // other column takes its "we could not look" default rather than a guess.
    // A bug in this function is not "could not look" and stays loud.
    if (fsFaultOf(error) === undefined) throw error;
    return {
      exists: false,
      isDirectory: false,
      isSymlink: false,
      symlinkResolves: null,
      mtime: null,
    };
  }
}

/** A symbolic link this process cannot resolve: dangling, a loop, refused by the OS or by VAT. */
function unresolvedLink(mtime: Date): PathObservation {
  return {
    exists: true,
    isDirectory: false,
    isSymlink: true,
    symlinkResolves: false,
    mtime,
  };
}

/**
 * Take the enumerator's word for it, and spend no syscall.
 *
 * `exists: true` is not an assumption bolted on here — it is half of what
 * {@link PathShape} means, and a source that cannot assert it must supply no
 * shape. `isSymlink: false` is the other half, which is why `symlinkResolves`
 * is `null` rather than `true`: the column reports how a *link* resolved, and
 * this path is not one.
 *
 * @param shape - What the enumerator observed
 * @returns The same five columns, none of them stat'ed
 */
function shapeObservation(shape: PathShape): PathObservation {
  return {
    exists: true,
    isDirectory: shape === 'directory',
    isSymlink: false,
    symlinkResolves: null,
    mtime: null,
  };
}

/**
 * Collect the realization row for one absolute path in one extent.
 *
 * `lstat` first, deliberately, **whenever the filesystem has to be asked at
 * all**: `stat` follows symlinks, so a `stat`-only implementation cannot tell a
 * symlink from what it points at, and reports a dangling link as simply absent.
 * That single `lstat` also supplies `mtime` — there is deliberately no second
 * `stat` call for it.
 *
 * The filesystem does not have to be asked when the enumerator already answered:
 * see {@link RealizationContext.observedShape}. That path costs no syscall and
 * yields `mtime: null`.
 *
 * @param absolutePath - Path to describe
 * @param resourceId - The identity this path realizes, from `ResourceIdentityMap`
 * @param context - Root, extent, (optional) git oracle, cache and demand policy
 * @returns The realization row, with `contentKey` filled in when the bytes were
 *   read and `contentState` always saying why it was or was not
 */
export async function collectRealization(
  absolutePath: string,
  resourceId: string,
  context: RealizationContext,
): Promise<ResourceRealizationRow> {
  const { exists, isDirectory, isSymlink, symlinkResolves, mtime }
    = context.observedShape === undefined
      ? statObservation(absolutePath, context.root)
      : shapeObservation(context.observedShape);

  // `isIgnoredByActiveSet`, NOT `isIgnored`, and the difference is 59× on this
  // repository. `GitTracker.initialize()` primes its cache with the ACTIVE files
  // only, so `isIgnored` is an O(1) cache hit for every path that is NOT ignored
  // and a `git check-ignore` SPAWN for every path that is — i.e. it spawns once
  // per ignored path, which for the filesystem extent (`respectGitignore: false`,
  // so it enumerates all of `dist/`) is most of the tree. Measured by
  // `claude-marketplace`'s `inventory-extent-corpus.integration.test.ts`, whose
  // `populate ms` column is the observation: repo root, tracker supplied,
  // 59,870 ms → 1,016 ms; one VAT package, 5,203 ms → 65 ms. Neither the
  // realization count (5,903) nor the reference-candidate count (31,264) moved,
  // so the column's ANSWERS are unchanged on that corpus.
  //
  // It is the same question, asked of a set instead of a subprocess: for a path
  // that exists inside the root, active-set membership is authoritative, and
  // `isIgnoredByActiveSet` falls back to `isIgnored` for the two cases where it
  // is not (a path that does not exist, and a path outside the root). The one
  // real difference is the tracker's documented STALENESS BOUND — a file created
  // after `initialize()` exists but is absent from the active set, so it reads as
  // ignored. A population is a read-only snapshot, which is exactly the lane that
  // bound is documented as safe for; a lane that WRITES between walks must hand
  // in a fresh tracker, as `walkLinkGraph`'s callers already must.
  // The observation above already answered "is this path there?", so the tracker
  // is told rather than asked. Without this it re-probes with `existsSync` for every
  // path absent from the active set -- once per ignored path, and this is the
  // extent that enumerates all of them: 11,108 calls on an 8,496-path adopter.
  //
  // `existsSync` FOLLOWS symlinks and `lstat` does not, so the boolean handed
  // over is deliberately not `exists`. A dangling symlink is `exists: true` here
  // and absent to `existsSync`, and passing the raw `lstat` answer would stop it
  // falling back to `git check-ignore` and start calling it ignored.
  const resolvesForStat = exists && symlinkResolves !== false;
  const gitignored = context.gitTracker?.isUsable() === true
    ? context.gitTracker.isIgnoredByActiveSet(absolutePath, resolvesForStat)
    : false;

  const rel = relativize(absolutePath, context.root);
  const lastSlash = rel.lastIndexOf('/');
  const basename = lastSlash === -1 ? rel : rel.slice(lastSlash + 1);
  const dot = basename.lastIndexOf('.');

  // Typed BEFORE the bytes are keyed, because the type decides the parser and
  // the parser kind is part of the content key. Resolving it afterwards would let
  // a row carry a `mime` its own `contentKey` disagrees with.
  //
  // A directory is not asked: `mime` is "what this FILE is", and a directory has
  // no bytes to type. Asking anyway did two wrong things — it stamped `docs/`
  // with the type its collection declared for the files beneath it, and it made
  // the resolver record a COLLECTION_MIME_CONFLICT for the directory path beside
  // the one for each file, so one authoring mistake surfaced twice.
  const mime = mimeForRealization(absolutePath, rel, isDirectory, context.mimeResolver);

  const { contentKey, contentState, contentFaultClass } = await keyOrState(absolutePath, context, {
    hasBytes: exists && !isDirectory && symlinkResolves !== false,
    gitignored,
  }, mime);

  return {
    resourceId,
    extentId: context.extentId,
    path: rel,
    pathLower: rel.toLowerCase(),
    basenameLower: basename.toLowerCase(),
    dir: lastSlash === -1 ? '' : rel.slice(0, lastSlash),
    // eslint-disable-next-line local/no-hardcoded-path-split -- relativize() has already forward-slashed this
    depth: rel.split('/').length,
    ext: dot <= 0 ? '' : basename.slice(dot).toLowerCase(),
    mime,
    contentKey,
    contentState,
    contentFaultClass,
    mtime,
    exists,
    isDirectory,
    gitignored,
    isSymlink,
    symlinkResolves,
  };
}

/**
 * Where a path really lives, as {@link resolveRealPath} answers it.
 *
 * `nowhere` is one answer with its reason: `fault: null` when the OS looked and
 * found nothing (absent, dangling, a cycle), and the fault — errno and class —
 * when it declined or failed to look. A read lane reports that fault against the
 * one path; it never stops the run.
 */
export type RealPathResolution =
  | { readonly kind: 'resolved'; readonly path: string }
  | { readonly kind: 'nowhere'; readonly fault: FsFaultFacts | null };

/**
 * A path's real location, or why it has none.
 *
 * Exported so a population pass can group by identity without resolving twice,
 * and because "two paths are the same file" is a question only the real path
 * can answer — comparing content keys would conflate an alias with two files
 * that merely have identical bytes, which any corpus with two empty files
 * already contains.
 *
 * Distinct from `identity.ts`'s ancestor-walking fallback on purpose: this one
 * reports unresolvability rather than inventing a spelling, because its callers
 * are asking *whether* a path resolves.
 *
 * @param absolutePath - Path to resolve
 * @param within - The tree the path is crawled in (the corpus root): its link chain is read beneath
 *   it before the kernel is asked (`link-following.ts`)
 * @returns The forward-slashed real path, or `nowhere` with the fault (or `null`) that says why
 * @throws The resolution's error when it carries no errno — a bug stays loud
 */
export function resolveRealPath(absolutePath: string, within: string): RealPathResolution {
  try {
    return { kind: 'resolved', path: realpathNativeSync(absolutePath, within) };
  } catch (error) {
    return { kind: 'nowhere', fault: linkResolutionFault(error) ?? null };
  }
}

/** What `lstat` already established about whether there are bytes to key. */
interface ObservedPath {
  /** False for an absent path, a directory, or a dangling symlink. */
  hasBytes: boolean;
  /** The row's own `gitignored` column — the input `deferGitignored` reads. */
  gitignored: boolean;
}

/**
 * Key a path's contents, or say why there is no key — the `(contentKey,
 * contentState)` pair, computed together because they are one decision and two
 * columns.
 *
 * Precedence is fixed and the order matters:
 *
 * 1. **No bytes** wins over everything. A directory is not "deferred", it is a
 *    thing with no content, and no demand policy may relabel it — otherwise a
 *    consumer could not tell a corpus of directories from one it declined to
 *    read.
 * 2. **The demand policy defers.** No read happens at all; that is the saving.
 * 3. **Otherwise read.** Success keys it; a file refused by its size is
 *    `oversize`, never read — too large to decode, or, for a kind a parser
 *    reads, past the run's parse input cap (the run's cache holds it to it);
 *    a filesystem refusal is `unreadable`, with its fault class; anything else
 *    is a bug and is rethrown.
 *
 * A read failure is a fact about the corpus, not an error in the harness — an
 * unreadable file must show up as a row with a null key, not abort the
 * population, or one permissions quirk on one CI host destroys the whole gate.
 *
 * The read goes through the run's cache when there is one, so the same file
 * realized in the git extent, the filesystem extent and a package extent costs
 * one `readFile` and one SHA-256 rather than three.
 *
 * @param absolutePath - Path to read and key
 * @param context - Supplies the demand policy and the run's cache
 * @param observed - What `lstat` already established about this path
 * @param mime - This realization's effective type, which chooses the parser
 * @returns The content key (or null), the state explaining it, and the fault of a read that failed
 */
async function keyOrState(
  absolutePath: string,
  context: RealizationContext,
  observed: ObservedPath,
  mime: string | null,
): Promise<Pick<ResourceRealizationRow, 'contentKey' | 'contentState' | 'contentFaultClass'>> {
  if (!observed.hasBytes) {
    return { contentKey: null, contentState: 'none', contentFaultClass: null };
  }
  if (defers(context.contentDemand ?? 'eager', observed.gitignored)) {
    return { contentKey: null, contentState: 'deferred', contentFaultClass: null };
  }
  try {
    const contentKey = await keyOfContent(
      absolutePath,
      // The row's OWN type, never the path-only `parserKindForPath`: a declared
      // `mimeType` must reach the parser, not merely the column.
      parserKindForMime(mime),
      context.contentCache,
    );
    return { contentKey, contentState: 'keyed', contentFaultClass: null };
  } catch (error) {
    // Refused by its size before any read (see `readDecodableBytes`): too large
    // to become a string, or past the parse input cap a parser would refuse it at.
    if (isSizeRefusal(error)) {
      return { contentKey: null, contentState: 'oversize', contentFaultClass: null };
    }
    // `unreadable` means the filesystem refused the bytes, and that is all it may
    // mean: a bug in the keying is not a fact about the corpus. A member's object
    // git's store does not hold is no filesystem fault either (the file is still
    // there): it reaches the command, which refuses it INPUT_UNREADABLE, as every
    // other read of that object does.
    const fault = fsFaultOf(error);
    if (fault === undefined) throw error;
    return { contentKey: null, contentState: 'unreadable', contentFaultClass: fault.faultClass };
  }
}

/**
 * Whether a demand policy declines to key this row.
 *
 * @param demand - The extent's policy
 * @param gitignored - The row's own `gitignored` column
 * @returns True when the bytes must not be read
 */
function defers(demand: ContentDemand, gitignored: boolean): boolean {
  return demand === 'deferred' || (demand === 'deferGitignored' && gitignored);
}

// ---------------------------------------------------------------------------
// Collection-declared MIME types
// ---------------------------------------------------------------------------

/**
 * The condition code for two collections that type one file differently.
 *
 * `severity: 'error'` — this is a mistake in `vibe-agent-toolkit.config.yaml`,
 * not a fact about the corpus, and it is the one condition in this module a
 * command is expected to fail on.
 */
export const COLLECTION_MIME_CONFLICT = 'COLLECTION_MIME_CONFLICT';

/** The `mime` column for one realization: null for a directory, the router's {@link mimeFor} otherwise. */
function mimeForRealization(
  absolutePath: string,
  relativePath: string,
  isDirectory: boolean,
  resolver: CollectionMimeResolver | undefined,
): string | null {
  if (isDirectory) return null;
  return mimeFor(resolver, absolutePath, relativePath);
}

/**
 * Render one conflict as the `realization_conditions` row that carries it, so a
 * config error is queryable like any population-time finding. The provenance
 * columns come from {@link CONDITION_WITHOUT_REFERENCE}: a config file, not a
 * reference, provoked it.
 *
 * @param conflict - The recorded disagreement
 * @param extentId - The extent whose realization of this path is being reported
 * @param resourceId - The identity at that path, or null when none was minted
 * @returns The condition row
 */
export function collectionMimeConflictCondition(
  conflict: CollectionMimeConflict,
  extentId: string,
  resourceId: string | null,
): RealizationConditionRow {
  return {
    extentId,
    path: conflict.path,
    ...collectionMimeConflictFinding(conflict),
    resourceId,
    ...CONDITION_WITHOUT_REFERENCE,
  };
}

/**
 * The code, severity and sentence of a MIME conflict — shared by the condition
 * row above and by `ResourceRegistry.validate()`, which reports the conflicts
 * ITS resolver met on both lanes so an author is told on the lane they ran.
 *
 * @param conflict - The recorded disagreement
 * @returns The finding's code, severity and message
 */
export function collectionMimeConflictFinding(
  conflict: CollectionMimeConflict,
): Pick<RealizationConditionRow, 'code' | 'severity' | 'message'> {
  const [firstName, secondName] = conflict.collections;
  const [firstType, secondType] = conflict.mimeTypes;
  return {
    code: COLLECTION_MIME_CONFLICT,
    severity: 'error',
    message: `Collections "${firstName}" and "${secondName}" declare different mimeType values for `
      + `"${conflict.path}": "${firstType}" and "${secondType}". A file has one type and one parser, `
      + 'so make the two declarations agree or drop mimeType from the collection that should not be '
      + 'typing this file. This run used the built-in type table\'s answer for the path so the rest '
      + 'of the report could complete.',
  };
}
