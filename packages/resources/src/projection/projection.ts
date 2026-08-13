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

import type { GitTracker } from '@vibe-agent-toolkit/utils';

import type {
  BlobConditionRow,
  BlobReferenceRow,
  BlobRow,
  BlobSectionRow,
} from '../schemas/projection-blobs.js';
import type {
  RealizationConditionRow,
  ResourceExtentRow,
  ResourceRealizationRow,
  ResourceRow,
  ResourceTagRow,
  RootRow,
} from '../schemas/projection-resources.js';
import type { ResolutionContextRow, ZoneProvenanceRow } from '../schemas/projection-zones.js';

import { ResourceIdentityMap } from './identity.js';

/**
 * Condition code for a second identity offered at an already-realized
 * `(extentId, path)`.
 *
 * `realization_conditions.code` is an open vocabulary, so this is a constant
 * rather than an enum member.
 */
export const REALIZATION_PATH_COLLISION = 'REALIZATION_PATH_COLLISION';

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
    // Linear, but only the provenance table replaces, and it holds one row per
    // (context, contributor). Replacing in place keeps insertion order stable.
    const at = this.#rows.indexOf(occupant);
    if (at !== -1) {
      this.#rows[at] = row;
    }
    this.#byKey.set(key, row);
    return undefined;
  }

  /** A frozen copy, for a built projection that must not change afterwards. */
  snapshot(): readonly T[] {
    return Object.freeze([...this.#rows]);
  }
}

/**
 * Accumulates rows into a {@link Projection}, enforcing the one population
 * invariant a single row cannot observe.
 *
 * Every `add*` method is idempotent: re-adding a row whose key is already
 * present changes nothing and reports `false`.
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

  #base: ProjectionBase | undefined;

  /**
   * @param root - Absolute corpus root
   * @param gitTracker - Optional git oracle supplying index casing to identity minting
   */
  constructor(root: string, gitTracker?: GitTracker | undefined) {
    this.#root = root;
    this.#gitTracker = gitTracker;
    this.identities = new ResourceIdentityMap(root, gitTracker);
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
      });
    }
    return false;
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
