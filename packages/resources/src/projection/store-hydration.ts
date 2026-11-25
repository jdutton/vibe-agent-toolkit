/**
 * Turning what a {@link FactStore} holds back into a {@link Projection} —
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
 * {@link FactStore.writeExtent} being additive — and a caller that
 * enumerated them would see paths no contributor of its own realized.
 * `buildResourcePopulation` is precisely such a caller: it walks
 * `resourceRealizations` with no extent filter at all, so a superset hydration
 * would hand `vat resources scan` every skill extent's re-realization of the
 * same files.
 *
 * So {@link selectRequestedContexts} keeps only rows belonging to the contexts
 * the run's own contributors declared. The tables with no
 * {@link ProjectionTableSpec.contextColumn} cannot be partitioned that way and
 * are not stored per-context either, so they are recovered by **reachability**:
 *
 * | table | kept when |
 * |---|---|
 * | `roots` | it is this run's root, or a kept context names it |
 * | `resources` | a kept realization or membership names the identity |
 * | `resourceTags` | a kept realization or membership names the identity |
 * | `claudeRulePatterns` | a kept realization or membership names the identity |
 *
 * Each row of that table is one reconstruction step of {@link EXTENT_STEP_TABLES}
 * (`roots` the roots step, the other three the identity step), and a caller
 * names the steps it needs in its {@link ExtentRequest}: membership reads three
 * context-scoped tables and runs neither. A step whose tables the request does
 * not name, or a requested table the stored rows lack, is an
 * {@link StoreRequestUnmetError}: an absent table never reads as empty.
 *
 * That reconstruction is a claim, and the claim is falsifiable rather than
 * argued: `exportProjection` emits a byte-identical document from a projection,
 * so "hydrated == populated" is a diff of two strings and is asserted as one.
 *
 * ## Why the blob tier is checked rather than trusted
 *
 * The blob tier is written by whoever derived it, and a run may legitimately
 * decline to derive it (`PopulateOptions.contentParsing` = `'skip'` — `vat resources
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
 * {@link uncoveredContentKeys} is the guard, and it needs no new metadata: the
 * derivation stage accounts for **every** keyed content key, with a `blobs` row
 * (and its companion rows) when it parsed and a `blobConditions` row when it
 * declined to (unreadable, changed underneath, or binary). A key the blob fact
 * reader cannot answer from its rows is a key the store never fully derived, and
 * one such key makes the whole extent a miss.
 */

import { VatError } from '@vibe-agent-toolkit/utils';

import { type BlobCoverageRows, blobFactsReader } from './blob-resource-facts.js';
import { canonicalJson } from './digest.js';
import type { Projection } from './projection.js';
import {
  EXTENT_STEP_TABLES,
  type BlobScopedRows,
  type ExtentRequest,
  type ExtentScopedRows,
  type ExtentScopedTableName,
  type ExtentStep,
} from './store.js';
import { PROJECTION_TABLES } from './table-registry.js';

/** The `code` a {@link StoreRequestUnmetError} carries — dispatch on this, never on the message. */
export const STORE_REQUEST_UNMET = 'STORE_REQUEST_UNMET';

/**
 * A store request that cannot be answered, on either tier. On the extent tier:
 * a step whose tables the request does not name, a context-less table requested
 * without the step that narrows it, or a requested table the stored rows do not
 * carry. On the blob tier: a store answer missing a requested table, a backend
 * that ignored the request; reading the absent table as empty would serve every
 * key as uncovered. A VAT or backend bug, never a property of the corpus;
 * recognise it with `isVatError(error, StoreRequestUnmetError.code)`.
 */
export class StoreRequestUnmetError extends VatError {
  /** The code every instance carries. */
  static readonly code = STORE_REQUEST_UNMET;

  /**
   * @param tier - The tier whose request is unmet
   * @param table - The table the request or the stored rows lack
   * @param reason - Why it was needed
   */
  constructor(
    readonly tier: 'extent' | 'blob',
    readonly table: string,
    reason: string,
  ) {
    super(STORE_REQUEST_UNMET, `The ${tier} request cannot be answered: ${table} ${reason}. This is a VAT bug.`);
  }
}

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

/** The column an identity-keyed table names its identity in. */
const IDENTITY_COLUMN = 'resourceId';

/**
 * The contexts a stored extent already holds for this exact request, or
 * `undefined` when it does not hold all of them.
 *
 * `undefined` rather than an empty array, because an empty array is a real
 * answer: a run that registers no contributors at all asks for no contexts, and
 * a stored extent trivially satisfies it.
 *
 * @param extent - What {@link FactStore.readExtent} returned
 * @param requested - Every contributor this run registered, with its parameters
 * @returns The context ids the run's own contributors declared, or `undefined`
 *   when some registered contributor has no matching provenance row
 */
