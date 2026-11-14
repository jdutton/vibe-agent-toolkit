/**
 * The run database: the one handle SQL runs on, and the compile probe beside it.
 *
 * A run's statements never reach the fact store. That store is **one database
 * per VAT release, shared by every root on the machine**, and arbitrary SQL
 * carries no key predicate, so a statement run there answers from every
 * projection on the machine. The run database is filled from one run's
 * {@link Projection} when it is opened, holds that tree and nothing else, and
 * is gone when it closes.
 *
 * ## Why it cannot become a second storage contract
 *
 * It is declared here, in the implementing package, and nowhere else. It shares
 * no operation with the `FactStore` port — it has no read, write or extent
 * operation, since it is filled when opened — so neither type is assignable to
 * the other. And only the CLI's one store module may import this package
 * (`local/projection-sqlite-import-boundary`).
 *
 * ⚠️ Transitional: it is opened from a whole populated projection, every relation
 * copied. Hydrating only the relations a run's statements need replaces
 * {@link openRunDatabase}, and the run database stays as hydration's result.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';

import {
  type DerivedTableName,
  type DerivedTableSpec,
  type ProjectionColumnType,
  type Projection,
  allDerivedSpecs,
  projectionColumnTypes,
  quoteIdentifier,
  splitProjectionByScope,
} from '@vibe-agent-toolkit/resources';
import { promised } from '@vibe-agent-toolkit/utils';

import { createDerivedTableSql, insertDerivedSql } from './schema-sql.js';
import { runGated } from './sql-gate.js';
import {
  createSchema,
  DEFAULT_RETENTION,
  inTransaction,
  prepareStoreTables,
  type WriteCounters,
  writeBlobRows,
  writeExtentRows,
} from './store.js';
import { encodeValue, type SqliteValue } from './values.js';

/**
 * Loading a run database is hydration, which ADR I10 does not bound: one write
 * for the extent, one for the blob facts when the projection names a content
 * key, and every row each inserted.
 */
const HYDRATION_WRITES: WriteCounters = { writes: 'hydration.writes', rowsWritten: 'hydration.rows.written' };

/**
 * The tree hash a run database's one extent is filed under.
 *
 * ⚠️ Deliberately NOT a tree hash. Nothing else ever opens this database, no
 * read-back compares the key against another run's, and the database is gone at
 * the end of the run — so the key only has to be internally consistent. A real
 * git tree hash here would cost a spawn to produce a value nobody reads.
 */
const RUN_TREE_HASH = 'ephemeral';

/**
 * The one handle SQL runs on: one run's projection, in memory, plus the derived
 * relations the run's lenses write.
 *
 * SQL is declared here and not on the `FactStore` port because it is a
 * property of *this backend*, not of storing a projection. The export format is
 * deliberately engine-free so a consumer can choose DuckDB, a JSON reader or a
 * golden diff; a `query` on the port would quietly make SQLite the one engine
 * every future backend had to reimplement.
 */
export interface RunDatabase {
  /**
   * Run one read-only statement and return its rows.
   *
   * 🪤 **Values come back exactly as SQLite holds them** — a boolean as `0`/`1`,
   * a date and a JSON column as text. This does not run `decodeRows`, and the
   * reason is that it *cannot*: decoding needs a {@link StoredTableSpec}, and
   * arbitrary SQL has none. `SELECT COUNT(*)`, an alias, a join and an
   * expression all produce columns no registry describes. Decoding only bare
   * column selections would mean one store answering `true` or `1` for the same
   * underlying row depending on how the caller phrased the question.
   *
   * @param sql - One `SELECT`, `WITH` or `VALUES` statement
   * @param parameters - Bound in order, for every `?` in the statement — and
   *   exactly one per `?`. The engine refuses a value with no slot but binds a
   *   slot with no value to NULL, which on this surface is a wrong answer that
   *   reports success; both directions are refused here, naming the counts
   * @returns The rows, in the order SQLite produced them
   * @throws If the statement is not a query (`SELECT`, `WITH` or `VALUES`), if
   *   it is not read-only, if it is more than one statement, if its
   *   placeholders and `parameters` do not pair off exactly, if it names a
   *   parameter (`:x`) positional values cannot reach, if two result columns
   *   share a name, or if SQLite rejects it — an unknown column included
   */
  query(sql: string, ...parameters: readonly SqliteValue[]): readonly Record<string, unknown>[];

