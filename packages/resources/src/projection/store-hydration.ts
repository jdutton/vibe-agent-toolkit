/**
 * Turning what a {@link ProjectionStore} holds back into a {@link Projection} —
 * and, first, deciding whether it holds enough.
 *
 * `store.ts` states the storage contract; this module states the **reuse rule**,
 * and it is deliberately not inside the store. A backend knows rows; only the
 * driver knows what this run asked. Putting the decision here means every
 * backend answers the same question the same way, and a second backend cannot
 * quietly relax it.
 *
 * ## The reuse rule, in one line
 *
 * A stored extent serves a run when **every contributor the run registered
 * already has a `zone_provenance` row under that key, recorded under the same
 * `parameterSet`.**
 *
 * `ExtentKey` names a tree; it does not name a *question*. Two commands over one
 * tree ask different questions of it — `vat inventory` declares the filesystem
 * extent plus one closure extent per skill, `vat resources scan` declares the
 * filesystem extent alone — so the key alone cannot say whether a stored answer
 * covers this run. `zone_provenance` can, because it is exactly the record of
 * *which contributor ran under which parameters*, which is what a run is.
 *
 * The parameter set is compared and not merely the id, because §7.3's closure
 * primitive is a generic contributor handed a declaration: two runs registering
 * `inventory-extent:skills/foo/SKILL.md` under different `maxDepth` values are
 * two different questions wearing one id, and reusing one for the other returns
 * a confidently wrong membership.
 *
 * ## What a hit returns: the requested contexts, and their reachable rows
 *
 * A hit does **not** hand back everything stored under the key. Another command
 * may have written its own closure extents there — that is the entire point of
 * {@link ProjectionStore.writeExtent} being additive — and a caller that
 * enumerated them would see paths no contributor of its own realized.
 * `buildResourcePopulation` is precisely such a caller: it walks
 * `resourceRealizations` with no extent filter at all, so a superset hydration
 * would hand `vat resources scan` every skill extent's re-realization of the
 * same files.
 *
 * So {@link selectRequestedContexts} keeps only rows belonging to the contexts
 * the run's own contributors declared. The three tables with no
 * {@link ProjectionTableSpec.contextColumn} cannot be partitioned that way and
 * are not stored per-context either, so they are recovered by **reachability**:
 *
 * | table | kept when |
 * |---|---|
 * | `roots` | it is this run's root, or a kept context names it |
 * | `resources` | a kept realization or membership names the identity |
 * | `resourceTags` | a kept realization or membership names the identity |
 *
 * That reconstruction is a claim, and the claim is falsifiable rather than
 * argued: `exportProjection` emits a byte-identical document from a projection,
 * so "hydrated == populated" is a diff of two strings and is asserted as one.
 *
 * ## Why the blob tier is checked rather than trusted
 *
 * The blob tier is written by whoever derived it, and a run may legitimately
 * decline to derive it (`PopulateOptions.blobs` = `'skip'` — `vat resources
 * scan` reads no blob table and the stage is ~90% of its cold cost). Such a run
 * still writes its extent, which is what lets the next command share the
 * enumeration — but that extent's realizations name content keys the blob tier
 * may not hold.
 *
 * A later run that *does* read blob tables must not accept it. Under an empty
 * `blob_references`, `ClosureExtentContributor` reduces every closure extent to
 * its own declared root, the fixpoint converges on iteration one, and the run
 * reports success — the exact silent-emptiness failure `blob-population.ts`
 * exists to prevent, arriving through the cache instead.
 *
 * {@link blobFactsCover} is the guard, and it needs no new metadata: the
 * derivation stage accounts for **every** keyed content key, with a `blobs` row
 * when it parsed and a `blobConditions` row when it declined to (unreadable,
 * changed underneath, or binary). A key with neither is a key the store never
 * derived, and one such key makes the whole extent a miss.
 */

import { canonicalJson } from './digest.js';
import type { Projection } from './projection.js';
import type { BlobScopedRows, ExtentScopedRows } from './store.js';
import { PROJECTION_TABLES } from './table-registry.js';

/**
 * One contributor a run registered, and the parameters it will run under.
 *
 * The pair, never the id alone — see this module's header on why a shared id
 * under two parameter sets is two questions.
 */
