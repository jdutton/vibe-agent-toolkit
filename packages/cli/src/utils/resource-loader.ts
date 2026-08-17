/**
 * Utilities for loading and crawling resources
 */

import { existsSync, statSync } from 'node:fs';

import {
  buildResourcePopulation,
  DEFAULT_RESOURCE_INCLUDE,
  ResourceRegistry,
  type CrawlOptions,
  type ProjectConfig,
  type ResourcePopulationSource,
  type ResourceRegistryOptions,
} from '@vibe-agent-toolkit/resources';
import { GitTracker, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { loadConfig } from './config-loader.js';
import type { Logger } from './logger.js';

/**
 * Which enumerator produced a load's population.
 *
 * `walk` is the incumbent `crawlDirectory` route; `projection` is the
 * projection lane behind {@link RESOURCES_CRAWL_ENV}.
 */
export type ResourceCrawlLane = 'walk' | 'projection';

export interface ResourceLoadResult {
  scanPath: string;
  projectRoot: string;
  config: ProjectConfig | undefined;
  registry: ResourceRegistry;
  gitTracker: GitTracker | undefined;
  /**
   * Which lane enumerated, as a fact about the run rather than about the
   * environment that requested it.
   *
   * Reported so that a population can be held against another one: two scans of
   * the same tree that disagree are only interpretable if each says which
   * enumerator produced it. Reading the env var back instead would prove what
   * was ASKED for, never what happened — a distinction that has already voided
   * one whole A/B on this codebase, where both arms silently ran the incumbent.
   */
  lane: ResourceCrawlLane;
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
 * The env var that selects the crawler behind every resources-crawling verb —
 * `vat resources scan`/`validate`, `vat rag index`, and the pipeline oracles.
 *
 * An environment switch rather than a config field, for the same reason
 * `VAT_INVENTORY_CRAWL` is one: it selects which INSTRUMENT runs, not what
 * the project means, and it has to be reachable from the lab, which spawns the
 * binary and controls its environment. A config field would put the A and B arms
 * inside the subject's own tree, where a measurement edits the thing it measures.
 */
export const RESOURCES_CRAWL_ENV = 'VAT_RESOURCES_CRAWL';

/** {@link RESOURCES_CRAWL_ENV}'s value that selects the projection lane. */
export const RESOURCES_CRAWL_PROJECTION = 'projection';

/**
 * Whether this process should source the resources population from a projection.
 *
 * ⚠️ **Opposite default to `vat inventory`'s selector, and that asymmetry is the
 * point rather than an oversight.** The inventory flip was defensible as a
 * default because it was provably a byte-for-byte no-op on its subject: both
 * lanes answered the same membership question and were shown to agree. This lane
 * cannot make that claim, because it deliberately does NOT agree — sourcing from
 * the `filesystem` extent is what lets validation see an uncommitted markdown
 * file, so switching it on ADDS findings on real adopter trees.
 *
 * A population change that emits new `LINK_BROKEN_FILE`s at people is not a
 * default to be taken on the strength of it being more correct in the abstract.
 * The blast radius gets measured on real corpora first; flipping this default is
 * then a one-line change with a changelog entry, not a rewrite.
 *
 * Read from the environment at each call rather than memoized at module load:
 * `vitest.setup.js` deletes every `VAT_*` variable before any test module loads,
 * so a module-level binding would make the switch unobservable to every test
 * that sets it.
 *
 * @returns `true` when the projection lane is selected
 */
export function resourcesProjectionCrawlSelected(): boolean {
  return process.env[RESOURCES_CRAWL_ENV] === RESOURCES_CRAWL_PROJECTION;
}

/**
 * The projection-backed enumeration for this run, or `undefined` to keep the
 * incumbent `crawlDirectory` walk.
 *
 * Gated on the selector alone — and NOT additionally on a discoverable project
 * root, which is where this differs from `vat inventory`'s
 * `populationProviderFor`. That gate exists there because inventory membership
 * is resolved per skill against a root the extractor derives itself, so a
 * population rooted anywhere else answers a different question. Here the caller
 * has already resolved the root and the registry is crawled against exactly it,
 * so there is no second root to disagree with.
 *
 * The tracker is threaded through because its absence is not cosmetic: with no
 * tracker every realization row reads `gitignored: false`, and the population
 * would admit the ignored half of a git tree rather than decline it. See
 * `buildResourcePopulation`.
 *
 * @param gitTracker - The run's ignore oracle
 * @returns A population source, or `undefined` to use the walk
 */
function populationSourceFor(gitTracker: GitTracker): ResourcePopulationSource | undefined {
  if (!resourcesProjectionCrawlSelected()) {
    return undefined;
  }
  return (root: string) => buildResourcePopulation({ root, gitTracker });
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

  // Which lane enumerates. Applied to the options both branches above produced,
  // so the path-argument case and the whole-root case cannot end up on different
  // crawlers — the bug shape this file already carries one fix for.
  const populationSource = populationSourceFor(gitTracker);
  const lane: ResourceCrawlLane = populationSource ? 'projection' : 'walk';
  if (populationSource) {
    logger.debug(`Enumerating via the projection lane (${RESOURCES_CRAWL_ENV}=${RESOURCES_CRAWL_PROJECTION})`);
    crawlOptions = { ...crawlOptions, populationSource };
  } else {
    // Said for the same reason the projection branch says it, and the symmetry
    // is the point: a marker that only one lane emits makes the other lane
    // identifiable by ABSENCE, which is indistinguishable from a build too old
    // to have either lane.
    logger.debug(`Enumerating via the incumbent walk (${RESOURCES_CRAWL_ENV} unset)`);
  }

  await registry.crawl(crawlOptions);

  return {
    scanPath: pathArg ?? projectRoot,
    projectRoot,
    config,
    registry,
    gitTracker,
    lane,
  };
}
