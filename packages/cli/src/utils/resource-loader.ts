/**
 * Utilities for loading and crawling resources
 */

import {
  ResourceRegistry,
  type ProjectConfig,
  type ResourceRegistryOptions,
} from '@vibe-agent-toolkit/resources';
import { GitTracker } from '@vibe-agent-toolkit/utils';

import { loadConfig } from './config-loader.js';
import type { Logger } from './logger.js';

export interface ResourceLoadResult {
  scanPath: string;
  projectRoot: string;
  config: ProjectConfig | undefined;
  registry: ResourceRegistry;
  gitTracker: GitTracker | undefined;
}

/**
 * Load resources from a path with config support
 *
 * Common pattern for CLI commands that need to:
 * 1. Determine scan path
 * 2. Load config from the pre-resolved project root
 * 3. Create registry and crawl
 *
 * Behavior:
 * - When path argument provided: use as baseDir, ignore config patterns (use defaults)
 * - When no path argument: use project root as baseDir, apply config patterns
 *
 * Per CLI-boundary rule (spec §5): `projectRoot` MUST be resolved by the
 * caller using one of the policy helpers in `project-root-policy.ts`. This
 * function does not call `findProjectRoot` itself.
 *
 * @param pathArg - Path argument from CLI (optional)
 * @param projectRoot - Pre-resolved project root from the CLI boundary
 * @param logger - Logger instance
 * @returns Resource load result with registry and metadata
 */
export async function loadResourcesWithConfig(
  pathArg: string | undefined,
  projectRoot: string,
  logger: Logger,
): Promise<ResourceLoadResult> {
  // Config lookup is anchored at the resolved projectRoot.
  const config = loadConfig(projectRoot);

  if (config) {
    logger.debug(`Loaded config from ${projectRoot}`);
  }

  // Create and initialize GitTracker anchored at the resolved projectRoot.
  const gitTracker = new GitTracker(projectRoot);
  await gitTracker.initialize();
  const stats = gitTracker.getStats();
  logger.debug(`GitTracker initialized with ${stats.cacheSize} tracked files`);

  // Create registry and crawl
  // Build options conditionally to satisfy exactOptionalPropertyTypes
  const registryOptions: ResourceRegistryOptions = {
    baseDir: projectRoot,
    gitTracker,
  };
  if (config?.resources?.collections) {
    registryOptions.config = config;
  }
  const registry = new ResourceRegistry(registryOptions);

  let crawlOptions;

  if (pathArg) {
    // Path argument provided: crawl from that directory with default patterns
    // Ignore config patterns because they're relative to project root
    logger.debug(`Path argument provided: ${pathArg}`);
    logger.debug('Using default patterns (ignoring config)');

    crawlOptions = {
      baseDir: pathArg,
      // Use defaults from ResourceRegistry.crawl (will use **/*.md)
    };
  } else {
    // No path argument: crawl from projectRoot with config patterns
    logger.debug(`No path argument, using: ${projectRoot}`);

    crawlOptions = {
      baseDir: projectRoot,
      // Apply include patterns from config (if specified)
      ...(config?.resources?.include ? { include: config.resources.include } : {}),
      // Apply exclude patterns from config (if specified)
      ...(config?.resources?.exclude ? { exclude: config.resources.exclude } : {}),
    };
  }

  await registry.crawl(crawlOptions);

  return {
    scanPath: pathArg ?? projectRoot,
    projectRoot,
    config,
    registry,
    gitTracker,
  };
}
