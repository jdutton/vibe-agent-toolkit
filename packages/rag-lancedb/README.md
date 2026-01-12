# @vibe-agent-toolkit/rag-lancedb

LanceDB implementation of RAG interfaces for vibe-agent-toolkit.

## Overview

This package provides a complete RAG (Retrieval-Augmented Generation) implementation using LanceDB as the vector database. It implements both `RAGQueryProvider` (read-only) and `RAGAdminProvider` (read/write) interfaces.

**Features:**
- Local file-based vector database (no server required)
- Fast vector search with LanceDB
- Resource-level change detection (content hashing)
- Readonly and admin modes
- Persistent storage with Apache Arrow

## Installation

```bash
bun add @vibe-agent-toolkit/rag-lancedb
```

## Quick Start

### Building a RAG Database

```typescript
import { LanceDBRAGProvider } from '@vibe-agent-toolkit/rag-lancedb';
import { TransformersEmbeddingProvider } from '@vibe-agent-toolkit/rag';
import { ResourceRegistry } from '@vibe-agent-toolkit/resources';

// 1. Scan resources
const registry = new ResourceRegistry();
await registry.crawl({ baseDir: './docs' });

// 2. Create admin provider
const admin = await LanceDBRAGProvider.create({
  dbPath: './rag-db',
  embeddingProvider: new TransformersEmbeddingProvider(),
});

// 3. Index resources
const result = await admin.indexResources(registry.getAllResources());
console.log(`Indexed ${result.chunksCreated} chunks`);

await admin.close();
```

### Querying a RAG Database

```typescript
import { LanceDBRAGProvider } from '@vibe-agent-toolkit/rag-lancedb';

// Open in readonly mode (for agents)
const rag = await LanceDBRAGProvider.create({
  dbPath: './rag-db',
  readonly: true,
});

// Query
const result = await rag.query({
  text: 'How do I validate schemas?',
  limit: 5,
  filters: {
    tags: ['validation'],
  },
});

// Use results
for (const chunk of result.chunks) {
  console.log(`[${chunk.headingPath}] ${chunk.content}`);
}
```

## Architecture

- **Database**: LanceDB (Apache Arrow format)
- **Storage**: Local file-based (`.lance` directory)
- **Change Detection**: Content hashing (SHA-256)
- **Updates**: Resource-level (delete old chunks, re-embed new)

## Dependencies

### Apache Arrow Compatibility

**Important**: This package requires `apache-arrow@18.1.0` explicitly specified as a dependency.

**Why**: The `@lancedb/lancedb@0.23.0` package requires `apache-arrow >=15.0.0 <=18.1.0`, but Bun bundles `apache-arrow@14.0.2` by default. Without an explicit dependency, schema inference fails with:

```
TypeError: Table and inner RecordBatch schemas must be equivalent
```

**Resolution**: We use `apache-arrow@18.1.0` (the latest compatible version) for:
- Latest bug fixes from Apache Arrow releases 15.x through 18.1.0
- Packaging improvements (primary focus of 18.1.0 release)
- Better TypeScript/JavaScript compatibility

This is fully compatible with Node.js - the explicit dependency only overrides Bun's bundled version.

## License

MIT
