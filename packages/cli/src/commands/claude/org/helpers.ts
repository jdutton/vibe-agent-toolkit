/**
 * Shared helpers for org commands to eliminate boilerplate duplication.
 */
import type { OrgApiClient } from '@vibe-agent-toolkit/claude-marketplace';
import { createOrgApiClientFromEnv } from '@vibe-agent-toolkit/claude-marketplace';
import type { Command } from 'commander';

import type { ExternalOutcome, ExternalVerb } from '../../../report-schemas.js';
import { endWithExternalRefusal, writeExternalDocument } from '../../../utils/document-writer.js';
import type { Logger } from '../../../utils/logger.js';
import { createLogger } from '../../../utils/logger.js';

interface OrgCommandContext {
  client: OrgApiClient;
  logger: Logger;
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
 * Fetch pages until `nextCursor` says there are none, collecting every page's
 * `data` in page order. Each page's cursor comes from the page before it, so the
 * fetches are sequential by construction.
 */
async function collectPages<P extends { data: unknown[] }>(
  firstCursor: string | undefined,
  fetchPage: (cursor: string | undefined) => Promise<P>,
  nextCursor: (page: P) => string | undefined,
): Promise<{ count: number; data: Array<P['data'][number]> }> {
  const allData: Array<P['data'][number]> = [];
  const fetchFrom = async (cursor: string | undefined): Promise<void> => {
    const page = await fetchPage(cursor);
    allData.push(...page.data);
    const next = nextCursor(page);
    if (next !== undefined) await fetchFrom(next);
  };
  await fetchFrom(firstCursor);
  return { count: allData.length, data: allData };
}

/**
 * Generic autopagination: collects all pages by calling `fetchPage` with a cursor.
 * Works for admin endpoints, skills endpoints, and custom URL patterns.
 */
function collectAllPages(
  fetchPage: (cursor: string | undefined) => Promise<PageResult>,
): Promise<{ count: number; data: unknown[] }> {
  return collectPages(undefined, fetchPage, (page) =>
    page.has_more && page.next_page ? page.next_page : undefined);
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
export function autopaginateReport(
  client: OrgApiClient,
  path: string,
  baseParams: QueryParams,
): Promise<{ count: number; data: unknown[] }> {
  const fetchPage = (startingAt: string | undefined): Promise<ReportPageResult> => {
    const params: QueryParams = { ...baseParams };
    if (startingAt) params['starting_at'] = startingAt;
    return client.get<ReportPageResult>(path, params);
  };
  return collectPages(baseParams['starting_at'] as string | undefined, fetchPage, (page) => {
    if (!page.has_more) return undefined;
    // Advance starting_at to the last bucket's ending_at for next page
    return page.data.at(-1)?.ending_at;
  });
}

/**
 * Autopaginate a Skills API endpoint (regular API key + beta header).
 */
export function autopaginateSkills(
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
export function autopaginateCustom(
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

/** What a write that did not fully land did — the outcomes the adapter ends on `ERROR`. */
export type OrgFailureOutcome = Exclude<ExternalOutcome, { kind: 'ok' }>;

/**
 * An org command's document, tagged as one that must NOT end in a success exit.
 *
 * A batch command's failures are part of its PAYLOAD, not an exception: the
 * document has to be published (which skills landed, which did not, and why),
 * and the run still has to end non-zero. Throwing would end non-zero but
 * discard the payload; returning plainly publishes it but claims success. This
 * wrapper is the third option: the payload is published verbatim and
 * `outcome` — `partial` (some writes landed) or `failed` (none did) — is what
 * the external entry's adapter maps to the exit code (both `ERROR`: the
 * workspace is not in the state the operator asked for). It keeps the "did
 * this fail?" decision in one place instead of letting each command invent a
 * status field.
 *
 * 🔑 It exists because a batch command has an ending the old code could not
 * express. `skills install --from-npm` catches each per-skill upload failure and
 * returns normally, so a run in which all three skills were rejected wrote
 * `status: success` beside `skillsFailed: 3` and exited 0 — and a CI wrapper
 * spelled `vat claude org skills install --from-npm … || fail` published nothing
 * and reported green.
 */
export interface OrgCommandFailure {
  readonly orgCommandFailed: true;
  readonly document: object;
  readonly outcome: OrgFailureOutcome;
}

/** Tag `document` as the payload of a write that did not fully land. */
export function orgCommandFailure(document: object, outcome: OrgFailureOutcome): OrgCommandFailure {
  return { orgCommandFailed: true, document, outcome };
}

function isOrgCommandFailure(result: object): result is OrgCommandFailure {
  return (result as Partial<OrgCommandFailure>).orgCommandFailed === true;
}

/** What an org command publishes, and the outcome its adapter ends on. */
export interface OrgCommandEnding {
  readonly document: object;
  readonly outcome: ExternalOutcome;
}

/**
 * Pure: the payload an org command's result publishes, and the outcome.
 *
 * Split out of {@link executeOrgCommand} because it is the whole of the
 * outcome decision and the only part of it that is testable without spawning
 * a process — `executeOrgCommand` itself ends in `process.exit`. The payload is
 * the action's own document, unwrapped: an external verb adds no status word
 * and no duration to it — the exit code, derived from the outcome by the
 * registered adapter, is the verdict.
 */
export function buildOrgCommandEnding(result: object): OrgCommandEnding {
  return isOrgCommandFailure(result)
    ? { document: result.document, outcome: result.outcome }
    : { document: result, outcome: { kind: 'ok' } };
}

/**
 * Execute an org command: set up the client and logger, run the action, and
 * end through the document writer.
 *
 * An action may return its payload plainly (`ok` → exit 0) or wrapped in
 * {@link orgCommandFailure} (the payload is still published; `partial` or
 * `failed` → exit 2). Anything thrown ends on
 * `endWithExternalRefusal`: `{ error: { code, message } }` at exit 2, the code
 * decided by the thrown value (`USAGE_INVALID` for a missing key or a bad
 * argument, `EXTERNAL_API_FAILED` for a refused or unanswered API call).
 *
 * 🔑 Usage guards belong INSIDE the action, not in the Commander action that
 * calls this. `bin.ts` runs the synchronous `program.parse()`, so a throw from
 * an async action handler is a floating rejection that reaches no catch: Node
 * prints a raw stack trace carrying absolute `$HOME` paths, writes nothing to
 * stdout, and exits 1 — which this CLI's contract reads as "at least one
 * error-severity finding" for a run in which nothing executed.
 *
 * @param verb - The registered external verb, as typed after `vat`
 * @param debug - `--debug`
 * @param action - The command's work
 */
export async function executeOrgCommand(
  verb: ExternalVerb,
  debug: boolean | undefined,
  action: (ctx: OrgCommandContext) => Promise<object>,
): Promise<void> {
  const logger = createLogger(debug ? { debug: true } : {});
  try {
    const client = createOrgApiClientFromEnv();
    const ending = buildOrgCommandEnding(await action({ client, logger }));
    writeExternalDocument(verb, ending.document, 'yaml', ending.outcome);
  } catch (error) {
    endWithExternalRefusal(verb, error, 'yaml');
  }
}
