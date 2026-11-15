/**
 * `vat rag index` runs no parser on its own thread (ADR I8).
 *
 * The registry already parsed every resource through the one bounded route —
 * a worker, under its limits, with the parser its type names — and the indexer
 * chunks by the facts it handed over. What the indexer still needs from the
 * file is its text, so it reads the text and parses nothing: an HTML resource
 * is chunked by its HTML headings, never re-parsed as markdown, and a document
 * deep enough to overflow a main-thread parse indexes like any other.
 */

import { writeFile } from 'node:fs/promises';

import { ParseCache, ResourceRegistry } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LanceDBRAGProvider } from '../../src/lancedb-rag-provider.js';
import { createStubEmbeddingProvider, setupLanceDBTestSuite } from '../test-helpers.js';

/**
 * Blockquotes nested deeper than a main-thread parse survives: measured, 6,000
 * levels already overflow the main thread's stack and 8,000 parse in a 4 MiB
 * worker. 10,000 did too, but sometimes needed more than the 512 MiB heap an
 * integration fork's `--max-old-space-size=1024` leaves a worker, and was refused.
 */
const DEEP_QUOTE = `${'>'.repeat(8000)} deep`;

const suite = setupLanceDBTestSuite();

beforeEach(async () => {
  await suite.beforeEach();
  suite.provider = await LanceDBRAGProvider.create({
    dbPath: suite.dbPath,
    embeddingProvider: createStubEmbeddingProvider(),
  });
});

afterEach(suite.afterEach);

/**
 * Admit `files` through a registry, as `vat rag index` does.
 *
 * @param files - File name to content
 * @returns The registry's metadata for each, in the order given
 */
async function admitted(files: Record<string, string>): Promise<Awaited<ReturnType<ResourceRegistry['addResources']>>> {
  const paths: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const filePath = safePath.join(suite.tempDir, name);
    await writeFile(filePath, content, 'utf-8');
    paths.push(filePath);
  }
  const registry = new ResourceRegistry({ baseDir: suite.tempDir, parseCache: new ParseCache({ enabled: false }) });
  return registry.addResources(paths);
}

describe('rag indexing on the bounded parse route', () => {
  it('indexes an HTML resource by its HTML facts, never re-parsing it as markdown', async () => {
    // As markdown, the last line is 10,000 nested blockquotes; as HTML, it is text.
    const resources = await admitted({
      'page.html': `<h1 id="alpha">Alpha</h1>\n<p>alpha prose</p>\n\n${DEEP_QUOTE}\n`,
    });
    // The HTML parser's facts: an anchor, and no markdown headings.
    expect(resources.map((resource) => [resource.anchors, resource.headings])).toStrictEqual([[['alpha'], []]]);

    const result = await suite.provider?.indexResources(resources);

    expect(result?.errors).toStrictEqual([]);
    expect(result?.resourcesIndexed).toBe(1);
    // Chunked by those facts: unheaded, so no chunk claims a markdown section.
    const chunks = (await suite.provider?.query({ text: 'prose', limit: 50 }))?.chunks ?? [];
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((chunk) => chunk.headingPath)).toStrictEqual(chunks.map(() => undefined));
  });

  // The indexer re-hashes what it reads and refuses a mismatch with the
  // registry's checksum, so its hash must be the registry's for every text — a
  // BOM and multibyte characters are where a byte-vs-string preimage would split.
  it('indexes a non-ASCII document the registry admitted: the re-hash at use agrees with admission', async () => {
    const resources = await admitted({ 'intl.md': `${String.fromCodePoint(0xfe_ff)}# Café\n\nnaïve façade — 東京 and 🚀 prose.\n` });

    const result = await suite.provider?.indexResources(resources);

    expect(result?.errors).toStrictEqual([]);
    expect(result?.resourcesIndexed).toBe(1);
  });

  it('indexes a markdown document deep enough to overflow a main-thread parse', async () => {
    const resources = await admitted({ 'deep.md': `# Deep\n\nintro\n\n${DEEP_QUOTE}\n` });
    expect(resources).toHaveLength(1);

    const result = await suite.provider?.indexResources(resources);

    expect(result?.errors).toStrictEqual([]);
    expect(result?.resourcesIndexed).toBe(1);
    expect(result?.chunksCreated).toBeGreaterThan(0);
  });
});
