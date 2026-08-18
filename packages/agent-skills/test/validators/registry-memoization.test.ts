import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import type { ResourcePopulationSource } from '@vibe-agent-toolkit/resources';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- mkdtempSync path
    writeFileSync(safePath.join(rootA, 'a.md'), '# A\n');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- mkdtempSync path
    writeFileSync(safePath.join(rootB, 'b.md'), '# B\n');
  });

  afterAll(() => {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  it('returns the same registry instance for a repeated root', async () => {
    const first = await crawlAndResolveRegistry(rootA);
    const second = await crawlAndResolveRegistry(rootA);

    expect(second).toBe(first);
  });

  it('keys on the resolved path, so a non-normalized spelling still hits', async () => {
    const first = await crawlAndResolveRegistry(rootA);
    const viaDotSegment = await crawlAndResolveRegistry(`${rootA}/./`);

    expect(viaDotSegment).toBe(first);
  });

  it('does not share a registry across different roots', async () => {
    const a = await crawlAndResolveRegistry(rootA);
    const b = await crawlAndResolveRegistry(rootB);

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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- mkdtempSync path
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
 * Deliberately a REAL {@link ResourcePopulationSource} rather than a mock: the
 * production type is a function, so the honest way to stand one up is to write
 * one. The count is what distinguishes "the memo was shared" from "the memo was
 * bypassed", and those are the two ways this seam can be wrong.
 */
function countingSource(
  root: string,
  names: readonly string[],
): { source: ResourcePopulationSource; calls: () => number } {
  let calls = 0;
  return {
    source: async () => {
      calls += 1;
      return names.map((name) => safePath.join(root, name));
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

    const sourced = await crawlAndResolveRegistry(root, { populationSource: source });
    expect(sourced.getResource(safePath.resolve(root, 'hidden.md'))).toBeUndefined();

    const walked = await crawlAndResolveRegistry(root);

    expect(walked).not.toBe(sourced);
    expect(walked.getResource(safePath.resolve(root, 'hidden.md'))).toBeDefined();
  });

  it('does not serve the walk registry to a caller that supplied a source', async () => {
    const root = rootWithMarkdown({ 'kept.md': '# Kept\n', 'hidden.md': '# Hidden\n' });
    const { source } = countingSource(root, ['kept.md']);

    const walked = await crawlAndResolveRegistry(root);
    expect(walked.getResource(safePath.resolve(root, 'hidden.md'))).toBeDefined();

    const sourced = await crawlAndResolveRegistry(root, { populationSource: source });

    expect(sourced).not.toBe(walked);
    expect(sourced.getResource(safePath.resolve(root, 'hidden.md'))).toBeUndefined();
  });

  it('keeps two different sources apart on one root', async () => {
    const root = rootWithMarkdown({ 'kept.md': '# Kept\n', 'hidden.md': '# Hidden\n' });
    const first = countingSource(root, ['kept.md']);
    const second = countingSource(root, ['hidden.md']);

    const fromFirst = await crawlAndResolveRegistry(root, { populationSource: first.source });
    const fromSecond = await crawlAndResolveRegistry(root, { populationSource: second.source });

    expect(fromSecond).not.toBe(fromFirst);
    expect(fromFirst.getResource(safePath.resolve(root, 'kept.md'))).toBeDefined();
    expect(fromFirst.getResource(safePath.resolve(root, 'hidden.md'))).toBeUndefined();
    expect(fromSecond.getResource(safePath.resolve(root, 'hidden.md'))).toBeDefined();
    expect(fromSecond.getResource(safePath.resolve(root, 'kept.md'))).toBeUndefined();
  });

  it('still pays one crawl per (source, root), so a run shares one registry', async () => {
    const root = rootWithMarkdown({ 'kept.md': '# Kept\n' });
    const { source, calls } = countingSource(root, ['kept.md']);

    const first = await crawlAndResolveRegistry(root, { populationSource: source });
    const second = await crawlAndResolveRegistry(root, { populationSource: source });

    expect(second).toBe(first);
    expect(calls()).toBe(1);
  });

  it('drops both lanes when the memo is reset', async () => {
    const root = rootWithMarkdown({ 'kept.md': '# Kept\n' });
    const { source, calls } = countingSource(root, ['kept.md']);

    const before = await crawlAndResolveRegistry(root, { populationSource: source });
    const walkedBefore = await crawlAndResolveRegistry(root);
    resetPackagingRegistryCache();

    expect(await crawlAndResolveRegistry(root, { populationSource: source })).not.toBe(before);
    expect(await crawlAndResolveRegistry(root)).not.toBe(walkedBefore);
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
      populationSource: source,
    });

    expect(calls()).toBe(1);
    expect(result.metadata.fileCount).toBe(2);
    expect(result.metadata.maxLinkDepth).toBe(0);
  });
});
