import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { type ResourcePopulationSource, ResourceRegistry } from '@vibe-agent-toolkit/resources';
import {
  createSymlink,
  FS_FAULT_CODE,
  mkdirSyncReal,
  normalizedTmpdir,
  safePath,
  symlinkCapability,
} from '@vibe-agent-toolkit/utils';
import { gitExecutable, withReaddirSyncRefused } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  crawlAndResolveRegistry,
  resetPackagingRegistryCache,
  validateSkillForPackaging,
} from '../../src/validators/packaging-validator.js';
import { createSkillContent, createTransitiveSkillStructure } from '../test-helpers.js';

/**
 * Building this registry parses EVERY markdown and HTML document under the
 * project root. On a 1039-document monorepo that is ~12 seconds, and the
 * packager's post-build validation calls it once per skill — so a 46-skill
 * plugin build paid it 46 times, a fixed per-skill cost independent of the
 * skill's own size. Both build phases hit it: `vat skills build` and
 * `vat claude plugin build` each share their PACKAGING registry, then every
 * `packageSkill` re-crawls the project for post-build validation anyway.
 *
 * The memo lives here, next to the crawl, rather than in each caller: `vat audit`
 * had already solved this with its own private cache keyed on a project-root
 * string it had to derive the same way the validator does — its own comment warns
 * that "a mismatched key silently degrades back to a per-skill crawl". Keying on
 * the RESOLVED path in one place removes both the duplication and that trap.
 */
describe('crawlAndResolveRegistry — memoized per project root', () => {
  let rootA: string;
  let rootB: string;

  beforeAll(() => {
    rootA = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-registry-memo-a-'));
    rootB = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-registry-memo-b-'));
    writeFileSync(safePath.join(rootA, 'a.md'), '# A\n');
    writeFileSync(safePath.join(rootB, 'b.md'), '# B\n');
  });

  afterAll(() => {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  it('returns the same registry instance for a repeated root', async () => {
    const first = await crawlAndResolveRegistry(rootA, { outputs: [], unreadable: 'refuse' });
    const second = await crawlAndResolveRegistry(rootA, { outputs: [], unreadable: 'refuse' });

    expect(second).toBe(first);
  });

  it('keys on the resolved path, so a non-normalized spelling still hits', async () => {
    const first = await crawlAndResolveRegistry(rootA, { outputs: [], unreadable: 'refuse' });
    const viaDotSegment = await crawlAndResolveRegistry(`${rootA}/./`, { outputs: [], unreadable: 'refuse' });

    expect(viaDotSegment).toBe(first);
  });

  /**
   * Why the key is LEXICAL, not the real path. A registry answers `getResource` for the spelling
   * it was crawled under, so serving the real root's registry to a caller holding a symlinked
   * spelling would miss every lookup — an empty link graph, and a skill reported clean because
   * nothing was walked. Two spellings cost two crawls; that is the price of a correct answer.
   */
  it('crawls a symlinked spelling of the root under that spelling, never serving the real one', async ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const link = safePath.join(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-registry-memo-link-')), 'root');
    createSymlink(cap, rootA, link, 'dir');
    try {
      const first = await crawlAndResolveRegistry(rootA, { outputs: [], unreadable: 'refuse' });
      const viaLink = await crawlAndResolveRegistry(link, { outputs: [], unreadable: 'refuse' });

      // The control: the real root's registry cannot answer for the link's spelling.
      expect(first.getResource(safePath.join(link, 'a.md'))).toBeUndefined();
      expect(viaLink).not.toBe(first);
      expect(viaLink.getResource(safePath.join(link, 'a.md'))).toBeDefined();
    } finally {
      rmSync(safePath.resolve(link, '..'), { recursive: true, force: true });
    }
  });

  it('does not share a registry across different roots', async () => {
    const a = await crawlAndResolveRegistry(rootA, { outputs: [], unreadable: 'refuse' });
    const b = await crawlAndResolveRegistry(rootB, { outputs: [], unreadable: 'refuse' });

    // Sharing across roots is the failure the caller-side cache guarded against:
    // every `getResource()` lookup would miss and the walker would walk an empty
    // graph, reporting a clean skill because it never looked.
    expect(b).not.toBe(a);
    expect(a.baseDir).not.toBe(b.baseDir);
  });
});

/**
 * Every scratch root this file made, removed once at the end.
 *
 * One list and one teardown rather than one per describe: the roots are all
 * temp directories with the same lifetime, and a second teardown over a second
 * list is the kind of near-duplicate the zero-duplication gate exists to stop.
 */
const scratchRoots: string[] = [];

afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

/** A fresh temp directory, registered for teardown. */
function scratchRoot(prefix: string): string {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), prefix));
  scratchRoots.push(root);
  return root;
}