  /**
   * The result columns one read-only statement would produce, in order —
   * without running it.
   *
   * 🔑 Beside {@link RunDatabase.query} rather than folded into it,
   * because rows cannot carry this: a statement that selects nothing still has
   * a shape, and a caller that read its column names off the first row would
   * publish none for every empty answer. SQLite knows the names at PREPARE
   * time, so this compiles and never steps — no row is computed.
   *
   * @param sql - One `SELECT`, `WITH` or `VALUES` statement
   * @param parameters - The values {@link RunDatabase.query} would bind, gated the same way
   * @returns Each result column's name — its alias where the statement gives one
   * @throws What {@link RunDatabase.query} throws for a statement refused
   *   by its gates or when it COMPILES — a write, an unknown name, a statement
   *   with no result column, two columns under one name. ⚠️ Not a refusal SQLite
   *   raises only when the statement RUNS (`json('{bad')`, a value over the
   *   length limit): this never steps, so it cannot see one.
   */
  columns(sql: string, ...parameters: readonly SqliteValue[]): readonly string[];

  /**
   * Write the rows one lens evaluation produced, so SQL can ask about them.
   *
   * A lens's rows never reach the fact store, and that is a property of the
   * types: this is the only handle with this method, and the factory of the
   * file-backed store returns the `FactStore` port, which has none.
   *
   * The table is created by the first write that names it — an empty array
   * included, because "evaluated, no rows" is a real answer. Until then a
   * statement naming it fails with SQLite's own `no such table`. That absence is
   * the query lane's refusal of a relation no lens filled: a table that existed
   * EMPTY would answer `SELECT COUNT(*)` with `0` at exit 0, and nothing that
   * scans the statement's text can be trusted to notice every way of naming it.
   * ⛔ Do not "simplify" by creating every derived relation up front.
   *
   * ⛔ Nor by moving the derived DDL into `createSchema`. That is the obvious
   * "why do these two schemas differ?" cleanup, and it would make the write
   * succeed silently on a database shared by every
   * repository on the machine — where the rows are also **unevictable** (they
   * carry no extent key, and eviction goes by the extent manifest) and where
   * this method's per-relation `DELETE` has **no root predicate**, so one
   * repository's evaluation would empty another's.
   *
   * The rule matters because the on-disk store is **one database per VAT
   * release, shared by every root on the machine**, retaining three tree hashes
   * per root. A lens's rows are a function of bytes AND of the lens, and a
   * question asked once — so persisting them would mean a later run reading one
   * lens's answers under another lens's question, across repositories.
   *
   * ⚠️ **Replaces the relation's contents.** Two evaluations in one process are
   * two answers to two questions, not an accumulation; appending would silently
   * union them and make every `GROUP BY` double-count.
   *
   * @param rows - Each derived relation's rows, keyed by `DERIVED_TABLES`'s own
   *   keys. A relation the caller omits is left UNTOUCHED — not emptied, and
   *   not created
   * @throws If a row carries a value no column type can store
   */
  writeDerived(rows: DerivedRows): Promise<void>;

  /** Release the connection. Idempotent; every other call refuses afterwards. */
  close(): Promise<void>;
}

