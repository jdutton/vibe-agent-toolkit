/**
 * RAG index command - index markdown resources into vector database
 */

import { type IndexResult, partialIndexResultOf } from '@vibe-agent-toolkit/rag';
import { LanceDBRAGProvider } from '@vibe-agent-toolkit/rag-lancedb';
import type { UnreadableResource } from '@vibe-agent-toolkit/resources';
import { buildReport, toFindings, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, NOTHING_FINISHED } from '../../utils/document-writer.js';
import { reportFindings } from '../../utils/issue-rendering.js';
import { createLogger } from '../../utils/logger.js';
import { assertReadableDirectoryArgument, projectRootOrNull } from '../../utils/project-root-policy.js';
import { requireWritableDatabase } from '../../utils/rag-database.js';
import { loadResourcesWithConfig } from '../../utils/resource-loader.js';

import { RAG_GATE, resolveDbPath } from './command-helpers.js';
import type { RagIndexReport } from './index-schema.js';

interface IndexOptions {
  db?: string;
  debug?: boolean;
}

const RAG_DOCUMENT_INDEX_FAILED = 'RAG_DOCUMENT_INDEX_FAILED';

/** One document the index does not hold, as its finding. */
function notIndexedIssue(location: string, reason: string): ValidationIssue {
  return {
    code: RAG_DOCUMENT_INDEX_FAILED,
    severity: 'error',
    message: `${location} is not in the index, so its content is not searchable: ${reason}`,
    location,
  };
}

/**
 * The provider's per-resource failures, as findings located at each resource's
 * path.
 *
 * The provider names a failure by the registry id; the operator needs the file,
 * so the id is mapped back through `locations` — and kept as the location when
 * the registry never mapped it, which only a provider inventing ids could cause.
 *
 * @param errors - `IndexResult['errors']`, absent when nothing failed
 * @param locations - Registry id → the resource's path relative to the crawl root
 * @returns One `RAG_DOCUMENT_INDEX_FAILED` issue per failure
 */
export function providerIndexIssues(
  errors: IndexResult['errors'],
  locations: ReadonlyMap<string, string>,
): ValidationIssue[] {
  return (errors ?? []).map((entry) => notIndexedIssue(locations.get(entry.resourceId) ?? entry.resourceId, entry.error));
}

/**
 * The resources the crawl enumerated but could not read, as findings.
 *
 * Such a file never reaches `indexResources`: the crawl reads and parses every
 * file itself, so an unreadable one is dropped before the provider sees it. It
 * is therefore in none of the provider's counters and not in its `errors` —
 * the registry keeps the reconciliation log (`getUnreadableResources()`), and
 * without reading it a corpus with a document missing from the index was
 * reported clean. It is the same finding as a provider failure: the document
 * is not in the index.
 *
 * @param unreadable - The registry's read-failure log
 * @param crawlRoot - The directory the crawl was rooted at
 * @returns One issue per unreadable file, in the order the crawl met them
 */
export function unreadableIndexIssues(
  unreadable: readonly UnreadableResource[],
  crawlRoot: string,
): ValidationIssue[] {
  return unreadable.map((entry) => notIndexedIssue(
    toForwardSlash(safePath.relative(crawlRoot, entry.filePath)),
    `enumerated by the crawl but could not be read: ${entry.reason}`,
  ));
}

/**
 * The provider's warnings about its own configuration (a chunk budget clamped
 * to the model's limit), as findings: the provider prints nothing itself.
 *
 * @param warnings - `IndexResult['warnings']`, absent when there were none
 * @returns One `RAG_CHUNKING_CONFIG_ADJUSTED` warning per message
 */
function providerConfigIssues(warnings: IndexResult['warnings']): ValidationIssue[] {
  return (warnings ?? []).map((message) => ({ code: 'RAG_CHUNKING_CONFIG_ADJUSTED', severity: 'warning', message }));
}

/** What the provider recorded — per-resource failures and its own warnings — as findings. */
function providerIssues(
  result: Pick<IndexResult, 'errors' | 'warnings'>,
  locations: ReadonlyMap<string, string>,
): ValidationIssue[] {
  return [...providerIndexIssues(result.errors, locations), ...providerConfigIssues(result.warnings)];
}

/** What {@link buildIndexReport} needs from a finished run. */
interface IndexReportInput {
  /** Resources submitted: every file the crawl enumerated, read or not. */
  examined: number;
  /** The counters only: the failures arrive as `issues`, already located. */
  result: Pick<IndexResult, 'resourcesIndexed' | 'resourcesSkipped' | 'resourcesEmpty' | 'resourcesUpdated' | 'chunksCreated' | 'chunksDeleted'>;
  /** Every document the index does not hold, from both sources. */
  issues: readonly ValidationIssue[];
  durationMs: number;
}

