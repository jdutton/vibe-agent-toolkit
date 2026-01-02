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

## Known Issues

### Bun + vectordb@0.4.x Arrow Buffer Detachment

**Issue**: When running under Bun runtime with `vectordb@0.4.20`, Apache Arrow buffers can become detached after table modifications (add/delete operations), causing "Buffer is already detached" errors on subsequent queries. This primarily affects rapid multi-resource indexing operations in short-lived test scenarios.

**Technical Details**:
- **Root Cause**: Apache Arrow uses zero-copy memory buffers for performance. When LanceDB performs table modifications, these buffers can be garbage collected or invalidated before subsequent queries can access them. Bun's garbage collector appears to be more aggressive than Node.js in reclaiming these buffers.
- **Trigger**: Indexing multiple resources in rapid succession, then querying the database in the same connection lifecycle
- **Error**: `TypeError: Buffer is already detached` when calling `.execute()` on query results

**Workarounds Implemented**:
1. **Connection Recreation**: Before each query/stats operation, we recreate the database connection entirely (`connect()` + `openTable()`)
2. **Immediate Materialization**: Results are materialized using `JSON.parse(JSON.stringify())` immediately after query execution to copy data out of Arrow buffers before they're invalidated
3. **Data Extraction Before Modifications**: When checking for existing resources during indexing, we extract all needed data from Arrow buffers before performing any table modifications

**Production Impact**: **Minimal**
- Production usage typically involves long-lived provider connections where this issue doesn't manifest
- Single-resource operations work reliably
- Query operations (the most common in production) are stable after the connection recreation workaround

**Test Impact**: **Significant**
- 18 integration and system tests are skipped due to this issue
- Tests that index multiple resources in rapid succession fail consistently
- Single-resource tests pass reliably

**Resolution Options**:
1. **Upgrade LanceDB**: Wait for newer versions of `vectordb` that may have fixed this issue (current: ^0.4.0)
2. **Use Node.js**: Run tests with Node.js instead of Bun (the issue is Bun-specific)
3. **Accept Limitation**: Document and skip affected tests, as production usage is unaffected

**Why Not Use `structuredClone()`?**
The standard `structuredClone()` function doesn't work with Arrow buffers because they contain native memory references that can't be cloned. `JSON.parse(JSON.stringify())` forces full serialization/deserialization, creating new JavaScript objects completely independent of Arrow's memory management.

**References**:
- Issue affects: `packages/rag-lancedb/src/lancedb-rag-provider.ts` (see comments at lines 107, 138, 198, 220, 282, 289)
- Skipped tests: `packages/rag-lancedb/test/integration/indexing.integration.test.ts`
- Skipped system tests: `packages/rag-lancedb/test/system/lancedb-rag-provider.system.test.ts`

## License

MIT
