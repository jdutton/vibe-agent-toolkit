import { mkdtempSync, truncateSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { MAX_DECODABLE_BYTES } from '@vibe-agent-toolkit/utils/fs';
import { beforeEach, describe, expect, it } from 'vitest';

import { readContentWithKey } from '../src/content-key.js';
import { POPULATION_PARSE_LIMITS, RunContentCache, readKeyedContent } from '../src/projection/content-cache.js';

const DOC = 'doc.md';
const ORIGINAL = '# original\n';

let root: string;

/** The fixture document's absolute path. */
function docPath(): string {
  return safePath.join(root, DOC);
}

beforeEach(() => {
  root = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-content-cache-')));
  writeFileSync(docPath(), ORIGINAL);
});

describe('RunContentCache', () => {
  it('reads a path once however many times it is asked for', async () => {
    const cache = new RunContentCache();

    const first = await cache.read(docPath(), 'markdown');
    const second = await cache.read(docPath(), 'markdown');

    // Identity, not equality: a second read that produced an equal value would
    // still have traversed the file, which is the cost this exists to remove.
    expect(second).toBe(first);
    expect(cache.stats).toEqual({
      hits: 1,
      misses: 1,
      entries: 1,
      bytesHeld: Buffer.byteLength(ORIGINAL),
    });
  });

  it('serves the first read after the file changes, so one run sees one instant', async () => {
    const cache = new RunContentCache();
    const first = await cache.read(docPath(), 'markdown');
    writeFileSync(docPath(), '# rewritten mid-run\n');

    const later = await cache.read(docPath(), 'markdown');

    expect(later.content).toBe(ORIGINAL);
    expect(later.key).toBe(first.key);
    // And the rewrite really did land — otherwise this test would pass against a
    // cache that does nothing.
    expect((await readContentWithKey(docPath(), 'markdown', null)).key).not.toBe(first.key);
  });

  it('does not serve one parser kind the other one’s entry', async () => {
    const cache = new RunContentCache();

    const asMarkdown = await cache.read(docPath(), 'markdown');
    const asHtml = await cache.read(docPath(), 'html');

    // Same bytes, two keys: `computeContentKey` mixes the parser kind into the
    // preimage, so a cache keyed on the path alone would hand one route the
    // other's key — a well-formed value with the wrong contents.
    expect(asHtml.key).not.toBe(asMarkdown.key);
    expect(asHtml.parserKind).toBe('html');
    expect(cache.stats.entries).toBe(2);
    expect(cache.stats.hits).toBe(0);
  });

  it('does not cache a failed read', async () => {
    const cache = new RunContentCache();
    const missing = safePath.join(root, 'absent.md');

    await expect(cache.read(missing, 'markdown')).rejects.toThrow();
    writeFileSync(missing, '# arrived late\n');

    // A throw is not a value. A negatively-cached miss would make a file that
    // appeared during the run permanently unreadable to it.
    expect((await cache.read(missing, 'markdown')).content).toBe('# arrived late\n');
  });
});

describe('readKeyedContent', () => {
  it('reads straight from disk when the cache is null', async () => {
    const direct = await readKeyedContent(docPath(), 'markdown', null);
    writeFileSync(docPath(), '# rewritten\n');

    const again = await readKeyedContent(docPath(), 'markdown', null);

    // The uncached path must stay a real read: it is what the blob stage's
    // content-changed and unreadable branches are still reachable through.
    expect(again.key).not.toBe(direct.key);
  });

  it('reads through the cache when one is supplied', async () => {
    const cache = new RunContentCache();

    await readKeyedContent(docPath(), 'markdown', cache);
    await readKeyedContent(docPath(), 'markdown', cache);

    expect(cache.stats.hits).toBe(1);
  });
});

describe('POPULATION_PARSE_LIMITS', () => {
  it('caps a population\'s input at no more than a string can hold, so the cap, not a decode, refuses an oversize file', () => {
    // An `oversize` realization of a parsed kind is reported as refused at the input cap
    // (`blob-refusals.ts`), which is true only while every file too large to decode is also past it.
    expect(POPULATION_PARSE_LIMITS.inputBytes).toBeLessThanOrEqual(MAX_DECODABLE_BYTES);
  });

  it('is the one cap a run\'s reads are held to: a parsed kind one byte past it is refused, never read', async () => {
    // Sparse, so the read the cap prevents would cost nothing if it happened.
    const past = safePath.join(root, 'past.md');
    writeFileSync(past, '');
    truncateSync(past, POPULATION_PARSE_LIMITS.inputBytes + 1);
    const at = safePath.join(root, 'at.md');
    writeFileSync(at, '');
    truncateSync(at, POPULATION_PARSE_LIMITS.inputBytes);
    const cache = new RunContentCache();

    await expect(cache.read(past, 'markdown')).rejects.toMatchObject({ limit: 'inputBytes' });
    await expect(cache.read(at, 'markdown')).resolves.toMatchObject({ byteLength: POPULATION_PARSE_LIMITS.inputBytes });
  });
});