/**
 * The report for a finished index run.
 *
 * The status is DERIVED from the findings, never asserted: this used to be a
 * hardcoded `status: 'success'` beside an unconditional `process.exit(0)`, so a
 * run that failed a fifth of its corpus told the user — and any CI step parsing
 * it — that everything was fine. A dropped document is an error finding (exit
 * 1): the run finished, and the counters report everything that did land.
 */
export function buildIndexReport(input: IndexReportInput): RagIndexReport {
  const { result } = input;
  return buildReport({
    examined: input.examined,
    findings: toFindings([...input.issues]),
    data: {
      resourcesIndexed: result.resourcesIndexed,
      resourcesSkipped: result.resourcesSkipped,
      resourcesEmpty: result.resourcesEmpty,
      resourcesUpdated: result.resourcesUpdated,
      chunksCreated: result.chunksCreated,
      chunksDeleted: result.chunksDeleted,
    },
    gate: RAG_GATE,
    durationMs: input.durationMs,
  });
}

export async function indexCommand(
  pathArg: string | undefined,
  options: IndexOptions
): Promise<void> {
  const logger = createLogger({ debug: options.debug ?? false });
  const startTime = Date.now();

  let report: RagIndexReport;
  // Held outside the `try`: a run the database then refuses still names every file it could not read,
  // every document the provider failed before the refusal, and every finding of a finished index.
  let unreadable: ValidationIssue[] = [];
  let locations: ReadonlyMap<string, string> = new Map();
  let indexed: IndexResult | undefined;
  try {
    // The path is the root to crawl: one that names nothing, or that the OS
    // will not list, refuses before any database is opened.
    if (pathArg !== undefined) assertReadableDirectoryArgument(pathArg);

    // Resolve projectRoot at the CLI boundary.
    // `vat rag index` uses `tolerate null` (spec §7) — rag config-loading
    // produces its own error if config is required.
    const projectRoot = projectRootOrNull(process.cwd());

    // Resolve database path (allow `--db <path>` without a projectRoot).
    const dbPath = resolveDbPath(options.db, projectRoot ?? undefined);
    logger.debug(`Database path: ${dbPath}`);

    // Load resources. `loadResourcesWithConfig` requires a non-null root, so
    // when projectRoot is null we fall back to cwd for the crawl baseDir.
    // Indexing doesn't surface URI-reference resolution, so cwd is fine here.
    const crawlRoot = projectRoot ?? process.cwd();
    const { registry } = await loadResourcesWithConfig(pathArg, crawlRoot, logger);

    const allResources = registry.getAllResources();
    // The declared population is the admitted one PLUS what the crawl could not
    // read; the second half is reported below, not dropped — see `unreadableIndexIssues`.
    unreadable = unreadableIndexIssues(registry.getUnreadableResources(), crawlRoot);
    logger.debug(`Found ${allResources.length} resources to index (${unreadable.length} enumerated but unreadable)`);
    requireWritableDatabase(dbPath, options.db !== undefined && options.db !== '');

    // Create RAG provider in admin mode (readonly: false)
    const ragProvider = await LanceDBRAGProvider.create({
      dbPath,
      readonly: false,
    });

    locations = new Map(allResources.map((resource) => [
      resource.id,
      toForwardSlash(safePath.relative(crawlRoot, resource.filePath)),
    ]));
    const indexResult = await ragProvider.indexResources(allResources);
    indexed = indexResult;
    await ragProvider.close();

    const recorded = providerIssues(indexResult, locations);
    // Every one, on stderr: this verb has no `--verbose`.
    reportFindings([...unreadable, ...recorded], { verbose: true, write: logger.warn });
    report = buildIndexReport({
      examined: allResources.length + unreadable.length,
      result: indexResult,
      issues: [...unreadable, ...recorded],
      durationMs: Date.now() - startTime,
    });
  } catch (error) {
    const partial = partialIndexResultOf(error) ?? indexed;
    // The writer says them on stderr, with the refusal.
    const recorded = partial ? providerIssues(partial, locations) : [];
    return endWithRefusal('rag index', refusalCodeOf(error), error, 'yaml', RAG_GATE, { ...NOTHING_FINISHED, findings: toFindings([...unreadable, ...recorded]) });
  }
  endWithReport('rag index', report, 'yaml');
}