export interface RequestedContributor {
  /** {@link ExtentContributor.id}. */
  readonly id: string;
  /** The parameter set this run will hand it, exactly as `populate()` resolved it. */
  readonly parameterSet: unknown;
}

/** A table bundle seen structurally, which is how every table is walked here. */
type RowBundle = Record<string, readonly Record<string, unknown>[]>;

/**
 * The contexts a stored extent already holds for this exact request, or
 * `undefined` when it does not hold all of them.
 *
 * `undefined` rather than an empty array, because an empty array is a real
 * answer: a run that registers no contributors at all asks for no contexts, and
 * a stored extent trivially satisfies it.
 *
 * @param extent - What {@link ProjectionStore.readExtent} returned
 * @param requested - Every contributor this run registered, with its parameters
 * @returns The context ids the run's own contributors declared, or `undefined`
 *   when some registered contributor has no matching provenance row
 */
export function selectRequestedContexts(
  extent: ExtentScopedRows,
  requested: readonly RequestedContributor[],
): readonly string[] | undefined {
  // Keyed by `(contributorId, canonical parameterSet)` in one string rather than
  // nested maps: the pair is the question, and splitting it across two lookups
  // invites a later edit to check only the first half.
  const contextsByQuestion = new Map<string, string[]>();
  for (const row of extent.zoneProvenance) {
    const question = questionKey(row.contributorId, row.parameterSet);
    const contexts = contextsByQuestion.get(question) ?? [];
    contextsByQuestion.set(question, contexts);
    contexts.push(row.contextId);
  }

  const selected = new Set<string>();
  for (const contributor of requested) {
    const contexts = contextsByQuestion.get(questionKey(contributor.id, contributor.parameterSet));
    // A registered contributor with no stored provenance under these exact
    // parameters is the whole miss condition: the stored extent answers a
    // question this run did not ask.
    if (contexts === undefined) return undefined;
    for (const contextId of contexts) selected.add(contextId);
  }
  return [...selected];
}

/**
 * Narrow a stored extent to the contexts one run is owed.
 *
 * @param extent - What {@link ProjectionStore.readExtent} returned
 * @param options - Which contexts, and whose root
 * @param options.contexts - Context ids from {@link selectRequestedContexts}
 * @param options.rootId - This run's corpus root id, which `populate()` records
 *   a `roots` row for before any contributor runs — so it is kept whether or not
 *   a context happens to name it
 * @returns The same eight tables, holding only this run's rows
 */
export function selectRequestedRows(
  extent: ExtentScopedRows,
  options: { contexts: readonly string[]; rootId: string },
): ExtentScopedRows {
  const contexts = new Set(options.contexts);
  const source = extent as unknown as RowBundle;
  const kept: RowBundle = {};

  for (const spec of Object.values(PROJECTION_TABLES)) {
    const column = spec.contextColumn;
    if (spec.scope !== 'extent' || column === undefined) continue;
    kept[spec.key] = (source[spec.key] ?? []).filter((row) => contexts.has(String(row[column])));
  }

  // The three context-less tables, by reachability from what was kept above.
  const identities = referencedIdentities(kept);
  kept[PROJECTION_TABLES.resources.key] = rowsNaming(source, PROJECTION_TABLES.resources.key, 'resourceId', identities);
  kept[PROJECTION_TABLES.resourceTags.key] = rowsNaming(source, PROJECTION_TABLES.resourceTags.key, 'resourceId', identities);

  const roots = new Set<string>([options.rootId]);
  for (const row of kept[PROJECTION_TABLES.resolutionContexts.key] ?? []) {
    roots.add(String(row['rootId']));
  }
  kept[PROJECTION_TABLES.roots.key] = rowsNaming(source, PROJECTION_TABLES.roots.key, 'id', roots);

  return kept as unknown as ExtentScopedRows;
}

/**
 * Whether the stored blob tier accounts for every content key these
 * realizations name.
 *
 * See this module's header: accounted for means a `blobs` row **or** a
 * `blobConditions` row, because the derivation stage records the latter instead
 * of the former whenever it declined to parse — and a binary file makes that the
 * common case rather than an exotic one.
 *
 * @param blobs - What {@link ProjectionStore.readBlobFacts} returned for
 *   {@link keyedContentKeys} of the same realizations
 * @param contentKeys - The keys those realizations name
 * @returns True when every key is accounted for
 */