/** A scratch root holding exactly `files`, keyed by basename. */
function rootWithMarkdown(files: Record<string, string>): string {
  const root = scratchRoot('vat-registry-pop-');
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(safePath.join(root, name), content);
  }
  return root;
}

/** A scratch root holding a two-hop link chain: SKILL.md -> a.md -> b.md. */
function chainRoot(): { root: string; skillPath: string } {
  const root = scratchRoot('vat-registry-shared-');
  const { skillPath } = createTransitiveSkillStructure(
    root,
    { 'a.md': '# A\n\nSee [b](./b.md).\n', 'b.md': '# B\n' },
    createSkillContent(
      { name: 'population-source-subject', description: 'A skill whose link graph reaches two further markdown documents.' },
      '\n# Subject\n\nSee [a](./a.md).\n',
    ),
  );
  return { root, skillPath };
}

/**
 * A population source that yields exactly the named files under `root`, and
 * counts how often it was asked.
 *
 * Deliberately a REAL {@link ResourcePopulationSource} rather than a mock, so the
 * root it declares is the root the registry's guard actually compares against.
 * The count is what distinguishes "the memo was shared" from "the memo was
 * bypassed", and those are the two ways this seam can be wrong.
 */
function countingSource(
  root: string,
  names: readonly string[],
): { source: ResourcePopulationSource; calls: () => number } {
  let calls = 0;
  return {
    source: {
      root,
      enumerate: async () => {
        calls += 1;
        return {
          paths: names.map((name) => safePath.join(root, name)),
          conditions: [],
          outcome: { population: 'derived', stored: 'no-store' }, extentSource: 'filesystem',
        };
      },
    },
    calls: () => calls,
  };
}

/**
 * The memo key, and the silent-wrong-answer it exists to make unreachable.
 *
 * `crawlAndResolveRegistry` is process-memoized and SHARED — `vat skills build`
 * reaches it per skill through `validateSkillForPackaging`, `vat audit` reaches
 * it directly, and the pipeline oracles reach it as a lane. Keying on the
 * project root ALONE means the first caller's population binds for the whole
 * process, so a later caller asking a different question transparently receives
 * the earlier caller's answer. Nothing in the output would say so.
 *
 * The population source is therefore part of the key, by IDENTITY. A run holds
 * one source closure for its whole bracket, so the memo still costs one crawl
 * per run; two callers cannot hold the same closure by accident, so they cannot
 * collide. A descriptor string ('walk' / 'projection') would NOT do: two
 * projection sources can differ in their ignore oracle, their store, and whether
 * that store is still open, and a key that cannot see the difference is the same
 * bug one level down.
 */
