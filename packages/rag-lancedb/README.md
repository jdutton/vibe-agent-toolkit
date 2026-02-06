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

## Custom Metadata

LanceDBRAGProvider supports custom metadata schemas with automatic type inference.

### Basic Usage (Default Metadata)

```typescript
import { LanceDBRAGProvider } from '@vibe-agent-toolkit/rag-lancedb';

const provider = await LanceDBRAGProvider.create({
  dbPath: './rag-db',
});

// Query with default metadata filters
const result = await provider.query({
  text: 'authentication',
  filters: {
    metadata: {
      tags: ['security'],
      type: 'guide',
    },
  },
});

// Chunks have default metadata
result.chunks[0].filePath; // ✅ string
result.chunks[0].tags; // ✅ string[] | undefined
```

### Custom Metadata Schema

Define a custom schema and the provider automatically infers types:

```typescript
import { z } from 'zod';
import { LanceDBRAGProvider } from '@vibe-agent-toolkit/rag-lancedb';

const MyMetadataSchema = z.object({
  domain: z.string(),
  category: z.string().optional(),
  priority: z.number(),
  keywords: z.array(z.string()),
});

const provider = await LanceDBRAGProvider.create({
  dbPath: './rag-db',
  metadataSchema: MyMetadataSchema,
});

// Query with custom metadata filters (type-safe!)
const result = await provider.query({
  text: 'authentication',
  filters: {
    metadata: {
      domain: 'security', // ✅ Type-safe
      priority: 1, // ✅ Type-safe
      // category: 123, // ❌ Type error: not a string
    },
  },
});

// Chunks have custom metadata (fully typed)
result.chunks[0].domain; // ✅ string
result.chunks[0].priority; // ✅ number
result.chunks[0].keywords; // ✅ string[]
```

### Extending Default Metadata

Combine default metadata with custom fields:

```typescript
import { DefaultRAGMetadataSchema } from '@vibe-agent-toolkit/rag';

const ExtendedSchema = DefaultRAGMetadataSchema.extend({
  domain: z.string(),
  priority: z.number().optional(),
});

const provider = await LanceDBRAGProvider.create({
  dbPath: './rag-db',
  metadataSchema: ExtendedSchema,
});

// Chunks have both default and custom fields
result.chunks[0].filePath; // ✅ Default field
result.chunks[0].tags; // ✅ Default field
result.chunks[0].domain; // ✅ Custom field
```

### Schema Serialization

LanceDB uses Apache Arrow format, which requires consistent column types. Custom metadata is automatically serialized:

- **Arrays** → Comma-separated strings
- **Objects** → JSON strings
- **Dates** → Unix timestamps
- **Primitives** → Stored as-is

The provider handles serialization/deserialization automatically based on your Zod schema.

### Filtering

All metadata fields (default or custom) are filterable:

```typescript
const result = await provider.query({
  text: 'authentication',
  filters: {
    // Core filters
    resourceId: 'doc-1',
    dateRange: { start: new Date('2025-01-01'), end: new Date() },

    // Metadata filters (type-safe)
    metadata: {
      domain: 'security',
      priority: 1,
      keywords: 'oauth', // Array field (substring match)
    },
  },
});
```

Array fields use substring matching (SQL `LIKE`). Other fields use exact matching.

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

## Migration Guide

### Upgrading from v0.1.7 to v0.1.8

**⚠️ BREAKING CHANGE**: Metadata storage format has changed. Existing LanceDB indexes must be rebuilt.

#### What Changed

**v0.1.7 and earlier:**
- Metadata stored as nested struct: `metadata.field`
- Filters failed on large indexes (>1000 chunks)

**v0.1.8 and later:**
- Metadata stored as top-level columns: `field`
- Filters work efficiently at any scale

#### Migration Steps

**Option 1: Clear and Rebuild (Recommended)**

```typescript
import { LanceDBRAGProvider } from '@vibe-agent-toolkit/rag-lancedb';

// 1. Create provider (will open existing index)
const provider = await LanceDBRAGProvider.create({
  dbPath: './rag-db',
  metadataSchema: MyMetadataSchema,  // Your custom schema
});

// 2. Clear old index
await provider.clear();

// 3. Re-index all resources with new schema
const resources = await loadYourResources();
await provider.indexResources(resources);

console.log('Migration complete!');
```

**Option 2: Create New Index Path**

```typescript
// Keep old index as backup
const provider = await LanceDBRAGProvider.create({
  dbPath: './rag-db-v0.1.8',  // New path
  metadataSchema: MyMetadataSchema,
});

await provider.indexResources(resources);

// After verifying new index works:
// rm -rf ./rag-db  // Delete old index
```

#### Verification

After migration, test that filtering works:

```typescript
const result = await provider.query({
  text: 'your query',
  filters: {
    metadata: {
      domain: 'security',  // Your custom field
    },
  },
});

console.log(`Found ${result.chunks.length} results`);
// Should return filtered results (not empty!)
```

#### API Compatibility

✅ **No code changes required** - The query API remains the same:

```typescript
// This syntax works in both v0.1.7 and v0.1.8
const result = await provider.query({
  text: 'query',
  filters: {
    metadata: { domain: 'security' },  // Same API
  },
});
```

The change is **internal only** - metadata is now stored differently in LanceDB for better performance at scale.

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
