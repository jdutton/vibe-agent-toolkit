/**
 * Populating a tree's resource projection and putting it somewhere ASKABLE —
 * the shared half of every command that runs SQL over it.
 *
 * `vat resources query` runs one statement a person typed; `vat resources check`
 * runs the statements a project wrote down. They differ in what they do with
 * rows and in nothing else: same population, same store selection, same run
 * database, same cache tell. This module is that "and in nothing
 * else", stated once so the two cannot drift into answering about different
 * corpora.
 *
 * ## 🚨 The SQL ALWAYS runs against a per-run in-memory database. Never the store.
 *
 * This is a correctness property, not an optimisation choice, and it was learned
 * the expensive way. The on-disk projection store is **one database per VAT
 * build, shared by every root on the machine** (`defaultStoreDirectory()` is
 * `<vatCacheRoot()>/<namespace>/projection-<shapeDigest>`, the root being
 * `VAT_CACHE_DIR` or `<tmpdir>/.vat-cache`), it retains three tree
 * hashes per root, and its blob tier is bounded only by a machine-wide byte
 * budget and carries no tree key at all. `FactStore.readExtent` narrows by `(rootId, treeHash)`; **arbitrary
 * SQL does not**, and cannot be made to — a `WHERE` clause the caller wrote is
 * not a key predicate.
 *
 * So running a user's statement against the file-backed store answered from
 * every projection on the machine. Measured on a two-file scratch repository:
 * `SELECT COUNT(*) FROM resource_realizations` returned **3** with no store and
 * **5,779** with one, and `WHERE path LIKE 'packages/%'` returned paths from a
 * different repository entirely. That is a wrong answer and a cross-project
 * disclosure of link text, heading text and frontmatter — the same material
 * `store.ts` cites as the reason it chmods the cache `0o700`.
 *
 * ⇒ The store's job is to make the POPULATION cheap, and that is all. Whatever
 * `populate()` returns — served from the store or derived — hydrates a fresh
 * in-memory run database with the relations the run's statements name, holding
 * this tree's rows and nothing else, and the SQL runs there. A test holds it:
 * `projection-containment.integration.test.ts` populates two repositories into
 * one store and asserts every relation the second run hydrates equals its
 * no-store run. The fact store's factory returns a port with no SQL surface, so
 * this is a property of the types as well as of this module. The saving is untouched (it was always in the population: on this
 * repository {@link ProjectionProvenance.populationMs} reads 1.16-1.18 s derived
 * against 0.29-0.31 s served), and "one tree, one answer" stops being a claim
 * about how callers behave and becomes a property of the shape.
 *
 * ## The store never reaches a caller
 *
 * Work runs against an `ask` closure rather than a store handle. That is
 * deliberate: `utils/projection-store.ts` is the one module in the toolkit that
 * knows `@vibe-agent-toolkit/projection-sqlite` exists, and handing commands a
 * backend-typed object would spread that knowledge to every future verb. A
 * closure also puts the legible-failure wrapper on the single path that can
 * throw, so no command can forget it.
 */

import { performance } from 'node:perf_hooks';

