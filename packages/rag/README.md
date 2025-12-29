# @vibe-agent-toolkit/rag

Abstract RAG (Retrieval-Augmented Generation) interfaces and shared implementations for vibe-agent-toolkit.

## Overview

This package provides the core interfaces and schemas for RAG functionality in VAT (Vibe Agent Toolkit). It defines contracts that RAG implementations must follow, ensuring portability and consistency across different vector database backends.

**What's included:**
- **Interfaces**: `RAGQueryProvider`, `RAGAdminProvider`, `EmbeddingProvider`, `TokenCounter`
- **Schemas**: Zod schemas with TypeScript types and JSON Schema exports
- **Token counters**: `FastTokenCounter` (bytes/4 heuristic), `ApproximateTokenCounter` (gpt-tokenizer)
- **Shared implementations**: Embedding providers, chunking utilities (coming in Phase 3-4)

**What's NOT included:**
- Vector database implementations (see `@vibe-agent-toolkit/rag-lancedb`)
- Concrete embedding providers (coming in Phase 3)

## Installation

```bash
bun add @vibe-agent-toolkit/rag
```

## Packages

- `@vibe-agent-toolkit/rag` - This package (interfaces + shared implementations)
- `@vibe-agent-toolkit/rag-lancedb` - LanceDB implementation (coming soon)
- Future: `@vibe-agent-toolkit/rag-pinecone`, `@vibe-agent-toolkit/rag-weaviate`, etc.

## Usage

### Using RAG Provider Interfaces

```typescript
import type { RAGQueryProvider, RAGQuery } from '@vibe-agent-toolkit/rag';

// Get a RAG provider implementation (from rag-lancedb or other package)
const rag: RAGQueryProvider = ...; // Implementation

// Query the RAG database
const result = await rag.query({
  text: 'How do I validate schemas?',
  limit: 5,
  filters: {
    tags: ['validation'],
    type: 'documentation'
  }
});

// Use results
for (const chunk of result.chunks) {
  console.log(`[${chunk.headingPath}] ${chunk.content}`);
}
```

### Using Schemas for Validation

```typescript
import { RAGQuerySchema, RAGChunkSchema } from '@vibe-agent-toolkit/rag';

// Validate a query
const queryResult = RAGQuerySchema.safeParse(userInput);
if (!queryResult.success) {
  console.error('Invalid query:', queryResult.error);
}

// Validate a chunk
const chunkResult = RAGChunkSchema.safeParse(data);
if (chunkResult.success) {
  const chunk = chunkResult.data; // Typed as RAGChunk
}
```

### Using JSON Schemas

```typescript
import { jsonSchemas } from '@vibe-agent-toolkit/rag';

// Get JSON Schema for RAGChunk
const schema = jsonSchemas.RAGChunk;

// Use for documentation, validation, code generation, etc.
console.log(JSON.stringify(schema, null, 2));
```

## Token Counters

Token counters are used for accurate chunking and embedding token limit management.

### Available Implementations

#### FastTokenCounter

Fast but inaccurate token estimation using bytes/4 heuristic.

```typescript
import { FastTokenCounter } from '@vibe-agent-toolkit/rag';

const counter = new FastTokenCounter();
const tokens = counter.count('Hello world'); // ~3 tokens (bytes/4)
```

**Characteristics:**
- **Speed**: Very fast (< 1ms for long text)
- **Accuracy**: ~75% accurate for English text
- **Recommended padding factor**: 0.8 (80% of target)
- **Use case**: Quick validation, ResourceRegistry estimation

#### ApproximateTokenCounter

Accurate token counting using gpt-tokenizer library.

```typescript
import { ApproximateTokenCounter } from '@vibe-agent-toolkit/rag';

const counter = new ApproximateTokenCounter();
const tokens = counter.count('Hello world'); // 2 tokens (accurate)
```

**Characteristics:**
- **Speed**: Fast (< 10ms for long text)
- **Accuracy**: ~95% accurate (GPT-3.5/GPT-4 tokenization)
- **Recommended padding factor**: 0.9 (90% of target)
- **Use case**: RAG chunking, embedding preparation

### Choosing a Token Counter

| Counter | Speed | Accuracy | Padding Factor | Use Case |
|---------|-------|----------|----------------|----------|
| FastTokenCounter | Very Fast | ~75% | 0.8 | Quick estimation |
| ApproximateTokenCounter | Fast | ~95% | 0.9 | RAG chunking |

### Padding Factor

The padding factor provides a safety margin to avoid exceeding embedding model token limits:

```typescript
const targetChunkSize = 512; // tokens
const paddingFactor = 0.9; // 90%
const effectiveTarget = targetChunkSize * paddingFactor; // 460 tokens

// Chunk to effective target to avoid splits from estimation error
```

**Why padding matters:**
- Token estimation may be imperfect
- Targeting exact limit might exceed it, forcing inefficient splits
- Lower accuracy = lower padding factor (more safety margin)

## API Reference

### Interfaces

#### RAGQueryProvider

Read-only provider interface for querying RAG databases.

```typescript
interface RAGQueryProvider {
  query(query: RAGQuery): Promise<RAGResult>;
  getStats(): Promise<RAGStats>;
}
```

#### RAGAdminProvider

Read/write provider interface for building and managing RAG databases.

```typescript
interface RAGAdminProvider extends RAGQueryProvider {
  indexResources(resources: ResourceMetadata[]): Promise<IndexResult>;
  updateResource(resourceId: string): Promise<void>;
  deleteResource(resourceId: string): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}
```

#### EmbeddingProvider

Interface for embedding providers (transformers.js, OpenAI, etc.)

```typescript
interface EmbeddingProvider {
  name: string;
  model: string;
  dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}
```

#### TokenCounter

Interface for token counting implementations.

```typescript
interface TokenCounter {
  name: string;
  count(text: string): number;
  countBatch(texts: string[]): number[];
}
```

### Schemas

All schemas are defined with Zod and exported as both TypeScript types and JSON Schemas.

- `RAGChunkSchema` / `RAGChunk` - Structure of a chunk in the RAG database
- `RAGQuerySchema` / `RAGQuery` - Structure of a query
- `RAGResultSchema` / `RAGResult` - Structure of query results
- `RAGStatsSchema` / `RAGStats` - Database statistics
- `IndexResultSchema` / `IndexResult` - Result from indexing operation

## Architecture

See the [RAG Design Document](../../docs/plans/2025-12-29-rag-design.md) for complete architecture details.

**Key principles:**
- **Interface-first**: Define contracts before implementations
- **Pluggable components**: All providers are swappable
- **Read/write separation**: Query providers for agents, admin providers for build tools
- **Rich metadata**: Enable powerful filtered searches

## Development

```bash
# Build
bun run build

# Test
bun test

# Type check
bun run typecheck
```

## License

MIT