export function selectRequestedContexts(
  extent: Pick<ExtentScopedRows, 'zoneProvenance'>,
  requested: readonly RequestedContributor[],
): readonly string[] | undefined {
  // Keyed by `(contributorId, canonical parameterSet)` in one string rather than
  // nested maps: the pair is the question, and splitting it across two lookups
  // invites a later edit to check only the first half.
  const contextsByQuestion = new Map<string, string[]>();
  for (const row of requestedTable(extent, PROJECTION_TABLES.zoneProvenance.key)) {
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
 * Narrow a stored extent to the contexts one run is owed, in the tables and
 * with the reconstruction steps the request names.
 *
 * @param extent - What {@link FactStore.readExtent} returned for `request`
 * @param request - The tables the caller reads and the steps to run over them
 * @param selection - Which contexts, and whose root
 * @param selection.contexts - Context ids from {@link selectRequestedContexts}
 * @param selection.rootId - This run's corpus root id, which `populate()` records
 *   a `roots` row for before any contributor runs — so the roots step keeps it
 *   whether or not a context happens to name it
 * @returns The requested tables, holding only this run's rows
 * @throws An {@link StoreRequestUnmetError} when a step's table is not
 *   requested, a context-less table is requested without its step, or a
 *   requested table is absent from `extent`
 */
export function selectRequestedRows<Table extends ExtentScopedTableName>(
  extent: Pick<ExtentScopedRows, Table>,
  request: ExtentRequest<Table>,
  selection: { contexts: readonly string[]; rootId: string },
): Pick<ExtentScopedRows, Table> {
  assertRequestComplete(request);
  const contexts = new Set(selection.contexts);
  const source = extent as unknown as RowBundle;
  const kept: RowBundle = {};

  for (const table of request.tables) {
    const column = PROJECTION_TABLES[table].contextColumn;
    if (column !== undefined) kept[table] = rowsOf(source, table).filter((row) => contexts.has(String(row[column])));
  }

  const steps = new Set<ExtentStep>(request.steps);
  if (steps.has('identity')) {
    // The context-less IDENTITY tables, by reachability from what was kept above.
    const identities = referencedIdentities(kept);
    for (const table of stepOutputs('identity')) {
      kept[table] = rowsNaming(source, table, IDENTITY_COLUMN, identities);
    }
  }
  if (steps.has('roots')) {
    const roots = new Set<string>([selection.rootId]);
    for (const row of rowsOf(kept, PROJECTION_TABLES.resolutionContexts.key)) {
      roots.add(String(row['rootId']));
    }
    kept[PROJECTION_TABLES.roots.key] = rowsNaming(source, PROJECTION_TABLES.roots.key, 'id', roots);
  }

  return kept as unknown as Pick<ExtentScopedRows, Table>;
}

/**
 * The content keys these realizations name that the stored blob tier does not
 * cover, by the ONE blob-tier predicate: {@link blobFactsReader}'s `answer`.
 *
 * A key is covered when it answers `facts` (a sound `blobs` row with its
 * reference, section and skill-text rows, or a `BLOB_NOT_TEXT` condition, the
 * constant facts) or `not-admitted` (a refusal condition: the derivation stage
 * records it instead of a `blobs` row when it declined to parse). Anything else,
 * a `blobs` row whose companion rows are missing or unsound included, is
 * `uncovered` and derived again. Stored admission and the checks gate ask the
 * same reader, so no caller can call a key covered that another calls uncovered.
 *
 * @param rows - What {@link FactStore.readBlobFacts} returned for
 *   {@link keyedContentKeys} of the same realizations; only the tables of
 *   `BLOB_FACT_READER_TABLES` are read, and the type admits no others
 * @param contentKeys - The keys those realizations name
 * @returns The keys the tier does not cover, in `contentKeys` order: empty when
 *   every key is covered. Returned rather than a yes/no so a miss can be counted
 *   and named (ADR I10).
 */
export function uncoveredContentKeys(rows: BlobCoverageRows, contentKeys: readonly string[]): string[] {
  const reader = blobFactsReader(rows);
  return contentKeys.filter((key) => reader.answer(key).kind === 'uncovered');
}

/**
 * What one derivation read of the stored blob tier: every blob-scoped row the
 * store held for the keys it asked about, and the keys among them the one
 * predicate ({@link uncoveredContentKeys}) calls covered.
 *
 * A covered key's rows are emitted in place of a read and a parse; every other
 * key is derived. `covered` is what the write reports as covered at read
 * (`FactStore.writeBlobFacts`).
 */
export interface StoredBlobTier {
  /** The rows the read returned, every blob-scoped table. */
  readonly rows: BlobScopedRows;
  /** The keys the one predicate called covered in that read. */
  readonly covered: ReadonlySet<string>;
}

/** The tier of a run with no store, or one that parses no content: nothing held, nothing covered. */
export const EMPTY_STORED_TIER: StoredBlobTier = Object.freeze({ rows: emptyBlobRows(), covered: new Set<string>() });

/**
 * The tier one read answered, judged by the one predicate.
 *
 * @param rows - What `readBlobTier` returned for `contentKeys`, every blob-scoped table
 * @param contentKeys - The keys the read asked about
 * @returns The rows, and the keys among `contentKeys` they cover
 */
export function storedBlobTier(rows: BlobScopedRows, contentKeys: readonly string[]): StoredBlobTier {
  const uncovered = new Set(uncoveredContentKeys(rows, contentKeys));
  return { rows, covered: new Set(contentKeys.filter((key) => !uncovered.has(key))) };
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
export function keyedContentKeys(extent: Pick<ExtentScopedRows, 'resourceRealizations'>): readonly string[] {
  const keys = new Set<string>();
  for (const row of extent.resourceRealizations) {
    if (row.contentState === 'keyed' && row.contentKey !== null) keys.add(row.contentKey);
  }
  return [...keys];
}

/**
 * Assemble every table of {@link PROJECTION_TABLES} into a projection.
 *
 * The two halves are disjoint and exhaustive over {@link Projection} by
 * construction — that is what {@link ProjectionTableScope} partitions — so this
 * is a spread rather than a merge, and a new table joins whichever half
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
 * further blob-scoped table.
 *
 * @returns Every blob-scoped table, empty
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
 * The context-less tables a step narrows: the ones of its
 * {@link EXTENT_STEP_TABLES} entry with no context column (the rest it only
 * reads).
 *
 * @param step - The step
 * @returns The registry keys it rebuilds
 */
function stepOutputs(step: ExtentStep): readonly ExtentScopedTableName[] {
  return EXTENT_STEP_TABLES[step].filter((table) => PROJECTION_TABLES[table].contextColumn === undefined);
}

/**
 * Refuse a request whose steps and tables disagree.
 *
 * The type already refuses a step without its tables ({@link ExtentStepsFor});
 * this is the same rule for a request built where the type cannot see it (a
 * cast, a widened variable, JavaScript), plus its converse: a context-less
 * table requested without the step that narrows it would be handed back
 * unnarrowed, every context's rows at once.
 *
 * @param request - The request
 * @throws An {@link StoreRequestUnmetError} on either disagreement
 */
function assertRequestComplete<Table extends ExtentScopedTableName>(request: ExtentRequest<Table>): void {
  const tables = new Set<ExtentScopedTableName>(request.tables);
  const steps = new Set<ExtentStep>(request.steps);
  for (const step of steps) {
    const missing = EXTENT_STEP_TABLES[step].find((table) => !tables.has(table));
    if (missing !== undefined) throw new StoreRequestUnmetError('extent', missing, `is read by the ${step} step but not requested`);
  }
  for (const table of tables) {
    if (PROJECTION_TABLES[table].contextColumn !== undefined) continue;
    const narrowedBy = (Object.keys(EXTENT_STEP_TABLES) as ExtentStep[]).filter((step) => stepOutputs(step).includes(table));
    if (!narrowedBy.some((step) => steps.has(step))) {
      throw new StoreRequestUnmetError('extent', table, `has no context column and is requested without the step that narrows it (${narrowedBy.join(', ')})`);
    }
  }
}

/**
 * One table of a bundle, which must be there: a requested table the stored
 * rows do not carry is a backend that ignored the request, and reading it as
 * empty would serve a membership with no members as a hit.
 *
 * @param bundle - The rows
 * @param table - The table
 * @returns Its rows
 * @throws An {@link StoreRequestUnmetError} when the bundle lacks it
 */
function rowsOf(bundle: RowBundle, table: string): readonly Record<string, unknown>[] {
  const rows = bundle[table];
  if (rows === undefined) throw new StoreRequestUnmetError('extent', table, 'was requested and is absent from the stored rows');
  return rows;
}

/**
 * {@link rowsOf} for one table of a typed extent answer, keeping the table's row type.
 *
 * @param extent - The stored rows
 * @param table - The table, which must be there
 * @returns Its rows
 * @throws An {@link StoreRequestUnmetError} when `extent` lacks it
 */
function requestedTable<Table extends ExtentScopedTableName>(extent: Pick<ExtentScopedRows, Table>, table: Table): ExtentScopedRows[Table] {
  return rowsOf(extent as unknown as RowBundle, table) as unknown as ExtentScopedRows[Table];
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
    for (const row of rowsOf(kept, key)) identities.add(String(row['resourceId']));
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
  return rowsOf(source, table).filter((row) => wanted.has(String(row[column])));
}
