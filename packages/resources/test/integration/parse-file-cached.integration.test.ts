/**
 * `parseFileCached` — the cached replacement for `parseMarkdown` / `parseHtml`.
 *
 * Those two read the file themselves and hand the bytes straight to a parser, so
 * they bypass the cache entirely. `parseFileCached` reads once, keys the bytes,
 * and consults the cache in between — and eight shipped call sites across
 * agent-skills, cli and rag-lancedb now go through it. The oracle for "did that
 * change anything?" is therefore the uncached function itself: every equivalence
 * test below compares against a real `parseMarkdown`/`parseHtml` call rather than
 * against another `parseFileCached` run, so a bug shared by both cache paths
 * cannot hide behind its own reflection.
 *
 * **Every cold/warm comparison also pins `cache.stats`.** The cache is
 * content-addressed and fail-soft, which makes it invisible: one that never hits
 * produces byte-identical results to one that always does. Measured in this repo
 * against an always-miss mutant, three pure-`toStrictEqual` tests stayed green
 * while claiming to test hits. `toStrictEqual` everywhere, never `toEqual` — the
 * distinction between an absent property and one valued `undefined` is exactly
 * what a rehydrated object can get wrong.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- tests use dynamic file paths in temp directories */

import { promises as fs } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ParserKind } from '../../src/content-key.js';
import { parseHtml } from '../../src/html-link-parser.js';
import { type ParseResult, parseMarkdown } from '../../src/link-parser.js';
import { ParseCache, type ParseCacheStats, parseFileCached } from '../../src/parse-cache.js';

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

/** Frontmatter, a heading, an inline link and an anchor — the markdown lane. */
const GUIDE_DOC = `---
title: Guide
tags:
  - alpha
---

# Guide

Start at [the api](./api.md).

<a id="details-anchor"></a>
`;

/**
 * Real HTML, and the file it is written to is named `page.html`.
 *
 * Parsed as `'html'` this yields one link; parsed as `'markdown'` — which is
 * what `rag-lancedb/src/lancedb-rag-provider.ts` actually does to every resource
 * the registry crawls, `.html` ones included — it yields none, because the
 * `<a href>` sits inside a raw-HTML block the markdown parser does not descend
 * into. That asymmetry is what makes it a usable probe for key separation.
 */
const PAGE_HTML = `<!doctype html>
<html>
  <body>
    <h1 id="top">Page</h1>
    <p><a href="./guide.md">guide</a></p>
  </body>
</html>
`;

/**
 * Bytes both parsers have a real, *different* answer for.
 *
 * Verified before being relied on (and re-verified in the test itself): markdown
 * reports `./md-target.md` plus the `# Markdown Heading` heading; HTML reports
 * `./html-target.md` plus a `missing-doctype` parse error and no headings. A
 * fixture that produced the same answer from both parsers could not tell a
 * kind-separated key from a shared one — the two lanes would agree either way.
 */
const DUAL_DOC = `# Markdown Heading

Text with [a markdown link](./md-target.md).

<h2 id="html-heading">HTML Heading</h2>

<p><a href="./html-target.md">html anchor</a></p>
`;

const CORPUS: ReadonlyArray<readonly [string, string]> = [
  ['guide.md', GUIDE_DOC],
  ['page.html', PAGE_HTML],
  ['dual.md', DUAL_DOC],
];

// ---------------------------------------------------------------------------
// Suite scaffolding
// ---------------------------------------------------------------------------

/** A cold run, the warm run over the same cache directory, and both stat pairs. */
interface ColdWarm {
  cold: ParseResult;
  warm: ParseResult;
  coldStats: ParseCacheStats;
  warmStats: ParseCacheStats;
}

/**
 * Temp corpus plus a per-test cache directory dispenser.
 *
 * Every cache in this file is explicitly directed at one of these directories:
 * a test that fell back to the process-wide default would read entries written
 * by whatever else ran on the machine, and would be neither cold nor isolated.
 */