describe('crawlAndResolveRegistry — a population never crosses between callers', () => {
  it('does not serve a source-backed registry to a caller that supplied none', async () => {
    const root = rootWithMarkdown({ 'kept.md': '# Kept\n', 'hidden.md': '# Hidden\n' });
    const { source } = countingSource(root, ['kept.md']);

    const sourced = await crawlAndResolveRegistry(root, { outputs: [], unreadable: 'refuse', populationSource: source });
    expect(sourced.getResource(safePath.resolve(root, 'hidden.md'))).toBeUndefined();

    const walked = await crawlAndResolveRegistry(root, { outputs: [], unreadable: 'refuse' });

    expect(walked).not.toBe(sourced);
    expect(walked.getResource(safePath.resolve(root, 'hidden.md'))).toBeDefined();
  });

  it('does not serve the walk registry to a caller that supplied a source', async () => {
    const root = rootWithMarkdown({ 'kept.md': '# Kept\n', 'hidden.md': '# Hidden\n' });
    const { source } = countingSource(root, ['kept.md']);

    const walked = await crawlAndResolveRegistry(root, { outputs: [], unreadable: 'refuse' });
    expect(walked.getResource(safePath.resolve(root, 'hidden.md'))).toBeDefined();

    const sourced = await crawlAndResolveRegistry(root, { outputs: [], unreadable: 'refuse', populationSource: source });

    expect(sourced).not.toBe(walked);
    expect(sourced.getResource(safePath.resolve(root, 'hidden.md'))).toBeUndefined();
  });

  it('keeps two different sources apart on one root', async () => {
    const root = rootWithMarkdown({ 'kept.md': '# Kept\n', 'hidden.md': '# Hidden\n' });
    const first = countingSource(root, ['kept.md']);
    const second = countingSource(root, ['hidden.md']);

    const fromFirst = await crawlAndResolveRegistry(root, { outputs: [], unreadable: 'refuse', populationSource: first.source });
    const fromSecond = await crawlAndResolveRegistry(root, { outputs: [], unreadable: 'refuse', populationSource: second.source });

    expect(fromSecond).not.toBe(fromFirst);
    expect(fromFirst.getResource(safePath.resolve(root, 'kept.md'))).toBeDefined();
    expect(fromFirst.getResource(safePath.resolve(root, 'hidden.md'))).toBeUndefined();
    expect(fromSecond.getResource(safePath.resolve(root, 'hidden.md'))).toBeDefined();
    expect(fromSecond.getResource(safePath.resolve(root, 'kept.md'))).toBeUndefined();
  });

  it('still pays one crawl per (source, root), so a run shares one registry', async () => {
    const root = rootWithMarkdown({ 'kept.md': '# Kept\n' });
    const { source, calls } = countingSource(root, ['kept.md']);

    const first = await crawlAndResolveRegistry(root, { outputs: [], unreadable: 'refuse', populationSource: source });
    const second = await crawlAndResolveRegistry(root, { outputs: [], unreadable: 'refuse', populationSource: source });

    expect(second).toBe(first);
    expect(calls()).toBe(1);
  });

  it('drops both lanes when the memo is reset', async () => {
    const root = rootWithMarkdown({ 'kept.md': '# Kept\n' });
    const { source, calls } = countingSource(root, ['kept.md']);

    const before = await crawlAndResolveRegistry(root, { outputs: [], unreadable: 'refuse', populationSource: source });
    const walkedBefore = await crawlAndResolveRegistry(root, { outputs: [], unreadable: 'refuse' });
    resetPackagingRegistryCache();

    expect(await crawlAndResolveRegistry(root, { outputs: [], unreadable: 'refuse', populationSource: source })).not.toBe(before);
    expect(await crawlAndResolveRegistry(root, { outputs: [], unreadable: 'refuse' })).not.toBe(walkedBefore);
    expect(calls()).toBe(2);
  });
});

/**
 * The seam that puts `vat skills build`'s per-skill validation on the lane its
 * run selected. Without it the packaging validator's private crawl is the last
 * enumeration on the walk inside a projection-lane build.
 */
describe('validateSkillForPackaging — routes its private crawl through the shared source', () => {
  it('walks the whole chain when no source is supplied', async () => {
    const { skillPath } = chainRoot();

    const result = await validateSkillForPackaging(skillPath);

    expect(result.metadata.fileCount).toBe(3);
    expect(result.metadata.maxLinkDepth).toBe(2);
  });

  it('sees only what the shared source enumerates', async () => {
    const { root, skillPath } = chainRoot();
    // Omits `a.md`, which is the DOOR to `b.md`. Routing is registry-only, so a
    // population that declines `a.md` cannot route THROUGH it: the walker finds
    // the file on disk and bundles it as a flat asset, and `b.md` — enumerated,
    // but reachable only through `a.md` — is never bundled at all. The chain
    // stops dead rather than one hop short, which is why the bundled depth is 0.
    const { source, calls } = countingSource(root, ['SKILL.md', 'b.md']);

    const result = await validateSkillForPackaging(skillPath, undefined, 'source', {
      unreadable: 'refuse',
      outputs: [],
      populationSource: source,
    });

    expect(calls()).toBe(1);
    expect(result.metadata.fileCount).toBe(2);
    expect(result.metadata.maxLinkDepth).toBe(0);
  });

  // No config and no git above the skill: the crawl falls back to the skill's own directory — a
  // staging directory, for a packaged skill — and memoizing it would keep one dead key per skill.
  it('does not memoize the crawl of a skill that sits in no project', async () => {
    const { root, skillPath } = chainRoot();
    const { source, calls } = countingSource(root, ['SKILL.md', 'a.md', 'b.md']);
    const shared = { unreadable: 'refuse', outputs: [], populationSource: source } as const;

    await validateSkillForPackaging(skillPath, undefined, 'source', shared);
    await validateSkillForPackaging(skillPath, undefined, 'source', shared);

    expect(calls()).toBe(2);
  });
});

