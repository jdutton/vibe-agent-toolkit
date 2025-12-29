/**
 * LanceDB RAG Provider
 *
 * Implements both RAGQueryProvider and RAGAdminProvider using LanceDB.
 */


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
import { connect } from 'vectordb';
import type { Connection, Table } from 'vectordb';

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
  private table: Table<LanceDBRow> | null = null;
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
    this.connection = await connect(this.config.dbPath);

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
    if (!this.table) {
      throw new Error('No data indexed yet');
    }

    const startTime = Date.now();

    // Embed query text
    const queryEmbedding = await this.config.embeddingProvider.embed(query.text);

    // Perform vector search
    let search = this.table.search(queryEmbedding as unknown as LanceDBRow).limit(query.limit ?? 10);

    // Apply filters if provided
    if (query.filters) {
      const conditions: string[] = [];

      if (query.filters.resourceId) {
        const ids = Array.isArray(query.filters.resourceId)
          ? query.filters.resourceId
          : [query.filters.resourceId];
        const idList = ids.map((id) => `'${id}'`).join(', ');
        // Use quoted column name for camelCase field
        conditions.push(`"resourceId" IN (${idList})`);
      }

      if (query.filters.type) {
        conditions.push(`type = '${query.filters.type}'`);
      }

      if (query.filters.headingPath) {
        // Use quoted column name for camelCase field
        conditions.push(`"headingPath" = '${query.filters.headingPath}'`);
      }

      if (conditions.length > 0) {
        search = search.where(conditions.join(' AND '));
      }
    }

    const results = await search.execute();

    // Convert results to RAGChunks
    const chunks = results.map((row) => lanceRowToChunk(row as unknown as LanceDBRow));

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
    const allRows = await this.table.filter('1 = 1').execute();
    const rows = allRows as unknown as LanceDBRow[];
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
    if (this.table) {
      let existing: LanceDBRow[] = [];
      // LanceDB requires quoted column names for camelCase fields
      const existingRows = await this.table.filter(`"resourceId" = '${resource.id}'`).execute();

      // Deep clone to detach from Arrow buffers (workaround for "Buffer is already detached")
      existing = JSON.parse(JSON.stringify(existingRows)) as LanceDBRow[];

      if (existing.length > 0 && existing[0]?.resourceContentHash === resourceContentHash) {
        result.resourcesSkipped++;
        return;
      }

      // Delete old chunks for this resource if it exists
      if (existing.length > 0) {
        const deleteCount = await this.countResourceChunks(resource.id);
        await this.deleteResource(resource.id);
        result.chunksDeleted += deleteCount;
        result.resourcesUpdated++;
      }
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
      this.table = (await this.connection.createTable(
        TABLE_NAME,
        rows
      )) as unknown as Table<LanceDBRow>;
    } else if (this.table) {
      await this.table.add(rows);
      // Reopen table after modification to avoid Arrow buffer issues
      if (this.connection) {
        this.table = (await this.connection.openTable(TABLE_NAME)) as unknown as Table<LanceDBRow>;
      }
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

    // Delete chunks (use quoted column name for camelCase field)
    await this.table.delete(`"resourceId" = '${resourceId}'`);

    // Reopen table after modification to avoid Arrow buffer issues
    if (this.connection) {
      this.table = (await this.connection.openTable(TABLE_NAME)) as unknown as Table<LanceDBRow>;
    }
  }

  /**
   * Count chunks for a resource (internal helper)
   *
   * @param resourceId - ID of resource
   * @returns Number of chunks
   */
  private async countResourceChunks(resourceId: string): Promise<number> {
    if (!this.table) {
      return 0;
    }

    const rows = await this.table.filter(`"resourceId" = '${resourceId}'`).execute();
    return (rows as unknown as LanceDBRow[]).length;
  }

  /**
   * Clear the entire database
   */
  async clear(): Promise<void> {
    if (this.config.readonly) {
      throw new Error('Cannot clear in readonly mode');
    }

    if (this.connection) {
      const tableNames = await this.connection.tableNames();
      if (tableNames.includes(TABLE_NAME)) {
        // Drop table (it will be recreated on next insert)
        await this.connection.dropTable(TABLE_NAME);
      }
      this.table = null;
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
