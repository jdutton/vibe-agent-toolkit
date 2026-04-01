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
 * Execute an org command with standard error handling.
 * Sets up client, logger, timer, and catches errors uniformly.
 */
export async function executeOrgCommand<T extends object>(
  commandName: string,
  debug: boolean | undefined,
  action: (ctx: OrgCommandContext) => Promise<T>,
): Promise<void> {
  const logger = createLogger(debug ? { debug: true } : {});
  const startTime = Date.now();
  try {
    const client = createOrgApiClientFromEnv();
    const ctx: OrgCommandContext = { client, logger, startTime };
    const result = await action(ctx);
    writeYamlOutput({
      status: 'success',
      ...(result as Record<string, unknown>),
      duration: `${String(Date.now() - startTime)}ms`,
    });
    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, commandName);
  }
}