/**
 * A fault at the crawl's base is classified on the side the CALLER declares: a packaging run
 * writes its output into the project it crawls, so a project that vanishes under it is a
 * destination fault (`RUN_INCOMPLETE`), while `vat skills validate` only reads it. A rejected
 * crawl is never memoized, so each caller's fault is classified against its own outputs.
 */
describe('crawlAndResolveRegistry — the side of the crawl base, from what the caller writes', () => {
  it('classifies a vanished base as the destination\'s only when it holds a declared output, and never serves one declaration\'s crawl to the other', async () => {
    resetPackagingRegistryCache();
    const root = rootWithMarkdown({ 'a.md': '# A\n' });

    await expect(crawlWithBaseVanished(root, []))
      .rejects.toMatchObject({ code: FS_FAULT_CODE, side: 'source', faultClass: 'absent' });
    await expect(crawlWithBaseVanished(root, [safePath.join(root, 'dist')]))
      .rejects.toMatchObject({ code: FS_FAULT_CODE, side: 'destination', faultClass: 'absent' });
  });
});

/** Crawl `root` with its own directory refused as vanished (`ENOENT`), declaring `outputs`. */
function crawlWithBaseVanished(root: string, outputs: string[]): Promise<ResourceRegistry> {
  return withReaddirSyncRefused(root, 'ENOENT', () => crawlAndResolveRegistry(root, { outputs, unreadable: 'refuse' }));
}

/** A population source whose first enumeration rejects, and every later one yields `names`. */
function failingOnceSource(root: string, names: readonly string[]): { source: ResourcePopulationSource; calls: () => number } {
  const inner = countingSource(root, names);
  return {
    source: {
      root,
      enumerate: async (...args) => {
        const result = await inner.source.enumerate(...args);
        if (inner.calls() === 1) throw new Error('the first enumeration fails');
        return result;
      },
    },
    calls: inner.calls,
  };
}

/** Whether `registry` holds the file at `relative` under `root`. */
function holds(registry: ResourceRegistry, root: string, relative: string): boolean {
  return registry.getResource(safePath.resolve(root, relative)) !== undefined;
}

/**
 * A crawl that rejected is never served from the memo: the next caller crawls again, under its
 * OWN `unreadable` ruling and its own outputs, because the rejection was decided under the
 * ruling of the caller that started it.
 */
