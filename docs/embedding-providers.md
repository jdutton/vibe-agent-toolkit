# Embedding Providers

Embedding providers convert text into vector embeddings for semantic search in RAG (Retrieval-Augmented Generation) systems. They're the critical component that enables your agent to find relevant context based on meaning, not just keyword matching.

## Overview

**What are embeddings?**

Embeddings are numerical vectors that capture the semantic meaning of text. Similar text produces similar vectors, enabling semantic search.

**How they fit into RAG:**

```
User Query → Embedding Provider → Query Vector
                                      ↓
                              Vector Database Search
                                      ↓
                              Top-K Similar Chunks → LLM Context
```

The RAG package provides:
- `EmbeddingProvider` interface - Standard contract for all providers
- Built-in providers - Ready-to-use implementations
- Easy provider swapping - Change providers without changing RAG code

## The EmbeddingProvider Interface

All embedding providers implement this interface:

```typescript
/**
 * Embedding Provider
 *
 * Converts text to vector embeddings for semantic search.
 */
export interface EmbeddingProvider {
  /** Provider name: "openai", "transformers-js", etc. */
  name: string;

  /** Model name: "text-embedding-3-small", "all-MiniLM-L6-v2", etc. */
  model: string;

  /** Embedding vector dimensions */
  dimensions: number;

  /**
   * Embed a single text chunk
   *
   * @param text - Text to embed
   * @returns Vector embedding
   */
  embed(text: string): Promise<number[]>;

  /**
   * Embed multiple text chunks efficiently
   *
   * @param texts - Array of texts to embed
   * @returns Array of vector embeddings
   */
  embedBatch(texts: string[]): Promise<number[][]>;
}
```

**Key methods:**

- `embed(text)` - Convert single text to vector. Use for query embedding.
- `embedBatch(texts)` - Convert multiple texts efficiently. Use for indexing documents.

## Built-in Providers

### Comparison Table

| Provider | Speed | Quality | Cost | API Key | Dimensions | Hardware Accel | Install |
|----------|-------|---------|------|---------|------------|----------------|---------|
| **Transformers** | Fast | Good | Free | No | 384 | CPU/WASM | `npm install @xenova/transformers` |
| **ONNX** | Very Fast | Good | Free | No | 384 | CoreML/CUDA/DirectML | `npm install onnxruntime-node` |
| **OpenAI** | Medium | Excellent | $$ | Yes | 1536/3072 | N/A | `npm install openai` |

**When to use each:**

- **Transformers**: Prototyping, quick local development, privacy-sensitive data, no API budget
- **ONNX**: Production local embeddings, hardware acceleration (GPU/Neural Engine), high throughput
- **OpenAI**: Highest quality needed, budget available, network access OK

### TransformersEmbeddingProvider

**Local, free, WASM-powered embeddings.**

```typescript
import { TransformersEmbeddingProvider } from '@vibe-agent-toolkit/rag';

// Install first: npm install @xenova/transformers

const provider = new TransformersEmbeddingProvider({
  model: 'Xenova/all-MiniLM-L6-v2',  // Default
  dimensions: 384,                     // Default
});

// Single text
const vector = await provider.embed('What is RAG?');
console.log(vector.length); // 384

// Batch (parallel processing)
const vectors = await provider.embedBatch([
  'Chunk 1 text',
  'Chunk 2 text',
  'Chunk 3 text',
]);
console.log(vectors.length); // 3
```

**Details:**
- **Model**: `Xenova/all-MiniLM-L6-v2` (default) - 20MB download on first run
- **Dimensions**: 384 (default)
- **No API key required**
- **Runs in Node.js via WASM** - No Python/GPU needed
- **Good quality** - Sentence-transformers model, widely used
- **Fast inference** - Quantized model
- **Network**: Downloads model once, then fully offline

### OnnxEmbeddingProvider

**Local, hardware-accelerated embeddings via native ONNX Runtime.**

```typescript
import { OnnxEmbeddingProvider } from '@vibe-agent-toolkit/rag';

// Install first: npm install onnxruntime-node

// Auto-downloads model on first run, uses hardware acceleration
const provider = new OnnxEmbeddingProvider({
  model: 'sentence-transformers/all-MiniLM-L6-v2',  // Default
  dimensions: 384,                                     // Default
});

// Single text
const vector = await provider.embed('What is RAG?');
console.log(vector.length); // 384

// Batch (true batched ONNX inference - single model call)
const vectors = await provider.embedBatch([
  'Chunk 1 text',
  'Chunk 2 text',
  'Chunk 3 text',
]);
```