function setupParseFileCachedSuite(): {
  file: (name: string) => string;
  freshCacheDir: () => Promise<string>;
  beforeAll: () => Promise<void>;
  afterAll: () => Promise<void>;
} {
  let root = '';
  let corpusDir = '';
  let counter = 0;

  return {
    file: (name) => safePath.join(corpusDir, name),
    freshCacheDir: async () => {
      counter += 1;
      const dir = safePath.join(root, `cache-${String(counter)}`);
      await fs.mkdir(dir, { recursive: true });
      return dir;
    },
    beforeAll: async () => {
      root = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'parse-file-cached-'));
      corpusDir = safePath.join(root, 'corpus');
      await fs.mkdir(corpusDir, { recursive: true });
      for (const [name, content] of CORPUS) {
        await fs.writeFile(safePath.join(corpusDir, name), content, 'utf-8');
      }
    },
    afterAll: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Parse one file twice through two cache instances over one directory.
 *
 * Two instances rather than one so each run's counters stand alone: a single
 * instance's cumulative `{hits:1,misses:1}` cannot say *which* run hit.
 */
async function coldThenWarm(
  filePath: string,
  parserKind: ParserKind,
  cacheDir: string,
): Promise<ColdWarm> {
  const coldCache = new ParseCache({ cacheDir });
  const cold = await parseFileCached(filePath, parserKind, coldCache);
  const warmCache = new ParseCache({ cacheDir });
  const warm = await parseFileCached(filePath, parserKind, warmCache);
  return { cold, warm, coldStats: coldCache.stats, warmStats: warmCache.stats };
}

/** Parse one file as BOTH kinds against one cache, markdown first. */
async function bothKinds(filePath: string, cache: ParseCache): Promise<[ParseResult, ParseResult]> {
  const asMarkdown = await parseFileCached(filePath, 'markdown', cache);
  const asHtml = await parseFileCached(filePath, 'html', cache);
  return [asMarkdown, asHtml];
}

/**
 * Re-parse both kinds over a populated cache and assert each got its OWN entry.
 *
 * The hit count is the load-bearing half: `toStrictEqual` against the cold
 * results would hold just as well if the cache had missed twice and re-parsed.
 */
async function expectWarmBothKinds(
  filePath: string,
  cacheDir: string,
  cold: readonly [ParseResult, ParseResult],
): Promise<void> {
  const warmCache = new ParseCache({ cacheDir });
  const [warmMarkdown, warmHtml] = await bothKinds(filePath, warmCache);
  expect(warmCache.stats).toStrictEqual({ hits: 2, misses: 0 });
  expect(warmMarkdown).toStrictEqual(cold[0]);
  expect(warmHtml).toStrictEqual(cold[1]);
}

/** How many entries the cache has written under `cacheDir`. */
async function entryCount(cacheDir: string): Promise<number> {
  const names = await fs.readdir(cacheDir, { recursive: true });
  return names.filter((name) => name.endsWith('.json')).length;
}

/**
 * Pin the only stats a single-file cold-then-warm pair may legitimately have.
 *
 * THE gate on every equivalence assertion in the first suite. Measured against
 * an always-miss mutant (every `ParseCache` here constructed `enabled: false`),
 * six of these eight tests fail — and every one of them fails *here* or on an
 * entry count, never on a `toStrictEqual` of parse results. Those stayed green
 * throughout, which is exactly the theatre this helper exists to prevent.
 */
function expectOneMissThenOneHit(pair: ColdWarm): void {
  expect(pair.coldStats).toStrictEqual({ hits: 0, misses: 1 });
  expect(pair.warmStats).toStrictEqual({ hits: 1, misses: 0 });
}

