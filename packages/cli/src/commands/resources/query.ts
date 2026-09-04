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
 * ## 🔑 One tree, one answer — and that is now a property, not a promise
 *
 * The SQL always runs against a per-run in-memory database holding this tree's
 * projection and nothing else. A selected projection store makes the POPULATION
 * cheap and is never queried, because it is one database per VAT release shared
 * by every root on the machine — querying it answered from other repositories,
 * with a two-file corpus reporting 5,779 rows instead of 3.
 * `utils/projection-query.ts`'s header carries the measurement and the reasoning.
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
 * `populationSecs` sits beside it and says what that origin was worth — the wall
 * time of the setup both this verb and `vat resources check` pay before either
 * runs a statement. Measured as that field on this repository with the parse
 * cache warm: 1.16-1.18 s derived against 0.29-0.31 s served. Without it the
 * tell is a label a reader has to trust; with it the saving is a number they can
 * check, and a per-statement cost published elsewhere has something to be read
 * against. `utils/projection-query.ts` states exactly which work the span covers
 * and why its start line is load-bearing.
 *
 * ## What this verb does NOT do
 *
 * It does not decode. Rows come back exactly as SQLite holds them — a boolean as
 * `0`/`1`, a date and a JSON column as text — because decoding needs a table
 * spec and arbitrary SQL has none. `SqlQueryableStore.query`'s docstring is the
 * authority on why.
 */

import { handleCommandError } from '../../utils/command-error.js';
import { formatDurationSecs } from '../../utils/duration.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { writeJsonOutput, writeYamlOutput } from '../../utils/output.js';
import { projectRootOrLoudCwd } from '../../utils/project-root-policy.js';
import {
  withQueriedProjection,
  type ProjectionProvenance,
} from '../../utils/projection-query.js';

interface QueryOptions {
  debug?: boolean;
  /** Bound in order, for every `?` in the statement. */
  param?: string[];
  /** `yaml` (default) or `json`. Same document either way. */
  format?: string;
}

/** What one query run produced, and what produced it. */
interface QueryOutcome extends ProjectionProvenance {
  rows: readonly Record<string, unknown>[];
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
    // The cache tell — see the header.
    population: input.population,
    // Immediately after the origin, because the two are one statement: served
    // or derived, and what that was worth. Separated they read as two unrelated
    // numbers in a list.
    populationSecs: formatDurationSecs(input.populationMs),
    rowCount: input.rows.length,
    durationSecs: formatDurationSecs(input.durationMs),
    rows: input.rows,
  };
}

/**
 * Populate the tree and run the caller's one statement against it.
 *
 * Thin by design: everything that is not "one statement, all its rows" —
 * population, store selection, the ephemeral fallback, the cache tell and the
 * legible-failure wrapper — is shared with `vat resources check` in
 * {@link withQueriedProjection}, so the two verbs cannot drift into answering
 * about different corpora.
 *
 * @param options - The run
 * @param options.root - Absolute corpus root
 * @param options.sql - The single read-only statement
 * @param options.parameters - Bound in order, for every `?`
 * @param options.logger - Where blob-stage refusals are reported
 * @returns The rows and the provenance of the population behind them
 */
async function runProjectionQuery(options: {
  root: string;
  sql: string;
  parameters: readonly string[];
  logger: Logger;
}): Promise<QueryOutcome> {
  const { root, sql, parameters, logger } = options;
  // The statement is compiled against the empty schema first, so a typo'd
  // column costs milliseconds instead of a full population.
  return withQueriedProjection({ root, logger, preflight: [sql] }, (ask, provenance) => ({
    rows: ask(sql, ...parameters),
    ...provenance,
  }));
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
    handleCommandError(error, logger, startTime, 'Query', options.format);
  }
}
