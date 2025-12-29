/**
 * Utilities for loading and crawling resources
 */

import { ResourceRegistry } from '@vibe-agent-toolkit/resources';

import type { ProjectConfig } from '../schemas/config.js';

import { loadConfig } from './config-loader.js';
import type { Logger } from './logger.js';
import { findProjectRoot } from './project-root.js';

export interface ResourceLoadResult {
  scanPath: string;
  projectRoot: string | null;
  config: ProjectConfig | undefined;
  registry: ResourceRegistry;
}

/**
 * Load resources from a path with config support
 *
 * Common pattern for CLI commands that need to:
 * 1. Determine scan path
 * 2. Find project root and load config
 * 3. Create registry and crawl
 *
 * @param pathArg - Path argument from CLI (optional)
 * @param logger - Logger instance
 * @returns Resource load result with registry and metadata
 */
export async function loadResourcesWithConfig(
  pathArg: string | undefined,
  logger: Logger
): Promise<ResourceLoadResult> {
  // Determine scan path
  const scanPath = pathArg ?? process.cwd();
  logger.debug(`Scan path: ${scanPath}`);

  // Find project root and load config
  const projectRoot = findProjectRoot(scanPath);
  const config = projectRoot ? loadConfig(projectRoot) : undefined;

  if (config) {
    logger.debug(`Loaded config from ${projectRoot ?? 'unknown'}`);
  }

  // Create registry and crawl
  const registry = new ResourceRegistry();

  const crawlOptions = {
    baseDir: scanPath,
    ...(config?.resources?.include ? { include: config.resources.include } : {}),
    ...(config?.resources?.exclude ? { exclude: config.resources.exclude } : {}),
  };

  await registry.crawl(crawlOptions);

  return {
    scanPath,
    projectRoot,
    config,
    registry,
  };
}
