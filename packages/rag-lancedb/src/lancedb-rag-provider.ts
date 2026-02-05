/**
 * LanceDB RAG Provider
 *
 * Implements both RAGQueryProvider and RAGAdminProvider using LanceDB.
 */

import fs from 'node:fs';

import type { Connection, Table } from '@lancedb/lancedb';
import * as lancedb from '@lancedb/lancedb';
import type {
  EmbeddingProvider,
  IndexResult,
  RAGAdminProvider,
  RAGChunk,
  RAGQuery,
  RAGResult,
  RAGStats,
} from '@vibe-agent-toolkit/rag';
import {
  ApproximateTokenCounter,
  chunkResource,
  enrichChunks,
  generateContentHash,
  TransformersEmbeddingProvider,
} from '@vibe-agent-toolkit/rag';
import { parseMarkdown, type ResourceMetadata } from '@vibe-agent-toolkit/resources';

import { chunkToLanceRow, lanceRowToChunk, type LanceDBRow } from './schema.js';

/**
 * Configuration for LanceDBRAGProvider
 */
export interface LanceDBConfig {
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
}

const TABLE_NAME = 'rag_chunks';

/**
 * LanceDBRAGProvider
 *
 * Complete RAG implementation using LanceDB for vector storage.
 */
export class LanceDBRAGProvider implements RAGAdminProvider {
  private readonly config: Required<LanceDBConfig>;
  private connection: Connection | null = null;
  private table: Table | null = null;
  private readonly tokenCounter = new ApproximateTokenCounter();

  private constructor(config: LanceDBConfig) {
    this.config = {
      readonly: false,
      embeddingProvider: new TransformersEmbeddingProvider(),
      targetChunkSize: 512,
      paddingFactor: 0.9,
      ...config,
    };
  }

  /**
   * Create and initialize LanceDBRAGProvider
   *
   * @param config - Configuration
   * @returns Initialized provider
   */
  static async create(config: LanceDBConfig): Promise<LanceDBRAGProvider> {
    const provider = new LanceDBRAGProvider(config);
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
  async query(query: RAGQuery): Promise<RAGResult> {
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
      const whereClause = this.buildWhereClause(query.filters);
      if (whereClause) {
        search = search.where(whereClause);
      }
    }

    const results = await search.toArray();

    // Convert results to plain objects immediately to avoid Arrow buffer issues
    // eslint-disable-next-line unicorn/prefer-structured-clone -- JSON.parse/stringify is intentional workaround for Arrow buffer lifecycle bug
    const materializedResults = JSON.parse(JSON.stringify(results)) as LanceDBRow[];

    // Convert results to RAGChunks
    const chunks = materializedResults.map((row) => lanceRowToChunk(row));

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
   * Build WHERE clause from filters
   */
  private buildWhereClause(filters: RAGQuery['filters']): string | null {
    if (!filters) {
      return null;
    }

    const conditions: string[] = [];

    if (filters.resourceId !== undefined) {
      const ids = Array.isArray(filters.resourceId) ? filters.resourceId : [filters.resourceId];

      // Handle empty array case - should match nothing
      if (ids.length === 0) {
        conditions.push('1 = 0'); // Always false condition
      } else {
        const idList = ids.map((id) => `'${id}'`).join(', ');
        // Use backticks for column names
        conditions.push(`\`resourceId\` IN (${idList})`);
      }
    }

    if (filters.metadata?.type) {
      conditions.push(`type = '${filters.metadata.type}'`);
    }

    if (filters.metadata?.headingPath) {
      // Use backticks for column names
      conditions.push(`\`headingPath\` = '${filters.metadata.headingPath}'`);
    }

    return conditions.length > 0 ? conditions.join(' AND ') : null;
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
    const uniqueResources = new Set(rows.map((r) => r.resourceId)).size;

    return {
      totalChunks: count,
      totalResources: uniqueResources,
      dbSizeBytes: 0, // LanceDB doesn't provide size info easily
      embeddingModel: this.config.embeddingProvider.model,
      lastIndexed: new Date(), // Would need to track this separately
    };
  }

  /**
   * Index resources into the RAG database
   */
  async indexResources(resources: ResourceMetadata[]): Promise<IndexResult> {
    if (this.config.readonly) {
      throw new Error('Cannot index in readonly mode');
    }

    const startTime = Date.now();
    const result: IndexResult = {
      resourcesIndexed: 0,
      resourcesSkipped: 0,
      resourcesUpdated: 0,
      chunksCreated: 0,
      chunksDeleted: 0,
      durationMs: 0,
      errors: [],
    };

    for (const resource of resources) {
      try {
        await this.indexResource(resource, result);
      } catch (error) {
        result.errors?.push({
          resourceId: resource.id,
          error: error instanceof Error ? error.message : String(error),
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
      const existingRows = await this.table.query().where(`\`resourceId\` = '${resource.id}'`).toArray();
      // Materialize immediately to avoid Arrow buffer issues
      // eslint-disable-next-line unicorn/prefer-structured-clone -- JSON.parse/stringify is intentional workaround for Arrow buffer lifecycle bug
      const existing = JSON.parse(JSON.stringify(existingRows)) as LanceDBRow[];

      // Extract data immediately while Arrow buffers are valid
      if (existing.length > 0) {
        const existingHash = existing[0]?.resourceContentHash;
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
      this.config.embeddingProvider.model
    );

    // Convert to LanceDB rows
    const rows = ragChunks.map((chunk) =>
      chunkToLanceRow(chunk as RAGChunk, resourceContentHash)
    );

    // Insert into LanceDB
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

    // Delete chunks (use backticks for column names)
    await this.table.delete(`\`resourceId\` = '${resourceId}'`);
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
