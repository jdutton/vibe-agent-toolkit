/**
 * Tests for LanceDB schema mapping
 */

import type { CoreRAGChunk } from '@vibe-agent-toolkit/rag';
import { DefaultRAGMetadataSchema } from '@vibe-agent-toolkit/rag';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import {
  chunkToLanceRow,
  lanceRowToChunk,
  serializeMetadata,
  deserializeMetadata,
} from '../src/schema.js';

// Test constants
const TEST_CHUNK_ID = 'chunk-1';
const TEST_RESOURCE_ID = 'resource-1';
const TEST_FILE_PATH = '/test.md';
const TEST_MODEL = 'test-model';
const TEST_CONTENT_HASH = 'abc123';
const TEST_RESOURCE_CONTENT_HASH = 'def456';
const TEST_CONTENT = 'Test content';
const TEST_HEADING_PATH = 'Main > Sub';
const TEST_EMBEDDING = [0.1, 0.2, 0.3];
const TEST_DATE = new Date('2025-01-01T00:00:00.000Z');
const TEST_DOCUMENTATION_TYPE = 'documentation';
const TEST_TITLE = 'Test Title';

// Custom metadata schema for testing serialization
const CustomMetadataSchema = z.object({
  author: z.string(),
  publishedAt: z.date(),
  version: z.number(),
  categories: z.array(z.string()),
  config: z.object({ key: z.string() }),
});

type CustomMetadata = z.infer<typeof CustomMetadataSchema>;

// Create test chunk with custom metadata
function createTestChunkWithCustomMetadata(): CoreRAGChunk & CustomMetadata {
  return {
    chunkId: TEST_CHUNK_ID,
    resourceId: TEST_RESOURCE_ID,
    content: TEST_CONTENT,
    contentHash: TEST_CONTENT_HASH,
    tokenCount: 5,
    embedding: TEST_EMBEDDING,
    embeddingModel: TEST_MODEL,
    embeddedAt: TEST_DATE,
    author: 'Alice',
    publishedAt: TEST_DATE,
    version: 2,
    categories: ['tech', 'docs'],
    config: { key: 'value' },
  };
}

// Create test row factory with custom metadata parameter
function createTestRow(metadata: Record<string, unknown>) {
  return {
    chunkId: TEST_CHUNK_ID,
    resourceId: TEST_RESOURCE_ID,
    content: TEST_CONTENT,
    contentHash: TEST_CONTENT_HASH,
    resourceContentHash: TEST_RESOURCE_CONTENT_HASH,
    tokenCount: 5,
    vector: TEST_EMBEDDING,
    embeddingModel: TEST_MODEL,
    embeddedAt: TEST_DATE.getTime(),
    previousChunkId: '',
    nextChunkId: '',
    metadata,
  };
}

// Convenience wrappers for different metadata scenarios
const createTestRowWithDefaultMetadata = () =>
  createTestRow({
    filePath: TEST_FILE_PATH,
    tags: 'test,example',
    type: TEST_DOCUMENTATION_TYPE,
    title: TEST_TITLE,
    headingPath: TEST_HEADING_PATH,
    headingLevel: 2,
    startLine: 10,
    endLine: 20,
  });

const createTestRowWithSentinelValues = () =>
  createTestRow({
    filePath: TEST_FILE_PATH,
    tags: '',
    type: '',
    title: '',
    headingPath: '',
    headingLevel: -1,
    startLine: -1,
    endLine: -1,
  });

const createTestRowWithCustomMetadata = () =>
  createTestRow({
    author: 'Alice',
    publishedAt: TEST_DATE.getTime(),
    version: 2,
    categories: 'tech,docs',
    config: JSON.stringify({ key: 'value' }),
  });

