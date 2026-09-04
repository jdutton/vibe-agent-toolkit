/**
 * Populating a tree's resource projection and putting it somewhere ASKABLE —
 * the shared half of every command that runs SQL over it.
 *
 * `vat resources query` runs one statement a person typed; `vat resources check`
 * runs the statements a project wrote down. They differ in what they do with
 * rows and in nothing else: same population, same store selection, same
 * ephemeral fallback, same cache tell. This module is that "and in nothing
 * else", stated once so the two cannot drift into answering about different
 * corpora.
 *
 * ## 🚨 The SQL ALWAYS runs against a per-run in-memory database. Never the store.
 *
 * This is a correctness property, not an optimisation choice, and it was learned
 * the expensive way. The on-disk projection store is **one database per VAT
 * release, shared by every root on the machine** (`defaultStoreDirectory()` is
 * `tmpdir/.vat-cache/<version>/projection-<shapeDigest>`), it retains three tree
 * hashes per root, and its blob tier is never evicted and carries no tree key at
 * all. `ProjectionStore.readExtent` narrows by `(rootId, treeHash)`; **arbitrary
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
 * `populate()` returns — served from the store or derived — is written into a
 * fresh in-memory database that holds this tree and nothing else, and the SQL
 * runs there. The saving is untouched (it was always in the population: on this
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
  buildResourceProjection,
  PROJECTION_TABLES,
  splitProjectionByScope,
} from '@vibe-agent-toolkit/resources';

import { gitTrackerForProjectRoot } from '../commands/audit/distributed-tree.js';

import type { Logger } from './logger.js';
import { populationWiring } from './population-wiring.js';
import { openEphemeralQueryStore, withPopulationCache } from './projection-store.js';

/**
 * The tree hash an in-memory store's one population is filed under.
 *
 * ⚠️ Deliberately NOT a tree hash. Nothing else ever opens this database, no
 * read-back compares the key against another run's, and the store is gone at the
 * end of the call — so the key only has to be internally consistent. A real
 * `git write-tree` here would cost a spawn to produce a value nobody reads, and
 * would invite the reader to believe the ephemeral store is shareable.
 */
const EPHEMERAL_TREE_HASH = 'ephemeral';

/** What SQLite says when a statement names something the schema does not have. */
const NAME_NOT_FOUND: readonly string[] = ['no such table:', 'no such column:'];

/** Where the POPULATION a statement ran against came from. */
export type PopulationOrigin = 'derived' | 'store';

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
   * rows. A hit short-circuits `populate()` before the builder exists, so no
   * contributor timing is filed — an empty record list IS the hit.
   *
   * It describes the POPULATION, which is the only thing the store now affects.
   */
  readonly population: PopulationOrigin;

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
   * `openSqliteProjectionStore()`), the git tracker, `buildResourceProjection`,
   * opening the ephemeral database, and writing the blob tier and the extent
   * into it.
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
   * one row (the invariant thrown for below), so a total over all twelve tables
   * is never 0; `blobs` is content-keyed and deduped, so it counts parse REACH
   * and already has its own guard in `onBlobPopulation`; and `resources` counts
   * identities, which a corpus can legitimately have none of while enumerating
   * plenty. One row per enumerated path is non-zero exactly when something was
   * enumerated.
   */
  readonly membersEnumerated: number;
}

/** Run one read-only statement against the populated projection. */
export type AskProjection = (
  sql: string,
  ...parameters: readonly string[]
) => readonly Record<string, unknown>[];

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
 * @param statements - Every statement the run will ask, in any order
 * @throws The same legible failure `ask` throws, for the first statement that
 *   does not compile
 */