/** First link of a result, failing loudly instead of returning `undefined`. */
function firstLink(result: ParseResult): ParseResult['links'][number] {
  const link = result.links[0];
  if (link === undefined) throw new Error('expected at least one link');
  return link;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseFileCached — equivalence with the uncached parsers', () => {
  const suite = setupParseFileCachedSuite();
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  it('agrees with parseMarkdown cold and on a hit', async () => {
    const filePath = suite.file('guide.md');
    const pair = await coldThenWarm(filePath, 'markdown', await suite.freshCacheDir());
    const { cold, warm } = pair;

    // The gate on the gate. Without it, the equalities below would pass just as
    // happily over a cache that never hit anything at all.
    expectOneMissThenOneHit(pair);

    const uncached = await parseMarkdown(filePath);
    expect(cold).toStrictEqual(uncached);
    expect(warm).toStrictEqual(uncached);
  });

  it('agrees with parseHtml cold and on a hit', async () => {
    const filePath = suite.file('page.html');
    const pair = await coldThenWarm(filePath, 'html', await suite.freshCacheDir());
    const { cold, warm } = pair;

    expectOneMissThenOneHit(pair);

    const uncached = await parseHtml(filePath);
    expect(cold).toStrictEqual(uncached);
    expect(warm).toStrictEqual(uncached);
  });

  it('reports the same sizeBytes as stat().size on both paths', async () => {
    const filePath = suite.file('guide.md');
    const pair = await coldThenWarm(filePath, 'markdown', await suite.freshCacheDir());
    const { cold, warm } = pair;

    // Without this, "on both paths" is a claim the test cannot make: under an
    // always-miss cache `warm` is a second cold parse, and this test was in fact
    // one of only two that survived that mutant before the gate was added.
    expectOneMissThenOneHit(pair);

    // `parseMarkdown` publishes `stat().size`; `parseFileCached` publishes the
    // byte length of what it read. For a regular file those are the same number,
    // and the whole-result comparisons above already depend on it — this pins
    // the claim directly so a divergence names itself instead of surfacing as an
    // unattributable object mismatch.
    const { size } = await fs.stat(filePath);
    expect(cold.sizeBytes).toBe(size);
    expect(warm.sizeBytes).toBe(size);
  });
});

describe('parseFileCached — cross-kind key separation', () => {
  const suite = setupParseFileCachedSuite();
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  it('serves each parser its own answer for one file and files two entries', async () => {
    const filePath = suite.file('dual.md');
    const cacheDir = await suite.freshCacheDir();
    const [asMarkdown, asHtml] = await bothKinds(filePath, new ParseCache({ cacheDir }));

    // Proof the fixture can actually tell the two apart, asserted rather than
    // assumed: a doc both parsers answered identically would make every
    // assertion below true under a key that ignored the parser kind.
    expect(firstLink(asMarkdown).href).toBe('./md-target.md');
    expect(firstLink(asHtml).href).toBe('./html-target.md');
    expect(asMarkdown.headings).toHaveLength(1);
    expect(asHtml.headings).toHaveLength(0);

    // Two kinds, two keys, two entries — not one entry serving both lanes.
    expect(await entryCount(cacheDir)).toBe(2);

    // …and on the warm pass each kind is served its own entry back, unswapped.
    await expectWarmBothKinds(filePath, cacheDir, [asMarkdown, asHtml]);
  });

  it('parses page.html as markdown without colliding with a genuine html parse', async () => {
    const filePath = suite.file('page.html');
    const cacheDir = await suite.freshCacheDir();
    const coldCache = new ParseCache({ cacheDir });
    const [asMarkdown, asHtml] = await bothKinds(filePath, coldCache);

    expect(coldCache.stats).toStrictEqual({ hits: 0, misses: 2 });

    // The extension says html; the caller said markdown. The caller wins — this
    // is the shape `lancedb-rag-provider.ts` relies on.
    expect(asMarkdown).toStrictEqual(await parseMarkdown(filePath));
    expect(asHtml).toStrictEqual(await parseHtml(filePath));

    // Non-vacuous: the two answers genuinely differ, so being served the wrong
    // one would be visible.
    expect(asMarkdown.links).toHaveLength(0);
    expect(asHtml.links).toHaveLength(1);
    expect(await entryCount(cacheDir)).toBe(2);

    // Warm: still two answers, still the right way round.
    await expectWarmBothKinds(filePath, cacheDir, [asMarkdown, asHtml]);
  });
});