describe('crawlAndResolveRegistry — a rejected crawl is retried, never served', () => {
  it('re-crawls for the next caller after the walk rejected', async () => {
    resetPackagingRegistryCache();
    const root = rootWithMarkdown({ 'a.md': '# A\n' });

    await expect(crawlWithBaseVanished(root, [])).rejects.toMatchObject({ code: FS_FAULT_CODE });
    const retried = await crawlAndResolveRegistry(root, { outputs: [], unreadable: 'refuse' });

    expect(holds(retried, root, 'a.md')).toBe(true);
  });

  it('re-crawls for the next caller after a population source rejected', async () => {
    const root = rootWithMarkdown({ 'a.md': '# A\n' });
    const { source, calls } = failingOnceSource(root, ['a.md']);

    await expect(crawlAndResolveRegistry(root, { outputs: [], unreadable: 'refuse', populationSource: source })).rejects.toThrow('the first enumeration fails');
    const retried = await crawlAndResolveRegistry(root, { outputs: [], unreadable: 'refuse', populationSource: source });

    expect(holds(retried, root, 'a.md')).toBe(true);
    expect(calls()).toBe(2);
  });

  it('serves a caller WAITING on a crawl that rejects by crawling again under its own policy', async () => {
    resetPackagingRegistryCache();
    const { root, locked } = rootWithLockedDirectory();
    const crawls = vi.spyOn(ResourceRegistry, 'fromCrawl');
    try {
      const degraded: unknown[] = [];
      await withReaddirSyncRefused(locked, 'EACCES', async () => {
        // Both started before either settles: the second joins the first's in-flight crawl.
        const first = crawlAndResolveRegistry(root, { outputs: [], unreadable: 'refuse' });
        const second = crawlAndResolveRegistry(root, { outputs: [], unreadable: { degrade: (refusal) => degraded.push(refusal) } });
        await expect(first).rejects.toMatchObject({ code: FS_FAULT_CODE });
        await expect(second).resolves.toBeDefined();
      });
      expect(degraded.length).toBeGreaterThan(0); // the retry ran under the waiter's OWN policy
      expect(crawls).toHaveBeenCalledTimes(2);
    } finally {
      crawls.mockRestore();
    }
  });

  it('costs N waiters on a rejected crawl ONE re-crawl, not N', async () => {
    resetPackagingRegistryCache();
    const { root, locked } = rootWithLockedDirectory();
    const crawls = vi.spyOn(ResourceRegistry, 'fromCrawl');
    try {
      await withReaddirSyncRefused(locked, 'EACCES', async () => {
        const degrade = { degrade: () => undefined };
        const first = crawlAndResolveRegistry(root, { outputs: [], unreadable: 'refuse' });
        const waiters = [1, 2, 3].map(() => crawlAndResolveRegistry(root, { outputs: [], unreadable: degrade }));
        await expect(first).rejects.toMatchObject({ code: FS_FAULT_CODE });
        const served = await Promise.all(waiters);
        expect(new Set(served).size).toBe(1);
      });
      expect(crawls).toHaveBeenCalledTimes(2);
    } finally {
      crawls.mockRestore();
    }
  });

  it('costs N waiters ONE re-crawl when the re-crawl rejects too, and each waiter is told', async () => {
    resetPackagingRegistryCache();
    const { root, locked } = rootWithLockedDirectory();
    const crawls = vi.spyOn(ResourceRegistry, 'fromCrawl');
    try {
      await withReaddirSyncRefused(locked, 'EACCES', async () => {
        const first = crawlAndResolveRegistry(root, { outputs: [], unreadable: 'refuse' });
        const waiters = [1, 2, 3].map(() => crawlAndResolveRegistry(root, { outputs: [], unreadable: 'refuse' }));
        await expect(first).rejects.toMatchObject({ code: FS_FAULT_CODE });
        for (const waiter of waiters) await expect(waiter).rejects.toMatchObject({ code: FS_FAULT_CODE });
      });
      expect(crawls).toHaveBeenCalledTimes(2);
    } finally {
      crawls.mockRestore();
    }
  });

  it('shares ONE in-flight crawl between two overlapping callers', async () => {
    const root = rootWithMarkdown({ 'a.md': '# A\n' });
    const { source, calls } = countingSource(root, ['a.md']);
    const options = { outputs: [], unreadable: 'refuse', populationSource: source } as const;

    const [first, second] = await Promise.all([crawlAndResolveRegistry(root, options), crawlAndResolveRegistry(root, options)]);

    expect(second).toBe(first);
    expect(calls()).toBe(1);
  });
});

/**
 * A root with a subdirectory to refuse: a refused SUBDIRECTORY degrades under `{ degrade }`,
 * where a refused root (the crawl base itself) refuses under any policy.
 */
function rootWithLockedDirectory(): { root: string; locked: string } {
  const root = rootWithMarkdown({ 'a.md': '# A\n' });
  const locked = mkdirSyncReal(safePath.join(root, 'locked'));
  writeFileSync(safePath.join(locked, 'b.md'), '# B\n');
  return { root, locked };
}

/** A root with a built skill under `out/` and the staging residue an interrupted build leaves beside it. */
function rootWithStagedOutput(): { root: string; output: string } {
  const root = rootWithMarkdown({ 'a.md': '# A\n' });
  const output = safePath.join(root, 'out', 'skill');
  const residue = safePath.join(root, 'out', '.skill.vat-staged-0a1b2c3d');
  for (const dir of [output, residue]) {
    mkdirSyncReal(dir, { recursive: true });
    writeFileSync(safePath.join(dir, 'SKILL.md'), '# Built\n');
  }
  return { root, output };
}

/** The staging residue's own path, relative to the root. */
const RESIDUE_SKILL = 'out/.skill.vat-staged-0a1b2c3d/SKILL.md';