describe('serializeMetadata', () => {
  it('should serialize strings', () => {
    const schema = z.object({ name: z.string() });
    const result = serializeMetadata({ name: 'Alice' }, schema);
    expect(result).toEqual({ name: 'Alice' });
  });

  it('should serialize optional strings to empty string sentinel', () => {
    const schema = z.object({ name: z.string().optional() });
    const result = serializeMetadata({}, schema);
    expect(result).toEqual({ name: '' });
  });

  it('should serialize numbers', () => {
    const schema = z.object({ age: z.number() });
    const result = serializeMetadata({ age: 42 }, schema);
    expect(result).toEqual({ age: 42 });
  });

  it('should serialize optional numbers to -1 sentinel', () => {
    const schema = z.object({ age: z.number().optional() });
    const result = serializeMetadata({}, schema);
    expect(result).toEqual({ age: -1 });
  });

  it('should serialize arrays to comma-separated strings', () => {
    const schema = z.object({ tags: z.array(z.string()) });
    const result = serializeMetadata({ tags: ['a', 'b', 'c'] }, schema);
    expect(result).toEqual({ tags: 'a,b,c' });
  });

  it('should serialize empty arrays to empty string', () => {
    const schema = z.object({ tags: z.array(z.string()) });
    const result = serializeMetadata({ tags: [] }, schema);
    expect(result).toEqual({ tags: '' });
  });

  it('should serialize optional arrays to empty string sentinel', () => {
    const schema = z.object({ tags: z.array(z.string()).optional() });
    const result = serializeMetadata({}, schema);
    expect(result).toEqual({ tags: '' });
  });

  it('should serialize dates to Unix timestamps', () => {
    const schema = z.object({ createdAt: z.date() });
    const result = serializeMetadata({ createdAt: TEST_DATE }, schema);
    expect(result).toEqual({ createdAt: TEST_DATE.getTime() });
  });

  it('should serialize optional dates to -1 sentinel', () => {
    const schema = z.object({ createdAt: z.date().optional() });
    const result = serializeMetadata({}, schema);
    expect(result).toEqual({ createdAt: -1 });
  });

  it('should serialize objects to JSON strings', () => {
    const schema = z.object({ config: z.object({ key: z.string() }) });
    const result = serializeMetadata({ config: { key: 'value' } }, schema);
    expect(result).toEqual({ config: JSON.stringify({ key: 'value' }) });
  });

  it('should serialize booleans to numbers', () => {
    const schema = z.object({ active: z.boolean() });
    const result = serializeMetadata({ active: true }, schema);
    expect(result).toEqual({ active: 1 });
  });
});

describe('deserializeMetadata', () => {
  it('should deserialize strings', () => {
    const schema = z.object({ name: z.string() });
    const result = deserializeMetadata({ name: 'Alice' }, schema);
    expect(result).toEqual({ name: 'Alice' });
  });

  it('should deserialize empty string sentinel to undefined for optional strings', () => {
    const schema = z.object({ name: z.string().optional() });
    const result = deserializeMetadata({ name: '' }, schema);
    expect(result).toEqual({});
  });

  it('should deserialize numbers', () => {
    const schema = z.object({ age: z.number() });
    const result = deserializeMetadata({ age: 42 }, schema);
    expect(result).toEqual({ age: 42 });
  });

  it('should deserialize -1 sentinel to undefined for optional numbers', () => {
    const schema = z.object({ age: z.number().optional() });
    const result = deserializeMetadata({ age: -1 }, schema);
    expect(result).toEqual({});
  });

  it('should deserialize comma-separated strings to arrays', () => {
    const schema = z.object({ tags: z.array(z.string()) });
    const result = deserializeMetadata({ tags: 'a,b,c' }, schema);
    expect(result).toEqual({ tags: ['a', 'b', 'c'] });
  });

  it('should deserialize empty string to undefined for optional arrays', () => {
    const schema = z.object({ tags: z.array(z.string()).optional() });
    const result = deserializeMetadata({ tags: '' }, schema);
    expect(result).toEqual({});
  });

  it('should deserialize Unix timestamps to dates', () => {
    const schema = z.object({ createdAt: z.date() });
    const result = deserializeMetadata({ createdAt: TEST_DATE.getTime() }, schema);
    expect(result).toEqual({ createdAt: TEST_DATE });
  });

  it('should deserialize -1 sentinel to undefined for optional dates', () => {
    const schema = z.object({ createdAt: z.date().optional() });
    const result = deserializeMetadata({ createdAt: -1 }, schema);
    expect(result).toEqual({});
  });

  it('should deserialize JSON strings to objects', () => {
    const schema = z.object({ config: z.object({ key: z.string() }) });
    const result = deserializeMetadata({ config: JSON.stringify({ key: 'value' }) }, schema);
    expect(result).toEqual({ config: { key: 'value' } });
  });

  it('should deserialize numbers to booleans', () => {
    const schema = z.object({ active: z.boolean() });
    const result = deserializeMetadata({ active: 1 }, schema);
    expect(result).toEqual({ active: true });
  });
});

