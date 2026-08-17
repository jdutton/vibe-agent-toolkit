/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
import { mkdtempSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { beforeEach, describe, expect, it } from 'vitest';

import { readContentWithKey } from '../src/content-key.js';
import { RunContentCache, readKeyedContent } from '../src/projection/content-cache.js';

const DOC = 'doc.md';
const ORIGINAL = '# original\n';
/** A second document, so two paths can share one hint. */
const OTHER = 'other.md';
/** Stands in for a blob OID: the value's shape is irrelevant, its reuse is not. */
const SHARED_HINT = 'oid-shared';

let root: string;

/** The fixture document's absolute path. */
function docPath(): string {
  return safePath.join(root, DOC);
}

/** The second fixture document's absolute path. */
function otherPath(): string {
  return safePath.join(root, OTHER);
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
      hintHits: 0,
      entries: 1,
      bytesHeld: Buffer.byteLength(ORIGINAL),
    });
  });

  describe('content hints', () => {
    it('serves a second path from the first path\'s bytes without reading it', async () => {
      const cache = new RunContentCache();
      // Deliberately DIFFERENT bytes on disk. A hint asserts byte identity, so a
      // cache that honoured it while still reading would return these — which is
      // exactly what makes this a proof that no read happened, rather than a
      // proof that two identical files produce identical results.
      writeFileSync(otherPath(), '# these bytes are never read\n');

      const first = await cache.read(docPath(), 'markdown', SHARED_HINT);
      const second = await cache.read(otherPath(), 'markdown', SHARED_HINT);

      expect(second).toBe(first);
      expect(second.content).toBe(ORIGINAL);
      expect(cache.stats.hintHits).toBe(1);
      // One read, not two — the whole point.
      expect(cache.stats.misses).toBe(1);
    });

    it('files the key hashed from bytes, never the hint itself', async () => {
      const cache = new RunContentCache();

      const keyed = await cache.read(docPath(), 'markdown', SHARED_HINT);

      // `content-key.ts`'s standing rule: a git SHA may be a lookup whose miss is
      // free and must never be the identity a parse is filed under.
      expect(keyed.key).not.toContain(SHARED_HINT);
      expect(keyed.key).toBe((await readContentWithKey(docPath(), 'markdown')).key);
    });

    it('does not let one hint serve two parser kinds', async () => {
      const cache = new RunContentCache();
      writeFileSync(otherPath(), ORIGINAL);

      const asMarkdown = await cache.read(docPath(), 'markdown', SHARED_HINT);
      const asHtml = await cache.read(otherPath(), 'html', SHARED_HINT);

      // Identical bytes, different parsers, therefore different identities — the
      // reason the parser kind is in the hash preimage and in this cache's key.
      expect(asHtml.key).not.toBe(asMarkdown.key);
      expect(cache.stats.hintHits).toBe(0);
    });

    it('reads normally when the hint has not been seen before', async () => {
      const cache = new RunContentCache();

      await cache.read(docPath(), 'markdown', 'oid-unseen');

      expect(cache.stats).toMatchObject({ hits: 0, misses: 1, hintHits: 0 });
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
    expect((await readContentWithKey(docPath(), 'markdown')).key).not.toBe(first.key);
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
  it('reads straight from disk when no cache is supplied', async () => {
    const direct = await readKeyedContent(docPath(), 'markdown');
    writeFileSync(docPath(), '# rewritten\n');

    const again = await readKeyedContent(docPath(), 'markdown');

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
