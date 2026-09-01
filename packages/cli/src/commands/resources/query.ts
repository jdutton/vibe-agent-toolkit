/**
 * `vat resources query` — ask the resource projection a read-only SQL question.
 *
 * ## Why a query verb at all, when `scan` already reports counts
 *
 * `vat resources scan` answers the questions its payload was written for, and
 * nothing else. The projection holds twelve tables — realizations, references,
 * sections, conditions, provenance — and every question about them that nobody
 * anticipated currently has no answer short of writing a new command. This verb
 * is the general case: one statement, the rows it selects, no new field.
 *
 * ## 🔑 The answer does not depend on whether a cache happened to exist
 *
 * With a projection store selected, the population is read from (or written to)
 * it and the SQL runs against that database. With none, the same projection is
 * loaded into an **in-memory** store and the identical SQL runs against the
 * identical schema. One dialect, one schema, one answer — the on-disk store is
 * purely the speed-up.
 *
 * That is not a convenience. A query surface that only worked where a cache was
 * present would make the answer a property of the machine rather than of the
 * tree, and would let two callers hold differently-shaped views of one corpus.
 * See {@link withQueryStore}.
 *
 * ## 🔑 The document says where its rows came from, and that is the cache tell
 *
 * `population` reports whether the projection was **derived** this run or read
 * from the **store**. It has to be reported, because it cannot be inferred: a
 * correct hit and a correct re-derivation produce byte-identical rows, so "did
 * the cache work" is otherwise unfalsifiable — this repository's most repeated
 * failure. The signal is real rather than declarative: a store hit
 * short-circuits `populate()` before the builder exists, so no contributor runs
 * and no timing record is filed. An empty record list IS the hit.
 *
 * `engine` is the second, independent fact: which database answered the SQL.
 * The two come apart — an ephemeral engine is always `derived`, but a `sqlite`
 * engine can be either.
 *
 * ## What this verb does NOT do
 *
 * It does not decode. Rows come back exactly as SQLite holds them — a boolean as
 * `0`/`1`, a date and a JSON column as text — because decoding needs a table
 * spec and arbitrary SQL has none. `SqlQueryableStore.query`'s docstring is the
 * authority on why.
 */

import {
  buildResourceProjection,
  PROJECTION_TABLES,
  splitProjectionByScope,
} from '@vibe-agent-toolkit/resources';

import { handleCommandError } from '../../utils/command-error.js';
import { formatDurationSecs } from '../../utils/duration.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { writeJsonOutput, writeYamlOutput } from '../../utils/output.js';
import { populationWiring } from '../../utils/population-wiring.js';
import { projectRootOrLoudCwd } from '../../utils/project-root-policy.js';
import { withQueryStore } from '../../utils/projection-store.js';
import { gitTrackerForProjectRoot } from '../audit/distributed-tree.js';

/**
 * The tree hash an in-memory store's one population is filed under.
 *
 * ⚠️ Deliberately NOT a tree hash. Nothing else ever opens this database, no
 * read-back compares the key against another run's, and the store is gone at
 * the end of the call — so the key only has to be internally consistent. A real
 * `git write-tree` here would cost a spawn to produce a value nobody reads, and
 * would invite the reader to believe the ephemeral store is shareable.
 */
const EPHEMERAL_TREE_HASH = 'ephemeral';

/**
 * What SQLite says when a statement names something the schema does not have.
 *
 * The two failures a column listing actually answers. Matched as substrings of
 * the engine's own message rather than by a code, because `node:sqlite` surfaces
 * these as plain `Error`s with no distinguishing property to read.
 */
const NAME_NOT_FOUND: readonly string[] = ['no such table:', 'no such column:'];

/** Where the rows the query ran against came from. */
export type PopulationOrigin = 'derived' | 'store';

/** Which database answered the SQL. */
export type QueryEngine = 'sqlite' | 'ephemeral';

interface QueryOptions {
  debug?: boolean;
  /** Bound in order, for every `?` in the statement. */
  param?: string[];
  /** `yaml` (default) or `json`. Same document either way. */
  format?: string;
}

/** What one query run produced, and what produced it. */
interface QueryOutcome {
  rows: readonly Record<string, unknown>[];
  population: PopulationOrigin;
  engine: QueryEngine;
}

export interface ProjectionQueryPayloadInput extends QueryOutcome {
  /** The stated root the query was asked about. */
  root: string;
  durationMs: number;
}

/**
 * Build the query payload.
 *
 * Pure: no file system, no clock, no `process.exit` — the same contract
 * `buildScanOutputData` follows, and for the same reason: it keeps the
 * document's shape, field names included, under unit test rather than only
 * under a CLI spawn.
 *
 * `rowCount` is stated beside `rows` rather than left for the consumer to
 * count, because the two answer different questions once a caller pipes the
 * document somewhere: a truncated read still carries the true total.
 *
 * @param input - The rows and the provenance of the run that produced them
 * @returns The document to serialize
 */
