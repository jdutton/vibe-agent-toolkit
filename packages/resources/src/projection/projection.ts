/**
 * The `Projection` container and the mutable builder that populates it.
 *
 * A projection is nothing but rows: twelve tables, each a flat array, produced
 * by contributors that never interpret one another's output. This module owns
 * two things and deliberately nothing else — the shape of that row set, and the
 * single **population** invariant no individual row can observe.
 *
 * ## `(extentId, path)` is unique, and the loser is recorded rather than dropped
 *
 * `resource_realizations` is keyed by extent and path, so a contributor that
 * would realize a second identity at an occupied path cannot. That is not a
 * theoretical case: `skill-packager.ts:624` and `:1094` record that `a-b/c.html`
 * and `a/b-c.html` both flatten to `a-b-c-html`, and `files:` remapping can
 * produce the same condition. Shipped code observes it exactly once, in
 * `registerBundledAssets`' `DuplicateResourceIdError` catch — which its own
 * comment calls the only place a bundled-asset collision is ever visible.
 *
 * So {@link ProjectionBuilder.addRealization} keeps the first row and emits a
 * {@link RealizationConditionRow} naming the loser. Uniqueness then costs no
 * diagnostic, which is the whole argument for making it an invariant.
 *
 * ## Re-contributing an identical row is a no-op, not a collision
 *
 * The closure stratum runs to a fixpoint, so a contributor re-emits its rows on
 * every iteration. If an identical re-emission counted as a collision, the
 * condition table would grow without bound and the fixpoint would never be
 * reached. A second row at an occupied key is a collision only when it names a
 * *different* identity.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { type GitTracker } from '@vibe-agent-toolkit/utils/git';

import type { KeyedContent, ParserKind } from '../content-key.js';
import { parserKindForMimeType } from '../mime-type.js';
import type {
  BlobConditionRow,
  BlobReferenceRow,
  BlobRow,
  BlobSectionRow,
} from '../schemas/projection-blobs.js';
import { CONDITION_WITHOUT_REFERENCE } from '../schemas/projection-resources.js';
import type {
  ContentState,
  RealizationConditionRow,
  ResourceExtentRow,
  ResourceRealizationRow,
  ResourceRow,
  ResourceTagRow,
  RootRow,
} from '../schemas/projection-resources.js';
import type { ResolutionContextRow, ZoneProvenanceRow } from '../schemas/projection-zones.js';

import { readKeyedContent, type RunContentCache } from './content-cache.js';
import { errorLabel } from './error-label.js';
import { ResourceIdentityMap } from './identity.js';
import type { CollectionMimeResolver } from './realizations.js';

/**
 * Condition code for a second identity offered at an already-realized
 * `(extentId, path)`.
 *
 * `realization_conditions.code` is an open vocabulary, so this is a constant
 * rather than an enum member.
 */
export const REALIZATION_PATH_COLLISION = 'REALIZATION_PATH_COLLISION';

/**
 * Condition code for a demand promotion whose read threw.
 *
 * The counterpart to {@link BLOB_UNREADABLE}, one layer down and for the same
 * reason: `ensureContentKey` rewrites the rows to `unreadable` and returns null,
 * which is a *state* but not a *cause*. Without this row the error's `code`, and
 * the fact that anyone asked at all, are discarded at the `catch` — so a path
 * nobody wanted and a path everybody wanted and could not have produce the same
 * projection.
 *
 * `realization_conditions.code` is an open vocabulary, so this is a constant
 * rather than an enum member.
 */
export const REALIZATION_PROMOTION_UNREADABLE = 'REALIZATION_PROMOTION_UNREADABLE';

/**
 * The kind that means "hand this to no document parser".
 *
 * Spelled here because `content-key.ts` keeps its own copy private; the
 * {@link ParserKind} annotation is the tie, so renaming the kind there stops
 * this line compiling rather than leaving a stale literal behind. Replace with
 * an import the moment that module exports one.
 */