**Details:**
- **Model**: `sentence-transformers/all-MiniLM-L6-v2` (default) - ~90MB download on first run
- **Dimensions**: 384 (default)
- **No API key required**
- **Native C++ ONNX Runtime** - Not WASM, significantly faster than Transformers provider
- **Hardware acceleration**: Auto-detects available hardware:
  - macOS Apple Silicon: CoreML (GPU + Neural Engine)
  - Linux with NVIDIA: CUDA
  - Windows: DirectML (any DirectX 12 GPU)
  - All platforms: CPU fallback
- **True batch inference** - Single model call for multiple texts (not Promise.all)
- **Pure TypeScript tokenizer** - No additional native dependencies beyond onnxruntime-node
- **Network**: Downloads model + vocab once to `~/.cache/vat-onnx-models/`, then fully offline

**Custom configuration:**
```typescript
const provider = new OnnxEmbeddingProvider({
  modelPath: '/path/to/pre-downloaded/model',  // Skip auto-download
  executionProviders: ['coreml', 'cpu'],         // Explicit EP selection
  maxSequenceLength: 512,                         // Override max tokens
  cacheDir: '/custom/cache/dir',                  // Override cache location
});
```

### OpenAIEmbeddingProvider

**Cloud-based, state-of-the-art embeddings.**

```typescript
import { OpenAIEmbeddingProvider } from '@vibe-agent-toolkit/rag';

// Install first: npm install openai

const provider = new OpenAIEmbeddingProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'text-embedding-3-small',   // Default (1536 dims)
  // model: 'text-embedding-3-large', // Higher quality (3072 dims)
  // dimensions: 512,                  // Custom (text-embedding-3-* only)
});

// Single text
const vector = await provider.embed('What is RAG?');
console.log(vector.length); // 1536

// Batch (uses OpenAI batch API)
const vectors = await provider.embedBatch([
  'Chunk 1 text',
  'Chunk 2 text',
]);
```

**Available models:**
- `text-embedding-3-small` - 1536 dims (default, best cost/quality)
- `text-embedding-3-large` - 3072 dims (highest quality)
- `text-embedding-ada-002` - 1536 dims (legacy)

**Details:**
- **API key required** - Get from https://platform.openai.com/api-keys
- **Cost**: ~$0.0001/1K tokens (text-embedding-3-small)
- **Network latency** - API call per batch
- **Rate limits** - 3,000 RPM (tier 1), 5,000 RPM (tier 2+)
- **Production-ready** - Widely tested, highly reliable

## Installing Provider Dependencies

**All embedding providers are optional dependencies.** Install only what you need:

```bash
# Transformers (local, WASM, free)
npm install @xenova/transformers

# ONNX (local, native, hardware-accelerated, free)
npm install onnxruntime-node

# OpenAI (cloud, API key required)
npm install openai
```

**Error if not installed:**

```typescript
// Without 'openai' installed:
const provider = new OpenAIEmbeddingProvider({ apiKey: 'sk-...' });
// Error: OpenAI SDK not installed. Install with: bun add openai

// Without '@xenova/transformers' installed:
const provider = new TransformersEmbeddingProvider();
await provider.embed('test');
// Error: @xenova/transformers is not installed. Install with: npm install @xenova/transformers
```

## Creating a Custom Provider

Need Ollama? Cohere? Voyage AI? Here's how to plug in any embedding service.

### Step 1: Implement the Interface

```typescript
import type { EmbeddingProvider } from '@vibe-agent-toolkit/rag';

export interface OllamaEmbeddingConfig {
  baseUrl?: string;  // Default: http://localhost:11434
  model?: string;    // Default: nomic-embed-text
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'ollama';
  readonly model: string;
  readonly dimensions: number;

  private readonly baseUrl: string;

  constructor(config: OllamaEmbeddingConfig = {}) {
    this.baseUrl = config.baseUrl ?? 'http://localhost:11434';
    this.model = config.model ?? 'nomic-embed-text';
    this.dimensions = 768; // nomic-embed-text dimensions
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.statusText}`);
    }

    const data = await response.json() as { embedding: number[] };
    return data.embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Ollama doesn't have batch API, so process sequentially
    const embeddings: number[][] = [];
    for (const text of texts) {
      embeddings.push(await this.embed(text));
    }
    return embeddings;
  }
}
```

### Step 2: Use with LanceDBRAGProvider

```typescript
import { LanceDBRAGProvider } from '@vibe-agent-toolkit/rag-lancedb';
import { OllamaEmbeddingProvider } from './ollama-embedding-provider.js';

