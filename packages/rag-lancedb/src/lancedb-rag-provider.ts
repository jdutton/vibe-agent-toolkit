/**
 * LanceDB RAG Provider
 *
 * Implements both RAGQueryProvider and RAGAdminProvider using LanceDB.
 */

import fs from 'node:fs';

import type { Connection, Table } from '@lancedb/lancedb';
import * as lancedb from '@lancedb/lancedb';
import type {
  ChunkingConfig,
  DefaultRAGMetadata,
  DocumentResult,
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
  assertQuerySupported,
  chunkResource,
  DefaultRAGMetadataSchema,
  enrichChunks,
  generateContentHash,
  OnnxEmbeddingProvider,
} from '@vibe-agent-toolkit/rag';
import {
  isParserUnavailable,
  parseFileCached,
  transformContent,
  type ContentTransformOptions,
  type ResourceMetadata,
} from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import type { ZodObject, ZodRawShape } from 'zod';

import { resolveChunkingConfig } from './chunking-config.js';
import { createDocumentRecord, overlayChunkMetadata, type DocumentRecord } from './document-helpers.js';
import { buildWhereClause, escapeSQLString, LANCEDB_QUERY_SUPPORT } from './filter-builder.js';
import {
  chunkToLanceRow,
  deserializeMetadata,
  lanceRowToChunk,
  type LanceDBRow,
  type SerializedMetadata,
} from './schema.js';

/**
 * Configuration for LanceDBRAGProvider (generic over metadata type)
 */
export interface LanceDBConfig<_TMetadata extends Record<string, unknown> = DefaultRAGMetadata> {
  /** Path to LanceDB database directory */
  dbPath: string;

  /** Readonly mode (query only) */
  readonly?: boolean;

  /** Embedding provider (default: OnnxEmbeddingProvider — local WASM embeddings) */
  embeddingProvider?: EmbeddingProvider;

  /**
   * Target chunk size in tokens.
   *
   * Defaults to the embedding provider's own `maxInputTokens` — 256 for the
   * default local model, not a fixed 512. A value above the provider's limit is
   * clamped with a warning, because text past that limit never reaches the model.
   */
  targetChunkSize?: number;

  /**
   * Padding factor for token estimation.
   *
   * Defaults to a value derived from the provider's limit that keeps a full
   * chunk inside it even after the chunker's cl100k count is re-tokenized by
   * the model's own (coarser) tokenizer. Override only with a reason — see
   * {@link resolveChunkingConfig}.
   */
  paddingFactor?: number;

  /** Metadata schema for validation and serialization (defaults to DefaultRAGMetadataSchema) */
  metadataSchema?: ZodObject<ZodRawShape>;

  /**
   * Content transform options applied before chunking and storage.
   *
   * When configured, content is transformed (e.g., links rewritten) before
   * computing the content hash, chunking, embedding, and persisting.
   * This means the stored chunks contain the transformed content, and the
   * content hash reflects the transformed output (not the raw file content).
   *
   * If not provided, content is stored as-is (original behavior).
   */
  contentTransform?: ContentTransformOptions;