import {
  allDerivedSpecs,
  buildResourceProjection,
  dataCredentialFileFindings,
  dataDefectIssues,
  dataIncludeGlobInertFindings,
  dataRoutingFor,
  dataStageContentOf,
  definesCteNamed,
  identifierSpellings,
  isStoredRowsEvicted,
  queryableRelationNames,
  queryableRelationSpecs,
  relationsNamedBy,
  runDataStage,
  storeMissOf,
  withPopulationRun,
  type DataDemand,
  type LensRefusalCode,
  type PopulationCache,
  type PopulationRun,
  type PopulationOutcome,
  PROJECTION_STORE_ROWS_EVICTED_CODE,
  type QueryProjection,
  type QueryReferences,
  type QueryReferenceSource,
  type RowSetSource,
  type RowSetTableName,
  type StoredRowsEvictedError,
  type WorkspaceAnswer,
} from '@vibe-agent-toolkit/resources';
import { resolveFindings, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { forEachInOrder, isVatError, VatError } from '@vibe-agent-toolkit/utils';

import { CommandRefusalError } from './command-refusal.js';
import { loadConfigCached } from './config-loader.js';
import type { LensPopulation } from './lens-population.js';
import type { Logger } from './logger.js';
import { populateAndReport } from './population-wiring.js';
import {
  CHANGED_FILES_LENS,
  evaluateLens,
  lensRelationNames,
  lensPopulationOf,
  planHydration,
  type LensEvaluation,
  type LensRefusal,
  type LensRows,
} from './projection-lenses.js';
import { dataStageSeamsFor, hydrateRunDatabase, openCompileProbe, storeMembersOf, withPopulationCache } from './projection-store.js';
import type { RunVerb } from './run-lanes.js';

/** What SQLite says when a statement names a table the schema does not have, before the name. */
const NO_SUCH_TABLE = 'no such table: ';

/** What SQLite says when a statement names something the schema does not have: wording only, never a code. */
const NAME_NOT_FOUND: readonly string[] = [NO_SUCH_TABLE, 'no such column:'];

/**
 * What a run's rows are, and where they came from.
 *
 * ⚠️ There is deliberately no `engine` field beside these. An earlier version
 * published one (`sqlite | ephemeral`) to say which database answered the SQL;
 * it is gone because the answer is now always the same — see the header — and a
 * field with one possible value tells a reader nothing while implying the other
 * value is reachable.
 */
export interface ProjectionProvenance {
  /**
   * 🔑 The cache tell. Reported rather than inferred, because it CANNOT be
   * inferred: a correct store hit and a correct re-derivation produce identical
   * rows. It is `populate()`'s own outcome, never a count of what ran.
   *
   * It describes the POPULATION, which is the only thing the store now affects.
   */
  readonly population: PopulationOutcome['population'];

  /**
   * The same tell for the lenses' OWN populations — the claude-context lens
   * populates a lane of its own. `'none'` when no evaluated lens populated
   * anything; see {@link lensPopulationOf}.
   */
  readonly lensPopulation: LensPopulation;

  /**
   * 🔑 What that origin was WORTH. {@link population} says whether the
   * projection was served or re-derived; this says what the difference cost, so
   * the tell stops being a bare label a reader has to take on faith.
   *
   * Measured as THIS field, by running `vat resources query 'SELECT COUNT(*) AS
   * n FROM blobs'` against this repository three times per arm with the parse
   * cache warm: **1.16-1.18 s derived against 0.29-0.31 s served**. With a cold
   * parse cache the derived arm is 33-35 s, so the pair above is the store's
   * saving and not the parse cache's.
   *
   * The wall time of the SHARED setup and nothing else: everything
   * {@link withQueriedProjection} does before it hands control to the caller's
   * work — opening the population cache (which, when a store is selected, is a
   * `git write-tree` spawn plus the backend's dynamic import and
   * `openSqliteFactStore()`), the git tracker, `buildResourceProjection`, and
   * opening the run database over the projection.
   *
   * ⚠️ The population cache's CLOSE is outside it, necessarily: that runs in
   * `withPopulationCache`'s `finally`, after the caller's work returns, and a
   * span that ends before the work begins cannot contain it. It is a handle
   * release, not population.
   *
   * 🪤 **The span's start is load-bearing, and moving it inward is silent.**
   * This shipped with the clock started on the first line INSIDE
   * `withPopulationCache`'s callback — which put the population-cache open, the
   * only part of the setup a store adds, OUTSIDE the measurement, and only on
   * the arm where a store exists. Measured on a two-file corpus with identical
   * total wall time on both arms: no store 0.145 of 0.146 s, cold store 0.0475
   * of 0.161 s. Same work, `populationSecs` three times apart, and a reader
   * comparing a no-store run to a warm-store run read a 42x saving where the
   * honest totals differ by 1.75x. The field was added to stop the cache tell
   * being a label taken on faith and had become the artifact instead. A
   * measurement that flatters one arm is this repository's most-repeated
   * defect; the system suite now pins `populationSecs / durationSecs > 0.6` on a
   * cold run so the next inward move is red rather than quiet.
   *
   * ## Why it belongs on shared provenance rather than on one verb
   *
   * Both verbs pay it, identically, because it is the half of the run they hold
   * in common — a `check` that runs forty statements and a `query` that runs one
   * do the same population first. And a per-statement cost is UNREADABLE without
   * it: `vat resources check` publishes what each rule's SQL cost, and a reader
   * handed forty small numbers and a large total has no way to tell an expensive
   * rule from a setup everybody shares. Absent this field the only arithmetic
   * available is "total minus the statements", which silently attributes the
   * shared setup to whichever rule the reader is looking at.
   *
   * ⚠️ Measured with `performance.now()`, not `Date.now()`. A warm population
   * lands well under a millisecond on a small tree, and a millisecond-granularity
   * clock reports that as `0` — which reads as "not measured" rather than "very
   * fast", turning the best case the store has into its least credible number.
   *
   * ⚠️ Deliberately ONE number, not a breakdown. Splitting it into crawl, parse
   * and store-load is a real question and it is the lab's: an instrument that
   * gets reviewed and re-run, rather than a product document that would then owe
   * every consumer a stable sub-phase vocabulary.
   */
  readonly populationMs: number;

  /**
   * The lenses this run evaluated, by name, in evaluation order.
   *
   * 🔑 **Published because "which lenses ran" became a DECISION, and an
   * unpublished decision is one nobody can check.** Without it an empty derived
   * relation is ambiguous — no rows, or no evaluation? This is the tell, in the
   * same family as {@link population}, and what makes a `lensSecs` of `0`
   * legible rather than alarming.
   *
   * ⚠️ Not the only guard: a relation no evaluated lens produced does not
   * EXIST in the run's database, so a statement naming it is refused by SQLite
   * (see {@link withQueriedProjection}). This field explains a cheap run rather
   * than excusing a blind one.
   */
  readonly lensesEvaluated: readonly string[];

  /**
   * What EVALUATING THE LENSES cost, separately from populating the tree.
   *
   * Separate because the two answer different questions and a reader must be
   * able to tell them apart. Population is work every verb pays and the store
   * can make cheap; this is work the *derived relations* cost, and a store hit
   * does NOT make an authored-link evaluation cheaper — it is a pass over the
   * served rows just as over derived ones. Folded into `populationMs` it would
   * look like the store getting worse.
   *
   * ⚠️ **Not an unconditional cost.** A run whose statements name no derived
   * relation evaluates nothing and reports `0`; {@link lensesEvaluated} says
   * which lenses the number covers.
   *
   * ⚠️ **DISJOINT from `populationMs`, and that is enforced by where the
   * population clock stops, not by convention.** It shipped overlapping: the
   * population span ended after the lens write, so this value was contained in
   * that one while all three docstrings said otherwise, and anyone adding the
   * two over-counted wall time. If you move either clock, keep them disjoint —
   * a reader comparing a served run against a derived one is the whole reason
   * they are two fields.
   *
   * ⚠️ Published rather than merely measured, because a cost that is invisible
   * is the one nobody can argue with. It is the evidence the selection above
   * rests on, and the evidence any future flag would rest on.
   */
  readonly lensMs: number;
}

/**
 * How much of the tree the population actually covered.
 *
 * ## Why this is not a field on {@link ProjectionProvenance}
 *
 * Provenance is a fact both verbs PUBLISH verbatim — "these rows were served or
 * re-derived" is the same sentence in either document. This is a fact a verb
 * REASONS with, and only one of them has anything to reason about: `vat
 * resources query` prints the rows a person selected, so its reader can see the
 * extent for themselves, while `vat resources check` prints a verdict and a
 * count of rules. Only the second can pass vacuously, and only the second needs
 * to know.
 *
 * ## 🔑 The failure it exists to make visible
 *
 * `vat resources check` reported how many CHECKS ran; nothing said how many ROWS
 * they ran against. So "four checks passed over eight thousand files" and "four
 * checks passed over ZERO files" were byte-identical documents, and the second
 * was a green gate asserting nothing. A broad `.gitignore`, a shallow or sparse
 * checkout, a root that resolved elsewhere, or an extent source that enumerated
 * nothing all produce it — and `buildResourceProjection` DECLINES ignored
 * members rather than flagging them, so an emptied enumeration leaves no trace
 * in the tables either.
 */
export interface PopulationExtent {
  /**
   * One per `(extentId, path)` row the population enumerated.
   *
   * 🪤 Realizations rather than any other count, because every alternative
   * fails to reach zero on the case that matters: `roots` always holds exactly
   * one row (the invariant thrown for below), so a total over every table
   * is never 0; `blobs` is content-keyed and deduped, so it counts parse REACH
   * and already has its own report in `populateAndReport`; and `resources` counts
   * identities, which a corpus can legitimately have none of while enumerating
   * plenty. One row per enumerated path is non-zero exactly when something was
   * enumerated.
   */
  readonly membersEnumerated: number;
}

/** One statement a run intends to ask, with the values it will bind to it. */
export interface PreflightStatement {
  readonly sql: string;
  /** Bound in order, one per `?`. Empty for a statement that binds nothing. */
  readonly parameters: readonly string[];
}

/** Run one read-only statement against the populated projection. */
export type AskProjection = (
  sql: string,
  ...parameters: readonly string[]
) => readonly Record<string, unknown>[];

/** The result columns one statement would produce, in order, without running it. */
export type ColumnsOfStatement = (sql: string, ...parameters: readonly string[]) => readonly string[];

/**
 * A statement's failure, reworded by {@link describeQueryFailure} — keeping
 * the thrown value's `code`.
 *
 * 🔑 The code is what tells the caller WHICH failure this is: the store's
 * `PROJECTION_STATEMENT_REFUSED_CODE` means the statement is wrong (the
 * author's to fix, a `USAGE_INVALID` refusal for `vat resources query`);
 * anything uncoded is a defect. A bare `Error` would drop the code.
 *
 * A relation a lens REFUSED never reaches here: {@link refusedStatement} refuses its statement
 * before it runs, so no code is ever read out of the engine's text.
 *
 * @param sql - The statement that was submitted
 * @param error - What running or compiling it threw
 * @param unhydrated - The queryable relations the database does not hold (none for the compile probe)
 * @returns The error to throw in its place
 */
export function describedFailure(sql: string, error: unknown, unhydrated: UnhydratedRelations): Error {
  const message = describeQueryFailure(sql, error instanceof Error ? error.message : String(error), unhydrated);
  return isVatError(error) ? new VatError(error.code, message, { cause: error }) : new Error(message, { cause: error });
}

/**
 * The queryable relations a run database does not hold, by SQL name, and of those, the ones the
 * plan WITHHELD, each with why. A relation absent and not withheld was not named as an
 * identifier the planner reads.
 */
export interface UnhydratedRelations {
  readonly absent: ReadonlySet<string>;
  readonly withheld: ReadonlyMap<string, string>;
}

/** What the compile probe lacks: nothing, since it holds every queryable relation. */
export const NOTHING_UNHYDRATED: UnhydratedRelations = { absent: new Set(), withheld: new Map() };

/** The workspace resolve step's relations, by SQL name: refused together when the step refuses. */
const WORKSPACE_RELATIONS: readonly string[] = allDerivedSpecs().filter((spec) => spec.producer === 'workspace').map((spec) => spec.name);

/**
 * The relations a run can REFUSE to answer: a CTE may not take one of their names. A lens's, and
 * the workspace step's (`WORKSPACE_*`, `DATA_REQUEST_UNROUTED`). Never a `data__*` relation: each
 * answers from the files that have rows, a broken file reported as its own finding
 * (`DATA_FILE_NO_ROWS`).
 */
const REFUSABLE_RELATIONS: readonly string[] = [...lensRelationNames(CHANGED_FILES_LENS), ...WORKSPACE_RELATIONS];

/**
 * A statement refused because it names a derived relation its lens could not evaluate. Its
 * `refusal` is narrowed to {@link LensRefusalCode}, so the check lane can publish it as a broken
 * check's `reason.refusal` and the type proves the value is one that field admits.
 */
export class RelationRefusedError extends CommandRefusalError {
  declare readonly refusal: LensRefusalCode;

  constructor(refusal: LensRefusalCode, message: string) {
    super(refusal, message);
  }
}

/**
 * The refusal for a statement that names a relation the run REFUSED to fill — decided from the
 * relations the statement names, before it runs, so the refusal's code and fix reach the operator
 * whatever else in the statement SQLite would have stopped at first.
 *
 * @param sql - The statement about to run
 * @param refusals - Each refusal, by the SQL name of a relation it covers
 * @returns The refusal, or undefined when the statement names no refused relation
 */
export function refusedStatement(sql: string, refusals: ReadonlyMap<string, LensRefusal>): RelationRefusedError | undefined {
  // A CTE in a refusable relation's name either shadows the relation or trips its refusal, whose
  // remedy (`--base`) would be wrong: the fix is the statement's, so it is refused first, either way.
  const reserved = REFUSABLE_RELATIONS.find((name) => definesCteNamed(sql, name));
  if (reserved !== undefined) {
    return new RelationRefusedError('USAGE_INVALID', `\`${reserved}\` is a reserved relation name; rename the CTE.`);
  }
  const [relation] = relationsNamedBy(sql, refusals.keys());
  const refused = relation === undefined ? undefined : refusals.get(relation);
  if (relation === undefined || refused === undefined) return undefined;
  return new RelationRefusedError(refused.refusal, `This statement reads ${relation}, a derived relation that could not be evaluated for this run: ${refused.refused}`);
}

/**
 * Compile every statement a run intends to ask, against the schema and NO rows,
 * before anything is populated.
 *
 * ## 🔑 What this buys, measured
 *
 * SQLite resolves table and column names when a statement is *prepared*, not
 * when it is stepped — so a typo is knowable before a single row exists. It was
 * not knowable in practice, because the only place a statement met the schema
 * was after the projection had been built. On a real adopter tree, `SELECT path,
 * no_such_column …` cost **8.3 s**, every millisecond of it spent building a
 * projection the statement could never have read. The same typo now costs the
 * price of an empty in-memory database — one extra `createSchema` into
 * `:memory:`, which is the whole overhead this adds on the happy path.
 *
 * It also moves the KIND refusals — a second statement, an `ATTACH`, a `PRAGMA`
 * — in front of the population, so a statement rejected for what it is costs no
 * more than one rejected for what it names.
 *
 * ⚠️ **This is a pre-flight, not a second gate.** `ask` still compiles and runs
 * the real statement against the real projection, and nothing here is trusted in
 * place of that. A statement that compiles here can still fail there — SQLite
 * resolves names against a schema, and this is the same schema, but a run-time
 * error (a bad cast, an overflow) belongs to stepping and is unreachable from a
 * prepare.
 *
 * ⚠️ It deliberately does not STEP anything. Stepping is where a check's
 * unbounded cost lives, and a preflight that ran `WITH RECURSIVE …` would hang
 * before the run it exists to make cheap had begun.
 *
 * ⚠️ Each statement comes WITH the values it will be bound to, because the
 * placeholder count is part of what compiles: a `?` the caller forgot to bind is
 * SQL NULL at run time, and the statement then selects nothing and reports
 * success — the same silent class as a typo'd column, and worth the same early
 * refusal. The backend does the counting; this only has to hand it the values.
 *
 * @param statements - Every statement the run will ask, in any order, each with
 *   the values it will bind
 * @throws The same legible failure `ask` throws, for the first statement that
 *   does not compile or does not pair its placeholders with its values
 */
export async function assertQueriesCompile(statements: readonly PreflightStatement[]): Promise<void> {
  if (statements.length === 0) return;
  // 🔑 A compile PROBE, not the run database: this runs before any lens is
  // evaluated, and the run database has no table for an unevaluated relation.
  // The probe carries every derived relation and cannot answer a query, so its
  // empty tables can never be read as a result.
  const probe = await openCompileProbe();
  try {
    for (const { sql, parameters } of statements) {
      try {
        probe.assertCompiles(sql, parameters);
      } catch (error) {
        throw describedFailure(sql, error, NOTHING_UNHYDRATED);
      }
    }
  } finally {
    await probe.close();
  }
}

/**
 * Populate the tree, load it into something askable, and hand the caller a way
 * to ask.
 *
 * @param options - The run
 * @param options.root - Absolute corpus root
 * @param options.logger - Where the population's refused content is reported
 *   (stderr, so a parseable document on stdout stays parseable)
 * @param options.preflight - Every statement this run intends to ask, compiled
 *   against the empty schema BEFORE the population starts. See
 *   {@link assertQueriesCompile}
 * @param options.statements - Every statement this run may ask, for HYDRATION
 *   and LENS SELECTION only — never compiled, never bound, and deliberately
 *   separate from `preflight`. Required: a relation no statement names is absent
 * @param options.base - The `--base` ref for the changed-files lens, or undefined when the run was
 *   given none. REQUIRED, so no caller can drop the person's `--base` and still compile
 * @param work - Given the asker, where its rows came from, how much of the tree
 *   they cover, and the ROWS THEMSELVES. The run database is open for exactly this call
 *   and closed however it ends
 * @returns Whatever `work` returned
 */
export async function withQueriedProjection<T>(
  options: {
    root: string;
    /** The verb asking, whose `RUN_MEMBER_BYTES` entry decides where the run reads members. */
    verb: Extract<RunVerb, 'resources query' | 'resources check'>;
    logger: Logger;
    preflight?: readonly PreflightStatement[];
    statements: readonly string[];
    base: string | undefined;
  },
  work: QueriedProjectionWork<T>,
): Promise<T> {
  const { root, logger } = options;


  // 🔑 BEFORE the clock and before the population, because being before the
  // population is the entire point — see {@link assertQueriesCompile}. It is an
  // option rather than a step each verb remembers for the same reason everything
  // else here is shared: a verb that forgot it would silently go back to paying
  // a full population to learn about a typo, and nothing in its output would say
  // so.
  await assertQueriesCompile(options.preflight ?? []);

  // 🚨 OUTSIDE `withPopulationCache`, and it must stay outside. That helper
  // awaits `openPopulationCache` — a `git write-tree` spawn plus the backend's
  // dynamic import and `openSqliteFactStore()` — BEFORE it invokes the
  // callback below, and it pays that cost ONLY when a store is selected. A clock
  // started inside the callback therefore drops the store's own setup out of the
  // measurement on precisely the arm the number is used to praise. See
  // `populationMs` for what that shipped as.
  //
  // What is NOT in the span, deliberately: `withPopulationCache`'s `finally`,
  // which closes the opened cache AFTER `work` returns. A span that ends before
  // `work` begins cannot contain it, and stretching the span past `work` would
  // fold the caller's statements into a number whose entire purpose is to be
  // read against them. The close is a handle release on an already-open
  // database, not population.
  const populationStart = performance.now();

  // The file-backed store, when one is selected, and ONLY as a population cache.
  // Its rows are never queried — see the header.
  // ONE population run for the query: the resources population and a lens that
  // populates (claude-context) read and parse each file once between them.
  return withPopulationCache({ root }, (cache) => withPopulationRun(storeMembersOf(root, options.verb), async (populationRun) => {
    const run = { root, statements: options.statements, base: options.base, cache, populationRun, populationStart };
    // A hit copies `blob_references` inside SQLite. A lens that populates after it reads, through
    // the run's one reader, only the reference forms the query population left out.
    const warned = new Set<string>();
    const remembering: Logger = { ...logger, warn: (message) => { warned.add(message); logger.warn(message); } };
    try {
      return await populateThenAsk({ ...run, logger: remembering, references: 'copy', attempt: 1 }, work);
    } catch (error) {
      // Rows the first attempt was served were evicted before hydration copied them. Once:
      // hydration runs before `work`, so nothing of the caller's ran, and the second attempt
      // repeats none of the first's warnings.
      if (!isStoredRowsEvicted(error)) throw error;
      const unrepeated: Logger = { ...logger, warn: (message) => { if (!warned.has(message)) logger.warn(message); } };
      const references = referencesAfterEviction(error, cache, populationRun);
      try {
        return await populateThenAsk({ ...run, logger: unrepeated, references, attempt: 2 }, work);
      } catch (error_) {
        throw isStoredRowsEvicted(error_) ? evictedTwice(error_) : error_;
      }
    }
  }));
}

/**
 * Where the second attempt's `blob_references` come from, after the first attempt's copy found rows
 * evicted. A blob key: populate again, which misses on that key and derives it, the store's ordinary
 * miss, handing its own rows (`'rows'`), so it reads no copy and cannot fail where a store-off run
 * succeeds. A row set: the run's reader forgets the evicted ids, so the data stage misses on exactly
 * them, extracts and writes them again, and the copies run as before (`'copy'`).
 *
 * @param error - The first attempt's eviction
 * @param cache - The run's store; a row-set eviction happens only with one
 * @param populationRun - The run, whose reader of the store forgets the evicted row sets
 * @returns The second attempt's references
 */
function referencesAfterEviction(error: StoredRowsEvictedError, cache: PopulationCache | undefined, populationRun: PopulationRun): QueryReferences {
  const { eviction } = error;
  if (eviction.tier === 'blob') return 'rows';
  if (cache === undefined) throw new Error('A row-set eviction reached a run with no store: the store-off data stage reads no stored row set.', { cause: error });
  populationRun.stored.of(cache.store).forgetRowSets(eviction.ids);
  return 'copy';
}

/**
 * The run's refusal when its one retry found rows evicted again.
 *
 * A write's eviction never selects what that write holds (`evictPastBudget` in projection-sqlite's
 * store), so what this query read and lost is another run's write to the same store; the budgets are fixed
 * in the build, so the remedies are what a user controls: when the runs happen, which store each
 * uses (`VAT_CACHE_DIR`), and, for the row-set tier, how many row sets this tree holds.
 *
 * @param error - The second attempt's eviction
 * @returns The refusal
 */
function evictedTwice(error: StoredRowsEvictedError): VatError {
  const rowSetRemedy = error.eviction.tier === 'rowSet'
    ? ' If it keeps happening while other runs share the store, this tree\'s row sets are a large share of the'
      + ' store\'s fixed row-set budget: route files the query does not need away with resources.extractors.data.exclude.'
    : '';
  return new VatError(
    PROJECTION_STORE_ROWS_EVICTED_CODE,
    `${error.message} It happened again on the run's one retry, so the run is refused. Another run wrote to the`
    + ' projection store while this query read it, and the store evicted rows this query held to keep within its'
    + ' fixed budget. Run again once the other run has finished, or give concurrent runs separate stores with'
    + ` VAT_CACHE_DIR.${rowSetRemedy}`,
    { cause: error },
  );
}

/** What one query run holds before it populates: see {@link askPopulatedProjection} for each field. */
interface QueryRun {
  readonly root: string;
  readonly logger: Logger;
  readonly statements: readonly string[];
  readonly base: string | undefined;
  readonly cache: PopulationCache | undefined;
  readonly populationRun: PopulationRun;
  readonly populationStart: number;
  /** Which attempt of the query this is, from 1: the lane retries once after an eviction. */
  readonly attempt: number;
}

/**
 * One population of the query lane and its answer: populate the resources projection, then hydrate
 * and ask it ({@link askPopulatedProjection}).
 *
 * @param run - The run's root, logger, statements, base, cache, population run and clock start,
 *   and where a store hit's `blob_references` come from (`populateForQuery`)
 * @param work - What runs against the hydrated database
 * @returns What `work` returns
 */
async function populateThenAsk<T>(
  run: QueryRun & { readonly references: QueryReferences },
  work: QueriedProjectionWork<T>,
): Promise<T> {
  const { root, logger, cache, populationRun, references } = run;
  // The cache tell is `populate()`'s own outcome — see `ProjectionProvenance.population`.
  const { projection, outcome, blobReferences } = await populateAndReport(
    { root, run: populationRun, cache, logger, population: 'resources' },
    (wiring) => buildResourceProjection({ root, ...wiring }, references),
    (result) => result.projection,
    (result) => storeMissOf(result.outcome),
  );
  return askPopulatedProjection({ ...run, projection, blobReferences, outcome }, work);
}

/**
 * The caller's work, given the asker, where its rows came from, how much of the tree they cover,
 * and the ROWS THEMSELVES.
 */
type QueriedProjectionWork<T> = (
  ask: AskProjection,
  provenance: ProjectionProvenance,
  extent: PopulationExtent,
  // 🔑 The in-memory rows, beside `ask` rather than instead of it: a built-in
  // check is a TypeScript predicate over the row model (no built-in may be
  // SQL) and needs the rows, not a database. Free to hand over — the
  // run database was loaded FROM them.
  //
  // ⚠️ Not a second way to ask the same question. Nothing here re-derives,
  // re-filters or re-scopes; a caller wanting a relational answer uses `ask`.
  // Of `blob_references` it holds the AST forms only (`astReferences`): a
  // lexical reference is answerable by SQL alone.
  projection: QueryProjection,
  // The shape of an answer, which its rows cannot carry when there are none.
  columnsOf: ColumnsOfStatement,
  // 🔑 One `DATA_FILE_NO_ROWS` error finding per routed data file that has no rows this run, empty
  // when no statement names a `data__*` relation. Every `data__*` relation answers without such a
  // file, so the caller must publish these: they are what keeps one broken file failing the run.
  dataFindings: readonly ValidationIssue[],
) => Promise<T> | T;

/**
 * The half of {@link withQueriedProjection} after population, over a projection already in hand:
 * plan the run from its statements, hydrate the run database with the planned relations' rows,
 * evaluate the planned lenses, and hand the caller a way to ask. In-process and store-free, so a
 * test can hold what a run database contains without a population.
 *
 * @param run - The populated run
 * @param run.projection - The run's own populated projection: what hydration fills every relation
 *   from but `blob_references`
 * @param run.blobReferences - Where `blob_references` come from: the projection's own rows, or the
 *   store the hit was served from, for exactly the keys it admitted (the source carries the store)
 * @param run.outcome - The population's outcome, for the cache tell
 * @param run.root - Absolute corpus root, for a lens that populates a lane of its own
 * @param run.logger - Where a lens's own population reports refused content
 * @param run.statements - Every statement this run may ask; what is hydrated and evaluated
 * @param run.base - The `--base` ref for the changed-files lens, or undefined
 * @param run.cache - The run's projection store, so a lens's own population can hit it
 * @param run.populationRun - The population run the projection was read through, so a
 *   lens's own population reads and parses through the same one
 * @param run.populationStart - When the population clock started (`performance.now()`)
 * @param work - The caller's work; the run database is open for exactly this call
 * @returns Whatever `work` returned
 */
export async function askPopulatedProjection<T>(
  run: QueryRun & {
    readonly projection: QueryProjection;
    readonly blobReferences: QueryReferenceSource;
    readonly outcome: Pick<PopulationOutcome, 'population'>;
  },
  work: QueriedProjectionWork<T>,
): Promise<T> {
  const { projection, outcome, root, logger, cache } = run;
  // 🔑 What the statements NAME, and nothing else — the projection tables to
  // hydrate, the lenses to evaluate, and what this run withholds. zones.md §2
  // carries why the lens half is narrowed.
  const plan = planHydration({ statements: run.statements, roots: projection.roots });
  const data = await stageData(run, plan.data);
  // ONE tree, in a database nothing else can reach, built fresh for this call
  // from this run's own rows and only the relations the plan names.
  const runDatabase = await hydrateRunDatabase({ projection, blobReferences: run.blobReferences, rowSets: data.sources }, plan);
  try {
    // 🚨 The population clock STOPS HERE, before the lens runs, so
    // `populationSecs` never contains `lensSecs`: the two are published side by
    // side to compare a served population against a derived one, and must not
    // overlap.
    const populationMs = performance.now() - run.populationStart;

    // The relations are still not behind a flag: a surface that exists only
    // when somebody remembered a flag is one nobody writes a check against.
    // What decides is the statement, which cannot be forgotten.
    //
    // ⛔ The narrowing is safe ONLY because an unplanned relation does not
    // EXIST in `runDatabase`: hydration creates only the planned tables and the
    // backend creates a derived table on the write that fills it, so a
    // statement reaching one fails `no such table` in SQLite itself — whatever
    // spelling slipped past the planner's scan. Create the relations up front
    // and this becomes a silent wrong answer: an empty table selecting zero rows.
    const { lenses } = plan;
    const lensStart = performance.now();
    // Sequential, not `Promise.all`: a lens may populate, and two
    // populations racing for one projection is the concurrency this
    // lane has no reason to invite.
    const lensPopulations: LensEvaluation['population'][] = [];
    const evaluated: string[] = [];
    // 🚨 A REFUSED lens writes nothing; a statement naming its relation is refused before it runs.
    const refusals = new Map<string, LensRefusal>(data.refusals);
    const absent = new Set(queryableRelationNames().filter((name) => !plan.relations.includes(name)));
    await writeDataRelations(runDatabase, data.derived, absent);
    await forEachInOrder(lenses, async (lens) => {
      const evaluation = await evaluateLens(lens, { projection, root, base: run.base, cache, populationRun: run.populationRun, logger });
      if ('refused' in evaluation) {
        for (const relation of lensRelationNames(lens)) refusals.set(relation, evaluation);
        return;
      }
      evaluated.push(lens.name);
      lensPopulations.push(evaluation.population);
      for (const relation of lensRelationNames(lens)) absent.delete(relation);
      await runDatabase.writeDerived(evaluation.rows);
    });
    // Exactly 0 when no lens was named, as `ProjectionProvenance.lensMs`
    // promises. Timing the empty loop instead published whatever a GC pause or
    // a descheduled thread put inside the span (2.97 ms on a loaded runner) as
    // lens cost.
    const lensMs = lenses.length === 0 ? 0 : performance.now() - lensStart;
    // The shared setup is done. Everything after this line is the caller's.

    /** Run one statement against the run database, unless it names a relation a lens refused. */
    const guarded = <R>(sql: string, execute: () => R): R => {
      const refused = refusedStatement(sql, refusals);
      if (refused !== undefined) throw refused;
      try {
        return execute();
      } catch (error) {
        throw describedFailure(sql, error, { absent, withheld: plan.withheld });
      }
    };
    const ask: AskProjection = (sql, ...parameters) => guarded(sql, () => runDatabase.query(sql, ...parameters));
    const columnsOf: ColumnsOfStatement = (sql, ...parameters) => guarded(sql, () => runDatabase.columns(sql, ...parameters));

    return await work(
      ask,
      {
        population: outcome.population,
        lensPopulation: lensPopulationOf(lensPopulations),
        populationMs,
        lensMs,
        // Only the lenses that ANSWERED: a refused one produced no relation.
        lensesEvaluated: evaluated,
      },
      // Read off the PROJECTION rather than counted back out of the run database with
      // a `SELECT COUNT(*)`: a count that travelled through the same `ask` the
      // caller's statements do would be broken by the very schema drift it
      // exists to survive, and it is the population's size either way.
      { membersEnumerated: projection.resourceRealizations.length },
      projection,
      columnsOf,
      data.findings,
    );
  } finally {
    // Closed however the work ends. An in-memory database is reclaimed with the
    // process either way, but a command that runs several of these in one
    // process would otherwise hold every one of them open.
    await runDatabase.close();
  }
}

/** What the `data` instance hands hydration, the run database and the statement guard. */
interface StagedData {
  /** Each named row-set table's source; empty when no statement names one. */
  readonly sources: ReadonlyMap<RowSetTableName, RowSetSource>;
  /** The named derived `data__*` relations' rows, and the workspace step's when it answered. */
  readonly derived: LensRows;
  /** One `DATA_FILE_NO_ROWS` finding per routed file that has no rows this run, in route order. */
  readonly findings: readonly ValidationIssue[];
  /** The workspace step's refusal, by each of its relations' SQL names; empty when it answered or did not run. */
  readonly refusals: ReadonlyMap<string, LensRefusal>;
}

/** A run that names no `data` relation: the stage does not run, and nothing of the instance is held. */
const NOTHING_STAGED: StagedData = { sources: new Map(), derived: {}, findings: [], refusals: new Map() };

/**
 * Run the `data` instance's stage for one attempt, when the statements demand it: routed by the
 * project's config, reading bytes only through the run's one content reader, extracting on the
 * run's dispatcher, and reading and writing the store through the run's one reader of it.
 *
 * @param run - The populated run
 * @param demand - What the statements demand of the instance, or undefined when they name none
 * @returns Each named relation's source or rows, and one finding per routed file with no rows
 * @throws CommandRefusalError `CONFIG_INVALID` when the declared instance routed nothing and does
 *   not allow that, before any statement runs
 */
async function stageData(
  run: Pick<QueryRun, 'root' | 'cache' | 'populationRun' | 'attempt'> & { readonly projection: QueryProjection },
  demand: DataDemand | undefined,
): Promise<StagedData> {
  if (demand === undefined) return NOTHING_STAGED;
  const { cache, populationRun } = run;
  const staged = await runDataStage({
    demand,
    projection: run.projection,
    routing: dataRoutingFor(loadConfigCached(run.root, 'source')),
    content: dataStageContentOf(populationRun.content),
    extractor: populationRun.dispatcher,
    store: cache === undefined ? undefined : { store: cache.store, reads: populationRun.stored.of(cache.store) },
    seams: await dataStageSeamsFor(cache?.store, run.attempt),
  });
  if (staged.outcome === 'examined-nothing') throw new CommandRefusalError('CONFIG_INVALID', staged.message);
  const workspace = workspaceRelations(staged.workspace);
  return { sources: staged.sources, derived: { ...staged.derived, ...workspace.rows }, findings: dataDefectIssues(staged.defects), refusals: workspace.refusals };
}

/**
 * The workspace step's answer as the run database takes it: its three relations' rows, or its
 * refusal under each of their names. The step ran inside the data stage, inside the lane's one
 * retry, so a row set it found evicted has already retried the attempt.
 *
 * Published as `RUN_INCOMPLETE` when the refusal is `retryable` (every refused root's input failed
 * for a cause the run decided: a time cap, a change under the run, a dead parse worker, a busy file
 * or exhausted descriptors), and as `INPUT_UNREADABLE` (the repository cannot answer) for every
 * refusal the tree decides. The step's own code (`WORKSPACE_*`, `DATA_REQUEST_UNROUTED`) leads the
 * message beside the file and the remedy: a broken check's `reason.refusal` admits only the lens
 * refusal codes.
 *
 * @param answer - The step's answer, or undefined when no workspace relation is named
 * @returns The rows to write, and the refusals
 */
export function workspaceRelations(answer: WorkspaceAnswer | undefined): { readonly rows: LensRows; readonly refusals: ReadonlyMap<string, LensRefusal> } {
  if (answer === undefined) return { rows: {}, refusals: new Map() };
  if (answer.outcome === 'rows') {
    return { rows: { workspacePackages: answer.packages, workspaceDependencies: answer.dependencies, workspaceConditions: answer.conditions }, refusals: new Map() };
  }
  const { refusal } = answer;
  const refused: LensRefusal = { refusal: refusal.retryable ? 'RUN_INCOMPLETE' : 'INPUT_UNREADABLE', refused: `${refusal.code}: ${refusal.message} Fix: ${refusal.remedy}.` };
  return { rows: {}, refusals: new Map(WORKSPACE_RELATIONS.map((name) => [name, refused] as const)) };
}

/**
 * The project's data routing findings over one run's realizations: each
 * `resources.extractors.data.include` glob that routes nothing (`DATA_INCLUDE_GLOB_INERT`), and each
 * credentials file a glob would route that the built-in rule refuses
 * (`DATA_CREDENTIAL_FILE_NOT_ROUTED`), resolved through the project's own `resources.validation`, so
 * a severity override (`ignore` drops them) holds on every verb. Never a refusal (the data stage
 * refuses only a block that routes nothing at all); `vat resources check` reports them as findings,
 * and `vat resources query`, whose document carries only the data files its answer omits
 * (`DATA_FILE_NO_ROWS`), writes them to stderr.
 *
 * @param root - The project root whose config routes the instance
 * @param projection - The run's projection
 * @param projection.resourceRealizations - Its realizations, the paths a glob can match
 * @returns The findings, resolved
 */
export function dataRoutingFindings(root: string, projection: Pick<QueryProjection, 'resourceRealizations'>): readonly ValidationIssue[] {
  const config = loadConfigCached(root, 'source');
  const routing = dataRoutingFor(config);
  return resolveFindings([
    ...dataIncludeGlobInertFindings(projection.resourceRealizations, routing),
    ...dataCredentialFileFindings(projection.resourceRealizations, routing),
  ], config?.resources?.validation ?? {});
}

/**
 * Whether a statement names a relation of the `data` instance: the one case a query's warning about
 * an inert include glob is about its answer.
 *
 * @param sql - The statement
 * @param roots - The run's roots, as hydration plans with them
 * @returns True when it names a `data__*` relation
 */
export function namesDataRelation(sql: string, roots: readonly unknown[]): boolean {
  return planHydration({ statements: [sql], roots }).data !== undefined;
}

/** The derived relations the `data` stage and the workspace step over it fill, by registry key. */
const DATA_DERIVED_NAMES: ReadonlyMap<string, string> = new Map(
  allDerivedSpecs().filter((spec) => spec.producer !== 'lens').map((spec) => [spec.key, spec.name] as const),
);

/**
 * Write the derived `data__*` relations the stage built into the run database, after hydration,
 * and mark each written one held.
 *
 * @param runDatabase - The hydrated run database
 * @param derived - The stage's derived rows
 * @param absent - The relations the run database does not hold, by SQL name; each written one leaves it
 */
async function writeDataRelations(
  runDatabase: Pick<Awaited<ReturnType<typeof hydrateRunDatabase>>, 'writeDerived'>,
  derived: LensRows,
  absent: Set<string>,
): Promise<void> {
  const written = Object.keys(derived).flatMap((key) => DATA_DERIVED_NAMES.get(key) ?? []);
  if (written.length === 0) return;
  await runDatabase.writeDerived(derived);
  for (const name of written) absent.delete(name);
}

/**
 * Turn a rejected statement into a message that names the surface it missed.
 *
 * ## Why this wrapper exists
 *
 * VAT ships no schema version, by standing rule — the *cache* is safe across a
 * shape change because its digest self-invalidates, but submitted SQL is not: it
 * simply breaks. Pre-1.0 that is acceptable. A raw SQLite error reaching the
 * user is not, because `no such column: contentHash` says nothing about what the
 * column is called now. It matters more for a CHECK than for a query: a query's
 * author is at the keyboard, while a check's author wrote it months ago and the
 * person reading the failure is someone else.
 *
 * ⚠️ **A legibility wrapper, not a validator.** It does not parse SQL and does
 * not check a statement before running it — it reacts to a failure by listing
 * what the query COULD have named. When the statement mentions a known table,
 * that table's columns are listed, which is the case that actually answers "what
 * moved"; otherwise the table names are, which at least answers "what is there".
 *
 * 🪤 **Only a name that was not found gets the listing.** The engine also refuses
 * a write and this backend refuses a second statement, and neither is answered by
 * a column list — appending one says the problem is the schema when the problem
 * is what the caller asked for. A wrapper that decorates every failure identically
 * teaches the reader to skip the decoration, which costs the case it was written for.
 *
 * Matching is a plain lowercase substring test rather than a regex: the input is
 * user text, and a pattern built from it is both a lint failure here and a
 * needless hazard.
 *
 * @param sql - The statement that was submitted
 * @param message - What the engine said
 * @param unhydrated - The queryable relations the database does not hold, by SQL name
 * @returns The message to surface, with the queryable surface appended when the
 *   failure was a name this projection does not have
 */
export function describeQueryFailure(sql: string, message: string, unhydrated: UnhydratedRelations): string {
  if (!NAME_NOT_FOUND.some((prefix) => message.includes(prefix))) return message;

  // 🚨 AN UNHYDRATED RELATION IS NOT A TYPO — it is the refusal that makes
  // hydrating only the named relations safe. The run database holds a relation
  // only when the plan hydrated it or a lens filled it, so any other is absent,
  // and SQLite refuses it rather than answering `0` from an empty table
  // (indistinguishable from an empty tree, and for `vat resources check` a rule
  // that could no longer fail). Every unhydrated relation is treated alike, and
  // none of its columns is listed. Which relation is the one the ENGINE named
  // in `no such table` — never a word found elsewhere in the statement, which
  // may sit in a literal or a comment. The compile probe holds them all.
  const unheld = unhydratedRelationOf(message, unhydrated);
  if (unheld !== undefined) return `${message}\n\n${unheld}`;

  // 🪤 The derived relations belong in this listing even though they are not
  // projection tables. A user who mistypes `edge_resolution` gets "no such
  // table" and a list of everything they could have meant — and a list that
  // omitted the very relation they were reaching for would read as proof it
  // does not exist. What the listing answers is "what can I name here", which
  // is the queryable surface, not the registry.
  //
  // Which relations the statement names is read by the scan the planner and the gate share, so a
  // relation spelled only inside a literal or a comment is not listed as one the statement reads.
  const askable = queryableRelationSpecs();
  const held = askable.filter((spec) => !unhydrated.absent.has(spec.name));
  const namedNames = new Set(relationsNamedBy(sql, held.map((spec) => spec.name)));
  const named = held.filter((spec) => namedNames.has(spec.name));
  const surface = named.length > 0
    ? named.map((spec) => `  ${spec.name}(${spec.columns.join(', ')})`).join('\n')
    : askable.map((spec) => `  ${spec.name}`).join('\n');
  const heading = named.length > 0
    ? 'The tables this statement names hold these columns:'
    : 'This tree is queryable through these relations:';

  return `${message}\n\n${heading}\n${surface}`;
}

/** The first whitespace-free run of a message: the name SQLite put after `no such table: `. */
const LEADING_TOKEN = /^\S+/u;

/**
 * The queryable relation SQLite named in a `no such table` message, by SQL name, or undefined.
 * Schema-qualified (`main.edges`) and any case are read as the relation they spell.
 *
 * @param message - What the engine said
 * @returns The relation
 */
function missingRelationOf(message: string): string | undefined {
  const at = message.indexOf(NO_SUCH_TABLE);
  if (at < 0) return undefined;
  const spelled = LEADING_TOKEN.exec(message.slice(at + NO_SUCH_TABLE.length))?.[0] ?? '';
  const bare = spelled.slice(spelled.lastIndexOf('.') + 1).toLowerCase();
  return queryableRelationNames().find((name) => name.toLowerCase() === bare);
}

/**
 * Why the engine found no table for a relation this run database does not hold, or undefined when
 * the table it named is no queryable relation. Read ONLY from the engine's `no such table`: a
 * withheld relation names its reason; any other names the spellings a statement reads it by.
 *
 * @param message - What the engine said
 * @param unhydrated - What the run database does not hold
 * @returns The explanation, or undefined
 */
function unhydratedRelationOf(message: string, unhydrated: UnhydratedRelations): string | undefined {
  const missing = missingRelationOf(message);
  if (missing === undefined) return undefined;
  const reason = unhydrated.withheld.get(missing);
  if (reason !== undefined) return `This statement reads ${missing}, which this run withheld: ${reason}.`;
  if (!unhydrated.absent.has(missing)) return undefined;
  return `This statement reads ${missing}, which this run did not hydrate: a statement reads a relation only when`
    + ` it names it itself as an identifier — ${identifierSpellings(missing).join(', ')}.`
    + ` A single-quoted '${missing}' is a string, not a name. Name it as an identifier in this statement.`;
}
