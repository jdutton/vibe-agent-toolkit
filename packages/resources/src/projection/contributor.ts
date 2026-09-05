/**
 * The extent-contributor seam (zones §7.1, §7.4, §7.5).
 *
 * §7.1 fixes the whole signature: *"Contributors read the base projection and
 * return rows; `resources` merges without interpreting. No contributor calls
 * into `resources` internals."* That is `(base, parameters) → rows`, and
 * nothing else. §7.4 fixes what each contributor is additionally accountable
 * for — `(contributorId, parameterSet, extentDigest)`, the three columns
 * `zone_provenance` already ships.
 *
 * Two consequences worth stating, because both look like gaps until you see
 * why they are not:
 *
 * - **The fixpoint is a property of the driver, not of the contributor.** §7.2
 *   iterates the closure stratum until digests stop moving. A contributor
 *   called once and a contributor called five times have the same signature,
 *   so iteration adds no method here.
 * - **The closure primitive is a `parameterSet`, not a new interface.** §7.3's
 *   `closureFrom` / `follow` / `maxDepth` / `exclude` are config data handed to
 *   a *generic* closure contributor. Adding closure-defined extents adds an
 *   instance, not a member.
 */

import type {
  RealizationConditionRow,
  ResourceExtentRow,
  ResourceRealizationRow,
  ResourceRow,
  ResourceTagRow,
} from '../schemas/projection-resources.js';
import type { JsonValue } from '../schemas/projection-shared.js';
import type { ResolutionContextRow } from '../schemas/projection-zones.js';

import type { ProjectionBase } from './projection.js';

export { extentDigest } from './digest.js';

/**
 * Which merge stratum a contributor belongs to (§7.2).
 *
 * `base` contributors are acyclic — what exists on disk, in git, in a package
 * manifest — and run exactly once. `closure` contributors are defined by
 * reachability *through* what other contributors found, so they re-run against
 * the growing base until their {@link extentDigest} stops moving.
 */
export type ContributorStratum = 'base' | 'closure';

/**
 * What a contributor returns: rows only.
 *
 * `resources` merges these without interpreting them — no field here is read
 * for meaning by the driver, which is what keeps "no contributor calls into
 * `resources` internals" true in both directions.
 *
 * Blob-keyed tables are deliberately absent: blobs are derived from bytes by
 * the parse layer and are path-independent, so an extent contributor has
 * nothing to say about them. It says which resources exist, where they are
 * realized, and which extents they belong to.
 */
export interface ExtentContribution {
  /** `resolution_contexts` rows, species `extent` — the extents being declared. */
  contexts: ResolutionContextRow[];
  /** `resources` rows — identities, minted or re-observed. */
  resources: ResourceRow[];
  /** `resource_realizations` rows — one path in one extent. */
  realizations: ResourceRealizationRow[];
  /** `resource_extents` rows — membership, and nothing more. */
  memberships: ResourceExtentRow[];
  /** `resource_tags` rows — the open-vocabulary classification mechanism. */
  tags: ResourceTagRow[];
  /** `realization_conditions` rows — population-time conditions, e.g. a path collision. */
  conditions: RealizationConditionRow[];
}

/**
 * One source of extent membership.
 *
 * The filesystem, git and package extents are the first three instances; the
 * generic closure contributor (§7.3) is the fourth, and skill / plugin /
 * marketplace extents are that fourth one parameterised by config rather than
 * new implementations.
 */
