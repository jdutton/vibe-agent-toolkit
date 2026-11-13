/**
 * `vat resources query` — ask the resource projection a read-only SQL question.
 *
 * ## Why a query verb at all, when `scan` already reports counts
 *
 * `vat resources scan` answers the questions its payload was written for, and
 * nothing else. The projection holds a table per fact kind — realizations, references,
 * sections, conditions, provenance, rule patterns — and every question nobody
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
 * failure. The signal is real rather than declarative: it is the outcome
 * `populate()` returns, which says whether the store served the run.
 * `lensPopulation` is the same tell for a lens that populates a lane of its own.
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
 * ## 🔑 Supervision is opt-in, and without it nothing changes
 *
 * `--budget <seconds>` runs the statement under `vat resources check`'s supervisor: a child
 * process the parent kills when it goes that long without progress, refused as `RUN_INCOMPLETE`.
 * Without it — or with `--budget 0` — this process runs the statement, exactly as it always has:
 * no second process, and `query-supervision.ts` is never loaded. The operator is at the keyboard
 * and Ctrl-C works (`checkCommand`'s header says why), so the bound is theirs to ask for.
 *
 * ## What this verb does NOT do
 *
 * It does not decode. Rows come back exactly as SQLite holds them — a boolean as
 * `0`/`1`, a date and a JSON column as text — because decoding needs a table
 * spec and arbitrary SQL has none. `RunDatabase.query`'s docstring is the
 * authority on why.
 */

import { buildReport } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';

import { refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, leaveFindingsToSupervisor, NOTHING_FINISHED } from '../../utils/document-writer.js';
import { formatDurationSecs } from '../../utils/duration.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { assertDirectoryArgument, projectRootOrLoudCwd, projectRootOrNull } from '../../utils/project-root-policy.js';
import {
  withQueriedProjection,
  type ProjectionProvenance,
} from '../../utils/projection-query.js';
import { relationBoundsFor } from '../../utils/relation-limits.js';

// Both already loaded by every `vat resources` run: `check` imports them. The supervision this
// verb adds lives in `query-supervision.ts`, imported only under a positive `--budget`.
import {
  createProgressWriter,
  endWhenSupervisorGone,
  letSupervisorLossSurface,
  populationEntry,
  type ProgressEntry,
} from './check-progress.js';
import {
  parseBudgetSeconds,
  requireSupervisableFlags,
  runsInThisProcess,
  type SupervisedChild,
  type SupervisedVerb,
} from './check-supervisor.js';
import type { ResourcesQueryReport } from './query-schema.js';

/** The verb this module runs, as the supervisor keys it. */
const QUERY_VERB = 'resources query' satisfies SupervisedVerb;

interface QueryOptions {
  debug?: boolean;
  /** Bound in order, for every `?` in the statement. */
  param?: string[];
  /** `yaml` (default) or `json`. Same document either way. */
  format?: string;
  /** `--base <ref>`: what `changed_files` compares this tree with. */
  base?: string;
  /** `--budget <seconds>`: run under the supervisor; absent or `0` runs here. */
  budget?: string;
  /** The hidden flag a supervisor hands the child it spawned. */
  supervisedBy?: string;
}

/** What one query run produced, and what produced it. */
interface QueryOutcome extends ProjectionProvenance {
  /** The statement's result columns, in order — known even when it selected no row. */
  columns: readonly string[];
  rows: readonly Record<string, unknown>[];
  /** Resources the population enumerated: what the statement was asked OVER. */
  membersEnumerated: number;
}

export interface ProjectionQueryPayloadInput extends QueryOutcome {
  /** The stated root the query was asked about. */
  root: string;
  durationMs: number;
}

/**
 * Build the query report.
 *
 * Pure: no file system, no clock, no `process.exit` — the same contract
 * `buildScanReport` follows, and for the same reason: it keeps the document's
 * shape, field names included, under unit test rather than only under a CLI
 * spawn.
 *
 * 🔑 `examined` is the POPULATION the statement ran over, never the rows it
 * selected. Zero rows over a populated tree is an answer (`ok`); a statement
 * over a population of nothing answers nothing, and the writer refuses it.
 *
 * @param input - The rows and the provenance of the run that produced them
 * @returns The report to publish
 */
