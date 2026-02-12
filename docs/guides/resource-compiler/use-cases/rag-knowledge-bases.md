---
title: Creating RAG Knowledge Bases
description: Patterns for building searchable knowledge bases using compiled markdown resources
category: guide
tags: [resource-compiler, rag, embeddings, search, knowledge-base]
audience: intermediate
---

# Creating RAG Knowledge Bases

Build searchable knowledge bases for Retrieval-Augmented Generation (RAG) systems using compiled markdown resources.

---

## What This Guide Covers

- Fragment-based RAG (using H2 sections)
- Custom chunking strategies with original markdown
- Vector database integration
- Semantic search patterns
- Hybrid search (keyword + semantic)
- Query optimization

**Audience:** Developers building RAG systems for documentation search, Q&A, or knowledge retrieval.

---

## Prerequisites

- Understanding of [resource compilation](../compiling-markdown-to-typescript.md)
- Basic RAG/embedding knowledge
- Familiarity with vector databases (optional)

---

## Fragment-Based RAG

### Why Use Fragments for RAG?

Compiled resources provide **pre-chunked content** via H2 sections:

**Advantages:**
- ✅ Semantic boundaries (author-defined sections)
- ✅ Consistent chunk sizes (per-section granularity)
- ✅ Type-safe access to chunks
- ✅ Metadata included (frontmatter)
- ✅ No parsing overhead at runtime

**When to use:**
- Documentation with clear H2 structure
- Technical guides with distinct sections
- API references with method-level docs
- Tutorials with step-by-step sections

### Basic Fragment Indexing

```typescript
import * as Docs from '@acme/kb/generated/resources/docs/architecture.js';
import { OnnxEmbeddingProvider } from '@vibe-agent-toolkit/rag';

// Each fragment is a natural chunk
const fragments = Object.entries(Docs.fragments).map(([name, fragment]) => ({
  id: `${Docs.meta.title}:${name}`,
  title: fragment.header.replace('## ', ''),
  content: fragment.body,
  metadata: {
    source: 'architecture.md',
    section: name,
    docTitle: Docs.meta.title,
    ...Docs.meta,
  },
}));

// Create embeddings
const embedder = new OnnxEmbeddingProvider();
const embeddings = await Promise.all(
  fragments.map(f => embedder.embed(f.content))
);

// Store in memory (or vector DB)
const vectorStore = fragments.map((fragment, i) => ({
  ...fragment,
  embedding: embeddings[i],
}));

console.log(`Indexed ${vectorStore.length} fragments`);
```

### Semantic Search Over Fragments

```typescript
function cosineSimilarity(a: number[], b: number[]): number {
  const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dotProduct / (magnitudeA * magnitudeB);
}

async function search(query: string, topK = 3) {
  // Embed the query
  const queryEmbedding = await embedder.embed(query);

  // Calculate similarities
  const scores = vectorStore.map(item => ({
    ...item,
    score: cosineSimilarity(queryEmbedding, item.embedding),
  }));

  // Return top K results
  return scores
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// Usage
const results = await search('How do I deploy to production?', 3);
results.forEach(r => {
  console.log(`${r.title} (score: ${r.score.toFixed(3)})`);
  console.log(r.content.substring(0, 200));
  console.log('---');
});
```

### Multi-Document Fragment Indexing

```typescript
import * as Architecture from '@acme/kb/generated/resources/docs/architecture.js';
import * as API from '@acme/kb/generated/resources/docs/api-reference.js';
import * as Deployment from '@acme/kb/generated/resources/docs/deployment.js';

const allDocs = [Architecture, API, Deployment];

// Index all fragments from all documents
const allFragments = allDocs.flatMap(doc =>
  Object.entries(doc.fragments).map(([name, fragment]) => ({
    id: `${doc.meta.title}:${name}`,
    title: fragment.header.replace('## ', ''),
    content: fragment.body,
    metadata: {
      docTitle: doc.meta.title,
      section: name,
      category: doc.meta.category,
      tags: doc.meta.tags,
    },
  }))
);

console.log(`Total fragments: ${allFragments.length}`);
```

---

## Custom Chunking with Original Markdown

### When to Use Custom Chunking

**Use custom chunking when:**
- H2 sections are too large (>1000 tokens)
- You need paragraph-level granularity
- Documents lack clear section structure
- You want overlapping chunks
- Semantic chunking is preferred

### Accessing Original Markdown

```typescript
import { readFileSync } from 'node:fs';

// Load original markdown
const mdPath = require.resolve('@acme/kb/resources/docs/architecture.md');
const markdown = readFileSync(mdPath, 'utf-8');
```

### Recursive Character Splitting