/**
 * The full queryable schema — every projection table AND every derived
 * relation — holding no rows, able only to COMPILE a statement.
 *
 * 🔑 **Why this is not a method on {@link RunDatabase}.** A statement is
 * compiled before the run has evaluated any lens, so the preflight needs every
 * derived relation to exist. The run database deliberately has none until a lens
 * writes it — that absence is how a statement over an unevaluated relation is
 * refused. A compile method on the run database would therefore reject every
 * check over `edges`; one on a database WITH the relations would be a run database
 * whose empty tables answer `0`. A type that can compile and cannot answer is
 * the only shape where neither mistake is expressible.
 */
export interface ProjectionCompileProbe {
  /**
   * Compile one statement and throw it away, running NOTHING.
   *
   * 🔑 **The point is what it does not do.** SQLite resolves every table and
   * column name at *prepare* time, so a typo is knowable before a single row
   * exists — but the only way to learn that was to run the statement, and by
   * then the caller had paid for a full projection population. Measured on a
   * real adopter: `SELECT path, no_such_column FROM blobs` cost **8.3 s**, all
   * of it building a projection the statement could never have read.
   *
   * ⚠️ It must not EXECUTE, and that is why this exists rather than a
   * `query()` against an empty store. Execution is where a check's unbounded
   * cost lives — `WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c)`
   * compiles instantly and then never returns, so a preflight that stepped it
   * would hang before the run it was meant to make cheap even started.
   * `EXPLAIN` is not the alternative: `assertIsQuery` refuses it by
   * design, because admitting a prefix means deciding safety past the first
   * token.
   *
   * Runs the same kind, single-statement and placeholder-count gates as
   * {@link RunDatabase.query}, so a statement refused for what it IS — or for what the
   * caller forgot to bind — is refused just as early as one refused for what
   * it names.
   *
   * @param sql - One `SELECT`, `WITH` or `VALUES` statement
   * @param parameters - What the caller WILL bind when it runs the statement.
   *   Required rather than defaulted, because an omitted argument would read as
   *   "no values" and silently pass every under-bound statement through the
   *   very preflight meant to catch it early
   * @throws The same errors {@link RunDatabase.query} throws for a statement that is not a
   *   query, is more than one statement, does not pair its placeholders with
   *   `parameters`, or names something the schema lacks
   */
  assertCompiles(sql: string, parameters: readonly SqliteValue[]): void;

  /** Release the connection. Idempotent; every other call refuses afterwards. */
  close(): Promise<void>;
}

/**
 * The rows of one lens evaluation, keyed by {@link DERIVED_TABLES}'s own keys.
 *
 * Every relation is optional, and omitting one leaves it UNTOUCHED while passing
 * an empty array CLEARS it.
 *
 * 🪤 **Omitting is not equivalent to passing empty, and the difference is a
 * hazard rather than a convenience.** An earlier docstring said the two "read
 * the same to SQL" — true only on a virgin store. Write `{lensContexts, edges}`
 * and then `{edges}`, and `edges` describes the second evaluation while
 * `lens_contexts` still describes the first: a join across two answers to two
 * questions, which is the exact double-count `writeDerived` clears each relation
 * to prevent. ⇒ **A caller should pass every relation it evaluated, every time.**
 * `EvaluatedLenses` makes all three fields required for precisely this reason.
 */
type DerivedRows = {
  readonly [Name in DerivedTableName]?: readonly Record<string, unknown>[];
};

/**
 * One derived relation's prepared statements.
 *
 * Deliberately not a `TablePlan` (in `store.ts`) with the extent fields left absent: six
 * of that type's seven optional members exist to serve the extent partition,
 * which a derived relation does not have, and reusing it would invite a reader
 * to look for a `selectExtent` that is missing for a reason no comment states.
 * The statement-reuse requirement in `TablePlan`'s header applies here
 * identically, which is why these are memoized rather than prepared per write.
 */
interface DerivedPlan {
  readonly spec: DerivedTableSpec;
  /** Each declared column paired with what it holds, in registry order. */
  readonly columns: readonly (readonly [column: string, type: ProjectionColumnType])[];
  readonly insert: StatementSync;
  /** Empty the relation, so one evaluation replaces another rather than joining it. */
  readonly clear: StatementSync;
}