const NO_PARSER_KIND: ParserKind = 'none';

/** Composite-key separator — a NUL can never occur in a path or an id. */
const KEY_SEPARATOR = '\u0000';

/**
 * The twelve materialised tables of the resource projection.
 *
 * `edges`, `edge_resolutions` and `lens_entry_points` are absent on purpose:
 * zones.md §3.2 places them in the derived-per-lens column, so they are the
 * output of evaluating a lens rather than rows anything populates. Declaring
 * empty slots for them would state the opposite.
 */
export interface Projection {
  /** Federated corpus roots. */
  readonly roots: readonly RootRow[];
  /** One row per identity, however many paths realize it. */
  readonly resources: readonly ResourceRow[];
  /** One row per `(extentId, path)` — the table the uniqueness invariant guards. */
  readonly resourceRealizations: readonly ResourceRealizationRow[];
  /** Extent memberships. */
  readonly resourceExtents: readonly ResourceExtentRow[];
  /** Open-vocabulary tags. */
  readonly resourceTags: readonly ResourceTagRow[];
  /** Population-time conditions, chiefly path collisions. */
  readonly realizationConditions: readonly RealizationConditionRow[];
  /** Zone entities — extents and lenses. */
  readonly resolutionContexts: readonly ResolutionContextRow[];
  /** Which contributor produced which extent, and the digest that makes runs comparable. */
  readonly zoneProvenance: readonly ZoneProvenanceRow[];
  /** Blob-keyed measurements. */
  readonly blobs: readonly BlobRow[];
  /** Blob-keyed reference candidates. */
  readonly blobReferences: readonly BlobReferenceRow[];
  /** Blob-keyed heading tree. */
  readonly blobSections: readonly BlobSectionRow[];
  /** Blob-keyed parse conditions. */
  readonly blobConditions: readonly BlobConditionRow[];
}

/**
 * The read-only view a contributor is handed.
 *
 * zones.md §7.1 requires that no contributor call into `resources` internals: a
 * contributor reads rows and returns rows. This type is that seam — every table
 * as a `readonly` array, plus the corpus root and the shared identity map a
 * contributor needs to mint ids consistently with everyone else. No mutator is
 * reachable through it.
 *
 * The arrays are **live**, not snapshots: the merge driver hands the same base
 * to successive strata, and a closure contributor must see what the base
 * stratum contributed. Copying twelve tables per contributor per fixpoint
 * iteration would be the alternative, and it buys nothing the `readonly` types
 * do not already state.
 */
export interface ProjectionBase extends Projection {
  /** Absolute corpus root every path in this projection is relative to. */
  readonly root: string;
  /** Shared identity minting, memoized across contributors. */
  readonly identities: ResourceIdentityMap;
  /**
   * The run's git oracle, or absent outside a repository.
   *
   * Shared rather than per-contributor: a `GitTracker` costs a `git ls-files`
   * spawn to initialize, and every contributor asking the same question would
   * pay it again.
   *
   * **Without this, `resource_realizations.gitignored` is a dead column.** The
   * git extent emits only tracked ∪ (untracked ∧ ¬ignored), so every row it
   * produces is `gitignored: false` *by construction* — it is structurally
   * incapable of observing an ignored path. The filesystem extent is the only
   * base contributor that ever sees one, so if it cannot reach a tracker,
   * nothing in the projection is ever `gitignored: true` and the
   * visible-to-you/invisible-to-CI rung the column exists for cannot be built.
   */
  readonly gitTracker?: GitTracker | undefined;
  /**
   * The run's content cache, or absent for a builder assembled without one.
   *
   * Shared for the same reason `gitTracker` is: most files are realized by
   * several contributors, and every one of them keying the bytes again is a
   * whole extra traversal of the corpus. It is on the base rather than passed to
   * `contribute` because the blob-derivation stage — which is not a contributor
   * — has to read through the *same* cache for its read to be the base's read.
   *
   * A contributor never constructs one: the lifetime is the population's, and a
   * per-contributor cache would reintroduce exactly the cross-extent re-read it
   * exists to remove.
   */
  readonly contentCache?: RunContentCache | undefined;
  /**
   * The run's parse routing, or absent when nothing declared a type.
   *
   * Shared for the third time for the same reason as the two above, plus one
   * that is correctness rather than cost: the resolver ACCUMULATES conflicts, so
   * two extents realizing one mistyped file must consult the *same* instance or
   * a three-extent population reports one authoring mistake three times.
   *
   * Absent means "type every path from `mime-type.ts`'s tables", which is what
   * every project that declares no `mimeType` gets — i.e. nearly all of them.
   */
  readonly mimeResolver?: CollectionMimeResolver | undefined;
}