  /**
   * Store full document content in a separate `rag_documents` table.
   *
   * When enabled, the complete source document is persisted alongside chunks
   * so consumers can retrieve the full content after finding relevant chunks
   * via vector search. Use `getDocument(resourceId)` to retrieve.
   *
   * @default false
   */
  storeDocuments?: boolean;
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
      const itemPath = safePath.join(dirPath, item);
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

/**
 * Render a thrown value as a message.
 *
 * @param error - The caught value
 * @returns Its message if it is an Error, otherwise its string form
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One progress report, assembled from the batch counters plus where the loop is.
 *
 * Extracted from the indexing loop rather than inlined: the loop's own branching
 * is now load-bearing (a failed parser LOAD is rethrown while a failed document
 * is recorded), and this arithmetic contributed nothing to that decision while
 * pushing the function past the complexity gate.
 *
 * @param result - The batch counters as they stand
 * @param at - Where the loop is: ordinal, total, elapsed time, current resource
 * @returns The progress payload a caller's callback receives
 */
function progressAfter(
  result: IndexResult,
  at: { current: number; total: number; elapsedMs: number; resourceId: string },
): IndexProgress {
  const remaining = at.total - at.current;
  return {
    current: at.current,
    total: at.total,
    resourcesIndexed: result.resourcesIndexed,
    resourcesSkipped: result.resourcesSkipped,
    resourcesUpdated: result.resourcesUpdated,
    resourcesEmpty: result.resourcesEmpty,
    chunksCreated: result.chunksCreated,
    elapsedMs: at.elapsedMs,
    // Extrapolated from the average so far, and zero once nothing is left —
    // never a negative number from a total that has been passed.
    estimatedRemainingMs: remaining > 0 ? Math.round((at.elapsedMs / at.current) * remaining) : 0,
    resourceId: at.resourceId,
    errors: result.errors ?? [],
  };
}

const TABLE_NAME = 'rag_chunks';
const DOCUMENTS_TABLE_NAME = 'rag_documents';

/**
 * What the documents table remembers about a resource, minus its content.
 *
 * `contenthash` and `totalchunks` together say "seen at this hash, and it
 * chunked to this many" — which is the whole record a zero-chunk resource
 * leaves, since it has no chunk rows to be recognised by.
 */
interface DocumentedResource {
  contenthash: string;
  totalchunks: number;
}

/** Per-batch view of the documents table, or null when document storage is off. */
type DocumentedResources = ReadonlyMap<string, DocumentedResource> | null;

/**
 * Required configuration after defaults applied
 */
interface RequiredLanceDBConfig<_TMetadata extends Record<string, unknown>> {
  dbPath: string;
  readonly: boolean;
  embeddingProvider: EmbeddingProvider;
  /** Caller override only — the default is derived from `embeddingProvider`. */
  targetChunkSize?: number;
  /** Caller override only — the default is derived from `embeddingProvider`. */
  paddingFactor?: number;
  metadataSchema: ZodObject<ZodRawShape>;
  contentTransform?: ContentTransformOptions;
  storeDocuments: boolean;
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

  /** Resolved once from the embedding provider's real limit; warnings logged once. */
  private resolvedChunkingConfig: ChunkingConfig | null = null;

  /** Opened lazily and reused: the documents table is written once per resource. */
  private documentsTable: Table | null = null;

  private constructor(config: LanceDBConfig<TMetadata>) {
    this.config = {
      readonly: false,
      embeddingProvider: new OnnxEmbeddingProvider(),
      metadataSchema: DefaultRAGMetadataSchema,
      storeDocuments: false,
      ...config,
    };
    this.metadataSchema = this.config.metadataSchema;
  }

