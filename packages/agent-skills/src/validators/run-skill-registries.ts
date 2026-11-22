/**
 * One run's skill registries: a view of the run's registry per project root a
 * skill resolves to, crawled once per run.
 *
 * Skills are validated against the registry of their project root, and one run
 * can reach several roots (`vat audit --user` reaches dozens; a skill with no
 * project root is its own). Each root gets ONE view of the run's registry
 * (`ResourceRegistry.view`), crawled from the run's population under that root's
 * own config: the id, duplicates, links, population conditions and parse refusals
 * are the view's own, while the read, key, parse and stat of every file are the
 * run's (see `RunPopulation` in `@vibe-agent-toolkit/resources`). There is no
 * process-wide memo: the views live exactly as long as the run that holds this.
 */

import {
  IGNORE_HOME_SETTLEMENT,
  listingRefusalRemedy,
  loadConfig,
  type ParseDispatcher,
  type ProjectConfig,
  type PopulationUnreadablePolicy,
  ResourceRegistry,
  type ResourcePopulationSource,
  withRunPopulation,
} from '@vibe-agent-toolkit/resources';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { type DirectoryRefusal, settleCrawlRefusal, type UnreadablePolicy } from '@vibe-agent-toolkit/utils/crawl';
import { GitTracker } from '@vibe-agent-toolkit/utils/git';

import { LINK_GRAPH_MEMBER_GLOBS } from '../link-graph-members.js';

/**
 * What a skill's registry crawls when the run declares nothing narrower: markdown
 * and HTML, so source HTML is in the link graph at source time as it is at build
 * time; and what the built lane reads of its own bundle.
 */
export const REGISTRY_INCLUDE: readonly string[] = ['**/*.md', '**/*.html', '**/*.htm'];

/** A caller's ruling for one crawl: what an unlistable directory does, and what the verb writes. */
export interface SkillRegistryRuling {
  /**
   * What the crawl does with a directory it cannot list: `'refuse'` for every
   * verb that acts on the registry as a complete population, `{ degrade }` for
   * `vat audit`. See `PopulationUnreadablePolicy`.
   */
  readonly unreadable: PopulationUnreadablePolicy;
  /**
   * What the calling verb writes, or `[]` for a verb that only reads: the crawl's
   * one declaration of which side a fault is on. It decides which side a fault
   * is on, never which files the crawl finds, so it is not part of a view's key.
   */
  readonly outputs: readonly string[];
}

/** What a run's skill registries are built over. */
export interface RunSkillRegistriesOptions {
  /** The run's registry; every view is a view of it. */
  readonly registry: ResourceRegistry;
  /** The run's population: where every view's file list comes from. */
  readonly source: ResourcePopulationSource;
  /**
   * The run's one parse dispatcher: every parse a lane makes beside its views
   * (the packager's SKILL.md, the built-phase check) runs on it, so a run holds
   * one pool open, never one per lane.
   */
  readonly dispatcher: ParseDispatcher;
  /**
   * The include set a root's view crawls. `vat skills validate` crawls markdown
   * only (`**\/*.md`) for the one project root its batch shares, and
   * {@link REGISTRY_INCLUDE} for any other; every other lane crawls
   * {@link REGISTRY_INCLUDE} everywhere.
   */
  readonly includeFor: (root: string) => readonly string[];
  /** The config governing a root: decides collection membership and a declared `mimeType`'s parser. */
  readonly configFor: (root: string) => Promise<ProjectConfig | undefined>;
}

/**
 * One crawl: the view AND every directory the crawl was refused.
 *
 * Two callers of one root may hold different `unreadable` rulings, so the
 * refusals ride beside the view and are settled again under each caller's policy
 * on every later hit: a `'refuse'` caller throws the same refusal the crawl would
 * have thrown for it, and a `{ degrade }` caller's handler is called for each. A
 * view built under `'refuse'` carries none by construction (the crawl threw).
 */
interface CrawledView {
  readonly registry: ResourceRegistry;
  readonly refusals: readonly DirectoryRefusal[];
}