/** Derives a table's composite key from a row. */
type RowKey<T> = (row: T) => string;

/**
 * One table: insertion-ordered rows plus a key index.
 *
 * Twelve near-identical `add` implementations would be twelve places for the
 * de-duplication rule to drift, so there is one, parameterised by the key.
 */
class ProjectionTable<T> {
  readonly #rows: T[] = [];
  readonly #byKey = new Map<string, T>();
  readonly #keyOf: RowKey<T>;
  readonly #replaceOnConflict: boolean;

  /**
   * @param keyOf - Derives the composite key this table de-duplicates on
   * @param replaceOnConflict - Overwrite the occupant instead of keeping it
   */
  constructor(keyOf: RowKey<T>, replaceOnConflict = false) {
    this.#keyOf = keyOf;
    this.#replaceOnConflict = replaceOnConflict;
  }

  /** The live row array. Read-only by type; never reassigned. */
  get rows(): readonly T[] {
    return this.#rows;
  }

  /**
   * Record a row unless its key is already occupied.
   *
   * @param row - The row to record
   * @returns The occupying row when this one was rejected, otherwise undefined
   */
  add(row: T): T | undefined {
    const key = this.#keyOf(row);
    const occupant = this.#byKey.get(key);
    if (occupant === undefined) {
      this.#byKey.set(key, row);
      this.#rows.push(row);
      return undefined;
    }
    if (!this.#replaceOnConflict) {
      return occupant;
    }
    this.#replaceInPlace(key, occupant, row);
    return undefined;
  }

  /**
   * Overwrite the row already filed under this row's key.
   *
   * Distinct from `add` on a `replaceOnConflict` table, and deliberately so: an
   * absent key is a **failure** here rather than an insert. The only caller is
   * {@link ProjectionBuilder.ensureContentKey}, which is rewriting a row it has
   * already read out of this table — an insert there would mean it invented a
   * realization at a path no contributor realized, which is precisely what the
   * `(extentId, path)` invariant exists to make impossible.
   *
   * `resource_realizations` therefore stays `replaceOnConflict: false`: making
   * it replace-on-add would silently turn every duplicate contribution into an
   * overwrite and delete the collision diagnostic.
   *
   * @param row - The replacement row, whose key must already be occupied
   * @returns True when a row was replaced, false when the key was vacant
   */
  replace(row: T): boolean {
    const key = this.#keyOf(row);
    const occupant = this.#byKey.get(key);
    if (occupant === undefined) {
      return false;
    }
    this.#replaceInPlace(key, occupant, row);
    return true;
  }