```typescript
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1000,        // Target chunk size
  chunkOverlap: 200,      // Overlap between chunks
  separators: ['\n\n', '\n', ' ', ''],
});

const chunks = await splitter.splitText(markdown);

console.log(`Created ${chunks.length} chunks`);
console.log(`Average size: ${chunks.reduce((s, c) => s + c.length, 0) / chunks.length} chars`);
```

### Semantic Chunking

```typescript
import { SemanticChunker } from 'langchain/text_splitter';
import { OnnxEmbeddingProvider } from '@vibe-agent-toolkit/rag';

const embedder = new OnnxEmbeddingProvider();

const semanticChunker = new SemanticChunker(embedder, {
  breakpointThreshold: 0.7,  // Similarity threshold
  minChunkSize: 100,
});

const semanticChunks = await semanticChunker.splitText(markdown);

console.log(`Semantic chunks: ${semanticChunks.length}`);
```

### Hybrid Approach: Fragments + Custom Chunking

```typescript
import * as Docs from '@acme/kb/generated/resources/docs/architecture.js';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 500,
  chunkOverlap: 50,
});

// Split large fragments into smaller chunks
const chunks = await Promise.all(
  Object.entries(Docs.fragments).flatMap(async ([name, fragment]) => {
    // Only split if fragment is large
    if (fragment.body.length > 800) {
      const subChunks = await splitter.splitText(fragment.body);
      return subChunks.map((chunk, i) => ({
        id: `${Docs.meta.title}:${name}:${i}`,
        content: chunk,
        metadata: {
          section: name,
          subsection: i,
          fragmentTitle: fragment.header,
        },
      }));
    }

    // Keep small fragments as-is
    return [{
      id: `${Docs.meta.title}:${name}`,
      content: fragment.body,
      metadata: {
        section: name,
        fragmentTitle: fragment.header,
      },
    }];
  })
);

const flatChunks = chunks.flat();
console.log(`Total chunks: ${flatChunks.length}`);
```

---

## Vector Database Integration

### Pinecone

```typescript
import { Pinecone } from '@pinecone-database/pinecone';
import * as Docs from '@acme/kb/generated/resources/docs/architecture.js';

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pinecone.index('knowledge-base');

// Prepare vectors from fragments
const vectors = await Promise.all(
  Object.entries(Docs.fragments).map(async ([name, fragment]) => {
    const embedding = await embedder.embed(fragment.body);

    return {
      id: `${Docs.meta.title}:${name}`,
      values: embedding,
      metadata: {
        title: fragment.header,
        content: fragment.body,
        source: Docs.meta.title,
        section: name,
      },
    };
  })
);

// Upsert to Pinecone
await index.upsert(vectors);

// Query
async function searchPinecone(query: string, topK = 3) {
  const queryEmbedding = await embedder.embed(query);

  const results = await index.query({
    vector: queryEmbedding,
    topK,
    includeMetadata: true,
  });

  return results.matches.map(match => ({
    title: match.metadata?.title,
    content: match.metadata?.content,
    score: match.score,
  }));
}
```

### Qdrant

```typescript
import { QdrantClient } from '@qdrant/js-client-rest';

const qdrant = new QdrantClient({ url: process.env.QDRANT_URL });
const collectionName = 'knowledge-base';

// Create collection
await qdrant.createCollection(collectionName, {
  vectors: {
    size: 384,  // OnnxEmbeddingProvider dimension
    distance: 'Cosine',
  },
});

// Index fragments
const points = await Promise.all(
  Object.entries(Docs.fragments).map(async ([name, fragment], i) => {
    const embedding = await embedder.embed(fragment.body);

    return {
      id: i,
      vector: embedding,
      payload: {
        title: fragment.header,
        content: fragment.body,
        source: Docs.meta.title,
        section: name,
      },
    };
  })
);

await qdrant.upsert(collectionName, { points });

// Search
async function searchQdrant(query: string, topK = 3) {
  const queryEmbedding = await embedder.embed(query);

  const results = await qdrant.search(collectionName, {
    vector: queryEmbedding,
    limit: topK,
  });

  return results.map(r => ({
    title: r.payload?.title,
    content: r.payload?.content,
    score: r.score,
  }));
}
```

### Chroma

