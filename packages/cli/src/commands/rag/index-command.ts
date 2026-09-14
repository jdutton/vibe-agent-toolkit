/**
 * RAG index command - index markdown resources into vector database
 */

import type { IndexResult } from '@vibe-agent-toolkit/rag';
import { LanceDBRAGProvider } from '@vibe-agent-toolkit/rag-lancedb';
import type { UnreadableResource } from '@vibe-agent-toolkit/resources';
import { ExitCode } from '@vibe-agent-toolkit/schema';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { createLogger } from '../../utils/logger.js';
import { writeYamlOutput } from '../../utils/output.js';
import { projectRootOrNull } from '../../utils/project-root-policy.js';
import { loadResourcesWithConfig } from '../../utils/resource-loader.js';

import { formatDuration, handleCommandError, resolveDbPath } from './command-helpers.js';

interface IndexOptions {
  db?: string;
  debug?: boolean;
}

/**
 * What an index run is allowed to report, and the exit code that agrees with it.
 *
 * `partial` is spelled the way `vat cache clear` spells it (see
 * `../cache/clear.ts` — `status: 'success' | 'partial'`, exiting
 * `partial ? 1 : 0`): a command that finished, published a complete report, and
 * did not do all of what was asked. The vocabulary is deliberately the sibling's
 * rather than a new one.
 *
 * Exit 1, not 2. This command family documents `1 - reported/expected failure`
 * and `2 - system error` (`vat claude budget`, and the `Exit Codes:` block on
 * every `vat rag` subcommand). A run that indexed most of a corpus and named the
 * resources it dropped is a REPORTED outcome — the report on stdout is complete
 * and parseable. 2 belongs to a command that could not run at all, which here is
 * the `handleCommandError` path below.
 */
export interface IndexOutcome {
  status: 'success' | 'partial';
  exitCode: 0 | 1;
}

/**
 * Derive the reported status and exit code from what indexing actually did.
 *
 * This existed as a hardcoded `status: 'success'` next to an unconditional
 * `process.exit(0)`, so a run that failed a fifth of its corpus told the user —
 * and any CI step parsing it — that everything was fine, while the dropped
 * documents were simply unsearchable. A status field that cannot express failure
 * is the defect; the particular failures it hid are incidental, and
 * `indexResources` can fail a resource for any reason (unreadable file,
 * embedding-provider error, provider unavailable).
 *
 * `errors` is optional on `IndexResult`'s schema, so a provider MAY omit it;
 * `LanceDBRAGProvider` never does (it always carries `errors: []` when nothing
 * failed). Both shapes are success here, because the schema allows both.
 *
 * @param indexResult - The result of the indexing run (only `errors` is read)
 * @returns The status to publish and the exit code that agrees with it
 */
export function indexOutcome(indexResult: Pick<IndexResult, 'errors'>): IndexOutcome {
  const failed = indexResult.errors?.length ?? 0;

  return failed > 0
    ? { status: 'partial', exitCode: ExitCode.FINDINGS }
    : { status: 'success', exitCode: ExitCode.OK };
}

/** One entry of `IndexResult['errors']`. */
type IndexError = NonNullable<IndexResult['errors']>[number];

/**
 * The resources the crawl enumerated but could not read, as index errors.
 *
 * Such a file never reaches `indexResources`: the crawl reads and parses every
 * file itself, so an unreadable one is dropped before the provider sees it. It
 * is therefore in none of the provider's counters and not in its `errors` —
 * the registry keeps the reconciliation log (`getUnreadableResources()`), and
 * this command did not read it, so a corpus with a document missing from the
 * index was reported `status: success`, exit 0, on both crawl lanes. Folding
 * the log into the same `errors` list the provider's failures land in is what
 * lets one status and one exit code cover "did not index everything asked".
 *
 * The id is the path relative to the crawl root: the registry never assigned
 * one (it could not read the file to), and the relative path is what an
 * operator needs to find it.
 *
 * @param unreadable - The registry's read-failure log
 * @param crawlRoot - The directory the crawl was rooted at
 * @returns One error per unreadable file, in the order the crawl met them
 */
export function unreadableIndexErrors(
  unreadable: readonly UnreadableResource[],
  crawlRoot: string,
): IndexError[] {
  return unreadable.map((entry) => ({
    resourceId: toForwardSlash(safePath.relative(crawlRoot, entry.filePath)),
    error: `Enumerated by the crawl but could not be read, so it is not in the index: ${entry.reason}`,
  }));
}

export async function indexCommand(
  pathArg: string | undefined,
  options: IndexOptions
): Promise<void> {
  const logger = createLogger({ debug: options.debug ?? false });
  const startTime = Date.now();

  try {
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
    // read; the second half is reported below, not dropped — see `unreadableIndexErrors`.
    const unreadable = unreadableIndexErrors(registry.getUnreadableResources(), crawlRoot);
    logger.debug(`Found ${allResources.length} resources to index (${unreadable.length} enumerated but unreadable)`);
    for (const entry of unreadable) {
      // On stderr as well, the way the provider reports its own per-resource
      // failures, so a caller reading only the exit code still sees the name.
      logger.warn(`[vat-rag] Failed to index resource '${entry.resourceId}': ${entry.error}`);
    }

    // Create RAG provider in admin mode (readonly: false)
    const ragProvider = await LanceDBRAGProvider.create({
      dbPath,
      readonly: false,
    });

    // Index all resources
    const indexResult = await ragProvider.indexResources(allResources);

    // Close provider
    await ragProvider.close();

    const duration = Date.now() - startTime;

    // One list for both kinds of failure — the provider's and the crawl's.
    const errors = [...unreadable, ...(indexResult.errors ?? [])];

    // Status is DERIVED, never asserted: see `indexOutcome`.
    const outcome = indexOutcome({ errors });

    // Output results as YAML
    writeYamlOutput({
      status: outcome.status,
      resourcesIndexed: indexResult.resourcesIndexed,
      resourcesSkipped: indexResult.resourcesSkipped,
      resourcesEmpty: indexResult.resourcesEmpty,
      resourcesUpdated: indexResult.resourcesUpdated,
      chunksCreated: indexResult.chunksCreated,
      chunksDeleted: indexResult.chunksDeleted,
      duration: formatDuration(duration),
      ...(errors.length > 0 ? { errors } : {}),
    });

    // The report is published FIRST and the failure signalled after, so a
    // partial run still hands the operator the `errors` list naming exactly
    // which resources are missing from the database.
    process.exit(outcome.exitCode);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Index');
  }
}
