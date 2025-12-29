# @vibe-agent-toolkit/rag Changelog

## [0.2.0] - 2025-12-29

### Added

- Token counter implementations:
  - `FastTokenCounter` - Fast bytes/4 heuristic (recommended padding: 0.8)
  - `ApproximateTokenCounter` - Accurate gpt-tokenizer (recommended padding: 0.9)
- Comparison tests demonstrating accuracy vs speed tradeoffs
- Comprehensive documentation for choosing token counters
- Padding factor recommendations for chunking strategies

## [0.1.0] - 2025-12-29

### Added

- Initial release of abstract RAG interfaces package
- Core interfaces:
  - `RAGQueryProvider` - Read-only query interface for agents
  - `RAGAdminProvider` - Read/write admin interface for build tools
  - `EmbeddingProvider` - Interface for embedding providers
  - `TokenCounter` - Interface for token counting
- Zod schemas with TypeScript types:
  - `RAGChunkSchema` - Rich metadata for RAG chunks
  - `RAGQuerySchema` - Query structure with filters and hybrid search
  - `RAGResultSchema` - Query results structure
  - `RAGStatsSchema` - Database statistics
  - `IndexResultSchema` - Indexing operation results
- JSON Schema exports for all Zod schemas
- Comprehensive test coverage for all schemas and interfaces
