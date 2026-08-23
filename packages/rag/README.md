# @vibe-agent-toolkit/rag

Abstract RAG (Retrieval-Augmented Generation) interfaces and shared implementations for vibe-agent-toolkit.

## Overview

This package provides the core interfaces and schemas for RAG functionality in VAT (Vibe Agent Toolkit). It defines contracts that RAG implementations must follow, ensuring portability and consistency across different vector database backends.

**What's included:**
- **Interfaces**: `RAGQueryProvider`, `RAGAdminProvider`, `EmbeddingProvider`, `TokenCounter`
- **Schemas**: Zod schemas with TypeScript types and JSON Schema exports
- **Token counters**: `FastTokenCounter` (bytes/4 heuristic), `ApproximateTokenCounter` (gpt-tokenizer)
- **Embedding providers**: `OnnxEmbeddingProvider` (local, batteries-included WASM), `OpenAIEmbeddingProvider` (cloud, OpenAI API)
- **Chunking utilities**: Hybrid heading-based + token-aware chunking with ResourceRegistry integration

**What's NOT included:**
- Vector database implementations (see `@vibe-agent-toolkit/rag-lancedb`)

## Custom Metadata

By default, RAG chunks include sensible metadata fields optimized for markdown documentation (filePath, tags, type, headingPath, etc.). You can extend or completely replace these defaults with your own custom metadata.

### Architecture

RAG chunks are composed of two parts:

1. **CoreRAGChunk** - Required fields for RAG functionality (identity, content, vectors, context)
2. **Metadata** - Flexible fields for filtering and organization

The default `RAGChunk` type is `CoreRAGChunk & DefaultRAGMetadata`.

### Defining Custom Metadata

Use Zod to define your custom metadata schema:

```typescript
import { z } from 'zod';
import {
  createCustomRAGChunkSchema,
  CoreRAGChunkSchema,
  DefaultRAGMetadataSchema,
} from '@vibe-agent-toolkit/rag';

// Option 1: Extend default metadata
const ExtendedMetadataSchema = DefaultRAGMetadataSchema.extend({
  domain: z.string(),
  priority: z.number().optional(),
});

// Option 2: Replace with custom metadata
const CustomMetadataSchema = z.object({
  sourceUrl: z.string(),
  domain: z.string(),
  category: z.string().optional(),
  keywords: z.array(z.string()),
});

// Create chunk schema
const CustomChunkSchema = createCustomRAGChunkSchema(CustomMetadataSchema);
type CustomChunk = z.infer<typeof CustomChunkSchema>;
```

### Type Safety

TypeScript automatically infers types from your Zod schema:

```typescript
const chunk: CustomChunk = {
  // Core fields (required)
  chunkId: 'chunk-1',
  resourceId: 'doc-1',
  content: 'Authentication guide',
  contentHash: 'abc123',
  tokenCount: 50,
  embedding: [0.1, 0.2, 0.3],
  embeddingModel: 'text-embedding-3-small',
  embeddedAt: new Date(),

  // Custom metadata fields
  sourceUrl: 'https://example.com/docs/auth.md',
  domain: 'security',
  keywords: ['auth', 'oauth', 'jwt'],
};
```

See the [LanceDB provider documentation](../rag-lancedb/README.md) for usage with databases.

## Installation

```bash
bun add @vibe-agent-toolkit/rag
```

## Packages

- `@vibe-agent-toolkit/rag` - This package (interfaces + shared implementations)
- `@vibe-agent-toolkit/rag-lancedb` - LanceDB implementation
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
- **Use case**: Quick validation, ResourceRegistry estimation — not chunking for
  embedding (the derived chunk budget is calibrated against cl100k counts, which
  this counter does not produce)

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
- **Use case**: RAG chunking, embedding preparation — this is the counter the
  derived padding factor assumes

### Choosing a Token Counter

| Counter | Speed | Accuracy | Use Case |
|---------|-------|----------|----------|
| FastTokenCounter | Very Fast | ~75% | Quick estimation |
| ApproximateTokenCounter | Fast | ~95% | RAG chunking |

The padding factor is deliberately absent from this table: it is not a property
of the counter you pick. It is derived from the *model's* token limit — see below.

### Padding Factor

The padding factor provides a safety margin to avoid exceeding embedding model token limits:

```typescript
const targetChunkSize = embeddingProvider.maxInputTokens; // e.g. 256 locally
const paddingFactor = 0.84;
const effectiveTarget = targetChunkSize * paddingFactor; // 215 tokens

// Chunk to effective target to avoid splits from estimation error
```

You should not compute this yourself: `resolveChunkingConfig()` in
`@vibe-agent-toolkit/rag-lancedb` derives both numbers from the provider and
warns when an override puts chunks back over the model's limit.

**Why padding matters:**
- Token estimation may be imperfect
- Targeting exact limit might exceed it, forcing inefficient splits
- The counter and the model may not share a tokenizer at all: the counters here
  measure in cl100k, while a local BERT model splits the same text into ~1.13-1.18x
  more WordPiece tokens. The margin has to cover that gap plus `[CLS]`/`[SEP]`,
  or full chunks overflow even when the target equals the model's limit exactly.

## Embedding Providers

Embedding providers convert text to vector embeddings for semantic search.

Full guide — the interface contract, both built-in providers, custom providers,
and troubleshooting: [Embedding Providers](../../docs/embedding-providers.md).

### Available Implementations

#### OnnxEmbeddingProvider (Default)

Local, batteries-included embedding generation using `onnxruntime-web` (WASM) - no API key, no extra install required.

