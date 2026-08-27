import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import {
  findProjectRoot,
  mkdirSyncReal,
  normalizedTmpdir,
  safePath,
} from '@vibe-agent-toolkit/utils';
// The two namespace types are type-only, purely so each mock factory can spread
// its real module without an inline `typeof import()` annotation, which this
// repo's lint forbids.
import type * as UtilsCrawlModule from '@vibe-agent-toolkit/utils/crawl';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import type * as UtilsGitModule from '@vibe-agent-toolkit/utils/git';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `vat inventory` and `vat audit` must each crawl the surrounding project's markdown
 * corpus ONCE per invocation, not once per skill — and neither may let a failed crawl
 * abort the command.
 *
 * Both lanes reach the same extractor (`extractClaudePluginInventory`) through their own
 * shared-registry plumbing (`linkRegistryProviderFor` in inventory.ts,
 * `pluginInventoryAt` in audit.ts), so both can get the same two things wrong: resolving
 * the registry OUTSIDE the extractor's try/catch (turning a degradable failure into a
 * fatal one), and building a registry at a root no skill will match (pure wasted crawl).
 * The two lanes are exercised here from one set of fixtures — the mock and the plugin
 * trees below are the expensive part, and this repo does not tolerate duplicating them.
 *
 * `extractClaudeSkillInventory` falls back to `crawlSkillLinkRegistry(projectRoot)`
 * whenever the caller hands it no registry rooted at exactly that project root —
 * and that crawl parses EVERY markdown document under the root. `extractClaudePluginInventory`
 * threads an optional `sharedRegistry` down to every per-skill extraction precisely so
 * one crawl can serve them all, but `routeInventory` never built one, so an N-skill
 * plugin paid N full-project crawls: a flat per-skill cost that tracks the size of the
 * surrounding project, not the subject. Measured on a ~1,041-document monorepo as a
 * controlled before/after pair: a 19-skill plugin took 3m45s and now takes 12.6s
 * (~11.9s per skill before, flat — the same ~12s a single SKILL.md costs on its own).
 *
 * Counting the crawls (rather than timing them) is also the proof the registry is
 * actually HIT: reuse is gated on `resolve(registry.baseDir) === resolve(projectRoot)`,
 * so a registry built against the wrong root is silently ignored and would show up
 * here as N+1 crawls, not 1.
 */
const crawlBaseDirs = vi.hoisted(() => [] as string[]);

/**
 * Roots whose crawl the mock below makes fail.
 *
 * A corpus crawl really can fail — one unreadable markdown file anywhere under the
 * root is enough (QA reproduced it with `chmod 000`). Injecting the failure here
 * rather than through file permissions keeps the test portable and meaningful when
 * the suite runs as root, where `chmod 000` does not stop a read.
 */
const failingCrawlRoots = vi.hoisted(() => [] as string[]);
const CRAWL_FAILURE_MESSAGE = vi.hoisted(() => 'simulated corpus crawl failure');

/**
 * Every path the link walk asked `git check-ignore` about, in order.
 *
 * `walkLinkGraph`'s `readGitignored` calls `isGitIgnored` — one subprocess per
 * distinct link target — whenever it holds no `GitTracker`. Only consumers that
 * import the `@vibe-agent-toolkit/utils/git` MODULE ID are intercepted here; a
 * mock is keyed on the specifier, not on the package.
 *
 * ⚠️ **Read what that does and does not buy you, because the obvious reading is
 * wrong.** `GitTracker` reaches `isGitIgnored` through a relative intra-package
 * import, so this mock **cannot see** the tracker's own fallback. That makes the
 * counter BLIND to those spawns — it is not evidence they did not happen, and an
 * earlier version of this comment claimed exactly that.
 *
 * A zero here is still sound, but for a stronger reason that has nothing to do
 * with the mock's reach: **the tracker's two spawning fallbacks are both
 * unreachable from this lane.** `classifyGitignored` (`walk-link-graph.ts`) is
 * gated on `facts.exists`, so the `!existsSync` fallback never fires; and
 * `classifyExclusion` returns `outside-project` before the gitignore branch, so
 * the outside-root fallback never fires either. In-project ⊆ in-repo, because
 * the tracker's root is `gitFindRoot(projectRoot)`, always an ancestor of
 * `projectRoot`. State the guarantee, not the mock's coverage.
 */
const gitIgnoreQueries = vi.hoisted(() => [] as string[]);