```typescript
import { ChromaClient } from 'chromadb';

const chroma = new ChromaClient({ path: process.env.CHROMA_URL });
const collection = await chroma.getOrCreateCollection({ name: 'knowledge-base' });

// Add fragments
const fragments = Object.entries(Docs.fragments);

await collection.add({
  ids: fragments.map(([name]) => `${Docs.meta.title}:${name}`),
  documents: fragments.map(([, f]) => f.body),
  metadatas: fragments.map(([name, f]) => ({
    title: f.header,
    source: Docs.meta.title,
    section: name,
  })),
});

// Query
async function searchChroma(query: string, topK = 3) {
  const results = await collection.query({
    queryTexts: [query],
    nResults: topK,
  });

  return results.documents[0].map((doc, i) => ({
    content: doc,
    metadata: results.metadatas[0][i],
    score: results.distances?.[0][i],
  }));
}
```

---

## Advanced Search Patterns

### Hybrid Search (Keyword + Semantic)

```typescript
import { BM25 } from 'natural';

// Build BM25 index for keyword search
const documents = Object.values(Docs.fragments).map(f => f.body);
const bm25 = new BM25(documents);

async function hybridSearch(query: string, topK = 5) {
  // Semantic search
  const semanticScores = await search(query, topK * 2);

  // Keyword search
  const keywords = query.toLowerCase().split(/\s+/);
  const keywordScores = bm25.search(keywords)
    .map((score, i) => ({
      ...vectorStore[i],
      keywordScore: score,
    }))
    .sort((a, b) => b.keywordScore - a.keywordScore)
    .slice(0, topK * 2);

  // Combine scores (weighted average)
  const combined = new Map();

  for (const result of semanticScores) {
    combined.set(result.id, { ...result, semanticScore: result.score, keywordScore: 0 });
  }

  for (const result of keywordScores) {
    if (combined.has(result.id)) {
      combined.get(result.id).keywordScore = result.keywordScore;
    } else {
      combined.set(result.id, { ...result, semanticScore: 0 });
    }
  }

  // Weighted combination
  return Array.from(combined.values())
    .map(item => ({
      ...item,
      finalScore: 0.7 * item.semanticScore + 0.3 * item.keywordScore,
    }))
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, topK);
}
```

### Metadata Filtering

```typescript
interface SearchFilters {
  category?: string;
  tags?: string[];
  dateAfter?: string;
  minScore?: number;
}

async function filteredSearch(query: string, filters: SearchFilters, topK = 3) {
  const results = await search(query, topK * 3);  // Get more, then filter

  return results
    .filter(r => {
      // Category filter
      if (filters.category && r.metadata.category !== filters.category) {
        return false;
      }

      // Tags filter
      if (filters.tags?.length) {
        const hasTags = filters.tags.some(tag =>
          r.metadata.tags?.includes(tag)
        );
        if (!hasTags) return false;
      }

      // Date filter
      if (filters.dateAfter && r.metadata.lastUpdated < filters.dateAfter) {
        return false;
      }

      // Score threshold
      if (filters.minScore && r.score < filters.minScore) {
        return false;
      }

      return true;
    })
    .slice(0, topK);
}

// Usage
const results = await filteredSearch(
  'deployment process',
  {
    category: 'documentation',
    tags: ['production', 'devops'],
    minScore: 0.7,
  },
  3
);
```

### Re-Ranking

```typescript
import { Anthropic } from '@anthropic-ai/sdk';

async function rerankResults(query: string, results: SearchResult[]) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `
Given the query: "${query}"

Rank these passages by relevance (1 = most relevant):

${results.map((r, i) => `[${i}] ${r.content.substring(0, 200)}...`).join('\n\n')}

Return only the ranked indices as a JSON array, e.g., [2, 0, 3, 1]
`;

  const response = await client.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 100,
    messages: [{ role: 'user', content: prompt }],
  });

  const rankedIndices = JSON.parse(response.content[0].text);

  return rankedIndices.map((i: number) => results[i]);
}
```

---

## Query Optimization

### Query Expansion

```typescript
import { Anthropic } from '@anthropic-ai/sdk';

async function expandQuery(userQuery: string): Promise<string[]> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: 'claude-3-haiku-20240307',  // Fast model for query expansion
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `Generate 3 alternative phrasings of this query: "${userQuery}"\nReturn as JSON array.`,
    }],
  });

  const alternatives = JSON.parse(response.content[0].text);
  return [userQuery, ...alternatives];
}

// Search with expanded queries
async function expandedSearch(query: string, topK = 3) {
  const queries = await expandQuery(query);

  const allResults = await Promise.all(
    queries.map(q => search(q, topK))
  );

  // Deduplicate and merge scores
  const merged = new Map();
  for (const results of allResults) {
    for (const result of results) {
      if (merged.has(result.id)) {
        merged.get(result.id).score = Math.max(merged.get(result.id).score, result.score);
      } else {
        merged.set(result.id, result);
      }
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
```

### Hypothetical Document Embeddings (HyDE)