// Create custom provider
const embeddingProvider = new OllamaEmbeddingProvider({
  baseUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
});

// Pass to RAG provider
const ragProvider = new LanceDBRAGProvider({
  dbPath: './vector-db',
  tableName: 'docs',
  embeddingProvider,  // Use your custom provider
});

// Index documents
await ragProvider.indexResources(resources);

// Query works seamlessly
const results = await ragProvider.query({
  query: 'What is RAG?',
  topK: 5,
});
```

### Step 3: Add Batch Optimization (Optional)

If your API supports batch embedding, optimize `embedBatch`:

```typescript
async embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  // Example: Cohere batch API
  const response = await fetch(`${this.baseUrl}/embed`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: this.model,
      texts,  // Send all at once
    }),
  });

  const data = await response.json() as { embeddings: number[][] };
  return data.embeddings;
}
```

### Complete Example: Cohere Provider

```typescript
import type { EmbeddingProvider } from '@vibe-agent-toolkit/rag';

export interface CohereEmbeddingConfig {
  apiKey: string;
  model?: string;
}

export class CohereEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'cohere';
  readonly model: string;
  readonly dimensions: number;

  private readonly apiKey: string;

  constructor(config: CohereEmbeddingConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'embed-english-v3.0';
    this.dimensions = 1024; // embed-english-v3.0 dimensions
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch('https://api.cohere.ai/v1/embed', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        texts: [text],
        input_type: 'search_document',
      }),
    });

    if (!response.ok) {
      throw new Error(`Cohere API error: ${response.statusText}`);
    }

    const data = await response.json() as { embeddings: number[][] };
    const firstEmbedding = data.embeddings[0];
    if (!firstEmbedding) {
      throw new Error('Cohere returned no embeddings');
    }
    return firstEmbedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await fetch('https://api.cohere.ai/v1/embed', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        texts,
        input_type: 'search_document',
      }),
    });

    if (!response.ok) {
      throw new Error(`Cohere API error: ${response.statusText}`);
    }

    const data = await response.json() as { embeddings: number[][] };
    return data.embeddings;
  }
}
```

**Usage:**

```typescript
import { CohereEmbeddingProvider } from './cohere-embedding-provider.js';

const provider = new CohereEmbeddingProvider({
  apiKey: process.env.COHERE_API_KEY!,
  model: 'embed-english-v3.0',
});

const results = await ragProvider.query({
  query: 'What is RAG?',
  topK: 5,
});
```

## Provider Selection Guide

### Decision Tree

```
Need embeddings?
├─ Quick prototyping / Simplest setup?
│  └─ Use TransformersEmbeddingProvider (WASM, no native deps)
│
├─ Local embeddings / High throughput / Hardware acceleration?
│  └─ Use OnnxEmbeddingProvider (native C++, GPU/Neural Engine)
│
├─ Production cloud / Highest quality?
│  ├─ Need best accuracy?
│  │  └─ Use OpenAIEmbeddingProvider with text-embedding-3-large (3072 dims)
│  └─ Cost-conscious?
│     └─ Use OpenAIEmbeddingProvider with text-embedding-3-small (1536 dims)
│
└─ Need specific provider (Cohere, Voyage, Ollama)?
   └─ Create custom provider (see examples above)
