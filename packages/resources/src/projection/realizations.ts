/**
 * Realization rows for the resource projection — **one path in one extent**.
 *
 * The cheap per-path attributes a population records once, so later stages do
 * not go and compute them per link, per check, per lane. Moved down here from
 * the CLI's enumeration oracle: the oracle asked exactly the same questions of
 * exactly the same `lstat`, and one fact must have one implementation.
 */

import { lstatSync, realpathSync, statSync } from 'node:fs';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { type GitTracker } from '@vibe-agent-toolkit/utils/git';

import { matchesCollection } from '../collection-matcher.js';
import type { ParserKind } from '../content-key.js';
import { mimeTypeForPath, parserKindForMimeType } from '../mime-type.js';
import type { CollectionConfig } from '../schemas/project-config.js';
import {
  CONDITION_WITHOUT_REFERENCE,
  type ContentState,
  type RealizationConditionRow,
  type ResourceRealizationRow,
} from '../schemas/projection-resources.js';

import { readKeyedContent, type RunContentCache } from './content-cache.js';
import { canonicalJson } from './digest.js';

/**
 * The kind meaning "no document parser runs on this".
 *
 * A second spelling of a literal `content-key.ts` keeps private, and it is here
 * only because that module does not export it. The binding to {@link ParserKind}
 * is what stops the two drifting silently: a kind renamed there stops this
 * assignment compiling. Delete this the moment `content-key.ts` exports its own
 * `NO_PARSER_KIND` — see the report accompanying this change.
 */
const NO_PARSER_KIND: ParserKind = 'none';

/**
 * Render an absolute path relative to a root, forward-slashed.
 *
 * Every path a realization row or a snapshot prints goes through here. An
 * absolute path in a golden file makes the golden machine-specific and leaks
 * `$HOME`; both have bitten this repo before.
 *
 * @param absolutePath - Path to render
 * @param root - Root the path is rendered relative to
 * @returns Forward-slashed relative path (or the forward-slashed absolute path
 *   when the target lies outside the root, which is itself worth seeing)
 */
export function relativize(absolutePath: string, root: string): string {
  const rel = safePath.relative(root, absolutePath);
  return rel === '' ? '.' : toForwardSlash(rel);
}

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
export type ContentDemand = 'eager' | 'deferred' | 'deferGitignored';

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
   * The run's content cache, so one path keyed in two extents is read once.
   *
   * Optional because this function is also called outside a population — the
   * CLI's enumeration oracle keys a single path with no run to belong to — and a
   * cache with a lifetime of one call would be a pure cost. Inside `populate` it
   * is always present, threaded from the builder through
   * {@link ProjectionBase.contentCache}.
   */
  contentCache?: RunContentCache | undefined;
  /**
   * Whether this extent wants the bytes keyed. Absent means {@link ContentDemand}
   * `'eager'` — the historical behaviour, and the reason no existing caller had
   * to change.
   */
  contentDemand?: ContentDemand | undefined;
  /**
   * A byte identity the enumerator already computed for THIS path — the git
   * source's blob OID, when it has a sound one.
   *
   * Only ever a lookup into the run's cache, so that a second path holding
   * identical bytes costs no read; never the key a parse is filed under. Absent
   * for every path a walk found, and absent for symlinks and submodules even
   * under git — see `EnumeratedPath.contentHint`, which is where the mode is
   * visible and therefore where the exclusion belongs.
   */
  contentHint?: string | undefined;
  /**
   * The enumerator's own answer to "what is this path", when it had one.
   *
   * Authoritative, unlike {@link RealizationContext.contentHint}, which is only
   * ever a cache lookup whose miss is free: supplying this **replaces** the
   * `lstat`, it does not accelerate it. So a source may set it only from
   * something it genuinely observed — see {@link PathShape} for the exact bar —
   * and absence means "ask the filesystem", which is what every caller that has
   * not opted in continues to do.
   */
  observedShape?: PathShape | undefined;
  /**
   * The run's collection-declared MIME types, when the project declares any.
   *
   * Absent means "nobody declared a type", and the row is typed by
   * `mime-type.ts`'s tables alone — which is what every caller outside a
   * populate (the CLI's enumeration oracle, a test realizing one path) wants and
   * what every caller that has not opted in continues to get.
   *
   * It is a RESOLVER rather than the raw collections map on purpose: it holds
   * the run's accumulated {@link CollectionMimeResolver.conflicts}, so two
   * extents realizing one conflicted file report the config error once rather
   * than once each.
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
 * @returns What `lstat` (and, for a link, `stat`) said
 */
