/**
 * Unit tests for document-helpers.ts pure logic functions.
 *
 * Tests overlayChunkMetadata and createDocumentRecord without
 * requiring a LanceDB connection.
 */

import type { CoreRAGChunk, TokenCounter } from '@vibe-agent-toolkit/rag';
import type { ResourceMetadata } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createDocumentRecord, missingDocumentColumns, overlayChunkMetadata } from '../src/document-helpers.js';

/** Minimal stub token counter for tests */
const stubTokenCounter: TokenCounter = {
  name: 'stub',
  count: (text: string) => text.split(/\s+/).length,
  countBatch: (texts: string[]) => texts.map((t) => t.split(/\s+/).length),
};

/** Schema with two metadata fields for testing */
const testSchema = z.object({
  category: z.string(),
  priority: z.number(),
});

function makeChunk(overrides?: Partial<CoreRAGChunk>): CoreRAGChunk {
  return {
    chunkId: 'chunk-1',
    content: 'test content',
    contentHash: 'hash-1',
    resourceId: 'res-1',
    embedding: [0.1, 0.2],
    embeddingModel: 'test-model',
    embeddedAt: new Date(),
    tokenCount: 2,
    chunkIndex: 0,
    totalChunks: 1,
    ...overrides,
  };
}

function makeResource(overrides?: Partial<ResourceMetadata>): ResourceMetadata {
  return {
    id: 'res-1',
    filePath: '/test/fixtures/test.md',
    links: [],
    headings: [],
    sizeBytes: 100,
    estimatedTokenCount: 20,
    modifiedAt: new Date(),
    checksum: 'abc123' as ResourceMetadata['checksum'],
    ...overrides,
  };
}

describe('overlayChunkMetadata', () => {
  it('should return chunks unchanged when frontmatter is undefined', () => {
    const chunks = [makeChunk()];
    const result = overlayChunkMetadata(chunks, undefined, testSchema);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ chunkId: 'chunk-1', content: 'test content' });
    expect(result[0]).not.toHaveProperty('category');
    expect(result[0]).not.toHaveProperty('priority');
  });

  it('should overlay matching frontmatter fields from the schema', () => {
    const chunks = [makeChunk()];
    const frontmatter = { category: 'guide', priority: 1, unrelated: 'ignored' };
    const result = overlayChunkMetadata(chunks, frontmatter, testSchema);

    expect(result[0]).toMatchObject({
      chunkId: 'chunk-1',
      category: 'guide',
      priority: 1,
    });
    // unrelated is not in schema, should not be overlaid
    expect(result[0]).not.toHaveProperty('unrelated');
  });

  it('should overlay only fields present in frontmatter', () => {
    const chunks = [makeChunk()];
    const frontmatter = { category: 'tutorial' }; // priority not present
    const result = overlayChunkMetadata(chunks, frontmatter, testSchema);

    expect(result[0]).toMatchObject({ category: 'tutorial' });
    expect(result[0]).not.toHaveProperty('priority');
  });

  it('should overlay metadata onto multiple chunks', () => {
    const chunks = [
      makeChunk({ chunkId: 'c1' }),
      makeChunk({ chunkId: 'c2' }),
      makeChunk({ chunkId: 'c3' }),
    ];
    const frontmatter = { category: 'api', priority: 5 };
    const result = overlayChunkMetadata(chunks, frontmatter, testSchema);

    expect(result).toHaveLength(3);
    for (const chunk of result) {
      expect(chunk).toMatchObject({ category: 'api', priority: 5 });
    }
  });

  it('should return empty array for empty chunks input', () => {
    const result = overlayChunkMetadata([], { category: 'x' }, testSchema);
    expect(result).toEqual([]);
  });
});