  /**
   * The chunking budget for this provider's embedder.
   *
   * Derived from `embeddingProvider.maxInputTokens` rather than assumed, and
   * memoized so its warnings are printed once per provider instead of once per
   * indexed resource.
   *
   * @returns Resolved chunking configuration
   */
  private getChunkingConfig(): ChunkingConfig {
    if (!this.resolvedChunkingConfig) {
      const { config, warnings } = resolveChunkingConfig({
        embeddingProvider: this.config.embeddingProvider,
        tokenCounter: this.tokenCounter,
        targetChunkSize: this.config.targetChunkSize,
        paddingFactor: this.config.paddingFactor,
      });

      for (const warning of warnings) {
        console.warn(`[vat-rag] ${warning}`);
      }

      this.resolvedChunkingConfig = config;
    }

    return this.resolvedChunkingConfig;
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
   * Reconnect and open table (workaround for a @lancedb/lancedb + Bun Arrow
   * buffer lifecycle bug: a stale connection's buffers can detach after table
   * modifications, so we re-open the connection before reading).
   */
  private async reconnectAndOpenTable(): Promise<void> {
    this.connection = await lancedb.connect(this.config.dbPath);
    // The memoized documents handle belongs to the connection just replaced.
    // Keeping it would hand later writes a table bound to a dead connection —
    // the same buffer-lifecycle hazard this reconnect exists to avoid.
    this.documentsTable = null;

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
    // Refuse a query this provider cannot honour BEFORE doing any work — the check is
    // deterministic and needs neither a connection nor an embedding, so an unindexed
    // provider reports the unsupported field rather than reporting that nothing is
    // indexed yet.
    //
    // One call covers BOTH halves, so a query carrying an unsupported filter AND an
    // unsupported `hybridSearch` reports all of them together. An earlier shape threw on
    // `hybridSearch` first and reached the filter check only afterwards, which reported
    // one offender out of three and made the caller fix the same query twice.
    //
    // The check lives in `@vibe-agent-toolkit/rag`, not here: the query surface it
    // enforces is declared there, and a second provider (the RAG skill actively invites
    // pgvector/Qdrant implementations) would otherwise inherit the declared fields and
    // none of the enforcement. What THIS provider supports is data it declares.
    assertQuerySupported(query as { filters?: Record<string, unknown> }, LANCEDB_QUERY_SUPPORT);

    // Workaround for the @lancedb/lancedb + Bun Arrow buffer lifecycle bug:
    // after table modifications we recreate the connection entirely before reading.
    await this.reconnectAndOpenTable();

    if (!this.table) {
      throw new Error(
        `No data indexed yet: no '${TABLE_NAME}' table at ${this.config.dbPath}. ` +
          'If indexResources() was called, check its returned `errors` for resources that failed to chunk or embed.',
      );
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
   * Retrieve the full source document by resource ID.
   *
   * Only returns data when `storeDocuments: true` was configured and the
   * rag_documents table exists. Returns `null` if the document is not found.
   *
   * @param resourceId - ID of the resource to retrieve
   * @returns Full document record or null
   */
  async getDocument(resourceId: string): Promise<DocumentResult | null> {
    if (!this.connection) {
      return null;
    }

    const docsTable = await this.openDocumentsTable().catch(() => null);
    if (!docsTable) {
      return null; // Table doesn't exist or connection error
    }

    const rows = await docsTable.query()
      .where(`resourceid = '${escapeSQLString(resourceId)}'`)
      .limit(1)
      .toArray();

    if (rows.length === 0) {
      return null;
    }

    // Materialize immediately to avoid Arrow buffer issues
    // eslint-disable-next-line unicorn/prefer-structured-clone -- JSON.parse/stringify is intentional workaround for Arrow buffer lifecycle bug
    const row = JSON.parse(JSON.stringify(rows[0])) as DocumentRecord;

    return {
      resourceId: row.resourceid,
      filePath: row.filepath,
      content: row.content,
      contentHash: row.contenthash,
      tokenCount: row.tokencount,
      totalChunks: row.totalchunks,
      indexedAt: new Date(row.indexedat),
      // The inverse of what `createDocumentRecord` wrote: every metadata column
      // is present on every row, so a sentinel has to read back as "absent".
      metadata: deserializeMetadata(row as SerializedMetadata<Record<string, unknown>>, this.metadataSchema),
    };
  }

  /**
   * Index resources into the RAG database
   *
   * @throws {ParserUnavailableError} If the markdown parser module cannot be
   *   loaded — a broken install fails the whole batch rather than becoming one
   *   error entry per resource
   */
  async indexResources(
    resources: ResourceMetadata[],
    onProgress?: (progress: IndexProgress) => void
  ): Promise<IndexResult> {
    if (this.config.readonly) {
      throw new Error('Cannot index in readonly mode');
    }

    // Which resources already have a document record, read ONCE for the whole
    // batch. `detectResourceChangeStatus` needs it to refuse a `skip` for a
    // resource whose chunks are present and whose document row is not — the
    // state an interrupted run under an older build left behind, which is
    // otherwise unreachable forever because the surviving chunks carry a
    // matching content hash. `recordEmptyResource` needs the hash and chunk
    // count behind each id, to leave a zero-chunk resource's row alone when it
    // already says what this run would write. `null` when document storage is
    // off: there is no documents table then, and an empty map would re-index
    // the whole corpus on every run.
    const documented = this.config.storeDocuments
      ? await this.readDocumentedResources()
      : null;

    const startTime = Date.now();
    const totalResources = resources.length;
    const result: IndexResult = {
      resourcesIndexed: 0,
      resourcesSkipped: 0,
      resourcesUpdated: 0,
      resourcesEmpty: 0,
      chunksCreated: 0,
      chunksDeleted: 0,
      durationMs: 0,
      errors: [],
    };

    let processedCount = 0;
    for (const resource of resources) {
      processedCount++;

      try {
        await this.indexResource(resource, result, documented);
      } catch (error) {
        // A broken INSTALL, not a broken corpus. `indexResource`'s parse carries
        // no local try, so this catch is the one that sees a failed parser load —
        // the parser arrives by `import()` from inside `parseFileCached`, lazily,
        // past the parse cache's hit-path return so a fully warm index loads no
        // parser at all. Unguarded, a `chmod 000` on the built parser produced
        // one `errors` entry per resource, `resourcesIndexed: 0`, and a resolved
        // promise with nothing to act on.
        //
        // A type check rather than a `loadParser('markdown')` hoisted above the
        // loop: that also closes it and costs every warm run the ~730 ms remark
        // load for parses that never happen. `isParserUnavailable` matches one
        // type VAT constructs at one place, so it is complete by construction —
        // not the guessed blocklist of Node loader codes that was deleted.
        if (isParserUnavailable(error)) throw error;

        const message = describeError(error);
        // Also surfaced on stderr: a caller that ignores `result.errors` would
        // otherwise meet this failure much later as an unexplained
        // "No data indexed yet" from query().
        console.warn(`[vat-rag] Failed to index resource '${resource.id}': ${message}`);
        result.errors?.push({
          resourceId: resource.id,
          error: message,
        });
      }

      // After each resource, never before: a caller reading this is told what has
      // actually happened, and the rethrow above leaves the loop without
      // reporting a resource the batch never finished.
      onProgress?.(
        progressAfter(result, {
          current: processedCount,
          total: totalResources,
          elapsedMs: Date.now() - startTime,
          resourceId: resource.id,
        }),
      );
    }

    result.durationMs = Date.now() - startTime;
    return result;
  }

  /**
   * What the documents table currently records, keyed by resource id.
   *
   * Projected to three columns: the documents table stores every document's
   * full text, and neither question asked of this map needs any of it.
   *
   * @returns Every `resourceid` in the documents table with its hash and chunk
   *   count, empty if there is no table
   */
  private async readDocumentedResources(): Promise<ReadonlyMap<string, DocumentedResource>> {
    const table = await this.openDocumentsTable();
    if (!table) {
      return new Map();
    }

    const rows = await table.query()
      .select(['resourceid', 'contenthash', 'totalchunks'])
      .where('1 = 1')
      .toArray();
    // eslint-disable-next-line unicorn/prefer-structured-clone -- JSON.parse/stringify is intentional workaround for Arrow buffer lifecycle bug
    const materialized = JSON.parse(JSON.stringify(rows)) as ({ resourceid: string } & DocumentedResource)[];

    return new Map(
      materialized.map((row) => [
        row.resourceid,
        { contenthash: row.contenthash, totalchunks: row.totalchunks },
      ]),
    );
  }

  /**
   * Open the documents table, or report that it does not exist yet.
   *
   * Memoized on the instance: document records are written one per resource, so
   * an un-memoized open would re-read the table manifest once per document.
   *
   * @returns The documents table, or null when nothing has created it
   */
  private async openDocumentsTable(): Promise<Table | null> {
    if (this.documentsTable) {
      return this.documentsTable;
    }
    if (!this.connection) {
      return null;
    }

    const tableNames = await this.connection.tableNames();
    if (!tableNames.includes(DOCUMENTS_TABLE_NAME)) {
      return null;
    }

    this.documentsTable = await this.connection.openTable(DOCUMENTS_TABLE_NAME);
    return this.documentsTable;
  }

  /**
   * Write one resource's document record, replacing any record it already has.
   *
   * Per resource rather than batched at the end of the run, and BEFORE that
   * resource's chunks rather than after. Both halves matter:
   *
   * - Batched, every record was held in memory until the loop finished, so any
   *   throw out of the loop discarded all of them while leaving every chunk
   *   already written. That state is permanent: change detection reads the
   *   chunk table, the surviving chunks carry a matching content hash, and the
   *   resource is skipped on every subsequent run.
   * - Ordered document-then-chunks, an interruption between the two leaves a
   *   document row with no chunks behind it. Change detection counts chunk
   *   rows, so it reads that resource as new and redoes it. The marker the
   *   detector trusts is written LAST, which is what makes a partial write
   *   self-repairing rather than terminal.
   *
   * @param record - The document record to store
   */
  private async upsertDocumentRecord(record: DocumentRecord): Promise<void> {
    if (!this.connection) {
      return;
    }

    const table = await this.openDocumentsTable();
    if (!table) {
      this.documentsTable = await this.connection.createTable(DOCUMENTS_TABLE_NAME, [record]);
      return;
    }

    await table.delete(`resourceid = '${escapeSQLString(record.resourceid)}'`);
    await table.add([record]);
  }

  /**
   * Detect whether a resource needs indexing, updating, or can be skipped.
   *
   * Queries existing rows for the resource and compares content hashes.
   * All Arrow data is materialized before returning to avoid buffer lifecycle issues.
   *
   * @param resourceId - Resource to inspect
   * @param contentHash - Hash of the content this run would index
   * @param documented - Resources that already have a document record, or
   *   null when document storage is off and there is nothing to be missing
   * @returns Object with `action` ('skip' | 'update' | 'new') and `deleteCount` (chunks to remove on update)
   */
  private async detectResourceChangeStatus(
    resourceId: string,
    contentHash: string,
    documented: DocumentedResources,
  ): Promise<{ action: 'skip' | 'update' | 'new'; deleteCount: number }> {
    if (!this.table) {
      return { action: 'new', deleteCount: 0 };
    }

    const existingRows = await this.table.query().where(`resourceid = '${escapeSQLString(resourceId)}'`).toArray();
    // Materialize immediately to avoid Arrow buffer issues
    // eslint-disable-next-line unicorn/prefer-structured-clone -- JSON.parse/stringify is intentional workaround for Arrow buffer lifecycle bug
    const existing = JSON.parse(JSON.stringify(existingRows)) as LanceDBRow[];

    if (existing.length === 0) {
      return { action: 'new', deleteCount: 0 };
    }

    const existingHash = existing[0]?.resourcecontenthash;

    // An unchanged hash is NOT sufficient on its own. A run interrupted under a
    // build that batched document records to the end of the loop left chunks
    // whose hash still matches and no document row behind them — and skipping
    // on the hash alone is exactly what made that state permanent. A resource
    // that is half in the index is not up to date; redo it.
    if (existingHash === contentHash && (documented === null || documented.has(resourceId))) {
      return { action: 'skip', deleteCount: existing.length };
    }

    return { action: 'update', deleteCount: existing.length };
  }

  /**
   * Account for a resource that chunked to nothing.
   *
   * A frontmatter-only or blank document has no prose to retrieve, so nothing
   * is embedded and no chunk row is written. Two things that used to happen
   * here are deliberately absent:
   *
   * - **No chunk table is created for it.** The table used to be created from
   *   the first resource's rows, and LanceDB refuses to create a table from an
   *   empty list — so a zero-chunk resource that happened to be enumerated
   *   first failed the run, and succeeded on the next run once a neighbour had
   *   created the table. Creation is deferred to the first resource that has
   *   rows, rather than done up front from a hand-written Arrow schema: the
   *   table's shape (vector width from the embedder, one column per metadata
   *   field) is already declared once, by `chunkToLanceRow`, and a second
   *   declaration would have to be kept in step with it by hand. A table that
   *   holds no rows answers no query, and `query()` already reports a missing
   *   table as "nothing indexed yet".
   * - **It is not counted as indexed.** Change detection reads chunk rows, and
   *   a zero-chunk resource leaves none, so it can never be recognised as
   *   "already done" the way a chunked resource is. Rather than invent a
   *   marker row, the outcome is its own counter, `resourcesEmpty`, reported on
   *   every run: the answer is the same on every run, and giving it costs
   *   nothing.
   *
   * With document storage on, the resource still gets its `rag_documents` row
   * (with `totalchunks: 0`), so `getDocument` can return it — but the row is
   * rewritten only when it does not already say exactly this, which is what
   * keeps a steady-state run from churning the documents table.
   *
   * @param record - The document record this run would store
   * @param result - The batch counters to move
   * @param documented - What the documents table already holds, or null when
   *   document storage is off
   */
  private async recordEmptyResource(
    record: DocumentRecord,
    result: IndexResult,
    documented: DocumentedResources,
  ): Promise<void> {
    if (this.config.storeDocuments) {
      const existing = documented?.get(record.resourceid);
      const alreadyRecorded =
        existing?.contenthash === record.contenthash && existing.totalchunks === 0;
      if (!alreadyRecorded) {
        await this.upsertDocumentRecord(record);
      }
    }

    result.resourcesEmpty++;
  }

  /**
   * Index a single resource
   */
  private async indexResource(
    resource: ResourceMetadata,
    result: IndexResult,
    documented: DocumentedResources,
  ): Promise<void> {
    // Read + parse, served from the disk parse cache when one is filed under
    // these bytes. 'markdown' is stated rather than derived from the extension:
    // this lane has always parsed every resource as markdown, including the
    // .html ones the registry crawls, and the key must name the parser that
    // actually ran (see content-key.ts).
    const parseResult = await parseFileCached(resource.filePath, 'markdown');

    // Apply content transform if configured (e.g., rewrite links before chunking)
    const content = this.config.contentTransform
      ? transformContent(parseResult.content, resource.links, this.config.contentTransform)
      : parseResult.content;

    // Generate content hash for change detection (based on transformed content)
    const resourceContentHash = generateContentHash(content);

    // Detect whether this resource is new, unchanged (skip), or updated
    const { action, deleteCount } = await this.detectResourceChangeStatus(
      resource.id,
      resourceContentHash,
      documented,
    );

    if (action === 'skip') {
      result.resourcesSkipped++;
      return;
    }

    if (action === 'update') {
      await this.deleteResource(resource.id);
      result.chunksDeleted += deleteCount;
      result.resourcesUpdated++;
    }

    // Chunk the resource
    const chunkingResult = chunkResource(
      {
        ...resource,
        content,
        frontmatter: {},
      },
      this.getChunkingConfig()
    );

    // Nothing to embed and nothing to write — see `recordEmptyResource`.
    if (chunkingResult.chunks.length === 0) {
      await this.recordEmptyResource(
        createDocumentRecord(resource, content, resourceContentHash, 0, this.tokenCounter, this.metadataSchema),
        result,
        documented,
      );
      return;
    }

    // Embed chunks
    const embeddings = await this.config.embeddingProvider.embedBatch(
      chunkingResult.chunks.map((c) => c.content)
    );

    // Enrich chunks with full metadata
    const ragChunks = enrichChunks(
      chunkingResult.chunks,
      { ...resource, content, frontmatter: {} },
      embeddings,
      this.config.embeddingProvider.model,
      this.tokenCounter,
    );

    // Add custom metadata from resource.frontmatter to each chunk
    const chunksWithMetadata = overlayChunkMetadata<TMetadata>(ragChunks, resource.frontmatter, this.metadataSchema);

    // Convert to LanceDB rows using the metadata schema
    const rows = chunksWithMetadata.map((chunk) =>
      chunkToLanceRow<TMetadata>(chunk, resourceContentHash, this.metadataSchema)
    );

    // The document record goes in FIRST — see `upsertDocumentRecord`. Change
    // detection reads the chunk table, so the chunks are the marker that says
    // "this resource is done", and the marker must be the last thing written.
    if (this.config.storeDocuments) {
      await this.upsertDocumentRecord(
        createDocumentRecord(resource, content, resourceContentHash, rows.length, this.tokenCounter, this.metadataSchema)
      );
    }

    // INSERT into LanceDB. `rows` is non-empty here — the zero-chunk return
    // above guarantees it — which is what lets the table be created from the
    // rows themselves: LanceDB infers the schema from them and refuses an
    // empty list.
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
   * Delete a specific resource and all its chunks.
   *
   * Also removes the document record from rag_documents if it exists.
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

    // Also delete from rag_documents table if it exists
    try {
      const docsTable = await this.openDocumentsTable();
      await docsTable?.delete(`resourceid = '${escapeSQLString(resourceId)}'`);
    } catch {
      // Documents table may not exist; ignore
    }
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
    // Release the embedding provider first (frees the WASM inference session's
    // heap for the default OnnxEmbeddingProvider; a no-op for providers that
    // don't implement dispose(), like OpenAIEmbeddingProvider), then the
    // LanceDB table and connection — both expose `close()` for exactly this;
    // the docs note they are otherwise only freed on GC. The default embedding
    // backend is onnxruntime-web (WASM), which has no native static
    // destructors, so there is no process-teardown abort when co-loaded with
    // LanceDB's native runtime.
    await this.config.embeddingProvider.dispose?.();
    try {
      this.table?.close();
    } catch (error) {
      // close() is expected to be idempotent (safe to call from a `finally`
      // block even if already closed), so we don't rethrow — but a genuine
      // close failure (e.g. a flush error) should still be visible, not silent.
      console.error('LanceDBRAGProvider.close(): failed to close table:', error);
    }
    try {
      this.connection?.close();
    } catch (error) {
      console.error('LanceDBRAGProvider.close(): failed to close connection:', error);
    }
    this.connection = null;
    this.table = null;
    // Not close()d in its own right: it is a second handle onto the same
    // connection, which the line above has already released.
    this.documentsTable = null;
  }
}
