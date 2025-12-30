/**
 * RAG index command - index markdown resources into vector database
 */

import { LanceDBRAGProvider } from '@vibe-agent-toolkit/rag-lancedb';

import { createLogger } from '../../utils/logger.js';
import { writeYamlOutput } from '../../utils/output.js';
import { loadResourcesWithConfig } from '../../utils/resource-loader.js';

import { formatDuration, handleCommandError, resolveDbPath } from './command-helpers.js';

interface IndexOptions {
  db?: string;
  debug?: boolean;
}

export async function indexCommand(
  pathArg: string | undefined,
  options: IndexOptions
): Promise<void> {
  const logger = createLogger({ debug: options.debug ?? false });
  const startTime = Date.now();

  try {
    // Load resources with config support
    const { registry, projectRoot } = await loadResourcesWithConfig(pathArg, logger);

    // Resolve database path
    const dbPath = resolveDbPath(options.db, projectRoot ?? undefined);
    logger.debug(`Database path: ${dbPath}`);

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

    // Output results as YAML
    writeYamlOutput({
      status: 'success',
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

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Index');
  }
}
