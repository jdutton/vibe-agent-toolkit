/**
 * RAG index command - index markdown resources into vector database
 */

import type { IndexResult } from '@vibe-agent-toolkit/rag';
import { LanceDBRAGProvider } from '@vibe-agent-toolkit/rag-lancedb';

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
 * `errors` is optional on `IndexResult`: the provider omits it entirely when
 * nothing failed, and can also return `[]`. Both are success.
 *
 * @param indexResult - The result of the indexing run (only `errors` is read)
 * @returns The status to publish and the exit code that agrees with it
 */
export function indexOutcome(indexResult: Pick<IndexResult, 'errors'>): IndexOutcome {
  const failed = indexResult.errors?.length ?? 0;

  return failed > 0 ? { status: 'partial', exitCode: 1 } : { status: 'success', exitCode: 0 };
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
    logger.debug(`Found ${allResources.length} resources to index`);

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

    // Status is DERIVED, never asserted: see `indexOutcome`.
    const outcome = indexOutcome(indexResult);

    // Output results as YAML
    writeYamlOutput({
      status: outcome.status,
      resourcesIndexed: indexResult.resourcesIndexed,
      resourcesSkipped: indexResult.resourcesSkipped,
      resourcesUpdated: indexResult.resourcesUpdated,
      chunksCreated: indexResult.chunksCreated,
      chunksDeleted: indexResult.chunksDeleted,
      duration: formatDuration(duration),
      ...(indexResult.errors && indexResult.errors.length > 0
        ? { errors: indexResult.errors }
        : {}),
    });

    // The report is published FIRST and the failure signalled after, so a
    // partial run still hands the operator the `errors` list naming exactly
    // which resources are missing from the database.
    process.exit(outcome.exitCode);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Index');
  }
}