export async function assertQueriesCompile(statements: readonly string[]): Promise<void> {
  if (statements.length === 0) return;
  const probe = await openEphemeralQueryStore();
  try {
    for (const sql of statements) {
      try {
        probe.assertCompiles(sql);
      } catch (error) {
        throw new Error(
          describeQueryFailure(sql, error instanceof Error ? error.message : String(error)),
        );
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
 * @param options.logger - Where blob-stage refusals are reported (stderr, so a
 *   parseable document on stdout stays parseable)
 * @param options.preflight - Every statement this run intends to ask, compiled
 *   against the empty schema BEFORE the population starts. See
 *   {@link assertQueriesCompile}
 * @param work - Given the asker, where its rows came from, and how much of the
 *   tree they cover. The store is open for exactly this call and closed however
 *   it ends
 * @returns Whatever `work` returned
 */
export async function withQueriedProjection<T>(
  options: { root: string; logger: Logger; preflight?: readonly string[] },
  work: (
    ask: AskProjection,
    provenance: ProjectionProvenance,
    extent: PopulationExtent,
  ) => Promise<T> | T,
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
  // dynamic import and `openSqliteProjectionStore()` — BEFORE it invokes the
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
  let contributorRecords = 0;
  const populationStart = performance.now();

  // The file-backed store, when one is selected, and ONLY as a population cache.
  // Its rows are never queried — see the header.
  return withPopulationCache({ root }, async (cache) => {
    // The cache tell. `populate()` short-circuits a hit before any contributor
    // is constructed, so this staying at zero is the ONLY observable difference
    // between a served population and a re-derived one. Declared with the clock
    // above rather than here so the two cannot drift apart when one moves.
    const gitTracker = await gitTrackerForProjectRoot(root);
    const projection = await buildResourceProjection({
      root,
      ...populationWiring(logger, gitTracker, cache, root),
      onContributorTiming: () => {
        contributorRecords += 1;
      },
    });

    // ONE tree, in a database nothing else can reach, built fresh for this call.
    const store = await openEphemeralQueryStore();
    try {
      // The key is read OFF the projection rather than re-derived from the root.
      // The driver mints `roots.id` with `rootIdFor` and every
      // `resolution_contexts.rootId` is a foreign key into it, so taking it from
      // the rows means the key provably describes them — a second derivation
      // could drift from the first and file rows under an id they do not carry.
      const rootId = projection.roots[0]?.id;
      if (rootId === undefined) {
        throw new Error(
          'The population produced no root row, so there is no id to file its extent under.'
          + ' This is a driver invariant rather than a user error — `populate()` adds exactly'
          + ' one, and a projection without it cannot be stored or queried.',
        );
      }
      const { blobs, extent } = splitProjectionByScope(projection);
      await store.writeBlobFacts(blobs);
      await store.writeExtent({ rootId, treeHash: EPHEMERAL_TREE_HASH }, extent);
      // The shared setup is done. Everything after this line is the caller's.
      const populationMs = performance.now() - populationStart;

      const ask: AskProjection = (sql, ...parameters) => {
        try {
          return store.query(sql, ...parameters);
        } catch (error) {
          throw new Error(
            describeQueryFailure(sql, error instanceof Error ? error.message : String(error)),
          );
        }
      };

      return await work(
        ask,
        { population: contributorRecords === 0 ? 'store' : 'derived', populationMs },
        // Read off the PROJECTION rather than counted back out of the store with
        // a `SELECT COUNT(*)`: a count that travelled through the same `ask` the
        // caller's statements do would be broken by the very schema drift it
        // exists to survive, and it is the population's size either way.
        { membersEnumerated: projection.resourceRealizations.length },
      );
    } finally {
      // Closed however the work ends. An in-memory database is reclaimed with the
      // process either way, but a command that runs several of these in one
      // process would otherwise hold every one of them open.
      await store.close();
    }
  });
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
 * @returns The message to surface, with the queryable surface appended when the
 *   failure was a name this projection does not have
 */
export function describeQueryFailure(sql: string, message: string): string {
  if (!NAME_NOT_FOUND.some((prefix) => message.includes(prefix))) return message;

  const lowered = sql.toLowerCase();
  const named = Object.values(PROJECTION_TABLES).filter((spec) =>
    lowered.includes(spec.name.toLowerCase()),
  );
  const surface = named.length > 0
    ? named.map((spec) => `  ${spec.name}(${spec.columns.join(', ')})`).join('\n')
    : Object.values(PROJECTION_TABLES).map((spec) => `  ${spec.name}`).join('\n');
  const heading = named.length > 0
    ? 'The tables this statement names hold these columns:'
    : 'The projection holds these tables:';

  return `${message}\n\n${heading}\n${surface}`;
}
