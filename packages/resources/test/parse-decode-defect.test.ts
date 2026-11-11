/**
 * A frontmatter decode that throws on the parent thread, on each route that
 * decodes there.
 *
 * The codec is loops end to end, so nothing about a document's size or depth
 * can make the parent's decode throw: a throw there is a VAT defect.
 *
 * - After a worker parse (`attachContent`), it is rethrown loud: never filed
 *   as a `BLOB_PARSE_FAILED` row the store would keep, never a per-file
 *   finding that blames the document.
 * - On a parse-cache hit (`rehydrate`), it is loud too; only an entry whose
 *   stored encoding is corrupt (`FRONTMATTER_VALUE_MALFORMED`) is a miss.
 *
 * The decode is made to throw by a seam (`decodeFails`), since no real input
 * reaches a throw any more. The worker runs the built codec, which the mock
 * does not touch, so only the parent's decode fails.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type KeyedContent, readContentWithKey } from '../src/content-key.js';
import type * as FrontmatterCodec from '../src/frontmatter-codec.js';
import { parseMarkdownContent } from '../src/link-parser.js';
import { ParseCache } from '../src/parse-cache.js';
import { classifyParseFailure } from '../src/parse-failure.js';
import { ParseDecodeDefectError } from '../src/parse-limits.js';
import { BLOB_PARSE_FAILED, populateBlobs } from '../src/projection/blob-population.js';
import { ResourceRegistry } from '../src/resource-registry.js';

import { baseBuilderForRoot, conditionsWithCode } from './blob-fixture-population.js';
import { setupSubdirTestSuite } from './test-helpers.js';

const seam = vi.hoisted(() => ({ decodeFails: false }));

vi.mock('../src/frontmatter-codec.js', async (importOriginal) => {
  const real = await importOriginal<typeof FrontmatterCodec>();
  return {
    ...real,
    decodeFrontmatterValue: (encoded: string): Record<string, unknown> => {
      if (seam.decodeFails) throw new TypeError('seeded decode defect');
      return real.decodeFrontmatterValue(encoded);
    },
  };
});

const suite = setupSubdirTestSuite('vat-parse-decode-defect-');

const DOCUMENT = '---\ntitle: Seeded\n---\n\n# Body\n';

describe('a frontmatter decode that throws on the parent thread', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);
  beforeEach(async () => {
    await writeFile(safePath.join(suite.tempDir, 'doc.md'), DOCUMENT, 'utf-8');
  });
  afterEach(() => {
    seam.decodeFails = false;
  });

  it('after a worker parse, fails the projection run loudly and files no BLOB_PARSE_FAILED', async () => {
    seam.decodeFails = true;
    const builder = await baseBuilderForRoot(suite.tempDir);

    await expectLoudDefect(populateBlobs(builder, { parseCache: new ParseCache({ enabled: false }) }));
    expect(conditionsWithCode(builder.build(), BLOB_PARSE_FAILED)).toHaveLength(0);
  });

  it('after a worker parse, fails the registry run loudly and records no finding', async () => {
    seam.decodeFails = true;
    const registry = new ResourceRegistry({ baseDir: suite.tempDir, parseCache: new ParseCache({ enabled: false }) });

    await expectLoudDefect(registry.addResources([safePath.join(suite.tempDir, 'doc.md')]));
    expect(registry.getParseRefusedResources()).toHaveLength(0);
  });

  it('on a cache hit, stays loud: a defect in the codec is not a corrupt entry', async () => {
    const { cache, keyed } = await cachedDocument();

    seam.decodeFails = true;

    await expect(cache.get(keyed)).rejects.toThrow('seeded decode defect');
  });

  it('on a cache hit whose stored encoding is corrupt, reads the entry as a miss', async () => {
    const { cache, cacheDir, keyed } = await cachedDocument();
    const [entry] = await filesUnder(cacheDir);
    if (entry === undefined) throw new Error('the cache filed no entry');
    const stored = JSON.parse(await readFile(entry, 'utf-8')) as { facts: { frontmatterValue?: string } };
    stored.facts.frontmatterValue = '{not json';
    await writeFile(entry, JSON.stringify(stored), 'utf-8');

    expect(await cache.get(keyed)).toBeNull();
  });
});

/**
 * Settle `run`, and assert it rejected with the decode defect — VAT's defect,
 * which the one classifier every per-file catch asks rethrows.
 */
async function expectLoudDefect(run: Promise<unknown>): Promise<void> {
  const outcome: unknown = await run.then(
    () => 'completed',
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(ParseDecodeDefectError);
  expect(() => classifyParseFailure(outcome)).toThrow(outcome as Error);
}

/** The test document, parsed and filed in a fresh cache that serves it back. */
async function cachedDocument(): Promise<{ cache: ParseCache; cacheDir: string; keyed: KeyedContent }> {
  const keyed = await readContentWithKey(safePath.join(suite.tempDir, 'doc.md'), 'markdown');
  const cacheDir = safePath.join(suite.tempDir, 'cache');
  const cache = new ParseCache({ cacheDir, enabled: true });
  await cache.set(keyed, parseMarkdownContent(keyed.content, keyed.byteLength));
  expect(await cache.get(keyed)).not.toBeNull();
  return { cache, cacheDir, keyed };
}

/** Every `.json` entry under a cache directory this test wrote (no links in it), at any depth. */
async function filesUnder(dir: string): Promise<string[]> {
  const names = await readdir(dir, { recursive: true });
  return names.filter((name) => name.endsWith('.json')).map((name) => safePath.join(dir, name));
}
