import { mkdtempSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { MAX_DECODABLE_BYTES, mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';
import { beforeEach, describe, expect, it } from 'vitest';

import { readContentWithKey } from '../src/content-key.js';
import { NO_GIT_MEMBERS, POPULATION_PARSE_LIMITS, RunContentCache, readKeyedContent } from '../src/projection/content-cache.js';

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
    const cache = new RunContentCache(NO_GIT_MEMBERS);

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
    const cache = new RunContentCache(NO_GIT_MEMBERS);
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
    const cache = new RunContentCache(NO_GIT_MEMBERS);

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
    const cache = new RunContentCache(NO_GIT_MEMBERS);
    const missing = safePath.join(root, 'absent.md');

    await expect(cache.read(missing, 'markdown')).rejects.toThrow();
    writeFileSync(missing, '# arrived late\n');

    // A throw is not a value. A negatively-cached miss would make a file that
    // appeared during the run permanently unreadable to it.
    expect((await cache.read(missing, 'markdown')).content).toBe('# arrived late\n');
  });

  it('keys a path outside its members\' root from disk without asking for the members', async () => {
    let asked = 0;
    const cache = new RunContentCache({
      root: safePath.join(root, 'project'),
      resolve: () => {
        asked += 1;
        return null;
      },
    });

    await cache.read(docPath(), 'markdown');
    expect(asked).toBe(0);
    expect(cache.stats.misses).toBe(1);

    // A sibling whose name only starts with the root's is outside it too.
    writeFileSync(safePath.join(root, 'project.md'), ORIGINAL);
    await cache.read(safePath.join(root, 'project.md'), 'markdown');
    expect(asked).toBe(0);

    // The control: a path inside the root asks, once, so the zeros above are the root's doing.
    mkdirSyncReal(safePath.join(root, 'project'));
    writeFileSync(safePath.join(root, 'project', DOC), ORIGINAL);
    await cache.read(safePath.join(root, 'project', DOC), 'markdown');
    await cache.read(safePath.join(root, 'project', DOC), 'html');
    expect(asked).toBe(1);
  });

  it('asks for its members once even when resolving them throws, and rethrows that failure', async () => {
    let asked = 0;
    const failure = new Error('the snapshot failed');
    const cache = new RunContentCache({
      root,
      resolve: () => {
        asked += 1;
        throw failure;
      },
    });

    await expect(cache.read(docPath(), 'markdown')).rejects.toBe(failure);
    await expect(cache.key(docPath(), 'html')).rejects.toBe(failure);
    expect(asked).toBe(1);
  });

  it('answers how it keyed a root from the members it resolved, asking for them once with its reads', async () => {
    let asked = 0;
    const failure = new Error('the snapshot failed');
    const resolvingTo = (answer: 'none' | 'throws'): RunContentCache => new RunContentCache({
      root,
      resolve: () => {
        asked += 1;
        if (answer === 'throws') throw failure;
        return null;
      },
    });

    expect(new RunContentCache(NO_GIT_MEMBERS).memberKeysUnder(root)).toBe('disk');
    const none = resolvingTo('none');
    expect(none.memberKeysUnder(root), 'members that resolved to none key every file from disk').toBe('disk');
    await none.read(docPath(), 'markdown');
    expect(asked, 'the read shares the one resolve').toBe(1);
    expect(none.memberKeysUnder(safePath.join(normalizedTmpdir(), 'vat-content-cache-elsewhere')), 'a root beside the members asks nothing').toBe('disk');
    expect(asked).toBe(1);

    const throws = resolvingTo('throws');
    expect(() => throws.memberKeysUnder(root)).toThrow(failure);
    await expect(throws.read(docPath(), 'markdown')).rejects.toBe(failure);
    expect(asked).toBe(2);
  });

  it('reads a file whose decode is not plain UTF-8 once for both its content and its bytes', async () => {
    const bom = safePath.join(root, 'bom.md');
    writeFileSync(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(ORIGINAL)]));
    const cache = new RunContentCache(NO_GIT_MEMBERS);

    expect((await cache.read(bom, 'markdown')).content).toBe(ORIGINAL);
    const held = await cache.readWithBytes(bom, 'markdown');
    expect(held.bytes === null ? null : Buffer.from(held.bytes)).toEqual(readFileSync(bom));
    expect((await cache.readWithBytes(docPath(), 'markdown')).bytes, 'a plain UTF-8 read holds no bytes').toBeNull();
    expect(cache.stats).toMatchObject({ misses: 2, hits: 1 });
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
    const cache = new RunContentCache(NO_GIT_MEMBERS);

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
    const cache = new RunContentCache(NO_GIT_MEMBERS);

    await expect(cache.read(past, 'markdown')).rejects.toMatchObject({ limit: 'inputBytes' });
    await expect(cache.read(at, 'markdown')).resolves.toMatchObject({ byteLength: POPULATION_PARSE_LIMITS.inputBytes });
  });
});