describe('chunkToLanceRow (generic)', () => {
  it('should convert chunk with default metadata to LanceDB row', () => {
    const chunk: CoreRAGChunk & { filePath: string; tags?: string[]; type?: string; title?: string } = {
      chunkId: TEST_CHUNK_ID,
      resourceId: TEST_RESOURCE_ID,
      content: TEST_CONTENT,
      contentHash: TEST_CONTENT_HASH,
      tokenCount: 5,
      embedding: TEST_EMBEDDING,
      embeddingModel: TEST_MODEL,
      embeddedAt: TEST_DATE,
      filePath: TEST_FILE_PATH,
      tags: ['test', 'example'],
      type: TEST_DOCUMENTATION_TYPE,
      title: TEST_TITLE,
    };

    const row = chunkToLanceRow(chunk, TEST_RESOURCE_CONTENT_HASH, DefaultRAGMetadataSchema);

    expect(row.chunkId).toBe(TEST_CHUNK_ID);
    expect(row.resourceId).toBe(TEST_RESOURCE_ID);
    expect(row.content).toBe(TEST_CONTENT);
    expect(row.contentHash).toBe(TEST_CONTENT_HASH);
    expect(row.resourceContentHash).toBe(TEST_RESOURCE_CONTENT_HASH);
    expect(row.vector).toEqual(TEST_EMBEDDING);
    expect(row.embeddingModel).toBe(TEST_MODEL);
    expect(row.embeddedAt).toBe(TEST_DATE.getTime());
    // Access metadata via index signature for type safety
    expect(row.metadata.filePath).toBe(TEST_FILE_PATH);
    expect((row.metadata as Record<string, unknown>)['tags']).toBe('test,example');
    expect((row.metadata as Record<string, unknown>)['type']).toBe(TEST_DOCUMENTATION_TYPE);
    expect((row.metadata as Record<string, unknown>)['title']).toBe(TEST_TITLE);
  });

  it('should handle optional metadata fields with sentinel values', () => {
    const chunk: CoreRAGChunk & { filePath: string } = {
      chunkId: TEST_CHUNK_ID,
      resourceId: TEST_RESOURCE_ID,
      content: TEST_CONTENT,
      contentHash: TEST_CONTENT_HASH,
      tokenCount: 5,
      embedding: TEST_EMBEDDING,
      embeddingModel: TEST_MODEL,
      embeddedAt: TEST_DATE,
      filePath: TEST_FILE_PATH,
    };

    const row = chunkToLanceRow(chunk, TEST_RESOURCE_CONTENT_HASH, DefaultRAGMetadataSchema);
    const metadata = row.metadata as Record<string, unknown>;

    expect(metadata['tags']).toBe(''); // Empty string sentinel
    expect(metadata['type']).toBe(''); // Empty string sentinel
    expect(metadata['title']).toBe(''); // Empty string sentinel
    expect(metadata['headingLevel']).toBe(-1); // -1 sentinel
    expect(metadata['startLine']).toBe(-1); // -1 sentinel
    expect(metadata['endLine']).toBe(-1); // -1 sentinel
  });

  it('should serialize custom metadata types', () => {
    const chunk = createTestChunkWithCustomMetadata();
    const row = chunkToLanceRow(chunk, TEST_RESOURCE_CONTENT_HASH, CustomMetadataSchema);

    expect(row.metadata.author).toBe('Alice');
    expect(row.metadata.publishedAt).toBe(TEST_DATE.getTime());
    expect(row.metadata.version).toBe(2);
    expect(row.metadata.categories).toBe('tech,docs');
    expect(row.metadata.config).toBe(JSON.stringify({ key: 'value' }));
  });
});

describe('lanceRowToChunk (generic)', () => {
  it('should convert LanceDB row to chunk with default metadata', () => {
    const row = createTestRowWithDefaultMetadata();
    const chunk = lanceRowToChunk(row, DefaultRAGMetadataSchema);

    expect(chunk.chunkId).toBe(TEST_CHUNK_ID);
    expect(chunk.embedding).toEqual(TEST_EMBEDDING);
    expect(chunk.embeddedAt).toEqual(TEST_DATE);
    expect(chunk.filePath).toBe(TEST_FILE_PATH);
    expect(chunk.tags).toEqual(['test', 'example']);
    expect(chunk.type).toBe(TEST_DOCUMENTATION_TYPE);
    expect(chunk.title).toBe(TEST_TITLE);
    expect(chunk.headingPath).toBe(TEST_HEADING_PATH);
    expect(chunk.headingLevel).toBe(2);
    expect(chunk.startLine).toBe(10);
    expect(chunk.endLine).toBe(20);
  });

  it('should handle sentinel values as undefined', () => {
    const row = createTestRowWithSentinelValues();
    const chunk = lanceRowToChunk(row, DefaultRAGMetadataSchema);

    expect(chunk.filePath).toBe(TEST_FILE_PATH);
    expect(chunk.tags).toBeUndefined();
    expect(chunk.type).toBeUndefined();
    expect(chunk.title).toBeUndefined();
    expect(chunk.headingPath).toBeUndefined();
    expect(chunk.headingLevel).toBeUndefined();
    expect(chunk.startLine).toBeUndefined();
    expect(chunk.endLine).toBeUndefined();
  });

  it('should deserialize custom metadata types', () => {
    const row = createTestRowWithCustomMetadata();
    const chunk = lanceRowToChunk(row, CustomMetadataSchema);

    expect(chunk.author).toBe('Alice');
    expect(chunk.publishedAt).toEqual(TEST_DATE);
    expect(chunk.version).toBe(2);
    expect(chunk.categories).toEqual(['tech', 'docs']);
    expect(chunk.config).toEqual({ key: 'value' });
  });
});