export function buildProjectionQueryOutputData(input: ProjectionQueryPayloadInput): Record<string, unknown> {
  return {
    status: 'success',
    // Stated once, and the only absolute path in the document.
    root: input.root,
    // The cache tell, and its independent companion — see the header.
    population: input.population,
    engine: input.engine,
    rowCount: input.rows.length,
    durationSecs: formatDurationSecs(input.durationMs),
    rows: input.rows,
  };
}

/**
 * Turn a rejected statement into a message that names the surface it missed.
 *
 * ## Why this wrapper exists
 *
 * VAT ships no schema version, by standing rule — the *cache* is safe across a
 * shape change because its digest self-invalidates, but a user's SQL is not: it
 * simply breaks. Pre-1.0 that is acceptable. A raw SQLite error reaching the
 * user is not, because `no such column: contentHash` says nothing about what the
 * column is called now.
 *
 * ⚠️ **A legibility wrapper, not a validator.** It does not parse SQL and does
 * not check a statement before running it — it reacts to a failure by listing
 * what the query COULD have named. When the statement mentions a known table,
 * that table's columns are listed, which is the case that actually answers "what
 * moved"; otherwise the table names are, which at least answers "what is there".
 *
 * 🪤 **Only a name that was not found gets the listing.** The engine also refuses
 * a write (`attempt to write a readonly database`) and this backend refuses a
 * second statement, and neither is answered by a column list — appending one
 * says the problem is the schema when the problem is what the caller asked for.
 * A wrapper that decorates every failure identically teaches the reader to skip
 * the decoration, which costs the case it was written for.
 *
 * Matching is a plain lowercase substring test rather than a regex: the input is
 * user text, and a pattern built from it is both a lint failure here and a
 * needless hazard.
 *
 * @param sql - The statement the user submitted
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

/**
 * Populate the tree, put the rows somewhere askable, and ask.
 *
 * @param options - The run
 * @param options.root - Absolute corpus root
 * @param options.sql - The single read-only statement to run
 * @param options.parameters - Bound in order, for every `?`
 * @param options.logger - Where blob-stage refusals are reported (stderr)
 * @returns The rows and the provenance of the population behind them
 */
async function runProjectionQuery(options: {
  root: string;
  sql: string;
  parameters: readonly string[];
  logger: Logger;
}): Promise<QueryOutcome> {
  const { root, sql, parameters, logger } = options;

  return withQueryStore({ root }, async (store, cache) => {
    // The cache tell. `populate()` short-circuits a hit before any contributor
    // is constructed, so this staying at zero is the ONLY observable difference
    // between a served population and a re-derived one.
    let contributorRecords = 0;
    const gitTracker = await gitTrackerForProjectRoot(root);
    const projection = await buildResourceProjection({
      root,
      ...populationWiring(logger, gitTracker, cache, root),
      onContributorTiming: () => {
        contributorRecords += 1;
      },
    });

    if (cache === undefined) {
      // The ephemeral path, and the ONE place the caller has to load the store
      // itself: `populate()` writes through a cache it was handed, and it was
      // handed none. Skipping this would run the SQL against an empty schema and
      // report zero rows as an answer.
      //
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
    }

    return {
      rows: runStatement(store, sql, parameters),
      population: contributorRecords === 0 ? 'store' : 'derived',
      engine: cache === undefined ? 'ephemeral' : 'sqlite',
    };
  });
}

/**
 * Run the statement, replacing an engine-level refusal with a legible one.
 *
 * Separated from its caller so the `try` wraps the query and nothing else. A
 * bracket around the whole population would also catch a crawl failure and
 * append a table listing to it, which is guidance about the wrong thing.
 *
 * @param store - The database to ask
 * @param sql - The statement
 * @param parameters - Bound in order
 * @returns The rows, in the order SQLite produced them
 */
function runStatement(
  store: { query: (sql: string, ...parameters: readonly string[]) => readonly Record<string, unknown>[] },
  sql: string,
  parameters: readonly string[],
): readonly Record<string, unknown>[] {
  try {
    return store.query(sql, ...parameters);
  } catch (error) {
    throw new Error(describeQueryFailure(sql, error instanceof Error ? error.message : String(error)));
  }
}

/**
 * Run one read-only SQL statement against this tree's resource projection.
 *
 * @param sql - The statement
 * @param pathArg - The corpus root, or omitted for the current directory
 * @param options - Parsed command-line options
 */
export async function queryCommand(
  sql: string,
  pathArg: string | undefined,
  options: QueryOptions,
): Promise<void> {
  const logger = createLogger({ debug: options.debug ?? false });
  const startTime = Date.now();

  try {
    // Resolved at the CLI boundary, like every other command — the loud-cwd
    // policy is where root discovery belongs.
    const projectRoot = projectRootOrLoudCwd(pathArg ?? process.cwd(), logger);

    const outcome = await runProjectionQuery({
      root: projectRoot,
      sql,
      parameters: options.param ?? [],
      logger,
    });

    const payload = buildProjectionQueryOutputData({
      ...outcome,
      root: projectRoot,
      durationMs: Date.now() - startTime,
    });
    if (options.format === 'json') {
      writeJsonOutput(payload);
    } else {
      writeYamlOutput(payload);
    }

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Query');
  }
}