export function blobFactsCover(blobs: BlobScopedRows, contentKeys: readonly string[]): boolean {
  const held = new Set<string>();
  for (const row of blobs.blobs) held.add(row.contentKey);
  for (const row of blobs.blobConditions) held.add(row.blob);
  return contentKeys.every((key) => held.has(key));
}

/**
 * The distinct content keys a set of realizations names.
 *
 * Filters on `contentState === 'keyed'` rather than on a non-null key, for the
 * reason `blobTargets` states: the schema pins the two together today, and a
 * fourth null state added later must not slip through as a blob that has no
 * bytes.
 *
 * @param extent - Extent-scoped rows, already narrowed to one run
 * @returns The keys, deduplicated, in first-seen order
 */
export function keyedContentKeys(extent: ExtentScopedRows): readonly string[] {
  const keys = new Set<string>();
  for (const row of extent.resourceRealizations) {
    if (row.contentState === 'keyed' && row.contentKey !== null) keys.add(row.contentKey);
  }
  return [...keys];
}

/**
 * Assemble the twelve tables into a projection.
 *
 * The two halves are disjoint and exhaustive over {@link Projection} by
 * construction — that is what {@link ProjectionTableScope} partitions — so this
 * is a spread rather than a merge, and a thirteenth table joins whichever half
 * its scope declares without touching this line.
 *
 * Frozen for the same reason {@link ProjectionBuilder.build} freezes: a
 * projection handed to a consumer must not change under it, and a hydrated one
 * must be indistinguishable from a populated one in every respect a consumer can
 * observe.
 *
 * @param extent - Extent-scoped rows, already narrowed to one run
 * @param blobs - Blob-scoped rows for exactly that run's content keys
 * @returns The frozen projection
 */
export function assembleProjection(extent: ExtentScopedRows, blobs: BlobScopedRows): Projection {
  return Object.freeze({ ...extent, ...blobs }) as Projection;
}

/**
 * A blob-scoped bundle with every table empty — what a run that declined to
 * derive blobs hydrates with.
 *
 * Built from the registry rather than written out, so it cannot fall behind a
 * thirteenth blob-scoped table.
 *
 * @returns Four empty tables
 */
export function emptyBlobRows(): BlobScopedRows {
  const empty: RowBundle = {};
  for (const spec of Object.values(PROJECTION_TABLES)) {
    if (spec.scope === 'blob') empty[spec.key] = [];
  }
  return empty as unknown as BlobScopedRows;
}

/**
 * One contributor's question, as a single comparable string.
 *
 * @param contributorId - {@link ExtentContributor.id}
 * @param parameterSet - The parameters it ran, or will run, under
 * @returns A key that is equal exactly when the questions are
 */
function questionKey(contributorId: string, parameterSet: unknown): string {
  return `${canonicalJson(contributorId)}\0${canonicalJson(parameterSet)}`;
}

/**
 * Every identity the kept context-scoped rows name.
 *
 * Realizations and memberships both carry `resourceId`, and a contributor emits
 * at least one of them for every identity it contributes — which is what makes
 * this reconstruction total rather than a heuristic.
 *
 * @param kept - The context-scoped tables, already filtered
 * @returns The identity ids
 */
function referencedIdentities(kept: RowBundle): ReadonlySet<string> {
  const identities = new Set<string>();
  for (const key of [PROJECTION_TABLES.resourceRealizations.key, PROJECTION_TABLES.resourceExtents.key]) {
    for (const row of kept[key] ?? []) identities.add(String(row['resourceId']));
  }
  return identities;
}

/**
 * The rows of one table whose named column is in a set.
 *
 * @param source - The stored bundle
 * @param table - Which table
 * @param column - The column to test
 * @param wanted - The values to keep
 * @returns The matching rows, in stored order
 */
function rowsNaming(
  source: RowBundle,
  table: string,
  column: string,
  wanted: ReadonlySet<string>,
): readonly Record<string, unknown>[] {
  return (source[table] ?? []).filter((row) => wanted.has(String(row[column])));
}