// TWO mocks, because the two intercepted functions live on two module ids.
// `safePath` is deliberately taken from the unmocked `.` barrel above rather
// than off either factory's `actual`: it is the real implementation on every
// route, and reaching for it through a mocked module is what breaks when a
// symbol later moves again.
vi.mock('@vibe-agent-toolkit/utils/crawl', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilsCrawlModule>();
  return {
    ...actual,
    crawlDirectory: async (options: Parameters<typeof actual.crawlDirectory>[0]) => {
      crawlBaseDirs.push(options.baseDir);
      const base = safePath.resolve(options.baseDir);
      if (failingCrawlRoots.some((dir) => safePath.resolve(dir) === base)) {
        throw new Error(CRAWL_FAILURE_MESSAGE);
      }
      return actual.crawlDirectory(options);
    },
  };
});

vi.mock('@vibe-agent-toolkit/utils/git', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilsGitModule>();
  return {
    ...actual,
    isGitIgnored: (filePath: string, cwd?: string) => {
      gitIgnoreQueries.push(filePath);
      return cwd === undefined ? actual.isGitIgnored(filePath) : actual.isGitIgnored(filePath, cwd);
    },
  };
});

const { routeInventory } = await import('../../src/commands/inventory.js');
const { buildAuditReport, resetAuditCaches } = await import('../../src/commands/audit.js');
const { gitTrackerForProjectRoot, resetGitTrackerCache } = await import(
  '../../src/commands/audit/distributed-tree.js'
);
const { extractClaudePluginInventory, NO_GIT_TRACKER } = await import(
  '@vibe-agent-toolkit/claude-marketplace'
);
const { silentLogger } = await import('../test-helpers.js');

const SKILL_NAMES = ['alpha', 'beta', 'gamma'];

/** The inventory shape these tests read; `routeInventory` returns the union of all kinds. */
interface SkillInventoryShape {
  files: { linked: string[] };
  parseErrors: { path: string; message: string }[];
}
interface PluginInventoryShape {
  discovered: { skills: SkillInventoryShape[]; commands: unknown[]; agents: unknown[] };
  parseErrors: { path: string; message: string }[];
}