describe('createDocumentRecord', () => {
  it('should create a basic document record', () => {
    const resource = makeResource();
    const record = createDocumentRecord(resource, 'hello world', 'hash-1', 3, stubTokenCounter, testSchema);

    expect(record.resourceid).toBe('res-1');
    expect(record.filepath).toBe('/test/fixtures/test.md');
    expect(record.content).toBe('hello world');
    expect(record.contenthash).toBe('hash-1');
    expect(record.tokencount).toBe(2); // "hello world" = 2 words
    expect(record.totalchunks).toBe(3);
    expect(record.indexedat).toBeGreaterThan(0);
  });

  it('should overlay string and number frontmatter fields', () => {
    const resource = makeResource({
      frontmatter: { category: 'guide', priority: 1 },
    });
    const record = createDocumentRecord(resource, 'content', 'hash', 1, stubTokenCounter, testSchema);

    expect(record['category']).toBe('guide');
    expect(record['priority']).toBe(1);
  });

  /**
   * Serialization is the SCHEMA's call, exactly as it is for chunk rows: an
   * array field declared as one is stored comma-joined, and a value that does
   * not match its declared type is stored as that type's sentinel rather than
   * as a JSON string the reader would then have to guess at.
   */
  it('serializes frontmatter values by their declared type, as chunk rows do', () => {
    const arraySchema = z.object({ tags: z.array(z.string()), priority: z.number() });
    const resource = makeResource({
      frontmatter: { tags: ['a', 'b'], priority: 3 },
    });
    const record = createDocumentRecord(resource, 'content', 'hash', 1, stubTokenCounter, arraySchema);

    expect(record['tags']).toBe('a,b');
    expect(record['priority']).toBe(3);
  });

  it('should not include frontmatter fields not in schema', () => {
    const resource = makeResource({
      frontmatter: { category: 'ref', extraField: 'ignored' },
    });
    const record = createDocumentRecord(resource, 'content', 'hash', 1, stubTokenCounter, testSchema);

    expect(record['category']).toBe('ref');
    expect(record).not.toHaveProperty('extrafield');
    expect(record).not.toHaveProperty('extraField');
  });

  /**
   * Every schema column is present on every record, sentinel or not. The
   * documents table's Arrow schema is inferred from the first row written, so
   * a record that omitted the columns its document lacked gave the table the
   * first document's shape — and every later document carrying a column the
   * first did not was refused at insert time.
   */
  it('writes every schema column even when the resource has no frontmatter', () => {
    const resource = makeResource({ frontmatter: undefined });
    const record = createDocumentRecord(resource, 'some text here', 'hash', 2, stubTokenCounter, testSchema);

    expect(record.resourceid).toBe('res-1');
    expect(record.tokencount).toBe(3); // "some text here" = 3 words
    expect(record['category']).toBe('');
    expect(record['priority']).toBe(-1);
  });

  it('should lowercase frontmatter field keys', () => {
    const upperSchema = z.object({ Title: z.string() });
    const resource = makeResource({
      frontmatter: { Title: 'My Doc' },
    });
    const record = createDocumentRecord(resource, 'x', 'h', 1, stubTokenCounter, upperSchema);

    expect(record['title']).toBe('My Doc');
    expect(record).not.toHaveProperty('Title');
  });
});

/**
 * The columns a record carries that an older table lacks, each with the
 * sentinel its existing rows are to be filled with. The answer comes from the
 * table's own column list against the schema — no stored version number.
 */
describe('missingDocumentColumns', () => {
  const CORE_COLUMNS = ['resourceid', 'filepath', 'content', 'contenthash', 'tokencount', 'totalchunks', 'indexedat'];

  it('names every metadata column a v0.1.42-shaped table lacks, with the sentinel of its type', () => {
    // v0.1.42 wrote core columns plus only the frontmatter keys the first document had.
    const missing = missingDocumentColumns([...CORE_COLUMNS, 'category'], testSchema);

    expect(missing).toEqual([{ name: 'priority', fill: -1 }]);
  });

  it('lowercases the schema key before comparing, as the record does', () => {
    const missing = missingDocumentColumns(CORE_COLUMNS, z.object({ Title: z.string(), Rank: z.number().optional() }));

    expect(missing).toEqual([
      { name: 'title', fill: '' },
      { name: 'rank', fill: -1 },
    ]);
  });

  it('reports nothing for a table that already has every column', () => {
    expect(missingDocumentColumns([...CORE_COLUMNS, 'category', 'priority'], testSchema)).toEqual([]);
  });

  it('does not report a column the table has and the record lacks', () => {
    expect(missingDocumentColumns([...CORE_COLUMNS, 'category', 'priority', 'retired'], testSchema)).toEqual([]);
  });
});
