/**
 * One run's skill registries: a view of the run's registry per project root a
 * skill resolves to, crawled once per run.
 *
 * Skills are validated against the registry of their project root, and one run
 * can reach several roots (a nested project with its own config, a skill with no
 * project root). Each root gets ONE view of the run's registry
 * (`ResourceRegistry.view`), crawled under that root's own config: the id,
 * duplicates, links, population conditions and parse refusals are the view's
 * own, while the read, key, parse and stat of every file are the run's (see
 * `RunPopulation` in `@vibe-agent-toolkit/resources`). There is no process-wide
 * memo: the views live exactly as long as the run that holds this.
 *
 * Every view crawls under `'refuse'`: the verbs that validate through a run
 * (`vat validate`, `vat verify`, `vat skills validate`) act on the registry as a
 * complete population, so a directory a crawl cannot list stops the run by name.
 */

import type { ProjectConfig, ResourcePopulationSource, ResourceRegistry } from '@vibe-agent-toolkit/resources';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

/** What a run's skill registries are built over. */
export interface RunSkillRegistriesOptions {
  /** The run's registry; every view is a view of it. */
  readonly registry: ResourceRegistry;
  /**
   * The run's population source, or `undefined` when the run walks
   * (`VAT_RESOURCES_CRAWL=walk`). It is bound to the run's home root, so a
   * view of any other root walks (handing it the source would only have the
   * crawl decline it, with a warning).
   */
  readonly source: ResourcePopulationSource | undefined;
  /**
   * The include set a root's view crawls. `vat skills validate` crawls markdown
   * only (`**\/*.md`) for the one project root its batch shares, and markdown
   * plus HTML for any other.
   */
  readonly includeFor: (root: string) => readonly string[];
  /** The config governing a root: decides collection membership and a declared `mimeType`'s parser. */
  readonly configFor: (root: string) => Promise<ProjectConfig | undefined>;
}

/** One run's views, one per (include set, root). */
export class RunSkillRegistries {
  readonly #options: RunSkillRegistriesOptions;
  readonly #views = new Map<string, Promise<ResourceRegistry>>();

  constructor(options: RunSkillRegistriesOptions) {
    this.#options = options;
  }

  /**
   * The link-resolved view of `root`, crawled the first time this run asks and
   * served every later time.
   *
   * LEXICAL on purpose, never the real path: a registry answers `getResource` for
   * the spelling it was crawled under, so two spellings of one root are two views.
   * A crawl that REJECTED is not served again: the next caller crawls again.
   *
   * @param root - The project root (or, for a skill with none, its directory)
   * @param outputs - What the calling verb writes, `[]` for a verb that only reads
   * @returns The view, links resolved
   */
  forRoot(root: string, outputs: readonly string[]): Promise<ResourceRegistry> {
    const resolved = toForwardSlash(safePath.resolve(root));
    const include = this.#options.includeFor(resolved);
    const key = `${include.join('\n')}\0${resolved}`;
    const held = this.#views.get(key);
    if (held !== undefined) return held;
    const crawl = this.#crawl(resolved, include, outputs);
    this.#views.set(key, crawl);
    crawl.catch(() => {
      if (this.#views.get(key) === crawl) this.#views.delete(key);
    });
    return crawl;
  }

  async #crawl(root: string, include: readonly string[], outputs: readonly string[]): Promise<ResourceRegistry> {
    const { registry, source, configFor } = this.#options;
    const config = await configFor(root);
    const homeSource = source !== undefined && toForwardSlash(safePath.resolve(source.root)) === root ? source : undefined;
    const view = registry.view({ baseDir: root, ...(config === undefined ? {} : { config }) });
    await view.crawl({
      baseDir: root,
      include: [...include],
      unreadable: 'refuse',
      outputs,
      ...(homeSource !== undefined && { populationSource: homeSource }),
    });
    view.resolveLinks();
    return view;
  }
}