/** One run's views, one per (include set, root). */
export class RunSkillRegistries {
  /** The run's registry. */
  readonly registry: ResourceRegistry;
  /** The run's population. */
  readonly source: ResourcePopulationSource;
  /** The run's one parse dispatcher (see {@link RunSkillRegistriesOptions.dispatcher}). */
  readonly dispatcher: ParseDispatcher;
  readonly #options: RunSkillRegistriesOptions;
  readonly #views = new Map<string, Promise<CrawledView>>();

  constructor(options: RunSkillRegistriesOptions) {
    this.#options = options;
    this.registry = options.registry;
    this.source = options.source;
    this.dispatcher = options.dispatcher;
  }

  /**
   * The link-resolved view of `root`, crawled the first time this run asks and
   * served every later time.
   *
   * LEXICAL on purpose, never the real path: a registry answers `getResource` for
   * the spelling it was crawled under, so two spellings of one root are two views.
   * A view whose crawl REJECTED is not kept: its fault was classified under the
   * ruling of the caller that started it, so the next caller crawls the view
   * again under its own. The run's population keeps a refused enumeration, so a
   * later 'refuse' caller meets the same refusal without the directory being
   * listed again; a `{ degrade }` caller is listed afresh and served the readable
   * remainder.
   *
   * @param root - The project root (or, for a skill with none, its directory)
   * @param ruling - This caller's ruling
   * @returns The view, links resolved
   */
  forRoot(root: string, ruling: SkillRegistryRuling): Promise<ResourceRegistry> {
    const resolved = toForwardSlash(safePath.resolve(root));
    const include = this.#options.includeFor(resolved);
    return this.#view(`validate\0${include.join('\n')}\0${resolved}`, resolved, ruling, () => this.#crawl(resolved, include, ruling, this.#options.configFor(resolved)));
  }

  /**
   * THE packaging registry of `root` for this run: every markdown file under it
   * (`LINK_GRAPH_MEMBER_GLOBS`), links resolved, under the root's config read
   * strictly — a build refuses a config that will not parse, where validation falls
   * back. Every skill a run packages under `root` is packaged against this one
   * registry, so the whole-project crawl is paid once per run, never per skill.
   *
   * Markdown only, unlike {@link forRoot}'s `REGISTRY_INCLUDE`, and deliberately:
   * a bundled HTML file joins this registry on demand (`registerBundledAssets`),
   * and crawling every `.html` up front would parse generated output the build
   * never bundles. The packager adds those files to THIS registry, so it is never
   * shared with a validation view.
   *
   * A directory this crawl cannot list refuses the run by name: a build must not
   * ship a shorter bundle.
   *
   * @param root - The project root
   * @param outputs - What the run writes: every output, and the staging it builds them in
   * @returns The registry, links resolved
   */
  packagingRegistry(root: string, outputs: readonly string[]): Promise<ResourceRegistry> {
    const resolved = toForwardSlash(safePath.resolve(root));
    const ruling: SkillRegistryRuling = { unreadable: 'refuse', outputs };
    return this.#view(`package\0${resolved}`, resolved, ruling, () => this.#crawl(resolved, LINK_GRAPH_MEMBER_GLOBS, ruling, loadConfig(resolved)));
  }

  async #view(key: string, root: string, ruling: SkillRegistryRuling, crawlNow: () => Promise<CrawledView>): Promise<ResourceRegistry> {
    const held = this.#views.get(key);
    if (held !== undefined) {
      const crawled = await held.catch(() => undefined);
      if (crawled !== undefined) {
        replayRefusals(crawled.refusals, ruling, root);
        return crawled.registry;
      }
    }
    const crawl = crawlNow();
    this.#views.set(key, crawl);
    crawl.catch(() => {
      if (this.#views.get(key) === crawl) this.#views.delete(key);
    });
    return (await crawl).registry;
  }

