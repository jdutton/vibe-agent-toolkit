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
 * runs there. The saving is untouched (it was always in the population: 1.06 s
 * cold against 0.194 s warm), and "one tree, one answer" stops being a claim
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
   * the tell stops being a bare label a reader has to take on faith. Measured on
   * this repository the two are roughly **1.06 s derived against 0.19 s warm**.
   *
   * The wall time of the SHARED setup and nothing else: everything
   * {@link withQueriedProjection} does before it hands control to the caller's
   * work — the git tracker, `buildResourceProjection`, opening the ephemeral
   * database, and writing the blob tier and the extent into it.
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
 * Populate the tree, load it into something askable, and hand the caller a way
 * to ask.
 *
 * @param options - The run
 * @param options.root - Absolute corpus root
 * @param options.logger - Where blob-stage refusals are reported (stderr, so a
 *   parseable document on stdout stays parseable)
 * @param work - Given the asker, where its rows came from, and how much of the
 *   tree they cover. The store is open for exactly this call and closed however
 *   it ends
 * @returns Whatever `work` returned
 */
export async function withQueriedProjection<T>(
  options: { root: string; logger: Logger },
  work: (
    ask: AskProjection,
    provenance: ProjectionProvenance,
    extent: PopulationExtent,
  ) => Promise<T> | T,
): Promise<T> {
  const { root, logger } = options;

  // The file-backed store, when one is selected, and ONLY as a population cache.
  // Its rows are never queried — see the header.
  return withPopulationCache({ root }, async (cache) => {
    // The cache tell. `populate()` short-circuits a hit before any contributor
    // is constructed, so this staying at zero is the ONLY observable difference
    // between a served population and a re-derived one.
    let contributorRecords = 0;
    // Opened before the first thing the shared setup does and read after the
    // last, so `populationMs` covers exactly what BOTH verbs pay and nothing a
    // caller's work does. `performance.now()` rather than `Date.now()` because a
    // warm population is routinely sub-millisecond — see `populationMs`.
    const populationStart = performance.now();
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
