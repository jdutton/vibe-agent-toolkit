/**
 * Utilities for loading and crawling resources
 */

import {
  ResourceRegistry,
  type ProjectConfig as ResourcesProjectConfig,
  type ResourceRegistryOptions,
} from '@vibe-agent-toolkit/resources';
import { GitTracker } from '@vibe-agent-toolkit/utils';

import type { ProjectConfig } from '../schemas/config.js';

import { loadConfig } from './config-loader.js';
import type { Logger } from './logger.js';
import { findProjectRoot } from './project-root.js';

export interface ResourceLoadResult {
  scanPath: string;
  projectRoot: string | null;
  config: ProjectConfig | undefined;
  registry: ResourceRegistry;
  gitTracker: GitTracker | undefined;
}

/**
 * Load resources from a path with config support
 *
 * Common pattern for CLI commands that need to:
 * 1. Determine scan path
 * 2. Find project root and load config
 * 3. Create registry and crawl
 *
 * Behavior:
 * - When path argument provided: use as baseDir, ignore config patterns (use defaults)
 * - When no path argument: use project root/cwd as baseDir, apply config patterns
 *
 * @param pathArg - Path argument from CLI (optional)
 * @param logger - Logger instance
 * @returns Resource load result with registry and metadata
 */
export async function loadResourcesWithConfig(
  pathArg: string | undefined,
  logger: Logger
): Promise<ResourceLoadResult> {
  // Find project root and load config
  const projectRoot = findProjectRoot(process.cwd());
  const config = projectRoot ? loadConfig(projectRoot) : undefined;

  if (config) {
    logger.debug(`Loaded config from ${projectRoot ?? 'unknown'}`);
  }

  // Create and initialize GitTracker if we have a project root
  let gitTracker: GitTracker | undefined;
  if (projectRoot) {
    gitTracker = new GitTracker(projectRoot);
    await gitTracker.initialize();
    const stats = gitTracker.getStats();
    logger.debug(`GitTracker initialized with ${stats.cacheSize} tracked files`);
  }

  // Create registry and crawl
  // Build options conditionally to satisfy exactOptionalPropertyTypes
  const registryOptions: ResourceRegistryOptions = {};
  if (config?.resources?.collections) {
    // Convert CLI config to resources package config
    // Only pass the collections field that resources package needs
    const resourcesConfig: ResourcesProjectConfig = {
      version: 1,
      resources: {
        collections: config.resources.collections,
        include: config.resources.include,
        exclude: config.resources.exclude,
      },
    };
    registryOptions.config = resourcesConfig;
  }
  if (projectRoot) {
    registryOptions.baseDir = projectRoot;
  }
  if (gitTracker) {
    registryOptions.gitTracker = gitTracker;
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
    // No path argument: crawl from project root (or cwd) with config patterns
    const scanPath = projectRoot ?? process.cwd();
    logger.debug(`No path argument, using: ${scanPath}`);

    crawlOptions = {
      baseDir: scanPath,
      // Apply include patterns from config (if specified)
      ...(config?.resources?.include ? { include: config.resources.include } : {}),
      // Apply exclude patterns from config (if specified)
      ...(config?.resources?.exclude ? { exclude: config.resources.exclude } : {}),
    };
  }

  await registry.crawl(crawlOptions);

  return {
    scanPath: pathArg ?? (projectRoot ?? process.cwd()),
    projectRoot,
    config,
    registry,
    gitTracker,
  };
}