function statObservation(absolutePath: string): PathObservation {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- enumerated corpus path
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
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- enumerated corpus path
      const target = statSync(absolutePath);
      return {
        exists: true,
        isDirectory: target.isDirectory(),
        isSymlink: true,
        symlinkResolves: true,
        mtime: link.mtime,
      };
    } catch {
      return {
        exists: true,
        isDirectory: false,
        isSymlink: true,
        symlinkResolves: false,
        mtime: link.mtime,
      };
    }
  } catch {
    // Genuinely absent — `exists` is false and every other column takes its "we
    // could not look" default rather than a guess.
    return {
      exists: false,
      isDirectory: false,
      isSymlink: false,
      symlinkResolves: null,
      mtime: null,
    };
  }
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
      ? statObservation(absolutePath)
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
  // the parser is mixed into the content key. Resolving it afterwards would let
  // a row carry a `mime` its own `contentKey` disagrees with.
  const mime = context.mimeResolver === undefined
    ? mimeTypeForPath(absolutePath)
    : context.mimeResolver.mimeFor(absolutePath, rel);

  const { contentKey, contentState } = await keyOrState(absolutePath, context, {
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
    mtime,
    exists,
    isDirectory,
    gitignored,
    isSymlink,
    symlinkResolves,
  };
}

/**
 * A path's real location, or `null` when it cannot be resolved.
 *
 * Exported so a population pass can group by identity without resolving twice,
 * and because "two paths are the same file" is a question only the real path
 * can answer — comparing content keys would conflate an alias with two files
 * that merely have identical bytes, which any corpus with two empty files
 * already contains.
 *
 * Distinct from `identity.ts`'s ancestor-walking fallback on purpose: this one
 * reports unresolvability as `null` rather than inventing a spelling, because
 * its callers are asking *whether* a path resolves.
 *
 * @param absolutePath - Path to resolve
 * @returns Forward-slashed real path, or null
 */
