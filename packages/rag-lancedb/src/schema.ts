/**
 * LanceDB schema mapping
 *
 * Converts between RAGChunk and LanceDB row format with generic metadata support.
 * Uses duck typing for Zod v3/v4 compatibility.
 */

import type { CoreRAGChunk, DefaultRAGMetadata, RAGChunk } from '@vibe-agent-toolkit/rag';
import { DefaultRAGMetadataSchema } from '@vibe-agent-toolkit/rag';
import { getZodTypeName, unwrapZodType, ZodTypeNames } from '@vibe-agent-toolkit/utils';
import type { ZodObject, ZodRawShape, ZodTypeAny } from 'zod';

/**
 * Helper type: Serializes metadata to Arrow-compatible types with lowercase keys
 *
 * - Keys → lowercase (SQL convention)
 * - Array<T> → string (comma-separated)
 * - Date → number (Unix timestamp)
 * - Object → string (JSON)
 * - Optional fields → sentinel values (empty string, -1)
 */
export type SerializedMetadata<T extends Record<string, unknown>> = {
  [K in keyof T as Lowercase<string & K>]: T[K] extends Array<infer _U>
    ? string
    : T[K] extends Date
      ? number
      : T[K] extends object
        ? string
        : T[K] extends string | undefined
          ? string
          : T[K] extends number | undefined
            ? number
            : T[K];
};

/**
 * LanceDB row format (generic over metadata type)
 *
 * LanceDB stores data in Apache Arrow format with specific type requirements.
 * Custom metadata fields are stored as top-level columns for efficient filtering.
 *
 * BREAKING CHANGE v0.2.0: All column names are now lowercase (SQL convention).
 * BREAKING CHANGE v0.1.8: Metadata is now flattened to top-level columns instead of
 * nested under a `metadata` struct. This enables scale-efficient filtering on
 * indexes with 1000+ chunks.
 *
 * @template TMetadata - Custom metadata type (fields stored as top-level columns with lowercase names)
 */
export type LanceDBRow<TMetadata extends Record<string, unknown> = DefaultRAGMetadata> = {
  // Required by LanceDB for vector search
  vector: number[];

  // CoreRAGChunk fields (lowercase column names)
  chunkid: string;
  resourceid: string;
  content: string;
  contenthash: string;
  tokencount: number;
  chunkindex: number;
  totalchunks: number;
  embeddingmodel: string;
  embeddedat: number; // Unix timestamp
  previouschunkid: string; // Empty string sentinel
  nextchunkid: string; // Empty string sentinel

  // Resource content hash (for change detection)
  resourcecontenthash: string;

  // Vector search result fields (optional, only present in query results)
  _distance?: number; // Distance metric from LanceDB vector search
} & SerializedMetadata<TMetadata>; // Metadata fields spread at top level (lowercase)

/**
 * Get sentinel value for optional field based on inner type
 *
 * Note: Mixed return type (string | number) is intentional for Arrow serialization.
 * Different Zod types require different sentinel values.
 */
// eslint-disable-next-line sonarjs/function-return-type -- Arrow serialization requires mixed return type
function getSentinelForType(innerType: ZodTypeAny): string | number {
  const typeName = getZodTypeName(innerType);
  const isStringOrArray = typeName === ZodTypeNames.STRING || typeName === ZodTypeNames.ARRAY;
  const isNumberOrDate = typeName === ZodTypeNames.NUMBER || typeName === ZodTypeNames.DATE;

  if (isStringOrArray) return '';
  if (isNumberOrDate) return -1;
  return '';
}

/**
 * Serialize array to string
 *
 * - Arrays of primitives → comma-separated string
 * - Arrays of objects → JSON string
 */
function serializeArray(value: unknown): string {
  if (!Array.isArray(value)) return '';

  // Check if array contains objects
  const hasObjects = value.some((item) => typeof item === 'object' && item !== null);

  if (hasObjects) {
    return JSON.stringify(value);
  }

  return value.join(',');
}

/**
 * Serialize date to Unix timestamp
 */
function serializeDate(value: unknown): number {
  return value instanceof Date ? value.getTime() : -1;
}

/**
 * Serialize string value
 */
function serializeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Serialize number value
 */
function serializeNumber(value: unknown): number {
  return typeof value === 'number' ? value : -1;
}

/**
 * Serialize boolean to number (0 or 1)
 */
function serializeBoolean(value: unknown): number {
  return (typeof value === 'boolean' && value) ? 1 : 0;
}