```typescript
import { OnnxEmbeddingProvider } from '@vibe-agent-toolkit/rag';

const provider = new OnnxEmbeddingProvider();
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
- **Max input tokens**: 256 — all-MiniLM-L6-v2 was trained at 256 positions, so
  this is a property of the model, not a tunable. The `maxSequenceLength` config
  option publishes it as `maxInputTokens`; raising it to make chunks "fit" only
  moves the truncation from the chunker to the model.
- **Use case**: Default choice for most projects

**First run**: Downloads model (~23MB int8-quantized for all-MiniLM-L6-v2)

**Teardown**: implements `dispose()`. The WASM backend has no finalizer, so a
session that is never released leaks for the life of the process. The provider
reloads transparently if it is used again after disposal.

**Truncation reporting**: exposes a `truncationStats` snapshot and an
`onTruncation` callback — non-zero `tokensDropped` means the corpus that was
indexed is not the corpus the model saw.

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
- **Max input tokens**: 8192 for `text-embedding-3-*`, 8191 for ada-002 — looked
  up per model, with 8191 (the lowest documented limit) for an unrecognized one
- **Use case**: Production agents requiring highest quality

**Installation**: `bun add openai` (optional dependency)

### Choosing an Embedding Provider

| Provider | Speed | Quality | Cost | Dimensions | `maxInputTokens` | Use Case |
|----------|-------|---------|------|------------|------------------|----------|
| OnnxEmbeddingProvider | Fast | Good | Free | 384 | 256 | Default choice |
| OpenAIEmbeddingProvider | Medium | Excellent | Paid | 1536-3072 | 8192 (8191 ada-002) | Production, high quality |

Dimensions tell you nothing about the input limit — these two differ by 32x on
it. Anything that sizes text for a model must read the limit off the provider in
use.

### Model Selection Guidelines

**Use OnnxEmbeddingProvider when:**
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
import { resolveChunkingConfig } from '@vibe-agent-toolkit/rag-lancedb';
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
//
// Prefer `resolveChunkingConfig()` from `@vibe-agent-toolkit/rag-lancedb`, which
// derives the whole budget from the provider and returns warnings. Spelled out
// here only to show what it produces; every number comes off the provider, never
// from a constant.
const { config, warnings } = resolveChunkingConfig({
  embeddingProvider,
  tokenCounter: new ApproximateTokenCounter(),
  targetChunkSize: undefined,    // derive from the provider
  paddingFactor: undefined,      // derive from the provider
});
for (const warning of warnings) console.warn(warning);
// => { targetChunkSize: 256, modelTokenLimit: 256, paddingFactor: 0.84, ... }
//    for the default local model; 8192 / 8192 / 0.84 for text-embedding-3-small.

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
  embeddingProvider.model
);
```

### Configuration

| Option | Description | Source |
|--------|-------------|--------|
| `targetChunkSize` | Ideal chunk size in tokens | `embeddingProvider.maxInputTokens` |
| `modelTokenLimit` | Hard limit — read it off the provider, never hardcode | `embeddingProvider.maxInputTokens` |
| `paddingFactor` | Safety margin (0.8-1.0) | derived by `resolveChunkingConfig()`; ~0.84 for both built-in providers |
| `tokenCounter` | Token counter to use | ApproximateTokenCounter |
| `minChunkSize` | Minimum chunk size (optional) | declared on `ChunkingConfig`, but no chunker currently reads it — setting it has no effect |

Every `EmbeddingProvider` publishes `maxInputTokens`, its model's real per-input
token limit, as a required member precisely so no consumer has to guess. Why it
is required and how to source it for a custom provider:
[Embedding Providers](../../docs/embedding-providers.md#maxinputtokens-is-a-measurement-not-a-setting).

### Padding Factor Guidelines

Don't pick one. `resolveChunkingConfig()` derives it from the model's limit as
roughly `(limit - 2) / (limit * 1.18)` — the two special tokens plus the gap
between the chunker's cl100k counts and the model's own tokenizer — which lands
near **0.84** for both built-in providers. There are no longer per-counter
recommendations: a factor chosen for the counter (0.9, say) overruns a
256-token model, and `resolveChunkingConfig()` will warn if you pass one.

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

// Calculate effective target with padding (both numbers derived, not chosen)
const effectiveTarget = calculateEffectiveTarget(256, 0.84); // 215
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

Interface for embedding providers (onnx, OpenAI, etc.)

```typescript
interface EmbeddingProvider {
  /** Provider name: "openai", "onnx", etc. */
  name: string;

  /** Model name: "text-embedding-3-small", "all-MiniLM-L6-v2", etc. */
  model: string;

  /** Embedding vector dimensions */
  dimensions: number;

  /**
   * Maximum number of tokens this provider's model reads for a single input,
   * INCLUDING whatever special tokens its tokenizer adds.
   *
   * Required, deliberately: it is a hard property of the model, and text beyond
   * it is discarded before inference. Look it up per model — never copy one
   * constant across models, and never restate it in a decorator (delegate to
   * the wrapped provider instead).
   */
  maxInputTokens: number;

  embed(text: string): Promise<number[]>;

  embedBatch(texts: string[]): Promise<number[][]>;

  /**
   * Release any resources held by the provider (optional).
   *
   * Implement it only if the provider holds a native or long-lived resource
   * (an inference session, a socket). No-op for pure-JS/HTTP providers.
   */
  dispose?(): Promise<void>;
}
```

Writing your own provider: see
[Embedding Providers](../../docs/embedding-providers.md#creating-a-custom-provider)
for a complete worked implementation and the rules around `maxInputTokens`.

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
bun run test:unit

# Type check
bun run typecheck
```

## License

MIT