describe('parseFileCached — fail-soft and failure propagation', () => {
  const suite = setupParseFileCachedSuite();
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  it('parses correctly with the cache disabled, and writes nothing', async () => {
    const cacheDir = await suite.freshCacheDir();
    const guide = suite.file('guide.md');
    const page = suite.file('page.html');

    const disabled = new ParseCache({ cacheDir, enabled: false });
    expect(await parseFileCached(guide, 'markdown', disabled)).toStrictEqual(
      await parseMarkdown(guide),
    );
    expect(await parseFileCached(page, 'html', disabled)).toStrictEqual(await parseHtml(page));

    // Every lookup is a miss, including the ones that short-circuit…
    expect(disabled.stats).toStrictEqual({ hits: 0, misses: 2 });
    // …and nothing reached disk. Asserted against a nonzero twin below, because
    // "zero entries" is also what a cache pointed at the wrong directory reports.
    expect(await entryCount(cacheDir)).toBe(0);

    const enabled = new ParseCache({ cacheDir });
    await bothKinds(guide, enabled);
    expect(await entryCount(cacheDir)).toBe(2);
  });

  it('rejects when the file cannot be read', async () => {
    const cache = new ParseCache({ cacheDir: await suite.freshCacheDir() });
    const missing = suite.file('no-such-file.md');

    await expect(parseFileCached(missing, 'markdown', cache)).rejects.toThrow(/ENOENT/);

    // A read failure is the caller's, exactly as it was with `parseMarkdown`:
    // the cache is never consulted, so it cannot silently answer for a file it
    // has no bytes for.
    expect(cache.stats).toStrictEqual({ hits: 0, misses: 0 });

    // The positive twin: the same cache on a real path resolves, so the
    // rejection above is about the missing file and not about the setup.
    await expect(parseFileCached(suite.file('guide.md'), 'markdown', cache)).resolves.toBeDefined();
  });
});

describe('parseFileCached — no aliasing across hits', () => {
  const suite = setupParseFileCachedSuite();
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  it('never lets a mutation on one hit reach the next', async () => {
    const filePath = suite.file('guide.md');
    const cacheDir = await suite.freshCacheDir();

    // Populate, then take two independent hits over the same entry.
    const cold = new ParseCache({ cacheDir });
    await parseFileCached(filePath, 'markdown', cold);
    expect(cold.stats).toStrictEqual({ hits: 0, misses: 1 });

    const warm = new ParseCache({ cacheDir });
    const first = await parseFileCached(filePath, 'markdown', warm);
    const firstHitStats = warm.stats;

    // `skill-packager.ts` assigns `link.resolvedId` in place while bundling. If
    // two callers shared one object graph, one skill's bundling decision would
    // change which branch another skill's link walker takes.
    firstLink(first).resolvedId = 'first-only';

    const second = await parseFileCached(filePath, 'markdown', warm);

    // Both reads were hits — a miss would re-parse and produce a fresh graph for
    // reasons that have nothing to do with the cache's aliasing behaviour, which
    // is precisely how this assertion would go vacuous.
    expect(firstHitStats).toStrictEqual({ hits: 1, misses: 0 });
    expect(warm.stats).toStrictEqual({ hits: 2, misses: 0 });

    // The positive twin for the negative below: the mutation did land somewhere.
    expect(firstLink(first).resolvedId).toBe('first-only');
    expect(firstLink(second).resolvedId).toBeUndefined();

    // Reference identity, not deep equality: the two are deeply equal by
    // construction, which is exactly why aliasing is invisible without `not.toBe`.
    expect(first.links).not.toBe(second.links);
    expect(firstLink(first)).not.toBe(firstLink(second));
    expect(first.headings).not.toBe(second.headings);
  });
});