export function realPathOrNull(absolutePath: string): string | null {
  try {
    return toForwardSlash(realpathSync.native(absolutePath));
  } catch {
    return null;
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
 * 3. **Otherwise read.** Success keys it; a throw is `unreadable`.
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
 * @returns The content key (or null) and the state explaining it
 */
async function keyOrState(
  absolutePath: string,
  context: RealizationContext,
  observed: ObservedPath,
  mime: string | null,
): Promise<{ contentKey: string | null; contentState: ContentState }> {
  if (!observed.hasBytes) {
    return { contentKey: null, contentState: 'none' };
  }
  if (defers(context.contentDemand ?? 'eager', observed.gitignored)) {
    return { contentKey: null, contentState: 'deferred' };
  }
  try {
    const keyed = await readKeyedContent(
      absolutePath,
      // The row's OWN type, not `parserKindForPath`'s answer, and the difference
      // is the whole of part two: a collection that declares `text/markdown` for
      // a `.ts` file must reach the parser, not merely the column. Re-deriving
      // the kind from the path here would key the bytes under `none.<digest>`
      // while the row claimed markdown, and every downstream stage reads the
      // kind back off that prefix.
      parserKindForMimeType(mime) ?? NO_PARSER_KIND,
      context.contentCache,
      context.contentHint,
    );
    return { contentKey: keyed.key, contentState: 'keyed' };
  } catch {
    return { contentKey: null, contentState: 'unreadable' };
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

/**
 * One file that two collections declare incompatible types for.
 *
 * Both halves are pairs rather than lists because the report only has to be
 * ACTIONABLE, not exhaustive: an author who deletes or aligns one of two named
 * declarations has fixed the file, and if a third collection also disagrees the
 * next run says so. Carrying every disagreeing collection would make the message
 * longer without making the first edit any different.
 */
export interface CollectionMimeConflict {
  /** Root-relative path of the file the collections disagree about. */
  path: string;
  /** The two collections, in the order the config declares them. */
  collections: readonly [string, string];
  /** What each of them declared, positionally paired with {@link collections}. */
  mimeTypes: readonly [string, string];
}

/**
 * The run's answer to "what is this file", and the config errors it found asking.
 *
 * Stateful on purpose. A conflict is a property of the CONFIG, but it is only
 * discovered while walking paths, and the same path is walked once per extent —
 * so the accumulator has to outlive a single {@link collectRealization} call or
 * a three-extent population would report one authoring mistake three times.
 */
export interface CollectionMimeResolver {
  /**
   * Type one path, recording a conflict rather than throwing on one.
   *
   * @param absolutePath - The path to type; matched against collection patterns,
   *   which are written to match absolute paths (see `pattern-expander.ts`)
   * @param relativePath - The same path as `resource_realizations.path` spells
   *   it, which is what a conflict names — an absolute path in a report leaks
   *   `$HOME` and makes the finding machine-specific
   * @returns The declared type, or `mime-type.ts`'s answer when nothing declared
   *   one AND when the declarations conflict
   */
  mimeFor(absolutePath: string, relativePath: string): string | null;
  /**
   * Every conflict seen so far, in first-encounter order, one per path.
   *
   * Live: it grows as {@link mimeFor} is called. Read it after the population
   * finishes.
   */
  readonly conflicts: readonly CollectionMimeConflict[];
  /**
   * A stable digest of the RULES this routing will apply — the run's parse
   * routing, named so a cache can be keyed on it.
   *
   * ## Why this exists, and why it is derived rather than listed
   *
   * A projection store's reuse rule compares `(contributorId, parameterSet)`.
   * Declared types appear in NO parameter set, so two runs over an unchanged
   * tree that disagree about routing ask genuinely different questions and would
   * otherwise be a **false hit**: same key, materially different `mime` columns,
   * different content keys, different blob rows, exit 0.
   *
   * `storeKeyFor` therefore folds this in. It is one entry rather than a growing
   * hand-maintained list because its VALUE is computed from the rules
   * themselves — that module's own warning is that an enumerated list is "the
   * set someone remembered to model", and a fingerprint derived from the rules
   * cannot fall behind them. A new parser, a new declaration field, or a whole
   * new routing rule extends the key by being part of what is digested, with no
   * edit at the cache.
   *
   * ⚠️ **Declaration ORDER is part of the fingerprint and must not be sorted
   * away.** Two collections that declare the same type in either order produce
   * the same `mime`, but the first match is the one a conflict names, and
   * conflicts are ROWS. Sorting would make two configs that emit different
   * `realization_conditions` share a key.
   *
   * A project declaring no types at all gets {@link NO_DECLARED_MIME_TYPES}, so
   * the overwhelmingly common case is a constant and every such run shares a
   * key with every other.
   */
  readonly fingerprint: string;
}

/**
 * The fingerprint of a routing that no collection contributes to.
 *
 * A literal rather than a digest of the empty list: this is the value nearly
 * every run in existence carries, and it should be legible in a store key
 * someone is debugging rather than being an opaque hash of nothing.
 */
export const NO_DECLARED_MIME_TYPES = 'mime:none-declared';

/** A collection that actually declares a type — the only kind that participates. */
interface DeclaringCollection {
  /** The collection's name, as the config keys it. */
  name: string;
  /** The type it declares — non-optional here, which is the whole filter. */
  mimeType: string;
  /** Its patterns, for {@link matchesCollection}. */
  config: CollectionConfig;
}

/**
 * Build the run's MIME resolver from the project's collections.
 *
 * ## Only a DECLARING collection participates
 *
 * The declaring collections are selected once, up front, and a collection with
 * no `mimeType` is not in the list at all — so it cannot match, cannot win, and
 * cannot conflict. That is the owner's rule stated as a data structure rather
 * than as a check inside the loop, which is what makes it cheap: the common
 * project declares none, `declaring` is empty, and every path costs one table
 * lookup and no pattern match at all.
 *
 * ## One distinct value wins; two are an error the run survives
 *
 * However many collections declare the SAME type, that is the answer. Two
 * distinct values are recorded as a {@link CollectionMimeConflict} and the file
 * takes `mime-type.ts`'s answer for the rest of the run, so the report
 * completes and the caller can fail at the end with every offending file named.
 * Throwing on the first would kill a 9,000-file run on file 400 and hide the
 * other six — a config authoring mistake should read like a linter finding.
 *
 * Parsing one file with two parsers was considered and rejected: a blob has one
 * content key and one set of derived facts, so "both" is not representable.
 *
 * @param collections - The project's `resources.collections`, or undefined
 * @returns A resolver whose {@link CollectionMimeResolver.conflicts} accumulate
 *   across every path it is asked about
 */
export function createCollectionMimeResolver(
  collections: Readonly<Record<string, CollectionConfig>> | undefined,
): CollectionMimeResolver {
  const declaring: DeclaringCollection[] = Object.entries(collections ?? {})
    .flatMap(([name, config]) => (
      config.mimeType === undefined ? [] : [{ name, mimeType: config.mimeType, config }]
    ));
  const conflicts: CollectionMimeConflict[] = [];
  // Keyed on the path, not on the collection pair: one file is one authoring
  // mistake however many extents realize it.
  const reported = new Set<string>();
  // Computed ONCE, off the same `declaring` array the matcher uses, so the
  // fingerprint cannot describe a different rule set from the one that runs.
  // Order preserved deliberately — see {@link CollectionMimeResolver.fingerprint}.
  const fingerprint = declaring.length === 0
    ? NO_DECLARED_MIME_TYPES
    : canonicalJson(declaring.map((candidate) => ({
      name: candidate.name,
      mimeType: candidate.mimeType,
      include: candidate.config.include,
      exclude: candidate.config.exclude ?? null,
    })));

  return {
    conflicts,
    fingerprint,
    mimeFor(absolutePath: string, relativePath: string): string | null {
      const matched = declaring.filter((candidate) => matchesCollection(absolutePath, candidate.config));
      const winner = matched[0];
      if (winner === undefined) {
        return mimeTypeForPath(absolutePath);
      }
      const rival = matched.find((candidate) => candidate.mimeType !== winner.mimeType);
      if (rival === undefined) {
        return winner.mimeType;
      }
      if (!reported.has(relativePath)) {
        reported.add(relativePath);
        conflicts.push({
          path: relativePath,
          collections: [winner.name, rival.name],
          mimeTypes: [winner.mimeType, rival.mimeType],
        });
      }
      return mimeTypeForPath(absolutePath);
    },
  };
}

/**
 * Render one conflict as the `realization_conditions` row that carries it.
 *
 * The projection's existing channel for a collected population-time finding, so
 * a config error is queryable exactly like a path collision or a refused closure
 * candidate rather than living in a channel of its own. The six provenance
 * columns are spread from {@link CONDITION_WITHOUT_REFERENCE}: no reference
 * provoked this, a config file did.
 *
 * The message names the file, both collections and both types, because the fix
 * is an edit to `vibe-agent-toolkit.config.yaml` and an author who has to re-run
 * the tool to find out which two collections disagreed has been told nothing.
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
  const [firstName, secondName] = conflict.collections;
  const [firstType, secondType] = conflict.mimeTypes;
  return {
    extentId,
    path: conflict.path,
    code: COLLECTION_MIME_CONFLICT,
    severity: 'error',
    message: `Collections "${firstName}" and "${secondName}" declare different mimeType values for `
      + `"${conflict.path}": "${firstType}" and "${secondType}". A file has one type and one parser, `
      + 'so make the two declarations agree or drop mimeType from the collection that should not be '
      + 'typing this file. This run used the built-in type table\'s answer for the path so the rest '
      + 'of the report could complete.',
    resourceId,
    ...CONDITION_WITHOUT_REFERENCE,
  };
}