/**
 * Serialize metadata value to Arrow-compatible type
 *
 * Runtime introspection of Zod schema to determine serialization strategy.
 *
 * Note: Mixed return type (string | number) is intentional for Arrow serialization.
 * Arrays, strings, objects → string; numbers, dates, booleans → number.
 */
// eslint-disable-next-line sonarjs/function-return-type -- Arrow serialization requires mixed return type
function serializeMetadataValue(value: unknown, zodType: ZodTypeAny): string | number {
  // Handle optional types by unwrapping
  const actualType = unwrapZodType(zodType);
  const typeName = getZodTypeName(actualType);

  // If value is undefined and type is optional, return sentinel
  if (value === undefined && typeName !== getZodTypeName(zodType)) {
    return getSentinelForType(actualType as ZodTypeAny);
  }

  // Type-specific serialization
  if (typeName === ZodTypeNames.ENUM || typeName === ZodTypeNames.NATIVENUM) return serializeString(value);
  if (typeName === ZodTypeNames.ARRAY) return serializeArray(value);
  if (typeName === ZodTypeNames.DATE) return serializeDate(value);
  if (typeName === ZodTypeNames.OBJECT) return JSON.stringify(value);
  if (typeName === ZodTypeNames.STRING) return serializeString(value);
  if (typeName === ZodTypeNames.NUMBER || typeName === ZodTypeNames.BIGINT) return serializeNumber(value);
  if (typeName === ZodTypeNames.BOOLEAN) return serializeBoolean(value);

  // Fallback: JSON stringify
  return JSON.stringify(value);
}

/**
 * Check if value is a sentinel for optional field
 */
function isSentinel(value: string | number, innerType: ZodTypeAny, isOptional: boolean): boolean {
  if (!isOptional) return false;

  const typeName = getZodTypeName(innerType);
  const isStringOrArray = typeName === ZodTypeNames.STRING || typeName === ZodTypeNames.ARRAY;
  const isNumberOrDate = typeName === ZodTypeNames.NUMBER || typeName === ZodTypeNames.DATE;
  const isStringSentinel = isStringOrArray && value === '';
  const isNumberSentinel = isNumberOrDate && value === -1;

  return isStringSentinel || isNumberSentinel;
}

/**
 * Deserialize array from string
 *
 * Handles both:
 * - Comma-separated strings → array of strings
 * - JSON strings → parsed array
 */
function deserializeArray(value: string | number, isOptional: boolean): unknown[] | undefined {
  const isEmptyOrInvalid = typeof value !== 'string' || value === '';
  if (isEmptyOrInvalid) {
    return isOptional ? undefined : [];
  }

  // Try JSON parsing first (for arrays of objects)
  if (value.startsWith('[')) {
    try {
      return JSON.parse(value);
    } catch {
      // Fall through to comma-separated parsing
    }
  }

  // Comma-separated strings
  return value.split(',');
}

/**
 * Deserialize date from Unix timestamp
 */
function deserializeDate(value: string | number, isOptional: boolean): Date | undefined {
  const isInvalid = typeof value !== 'number' || value === -1;
  if (isInvalid) {
    return isOptional ? undefined : new Date(0);
  }
  return new Date(value);
}

/**
 * Deserialize object from JSON string
 */
function deserializeObject(value: string | number, isOptional: boolean): Record<string, unknown> | undefined {
  const isEmptyOrInvalid = typeof value !== 'string' || value === '';
  if (isEmptyOrInvalid) {
    return isOptional ? undefined : {};
  }
  return JSON.parse(value);
}

/**
 * Deserialize string value
 */
function deserializeString(value: string | number, isOptional: boolean): string | undefined {
  if (typeof value === 'string') return value;
  return isOptional ? undefined : '';
}

/**
 * Deserialize number value
 */
function deserializeNumber(value: string | number, isOptional: boolean): number | undefined {
  if (typeof value === 'number') return value;
  return isOptional ? undefined : 0;
}

/**
 * Deserialize boolean from number (0 or 1)
 */
function deserializeBoolean(value: string | number): boolean {
  return typeof value === 'number' && value === 1;
}

/**
 * Deserialize fallback (parse JSON if string, else return value)
 */
