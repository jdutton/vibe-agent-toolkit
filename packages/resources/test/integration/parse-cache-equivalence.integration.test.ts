/**
 * Cold-vs-warm equivalence for the disk-backed parse cache.
 *
 * The cache is content-addressed and fail-soft, which makes it *invisible*: a
 * cache that silently never hits produces byte-identical `ResourceMetadata` to
 * one that always does. An equivalence assertion alone therefore asserts
 * nothing — every test here that compares two runs also pins the hit count of
 * each, so a regression that disables the cache fails loudly instead of passing
 * quietly.
 *
 * Equality is `toStrictEqual`, never `toEqual`: `toStrictEqual` distinguishes an
 * own property valued `undefined` from an absent one, and that distinction is
 * exactly what a rehydrated object can get wrong (`x: undefined` in place of no
 * `x` at all). Weakening the matcher would retire the only assertion that can
 * see it.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- tests use dynamic file paths in temp directories */

import { promises as fs } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ParseCache, type ParseCacheStats } from '../../src/parse-cache.js';
import { ResourceRegistry } from '../../src/resource-registry.js';
import type { ResourceMetadata } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Corpus — written once, read by every test.
// ---------------------------------------------------------------------------

/** Frontmatter, two heading levels, an inline link, a reference link and an anchor. */
const GUIDE_DOC = `---
title: Guide
tags:
  - alpha
  - beta
nested:
  depth: 2
---

# Guide

Start at [the api](./api.md) and then [the notes][notes].

## Details

<a id="details-anchor"></a>

[notes]: ./notes.md
`;

/**
 * Frontmatter whose values JSON cannot carry.
 *
 * `.inf` and `.nan` become `Infinity`/`NaN`, which `JSON.stringify` writes as
 * `null`; `!!binary` becomes a `Buffer`, which it rewrites as `{type,data}`; the
 * cyclic anchor makes it **throw**. Present here because the cache stores the
 * YAML *source* and re-parses it on a hit — a cache that stored the parsed
 * object would corrupt the first three and silently never store the fourth, and
 * only a document like this one can tell the two designs apart.
 */
const EXOTIC_DOC = `---
ratio: .inf
missing: .nan
blob: !!binary "d2F2ZQ=="
loop: &node
  back: *node
---

# Exotic

[onward](./onward.md)
`;

/** Frontmatter present but unparseable — populates `frontmatterError`. */
const UNPARSEABLE_DOC = `---
title: "unterminated
list: [1, 2
---

# Unparseable
`;

/** No frontmatter at all — the `deriveFrontmatter` no-source branch. */
const BARE_DOC = `# Bare

No frontmatter here, just [a link](./guide.md).
`;

/** Routes to the HTML parser, so the html half of the interception is covered. */
const PAGE_HTML = `<!doctype html>
<html>
  <body>
    <h1 id="top">Page</h1>
    <p><a href="./guide.md">guide</a></p>
    <h2 id="second">Second</h2>
  </body>
</html>
`;

/** Identical bytes under two names — one content key, two resources. */
const TWIN_DOC = `---
title: Twin
---

# Twin

Shared bytes, [two homes](./elsewhere.md).
`;

/** Files of the mixed corpus, in the order they are added. All distinct content. */
const MIXED_FILES: ReadonlyArray<readonly [string, string]> = [
  ['guide.md', GUIDE_DOC],
  ['exotic.md', EXOTIC_DOC],
  ['unparseable.md', UNPARSEABLE_DOC],
  ['bare.md', BARE_DOC],
  ['page.html', PAGE_HTML],
];

/** Registry ids, derived from the corpus file names by the default path rule. */
const EXOTIC_ID = 'exotic-md';
const UNPARSEABLE_ID = 'unparseable-md';

/** Files of the twin corpus — identical content, different names. */
const TWIN_FILES: ReadonlyArray<readonly [string, string]> = [
  ['left.md', TWIN_DOC],
  ['right.md', TWIN_DOC],
];

// ---------------------------------------------------------------------------
// Suite helper — one corpus setup, one registry-construction path.
// ---------------------------------------------------------------------------

/** One registry run: the resources it produced and what the cache did for it. */
interface BuildOutcome {
  resources: ResourceMetadata[];
  stats: ParseCacheStats;
}

/** A written corpus: where it lives and which paths to feed the registry. */
interface Corpus {
  dir: string;
  paths: string[];
}

/** A cold run, the warm run over the same cache, and where that cache lives. */
interface ColdWarmPair {
  cold: BuildOutcome;
  warm: BuildOutcome;
  cacheDir: string;
}

