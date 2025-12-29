# @vibe-agent-toolkit/rag

Abstract RAG (Retrieval-Augmented Generation) interfaces and shared implementations for vibe-agent-toolkit.

## Overview

This package provides:
- **Interfaces**: `RAGQueryProvider`, `RAGAdminProvider`, `EmbeddingProvider`, `TokenCounter`
- **Schemas**: Zod schemas for `RAGChunk`, `RAGQuery`, `RAGResult` with JSON Schema exports
- **Shared implementations**: Token counters, embedding providers, chunking utilities

This is an abstract package - it does not include vector database implementations. See `@vibe-agent-toolkit/rag-lancedb` for the LanceDB implementation.

## Installation

```bash
bun add @vibe-agent-toolkit/rag
```

## Usage

```typescript
import type { RAGQueryProvider, RAGQuery } from '@vibe-agent-toolkit/rag';

// Use RAGQueryProvider interface
const rag: RAGQueryProvider = ...; // Implementation provided by rag-lancedb

const result = await rag.query({
  text: 'How do I validate schemas?',
  limit: 5,
  filters: {
    tags: ['validation'],
    type: 'documentation'
  }
});
```

## Packages

- `@vibe-agent-toolkit/rag` - This package (interfaces + shared implementations)
- `@vibe-agent-toolkit/rag-lancedb` - LanceDB implementation
- Future: `@vibe-agent-toolkit/rag-pinecone`, `@vibe-agent-toolkit/rag-weaviate`, etc.