/** Write a file, creating its parent directory. */
function writeFixtureFile(absolutePath: string, content: string): void {
  mkdirSyncReal(safePath.join(absolutePath, '..'), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture setup, temp directory
  writeFileSync(absolutePath, content, 'utf8');
}

/** The file that anchors `findProjectRoot` at `dir` deterministically (no `.git` needed). */
const PROJECT_CONFIG_FILE = 'vibe-agent-toolkit.config.yaml';

/** Anchor `findProjectRoot` at `dir`. */
function writeProjectConfig(dir: string): void {
  writeFixtureFile(safePath.join(dir, PROJECT_CONFIG_FILE), 'version: 1\n');
}

/** A plugin manifest plus one skill per {@link SKILL_NAMES}, each linking one sibling doc. */
function writeSkillPlugin(pluginDir: string, pluginName: string): void {
  writeFixtureFile(
    safePath.join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: pluginName, version: '1.0.0' }),
  );
  for (const name of SKILL_NAMES) {
    writeFixtureFile(
      safePath.join(pluginDir, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Fixture skill ${name}\n---\n\nSee [reference](./reference.md).\n`,
    );
    writeFixtureFile(safePath.join(pluginDir, 'skills', name, 'reference.md'), `# ${name} reference\n`);
  }
}

/** Every message across the inventory's own parseErrors, joined for substring assertions. */
function messagesOf(parseErrors: { message: string }[]): string {
  return parseErrors.map((e) => e.message).join('\n');
}

/**
 * Audit `dir` in-process from a clean slate, returning the validation results.
 *
 * `buildAuditReport` is exported `@internal` for exactly this. The cache reset is not
 * optional: audit memoizes inventory registries (and git trackers) at module scope, so
 * a leftover registry from a sibling test would make the crawl counts below lie.
 */
async function auditPlugin(dir: string): Promise<unknown[]> {
  resetAuditCaches();
  crawlBaseDirs.length = 0;
  const { results } = await buildAuditReport(dir, {}, Date.now(), silentLogger as never);
  return results;
}

/** The link targets under `root` that the walk asked git about directly. */
function linkTargetQueries(root: string): string[] {
  const base = safePath.resolve(root);
  return gitIgnoreQueries
    .map((queried) => safePath.resolve(queried))
    .filter((queried) => queried.startsWith(`${base}/`) && queried.endsWith('/reference.md'));
}

/** Every skill in a plugin inventory still resolved its one linked reference. */
function expectLinksFound(inventory: PluginInventoryShape): void {
  expect(inventory.discovered.skills).toHaveLength(SKILL_NAMES.length);
  for (const skill of inventory.discovered.skills) {
    expect(skill.files.linked).toHaveLength(1);
  }
}

describe('shared link registry — one corpus crawl per invocation', () => {
  let projectRoot: string;
  let pluginDir: string;
  let skilllessPluginDir: string;
  let rootlessRoot: string;
  let rootlessPluginDir: string;

  beforeAll(() => {
    projectRoot = safePath.resolve(
      mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-inv-registry-')),
    );
    writeProjectConfig(projectRoot);
    // Corpus documents outside the plugin — the cost a per-skill crawl re-pays.
    for (const doc of ['one', 'two', 'three']) {
      writeFixtureFile(safePath.join(projectRoot, 'docs', `${doc}.md`), `# ${doc}\n`);
    }

    pluginDir = safePath.join(projectRoot, 'plugins', 'demo');
    writeSkillPlugin(pluginDir, 'demo');

    // A plugin that ships only commands/ and agents/ — no skills/, no root SKILL.md.
    // Nothing in it can consult a link registry, so it must crawl nothing.
    skilllessPluginDir = safePath.join(projectRoot, 'plugins', 'commands-only');
    writeFixtureFile(
      safePath.join(skilllessPluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'commands-only', version: '1.0.0' }),
    );
    writeFixtureFile(
      safePath.join(skilllessPluginDir, 'commands', 'deploy.md'),
      '# deploy\n\nSee [notes](./notes.md).\n',
    );
    writeFixtureFile(safePath.join(skilllessPluginDir, 'agents', 'reviewer.md'), '# reviewer\n');

    // Deliberately NO config file and NO .git anywhere at or above the plugin: the
    // case where `findProjectRoot` returns null. A separate mkdtemp root, so the
    // config file above cannot be an ancestor of it.
    rootlessRoot = safePath.resolve(
      mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-inv-rootless-')),
    );
    rootlessPluginDir = safePath.join(rootlessRoot, 'plugins', 'demo');
    writeSkillPlugin(rootlessPluginDir, 'rootless-demo');
  });

  afterAll(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(rootlessRoot, { recursive: true, force: true });
  });

  it('crawls the project corpus once for a plugin with N skills, not N times', async () => {
    crawlBaseDirs.length = 0;

    const inventory = (await routeInventory(pluginDir, {})) as unknown as PluginInventoryShape;

    // The work still happens: every skill is discovered and its link graph walked.
    const skills = inventory.discovered.skills;
    expect(skills).toHaveLength(SKILL_NAMES.length);
    for (const skill of skills) {
      expect(skill.files.linked).toHaveLength(1);
    }

    const rootCrawls = crawlBaseDirs.filter((dir) => safePath.resolve(dir) === projectRoot);
    expect(rootCrawls).toHaveLength(1);
    expect(crawlBaseDirs).toHaveLength(1);
  });

  it('crawls nothing for a plugin with commands and agents but no skills', async () => {
    crawlBaseDirs.length = 0;

    const inventory = (await routeInventory(
      skilllessPluginDir,
      {},
    )) as unknown as PluginInventoryShape;

    // The plugin is really inventoried — the zero crawls are not zero work.
    const discovered = inventory.discovered;
    expect(discovered.skills).toHaveLength(0);
    expect(discovered.commands).toHaveLength(1);
    expect(discovered.agents).toHaveLength(1);

    // No skill means no link walk means no registry. Building one eagerly costs a
    // full corpus crawl (~12s on a ~1,041-document monorepo) for nothing.
    expect(crawlBaseDirs).toHaveLength(0);
  });

  describe('a failed corpus crawl degrades to parseErrors, it does not abort the inventory', () => {
    // `extractClaudePluginInventory` documents "never throws — all failures surface via
    // parseErrors[]". That held while the crawl lived inside `walkLinkedFiles`'s try/catch.
    // Resolving the shared registry outside that catch broke it: one unreadable markdown
    // file anywhere under the root turned a full inventory into `Inventory failed: EACCES`.
    beforeAll(() => {
      failingCrawlRoots.push(projectRoot);
    });
    afterAll(() => {
      failingCrawlRoots.length = 0;
    });

    it('returns the plugin inventory, one parseError per skill, and attempts each lane once', async () => {
      crawlBaseDirs.length = 0;

      const inventory = (await routeInventory(pluginDir, {})) as unknown as PluginInventoryShape;

      // Everything that does not depend on the corpus is still reported.
      const skills = inventory.discovered.skills;
      expect(skills).toHaveLength(SKILL_NAMES.length);
      for (const skill of skills) {
        // The link walk is the only casualty: no linked files, and the skill says why.
        expect(skill.files.linked).toHaveLength(0);
        expect(messagesOf(skill.parseErrors)).toContain(CRAWL_FAILURE_MESSAGE);
      }
      // Reported per skill, not once per plugin: a parseError is keyed by `path`, and the
      // thing degraded is each skill's `files.linked`. A single plugin-level entry would
      // leave three empty link lists unexplained.
      const crawlErrors = inventory.parseErrors.filter((e) =>
        e.message.includes(CRAWL_FAILURE_MESSAGE),
      );
      expect(crawlErrors).toHaveLength(SKILL_NAMES.length);

      // Reported N times, ATTEMPTED once PER LANE — the memoized provider hands every
      // skill the same rejected promise instead of re-crawling a corpus that just failed.
      //
      // Two, not one, since `vat inventory` began defaulting to the projection: this is
      // the FAILURE path, so the projection's own corpus crawl fails and the extractor
      // then degrades to the link walk, which builds the registry and fails too. One
      // attempt each. The success-path test above still sees exactly ONE crawl, and the
      // asymmetry is the whole mechanism — when the projection answers, it short-circuits
      // `walkLinkedFiles` before `registryFor` is ever reached, so no registry is built.
      //
      // ⚠️ The number this pins is "per LANE", never "per skill". With three skills an
      // N+1 regression in either lane reads 3 or 4 here, so this assertion still fails
      // exactly as it was written to — do not relax it to a lower bound.
      expect(crawlBaseDirs).toHaveLength(2);
    });

    it('returns the single-SKILL.md inventory with the failure in parseErrors', async () => {
      crawlBaseDirs.length = 0;

      const skillMd = safePath.join(pluginDir, 'skills', 'alpha', 'SKILL.md');
      const inventory = (await routeInventory(skillMd, {})) as unknown as SkillInventoryShape;

      expect(inventory.files.linked).toHaveLength(0);
      expect(messagesOf(inventory.parseErrors)).toContain(CRAWL_FAILURE_MESSAGE);
    });
  });

  it('crawls once per skill, never at the plugin dir, when there is no project root', async () => {
    // The premise: no config and no .git at or above the plugin.
    expect(findProjectRoot(rootlessPluginDir)).toBeNull();
    crawlBaseDirs.length = 0;

    const inventory = (await routeInventory(
      rootlessPluginDir,
      {},
    )) as unknown as PluginInventoryShape;

    const skills = inventory.discovered.skills;
    expect(skills).toHaveLength(SKILL_NAMES.length);
    for (const skill of skills) {
      expect(skill.files.linked).toHaveLength(1);
    }

    // The correct count is 3 — one per skill, each scoped to that skill's OWN directory.
    // With no project root the extractor falls back to `dirname(SKILL.md)`, so no single
    // shared root can serve all three: a plugin-rooted registry answers a different
    // question and is discarded by the `baseDir === projectRoot` gate. Building one
    // anyway is pure added cost (QA: 863ms -> 1308ms, 1.5x SLOWER than no sharing at all),
    // so the count must be 3, not 4.
    const byPath = (a: string, b: string): number => a.localeCompare(b);
    const crawled = crawlBaseDirs.map((dir) => safePath.resolve(dir)).sort(byPath);
    expect(crawled.filter((dir) => dir === safePath.resolve(rootlessPluginDir))).toHaveLength(0);
    expect(crawled).toEqual(
      SKILL_NAMES.map((name) => safePath.join(rootlessPluginDir, 'skills', name)).sort(byPath),
    );
    expect(crawlBaseDirs).toHaveLength(SKILL_NAMES.length);
  });

  /**
   * `vat audit` reaches the same extractor through `pluginInventoryAt`. Its plumbing is
   * separate from `routeInventory`'s, so it needs its own proof of the same two properties.
   */
  describe('buildAuditReport — the audit lane', () => {
    it('crawls the project corpus once for a plugin with N skills, not N times', async () => {
      const results = await auditPlugin(pluginDir);

      // The plugin and each of its skills are really audited.
      expect(results.length).toBeGreaterThanOrEqual(SKILL_NAMES.length + 1);

      const rootCrawls = crawlBaseDirs.filter((dir) => safePath.resolve(dir) === projectRoot);
      expect(rootCrawls).toHaveLength(1);
    });

    describe('a failed corpus crawl degrades to findings, it does not abort the audit', () => {
      // The bug: `pluginInventoryAt` awaited the shared registry OUTSIDE
      // `walkLinkedFiles`'s try/catch, so one unreadable markdown file anywhere under
      // the root turned a full audit into `status: error` / exit code 2 with a bare
      // EACCES message and not a single finding.
      beforeAll(() => {
        failingCrawlRoots.push(projectRoot);
      });
      afterAll(() => {
        failingCrawlRoots.length = 0;
      });

      it('resolves with the plugin report instead of rejecting', async () => {
        const results = await auditPlugin(pluginDir);

        // Everything that does not depend on the corpus is still reported: the plugin
        // result plus one per skill. A crawl failure costs `files.linked`, not the audit.
        expect(results.length).toBeGreaterThanOrEqual(SKILL_NAMES.length + 1);
      });

      it('attempts the failing crawl once, not once per skill', async () => {
        await auditPlugin(pluginDir);

        // Reported per skill, ATTEMPTED once — the memoized provider hands every skill
        // the same rejected promise instead of re-crawling a corpus that just failed.
        const rootCrawls = crawlBaseDirs.filter((dir) => safePath.resolve(dir) === projectRoot);
        expect(rootCrawls).toHaveLength(1);
        expect(crawlBaseDirs).toHaveLength(1);
      });
    });

    it('never crawls at the plugin dir when there is no project root', async () => {
      // The premise: no config and no .git at or above the plugin.
      expect(findProjectRoot(rootlessPluginDir)).toBeNull();

      await auditPlugin(rootlessPluginDir);

      // `findProjectRoot(dir) ?? dir` would root the shared registry at the PLUGIN, a
      // root `walkLinkedFiles` never derives (it falls back to `dirname(SKILL.md)`), so
      // the `baseDir === projectRoot` gate discards it and every skill re-crawls anyway.
      // The crawl is therefore pure waste — it must not happen at all.
      const crawled = crawlBaseDirs.map((dir) => safePath.resolve(dir));
      expect(crawled.filter((dir) => dir === safePath.resolve(rootlessPluginDir))).toHaveLength(0);
      expect(new Set(crawled)).toEqual(
        new Set(SKILL_NAMES.map((name) => safePath.join(rootlessPluginDir, 'skills', name))),
      );
    });
  });
});

