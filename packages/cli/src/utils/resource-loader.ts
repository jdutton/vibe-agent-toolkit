/**
 * Utilities for loading and crawling resources
 */

import { existsSync, statSync } from 'node:fs';

import {
  DEFAULT_RESOURCE_INCLUDE,
  ResourceRegistry,
  type CrawlOptions,
  type ProjectConfig,
  type ResourceRegistryOptions,
} from '@vibe-agent-toolkit/resources';
import { GitTracker, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

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
 * Scope resource include patterns to a subdirectory of the crawl base.
 *
 * Pure, and exported so the scoping rule is testable without a filesystem.
 * `relDir` is base-relative with forward slashes; `''` means "the base itself",
 * for which the patterns are already correctly scoped.
 *
 * The patterns in {@link DEFAULT_RESOURCE_INCLUDE} are all `**`-rooted, so
 * prefixing is enough: picomatch's `**` matches zero segments, meaning
 * `docs/**\/*.md` still matches `docs/a.md`.
 */
export function scopeIncludeToSubtree(include: readonly string[], relDir: string): string[] {
  if (relDir === '') {
    return [...include];
  }
  return include.map((pattern) => `${relDir}/${pattern}`);
}

/**
 * Build the crawl options for an explicit path argument.
 *
 * The path argument RESTATES which tree to scan; it does not license scanning
 * files the project has declared out of bounds. So `exclude` — a "never treat
 * this as a resource" statement about node_modules, build output, vendored
 * trees, and deliberately-broken test fixtures — is applied either way, while
 * the path replaces `include`.
 *
 * That is only expressible by keeping `baseDir` at the project root: config
 * globs are declared relative to the project root, so re-basing the crawl onto
 * the path argument (the previous behavior) silently voided every one of them.
 * Instead the path argument becomes an include PREFIX on the same basis.
 */
function crawlOptionsForPath(
  pathArg: string,
  projectRoot: string,
  config: ProjectConfig | undefined,
  logger: Logger,
): CrawlOptions {
  const resolved = safePath.resolve(pathArg);
  // safePath.relative already normalizes, but toForwardSlash makes the
  // separator assumption in the `../` test below explicit on Windows too.
  const normalizedRelDir = toForwardSlash(safePath.relative(projectRoot, resolved));

  if (normalizedRelDir === '..' || normalizedRelDir.startsWith('../')) {
    // Outside the project root, so the config's root-relative globs describe a
    // different tree and genuinely cannot apply. Say so rather than dropping
    // them silently — silent dropping is the bug this function exists to fix.
    logger.warn(
      `${resolved} is outside projectRoot ${projectRoot}; ` +
        `resources include/exclude patterns from the config do not apply to it`,
    );
    return { baseDir: resolved };
  }

  assertCrawlableDirectory(resolved);

  return {
    baseDir: projectRoot,
    include: scopeIncludeToSubtree(DEFAULT_RESOURCE_INCLUDE, normalizedRelDir),
    ...(config?.resources?.exclude ? { exclude: config.resources.exclude } : {}),
  };
}

/**
 * Fail loudly on a path argument that cannot be crawled.
 *
 * The crawler used to perform this check itself, because it received the path
 * argument as its `baseDir`. Now that `baseDir` is the project root, a bad path
 * argument would otherwise degrade into a glob that matches nothing — a green
 * run reporting `filesScanned: 0`.
 */
function assertCrawlableDirectory(resolved: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- CLI path argument, resolved above
  if (!existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- CLI path argument, existence checked above
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }
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
 * - When no path argument: crawl the project root, applying the config's
 *   `resources.include` and `resources.exclude` patterns.
 * - When a path argument is provided: still crawl on the project-root basis (so
 *   the config's root-relative globs remain meaningful), with `include` replaced
 *   by the default resource patterns scoped to that subtree and the config's
 *   `exclude` still applied. A path argument says WHICH tree to scan; it does
 *   not license scanning files the project excluded.
 * - When the path argument lies outside the project root, the config's patterns
 *   describe a different tree: they are dropped, with a warning.
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

  let crawlOptions: CrawlOptions;

  if (pathArg) {
    // Path argument provided: narrow the scan to that subtree, but keep the
    // project's exclude patterns — see crawlOptionsForPath.
    logger.debug(`Path argument provided: ${pathArg}`);
    crawlOptions = crawlOptionsForPath(pathArg, projectRoot, config, logger);
    logger.debug(`Crawling ${crawlOptions.baseDir} with include: ${JSON.stringify(crawlOptions.include)}`);
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
