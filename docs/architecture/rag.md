# RAG (Retrieval-Augmented Generation) Architecture

**Status**: Production Ready
**Last Updated**: 2025-12-31

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Core Components](#core-components)
4. [Usage Patterns](#usage-patterns)
5. [Configuration](#configuration)
6. [Best Practices](#best-practices)
7. [Troubleshooting](#troubleshooting)

---

## Overview

The VAT RAG system enables semantic search over markdown documentation using vector embeddings. It provides a two-layer architecture with abstract interfaces and pluggable implementations.

### Key Features

- **Semantic Search**: Find content by meaning, not just keywords
- **Hybrid Chunking**: Markdown-aware chunking with token limits
- **Pluggable Providers**: Swap embedding providers and vector databases
- **Incremental Updates**: Skip unchanged files, update only modifications
- **Local-First**: LanceDB runs entirely locally, no external services required
- **Project Configuration**: Named stores and collections for complex projects

### Primary Use Cases

1. **Agent Knowledge Bases**: Agents search their own documentation
2. **Generic Document Search**: Search any project's markdown files
3. **Multi-Agent Sharing**: Multiple agents using shared RAG databases

---

## Architecture

### Package Structure

```
@vibe-agent-toolkit/rag              # Abstract interfaces + shared implementations
  ├── interfaces/                    # Provider contracts
  ├── schemas/                       # Zod schemas for validation
  ├── token-counters/                # Fast and approximate token counting
  ├── embedding-providers/           # Transformers.js and OpenAI
  └── chunking/                      # Markdown-aware chunking logic

@vibe-agent-toolkit/rag-lancedb      # LanceDB implementation
  ├── provider.ts                    # Implements RAGQueryProvider + RAGAdminProvider
  └── __tests__/                     # Integration tests with real DB

@vibe-agent-toolkit/cli              # User-facing commands
  └── commands/rag/                  # index, query, stats, clear
```

### Dependency Flow

```
cli → rag-lancedb → rag → utils
              ↓
          resources
```

### Design Principles

1. **Interface-First**: Define contracts before implementations
2. **Read/Write Separation**: Query (agents) vs Admin (build tools)
3. **Pluggable Components**: TokenCounter, EmbeddingProvider, RAGProvider swappable
4. **ResourceRegistry Integration**: Leverage existing markdown parsing
5. **Database as Cache**: Vector DB provides persistence, no separate cache layer

---

## Core Components

### 1. RAG Interfaces

#### `RAGQueryProvider` (Read-Only)

What agents use at runtime:

```typescript
interface RAGQueryProvider {
  query(params: {
    text: string;
    limit?: number;
    filters?: RAGQueryFilters;
  }): Promise<RAGQueryResult>;

  stats(): Promise<RAGStats>;
  close(): Promise<void>;
}
```

**Usage**: Agents call `query()` to find relevant chunks, never index data.

#### `RAGAdminProvider` (Read-Write)

What build tools use:

```typescript
interface RAGAdminProvider {
  index(resources: ResourceRegistry): Promise<IndexResult>;
  clear(): Promise<void>;
}
```

**Usage**: CLI `vat rag index` uses this to build/update the database.

### 2. Token Counters

#### `FastTokenCounter` (Default)

- **Algorithm**: `bytes / 4` heuristic
- **Speed**: Instant (no tokenization)
- **Accuracy**: ±20% error
- **Use When**: Speed matters more than precision

#### `ApproximateTokenCounter`

- **Algorithm**: Uses `gpt-tokenizer` library
- **Speed**: ~100x slower than fast counter
- **Accuracy**: ±5% error
- **Use When**: Precision required for token limits

### 3. Embedding Providers

#### `TransformersEmbeddingProvider` (Default)

- **Model**: `Xenova/all-MiniLM-L6-v2` (384 dimensions)
- **Speed**: ~100 chunks/sec on M1 Mac
- **Size**: ~90MB model download (cached locally)
- **Pro**: No API costs, works offline
- **Con**: Lower quality than OpenAI

#### `OpenAIEmbeddingProvider`

- **Model**: `text-embedding-3-small` (1536 dimensions)
- **Speed**: Depends on API latency (~50 chunks/sec with batching)
- **Cost**: $0.02 per 1M tokens
- **Pro**: Higher quality, better retrieval accuracy
- **Con**: Requires API key, costs money

### 4. Chunking Strategy

**Hybrid approach**: Markdown heading boundaries + token-aware splitting

```
1. Parse markdown → Extract sections by headings (ResourceRegistry)
2. For each section:
   - If tokens <= targetSize → single chunk
   - If tokens > targetSize → split into smaller chunks
3. Link chunks: previousChunkId, nextChunkId
4. Add metadata: headingPath, file location, content hash
```

**Key Parameters**:
- `targetSize`: 512 tokens (default, adjustable)
- `paddingFactor`: 0.9 (10% safety margin for token estimation error)

### 5. LanceDB Provider

**Implementation**: `LanceDBRAGProvider` implements both Query and Admin interfaces.

**Features**:
- Local vector database (no server required)
- HNSW index for fast similarity search
- Change detection via content hashes
- Resource-level updates (delete old chunks, insert new)

**Storage**: `.rag-db/` directory containing:
- `chunks.lance` - LanceDB table with vectors + metadata
- `.last_indexed` - Timestamp tracking

---

## Usage Patterns

### Pattern 1: Quick Start (Standalone)

Index documentation and search:

```bash
# Index docs
vat rag index docs/

# Query database
vat rag query "error handling"

# View stats
vat rag stats

# Clear database
vat rag clear
```

**Use When**: Exploring RAG for the first time, no project config.

### Pattern 2: Project Configuration (Recommended)

Create `vibe-agent-toolkit.config.yaml`:

```yaml
version: 1

resources:
  collections:
    project-docs:
      include:
        - ./docs/**/*.md
        - ./README.md

rag:
  stores:
    docs-rag:
      db: ./dist/docs-rag
      resources: project-docs
```

Then use named references:

```bash
vat rag index --config docs-rag   # Uses named store
vat rag query "error handling"     # Uses default store
```

**Use When**: Building production agents, complex projects with multiple RAG stores.

### Pattern 3: Agent Knowledge Base

Agent manifest references RAG store:

```yaml
# agent.yaml
spec:
  tools:
    - name: knowledge_base
      type: rag
      config:
        store: docs-rag  # References config
```

Agent queries at runtime:

```typescript
const ragProvider = await createRAGProvider({
  dbPath: './dist/docs-rag',
  readonly: true,
});

const result = await ragProvider.query({
  text: userQuestion,
  limit: 10,
});

// Use result.chunks for context
```

**Use When**: Building agents that need to reference documentation.

### Pattern 4: Multi-Store Project

Multiple RAG stores for different content types:

```yaml
# vibe-agent-toolkit.config.yaml
resources:
  collections:
    api-docs:
      include: ['./api/**/*.md']
    examples:
      include: ['./examples/**/*.md']
    guides:
      include: ['./guides/**/*.md']

rag:
  stores:
    api-rag:
      db: ./dist/api-rag
      resources: api-docs
    examples-rag:
      db: ./dist/examples-rag
      resources: examples
    guides-rag:
      db: ./dist/guides-rag
      resources: guides
```

**Use When**: Large projects with distinct content categories requiring separate indexes.

---

## Configuration

### Complete Config Example

```yaml
version: 1

# Resource collections (reusable)
resources:
  defaults:
    exclude:
      - '**/node_modules/**'
      - '**/dist/**'
    metadata:
      frontmatter: true

  collections:
    project-docs:
      include:
        - ./docs/**/*.md
        - ./README.md
      metadata:
        defaults:
          type: documentation

# RAG stores
rag:
  defaults:
    embedding:
      provider: transformers-js
      model: Xenova/all-MiniLM-L6-v2
    chunking:
      targetSize: 512
      paddingFactor: 0.9

  stores:
    main:
      db: ./dist/rag-db
      resources: project-docs
      embedding:
        provider: openai              # Override for this store
        model: text-embedding-3-small
```

### CLI Flags

All RAG commands support:

- `--db <path>` - Database path (default: `.rag-db`)
- `--debug` - Enable debug logging
- `--config <path>` - Config file path (default: `vibe-agent-toolkit.config.yaml`)

---

## Best Practices

### Chunking Strategy

**Target Size Selection**:
- **512 tokens**: General documentation (default, good balance)
- **256 tokens**: Code snippets, API references (more granular)
- **1024 tokens**: Long-form guides, tutorials (more context)

**Padding Factor**:
- **0.9** (default): Safe for fast token counter (±20% error)
- **0.95**: For approximate counter (±5% error)
- **1.0**: Only if using exact tokenization

### Embedding Provider Choice

| Provider | When to Use |
|----------|-------------|
| transformers-js | Default, offline-first, cost-free |
| openai | Higher accuracy required, API key available |

**Cost Comparison** (1000 markdown files, 500 chunks each):
- transformers-js: $0 (one-time 90MB download)
- openai: ~$5 (500k chunks × $0.02 / 1M tokens)

### Index Update Strategy

**Incremental Updates** (default):
```bash
vat rag index docs/  # Skips unchanged files
```

**Force Rebuild** (when changing embedding models):
```bash
vat rag clear
vat rag index docs/
```

### Performance Optimization

1. **Batch Indexing**: Index all docs at once, not one-by-one
2. **Cache Models**: Transformers.js caches models in `~/.cache/`
3. **Separate Stores**: Multiple stores > one large store for unrelated content
4. **Prune Old Content**: Run `vat rag clear` when docs are restructured

---

## Troubleshooting

### Problem: Query returns no results

**Symptoms**: `vat rag query "..."` returns empty chunks array

**Solutions**:
1. Check database exists: `vat rag stats`
2. Verify indexing completed: Look for "resourcesIndexed" count
3. Try broader query: "configuration" instead of "vat.config.yaml schema"
4. Check embedding model matches between index and query

### Problem: Slow indexing

**Symptoms**: Indexing takes >5 minutes for 1000 files

**Solutions**:
1. Switch to `FastTokenCounter` (default)
2. Use transformers-js (faster than OpenAI for large batches)
3. Reduce `targetSize` (fewer chunks = faster indexing)
4. Check disk I/O (SSD vs HDD)

### Problem: Model download fails

**Symptoms**: `Failed to load model: network error`

**Solutions**:
1. Check internet connection
2. Verify Hugging Face Hub is accessible
3. Set HF cache directory: `export HF_HOME=/path/to/cache`
4. Use OpenAI provider if transformers.js unavailable

### Problem: Out of memory during indexing

**Symptoms**: `JavaScript heap out of memory`

**Solutions**:
1. Increase Node.js memory: `NODE_OPTIONS=--max-old-space-size=4096`
2. Index in smaller batches
3. Reduce `targetSize` (larger chunks = more memory)
4. Close other applications

### Problem: Inaccurate token counts

**Symptoms**: Chunks exceed model limits despite padding factor

**Solutions**:
1. Switch to `ApproximateTokenCounter`
2. Reduce `paddingFactor` to 0.8-0.85
3. Inspect failed chunks: Look at `tokenCount` field
4. Report issue with example markdown

### Problem: Database corruption

**Symptoms**: `Error: Invalid LanceDB file`

**Solutions**:
1. Clear and rebuild: `vat rag clear && vat rag index`
2. Check disk space (>100MB free)
3. Verify no concurrent writes
4. Update LanceDB: `bun update @lancedb/lancedb`

### Problem: Query results not relevant

**Symptoms**: Returned chunks don't match query intent

**Solutions**:
1. Try different query phrasing
2. Increase `--limit` to see more results
3. Switch to OpenAI embeddings (higher quality)
4. Check source documents are well-written
5. Consider hybrid search (not yet implemented)

---

## Future Enhancements

- **Hybrid Search**: Combine vector search with keyword matching
- **Reranking**: Use cross-encoder for result reranking
- **Metadata Filters**: Filter by file type, tags, date
- **Multi-Modal**: Support images, code, diagrams
- **Distributed RAG**: Share databases across team
- **Live Updates**: Watch filesystem for changes

---

**See Also**:
- [CLI Architecture](./cli.md)