/**
 * `walkLinkGraph` asks "is this link target gitignored?" once per distinct target, and with
 * no {@link GitTracker} each question is a `git check-ignore` subprocess. Deep-frame stack
 * attribution of a `vat audit` run over a 1,484-document adopter monorepo put **786 of 786**
 * such spawns in this one lane — the inventory extractors were the only `walkLinkGraph` call
 * site passing no tracker — costing 9,242 ms of a 16,295 ms command. One
 * `GitTracker.initialize()` plus the same 785 active-set lookups cost 147 ms + 1 ms and
 * disagreed with the subprocess on nothing.
 *
 * Both CLI lanes therefore hand the extractors `gitTrackerForProjectRoot`, and all three
 * call sites are pinned below. They need a REAL repository to be pinnable at all:
 * `isGitIgnored` settles "is there a repository here?" from the filesystem and returns
 * `false` with zero spawns outside one, so the `mkdtemp` fixtures above cannot tell a wired
 * lane from an unwired one — which is what the control case exists to demonstrate.
 *
 * Two-sided on purpose. Zero queries alone would also be satisfied by a tracker that called
 * everything ignored — a live failure mode, since a path inside the project root but absent
 * from the active set reads as ignored — and that would silently empty `files.linked`. So
 * every case asserts the links are still found.
 */