  async #crawl(
    root: string,
    include: readonly string[],
    ruling: SkillRegistryRuling,
    configOf: Promise<ProjectConfig | undefined>,
  ): Promise<CrawledView> {
    const config = await configOf;
    const refusals: DirectoryRefusal[] = [];
    const { unreadable, outputs } = ruling;
    const recorded: PopulationUnreadablePolicy = unreadable === 'refuse'
      ? 'refuse'
      : { degrade: (refusal) => { refusals.push(refusal); unreadable.degrade(refusal); } };
    const registry = this.registry.view({ baseDir: root, ...(config === undefined ? {} : { config }) });
    // `skip`: no skills lane reports a directory it could not list inside ignored
    // territory (it validates skills, never the view's population conditions), so
    // a listing never walks ignored territory for them.
    await registry.crawl({ baseDir: root, include: [...include], unreadable: recorded, ignoredRefusals: 'skip', outputs, populationSource: this.source });
    registry.resolveLinks();
    return { registry, refusals };
  }
}

/**
 * Settle a served view's refusals under THIS caller's policy — see {@link CrawledView}.
 *
 * @param refusals - What the one crawl of `root` was refused
 * @param ruling - This caller's ruling
 * @param root - The crawl's root, for the refuse sentence
 */
function replayRefusals(refusals: readonly DirectoryRefusal[], ruling: SkillRegistryRuling, root: string): void {
  for (const refusal of refusals) {
    const policy: UnreadablePolicy = ruling.unreadable === 'refuse'
      ? { refuse: { root, remedy: listingRefusalRemedy(root), side: 'source' } }
      : ruling.unreadable;
    settleCrawlRefusal(policy, refusal, ruling.outputs);
  }
}

/**
 * The config governing a root, or none when it has none or it will not parse.
 *
 * A broken config falls back to config-free validation here and is reported by
 * the caller: `vat audit`, a bulk linter over trees VAT does not own, reads the
 * same config at its own layer, catches the error there and reports it, and must
 * not be aborted from four frames down. A config that will not parse gives the
 * population no declarations either, so the two still agree.
 *
 * @param root - The root
 * @returns Its config, or `undefined`
 */
export function projectConfigOrNone(root: string): Promise<ProjectConfig | undefined> {
  return loadConfig(root).catch(() => undefined);
}

/**
 * The LIBRARY run opener: run `work` with skill registries of its own, for a
 * caller outside a verb (`packageSkill` called directly through the workspace
 * skill source, a test), whose run is this call. No CLI verb uses it: every verb,
 * `vat audit` included, opens its run with the CLI's `withRunContext` and builds
 * its registries with `runSkillRegistries(run)`.
 *
 * It differs from the CLI opener on purpose, in two ways. It opens no projection
 * store: the store and its location are the CLI's, which a library caller does
 * not carry. And its config is lenient ({@link projectConfigOrNone}): a root
 * whose config will not parse populates and validates config-free, because a
 * library caller has no layer of its own that would report the broken config,
 * where the CLI opener's run refuses it.
 *
 * @param root - The run's home root
 * @param work - The run
 * @returns Whatever `work` returned
 */
export function withSkillRegistries<T>(root: string, work: (registries: RunSkillRegistries) => Promise<T>): Promise<T> {
  const resolved = safePath.resolve(root);
  const gitTracker = new GitTracker(resolved);
  return withRunPopulation(
    {
      root: resolved,
      // No store, so no stored-document question opens a home population: what
      // each packaging crawl writes is passed to that crawl.
      outputs: [],
      gitTracker,
      cacheOf: () => Promise.resolve(undefined),
      questionCacheOf: () => Promise.resolve(undefined),
      holdsStore: false,
      collectionsFor: async (enumerated) => (await projectConfigOrNone(enumerated))?.resources?.collections,
      onHomeSettled: IGNORE_HOME_SETTLEMENT,
    },
    (population) => work(new RunSkillRegistries({
      registry: ResourceRegistry.forRun(population, { baseDir: resolved, gitTracker }),
      source: population.source,
      dispatcher: population.dispatcher,
      includeFor: () => REGISTRY_INCLUDE,
      configFor: projectConfigOrNone,
    })),
  );
}