/** Crawl twice (the second a memo hit declaring `output`) and assert the hit holds no residue. */
async function expectMemoHitWithoutResidue(
  root: string,
  output: string,
  extra: { populationSource?: ResourcePopulationSource } = {},
): Promise<void> {
  const first = await crawlAndResolveRegistry(root, { outputs: [], unreadable: 'refuse', ...extra });
  const hit = await crawlAndResolveRegistry(root, { outputs: [output], unreadable: 'refuse', ...extra });

  expect(hit).toBe(first);
  expect(holds(hit, root, 'a.md')).toBe(true);
  expect(holds(hit, root, RESIDUE_SKILL)).toBe(false);
}

/**
 * The memoized crawl never holds a build's staging residue (`.<name>.vat-staged-*`): it is the
 * tree-change primitive's transient copy, and a later skill served a registry holding it would
 * resolve links into a directory that is renamed away. Asserted on a memo HIT — the second
 * caller is served without a reset — on every route the crawl can take.
 */
describe('crawlAndResolveRegistry — the build\'s staging residue is never in the memoized crawl', () => {
  it('on the walk', async () => {
    resetPackagingRegistryCache();
    const { root, output } = rootWithStagedOutput();
    await expectMemoHitWithoutResidue(root, output);
  });

  it('on the git route', async () => {
    resetPackagingRegistryCache();
    const { root, output } = rootWithStagedOutput();
    spawnSync(gitExecutable(), ['init', '-q', root], { stdio: 'ignore' });
    await expectMemoHitWithoutResidue(root, output);
  });

  it('on a population source that enumerates the residue', async () => {
    const { root, output } = rootWithStagedOutput();
    const { source } = countingSource(root, ['a.md', 'out/skill/SKILL.md', RESIDUE_SKILL]);
    await expectMemoHitWithoutResidue(root, output, { populationSource: source });
  });
});

/**
 * `outputs` decides which SIDE a fault is on, never which files the crawl finds — so it is not
 * part of what the memo shares. The packager's post-build lane calls this once per skill, each
 * declaring its own output directory; keyed on `outputs`, every skill paid a fresh whole-project
 * crawl and the process-lifetime memo kept every one of them (one registry per skill, which ran
 * a large adopter's plugin build out of heap).
 */
describe('crawlAndResolveRegistry — what the caller writes does not split the memo', () => {
  it('serves one registry to N callers that each declare a different output', async () => {
    resetPackagingRegistryCache();
    const root = rootWithMarkdown({ 'a.md': '# A\n' });

    const registries = new Set<unknown>();
    for (const skill of ['one', 'two', 'three', 'four']) {
      registries.add(await crawlAndResolveRegistry(root, { unreadable: 'refuse', outputs: [safePath.join(root, 'out', skill)] }));
    }

    expect(registries.size).toBe(1);
  });

  it('finds the same population whatever the caller declares, an output inside the root included', async () => {
    const root = rootWithMarkdown({ 'a.md': '# A\n' });
    // An output directory inside the root and outside every default exclude: whether the crawl
    // walks it is decided by include/exclude alone, never by its being declared an output.
    const output = safePath.join(root, 'out');
    mkdirSyncReal(output);
    writeFileSync(safePath.join(output, 'built.md'), '# Built\n');
    const pathsOf = (registry: ResourceRegistry): string[] =>
      registry.getAllResources().map((resource) => resource.filePath).toSorted((a, b) => a.localeCompare(b));

    resetPackagingRegistryCache();
    const undeclared = pathsOf(await crawlAndResolveRegistry(root, { unreadable: 'refuse', outputs: [] }));
    resetPackagingRegistryCache();
    const declared = pathsOf(await crawlAndResolveRegistry(root, { unreadable: 'refuse', outputs: [output] }));

    expect(declared).toEqual(undeclared);
    expect(declared).toContain(safePath.join(output, 'built.md'));
  });
});

// A verb that writes its output into the project it validates (`vat skills build`) declares so:
// its pre-build validation's crawl then classifies a project vanishing under it as the destination's.
describe('validateSkillForPackaging — the calling verb declares the side of the project', () => {
  it('classifies a vanished project on the side the shared context declares', async () => {
    resetPackagingRegistryCache();
    const { root, skillPath } = chainRoot();

    await expect(withReaddirSyncRefused(root, 'ENOENT', () => validateSkillForPackaging(skillPath, undefined, 'source', { unreadable: 'refuse', outputs: [safePath.join(root, 'dist')] })))
      .rejects.toMatchObject({ code: FS_FAULT_CODE, side: 'destination', faultClass: 'absent' });
  });
});