describe('git tracker source — the link walk stops spawning `git check-ignore` per target', () => {
  let gitRoot: string;
  let gitPluginDir: string;

  beforeAll(() => {
    gitRoot = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-inv-git-')));
    // No commit needed: the active set comes from `git ls-files --cached --others
    // --exclude-standard`, which already reports untracked-but-not-ignored files.
    runGitOrThrow(['init', '-q'], { cwd: gitRoot });
    writeProjectConfig(gitRoot);
    gitPluginDir = safePath.join(gitRoot, 'plugins', 'demo');
    writeSkillPlugin(gitPluginDir, 'git-demo');
  });

  afterAll(() => {
    rmSync(gitRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetGitTrackerCache();
    gitIgnoreQueries.length = 0;
  });

  it('spawns check-ignore per link target when the tracker-less walk is CHOSEN — the control', async () => {
    // The extractor doing what the CLI's call did BEFORE this wiring. Without this
    // case the zeros below are unfalsifiable: they would also hold for a fixture the
    // counter can never see.
    //
    // `NO_GIT_TRACKER`, not an omitted argument. This case used to omit the source
    // entirely, and that made it two claims at once — "this lane spawns per target"
    // and "a caller can reach that lane by forgetting something". The second is no
    // longer true anywhere in the product, and pinning it here would have kept a
    // dead shape alive in the one test whose job is to be the honest control.
    const inventory = (await extractClaudePluginInventory(gitPluginDir, {
      gitTrackerSource: NO_GIT_TRACKER,
    })) as unknown as PluginInventoryShape;

    expectLinksFound(inventory);
    expect(linkTargetQueries(gitRoot).length).toBeGreaterThan(0);
  });

  it('asks git nothing about link targets in the audit lane', async () => {
    // `pluginInventoryAt` — the call site that carried all 786 measured spawns.
    const results = await auditPlugin(gitPluginDir);
    expect(results.length).toBeGreaterThanOrEqual(SKILL_NAMES.length + 1);

    expect(linkTargetQueries(gitRoot)).toEqual([]);
  });

  it('asks git nothing about link targets in the `vat inventory` plugin lane', async () => {
    const inventory = (await routeInventory(gitPluginDir, {})) as unknown as PluginInventoryShape;

    expectLinksFound(inventory);
    expect(linkTargetQueries(gitRoot)).toEqual([]);
  });

  it('asks git nothing about link targets in the `vat inventory` single-SKILL.md lane', async () => {
    const skillMd = safePath.join(gitPluginDir, 'skills', 'alpha', 'SKILL.md');
    const inventory = (await routeInventory(skillMd, {})) as unknown as SkillInventoryShape;

    // One skill still benefits: the saving is per LINK TARGET, not per skill.
    expect(inventory.files.linked).toHaveLength(1);
    expect(linkTargetQueries(gitRoot)).toEqual([]);
  });

  it('keys the shared cache on the GIT root, so nested project roots share one tracker', async () => {
    // The extractors call the source with each skill's own project root — anchored by a
    // config file or a `.git`, so usually a SUBDIRECTORY of the repository and a different
    // one per skill. Keyed on that root rather than on the repository, an N-skill monorepo
    // would pay N `git ls-files` for one repo's answer.
    writeProjectConfig(gitPluginDir);

    const fromNested = await gitTrackerForProjectRoot(gitPluginDir);
    const fromRepoRoot = await gitTrackerForProjectRoot(gitRoot);

    expect(fromNested).toBeDefined();
    // Same OBJECT, not merely an equal one: two trackers would be two `git ls-files`.
    expect(fromNested).toBe(fromRepoRoot);

    rmSync(safePath.join(gitPluginDir, PROJECT_CONFIG_FILE), { force: true });
  });

  it('answers undefined outside a repository, where there is nothing to win', async () => {
    // `isGitIgnored` already returns `false` with zero spawns when `gitFindRoot` finds no
    // repository, so a tracker there would be cost without benefit.
    //
    // ⚠️ Not "because a non-repository tracker would call every path ignored" — that was
    // written here and is INVERTED. Measured: `gitLsFiles` returns null ⇒
    // `activeSetPopulated` stays false ⇒ `isIgnoredByActiveSet` delegates to `isIgnored`
    // ⇒ `isGitIgnored` ⇒ `gitFindRoot === null` ⇒ **false**. Such a tracker calls every
    // path NOT ignored, i.e. it degrades to exactly the pre-change behaviour. That makes
    // the no-repository case safe rather than dangerous; returning `undefined` here is a
    // cost decision, not a correctness one.
    const outside = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-inv-nogit-')));
    try {
      expect(await gitTrackerForProjectRoot(outside)).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