/**
 * Suite scaffolding: a temp root, the two corpora, and fresh cache directories.
 *
 * Exists so no test repeats corpus creation or registry construction — the
 * repeated block is the thing jscpd catches, and the shared `build` is also
 * what guarantees every test drives the registry the same way.
 */
function setupParseCacheEquivalenceSuite(): {
  mixed: () => Corpus;
  twin: () => Corpus;
  freshCacheDir: () => Promise<string>;
  coldThenWarm: (corpus: Corpus) => Promise<ColdWarmPair>;
  beforeAll: () => Promise<void>;
  afterAll: () => Promise<void>;
} {
  let root = '';
  let mixed: Corpus = { dir: '', paths: [] };
  let twin: Corpus = { dir: '', paths: [] };
  let cacheCounter = 0;

  const freshCacheDir = async (): Promise<string> => {
    cacheCounter += 1;
    const dir = safePath.join(root, `cache-${String(cacheCounter)}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  return {
    mixed: () => mixed,
    twin: () => twin,
    freshCacheDir,
    coldThenWarm: async (corpus) => {
      const cacheDir = await freshCacheDir();
      const cold = await build(corpus, new ParseCache({ cacheDir }));
      const warm = await build(corpus, new ParseCache({ cacheDir }));
      return { cold, warm, cacheDir };
    },
    beforeAll: async () => {
      root = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'parse-cache-equiv-'));
      mixed = await writeCorpus(safePath.join(root, 'mixed'), MIXED_FILES);
      twin = await writeCorpus(safePath.join(root, 'twin'), TWIN_FILES);
    },
    afterAll: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

/** Write one corpus to disk and return the paths in declaration order. */
async function writeCorpus(
  dir: string,
  files: ReadonlyArray<readonly [string, string]>,
): Promise<Corpus> {
  await fs.mkdir(dir, { recursive: true });
  const paths: string[] = [];
  for (const [name, content] of files) {
    const filePath = safePath.join(dir, name);
    await fs.writeFile(filePath, content, 'utf-8');
    paths.push(filePath);
  }
  return { dir, paths };
}

/**
 * Build one registry over a corpus with the given cache and report both halves.
 *
 * THE shared construction path. A test that built its own registry could drift
 * into passing a different option set than the run it is being compared with,
 * which would make an equality failure unattributable.
 */
async function build(corpus: Corpus, cache: ParseCache): Promise<BuildOutcome> {
  const registry = new ResourceRegistry({ baseDir: corpus.dir, parseCache: cache });
  const resources = await registry.addResources(corpus.paths);
  return { resources, stats: registry.getParseCacheStats() };
}

/** Every entry file the cache has written, absolute, sorted. */
async function entryFiles(cacheDir: string): Promise<string[]> {
  const names = await fs.readdir(cacheDir, { recursive: true });
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => safePath.join(cacheDir, name))
    .sort((a, b) => a.localeCompare(b));
}

/** Overwrite every entry with bytes that are not JSON. */
async function corruptEntries(cacheDir: string): Promise<number> {
  const entries = await entryFiles(cacheDir);
  for (const entry of entries) {
    await fs.writeFile(entry, '{"v":1,"facts":{ truncated', 'utf-8');
  }
  return entries.length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parse cache — cold/warm equivalence', () => {
  const suite = setupParseCacheEquivalenceSuite();
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  it('serves a warm run entirely from cache and produces identical metadata', async () => {
    const { cold, warm } = await suite.coldThenWarm(suite.mixed());

    // The gate on the gate: without these two the equality below would pass
    // just as happily over a cache that never hit anything. Verified — an
    // always-miss mutant leaves the `toStrictEqual` green and fails only here.
    expect(cold.stats).toStrictEqual({ hits: 0, misses: MIXED_FILES.length });
    expect(warm.stats).toStrictEqual({ hits: MIXED_FILES.length, misses: 0 });

    expect(warm.resources).toStrictEqual(cold.resources);
  });

  it('round-trips frontmatter values that JSON cannot carry', async () => {
    const { cold, warm } = await suite.coldThenWarm(suite.mixed());

    // Same gate-on-the-gate as above, and it is not redundant: measured against
    // an always-miss mutant, this test and the one below BOTH stayed green
    // without it. A test whose name says "on a hit" has to assert that a hit
    // happened, or it is asserting that two cold runs agree with each other.
    expect(warm.stats.hits).toBe(MIXED_FILES.length);

    const coldExotic = findById(cold.resources, EXOTIC_ID);

    // Pinned explicitly rather than left to the whole-corpus comparison: if the
    // fixture ever stopped containing JSON-hostile values, that comparison would
    // keep passing while proving strictly less.
    expect(coldExotic.frontmatter?.['ratio']).toBe(Number.POSITIVE_INFINITY);
    expect(coldExotic.frontmatter?.['missing']).toBeNaN();
    expect(findById(warm.resources, EXOTIC_ID)).toStrictEqual(coldExotic);
  });

  it('reports a frontmatter error identically on a hit', async () => {
    const { cold, warm } = await suite.coldThenWarm(suite.mixed());

    expect(warm.stats.hits).toBe(MIXED_FILES.length);

    const coldBroken = findById(cold.resources, UNPARSEABLE_ID);
    expect(coldBroken.frontmatterError).toBeTypeOf('string');
    expect(findById(warm.resources, UNPARSEABLE_ID)).toStrictEqual(coldBroken);
  });
});

describe('parse cache — resources sharing one content key', () => {
  const suite = setupParseCacheEquivalenceSuite();
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  it('files two identically-contented files under one entry', async () => {
    const cacheDir = await suite.freshCacheDir();

    const cold = await build(suite.twin(), new ParseCache({ cacheDir }));

    // Proves the fixture really can exercise the shared-entry path: two
    // resources, one entry on disk. The second file hits within the SAME run,
    // because `set` is awaited before the next file is read.
    expect(cold.resources).toHaveLength(2);
    expect(await entryFiles(cacheDir)).toHaveLength(1);
    expect(cold.stats).toStrictEqual({ hits: 1, misses: 1 });
  });

  it('never hands two resources the same links array', async () => {
    const { warm } = await suite.coldThenWarm(suite.twin());

    expect(warm.stats).toStrictEqual({ hits: 2, misses: 0 });

    const [left, right] = warm.resources;
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    if (left === undefined || right === undefined) return;

    // Reference identity, not deep equality: the two are deeply equal by
    // construction, and that is precisely why aliasing is invisible without
    // `not.toBe`.
    expect(left.links).not.toBe(right.links);
    expect(left.headings).not.toBe(right.headings);
    expect(left.links[0]).not.toBe(right.links[0]);

    // `skill-packager.ts` assigns `link.resolvedId` in place while bundling. A
    // shared array would leak one skill's bundling decision into another's.
    const target = left.links[0];
    expect(target).toBeDefined();
    if (target === undefined) return;
    target.resolvedId = 'left-only';

    expect(right.links[0]?.resolvedId).toBeUndefined();
  });
});

describe('parse cache — degraded modes', () => {
  const suite = setupParseCacheEquivalenceSuite();
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  it('produces identical metadata with the cache disabled', async () => {
    const cacheDir = await suite.freshCacheDir();

    const cold = await build(suite.mixed(), new ParseCache({ cacheDir }));
    const disabled = await build(suite.mixed(), new ParseCache({ cacheDir, enabled: false }));

    // A disabled cache reads nothing even though the directory is populated…
    expect(disabled.stats).toStrictEqual({ hits: 0, misses: MIXED_FILES.length });
    // …and writes nothing either, so the entry count is unchanged.
    expect(await entryFiles(cacheDir)).toHaveLength(MIXED_FILES.length);
    expect(disabled.resources).toStrictEqual(cold.resources);
  });

  it('degrades a corrupt entry to a miss and still parses correctly', async () => {
    const cacheDir = await suite.freshCacheDir();

    const cold = await build(suite.mixed(), new ParseCache({ cacheDir }));
    expect(await corruptEntries(cacheDir)).toBe(MIXED_FILES.length);

    const afterCorruption = await build(suite.mixed(), new ParseCache({ cacheDir }));

    // Every read is a miss, so the run is a full cold parse wearing a warm hat.
    expect(afterCorruption.stats).toStrictEqual({ hits: 0, misses: MIXED_FILES.length });
    expect(afterCorruption.resources).toStrictEqual(cold.resources);

    // …and the run repaired what it found broken, so the next one hits.
    const repaired = await build(suite.mixed(), new ParseCache({ cacheDir }));
    expect(repaired.stats).toStrictEqual({ hits: MIXED_FILES.length, misses: 0 });
    expect(repaired.resources).toStrictEqual(cold.resources);
  });
});

/** Locate one resource by id, failing loudly rather than returning undefined. */
function findById(resources: ResourceMetadata[], id: string): ResourceMetadata {
  const found = resources.find((resource) => resource.id === id);
  if (found === undefined) throw new Error(`No resource with id ${id}`);
  return found;
}
