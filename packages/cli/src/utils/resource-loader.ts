/**
 * Utilities for loading and crawling resources
 */

import { existsSync, statSync } from 'node:fs';

import {
  buildResourcePopulation,
  DEFAULT_RESOURCE_INCLUDE,
  gitExtentSelected,
  ResourceRegistry,
  type CrawlOptions,
  type CrawlSourceKind,
  type PopulationCache,
  type ProjectConfig,
  type ResourcePopulationSource,
  type ResourceRegistryOptions,
} from '@vibe-agent-toolkit/resources';
import { GitTracker, gitTreeSnapshot, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { loadConfig } from './config-loader.js';
import type { Logger } from './logger.js';
import { withPopulationCache } from './projection-store.js';

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
  /**
   * Which enumerator the projection lane used, or `null` when the walk ran and
   * there was no extent to source.
   *
   * Reported for the same reason {@link ResourceCrawlLane} is, one level down.
   * `lane` distinguishes the walk from the projection; it does NOT distinguish
   * the projection's two enumerators, and `VAT_EXTENT_SOURCE` is exactly the
   * axis a flip decision turns on. Without this, both arms of that A/B report
   * `projection` and two identical populations mean either "the enumerators
   * agree" or "the switch was ignored" — indistinguishable, and the second is
   * reachable, because `crawlSourceFor` falls back to the walk without saying
   * so when the root is not in a repository.
   */
  extentSource: CrawlSourceKind | null;
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
 * `vat resources scan`/`validate`, `vat rag index`, the pipeline oracles, and
 * (via {@link withResourcePopulationSource}) the packaging verbs
 * `vat skills build`/`validate` and `vat claude plugin build`, which is what
 * puts `vat build` on the lane at all.
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
 * {@link RESOURCES_CRAWL_ENV}'s value that opts BACK to the incumbent walk.
 *
 * The projection lane is the default now, so this is the escape hatch rather
 * than the selector. Any other value — including the historical `projection` —
 * leaves the projection lane selected, so existing scripts and lab arms that
 * name it explicitly keep working and keep MEANING the same thing.
 */
export const RESOURCES_CRAWL_WALK = 'walk';

/**
 * Whether this process should source the resources population from a projection.
 *
 * **Defaults to the projection lane.** Both lanes now enumerate
 * `tracked ∪ (untracked ∧ ¬ignored)` — `ResourceRegistry.crawl` passes
 * `includeUntracked: true` per `docs/architecture/resource-scanning-and-caching.md`
 * §2.1 — so the population question they answer is the same one.
 *
 * ⚠️⚠️ **ONE DISAGREEMENT SURVIVES, AND IT DROPS FINDINGS: SYMLINKS.** The
 * `filesystem` extent crawls with `followSymlinks: false` and records no link's
 * own path, and `GitCrawlSource` skips mode `120000` deliberately to match it —
 * so BOTH projection extents omit a committed symlink that the incumbent walk
 * includes. For an out-of-tree target those bytes have no other path into the
 * population, which means **a broken symlink the walk reports as
 * `LINK_BROKEN_FILE` is not reported on this lane.** That is a real loss, it is
 * known, and it is the cost this default was accepted at; closing it is its own
 * change (teaching an extent to admit `120000` entries as their own paths).
 * {@link RESOURCES_CRAWL_WALK} is the one-value escape hatch meanwhile.
 *
 * Read from the environment at each call rather than memoized at module load:
 * `vitest.setup.js` deletes every `VAT_*` variable before any test module loads,
 * so a module-level binding would make the switch unobservable to every test
 * that sets it.
 *
 * @returns `true` when the projection lane is selected
 */
export function resourcesProjectionCrawlSelected(): boolean {
  return process.env[RESOURCES_CRAWL_ENV] !== RESOURCES_CRAWL_WALK;
}

/**
 * The projection-backed enumeration for this run, or `undefined` to keep the
 * incumbent `crawlDirectory` walk.
 *
 * Gated on the selector alone — and NOT additionally on a discoverable project
 * root, which is where this differs from `vat inventory`'s
 * `populationProviderFor`. That gate exists there because inventory membership
 * is resolved per skill against a root the extractor derives itself, so a
 * population rooted anywhere else answers a different question.
 *
 * The root the caller resolved is carried ON the source rather than merely used
 * to build it, which is what lets `ResourceRegistry.populationFrom` decline a
 * crawl of some OTHER tree instead of answering it with this tree's ignore
 * oracle. This function used to argue that no second root existed to disagree
 * with; it does — `crawlOptionsForPath` re-bases `baseDir` onto a path argument
 * that lies outside the project root, and the packaging validator's
 * `findProjectRoot(...) ?? dirname(skillPath)` can land on a build output
 * directory. Both are now declined rather than served.
 *
 * The tracker is threaded through because its absence is not cosmetic: with no
 * tracker every realization row reads `gitignored: false`, and the population
 * would admit the ignored half of a git tree rather than decline it. See
 * `buildResourcePopulation`.
 *
 * @param root - The root this source may answer for, and no other
 * @param gitTracker - The run's ignore oracle
 * @param observeExtentSource - Called with the enumerator that actually ran,
 *   once per enumerated root. The value cannot be recovered afterwards by
 *   re-reading the environment — see {@link ResourceLoadResult.extentSource}.
 *   🪤 On a cache hit NO enumerator runs and this still reports the one this
 *   process selected, because the source is chosen before the store is asked
 * @param cache - The run's projection store, or `undefined` to enumerate every
 *   time. A SEPARATE selector from {@link RESOURCES_CRAWL_ENV}: which lane
 *   enumerates and whether its answer is cached are independent choices, and a
 *   cache folded into the lane switch could never be measured against it
 * @returns A population source, or `undefined` to use the walk
 */
function populationSourceFor(
  root: string,
  gitTracker: GitTracker,
  observeExtentSource: (kind: CrawlSourceKind) => void,
  cache: PopulationCache | undefined
): ResourcePopulationSource | undefined {
  if (!resourcesProjectionCrawlSelected()) {
    return undefined;
  }
  return {
    root: safePath.resolve(root),
    enumerate: async (enumeratedRoot: string) => {
      const population = await buildResourcePopulation({
        root: enumeratedRoot,
        gitTracker,
        ...(cache !== undefined && { cache }),
      });
      observeExtentSource(population.extentSource);
      return population.paths;
    },
  };
}

/**
 * Run one command's work with the projection-backed population source it
 * selected, and the store that answers it open for the whole call.
 *
 * The lane-selection seam for every command that builds its OWN registry rather
 * than going through {@link loadResourcesWithConfig} — `vat skills build` and
 * `vat claude plugin build` (via `createProjectRegistry`) and
 * `vat skills validate` (via its shared-context registry). Those three are what
 * put `vat build` on the projection lane at all: before this, that verb reached
 * a projection store on NO phase.
 *
 * Same selector, same store, same ignore oracle as the resource loader —
 * deliberately, and not merely for tidiness. A second way to decide the lane is
 * a second thing to keep in step, and a packaging lane that answered the
 * selector differently from the validation lane would make a whole-run A/B
 * uninterpretable: half the phases on one population, half on the other, and
 * nothing in the output saying so.
 *
 * ⚠️ The tracker is **not optional dressing**. With no `GitTracker` every
 * realization row reads `gitignored: false`, so the population would admit the
 * ignored half of a git tree — generated markdown, caches, vendored corpora —
 * and the packaging run would start bundling and validating files the project
 * told git to forget. One is built here when the caller has none, rooted at the
 * same root the population is enumerated from.
 *
 * @param options - Where the corpus is, and what to reuse
 * @param options.root - The absolute corpus root, which is also the basis every
 *   enumerated path is returned against
 * @param options.gitTracker - An already-initialized tracker to reuse. Omit to
 *   have one built, which costs a `git ls-files` spawn — and only when the lane
 *   is actually selected
 * @param options.observeExtentSource - Called with the enumerator that ran, once
 *   per enumerated root. 🪤 NOT a cache-hit marker: on a hit no enumerator runs
 *   and this still reports the one this process selected
 * @param work - Given the source, or `undefined` when the walk stays selected
 * @returns Whatever `work` returned
 */
export async function withResourcePopulationSource<T>(
  options: {
    root: string;
    gitTracker?: GitTracker | undefined;
    observeExtentSource?: ((kind: CrawlSourceKind) => void) | undefined;
  },
  work: (populationSource: ResourcePopulationSource | undefined) => Promise<T>,
): Promise<T> {
  // Checked before anything is built or opened: an unselected lane must cost
  // nothing, or every command pays a tracker and a store to decline them.
  if (!resourcesProjectionCrawlSelected()) {
    return work(undefined);
  }

  const gitTracker = options.gitTracker ?? new GitTracker(options.root);

  return withPopulationCache({ root: options.root }, async (cache) => {
    // Initialized inside the bracket for the reason `loadResourcesWithConfig`
    // gives at its own call: the store has already taken the snapshot that
    // answers this tracker's question, so asking git again is a spawn spent
    // rebuilding a set the process is holding.
    if (options.gitTracker === undefined) {
      await gitTracker.initialize();
    }

    return work(populationSourceFor(options.root, gitTracker, options.observeExtentSource ?? (() => undefined), cache));
  });
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

  // Built here, but deliberately NOT initialized here — see the call inside the
  // population-cache bracket below. The registry only reads the tracker during
  // `crawl`, which happens inside that bracket, so nothing observes it empty.
  const gitTracker = new GitTracker(projectRoot);

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
  let extentSource: CrawlSourceKind | null = null;
  // The store brackets the crawl and is closed however the crawl ends. Nothing
  // outside this bracket can reach it: the population source is called from
  // inside `registry.crawl` and nowhere else.
  const lane = await withPopulationCache({ root: projectRoot }, async (cache) => {
    // The git enumerator takes a `gitTreeSnapshot` during the crawl below no matter
    // what. Taking it HERE instead is the same snapshot moved a few lines earlier —
    // the open bracket memoizes it, so the enumerator's own call becomes a lookup —
    // and it puts the answer in hand before the tracker asks its question.
    //
    // ⚠️ Gated, because ungated this is a LOSS: a snapshot is `git add --all` plus
    // two more spawns, and on the filesystem enumerator or the incumbent walk
    // nothing would ever consume it. Guarded by `gitExtentSelected` rather than a
    // second copy of the condition, so the two cannot drift.
    if (gitExtentSelected(projectRoot)) {
      gitTreeSnapshot({ cwd: projectRoot });
    }

    // Now inside the bracket, and after the snapshot above. The set a snapshot
    // describes — `tracked ∪ (untracked ∧ ¬ignored)` — is exactly the set this
    // would otherwise spawn `git ls-files --cached --others --exclude-standard` to
    // rebuild, so on the git lane it reads the answer instead of re-asking. Where
    // no snapshot was taken the peek misses and it spawns exactly as before.
    await gitTracker.initialize();
    logger.debug(`GitTracker initialized with ${gitTracker.getStats().cacheSize} tracked files`);

    const populationSource = populationSourceFor(projectRoot, gitTracker, (kind) => {
      extentSource = kind;
    }, cache);
    const selected: ResourceCrawlLane = populationSource ? 'projection' : 'walk';
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
    return selected;
  });

  return {
    scanPath: pathArg ?? projectRoot,
    projectRoot,
    config,
    registry,
    gitTracker,
    lane,
    extentSource,
  };
}
