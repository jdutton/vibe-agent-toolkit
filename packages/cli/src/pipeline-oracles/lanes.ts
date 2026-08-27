/**
 * The five corpus enumerations VAT actually performs.
 *
 * Each lane names the **real, exported builder** its production path calls —
 * never a copy of it. A lane also restates the crawl it performs declaratively,
 * so the pre-deduplication ordered list is observable; that restatement is a
 * copy and therefore a drift risk, which is why every snapshot reconciles the
 * two and reports disagreement as {@link EnumerationSnapshot.restatementDrift}
 * rather than trusting either.
 *
 * The divergences between these lanes are the point, not an accident to be
 * smoothed over here. `resources` is the only lane with the full markdown+HTML
 * include set that also applies the project's `include`/`exclude`; `audit` is
 * memoized per root; `inventory` is the only one that asks git for untracked
 * files.
 *
 * What is NO LONGER a divergence, and must not become one again: **whether a
 * lane sees the project's config.** All five do. A collection's declared
 * `mimeType` decides which parser runs, so a config-less lane reaches a
 * different verdict about whether a file is prose than the projection that
 * enumerated it — inside one command. `test/collection-mime-lane-agreement.test.ts`
 * holds every lane to the projection's verdict.
 */

import { crawlAndResolveRegistry, createProjectRegistry } from '@vibe-agent-toolkit/agent-skills';
import { crawlSkillLinkRegistry } from '@vibe-agent-toolkit/claude-marketplace';
import { DEFAULT_RESOURCE_INCLUDE, type ResourceRegistry } from '@vibe-agent-toolkit/resources';
import type { CrawlOptions } from '@vibe-agent-toolkit/utils/crawl';

import { buildSkillsValidateRegistry } from '../commands/skills/validate.js';
import { loadConfig } from '../utils/config-loader.js';
import { createLogger } from '../utils/logger.js';
import { loadResourcesWithConfig } from '../utils/resource-loader.js';

import type { LaneId } from './types.js';

/** Markdown-only, the include set three of the five lanes hardcode. */
const MARKDOWN_ONLY: readonly string[] = ['**/*.md'];

/** Markdown + HTML, the set the two config-agnostic wide lanes use. */
const MARKDOWN_AND_HTML: readonly string[] = ['**/*.md', '**/*.html', '**/*.htm'];

/**
 * `ResourceRegistry.crawl`'s own exclude default, restated.
 *
 * Note it is NOT `crawlDirectory`'s default (`NEVER_CRAWL_GLOBS` +
 * `BUILD_OUTPUT_GLOBS`): the registry passes its own narrower list, which omits
 * the worktree globs. That difference is real and is one of the things a
 * snapshot exists to hold still, so it is restated here rather than imported
 * from the wider constant.
 */
const REGISTRY_DEFAULT_EXCLUDE: readonly string[] = ['**/node_modules/**', '**/.git/**', '**/dist/**'];

/** One enumerating lane: how it crawls, and who really does it. */
export interface LaneDefinition {
  id: LaneId;
  /** One line naming the command(s) this lane serves. */
  description: string;
  /**
   * Restatement of the crawl this lane performs. Used to observe the ordered,
   * pre-deduplication path list, which the registry does not retain. Reconciled
   * against {@link build} on every snapshot.
   */
  crawlOptions: (projectRoot: string) => CrawlOptions;
  /** The production builder. Called as-is; never reimplemented. */
  build: (projectRoot: string) => Promise<ResourceRegistry>;
}

/**
 * All five lanes, in a stable order.
 *
 * @returns The lane definitions, frozen
 */
export const LANES: readonly LaneDefinition[] = Object.freeze([
  {
    id: 'resources',
    description: '`vat resources scan` / `validate` — config-aware, md+html+htm',
    crawlOptions: (projectRoot) => {
      const config = loadConfig(projectRoot);
      return {
        baseDir: projectRoot,
        include: config?.resources?.include ?? [...DEFAULT_RESOURCE_INCLUDE],
        // ResourceRegistry.crawl's own default when config supplies none.
        exclude: config?.resources?.exclude ?? [...REGISTRY_DEFAULT_EXCLUDE],
        absolute: true,
        filesOnly: true,
      };
    },
    build: async (projectRoot) => {
      const loaded = await loadResourcesWithConfig(undefined, projectRoot, createLogger());
      return loaded.registry;
    },
  },
  {
    id: 'audit',
    description: '`vat audit` and post-build validation — config-aware per root, memoized per root',
    crawlOptions: (projectRoot) => ({
      baseDir: projectRoot,
      include: [...MARKDOWN_AND_HTML],
      exclude: [...REGISTRY_DEFAULT_EXCLUDE],
      absolute: true,
      filesOnly: true,
    }),
    build: async (projectRoot) => crawlAndResolveRegistry(projectRoot),
  },
  {
    id: 'skills-build',
    description: '`vat skills build` via createProjectRegistry — config-aware but markdown-only',
    crawlOptions: (projectRoot) => ({
      baseDir: projectRoot,
      include: [...MARKDOWN_ONLY],
      exclude: [...REGISTRY_DEFAULT_EXCLUDE],
      absolute: true,
      filesOnly: true,
    }),
    build: async (projectRoot) => createProjectRegistry(projectRoot),
  },
  {
    id: 'inventory',
    description: '`vat inventory` — markdown-only, the only lane that includes untracked files',
    crawlOptions: (projectRoot) => ({
      baseDir: projectRoot,
      include: [...MARKDOWN_ONLY],
      absolute: true,
      filesOnly: true,
      includeUntracked: true,
    }),
    build: async (projectRoot) => crawlSkillLinkRegistry(projectRoot),
  },
  {
    id: 'skills-validate',
    description: '`vat skills validate` — batch-scoped shared registry, markdown-only, config-aware',
    crawlOptions: (projectRoot) => ({
      baseDir: projectRoot,
      include: [...MARKDOWN_ONLY],
      exclude: [...REGISTRY_DEFAULT_EXCLUDE],
      absolute: true,
      filesOnly: true,
    }),
    // The REAL builder, like every other lane. It used to be restated inline
    // here because `commands/skills/validate.ts` built its registry inline too,
    // and this file recorded that as "the one lane with no reusable builder to
    // point at". The restatement then quietly outlived its subject: the command
    // learned to route parsing through the project's declared collection
    // `mimeType`s and this copy did not, so the oracle described a lane nobody
    // runs. Naming the builder is what makes that class of drift impossible.
    build: async (projectRoot) => buildSkillsValidateRegistry(projectRoot, {
      config: loadConfig(projectRoot),
    }),
  },
]);

/**
 * Look a lane up by id.
 *
 * @param id - Lane identifier
 * @returns The lane definition
 * @throws Error when the id is not one of the five
 */
export function laneById(id: LaneId): LaneDefinition {
  const lane = LANES.find((candidate) => candidate.id === id);
  if (lane === undefined) {
    throw new Error(`Unknown lane: ${id}`);
  }
  return lane;
}