function deserializeFallback(value: string | number): unknown {
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Deserialize metadata value from Arrow type to TypeScript type
 *
 * Runtime introspection of Zod schema to determine deserialization strategy.
 */
function deserializeMetadataValue(value: string | number, zodType: ZodTypeAny): unknown {
  // Handle optional types by unwrapping
  const actualType = unwrapZodType(zodType);
  const typeName = getZodTypeName(actualType);
  const isOptional = getZodTypeName(zodType) === ZodTypeNames.OPTIONAL;

  // Check for sentinel values
  if (isSentinel(value, actualType as ZodTypeAny, isOptional)) {
    return undefined;
  }

  // Type-specific deserialization
  if (typeName === ZodTypeNames.ENUM || typeName === ZodTypeNames.NATIVENUM) {
    return deserializeString(value, isOptional);
  }
  if (typeName === ZodTypeNames.ARRAY) return deserializeArray(value, isOptional);
  if (typeName === ZodTypeNames.DATE) return deserializeDate(value, isOptional);
  if (typeName === ZodTypeNames.OBJECT) return deserializeObject(value, isOptional);
  if (typeName === ZodTypeNames.STRING) return deserializeString(value, isOptional);
  if (typeName === ZodTypeNames.NUMBER || typeName === ZodTypeNames.BIGINT) {
    return deserializeNumber(value, isOptional);
  }
  if (typeName === ZodTypeNames.BOOLEAN) return deserializeBoolean(value);

  // Fallback
  return deserializeFallback(value);
}

/**
 * Serialize metadata object to Arrow-compatible format
 *
 * Uses Zod schema to introspect field types and apply correct serialization.
 */
export function serializeMetadata<TMetadata extends Record<string, unknown>>(
  metadata: TMetadata,
  schema: ZodObject<ZodRawShape>,
): SerializedMetadata<TMetadata> {
  const serialized: Record<string, string | number> = {};

  for (const [key, zodType] of Object.entries(schema.shape)) {
    const value = metadata[key];
    // Lowercase the key for database storage (SQL convention)
    serialized[key.toLowerCase()] = serializeMetadataValue(value, zodType);
  }

  return serialized as SerializedMetadata<TMetadata>;
}

/**
 * Deserialize metadata object from Arrow format to TypeScript types
 *
 * Uses Zod schema to introspect field types and apply correct deserialization.
 */
export function deserializeMetadata<TMetadata extends Record<string, unknown>>(
  serialized: SerializedMetadata<TMetadata>,
  schema: ZodObject<ZodRawShape>,
): TMetadata {
  const metadata: Record<string, unknown> = {};

  for (const [key, zodType] of Object.entries(schema.shape)) {
    // Lookup using lowercase key (database column name)
    const value = serialized[key.toLowerCase() as keyof SerializedMetadata<TMetadata>];
    // Type narrowing: value is always string | number from SerializedMetadata
    const deserialized = deserializeMetadataValue(value as string | number, zodType);
    if (deserialized !== undefined) {
      // Return with original case preserved (camelCase)
      metadata[key] = deserialized;
    }
  }

  return metadata as TMetadata;
}

/**
 * Convert CoreRAGChunk + Metadata to LanceDB row format
 *
 * Generic over metadata type. Uses Zod schema for runtime introspection.
 *
 * BREAKING CHANGE: Metadata fields are now spread at top level instead of
 * nested under `metadata` struct. This enables efficient filtering at scale.
 *
 * @param chunk - Chunk with CoreRAGChunk fields + custom metadata
 * @param resourceContentHash - Hash of the full resource content (for change detection)
 * @param metadataSchema - Zod schema for metadata type
 * @returns LanceDB row with metadata fields at top level
 */
export function chunkToLanceRow<TMetadata extends Record<string, unknown>>(
  chunk: CoreRAGChunk & TMetadata,
  resourceContentHash: string,
  metadataSchema: ZodObject<ZodRawShape>,
): LanceDBRow<TMetadata> {
  // Extract and serialize metadata by collecting all fields from the schema
  const metadata: Record<string, unknown> = {};
  for (const key of Object.keys(metadataSchema.shape)) {
    if (key in chunk) {
      metadata[key] = chunk[key as keyof typeof chunk];
    }
  }

  const serializedMetadata = serializeMetadata(metadata as TMetadata, metadataSchema);

  // Spread metadata first, then core fields override any collisions.
  // This prevents custom metadata schemas that reuse core column names
  // (e.g., chunkindex, totalchunks) from overwriting correctly populated values.
  // Use lowercase for all column names (SQL convention).
  // Type assertion needed: TS cannot verify intersection of explicit props + generic spread
  return {
    ...serializedMetadata,
    vector: chunk.embedding,
    chunkid: chunk.chunkId,
    resourceid: chunk.resourceId,
    content: chunk.content,
    contenthash: chunk.contentHash,
    resourcecontenthash: resourceContentHash,
    tokencount: chunk.tokenCount,
    chunkindex: chunk.chunkIndex ?? -1,
    totalchunks: chunk.totalChunks ?? -1,
    embeddingmodel: chunk.embeddingModel,
    embeddedat: chunk.embeddedAt.getTime(),
    previouschunkid: chunk.previousChunkId ?? '',
    nextchunkid: chunk.nextChunkId ?? '',
  } as LanceDBRow<TMetadata>;
}

/**
 * Convert LanceDB row to CoreRAGChunk + Metadata
 *
 * Generic over metadata type. Uses Zod schema for runtime introspection.
 *
 * BREAKING CHANGE: Metadata fields are now extracted from top level instead of
 * nested `metadata` struct.
 *
 * @param row - LanceDB row with metadata fields at top level
 * @param metadataSchema - Zod schema for metadata type
 * @returns Chunk with CoreRAGChunk fields + custom metadata
 */
export function lanceRowToChunk<TMetadata extends Record<string, unknown>>(
  row: LanceDBRow<TMetadata>,
  metadataSchema: ZodObject<ZodRawShape>,
): CoreRAGChunk & TMetadata {
  // Read from lowercase column names (SQL convention)
  const rowData = row as unknown as Record<string, unknown>;
  const coreChunk: CoreRAGChunk = {
    chunkId: rowData['chunkid'] as string,
    resourceId: rowData['resourceid'] as string,
    content: rowData['content'] as string,
    contentHash: rowData['contenthash'] as string,
    tokenCount: rowData['tokencount'] as number,
    embedding: rowData['vector'] as number[],
    embeddingModel: rowData['embeddingmodel'] as string,
    embeddedAt: new Date(rowData['embeddedat'] as number),
  };

  // Add chunk position fields if present
  const chunkIndex = rowData['chunkindex'] as number;
  if (chunkIndex >= 0) {
    coreChunk.chunkIndex = chunkIndex;
  }
  const totalChunks = rowData['totalchunks'] as number;
  if (totalChunks >= 0) {
    coreChunk.totalChunks = totalChunks;
  }

  // Add optional context fields if present
  const previousChunkId = rowData['previouschunkid'] as string;
  if (previousChunkId && previousChunkId.length > 0) {
    coreChunk.previousChunkId = previousChunkId;
  }
  const nextChunkId = rowData['nextchunkid'] as string;
  if (nextChunkId && nextChunkId.length > 0) {
    coreChunk.nextChunkId = nextChunkId;
  }

  // Add search result metrics if present (from vector search results)
  if (row._distance !== undefined) {
    coreChunk._distance = row._distance;
    // Compute similarity score: score = 1 / (1 + distance)
    // Range: 0-1 where 1 is perfect match, approaches 0 as distance increases
    coreChunk.score = 1 / (1 + row._distance);
  }

  // Extract serialized metadata from top-level row fields
  // Row has lowercase column names, so use lowercase to lookup
  const serializedMetadata: Record<string, string | number> = {};
  for (const key of Object.keys(metadataSchema.shape)) {
    const lowercaseKey = key.toLowerCase();
    if (lowercaseKey in row) {
      serializedMetadata[lowercaseKey] = row[lowercaseKey as keyof typeof row] as string | number;
    }
  }

  // Deserialize metadata
  const metadata = deserializeMetadata(
    serializedMetadata as SerializedMetadata<TMetadata>,
    metadataSchema
  );

  return { ...coreChunk, ...metadata };
}

/**
 * Backward-compatible wrapper: Convert RAGChunk to LanceDB row format
 *
 * Uses DefaultRAGMetadata schema automatically for existing code.
 * New code should use the generic chunkToLanceRow<TMetadata>() directly.
 *
 * @param chunk - RAGChunk (CoreRAGChunk + DefaultRAGMetadata)
 * @param resourceContentHash - Hash of the full resource content
 * @returns LanceDB row with default metadata
 */
export function chunkToLanceRowWithDefaultMetadata(
  chunk: RAGChunk,
  resourceContentHash: string,
): LanceDBRow<DefaultRAGMetadata> {
  return chunkToLanceRow(chunk, resourceContentHash, DefaultRAGMetadataSchema);
}

/**
 * Backward-compatible wrapper: Convert LanceDB row to RAGChunk
 *
 * Uses DefaultRAGMetadata schema automatically for existing code.
 * New code should use the generic lanceRowToChunk<TMetadata>() directly.
 *
 * @param row - LanceDB row with default metadata
 * @returns RAGChunk (CoreRAGChunk + DefaultRAGMetadata)
 */
export function lanceRowToChunkWithDefaultMetadata(row: LanceDBRow<DefaultRAGMetadata>): RAGChunk {
  return lanceRowToChunk(row, DefaultRAGMetadataSchema);
}