  /** A frozen copy, for a built projection that must not change afterwards. */
  snapshot(): readonly T[] {
    return Object.freeze([...this.#rows]);
  }

  /**
   * Swap `occupant` for `row` without disturbing insertion order.
   *
   * Linear in the table, which is affordable for its two callers: the
   * provenance table holds one row per `(context, contributor)`, and content
   * promotion touches one path's rows. Position is preserved rather than
   * push-after-delete because the export layer's sort is by primary key, and a
   * table whose insertion order moved under a rewrite would make two runs that
   * promoted different paths produce different unsorted tables.
   *
   * @param key - The composite key both rows share
   * @param occupant - The row currently held
   * @param row - The row to hold instead
   */
  #replaceInPlace(key: string, occupant: T, row: T): void {
    const at = this.#rows.indexOf(occupant);
    if (at !== -1) {
      this.#rows[at] = row;
    }
    this.#byKey.set(key, row);
  }
}

/**
 * Accumulates rows into a {@link Projection}, enforcing the one population
 * invariant a single row cannot observe.
 *
 * Every `add*` method is idempotent: re-adding a row whose key is already
 * present changes nothing and reports `false`.
 *
 * {@link ProjectionBuilder.ensureContentKey} is the one method that **rewrites**
 * a row rather than adding one, and it is confined to a single transition:
 * `deferred` → `keyed`/`unreadable` on `resource_realizations`. No other column
 * moves, and no row is created — so the `(extentId, path)` invariant above is
 * untouched by it.
 */
export class ProjectionBuilder {
  /** Shared identity minting for this root. */
  readonly identities: ResourceIdentityMap;

