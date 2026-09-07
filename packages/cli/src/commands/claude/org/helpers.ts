/**
 * Shared helpers for org commands to eliminate boilerplate duplication.
 */
import type { OrgApiClient } from '@vibe-agent-toolkit/claude-marketplace';
import { createOrgApiClientFromEnv } from '@vibe-agent-toolkit/claude-marketplace';
import type { Command } from 'commander';

import { handleCommandError } from '../../../utils/command-error.js';
import type { Logger } from '../../../utils/logger.js';
import { createLogger } from '../../../utils/logger.js';
import { writeYamlOutput } from '../../../utils/output.js';

interface OrgCommandContext {
  client: OrgApiClient;
  logger: Logger;
  startTime: number;
}

export type QueryParams = Record<string, string | number | undefined>;

/** Default date N days ago as ISO8601 datetime. */
export function defaultDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

/** Default date N days ago as date-only YYYY-MM-DD string. */
export function defaultDaysAgoDateOnly(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0] as string;
}

/** First of current month as ISO8601 datetime. */
export function defaultFirstOfMonth(): string {
  const d = new Date();
  d.setDate(1);
  return d.toISOString();
}

interface PaginatedListOptions {
  limit?: string;
  afterId?: string;
  debug?: boolean;
}

/**
 * Build pagination params from standard list options.
 */
export function buildPaginationParams(
  options: PaginatedListOptions,
  extra?: QueryParams,
): QueryParams {
  return {
    limit: options.limit,
    after_id: options.afterId,
    ...extra,
  };
}

interface PageResult {
  data: unknown[];
  has_more: boolean;
  next_page: string | null;
}

/**
 * Generic autopagination: collects all pages by calling `fetchPage` with a cursor.
 * Works for admin endpoints, skills endpoints, and custom URL patterns.
 */
async function collectAllPages(
  fetchPage: (cursor: string | undefined) => Promise<PageResult>,
): Promise<{ count: number; data: unknown[] }> {
  const allData: unknown[] = [];
  let nextPage: string | undefined;

  do {
    const resp = await fetchPage(nextPage);
    allData.push(...resp.data);
    nextPage = resp.has_more && resp.next_page ? resp.next_page : undefined;
  } while (nextPage !== undefined);

  return { count: allData.length, data: allData };
}

interface ReportBucket {
  starting_at: string;
  ending_at: string;
  [key: string]: unknown;
}

interface ReportPageResult {
  data: ReportBucket[];
  has_more: boolean;
  next_page: string | null;
}

/**
 * Autopaginate a report-style Admin API endpoint (usage, cost, code-analytics).
 *
 * Report endpoints do NOT accept `next_page` as a query parameter — the API rejects it.
 * Pagination works by advancing `starting_at` to the last bucket's `ending_at`.
 */
export async function autopaginateReport(
  client: OrgApiClient,
  path: string,
  baseParams: QueryParams,
): Promise<{ count: number; data: unknown[] }> {
  const allData: ReportBucket[] = [];
  let startingAt = baseParams['starting_at'] as string | undefined;

  let hasMore = true;
  while (hasMore) {
    const params: QueryParams = { ...baseParams };
    if (startingAt) params['starting_at'] = startingAt;

    const resp = await client.get<ReportPageResult>(path, params);
    allData.push(...resp.data);

    if (!resp.has_more || resp.data.length === 0) {
      hasMore = false;
    } else {
      // Advance starting_at to the last bucket's ending_at for next page
      const lastBucket = resp.data.at(-1);
      if (lastBucket) {
        startingAt = lastBucket.ending_at;
      } else {
        hasMore = false;
      }
    }
  }

  return { count: allData.length, data: allData };
}

/**
 * Autopaginate a Skills API endpoint (regular API key + beta header).
 */
export async function autopaginateSkills(
  client: OrgApiClient,
  path: string,
): Promise<{ count: number; data: unknown[] }> {
  return collectAllPages((cursor) =>
    client.getSkills<PageResult>(path, { next_page: cursor }),
  );
}

/**
 * Autopaginate with a custom URL builder (e.g. cost endpoint with URLSearchParams).
 */
export async function autopaginateCustom(
  fetchPage: (cursor: string | undefined) => Promise<PageResult>,
): Promise<{ count: number; data: unknown[] }> {
  return collectAllPages(fetchPage);
}

/**
 * Add standard pagination and debug options to a list command.
 * Reduces duplication of --limit, --after-id, --debug across list subcommands.
 */
