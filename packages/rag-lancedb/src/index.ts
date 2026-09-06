/**
 * @vibe-agent-toolkit/rag-lancedb
 *
 * LanceDB implementation of RAG interfaces for vibe-agent-toolkit.
 */

export { LanceDBRAGProvider, type LanceDBConfig } from './lancedb-rag-provider.js';
export {
  ESTIMATOR_DIVERGENCE_FACTOR,
  SPECIAL_TOKEN_OVERHEAD,
  resolveChunkingConfig,
  type ChunkingConfigInputs,
  type ResolvedChunkingConfig,
} from './chunking-config.js';
export type { ContentTransformOptions, LinkRewriteRule, LinkRewriteMatch } from '@vibe-agent-toolkit/resources';
export { chunkToLanceRow, lanceRowToChunk, type LanceDBRow } from './schema.js';
export {
  buildMetadataFilter,
  buildMetadataWhereClause,
  buildWhereClause,
  LANCEDB_QUERY_SUPPORT,
} from './filter-builder.js';