```typescript
async function hydeSearch(query: string, topK = 3) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Generate hypothetical answer
  const response = await client.messages.create({
    model: 'claude-3-haiku-20240307',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Write a detailed answer to: "${query}"`,
    }],
  });

  const hypotheticalAnswer = response.content[0].text;

  // Search using hypothetical answer instead of query
  return await search(hypotheticalAnswer, topK);
}
```

---

## RAG with Context

### Building Context for LLM

```typescript
async function ragQuery(userQuestion: string) {
  // 1. Search for relevant chunks
  const relevantChunks = await search(userQuestion, 3);

  // 2. Build context from chunks
  const context = relevantChunks
    .map((chunk, i) => `[${i + 1}] ${chunk.title}\n${chunk.content}`)
    .join('\n\n---\n\n');

  // 3. Query LLM with context
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `
Context from knowledge base:

${context}

---

Question: ${userQuestion}

Answer the question using only the provided context. If the context doesn't contain the answer, say so.
      `,
    }],
  });

  return {
    answer: response.content[0].text,
    sources: relevantChunks.map(c => c.title),
  };
}

// Usage
const result = await ragQuery('How do I deploy to production?');
console.log(result.answer);
console.log('Sources:', result.sources);
```

### Citation Support

```typescript
interface RagResult {
  answer: string;
  citations: Array<{
    text: string;
    source: string;
    section: string;
  }>;
}

async function ragQueryWithCitations(userQuestion: string): Promise<RagResult> {
  const relevantChunks = await search(userQuestion, 3);

  const context = relevantChunks
    .map((chunk, i) => `[${i + 1}] Source: ${chunk.title}\n${chunk.content}`)
    .join('\n\n---\n\n');

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `
${context}

---

Question: ${userQuestion}

Answer using the context above. Include citation numbers [1], [2], etc. when referencing sources.
      `,
    }],
  });

  const answer = response.content[0].text;

  return {
    answer,
    citations: relevantChunks.map(c => ({
      text: c.content.substring(0, 200),
      source: c.metadata.source,
      section: c.title,
    })),
  };
}
```

---

## Best Practices

### 1. Choose Right Chunking Strategy

| Strategy | Use Case |
|----------|----------|
| **Fragment-based** | Well-structured docs with clear H2 sections |
| **Recursive** | General-purpose, balanced chunks |
| **Semantic** | When semantic coherence is critical |
| **Hybrid** | Large fragments need subdivision |

### 2. Optimize Chunk Size

```typescript
// Too small: < 100 tokens → loses context
// Too large: > 1500 tokens → dilutes relevance
// Optimal: 300-800 tokens for most use cases

const OPTIMAL_CHUNK_SIZE = 500;
const CHUNK_OVERLAP = Math.floor(OPTIMAL_CHUNK_SIZE * 0.15);  // 15% overlap
```

### 3. Include Rich Metadata

```typescript
interface ChunkMetadata {
  source: string;           // Document filename
  title: string;            // Section title
  category: string;         // Document category
  tags: string[];           // Searchable tags
  lastUpdated: string;      // Freshness
  author?: string;          // Authorship
  confidence?: number;      // Quality score
}
```

### 4. Monitor Search Quality

```typescript
interface SearchMetrics {
  query: string;
  resultsCount: number;
  avgScore: number;
  latency: number;
  userSatisfaction?: number;
}

const searchMetrics: SearchMetrics[] = [];

async function trackedSearch(query: string) {
  const start = Date.now();
  const results = await search(query);
  const latency = Date.now() - start;

  searchMetrics.push({
    query,
    resultsCount: results.length,
    avgScore: results.reduce((s, r) => s + r.score, 0) / results.length,
    latency,
  });

  return results;
}
```

### 5. Cache Embeddings

```typescript
const embeddingCache = new Map<string, number[]>();

async function cachedEmbed(text: string): Promise<number[]> {
  const cacheKey = text.substring(0, 100);  // Use prefix as key

  if (embeddingCache.has(cacheKey)) {
    return embeddingCache.get(cacheKey)!;
  }

  const embedding = await embedder.embed(text);
  embeddingCache.set(cacheKey, embedding);

  return embedding;
}
```

---

## Next Steps

- [Building Agent Prompt Libraries](./agent-prompt-libraries.md) - For AI agent prompts
- [Template System Patterns](./template-systems.md) - For content generation
- [Advanced Patterns](./advanced-patterns.md) - Multi-collection packages

---

## See Also

- [Overview: Compiling Markdown to TypeScript](../compiling-markdown-to-typescript.md)
- [Publishing Packages](../publishing-packages.md)
- [Consuming Packages](../consuming-packages.md)
- [Guide Index](../README.md)