describe('round-trip serialization', () => {
  it('should preserve all data through serialize → deserialize cycle (default metadata)', () => {
    const original = {
      filePath: TEST_FILE_PATH,
      tags: ['test', 'example'],
      type: 'documentation',
      title: TEST_TITLE,
      headingPath: TEST_HEADING_PATH,
      headingLevel: 2,
      startLine: 10,
      endLine: 20,
    };

    const serialized = serializeMetadata(original, DefaultRAGMetadataSchema);
    const deserialized = deserializeMetadata(serialized, DefaultRAGMetadataSchema);

    expect(deserialized).toEqual(original);
  });

  it('should preserve optional fields as undefined through round-trip', () => {
    const original = {
      filePath: TEST_FILE_PATH,
      // All optional fields omitted
    };

    const serialized = serializeMetadata(original, DefaultRAGMetadataSchema);
    const deserialized = deserializeMetadata(serialized, DefaultRAGMetadataSchema);

    expect(deserialized).toEqual({ filePath: TEST_FILE_PATH });
    // Access via index signature for optional fields
    const metadata = deserialized as Record<string, unknown>;
    expect(metadata['tags']).toBeUndefined();
    expect(metadata['type']).toBeUndefined();
    expect(metadata['title']).toBeUndefined();
    expect(metadata['headingPath']).toBeUndefined();
    expect(metadata['headingLevel']).toBeUndefined();
  });

  it('should preserve custom metadata through round-trip', () => {
    const ExtendedMetadataSchema = CustomMetadataSchema.extend({
      isPublic: z.boolean().optional(),
    });

    const original = {
      author: 'Alice',
      publishedAt: TEST_DATE,
      version: 2,
      categories: ['tech', 'docs'],
      config: { key: 'value' },
      isPublic: true,
    };

    const serialized = serializeMetadata(original, ExtendedMetadataSchema);
    const deserialized = deserializeMetadata(serialized, ExtendedMetadataSchema);

    expect(deserialized).toEqual(original);
  });

  it('should preserve full chunk through chunkToLanceRow → lanceRowToChunk cycle', () => {
    const chunk: CoreRAGChunk & {
      filePath: string;
      tags?: string[];
      type?: string;
      title?: string;
      headingPath?: string;
      headingLevel?: number;
    } = {
      chunkId: TEST_CHUNK_ID,
      resourceId: TEST_RESOURCE_ID,
      content: TEST_CONTENT,
      contentHash: TEST_CONTENT_HASH,
      tokenCount: 5,
      embedding: TEST_EMBEDDING,
      embeddingModel: TEST_MODEL,
      embeddedAt: TEST_DATE,
      previousChunkId: 'prev-chunk',
      nextChunkId: 'next-chunk',
      filePath: TEST_FILE_PATH,
      tags: ['test', 'example'],
      type: TEST_DOCUMENTATION_TYPE,
      title: TEST_TITLE,
      headingPath: TEST_HEADING_PATH,
      headingLevel: 2,
    };

    const row = chunkToLanceRow(chunk, TEST_RESOURCE_CONTENT_HASH, DefaultRAGMetadataSchema);
    const restored = lanceRowToChunk(row, DefaultRAGMetadataSchema);

    // Core fields
    expect(restored.chunkId).toBe(chunk.chunkId);
    expect(restored.resourceId).toBe(chunk.resourceId);
    expect(restored.content).toBe(chunk.content);
    expect(restored.contentHash).toBe(chunk.contentHash);
    expect(restored.tokenCount).toBe(chunk.tokenCount);
    expect(restored.embedding).toEqual(chunk.embedding);
    expect(restored.embeddingModel).toBe(chunk.embeddingModel);
    expect(restored.embeddedAt).toEqual(chunk.embeddedAt);
    expect(restored.previousChunkId).toBe(chunk.previousChunkId);
    expect(restored.nextChunkId).toBe(chunk.nextChunkId);

    // Metadata fields
    expect(restored.filePath).toBe(chunk.filePath);
    expect(restored.tags).toEqual(chunk.tags);
    expect(restored.type).toBe(chunk.type);
    expect(restored.title).toBe(chunk.title);
    expect(restored.headingPath).toBe(chunk.headingPath);
    expect(restored.headingLevel).toBe(chunk.headingLevel);
  });
});