/**
 * Open the run database over one run's projection.
 *
 * The point is not speed — it is that **the same SQL gets the same answer
 * whether or not a fact store exists**. Whatever `populate()` returns, served
 * from the store or derived, is loaded here, and the SQL runs here.
 *
 * Takes the whole projection, every relation copied, and nothing else.
 *
 * 🪤 **This deliberately does not configure the connection the way the
 * file-backed store does, and that is not a tidiness choice.** Every pragma that
 * configuration sets is a property of a *file*:
 *
 * - `journal_mode = WAL` is the sharp one. On an in-memory database SQLite
 *   *accepts the statement without throwing* and leaves the mode at `memory`,
 *   so the WAL switch's retry loop never sees `'wal'`, burns every attempt on a
 *   blocking wait, and ends about a second later naming a rollback journal,
 *   when this is a memory journal. Wrong answer, wrong diagnosis, one second of
 *   latency to deliver them.
 * - `busy_timeout` covers contention between connections; nothing else can
 *   reach this database.
 * - `auto_vacuum` and `synchronous` describe how pages reach a file there is
 *   none of.
 *
 * @param projection - One run's populated projection
 * @returns The open run database, holding that projection; close it when done
 * @throws Error When the projection has no root row: a driver invariant, since
 *   `populate()` adds exactly one, and without it there is no id to file the
 *   extent under
 */
export function openRunDatabase(projection: Projection): RunDatabase {
  // The key is read OFF the projection rather than re-derived from the root.
  // The driver mints `roots.id` with `rootIdFor` and every
  // `resolution_contexts.rootId` is a foreign key into it, so taking it from
  // the rows means the key provably describes them.
  const rootId = projection.roots[0]?.id;
  if (rootId === undefined) {
    throw new Error(
      'The population produced no root row, so there is no id to file its extent under.'
      + ' This is a driver invariant rather than a user error — `populate()` adds exactly'
      + ' one, and a projection without it cannot be stored or queried.',
    );
  }
  const database = new DatabaseSync(':memory:');
  try {
    createSchema(database);
    // 🚨 NO derived relation is created here. Each is created by the first
    // `writeDerived` that names it, so a relation no lens evaluated is ABSENT
    // and a statement naming it fails `no such table` — see `writeDerived`.
    // Creating them all up front would turn that refusal back into an empty
    // table that answers `0`. And never in `createSchema`: it is shared with
    // the file-backed store, which a lens's rows must never enter.
    const tables = prepareStoreTables(database, DEFAULT_RETENTION);
    const { blobs, extent } = splitProjectionByScope(projection);
    writeBlobRows(tables, blobs, HYDRATION_WRITES);
    writeExtentRows(tables, { rootId, treeHash: RUN_TREE_HASH }, extent, HYDRATION_WRITES);
  } catch (error) {
    database.close();
    throw error;
  }
  return new SqliteRunDatabase(database);
}

/**
 * Open a {@link ProjectionCompileProbe}: the full queryable schema, derived
 * relations included, in memory, with no rows and no way to ask for any.
 *
 * Every derived relation is created up front HERE, which is exactly what the
 * run database must not do — and safe here only because nothing can read this
 * database's empty tables as an answer.
 *
 * @returns An open probe; close it when done
 */
export function openProjectionCompileProbe(): ProjectionCompileProbe {
  const database = new DatabaseSync(':memory:');
  createSchema(database);
  for (const spec of allDerivedSpecs()) {
    database.exec(createDerivedTableSql(spec));
  }
  return new SqliteCompileProbe(database);
}

/** The {@link ProjectionCompileProbe} contract over one in-memory connection. */
class SqliteCompileProbe implements ProjectionCompileProbe {
  readonly #database: DatabaseSync;
  #closed = false;

