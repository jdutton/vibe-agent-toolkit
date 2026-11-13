/**
 * `vat resources query --budget <seconds>`: the statement runs in a child process under
 * `vat resources check`'s supervisor, and a run that goes that long without progress is killed and
 * refused as `RUN_INCOMPLETE`, exit 2.
 *
 * ## 🔑 Loaded only under a positive `--budget`
 *
 * `queryCommand` imports this module dynamically, and only when it is about to supervise. A query
 * without `--budget` starts no second process and loads nothing here — the opt-in costs nothing to
 * the run that does not opt in.
 *
 * ## The child is the CLI itself
 *
 * The child is `vat resources query` with the hidden `--supervised-by` flag, running the ordinary
 * in-process path, as `check`'s child is: one implementation of the verb, never a second one that
 * only the supervised lane runs. The child writes `started`, the population line, and
 * `statements-complete` once its one statement returns, so a kill names where it landed.
 *
 * ## What the parent says, and what the child says
 *
 * The child prints every notice (this process loads no config) and leaves its findings and its
 * error line to this process, which prints them once — so the operator reads the same stderr as an
 * in-process run. A completed child's document is forwarded byte for byte, after the supervisor
 * has checked it is a query document and that the child's exit agrees with it.
 *
 * ## Not claimed
 *
 * - A healthy statement slower than the budget is killed: the bound is time without progress, and
 *   one statement is one unit.
 * - This process holds the whole forwarded document in memory: a result the in-process run could
 *   write can exhaust this process's heap here first.
 * - The statement and every `--param` travel on the child's command line, which every platform
 *   bounds; a statement too long for it is `spawn-failed`, whose remedy names `--budget 0`.
 */

import { toFindings } from '@vibe-agent-toolkit/schema';

import { CommandRefusalError } from '../../utils/command-refusal.js';
import { endWithRefusal, leftoverIssueOf, NOTHING_FINISHED, type FinishedWork } from '../../utils/document-writer.js';
import type { Logger } from '../../utils/logger.js';

import { parseProgressLog, unitInFlight } from './check-progress.js';
import {
  interruptionMessage,
  publishSupervisedEnding,
  SUPERVISED_BY_FLAG,
  superviseRun,
  supervisedByValue,
  withLeftover,
  withProgressLog,
  type SupervisedEnding,
  type SupervisedRun,
  type SupervisedVerb,
} from './check-supervisor.js';
import type { ResourcesQueryReport } from './query-schema.js';

/** The verb this module runs, as the supervisor keys it. */
const QUERY_VERB = 'resources query' satisfies SupervisedVerb;

/** What the operator asked the supervised query to run. */
export interface QueryRequest {
  readonly sql: string;
  readonly parameters: readonly string[];
  /** The project root this process resolved, which the child queries. */
  readonly root: string;
  readonly base: string | undefined;
  readonly debug: boolean;
  readonly format: 'yaml' | 'json';
  /** The bound, in seconds; positive. */
  readonly budgetSecs: number;
}

/**
 * The child's argv after the CLI entry point.
 *
 * 🔑 Every value travels as `--name=value`, and the operands come LAST, after `--`. A statement
 * that opens with a `--` comment, or a parameter that begins with `-`, would otherwise read as an
 * option. (`--supervised-by` keeps two tokens: its value always begins with the invoker's name.)
 *
 * @param request - What to run
 * @param logPath - The progress log both processes watch
 * @returns The arguments
 */
export function queryChildArgs(request: QueryRequest, logPath: string): string[] {
  return [
    'resources',
    'query',
    `--format=${request.format}`,
    ...(request.debug ? ['--debug'] : []),
    ...(request.base === undefined ? [] : [`--base=${request.base}`]),
    ...request.parameters.map((value) => `--param=${value}`),
    SUPERVISED_BY_FLAG,
    // Always `standalone` for a query: only `vat resources check` runs as `vat validate`'s phase.
    supervisedByValue({ invoker: 'standalone', progressLog: logPath }),
    '--',
    request.sql,
    request.root,
  ];
}

/**
 * The refusal for a supervised query that ended without its own document: killed by the watchdog,
 * or dead of something else. Always `RUN_INCOMPLETE` — a query that did not finish has no answer,
 * wherever it stopped.
 *
 * @param run - How the child ended, and what its progress log held
 * @param budgetSecs - The bound that was in force
 * @returns The refusal to publish
 */
export function interruptedQueryRefusal(
  run: Exclude<SupervisedRun, { outcome: 'completed' }>,
  budgetSecs: number,
): CommandRefusalError {
  const inFlight = unitInFlight(parseProgressLog(run.log));
  const message = interruptionMessage(inFlight, run.outcome === 'killed'
    ? { kind: 'budget', budgetSecs, invocation: 'query' }
    : { kind: 'abnormal', death: run.death, invocation: 'query' });
  return new CommandRefusalError('RUN_INCOMPLETE', message);
}

/**
 * Supervise the query, publish what it came to, and end on that document's code.
 *
 * @param request - What to run, and `logger`: where the forwarded document's findings are said
 * @returns Never: the process ends on the published document's code
 */
export async function superviseQuery(request: QueryRequest & { logger: Logger }): Promise<never> {
  const { value: ending, leftover } = await withProgressLog(
    QUERY_VERB,
    async (log): Promise<SupervisedEnding<ResourcesQueryReport> | { refusal: CommandRefusalError }> => {
      const run = await superviseRun({
        verb: QUERY_VERB,
        args: queryChildArgs(request, log.path),
        log,
        budgetMs: request.budgetSecs * 1000,
        format: request.format,
      });
      return run.outcome === 'completed'
        ? { forward: run.document }
        : { refusal: interruptedQueryRefusal(run, request.budgetSecs) };
    },
  );

  if ('refusal' in ending) {
    // A directory the OS would not remove is a warning beside the refusal, as on every lane.
    const finished: FinishedWork = leftover === undefined
      ? NOTHING_FINISHED
      : { examined: 0, findings: toFindings([leftoverIssueOf(leftover)]), data: null };
    return endWithRefusal(QUERY_VERB, 'RUN_INCOMPLETE', ending.refusal, request.format, { strict: false }, finished);
  }
  // The human half, once, by this process: the child left its error line and findings to it.
  return publishSupervisedEnding(QUERY_VERB, {
    ending: withLeftover(ending, leftover),
    format: request.format,
    speaks: true,
    verbose: false,
    write: request.logger.error,
  });
}
