/**
 * Utilities for loading and crawling resources
 */

import { projectConfigOrNone, REGISTRY_INCLUDE, RunSkillRegistries } from '@vibe-agent-toolkit/agent-skills';
import {
  buildLinkAuthEngineConfig,
  DEFAULT_RESOURCE_INCLUDE,
  gitExtentSelected,
  ResourceRegistry,
  withRunPopulation,
  type CrawlOptions,
  type CrawlPopulation,
  type FactStore,
  type ParseDispatcher,
  type PopulationCache,
  type ProjectConfig,
  type RunPopulation,
} from '@vibe-agent-toolkit/resources';
import { relativeEscapesRoot, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { GitTracker, gitTreeSnapshot } from '@vibe-agent-toolkit/utils/git';

import { CommandRefusalError } from './command-refusal.js';
import { loadConfig } from './config-loader.js';
import type { Logger } from './logger.js';
import { collectionsOption } from './population-wiring.js';
import { assertDirectoryArgument } from './project-root-policy.js';
import { type OpenedPopulationCache, openQuestionCache, projectionStoreSelected, runThenClose, withLazyPopulationCache } from './projection-store.js';

/**
 * One VAT process run's shared population, registry and parse dispatcher: what
 * every phase of the run reads through, so each file is read, keyed, parsed and
 * admitted once per run whichever phase asks (rule 4 of "Decision: content
 * identity is per source", `docs/architecture/content-keying-and-git.md`).
 *
 * Built with {@link withRunContext} by `vat validate`, `vat verify`,
 * `vat resources validate`, `vat skills validate`, `vat resources scan`,
 * `vat audit`, `vat skill review`, `vat skills build`, `vat skills package`,
 * `vat skill test run` and `vat claude plugin build`, and required by every
 * phase runner of those verbs: there is no phase that builds a registry of its
 * own beside it. `vat rag index` opens one too, but its index step re-reads
 * each file. `vat ard emit` opens none, and still reads a file once per lane
 * that asks.
 */
export interface RunContext {
  /** The run's population: one read, key, parse and admission per file, and each root's enumeration. */
  readonly population: RunPopulation;
  /**
   * The run's registry. A phase never crawls it: it crawls a `view` of it under
   * its own base directory, config and include set (see `ResourceRegistry.view`).
   */
  readonly registry: ResourceRegistry;
  /** The run's one parse dispatcher, which the run shuts down. */
  readonly dispatcher: ParseDispatcher;
}

/** The errors that refuse a whole run, by identity: see {@link isRunRefusal}. */
const runRefusals = new WeakSet<object>();

/**
 * Mark `error` as the run's refusal, so no phase claims it as its own.
 *
 * @param error - What refused the run
 * @returns `error`, marked when it is an object
 */
function markRunRefusal(error: unknown): unknown {
  if (typeof error === 'object' && error !== null) runRefusals.add(error);
  return error;
}

/**
 * Whether `error` refuses the whole run rather than the phase it surfaced in: the
 * run's projection store would not open (a read-only `VAT_CACHE_DIR`, say), or
 * opened and then could not read its blob tier back. The store opens on the
 * run's first enumeration and every later enumeration is answered by that same
 * refusal; the blob tier is read once per run and every later admission is
 * answered by that same rejection. So it is the run's, said once (`orchestrate`),
 * never once per phase that meets it. A phase runner rethrows it.
 *
 * An error that carries the run's refusal as its `cause` is the run's refusal
 * too: the population codes a blob tier failure in its own error
 * (`PROJECTION_STORE_READ_FAILED`) around the store's.
 *
 * The walk stops at the first error it has already seen, so a `cause` chain that
 * loops back on itself (`e.cause = e`) ends rather than spinning the run.
 *
 * @param error - A phase's error
 * @returns Whether it is the run's refusal
 */
export function isRunRefusal(error: unknown): boolean {
  const seen = new Set<object>();
  for (let current = error; typeof current === 'object' && current !== null && !seen.has(current); current = (current as { cause?: unknown }).cause) {
    if (runRefusals.has(current)) return true;
    seen.add(current);
  }
  return false;
}

/**
 * The run's store, with a failed blob tier read marked as the run's refusal
 * ({@link isRunRefusal}). Every other call is the store's own.
 *
 * @param store - The run's store
 * @returns The same store, marking
 */
function markingBlobReads(store: FactStore): FactStore {
  return {
    writeBlobFacts: (rows) => store.writeBlobFacts(rows),
    readBlobFacts: (contentKeys, request) => store.readBlobFacts(contentKeys, request).catch((error: unknown) => {
      throw markRunRefusal(error);
    }),
    writeExtent: (key, rows) => store.writeExtent(key, rows),
    readExtent: (key, request) => store.readExtent(key, request),
    close: () => store.close(),
  };
}

/**
 * The run's population cache, as {@link withRunContext} hands it to the run: a
 * store that will not open, or whose blob tier cannot be read, is the run's refusal.
 *
 * @param cacheOf - Opens the run's population cache
 * @returns The cache, or `undefined` when the run has no store
 */
async function runCacheOf(cacheOf: () => Promise<PopulationCache | undefined>): Promise<PopulationCache | undefined> {
  const cache = await cacheOf().catch((error: unknown) => {
    throw markRunRefusal(error);
  });
  return cache === undefined ? undefined : { ...cache, store: markingBlobReads(cache.store) };
}

/**
 * The store as a run's stored-document questions open it: a connection that
 * never waits on a lock ({@link openQuestionCache}), opened by the first
 * question that needs it and closed when the run ends ({@link runThenClose}, the
 * run's own connection's close contract). Its blob tier reads are marked as the
 * run's refusal, as the run's own connection's are.
 *
 * @param root - The run's home root
 * @param holdsStore - Whether the run has a projection store
 * @returns The opener, and its open for the closer: `undefined` when nothing asked
 */
function questionStoreOf(root: string, holdsStore: boolean): {
  readonly cacheOf: () => Promise<PopulationCache | undefined>;
  readonly opening: () => Promise<OpenedPopulationCache | undefined> | undefined;
} {
  let opened: Promise<OpenedPopulationCache | undefined> | undefined;
  return {
    cacheOf: async () => {
      if (!holdsStore) return undefined;
      opened ??= openQuestionCache({ root });
      const cache = (await opened)?.cache;
      return cache === undefined ? undefined : { ...cache, store: markingBlobReads(cache.store) };
    },
    opening: () => opened,
  };
}

/**
 * Run one verb's work with its {@link RunContext}, inside the projection-store
 * scope that answers it.
 *
 * Opening the run reads no file, opens no store and takes no snapshot. The first
 * enumeration of the home root, or the first stored-document question a skills
 * lane asks (`RunPopulation.storedDocument`), inside whichever phase asks first,
 * opens the store, takes the snapshot that keys it and initializes the root's
 * ignore oracle; so a phase that refuses at its own guards, or finds nothing to
 * check, refuses or reports exactly as it would alone. A verb that asks only a
 * stored-document question (a `vat verify` with only non-resource phases)
 * therefore opens the store for it, and on a cold store
 * derives the whole home population to answer one skill. The questions open
 * their own connection, one that never waits on a lock ({@link questionStoreOf}). A git refusal is the refusal of
 * the phase that enumerated; a store that will not open, or whose blob tier
 * cannot be read, is the run's refusal ({@link isRunRefusal}), said once, and no
 * later phase runs.
 * What can still fail here is the parse dispatcher's shutdown when the run ends.
 *
 * @param options - The run's home root, the trees it writes (`[]` for a verb that
 *   only reads; see `RunPopulationOptions.outputs`), an ignore oracle to reuse,
 *   and whether the run has a projection store: `'on-demand'` opens it as above,
 *   `'none'` declares a run that never opens it (`vat audit`), so its enumerations
 *   and stored-document questions open no home and take no snapshot
 * @param work - The verb's work
 * @returns Whatever `work` returned
 */
export function withRunContext<T>(
  options: {
    readonly root: string;
    readonly outputs: readonly string[];
    readonly projectionStore: 'on-demand' | 'none';
    readonly gitTracker?: GitTracker | undefined;
  },
  work: (run: RunContext) => Promise<T>,
): Promise<T> {
  const root = safePath.resolve(options.root);
  const gitTracker = options.gitTracker ?? new GitTracker(root);
  // One decision whether the run has a store: what the openers answer and what the
  // skills lane counts a scan as (`skillText.storeMiss` or `skillText.noStore`).
  const holdsStore = options.projectionStore === 'on-demand' && projectionStoreSelected();
  const questionStore = questionStoreOf(root, holdsStore);
  // The questions' connection closes inside the scope, before the run's own.
  return withLazyPopulationCache({ root }, (cacheOf) => runThenClose(() =>
    withRunPopulation(
      {
        root,
        outputs: options.outputs,
        gitTracker,
        cacheOf: holdsStore ? () => runCacheOf(cacheOf) : () => Promise.resolve(undefined),
        questionCacheOf: questionStore.cacheOf,
        holdsStore,
        collectionsFor: (enumerated) => Promise.resolve(collectionsOption(enumerated).collections),
      },
      (population) => work({
        population,
        registry: ResourceRegistry.forRun(population, { baseDir: root, gitTracker }),
        dispatcher: population.dispatcher,
      }),
    ), questionStore.opening),
  );
}

/**
 * The run's skill registries for every verb that packages or validates skills
 * outside `vat skills validate` (which narrows its shared root to markdown, see
 * `skillsValidateRegistries`): every root's view crawls {@link REGISTRY_INCLUDE}
 * under that root's own config, and packaging uses
 * `RunSkillRegistries.packagingRegistry`. One per run, built over the run's
 * registry and population, so every skill of the run shares one crawl per root.
 *
 * @param run - The run
 * @returns The run's skill registries
 */
export function runSkillRegistries(run: RunContext): RunSkillRegistries {
  return new RunSkillRegistries({
    registry: run.registry,
    source: run.population.source,
    dispatcher: run.dispatcher,
    includeFor: () => REGISTRY_INCLUDE,
    configFor: projectConfigOrNone,
    crawlOnce: (key, crawl) => run.population.crawlOnce(key, crawl),
  });
}

export interface ResourceLoadResult {
  scanPath: string;
  projectRoot: string;
  config: ProjectConfig | undefined;
  registry: ResourceRegistry;
  gitTracker: GitTracker;
  /**
   * Where the population came from: the `CrawlPopulation` the crawl itself
   * returned, carried here unchanged — the enumeration's outcome (store or
   * derived) and the enumerator that produced it.
   *
   * Reported as a fact about the run rather than about the environment that
   * requested it: reading `VAT_EXTENT_SOURCE` back would prove what was ASKED
   * for, never what happened.
   */
  population: CrawlPopulation;
}

/**
 * Refuse a `resources.linkAuth` provider that cannot compile HERE, where the
 * config is loaded, so every verb that loads it answers the same way.
 *
 * `buildLinkAuthEngineConfig` is the one place the per-provider compile check
 * (`assertProviderCompiles`) lives, and the registry calls it only when it
 * constructs the external-link validator — i.e. under `--check-external-urls`.
 * Every other verb on this loader (`vat validate`, `vat resources validate`
 * without the flag, `vat resources scan`, `vat rag index`) accepted an
 * uncompilable `when` and exited 0, while the validation-code registry
 * promised the refusal "at config load … and every other command that loads
 * `resources.linkAuth`". The registry was right about what the contract should
 * be; this makes the code keep it. The built config is discarded — the
 * registry builds its own when the lane runs — because the value wanted is
 * the throw, and calling the same function is how the two stay one check.
 *
 * @throws {LinkAuthConfigError} naming `providers[<n>]`, the host and the field;
 *   every caller's catch turns a thrown error into exit 2.
 */
function assertLinkAuthProvidersCompile(config: ProjectConfig): void {
  const linkAuth = config.resources?.linkAuth;
  if (linkAuth !== undefined) buildLinkAuthEngineConfig(linkAuth);
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
 * Refuse a `--collection` that names no collection the project declares.
 *
 * A typo'd filter used to run the verb over zero resources and answer with a
 * run-integrity finding (or, in `scan`, a zero count under the typo'd name) —
 * a report about a collection that does not exist. It is the invocation's
 * mistake, and `resources validate` and `resources scan` refuse it the same way.
 * A declared collection that matched no file is NOT refused here: that is a run
 * over nothing, and the writer's run-integrity refusal says so.
 *
 * @param config - The loaded project config, when there is one
 * @param collection - The `--collection` value, when one was passed
 * @throws {CommandRefusalError} `USAGE_INVALID` naming the declared collections
 */
export function assertDeclaredCollection(config: ProjectConfig | undefined, collection: string | undefined): void {
  if (collection === undefined) return;
  const declared = Object.keys(config?.resources?.collections ?? {});
  if (declared.includes(collection)) return;
  throw new CommandRefusalError(
    'USAGE_INVALID',
    `--collection ${collection} names no collection in resources.collections`
      + ` (declared: ${declared.length === 0 ? 'none' : declared.join(', ')})`,
  );
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
  run: RunContext,
  config: ProjectConfig | undefined,
  logger: Logger,
): CrawlOptions {
  const projectRoot = run.population.root;
  const populationSource = run.population.source;
  const resolved = safePath.resolve(pathArg);
  // safePath.relative already normalizes, but toForwardSlash makes the
  // separator assumption in the `../` test below explicit on Windows too.
  const normalizedRelDir = toForwardSlash(safePath.relative(projectRoot, resolved));

  if (relativeEscapesRoot(normalizedRelDir)) {
    // Outside the project root, so the config's root-relative globs describe a
    // different tree and genuinely cannot apply. Say so rather than dropping
    // them silently — silent dropping is the bug this function exists to fix.
    // The run's population enumerates that tree under its own oracles.
    logger.warn(
      `${resolved} is outside projectRoot ${projectRoot}; ` +
        `resources include/exclude patterns from the config do not apply to it`,
    );
    return { baseDir: resolved, unreadable: RESOURCES_UNREADABLE, ignoredRefusals: RESOURCES_IGNORED_REFUSALS, outputs: [], populationSource };
  }

  // The crawler used to perform this check itself, because it received the path
  // argument as its `baseDir`. Now that `baseDir` is the project root, a bad path
  // argument would otherwise degrade into a glob that matches nothing — a green
  // run reporting `filesScanned: 0`.
  assertDirectoryArgument(resolved);

  return {
    baseDir: projectRoot,
    unreadable: RESOURCES_UNREADABLE,
    ignoredRefusals: RESOURCES_IGNORED_REFUSALS,
    // Every resources verb only reads the tree it crawls.
    outputs: [],
    populationSource,
    include: scopeIncludeToSubtree(DEFAULT_RESOURCE_INCLUDE, normalizedRelDir),
    ...(config?.resources?.exclude ? { exclude: config.resources.exclude } : {}),
  };
}

/**
 * The resources verbs' ruling for a directory the crawl cannot list: refuse
 * the run by name, exit 2 — `vat resources validate`/`scan`/`check` and every
 * verb that reaches this loader act on the registry as the whole population.
 * See `PopulationUnreadablePolicy` on the registry.
 */
const RESOURCES_UNREADABLE = 'refuse' as const;

/**
 * The resources verbs report a directory they could not list inside ignored
 * territory: `vat resources validate` lists it as an `EXTENT_DIRECTORY_UNLISTABLE`
 * warning, with the store on or off. See `PopulationMembers.ignoredRefusals`.
 */
const RESOURCES_IGNORED_REFUSALS = 'record' as const;


/**
 * Load resources from a path with config support, as one phase of a run.
 *
 * Common pattern for CLI commands that need to:
 * 1. Determine scan path
 * 2. Load config from the run's root
 * 3. Crawl a view of the run's registry
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
 *   describe a different tree: they are dropped, with a warning, and the run's
 *   population enumerates that tree under its own oracles.
 *
 * The project root is the run's (`run.population.root`), which the caller
 * resolved at the CLI boundary with one of the policy helpers in
 * `project-root-policy.ts`.
 *
 * @param pathArg - Path argument from CLI (optional)
 * @param run - The run this load is one phase of
 * @param logger - Logger instance
 * @returns Resource load result with registry, metadata and the population the
 *   crawl returned
 */
export async function loadResourcesWithConfig(
  pathArg: string | undefined,
  run: RunContext,
  logger: Logger,
): Promise<ResourceLoadResult> {
  const projectRoot = run.population.root;
  const { gitTracker } = run.population;
  // Config lookup is anchored at the resolved projectRoot.
  const config = loadConfig(projectRoot, 'source');

  if (config) {
    logger.debug(`Loaded config from ${projectRoot}`);
    assertLinkAuthProvidersCompile(config);
  }

  // 🚨 The config is handed over WHENEVER one was loaded — never gated on one of
  // its keys. Every read inside the registry is already
  // `this.config?.resources?.<key>`-guarded, so an undeclared key costs nothing;
  // a key-gate here can only hide the next consumer (it once hid
  // `resources.linkAuth` from every adopter without `collections`).
  const registry = run.registry.view({
    baseDir: projectRoot,
    gitTracker,
    ...(config === undefined ? {} : { config }),
  });

  let crawlOptions: CrawlOptions;

  if (pathArg) {
    // Path argument provided: narrow the scan to that subtree, but keep the
    // project's exclude patterns — see crawlOptionsForPath.
    logger.debug(`Path argument provided: ${pathArg}`);
    crawlOptions = crawlOptionsForPath(pathArg, run, config, logger);
    logger.debug(`Crawling ${crawlOptions.baseDir} with include: ${JSON.stringify(crawlOptions.include)}`);
  } else {
    // No path argument: crawl from projectRoot with config patterns
    logger.debug(`No path argument, using: ${projectRoot}`);

    crawlOptions = {
      baseDir: projectRoot,
      unreadable: RESOURCES_UNREADABLE,
      ignoredRefusals: RESOURCES_IGNORED_REFUSALS,
      outputs: [],
      populationSource: run.population.source,
      // Apply include patterns from config (if specified)
      ...(config?.resources?.include ? { include: config.resources.include } : {}),
      // Apply exclude patterns from config (if specified)
      ...(config?.resources?.exclude ? { exclude: config.resources.exclude } : {}),
    };
  }

  // With a store, the crawl below opens it, and opening it takes the snapshot that
  // keys it. Taking that snapshot HERE is the same one moved a few lines earlier
  // (the open store bracket memoizes it, so the store's key reuses it and adds only
  // its one flag listing, `git ls-files -v`), and
  // it puts the answer in hand before the tracker asks its question (the run
  // initializes the home tracker on the first enumeration of the root). With no
  // store, nothing takes a snapshot: the population is a listing, which reads no
  // file, and a snapshot here would read and hash every untracked one for nothing.
  // Gated on `gitExtentSelected` too: on the filesystem enumerator nothing consumes it.
  if (projectionStoreSelected() && gitExtentSelected(projectRoot)) {
    gitTreeSnapshot({ cwd: projectRoot });
  }

  const { population } = await registry.crawl(crawlOptions);
  logger.debug(`GitTracker initialized with ${gitTracker.getStats().cacheSize} tracked files`);

  return {
    scanPath: pathArg ?? projectRoot,
    projectRoot,
    config,
    registry,
    gitTracker,
    population,
  };
}