  /** @param database - An open connection holding the full queryable schema */
  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  /** @inheritdoc */
  assertCompiles(sql: string, parameters: readonly SqliteValue[]): void {
    if (this.#closed) throw new Error('This compile probe is closed');
    // Compiled and discarded: the step callback does nothing. `.all()` is
    // deliberately NOT called — stepping is the unbounded half, and the whole
    // value of this method is being the half that is not.
    runGated(this.#database, sql, parameters, () => undefined);
  }

  /** @inheritdoc */
  close(): Promise<void> {
    return promised(() => {
      // Nothing reads this database after the preflight, so there is no
      // transaction or statement cache to settle first.
      if (!this.#closed) {
        this.#closed = true;
        this.#database.close();
      }
    });
  }
}

/** The {@link RunDatabase} contract over one in-memory connection. */
class SqliteRunDatabase implements RunDatabase {
  readonly #database: DatabaseSync;
  /**
   * Derived-relation statements by registry key, each prepared by the write that
   * CREATED its table — so a key's presence here means the relation exists. See
   * {@link SqliteRunDatabase.writeDerived}.
   */
  readonly #derivedPlans = new Map<string, DerivedPlan>();
  #closed = false;

  /** @param database - An open in-memory connection, already loaded */
  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  /** @inheritdoc */
  query(sql: string, ...parameters: readonly SqliteValue[]): readonly Record<string, unknown>[] {
    this.#assertOpen();

    // 🪤 Read-only-ness is `PRAGMA query_only` and NOT an inspection of the
    // statement, because there is nothing useful to inspect: `StatementSync`
    // exposes no read-only flag (verified on Node 24.13.1 — `readOnly` is simply
    // absent), so the alternative would be pattern-matching the caller's SQL,
    // which is a denylist and loses to the first `WITH c AS (…) DELETE FROM …`
    // nobody thought of — real SQLite grammar, and measured reaching the engine.
    // The pragma is the engine refusing, which no phrasing talks out of it.
    // The kind gate in `sql-gate.ts` reads one token; it composes with this
    // rather than replacing it.
    //
    // ⚠️ **The blast radius, as shipped.** Two axes, and the pragma only covers
    // the first.
    //
    // *Writes.* Measured on Node 24.13.1 under `query_only = 1`: `DELETE` is
    // refused, and so are temp tables and views, `load_extension` and
    // `readfile`. `VACUUM INTO '/any/path'` throws `attempt to write a readonly
    // database` but creates the file first. `ATTACH DATABASE '/any/path' AS x`
    // is ACCEPTED and creates a zero-byte file there — a nuisance-write
    // primitive rather than a destructive one, since neither truncates an
    // existing non-SQLite file (`ATTACH` on one fails `file is not a database`
    // with the contents intact). `ATTACH` and `PRAGMA` no longer arrive here at
    // all: the kind gate refuses both, which also closed `PRAGMA cache_size` and
    // `PRAGMA temp_store_directory = '/tmp'`, each of which the pragma accepted.
    //
    // *Compute and memory, uncovered.* There is **no timeout and no row cap**,
    // and `.all()` materialises every row before returning. A runaway statement
    // therefore blocks the event loop, which is why no in-process timer can
    // rescue it: `WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c)
    // SELECT count(*) FROM c` was still running at 25 s and 115 MB RSS through
    // the CLI, and `SELECT length(randomblob(64*1024*1024))` returns
    // 67,108,864 — allocated. Every one of those is a plain `SELECT`, so no gate
    // here can see it; a real timeout needs a kill-able execution context, which
    // is a design decision above this function. Stated rather than implied
    // because a reader sizing up the blast radius deserves the real one.
    //
    // Restored in `finally` because this connection is the one `writeDerived`
    // uses too: leaving it read-only would turn the next lens write into
    // "attempt to write a readonly database" somewhere with no query in sight.
    //
    // Counts nothing: the load that filled this database was counted as
    // hydration when it happened.
    return runGated(
      this.#database,
      sql,
      parameters,
      (statement) => statement.all(...parameters) as readonly Record<string, unknown>[],
    );
  }

  /** @inheritdoc */
  columns(sql: string, ...parameters: readonly SqliteValue[]): readonly string[] {
    this.#assertOpen();
    // Through the same gates as `query`, and then prepared but never stepped.
    // `StatementSync.columns()` is why the engines floor is 22.16.0, not 22.13.0:
    // Node added it in 22.16.0 (see the package header for the rejected
    // alternative).
    return runGated(this.#database, sql, parameters, (statement) => statement.columns().map((column) => column.name));
  }

  /**
   * @inheritdoc
   *
   * Each relation's table is created — and its statements prepared — by the
   * first write that names it, never before: the absence of an unwritten
   * relation is the query lane's refusal of it (see the interface).
   *
   * Counts no work counter: a lens's rows are the lens-evaluation cost, counted
   * where that mechanism lands, not hydration.
   */
  writeDerived(rows: DerivedRows): Promise<void> {
    return promised(() => {
      this.#assertOpen();
      const bundle = rows as Record<string, readonly Record<string, unknown>[] | undefined>;
      const knownBefore = new Set(this.#derivedPlans.keys());
      try {
        this.#writeDerivedRows(bundle);
      } catch (error) {
        // The rollback removed every table this write created; forget their plans
        // too, or the next write would skip the `CREATE` and fail `no such table`.
        for (const key of this.#derivedPlans.keys()) {
          if (!knownBefore.has(key)) this.#derivedPlans.delete(key);
        }
        throw error;
      }
    });
  }

  /**
   * `writeDerived`'s transaction: create, clear and fill each supplied relation.
   *
   * @param bundle - The rows, by registry key
   */
  #writeDerivedRows(bundle: Readonly<Record<string, readonly Record<string, unknown>[] | undefined>>): void {
    inTransaction(this.#database, () => {
      for (const spec of allDerivedSpecs()) {
        const supplied = bundle[spec.key];
        // Omitted is not the same as empty: an omitted relation is one this
        // evaluation has nothing to say about, and clearing — or creating — it
        // would be this method inventing a claim. An empty ARRAY does mean "no
        // rows", and creates-then-clears — which is why the two are
        // distinguished here rather than collapsed with `?? []`.
        if (supplied === undefined) continue;
        const plan = this.#derivedPlanFor(spec);
        plan.clear.run();
        for (const row of supplied) {
          plan.insert.run(...plan.columns.map(([column, { kind }]) => encodeValue(kind, row[column])));
        }
      }
    });
  }

  /**
   * One derived relation's statements — creating its table on first use.
   *
   * Called inside `writeDerived`'s transaction, so a write that fails rolls the
   * `CREATE TABLE` back with its rows. 🪤 The memo is then ahead of the schema:
   * it holds statements for a table the rollback removed. Dropped on failure for
   * that reason, so the next write creates the table again.
   *
   * @param spec - The relation
   * @returns Its plan
   */
  #derivedPlanFor(spec: DerivedTableSpec): DerivedPlan {
    const cached = this.#derivedPlans.get(spec.key);
    if (cached !== undefined) return cached;
    this.#database.exec(createDerivedTableSql(spec));
    const plan: DerivedPlan = {
      spec,
      columns: projectionColumnTypes(spec),
      insert: this.#database.prepare(insertDerivedSql(spec)),
      clear: this.#database.prepare(`DELETE FROM ${quoteIdentifier(spec.name)}`),
    };
    this.#derivedPlans.set(spec.key, plan);
    return plan;
  }

  /** @inheritdoc */
  close(): Promise<void> {
    return promised(() => {
      if (this.#closed) return;
      this.#closed = true;
      this.#database.close();
    });
  }

  /**
   * @throws Error When the run database has been closed
   */
  #assertOpen(): void {
    if (this.#closed) {
      throw new Error('This run database is closed');
    }
  }
}
