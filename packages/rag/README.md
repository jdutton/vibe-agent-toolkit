# @vibe-agent-toolkit/rag

Abstract RAG (Retrieval-Augmented Generation) interfaces and shared implementations for vibe-agent-toolkit.

## Overview

This package provides the core interfaces and schemas for RAG functionality in VAT (Vibe Agent Toolkit). It defines contracts that RAG implementations must follow, ensuring portability and consistency across different vector database backends.

**What's included:**
- **Interfaces**: `RAGQueryProvider`, `RAGAdminProvider`, `EmbeddingProvider`, `TokenCounter`
- **Schemas**: Zod schemas with TypeScript types and JSON Schema exports
- **Token counters**: `FastTokenCounter` (bytes/4 heuristic), `ApproximateTokenCounter` (gpt-tokenizer)
- **Embedding providers**: `TransformersEmbeddingProvider` (local, transformers.js), `OpenAIEmbeddingProvider` (cloud, OpenAI API)
- **Chunking utilities**: Hybrid heading-based + token-aware chunking with ResourceRegistry integration

**What's NOT included:**
- Vector database implementations (see `@vibe-agent-toolkit/rag-lancedb`)

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

## Embedding Providers

Embedding providers convert text to vector embeddings for semantic search.

### Available Implementations

#### TransformersEmbeddingProvider (Default)

Local embedding generation using transformers.js - no API key required.

```typescript
import { TransformersEmbeddingProvider } from '@vibe-agent-toolkit/rag';

const provider = new TransformersEmbeddingProvider();
// Default model: Xenova/all-MiniLM-L6-v2 (384 dimensions)

const embedding = await provider.embed('Search query text');
console.log(embedding.length); // 384

// Batch embedding for efficiency
const embeddings = await provider.embedBatch(['text1', 'text2', 'text3']);
```

**Characteristics:**
- **Speed**: Fast (local inference)
- **Quality**: Good (suitable for most use cases)
- **Cost**: Free (no API calls)
- **API Key**: Not required
- **Dimensions**: 384 (all-MiniLM-L6-v2)
- **Use case**: Default choice for most projects

**First run**: Downloads model (~20MB for all-MiniLM-L6-v2)

#### OpenAIEmbeddingProvider (Optional)

Cloud-based embedding using OpenAI API - requires API key.

```typescript
import { OpenAIEmbeddingProvider } from '@vibe-agent-toolkit/rag';

const provider = new OpenAIEmbeddingProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'text-embedding-3-small', // or 'text-embedding-3-large'
});

const embedding = await provider.embed('Search query text');
console.log(embedding.length); // 1536

// Custom dimensions (text-embedding-3-* models only)
const customProvider = new OpenAIEmbeddingProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'text-embedding-3-small',
  dimensions: 512, // Reduce dimensions for faster search
});
```

**Characteristics:**
- **Speed**: Medium (network latency)
- **Quality**: Excellent (state-of-art)
- **Cost**: Paid (per token)
- **API Key**: Required
- **Dimensions**: 1536 (small) or 3072 (large)
- **Use case**: Production agents requiring highest quality

**Installation**: `bun add openai` (optional dependency)

### Choosing an Embedding Provider

| Provider | Speed | Quality | Cost | Dimensions | Use Case |
|----------|-------|---------|------|------------|----------|
| TransformersEmbeddingProvider | Fast | Good | Free | 384 | Default choice |
| OpenAIEmbeddingProvider | Medium | Excellent | Paid | 1536-3072 | Production, high quality |

### Model Selection Guidelines

**Use TransformersEmbeddingProvider when:**
- Building locally or in development
- Budget-conscious or high-volume scenarios
- Good quality is sufficient (most use cases)
- Want to avoid API dependencies

**Use OpenAIEmbeddingProvider when:**
- Deploying production agents with budget
- Need highest quality search results
- Working with complex or nuanced queries
- Want proven, well-tested models

## Chunking

Chunking utilities split documents into semantic chunks for embedding and retrieval.

### Strategy

**Hybrid Approach:**
1. **Heading boundaries** - Primary split points (respects markdown structure)
2. **Token-aware splitting** - Splits large sections by paragraphs to fit token limits
3. **Padding factor** - Safety margin to avoid exceeding model limits
4. **Context linking** - previousChunkId/nextChunkId for context expansion

### Usage

```typescript
import { chunkResource, enrichChunks } from '@vibe-agent-toolkit/rag';
import { ApproximateTokenCounter } from '@vibe-agent-toolkit/rag';
import { ResourceRegistry } from '@vibe-agent-toolkit/resources';

// 1. Get resource from ResourceRegistry
const registry = new ResourceRegistry();
await registry.crawl({ baseDir: './docs' });
const metadata = registry.getResourceById('resource-id');

// 2. Read file content and parse frontmatter (not included in ResourceMetadata)
const content = await fs.readFile(metadata.filePath, 'utf-8');
const frontmatter = /* parse frontmatter */;
const resource = { ...metadata, content, frontmatter };

// 3. Configure chunking
const config = {
  targetChunkSize: 512,         // Ideal chunk size
  modelTokenLimit: 8191,         // Hard limit (embedding model)
  paddingFactor: 0.9,            // 90% of target (safety margin)
  tokenCounter: new ApproximateTokenCounter(),
};

// 4. Chunk the resource
const result = chunkResource(resource, config);
console.log(`Created ${result.stats.totalChunks} chunks`);
console.log(`Average tokens: ${result.stats.averageTokens}`);

// 5. Enrich with embeddings (after embedding)
const embeddings = await embeddingProvider.embedBatch(
  result.chunks.map(c => c.content)
);

const ragChunks = enrichChunks(
  result.chunks,
  resource,
  embeddings,
  'text-embedding-3-small'
);
```

### Configuration

| Option | Description | Example |
|--------|-------------|---------|
| `targetChunkSize` | Ideal chunk size in tokens | 512 |
| `modelTokenLimit` | Hard limit (embedding model) | 8191 (OpenAI) |
| `paddingFactor` | Safety margin (0.8-1.0) | 0.9 (ApproximateTokenCounter) |
| `tokenCounter` | Token counter to use | ApproximateTokenCounter |
| `minChunkSize` | Minimum chunk size (optional) | 50 |

### Padding Factor Guidelines

See [Token Counters](#token-counters) for padding factor recommendations:
- **FastTokenCounter**: 0.8 (80% of target)
- **ApproximateTokenCounter**: 0.9 (90% of target)

Lower accuracy = lower padding factor (more safety margin)

### Utilities

```typescript
import {
  chunkByTokens,
  splitByParagraphs,
  splitBySentences,
  generateContentHash,
  generateChunkId,
  calculateEffectiveTarget,
} from '@vibe-agent-toolkit/rag';

// Split text by token count
const chunks = chunkByTokens('long text...', config);

// Split by paragraphs
const paragraphs = splitByParagraphs(text);

// Generate content hash for change detection
const hash = generateContentHash(content);

// Calculate effective target with padding
const effectiveTarget = calculateEffectiveTarget(512, 0.9); // 460
```

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
