/**
 * LanceDB RAG Provider
 *
 * Implements both RAGQueryProvider and RAGAdminProvider using LanceDB.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { Connection, Table } from '@lancedb/lancedb';
import * as lancedb from '@lancedb/lancedb';
import type {
  CoreRAGChunk,
  DefaultRAGMetadata,
  EmbeddingProvider,
  IndexProgress,
  IndexResult,
  RAGAdminProvider,
  RAGQuery,
  RAGResult,
  RAGStats,
} from '@vibe-agent-toolkit/rag';
import {
  ApproximateTokenCounter,
  chunkResource,
  DefaultRAGMetadataSchema,
  enrichChunks,
  generateContentHash,
  TransformersEmbeddingProvider,
} from '@vibe-agent-toolkit/rag';
import { parseMarkdown, type ResourceMetadata } from '@vibe-agent-toolkit/resources';
import type { ZodObject, ZodRawShape } from 'zod';

import { buildWhereClause, escapeSQLString } from './filter-builder.js';
import {
  chunkToLanceRow,
  lanceRowToChunk,
  type LanceDBRow,
} from './schema.js';

/**
 * Configuration for LanceDBRAGProvider (generic over metadata type)
 */
export interface LanceDBConfig<_TMetadata extends Record<string, unknown> = DefaultRAGMetadata> {
  /** Path to LanceDB database directory */
  dbPath: string;

  /** Readonly mode (query only) */
  readonly?: boolean;

  /** Embedding provider (default: TransformersEmbeddingProvider) */
  embeddingProvider?: EmbeddingProvider;

  /** Target chunk size in tokens (default: 512) */
  targetChunkSize?: number;

  /** Padding factor for token estimation (default: 0.9) */
  paddingFactor?: number;

  /** Metadata schema for validation and serialization (defaults to DefaultRAGMetadataSchema) */
  metadataSchema?: ZodObject<ZodRawShape>;
}

/**
 * Calculate total size of a directory recursively
 * @param dirPath - Path to directory
 * @returns Total size in bytes
 */
function getDirectorySize(dirPath: string): number {
  let totalSize = 0;

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirPath is from config, not user input
    const items = fs.readdirSync(dirPath);

    for (const item of items) {
      const itemPath = path.join(dirPath, item);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- itemPath is constructed from config, not user input
      const stats = fs.statSync(itemPath);

      if (stats.isDirectory()) {
        totalSize += getDirectorySize(itemPath);
      } else {
        totalSize += stats.size;
      }
    }
  } catch {
    // If directory doesn't exist or can't be read, return 0
    return 0;
  }

  return totalSize;
}

const TABLE_NAME = 'rag_chunks';

/**
 * Required configuration after defaults applied
 */
interface RequiredLanceDBConfig<_TMetadata extends Record<string, unknown>> {
  dbPath: string;
  readonly: boolean;
  embeddingProvider: EmbeddingProvider;
  targetChunkSize: number;
  paddingFactor: number;
  metadataSchema: ZodObject<ZodRawShape>;
}

/**
 * LanceDBRAGProvider (generic over metadata type)
 *
 * Complete RAG implementation using LanceDB for vector storage.
 * Users must explicitly specify the metadata type when using custom schemas.
 */