export function addPaginationOptions(cmd: Command): Command {
  return cmd
    .option('--limit <n>', 'Page size (1-100)', '20')
    .option('--after-id <id>', 'Cursor for pagination')
    .option('--debug', 'Enable debug logging');
}

/**
 * The exit code for a run that COMPLETED and reported failures.
 *
 * Read against the contract every command's `--help` publishes — `0` no
 * error-severity findings, `1` at least one, `2` a system error — this is `1`:
 * the command ran, produced its document, and that document reports something
 * that went wrong. `2` stays for the run that could not happen at all (no
 * credential, no such source), which is what {@link handleCommandError} ends on.
 *
 * 🔑 It exists because a batch command has an ending the old code could not
 * express. `skills install --from-npm` catches each per-skill upload failure and
 * returns normally, so a run in which all three skills were rejected wrote
 * `status: success` beside `skillsFailed: 3` and exited 0 — and a CI wrapper
 * spelled `vat claude org skills install --from-npm … || fail` published nothing
 * and reported green.
 */
export const ORG_RUN_FAILED_EXIT_CODE = 1;

/**
 * An org command's document, tagged as one that must NOT end in a success exit.
 *
 * A batch command's failures are part of its REPORT, not an exception: the
 * document has to be published (which skills landed, which did not, and why),
 * and the run still has to end non-zero. Throwing would end non-zero but discard
 * the report; returning plainly publishes the report but claims success. This
 * wrapper is the third option, and it keeps the "did this fail?" decision in one
 * place instead of letting each command invent a status field.
 */
export interface OrgCommandFailure {
  readonly orgCommandFailed: true;
  readonly document: object;
}

/** Tag `document` as the report of a run that failed. */
export function orgCommandFailure(document: object): OrgCommandFailure {
  return { orgCommandFailed: true, document };
}

function isOrgCommandFailure(result: object): result is OrgCommandFailure {
  return (result as Partial<OrgCommandFailure>).orgCommandFailed === true;
}

/** What an org command writes to stdout, and the code it ends on. */
export interface OrgCommandEnding {
  readonly document: Record<string, unknown>;
  readonly exitCode: number;
}

/**
 * Pure: the document and exit code an org command's result ends on.
 *
 * Split out of {@link executeOrgCommand} because it is the whole of the
 * status/exit-code decision and the only part of it that is testable without
 * spawning a process — `executeOrgCommand` itself ends in `process.exit`.
 */
export function buildOrgCommandEnding(result: object, durationMs: number): OrgCommandEnding {
  const failed = isOrgCommandFailure(result);
  const payload = (failed ? result.document : result) as Record<string, unknown>;
  return {
    document: {
      status: failed ? 'error' : 'success',
      ...payload,
      duration: `${String(durationMs)}ms`,
    },
    exitCode: failed ? ORG_RUN_FAILED_EXIT_CODE : 0,
  };
}

/**
 * Execute an org command with standard error handling.
 * Sets up client, logger, timer, and catches errors uniformly.
 *
 * An action may return its document plainly (success, exit 0) or wrapped in
 * {@link orgCommandFailure} (the document is still published, the run exits
 * {@link ORG_RUN_FAILED_EXIT_CODE}). Anything thrown is the system error and
 * ends on {@link handleCommandError}'s exit 2.
 *
 * 🔑 Usage guards belong INSIDE the action, not in the Commander action that
 * calls this. `bin.ts` runs the synchronous `program.parse()`, so a throw from
 * an async action handler is a floating rejection that reaches no catch: Node
 * prints a raw stack trace carrying absolute `$HOME` paths, writes nothing to
 * stdout, and exits 1 — which this CLI's contract reads as "at least one
 * error-severity finding" for a run in which nothing executed.
 */
export async function executeOrgCommand(
  commandName: string,
  debug: boolean | undefined,
  action: (ctx: OrgCommandContext) => Promise<object>,
): Promise<void> {
  const logger = createLogger(debug ? { debug: true } : {});
  const startTime = Date.now();
  try {
    const client = createOrgApiClientFromEnv();
    const ctx: OrgCommandContext = { client, logger, startTime };
    const ending = buildOrgCommandEnding(await action(ctx), Date.now() - startTime);
    writeYamlOutput(ending.document);
    process.exit(ending.exitCode);
  } catch (error) {
    handleCommandError(error, logger, startTime, commandName);
  }
}