export function buildProjectionQueryReport(input: ProjectionQueryPayloadInput): ResourcesQueryReport {
  return buildReport({
    examined: input.membersEnumerated,
    findings: [],
    // `vat resources query` offers no `--strict`, and reports no finding of its own.
    gate: { strict: false },
    durationMs: input.durationMs,
    data: {
      // Stated once, and the only absolute path in the document.
      root: input.root,
      columns: [...input.columns],
      rows: [...input.rows],
      // The cache tell — see the header.
      population: input.population,
      // Immediately after the origin, because the two are one statement: served
      // or derived, and what that was worth.
      populationSecs: formatDurationSecs(input.populationMs),
      // Beside the population it is NOT part of. A store hit does not make a lens
      // evaluation cheaper, so folding it into `populationSecs` would read as the
      // store having got worse. See `ProjectionProvenance.lensMs`.
      lensSecs: formatDurationSecs(input.lensMs),
      // 🔑 What that number covers. A lens is evaluated only when THIS statement
      // names one of its relations, so an empty list beside `lensSecs: 0` is the
      // statement saying it asked for none — not a lens that silently stopped
      // running. See `ProjectionProvenance.lensesEvaluated`.
      lensesEvaluated: [...input.lensesEvaluated],
      // The cache tell for those lenses' own populations — see the header.
      lensPopulation: input.lensPopulation,
      // The bounds of the rows, stated ONCE and only when a bounded lens ran —
      // `relation-limits.ts` carries why the SQL route owes them at all.
      ...relationBoundsFor(input.lensesEvaluated),
    },
  });
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
 * @param options.base - The ref `changed_files` compares with, or undefined when none was given
 * @param options.onProgress - The supervised child's progress writer, or undefined when nothing is
 *   watching (every run without `--budget`)
 * @returns The rows and the provenance of the population behind them
 */
function runProjectionQuery(options: {
  root: string;
  sql: string;
  parameters: readonly string[];
  logger: Logger;
  base: string | undefined;
  onProgress: ((entry: ProgressEntry) => void) | undefined;
}): Promise<QueryOutcome> {
  const { root, sql, parameters, logger, base, onProgress } = options;
  // The statement is compiled against the empty schema first, so a typo'd
  // column — or a `?` with no `--param` behind it — costs milliseconds instead
  // of a full population.
  return withQueriedProjection(
    // `statements` as well as `preflight`, and the two are not redundant: the
    // preflight COMPILES this statement early, while `statements` decides which
    // derived relations get evaluated at all. One statement, two questions asked
    // of it.
    { root, logger, preflight: [{ sql, parameters }], statements: [sql], base },
    (ask, provenance, extent, _projection, columnsOf) => {
      // A supervised child's units: the population, then the statement (the log reads it as
      // `idle`), then the answer being written. Unsupervised, the optional calls are no-ops.
      onProgress?.(populationEntry(provenance, extent));
      const columns = columnsOf(sql, ...parameters);
      const rows = ask(sql, ...parameters);
      onProgress?.({ kind: 'statements-complete' });
      return { columns, rows, membersEnumerated: extent.membersEnumerated, ...provenance };
    },
  );
}

/**
 * Read `--budget` and the hidden `--supervised-by`: the bound, and the supervised child this
 * process is, if it is one.
 *
 * 🔑 **No default bound.** `check` defaults to 300 s; a query has none unless its operator asks,
 * and `--budget 0` equals omitting the flag. A value is refused exactly as `check` refuses it —
 * blank, a number that means zero without saying so, negative, not a number — and `--budget`
 * beside `--supervised-by`, or a `--supervised-by` this process's parent did not hand it, is
 * refused too: the same functions decide both verbs.
 *
 * @param options - Parsed command-line options
 * @param options.budget - What the operator typed for `--budget`, or undefined
 * @param options.supervisedBy - The hidden `--supervised-by` value, or undefined
 * @returns The bound in seconds (0: none) and the supervised child, or undefined when not one
 * @throws `USAGE_INVALID` for a value either flag refuses
 */
export function querySupervisionOf(options: {
  budget?: string | undefined;
  supervisedBy?: string | undefined;
}): { budgetSecs: number; child: SupervisedChild | undefined } {
  const budgetSecs = options.budget === undefined ? 0 : parseBudgetSeconds(options.budget);
  const child = requireSupervisableFlags({ supervisedBy: options.supervisedBy, budgetRaw: options.budget, budgetSecs });
  return { budgetSecs, child };
}

/**
 * Set up THIS process as a supervised query child: its findings and error line are the
 * supervisor's to print, it ends itself when the supervisor is gone, and it says it has booted.
 *
 * @param child - The supervised child this process is
 * @returns The progress writer the run's units are announced through
 */
function superviseHere(child: SupervisedChild): (entry: ProgressEntry) => void {
  leaveFindingsToSupervisor();
  endWhenSupervisorGone(QUERY_VERB, child.supervisorPid, process.stdin);
  const progress = createProgressWriter(child);
  progress({ kind: 'started' });
  return progress;
}

/**
 * Run one read-only SQL statement against this tree's resource projection.
 *
 * ## 🔑 `[path]` LOCATES the project. It never narrows the corpus.
 *
 * `vat resources scan docs/` scopes its crawl to `docs/`; this verb cannot offer
 * the same, and says so rather than pretending. The projection is the whole
 * tracked tree by construction — one population per `(root, treeHash)`, and a
 * subtree population would be filed in the shared store under the whole tree's
 * key, which is the cross-tree class `utils/projection-query.ts` documents —
 * and arbitrary SQL cannot be post-filtered by path (blobs carry none). So the
 * argument is where root discovery STARTS, the answer is about the tree it
 * finds, and `root` in the document names that tree. A `WHERE path LIKE …` is
 * the only scope a statement has, exactly as `vat resources check` documents.
 *
 * 🚨 Which is why a locator that locates nothing has to be refused: `nope`
 * walked up to the cwd's project and answered about the whole tree at exit 0,
 * byte-identical to a correct run. `assertDirectoryArgument` is the same refusal
 * `validate` gives, in the same words.
 *
 * @param sql - The statement
 * @param pathArg - Where to look for the project, or omitted for the current directory
 * @param options - Parsed command-line options
 */
export async function queryCommand(
  sql: string,
  pathArg: string | undefined,
  options: QueryOptions,
): Promise<void> {
  const logger = createLogger({ debug: options.debug ?? false });
  const startTime = Date.now();
  // The two formats this verb offers (Commander refuses any other).
  const format = options.format === 'json' ? 'json' : 'yaml';

  try {
    if (pathArg !== undefined) assertDirectoryArgument(pathArg);
    const { budgetSecs, child } = querySupervisionOf(options);
    if (!runsInThisProcess({ supervisedBy: options.supervisedBy, budgetSecs })) {
      // Loud, as the in-process run resolves it; the child is handed this root and is silent.
      const root = projectRootOrLoudCwd(pathArg ?? process.cwd(), logger);
      const { superviseQuery } = await import('./query-supervision.js');
      return await superviseQuery({
        sql,
        root,
        parameters: options.param ?? [],
        base: options.base,
        debug: options.debug === true,
        format,
        budgetSecs,
        logger,
      });
    }
    const onProgress = child === undefined ? undefined : superviseHere(child);
    // Resolved at the CLI boundary, like every other command — the loud-cwd
    // policy is where root discovery belongs. A supervised child was handed the
    // root its supervisor already resolved (and announced), so it says nothing.
    const projectRoot = child === undefined
      ? projectRootOrLoudCwd(pathArg ?? process.cwd(), logger)
      : projectRootOrNull(pathArg ?? process.cwd()) ?? safePath.resolve(pathArg ?? process.cwd());

    const outcome = await runProjectionQuery({
      root: projectRoot,
      sql,
      parameters: options.param ?? [],
      logger,
      base: options.base,
      onProgress,
    });
    // The statement ran synchronously: a supervisor lost meanwhile ends this child HERE, unpublished.
    if (child !== undefined) await letSupervisorLossSurface();

    endWithReport(QUERY_VERB, buildProjectionQueryReport({
      ...outcome,
      root: projectRoot,
      durationMs: Date.now() - startTime,
    }), format);
  } catch (error) {
    // A refused statement is USAGE_INVALID by its code; see `describedFailure`.
    endWithRefusal(QUERY_VERB, refusalCodeOf(error), error, format, { strict: false }, NOTHING_FINISHED);
  }
}