export class LanceDBRAGProvider<TMetadata extends Record<string, unknown> = DefaultRAGMetadata>
  implements RAGAdminProvider<TMetadata> {
  private readonly config: RequiredLanceDBConfig<TMetadata>;
  private readonly metadataSchema: ZodObject<ZodRawShape>;
  private connection: Connection | null = null;
  private table: Table | null = null;
  private readonly tokenCounter = new ApproximateTokenCounter();

  private constructor(config: LanceDBConfig<TMetadata>) {
    this.config = {
      readonly: false,
      embeddingProvider: new TransformersEmbeddingProvider(),
      targetChunkSize: 512,
      paddingFactor: 0.9,
      metadataSchema: DefaultRAGMetadataSchema,
      ...config,
    };
    this.metadataSchema = this.config.metadataSchema;
  }

  /**
   * Create and initialize LanceDBRAGProvider
   *
   * For custom metadata types, specify the type parameter explicitly:
   *
   * @param config - Configuration with optional metadataSchema
   * @returns Initialized provider
   *
   * @example
   * ```typescript
   * // Default metadata (DefaultRAGMetadata)
   * const provider = await LanceDBRAGProvider.create({
   *   dbPath: './db',
   * });
   *
   * // Custom metadata (explicit type parameter required)
   * type CustomMetadata = { domain: string; priority: number };
   * const CustomSchema = z.object({ domain: z.string(), priority: z.number() });
   * const customProvider = await LanceDBRAGProvider.create<CustomMetadata>({
   *   dbPath: './db',
   *   metadataSchema: CustomSchema,
   * });
   * ```
   */
  static async create<TMetadata extends Record<string, unknown> = DefaultRAGMetadata>(
    config: LanceDBConfig<TMetadata>
  ): Promise<LanceDBRAGProvider<TMetadata>> {
    const provider = new LanceDBRAGProvider<TMetadata>(config);
    await provider.initialize();
    return provider;
  }

  /**
   * Initialize database connection and table
   */
  private async initialize(): Promise<void> {
    await this.reconnectAndOpenTable();
  }

  /**
   * Reconnect and open table (workaround for vectordb@0.4.20 + Bun Arrow buffer lifecycle bug)
   */
  private async reconnectAndOpenTable(): Promise<void> {
    this.connection = await lancedb.connect(this.config.dbPath);

    const tableNames = await this.connection.tableNames();
    if (tableNames.includes(TABLE_NAME)) {
      this.table = await this.connection.openTable(TABLE_NAME);
    } else {
      // Table doesn't exist
      // In admin mode: will be created on first insert
      // In readonly mode: operations that require table will fail gracefully
      this.table = null;
    }
  }

  /**
   * Query the RAG database
   */
  async query(query: RAGQuery<TMetadata>): Promise<RAGResult<TMetadata>> {
    // Workaround for vectordb@0.4.20 + Bun Arrow buffer lifecycle bug
    // After table modifications, we need to recreate the connection entirely
    await this.reconnectAndOpenTable();

    if (!this.table) {
      throw new Error('No data indexed yet');
    }

    const startTime = Date.now();

    // Embed query text
    const queryEmbedding = await this.config.embeddingProvider.embed(query.text);

    // Perform vector search
    let search = this.table.vectorSearch(queryEmbedding).limit(query.limit ?? 10);

    // Apply filters if provided
    if (query.filters) {
      const whereClause = buildWhereClause(query.filters, this.metadataSchema);
      if (whereClause) {
        search = search.where(whereClause);
      }
    }

    const results = await search.toArray();

    // Convert results to plain objects immediately to avoid Arrow buffer issues
    // eslint-disable-next-line unicorn/prefer-structured-clone -- JSON.parse/stringify is intentional workaround for Arrow buffer lifecycle bug
    const materializedResults = JSON.parse(JSON.stringify(results)) as LanceDBRow<TMetadata>[];

    // Convert results to RAGChunks using the metadata schema
    const chunks = materializedResults.map((row) => lanceRowToChunk<TMetadata>(row, this.metadataSchema));

    const searchDurationMs = Date.now() - startTime;

    return {
      chunks,
      stats: {
        totalMatches: chunks.length,
        searchDurationMs,
        embedding: {
          model: this.config.embeddingProvider.model,
        },
      },
    };
  }


  /**
   * Get database statistics
   */
  async getStats(): Promise<RAGStats> {
    // Workaround for vectordb@0.4.20 + Bun Arrow buffer lifecycle bug
    // After table modifications, we need to recreate the connection entirely
    await this.reconnectAndOpenTable();

    if (!this.table) {
      return {
        totalChunks: 0,
        totalResources: 0,
        dbSizeBytes: 0,
        embeddingModel: this.config.embeddingProvider.model,
        lastIndexed: new Date(0),
      };
    }

    const count = await this.table.countRows();

    // Get unique resource count (use a condition that matches all rows)
    const allRows = await this.table.query().where('1 = 1').toArray();
    // Materialize immediately to avoid Arrow buffer issues
    // eslint-disable-next-line unicorn/prefer-structured-clone -- JSON.parse/stringify is intentional workaround for Arrow buffer lifecycle bug
    const rows = JSON.parse(JSON.stringify(allRows)) as LanceDBRow[];
    const uniqueResources = new Set(rows.map((r) => r.resourceid)).size;

    // Calculate database size by traversing the directory
    const dbSizeBytes = getDirectorySize(this.config.dbPath);

    return {
      totalChunks: count,
      totalResources: uniqueResources,
      dbSizeBytes,
      embeddingModel: this.config.embeddingProvider.model,
      lastIndexed: new Date(), // Would need to track this separately
    };
  }

  /**
   * Index resources into the RAG database
   */
  async indexResources(
    resources: ResourceMetadata[],
    onProgress?: (progress: IndexProgress) => void
  ): Promise<IndexResult> {
    if (this.config.readonly) {
      throw new Error('Cannot index in readonly mode');
    }

    const startTime = Date.now();
    const totalResources = resources.length;
    const result: IndexResult = {
      resourcesIndexed: 0,
      resourcesSkipped: 0,
      resourcesUpdated: 0,
      chunksCreated: 0,
      chunksDeleted: 0,
      durationMs: 0,
      errors: [],
    };

    let processedCount = 0;
    for (const resource of resources) {
      processedCount++;

      try {
        await this.indexResource(resource, result);
      } catch (error) {
        result.errors?.push({
          resourceId: resource.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Call progress callback after each resource
      if (onProgress) {
        const elapsedMs = Date.now() - startTime;
        const avgTimePerResource = elapsedMs / processedCount;
        const remainingResources = totalResources - processedCount;
        const estimatedRemainingMs = remainingResources > 0 ? Math.round(avgTimePerResource * remainingResources) : 0;

        onProgress({
          current: processedCount,
          total: totalResources,
          resourcesIndexed: result.resourcesIndexed,
          resourcesSkipped: result.resourcesSkipped,
          resourcesUpdated: result.resourcesUpdated,
          chunksCreated: result.chunksCreated,
          elapsedMs,
          estimatedRemainingMs,
          resourceId: resource.id,
          errors: result.errors ?? [],
        });
      }
    }

    result.durationMs = Date.now() - startTime;
    return result;
  }

  /**
   * Index a single resource
   */
  private async indexResource(
    resource: ResourceMetadata,
    result: IndexResult
  ): Promise<void> {
    // Read file content using parseMarkdown
    const parseResult = await parseMarkdown(resource.filePath);

    // Generate content hash for change detection
    const resourceContentHash = generateContentHash(parseResult.content);

    // Check if resource already exists with same content hash
    // Extract all needed data BEFORE any table modifications to avoid Arrow buffer issues
    let shouldSkip = false;
    let deleteCount = 0;
    let shouldUpdate = false;

    if (this.table) {
      const existingRows = await this.table.query().where(`resourceid = '${escapeSQLString(resource.id)}'`).toArray();
      // Materialize immediately to avoid Arrow buffer issues
      // eslint-disable-next-line unicorn/prefer-structured-clone -- JSON.parse/stringify is intentional workaround for Arrow buffer lifecycle bug
      const existing = JSON.parse(JSON.stringify(existingRows)) as LanceDBRow[];

      // Extract data immediately while Arrow buffers are valid
      if (existing.length > 0) {
        const existingHash = existing[0]?.resourcecontenthash;
        deleteCount = existing.length;

        if (existingHash === resourceContentHash) {
          shouldSkip = true;
        } else {
          shouldUpdate = true;
        }
      }
    }

    // Handle skip case
    if (shouldSkip) {
      result.resourcesSkipped++;
      return;
    }

    // Delete old chunks if updating
    if (shouldUpdate) {
      await this.deleteResource(resource.id);
      result.chunksDeleted += deleteCount;
      result.resourcesUpdated++;
    }

    // Chunk the resource
    const chunkingResult = chunkResource(
      {
        ...resource,
        content: parseResult.content,
        frontmatter: {},
      },
      {
        targetChunkSize: this.config.targetChunkSize,
        modelTokenLimit: 8191,
        paddingFactor: this.config.paddingFactor,
        tokenCounter: this.tokenCounter,
      }
    );

    // Embed chunks
    const embeddings = await this.config.embeddingProvider.embedBatch(
      chunkingResult.chunks.map((c) => c.content)
    );

    // Enrich chunks with full metadata
    const chunkableResource = {
      ...resource,
      content: parseResult.content,
      frontmatter: {},
    };

    const ragChunks = enrichChunks(
      chunkingResult.chunks,
      chunkableResource,
      embeddings,
      this.config.embeddingProvider.model,
      this.tokenCounter,
    );

    // Add custom metadata from resource.frontmatter to each chunk
    // This allows custom metadata schemas to extract additional fields beyond the default ones
    const chunksWithMetadata = ragChunks.map((chunk) => {
      const chunkWithMetadata: Record<string, unknown> = { ...chunk };

      // Add metadata fields from frontmatter according to the schema
      if (resource.frontmatter) {
        for (const key of Object.keys(this.metadataSchema.shape)) {
          if (key in resource.frontmatter) {
            chunkWithMetadata[key] = resource.frontmatter[key];
          }
        }
      }

      return chunkWithMetadata as CoreRAGChunk & TMetadata;
    });

    // Convert to LanceDB rows using the metadata schema
    const rows = chunksWithMetadata.map((chunk) =>
      chunkToLanceRow<TMetadata>(chunk, resourceContentHash, this.metadataSchema)
    );

    // INSERT into LanceDB
    if (!this.table && this.connection) {
      this.table = await this.connection.createTable(TABLE_NAME, rows);
    } else if (this.table) {
      await this.table.add(rows);
    }

    result.resourcesIndexed++;
    result.chunksCreated += rows.length;
  }

  /**
   * Update a specific resource
   */
  async updateResource(_resourceId: string): Promise<void> {
    throw new Error('Not implemented - use indexResources() instead');
  }

  /**
   * Delete a specific resource and all its chunks
   *
   * @param resourceId - ID of resource to delete
   */
  async deleteResource(resourceId: string): Promise<void> {
    if (this.config.readonly) {
      throw new Error('Cannot delete in readonly mode');
    }

    if (!this.table) {
      return;
    }

    // Delete chunks (use lowercase column names)
    await this.table.delete(`resourceid = '${escapeSQLString(resourceId)}'`);
  }

  /**
   * Clear the entire database
   *
   * Deletes all data and removes the database directory.
   * This is a destructive operation that cannot be undone.
   */
  async clear(): Promise<void> {
    if (this.config.readonly) {
      throw new Error('Cannot clear in readonly mode');
    }

    // Close connection first
    await this.close();

    // Delete entire database directory
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dbPath comes from validated config
    if (fs.existsSync(this.config.dbPath)) {
      fs.rmSync(this.config.dbPath, { recursive: true, force: true });
    }
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    // LanceDB connections are automatically managed
    this.connection = null;
    this.table = null;
  }
}