  readonly #root: string;
  readonly #roots = new ProjectionTable<RootRow>((row) => row.id);
  readonly #resources = new ProjectionTable<ResourceRow>((row) => row.resourceId);
  readonly #realizations = new ProjectionTable<ResourceRealizationRow>(
    (row) => compositeKey(row.extentId, row.path),
  );
  readonly #extents = new ProjectionTable<ResourceExtentRow>(
    (row) => compositeKey(row.resourceId, row.extentId),
  );
  readonly #tags = new ProjectionTable<ResourceTagRow>(
    (row) => compositeKey(row.resourceId, row.tag, row.value, row.source),
  );
  readonly #realizationConditions = new ProjectionTable<RealizationConditionRow>(
    (row) => compositeKey(row.extentId, row.path, row.code, row.resourceId),
  );
  readonly #contexts = new ProjectionTable<ResolutionContextRow>((row) => row.contextId);
  // Replaces rather than keeps: a closure contributor re-runs to a fixpoint, and
  // the digest that describes its final extent is the last one it produced. A
  // kept-first digest would describe iteration one and §7.4's convergence oracle
  // would compare the wrong extents.
  readonly #provenance = new ProjectionTable<ZoneProvenanceRow>(
    (row) => compositeKey(row.contextId, row.contributorId),
    true,
  );
  readonly #blobs = new ProjectionTable<BlobRow>((row) => row.contentKey);
  readonly #blobReferences = new ProjectionTable<BlobReferenceRow>(
    (row) => compositeKey(row.blob, row.ordinal),
  );
  readonly #blobSections = new ProjectionTable<BlobSectionRow>(
    (row) => compositeKey(row.blob, row.ordinal),
  );
  readonly #blobConditions = new ProjectionTable<BlobConditionRow>(
    (row) => compositeKey(row.blob, row.code, row.line, row.message),
  );

  readonly #gitTracker: GitTracker | undefined;

  readonly #contentCache: RunContentCache | undefined;

  #base: ProjectionBase | undefined;

  #contentPromotions = 0;

  #contentPromotionAttempts = 0;

  readonly #mimeResolver: CollectionMimeResolver | undefined;

  /**
   * An options object rather than positionals: the run inputs a builder shares
   * with every contributor are a growing set (root, git oracle, content cache,
   * parse routing), three of the four are optional, and a fourth positional
   * would make the call site a row of `undefined`s that nothing names. There is
   * exactly ONE production call site — `merge.ts`'s `populate()` — so the shape
   * costs nothing to change and is worth getting right before a fifth arrives.
   *
   * @param options - The run's root and its shared oracles
   */
  constructor(options: {
    /** Absolute corpus root. */
    root: string;
    /** Optional git oracle supplying index casing to identity minting. */
    gitTracker?: GitTracker | undefined;
    /**
     * Optional per-run read-and-key memo, shared with every contributor and with
     * the blob-derivation stage. Omitted by a caller assembling a builder by
     * hand that wants each read to touch disk.
     */
    contentCache?: RunContentCache | undefined;
    /**
     * The run's collection-declared parse routing, or omitted to type every
     * path from `mime-type.ts`'s tables alone.
     */
    mimeResolver?: CollectionMimeResolver | undefined;
  }) {
    this.#root = options.root;
    this.#gitTracker = options.gitTracker;
    this.#contentCache = options.contentCache;
    this.#mimeResolver = options.mimeResolver;
    this.identities = new ResourceIdentityMap(options.root, options.gitTracker);
  }

  /**
   * Record a corpus root.
   *
   * @param row - The root row
   * @returns True when recorded, false when this root id was already present
   */
  addRoot(row: RootRow): boolean {
    return this.#roots.add(row) === undefined;
  }

  /**
   * Record an identity.
   *
   * @param row - The resource row
   * @returns True when recorded, false when this identity was already present
   */
  addResource(row: ResourceRow): boolean {
    return this.#resources.add(row) === undefined;
  }

  /**
   * Record one path in one extent, enforcing `(extentId, path)` uniqueness.
   *
   * A second row for the identity already at that key is an idempotent re-
   * observation and is silently ignored. A row naming a *different* identity is
   * a collision: the first row stands and a {@link REALIZATION_PATH_COLLISION}
   * condition records the loser, so the fact survives the invariant.
   *
   * @param row - The realization row
   * @returns True when recorded, false when the path was already occupied
   */
  addRealization(row: ResourceRealizationRow): boolean {
    const occupant = this.#realizations.add(row);
    if (occupant === undefined) {
      return true;
    }
    if (occupant.resourceId !== row.resourceId) {
      this.addCondition({
        extentId: row.extentId,
        path: row.path,
        code: REALIZATION_PATH_COLLISION,
        severity: 'error',
        message: collisionMessage(occupant.resourceId, row.resourceId, row.extentId, row.path),
        resourceId: row.resourceId,
        ...CONDITION_WITHOUT_REFERENCE,
      });
    }
    return false;
  }

  /**
   * How many paths this builder has promoted from `deferred` to `keyed`.
   *
   * Monotonic, and counted **per path** rather than per row: promoting a path
   * realized in three extents rewrites three rows but is one act of reading
   * bytes, and the only consumer — the merge driver deciding whether the blob
   * stage has new work — is asking about reads, not rows.
   *
   * A read that threw is not a promotion: it rewrites the rows to `unreadable`
   * and leaves this untouched, because no new content key entered the
   * projection and re-deriving blobs would find nothing.
   *
   * ⚠️ **Not on its own a record that promotion was attempted** — see
   * {@link contentPromotionAttempts}, which is the counter that separates
   * "nobody asked" from "everybody asked and every read failed". Reading this
   * one alone is what made those two runs emit an identical signal.
   */
  get contentPromotions(): number {
    return this.#contentPromotions;
  }

  /**
   * How many paths this builder has **tried** to promote by reading their bytes.
   *
   * The denominator {@link contentPromotions} is the numerator of, and the whole
   * reason it exists separately: a promotion that throws leaves
   * `contentPromotions` untouched, so a driver comparing only that counter reads
   * "every read failed" as "nobody asked" and reports the deliberate no-op. Two
   * outcomes that differ by an entire corpus of unreadable files must not emit
   * one signal.
   *
   * Counted on the same unit — **per path**, once per act of reading bytes — so
   * `attempts - promotions` is exactly the number of paths whose read threw, and
   * each of those carries a {@link REALIZATION_PROMOTION_UNREADABLE} row naming
   * the cause.
   *
   * A path with nothing `deferred` performs no read and is therefore not an
   * attempt: `ensureContentKey` returns the key it already had, which is not a
   * question this counter was asked.
   */
  get contentPromotionAttempts(): number {
    return this.#contentPromotionAttempts;
  }

  /**
   * Key a path's bytes on demand, promoting every `deferred` realization of it.
   *
   * The counterpart to `contentDemand` (see `realizations.ts`): a contributor
   * that declines to hash a path still records the row, and this is the door
   * through which a later consumer buys the hash it skipped. Nothing else in the
   * projection can turn a null `contentKey` into a real one.
   *
   * ## What it does, exactly
   *
   * - `path` is **root-relative**, the same spelling `resource_realizations.path`
   *   carries; `safePath.join(root, path)` is that column's total inverse, which
   *   is what `blob-population.ts`'s `readTarget` already relies on.
   * - **Every** row at that path is considered, not the first: a path realized
   *   in the filesystem extent and a package extent is two rows, and promoting
   *   one while leaving the other `deferred` would make the answer depend on
   *   which extent a consumer happened to join through.
   * - The read goes through the run's {@link RunContentCache} with the
   *   realization's OWN `mime` column choosing the kind — byte-for-byte the read
   *   `collectRealization` would have made — so the bytes really are shared with
   *   the rest of the run rather than being a second traversal wearing the same
   *   key. Re-deriving the kind from the path instead is the one thing that
   *   breaks that equivalence, because `mime` may have come from a collection's
   *   declared `mimeType` rather than from the extension tables.
   * - A read that throws rewrites the rows to `unreadable` with a null key,
   *   records a {@link REALIZATION_PROMOTION_UNREADABLE} condition per rewritten
   *   row carrying the error's label, and still counts as an
   *   {@link contentPromotionAttempts attempt}. An unreadable file is a fact
   *   about the corpus, and leaving the rows `deferred` would claim nobody had
   *   asked yet, which would be false. Swallowing the error on top of that used
   *   to make the failure indistinguishable from the deliberate no-op — the
   *   state column said `unreadable`, but no row said why and no counter said
   *   anyone had tried.
   *
   * ## Idempotent, and observably so
   *
   * A path with no `deferred` rows performs **no read at all** and returns the
   * key it already has (or null when its rows are `none`/`unreadable`). Calling
   * it twice therefore costs one read, which is asserted against
   * `RunContentCache.stats.misses` rather than by inspection — a memo's
   * correctness that nothing measures is a claim, not a property.
   *
   * @param path - Root-relative path, as `resource_realizations.path` spells it
   * @returns The content key now on the rows at that path, or null when there is
   *   none to have
   */
  async ensureContentKey(path: string): Promise<string | null> {
    const rows = this.#realizations.rows.filter((row) => row.path === path);
    const deferred = rows.filter((row) => row.contentState === 'deferred');
    // Destructured rather than length-tested so the row whose `mime` routes the
    // read below is the same one the guard proved exists — no non-null assertion
    // standing in for a check already made.
    const [routing] = deferred;
    if (routing === undefined) {
      // Already keyed, or definitively keyless. Either way there is nothing to
      // buy, and buying it again is the read this method exists to avoid.
      return rows.find((row) => row.contentState === 'keyed')?.contentKey ?? null;
    }

    // Counted BEFORE the read, so a throw cannot skip it. This is the fact the
    // bare `catch` used to destroy: without it the driver's only evidence that
    // promotion happened at all is `#contentPromotions`, which a failed read
    // leaves untouched — making "nobody asked" and "everybody asked and every
    // read failed" the same number.
    this.#contentPromotionAttempts += 1;

    const absolutePath = safePath.join(this.#root, path);
    let keyed: KeyedContent;
    try {
      keyed = await readKeyedContent(
        absolutePath,
        // The ROW's own type, never re-derived from the path. `mime` can come
        // from a collection's declared `mimeType`, which overrides the
        // extension tables — so `parserKindForPath` here would key a `.ts` file
        // a collection typed `text/markdown` as `none.<digest>` while its own
        // `mime` column said prose. Every downstream stage reads the kind back
        // off that prefix, so the two contradicting each other is the
        // well-formed-entry-with-the-wrong-contents class `content-key.ts`
        // exists to rule out. `realizations.ts`'s `keyOrState` routes the
        // eager path the same way; this is the deferred path's copy of that
        // one decision.
        //
        // The FIRST deferred row types the read for all of them, which is sound
        // because typing is a function of the path and the run's single
        // `CollectionMimeResolver` — not of the extent. Two rows at one path
        // cannot disagree unless a caller hands two extents two different
        // resolvers, and that population is already broken one layer up: this
        // method writes ONE key onto every row it promotes, so a per-row kind
        // would have nothing to write.
        parserKindForMimeType(routing.mime) ?? NO_PARSER_KIND,
        this.#contentCache,
      );
    } catch (error) {
      // A row per extent that deferred this path, not one row for the path: a
      // condition is keyed on `(extentId, path)` like the realization it is
      // about, and a single row would leave the other extents' realizations
      // `unreadable` with nothing saying why.
      //
      // The same standard `blob-population.ts`'s `readTarget` sets: count it,
      // record the cause with `errorLabel` (never `String(error)` — an `fs`
      // message carries the absolute path, and every other column here is
      // root-relative), and say why the rows that follow are absent.
      for (const row of deferred) {
        this.addCondition({
          extentId: row.extentId,
          path: row.path,
          code: REALIZATION_PROMOTION_UNREADABLE,
          severity: 'warning',
          message:
            `The bytes for "${row.path}" were demanded by a consumer and could not be read`
            + ` (${errorLabel(error)}); this realization is "unreadable" rather than "deferred"`
            + ' because it was asked for, and it has no content key because the read failed,'
            + ' not because nobody wanted one',
          resourceId: row.resourceId,
          ...CONDITION_WITHOUT_REFERENCE,
        });
      }
      this.#rewriteRealizations(deferred, null, 'unreadable');
      return null;
    }

    this.#rewriteRealizations(deferred, keyed.key, 'keyed');
    this.#contentPromotions += 1;
    return keyed.key;
  }

  /**
   * Record an extent membership.
   *
   * @param row - The membership row
   * @returns True when recorded, false when this membership was already present
   */
  addExtentMembership(row: ResourceExtentRow): boolean {
    return this.#extents.add(row) === undefined;
  }

  /**
   * Record a tag.
   *
   * @param row - The tag row
   * @returns True when recorded, false when this exact tag was already present
   */
  addTag(row: ResourceTagRow): boolean {
    return this.#tags.add(row) === undefined;
  }

  /**
   * Record a population-time condition.
   *
   * @param row - The condition row
   * @returns True when recorded, false when this exact condition was already present
   */
  addCondition(row: RealizationConditionRow): boolean {
    return this.#realizationConditions.add(row) === undefined;
  }

  /**
   * Record a zone entity.
   *
   * @param row - The resolution-context row
   * @returns True when recorded, false when this context id was already present
   */
  addContext(row: ResolutionContextRow): boolean {
    return this.#contexts.add(row) === undefined;
  }

  /**
   * Record (or refresh) a contributor's provenance for a context.
   *
   * @param row - The provenance row
   * @returns True — a repeat `(contextId, contributorId)` replaces its predecessor
   */
  addProvenance(row: ZoneProvenanceRow): boolean {
    return this.#provenance.add(row) === undefined;
  }

  /**
   * Record a blob measurement.
   *
   * @param row - The blob row
   * @returns True when recorded, false when this content key was already present
   */
  addBlob(row: BlobRow): boolean {
    return this.#blobs.add(row) === undefined;
  }

  /**
   * Record a reference candidate.
   *
   * @param row - The reference row
   * @returns True when recorded, false when this `(blob, ordinal)` was already present
   */
  addBlobReference(row: BlobReferenceRow): boolean {
    return this.#blobReferences.add(row) === undefined;
  }

  /**
   * Record a section.
   *
   * @param row - The section row
   * @returns True when recorded, false when this `(blob, ordinal)` was already present
   */
  addBlobSection(row: BlobSectionRow): boolean {
    return this.#blobSections.add(row) === undefined;
  }

  /**
   * Record a parse-time condition.
   *
   * @param row - The blob-condition row
   * @returns True when recorded, false when this exact condition was already present
   */
  addBlobCondition(row: BlobConditionRow): boolean {
    return this.#blobConditions.add(row) === undefined;
  }

  /**
   * Restamp a set of realization rows with one `(contentKey, contentState)` pair.
   *
   * The two columns are written together and never separately: the schema pins
   * `keyed` ⟺ non-null in both directions, so a helper that could set one
   * without the other would be a way to build a row the schema rejects.
   *
   * @param rows - Rows already present in the table, to be replaced in place
   * @param contentKey - The key to stamp, or null
   * @param contentState - The state that key implies
   */
  #rewriteRealizations(
    rows: readonly ResourceRealizationRow[],
    contentKey: string | null,
    contentState: ContentState,
  ): void {
    for (const row of rows) {
      this.#realizations.replace({ ...row, contentKey, contentState });
    }
  }

  /**
   * The read-only view handed to contributors.
   *
   * Memoized, and live without any getter indirection: each table's row array is
   * a stable reference that is only ever pushed to, so holding it *is* holding
   * the live table. A contributor invoked in a later stratum therefore sees
   * everything earlier strata contributed through the same object.
   *
   * @returns The contributor-facing base projection
   */
  base(): ProjectionBase {
    this.#base ??= {
      root: this.#root,
      identities: this.identities,
      // Conditional spread, not `gitTracker: this.#gitTracker`:
      // `exactOptionalPropertyTypes` distinguishes an absent key from one
      // holding `undefined`, and the field is declared optional.
      ...(this.#gitTracker !== undefined && { gitTracker: this.#gitTracker }),
      ...(this.#contentCache !== undefined && { contentCache: this.#contentCache }),
      ...(this.#mimeResolver !== undefined && { mimeResolver: this.#mimeResolver }),
      roots: this.#roots.rows,
      resources: this.#resources.rows,
      resourceRealizations: this.#realizations.rows,
      resourceExtents: this.#extents.rows,
      resourceTags: this.#tags.rows,
      realizationConditions: this.#realizationConditions.rows,
      resolutionContexts: this.#contexts.rows,
      zoneProvenance: this.#provenance.rows,
      blobs: this.#blobs.rows,
      blobReferences: this.#blobReferences.rows,
      blobSections: this.#blobSections.rows,
      blobConditions: this.#blobConditions.rows,
    };
    return this.#base;
  }

  /**
   * Freeze the accumulated rows into an immutable projection.
   *
   * Copies rather than freezing in place, so the builder stays usable — the
   * merge driver builds intermediate projections between strata.
   *
   * @returns The frozen projection
   */
  build(): Projection {
    return Object.freeze({
      roots: this.#roots.snapshot(),
      resources: this.#resources.snapshot(),
      resourceRealizations: this.#realizations.snapshot(),
      resourceExtents: this.#extents.snapshot(),
      resourceTags: this.#tags.snapshot(),
      realizationConditions: this.#realizationConditions.snapshot(),
      resolutionContexts: this.#contexts.snapshot(),
      zoneProvenance: this.#provenance.snapshot(),
      blobs: this.#blobs.snapshot(),
      blobReferences: this.#blobReferences.snapshot(),
      blobSections: this.#blobSections.snapshot(),
      blobConditions: this.#blobConditions.snapshot(),
    });
  }
}

/** Join key parts with a separator no id or path can contain. */
function compositeKey(...parts: readonly (string | number | boolean | null)[]): string {
  return parts.map((part) => String(part)).join(KEY_SEPARATOR);
}

/** The message a path collision records, naming both identities. */
function collisionMessage(
  winner: string,
  loser: string,
  extentId: string,
  path: string,
): string {
  return `Path "${path}" in extent "${extentId}" is already realized by ${winner};`
    + ` ${loser} could not be realized there and is recorded here instead`;
}