```

### Quality vs Cost Trade-offs

**Quality (best to good):**
1. OpenAI text-embedding-3-large (3072 dims) - Highest quality
2. OpenAI text-embedding-3-small (1536 dims) - Excellent quality
3. ONNX / Transformers all-MiniLM-L6-v2 (384 dims) - Good quality (same model, different runtime)

**Speed (fastest to slowest):**
1. ONNX - Native C++ with hardware acceleration (CoreML/CUDA/DirectML)
2. Transformers - WASM single-threaded
3. OpenAI - Network round-trip per batch

**Cost (cheapest to most expensive):**
1. ONNX / Transformers - Free (compute cost only)
2. OpenAI text-embedding-3-small - ~$0.0001/1K tokens
3. OpenAI text-embedding-3-large - ~$0.0003/1K tokens

### Dimension Considerations

**More dimensions = better semantic understanding, but:**
- Larger storage requirements
- Slower search (marginal)
- Higher API costs (for cloud providers)

**Recommendations:**
- **384 dims** (Transformers) - Sufficient for most use cases
- **1536 dims** (OpenAI small) - Better for complex domains (legal, medical, technical)
- **3072 dims** (OpenAI large) - Highest accuracy needed (enterprise search, research)

### Mixing Providers (Don't Do This)

**CRITICAL**: Never mix embedding providers for the same vector database table.

```typescript
// WRONG - Different providers for indexing vs querying
const indexProvider = new TransformersEmbeddingProvider(); // 384 dims
await ragProvider.indexResources(resources);

const queryProvider = new OpenAIEmbeddingProvider({ apiKey }); // 1536 dims
await ragProvider.query({ query: 'test' }); // Won't work - dimension mismatch
```

**Why?** Vector databases require consistent dimensions. Once you index with a provider, you must use the same provider (and model) for queries.

**Solution:** Pick one provider and stick with it. To switch providers, re-index all documents.

## Advanced Patterns

### Lazy Initialization

Defer model loading until first use:

```typescript
export class LazyEmbeddingProvider implements EmbeddingProvider {
  private pipelinePromise: Promise<Pipeline> | null = null;

  private async getPipeline(): Promise<Pipeline> {
    // Load only once, cache for future calls
    this.pipelinePromise ??= this.loadPipeline();
    return this.pipelinePromise;
  }

  async embed(text: string): Promise<number[]> {
    const pipeline = await this.getPipeline();
    return pipeline.embed(text);
  }
}
```

### Error Handling

Handle API failures gracefully:

```typescript
async embed(text: string): Promise<number[]> {
  try {
    const response = await fetch(this.apiUrl, { /* ... */ });
    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }
    return await this.parseResponse(response);
  } catch (error) {
    if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
      throw new Error(`Cannot connect to embedding service at ${this.apiUrl}. Is it running?`);
    }
    throw error;
  }
}
```

### Rate Limiting

Add rate limiting for cloud APIs:

```typescript
import pLimit from 'p-limit';

export class RateLimitedProvider implements EmbeddingProvider {
  private limiter = pLimit(10); // Max 10 concurrent requests

  async embedBatch(texts: string[]): Promise<number[][]> {
    const tasks = texts.map(text =>
      this.limiter(() => this.embed(text))
    );
    return Promise.all(tasks);
  }
}
```

## Troubleshooting

### "Module not installed" errors

**Problem:**
```
Error: OpenAI SDK not installed. Install with: bun add openai
```

**Solution:**
```bash
npm install openai
# or
bun add openai
```

### Dimension mismatch errors

**Problem:**
```
Error: Vector dimension mismatch. Expected 384, got 1536.
```

**Solution:** You switched providers after indexing. Either:
1. Re-index with new provider: `await ragProvider.clearAndReindex(resources)`
2. Switch back to original provider

### API key errors

**Problem:**
```
Error: Invalid API key
```

**Solution:**
```typescript
// Check API key is set
console.log(process.env.OPENAI_API_KEY ? 'Set' : 'Missing');

// Load from .env file
import 'dotenv/config';
const provider = new OpenAIEmbeddingProvider({
  apiKey: process.env.OPENAI_API_KEY!,
});
```

### Model download hangs (Transformers)

**Problem:** First run hangs downloading model.

**Solution:**
- **Check network** - Model downloads from Hugging Face
- **Wait** - all-MiniLM-L6-v2 is ~20MB, takes 30-60s on slow connections
- **Use cache** - Models cache to `~/.cache/huggingface/`, subsequent runs are instant

## Related Documentation

- [RAG Usage Guide](./guides/rag-usage-guide.md) - Using RAG providers with embedding providers
- [Resources Package](../packages/resources/README.md) - Parsing markdown for RAG indexing
- [LanceDB RAG Provider](../packages/rag-lancedb/README.md) - Vector database implementation