export interface ExtentContributor {
  /** Stable identity — `zone_provenance.contributorId` keys on it, so it must be unique. */
  readonly id: string;
  /** The `resolution_contexts.kind` this contributor populates. Open vocabulary. */
  readonly kind: string;
  /** Which stratum the merge driver runs it in. */
  readonly stratum: ContributorStratum;
  /**
   * Whether this contributor reads the blob-keyed tables off the base.
   *
   * **Declared, not inferred from {@link stratum}.** Every blob reader VAT ships
   * today happens to be a `closure` contributor, so stratum would work as a
   * proxy right up until it silently stopped working — a base contributor that
   * reads `blob_references` would be handed empty tables and would report a
   * complete, empty extent, which is the exact failure `blob-population.ts`
   * exists to prevent.
   *
   * Required rather than optional, and for the same reason: an optional field
   * defaults to `false`, which is the dangerous direction. A new contributor's
   * author has to answer the question.
   *
   * It is what {@link PopulateOptions.contentParsing} `'skip'` is checked against — a run
   * that declines to derive blobs while something registered reads them is a
   * loud error, never a degraded extent. A wrapper around another contributor
   * (the skill, plugin and inventory extents all wrap
   * `ClosureExtentContributor`) must **delegate** this rather than restate it,
   * or the two can drift apart.
   */
  readonly readsBlobs: boolean;
  /**
   * Registration-time state that changes the rows this contributor produces,
   * and which its parameter set does not name.
   *
   * ## Why this exists at all — the hole it closes was measured, not imagined
   *
   * The reuse rule reads a stored extent as an answer to `(contributorId,
   * parameterSet)`. That pair is the *whole* question only while every input a
   * contributor reads reaches it through one of the two. A constructor argument
   * reaches it through neither, so two registrations of one class, under one id,
   * under one parameter set, can produce materially different rows and be served
   * each other's answer.
   *
   * `FilesystemExtentContributor`'s `contentDemand` is that argument.
   * `DECLINE_IGNORED`'s docstring places it in the constructor on the grounds
   * that it "changes what a row *says* (`contentState`), never which rows
   * exist" — which is true, and incomplete in one direction. A `'deferred'`
   * registration keys nothing, so `keyedContentKeys` returns the empty list and
   * `blobFactsCover` — the guard that stops a blob-reading run accepting a
   * content-less extent — passes **vacuously**, having no keys to fail on. The
   * deriving run then hydrates four empty blob tables and reports success.
   *
   * ⇒ Whatever a contributor learns at construction and cannot state in a
   * parameter set is declared here, and {@link storeKeyFor} folds it into the
   * key beside the run's other ambient inputs.
   *
   * ## Optional, and here that is the SAFE direction
   *
   * Unlike {@link readsBlobs}, whose absent value would be an *assertion* about
   * a contributor nobody checked, an absent value here adds nothing to a key
   * that already separates on everything else. It cannot admit a hit that would
   * otherwise miss; it can only fail to separate one the author never declared.
   * So a contributor whose constructor takes nothing — or whose arguments are
   * already folded into its {@link id}, as `ClosureExtentContributor`'s are —
   * correctly says nothing.
   */
  readonly registrationQuestion?: JsonValue | undefined;
  /**
   * Produce this contributor's rows against the projection built so far.
   *
   * @param base - Read-only view of everything merged before this invocation
   * @param parameters - The parameter set this run is scoped by, verbatim from
   *   config; recorded on `zone_provenance.parameterSet`
   * @returns The rows to merge
   */
  contribute(base: ProjectionBase, parameters: JsonValue): Promise<ExtentContribution>;
}

/**
 * The set of contributors a population run draws on.
 *
 * Two rules, both of which exist to make a wrong answer impossible rather than
 * merely unlikely:
 *
 * - **{@link forKind} throws when nothing is registered** (§7.5). Returning an
 *   empty array would let a caller ask for the marketplace extent, receive
 *   nothing, and report a complete, empty extent — a confident wrong answer.
 * - **{@link register} refuses a duplicate id.** Provenance keys on
 *   `contributorId`, so two contributors sharing one id make two extents
 *   indistinguishable in `zone_provenance` and silently collapse a digest
 *   comparison.
 */
export class ContributorRegistry {
  readonly #byId = new Map<string, ExtentContributor>();

  /**
   * Add a contributor.
   *
   * @param contributor - The contributor to register
   * @throws When a contributor with the same id is already registered
   */
  register(contributor: ExtentContributor): void {
    if (this.#byId.has(contributor.id)) {
      throw new Error(
        `Contributor id "${contributor.id}" is already registered. Ids are unique because zone_provenance.contributorId keys on them.`,
      );
    }
    this.#byId.set(contributor.id, contributor);
  }

  /**
   * Every contributor registered for a zone kind, in registration order.
   *
   * @param kind - A `resolution_contexts.kind` value
   * @returns The contributors populating that kind — never empty
   * @throws When no contributor is registered for the kind
   */
  forKind(kind: string): ExtentContributor[] {
    const matches = [...this.#byId.values()].filter((contributor) => contributor.kind === kind);
    if (matches.length === 0) {
      throw new Error(
        `No extent contributor is registered for kind "${kind}". An empty extent is a confident wrong answer, so this is an error rather than an empty result.`,
      );
    }
    return matches;
  }

  /**
   * Every contributor in a stratum, in registration order.
   *
   * The driver's partition: `base` runs once, `closure` iterates to a fixpoint.
   *
   * @param stratum - The stratum to select
   * @returns The contributors in that stratum, possibly empty — a run with no
   *   closure contributors is ordinary, unlike a kind with none
   */
  byStratum(stratum: ContributorStratum): ExtentContributor[] {
    return [...this.#byId.values()].filter((contributor) => contributor.stratum === stratum);
  }

  /**
   * Every registered contributor that declares it reads the blob-keyed tables.
   *
   * The contributors themselves rather than a boolean, so the driver's error can
   * name which registration made a `'skip'` request unsatisfiable — "something
   * reads blobs" sends the reader back to grep the registry, and the whole point
   * of {@link ExtentContributor.readsBlobs} being declared is that the answer is
   * already written down.
   *
   * @returns The blob readers, in registration order, possibly empty
   */
  blobReaders(): ExtentContributor[] {
    return [...this.#byId.values()].filter((contributor) => contributor.readsBlobs);
  }
}
