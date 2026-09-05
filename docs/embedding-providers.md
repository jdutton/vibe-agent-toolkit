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
   * This is a hard property of the model, not a preference: text beyond it is
   * discarded before inference, so anything that decides how much text to hand
   * over (a chunker, a batcher) must size its work against THIS number.
   *
   * Required, deliberately. It was previously absent, and the only consumer —
   * the chunker in `@vibe-agent-toolkit/rag-lancedb` — filled the hole with a
   * hardcoded 8191 (OpenAI ada-002's limit) for every provider, including a
   * local model that reads 256. The result was that chunks were cut at inference
   * time with nothing said, and the "exceeds model token limit" guard was
   * permanently unable to fire. (⛔ This passage used to quote "84-86% of chunks
   * truncated, 42-44% of every corpus". Retired, not corrected: that was measured
   * against raw `chunkByTokens` while the shipped path is `chunkResource`, which
   * splits at headings first — see the retirement in
   * `packages/rag-lancedb/src/chunking-config.ts`.) An optional field with a
   * fallback would reproduce exactly that bug for any provider that forgot it.
   */
  maxInputTokens: number;

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

  /**
   * Release any resources held by the provider (optional).
   *
   * Extension point for providers that hold onto a native or long-lived
   * resource (an inference session, a socket) and need explicit teardown.
   * No-op for pure-JS/HTTP providers.
   */
  dispose?(): Promise<void>;
}
```

**Key methods:**

- `embed(text)` - Convert single text to vector. Use for query embedding.
- `embedBatch(texts)` - Convert multiple texts efficiently. Use for indexing documents.
- `dispose()` - Optional. Implement it only if your provider holds a native session or socket.

### `maxInputTokens` is a measurement, not a setting

`maxInputTokens` is the one member you cannot guess at. The chunker reads it —
`resolveChunkingConfig()` in `@vibe-agent-toolkit/rag-lancedb` derives the entire
chunk budget from it — so a number that is too high means chunks the model
silently truncates before inference, with no error anywhere. That is not
hypothetical: it is the measured bug this member exists to prevent.

Naming where that silence came from matters, because it is not where a reader
would look. The chunker packed 460 tokens into a chunk — a hardcoded 512-token
target times a 0.9 padding factor — for an embedder whose 256-token window holds
254 once `[CLS]` and `[SEP]` are charged. That ratio is what made truncation the
normal case rather than an edge case. The silence itself was one layer further
down: `BertTokenizer.tokenize` reserved those two positions and then simply
`break`ed out of the token loop when the budget ran out — no throw, no warning,
no truncation flag. It returned a well-formed `inputIds` array of exactly the
legal length, so no amount of checking return values could have caught it.

Both halves are closed now, and it is worth knowing which is which.
`resolveChunkingConfig()` sizes the budget from `maxInputTokens` before anything
is embedded: for the default local model the effective target is 215 tokens
(256 x 0.84), not 460. And `tokenize` no longer leaves the loop early — it counts
every content token and returns `droppedTokens`, which `OnnxEmbeddingProvider`
books into `truncationStats`, passes to an `onTruncation` callback, or, failing
both, warns about once on stderr. For any provider that reports neither, the
original rule stands: compare your chunk budget against the model's real limit
yourself, because nothing downstream will tell you.

Two rules follow:

1. **Look the number up for your specific model, per model, the way
   `OpenAIEmbeddingProvider` does with its `MODEL_INPUT_TOKEN_LIMITS` table.** If a
   provider offers several models with different windows, one constant is already
   wrong for all but one of them.
2. **If your provider wraps another provider, delegate — never restate.** A
   decorator that hardcodes a limit is worse than no limit at all, because it
   lies with authority about a model it does not own.

## Built-in Providers

### Comparison Table

| Provider | Speed | Quality | Cost | API Key | Dimensions | `maxInputTokens` | Runtime | Install |
|----------|-------|---------|------|---------|------------|------------------|---------|---------|
| **ONNX** | Fast | Good | Free | No | 384 | 256 | WASM (`onnxruntime-web`) | Nothing to install beyond `@vibe-agent-toolkit/rag` |
| **OpenAI** | Medium | Excellent | $$ | Yes | 1536/3072 | 8192 (8191 for ada-002) | Cloud API | `npm install openai` |

Note how far apart those input limits are — 32x — and that dimensions tell you
nothing about them. The default local model produces 384-dimension vectors from
at most 256 tokens of text; OpenAI's small model produces 1536-dimension vectors
from up to 8192. Anything that sizes text for a model has to read the limit off
the provider it is actually using.

**When to use each:**

- **ONNX**: Default choice — prototyping, production local embeddings, privacy-sensitive data, no API budget
- **OpenAI**: Highest quality needed, budget available, network access OK

### OnnxEmbeddingProvider

**Local embeddings via `onnxruntime-web` (WASM), bundled with `@vibe-agent-toolkit/rag`.**

```typescript
import { OnnxEmbeddingProvider } from '@vibe-agent-toolkit/rag';

// No install step BEYOND @vibe-agent-toolkit/rag itself — onnxruntime-web is a regular
// dependency of it. See "Installing Provider Dependencies": the RAG packages are opt-in.

// Auto-downloads model on first run
const provider = new OnnxEmbeddingProvider({
  model: 'Xenova/all-MiniLM-L6-v2',  // Default
  dimensions: 384,                     // Default
});

// Single text
const vector = await provider.embed('What is RAG?');
console.log(vector.length); // 384

// Batch: one ONNX call over one padded batch tensor. That is NOT a per-chunk
// speedup, and with the default int8 weights a chunk's vector depends on its
// batch neighbours — see "The int8 vector is not a function of its own text".
const vectors = await provider.embedBatch([
  'Chunk 1 text',
  'Chunk 2 text',
  'Chunk 3 text',
]);
```

**Details:**
- **Model**: `Xenova/all-MiniLM-L6-v2` (default) - ~23MB int8-quantized download on first run
- **Dimensions**: 384 (default)
- **`maxInputTokens`**: 256 — all-MiniLM-L6-v2 was *trained* at 256 positions, so this is a property of the model, not a tuning knob. Two of those 256 go to `[CLS]`/`[SEP]` before any of your content does.
- **No API key required**
- **Pure WASM (`onnxruntime-web`)** - No native addon, no build step, no platform-specific binaries. Runs identically everywhere Node.js runs, and safe to co-load with other native addons (e.g. LanceDB) in the same process.
- **Pure TypeScript tokenizer** - No additional native dependencies
- **Network**: Downloads model + vocab once to `~/.cache/vat-onnx-models/`, then fully offline

**Custom configuration:**
```typescript
const provider = new OnnxEmbeddingProvider({
  modelPath: '/path/to/pre-downloaded/model',  // Skip auto-download
  quantized: false,                              // fp32 weights instead of the int8 default (see below)
  cacheDir: '/custom/cache/dir',                  // Override cache location
  numThreads: 1,                                  // WASM threads (default: 1)
  // maxSequenceLength: 256,                      // ONLY to describe a DIFFERENT model
});
```

`maxSequenceLength` is what the provider publishes as `maxInputTokens`, so it is
not a way to make chunks fit. Raising it to 512 for all-MiniLM-L6-v2 does not
give the model a 512-token window — the model still reads 256 and drops the
rest — it only stops the chunker from knowing that. Set it only when you point
`modelPath` at a different model that genuinely has a different window.

#### The int8 vector is not a function of its own text

`quantized` defaults to `true`, and `quantized: false` is not a quality knob with
a speed price attached. Measured 2026-08 against `Xenova/all-MiniLM-L6-v2` on one
macOS machine, by probing one fixed string against different batch neighbours:

| Build | Same string, different batch neighbours | Speed | Download |
|---|---|---|---|
| int8 — `quantized: true`, the default | cosine **0.9917-0.9928**, maxAbs up to **2.27e-2** | 141.8 ms/chunk | 22 MB |
| fp32 — `quantized: false` | **bit-identical in every arm** | 122.2 ms/chunk | 86 MB |

The int8 vector moved with *what the other rows in the batch contained* — their
content, not their padded length. **Mechanism**: dynamic int8 quantization
computes activation scales **per tensor**, and the tensor spans the whole batch,
so one row's activations set the scale another row is quantized with. fp32 has no
activation scales, so it has no coupling.

Two results ride along, both cutting against the shipped defaults:

- **fp32 is faster than the int8 build it is supposed to accelerate** — 122.2 vs
  141.8 ms/chunk. The quantization buys the 22 MB vs 86 MB download, not speed.
- **Batching is a pessimization.** `tokenizeBatch` pads every member to the
  longest sequence in the batch, so a batch of 32 does *more* work than 32 batches
  of one: 118.0 ms/chunk at batch size 1, against 141.8 batched.

Both configurations were bit-stable across separate processes on one machine.
**Cross-platform bit-stability is untested and therefore not claimed here.**

**What this means for caching and invalidation.** Production embeds one resource
at a time — `LanceDBRAGProvider` calls `embedBatch` once per resource, handing it
that resource's whole chunk list. So a file's **ordered vector set** is
deterministic, but **an individual chunk's vector is not a function of that
chunk's text**. Two byte-identical chunks in different files get different
vectors. Two rules follow:

1. **The cache unit is `(content_key, chunk_policy, model_config) → the file's
   ordered vector set`**, never a per-chunk vector keyed on that chunk's own
   hash. A per-chunk cache would serve a vector computed under some other batch's
   activation scales.
2. **The stored model identity is insufficient to invalidate on.** `enrichChunks`
   records only the bare model string `Xenova/all-MiniLM-L6-v2`, which
   distinguishes neither quantized from fp32, nor sequence length, nor pooling
   rule — and each of those changes every vector.

If you need reproducible vectors — a golden test, a differential comparison across
runs, a store you will append to over months — set `quantized: false` and accept
the 86 MB download; it is also the faster of the two. The int8 default stays
reasonable when the download matters and every vector in a store comes from one
build: a same-string cosine of 0.9917 is a small perturbation. Its effect on
retrieval quality has not been measured, so treat that as an argument rather than
a result.

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
- `text-embedding-3-small` - 1536 dims, 8192 input tokens (default, best cost/quality)
- `text-embedding-3-large` - 3072 dims, 8192 input tokens (highest quality)
- `text-embedding-ada-002` - 1536 dims, 8191 input tokens (legacy)

The provider keeps that as a `MODEL_INPUT_TOKEN_LIMITS` lookup beside its
dimensions table and falls back to 8191 — the lowest documented OpenAI limit —
for a model it does not recognise. Copy that shape for your own provider: a
per-model table plus a conservative fallback, so an unknown model under-claims
rather than over-claims. (The ada-002 off-by-one is the entire provenance of the
8191 that used to be hardcoded into the chunker and applied to every provider.)

**Details:**
- **API key required** - Get from https://platform.openai.com/api-keys
- **Cost**: ~$0.0001/1K tokens (text-embedding-3-small)
- **Network latency** - API call per batch
- **Rate limits** - 3,000 RPM (tier 1), 5,000 RPM (tier 2+)
- **Production-ready** - Widely tested, highly reliable

## Installing Provider Dependencies

### ⚠️ First: the RAG packages themselves are opt-in

Installing `@vibe-agent-toolkit/cli` does **not** install the RAG lane. `@vibe-agent-toolkit/rag`
and `@vibe-agent-toolkit/rag-lancedb` are declared as **optional peer dependencies**, which npm and
pnpm do not auto-install:

```bash
npm install @vibe-agent-toolkit/rag-lancedb    # pulls @vibe-agent-toolkit/rag with it
```

They were `optionalDependencies` previously, where "optional" means *the install may fail without
failing the build* — not *skipped* — so every adopter paid for the RAG stack whether or not they
used it. Measured against the published tarballs: **389 MB installed, 92 MB with those skipped.**

**`OnnxEmbeddingProvider` then needs nothing further** — `onnxruntime-web` is a regular dependency
of `@vibe-agent-toolkit/rag`, so once that package is present local embeddings work with no extra
install. "Batteries-included" below is scoped to that: it means no *second* install on top of the
RAG package, not that `vat rag` runs from a bare CLI install.

**OpenAI is an optional peer dependency** — install only if you want it:

```bash
# OpenAI (cloud, API key required)
npm install openai
```

**Error if not installed:**

```typescript
// Without 'openai' installed:
const provider = new OpenAIEmbeddingProvider({ apiKey: 'sk-...' });
// Error: OpenAI SDK not installed. Install with: bun add openai
```

## Creating a Custom Provider

Need Ollama? Cohere? Voyage AI? Here's how to plug in any embedding service.

### Step 1: Implement the Interface

```typescript
import type { EmbeddingProvider } from '@vibe-agent-toolkit/rag';

export interface OllamaEmbeddingConfig {
  baseUrl?: string;  // Default: http://localhost:11434
  model?: string;    // Default: nomic-embed-text
  /**
   * Ollama serves a model inside a context window (`num_ctx`) that may be
   * SMALLER than the model's architectural maximum, and it truncates silently
   * when it is. If you have narrowed `num_ctx` in a Modelfile or in the request
   * options, pass that number here — it, not the model's spec sheet, is what
   * this server will actually read.
   */
  maxInputTokens?: number;
}

/**
 * Per-model input windows, in tokens. One constant would be wrong the moment
 * you switch models, so this is a table — the same shape OpenAIEmbeddingProvider
 * uses. `dimensions` and `maxInputTokens` are independent: look both up.
 */
const OLLAMA_MODELS: Record<string, { dimensions: number; maxInputTokens: number }> = {
  'nomic-embed-text': { dimensions: 768, maxInputTokens: 8192 },
  'mxbai-embed-large': { dimensions: 1024, maxInputTokens: 512 },
  'all-minilm': { dimensions: 384, maxInputTokens: 256 },
};

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'ollama';
  readonly model: string;
  readonly dimensions: number;
  readonly maxInputTokens: number;

  private readonly baseUrl: string;

  constructor(config: OllamaEmbeddingConfig = {}) {
    this.baseUrl = config.baseUrl ?? 'http://localhost:11434';
    this.model = config.model ?? 'nomic-embed-text';

    const spec = OLLAMA_MODELS[this.model];
    if (!spec) {
      // Refuse to guess. A wrong maxInputTokens is invisible data loss, so an
      // unknown model is an error at construction, not a plausible default.
      throw new Error(
        `Unknown Ollama embedding model '${this.model}'. Add its dimensions and ` +
          'input-token window to OLLAMA_MODELS before using it.'
      );
    }

    this.dimensions = spec.dimensions;
    // An explicitly narrowed num_ctx wins: the server's window is the real limit.
    this.maxInputTokens = config.maxInputTokens ?? spec.maxInputTokens;
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

The three entries in `OLLAMA_MODELS` are the published windows for those model
weights (`nomic-embed-text` 8192, `mxbai-embed-large` 512, `all-minilm` 256).
Check the model card for anything you add, and check your own Modelfile: Ollama
will happily serve an 8192-token model behind a 2048-token `num_ctx` and drop
the difference without telling you, which is exactly the case `maxInputTokens`
in the config exists to cover.

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

/**
 * Per-model dimensions and input windows for Cohere's v3 embed family.
 *
 * These make the point that the two numbers are unrelated: embed-english-v3.0
 * emits a 1024-dimension vector but reads only 512 tokens of text. A provider
 * that inferred one from the other would be wrong by 16x here.
 */
const COHERE_MODELS: Record<string, { dimensions: number; maxInputTokens: number }> = {
  'embed-english-v3.0': { dimensions: 1024, maxInputTokens: 512 },
  'embed-multilingual-v3.0': { dimensions: 1024, maxInputTokens: 512 },
  'embed-english-light-v3.0': { dimensions: 384, maxInputTokens: 512 },
  'embed-multilingual-light-v3.0': { dimensions: 384, maxInputTokens: 512 },
};

export class CohereEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'cohere';
  readonly model: string;
  readonly dimensions: number;
  readonly maxInputTokens: number;

  private readonly apiKey: string;

  constructor(config: CohereEmbeddingConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'embed-english-v3.0';

    const spec = COHERE_MODELS[this.model];
    if (!spec) {
      throw new Error(
        `Unknown Cohere embedding model '${this.model}'. Add its dimensions and ` +
          'input-token window to COHERE_MODELS before using it.'
      );
    }

    this.dimensions = spec.dimensions;
    this.maxInputTokens = spec.maxInputTokens;
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

Note that Cohere's `/v1/embed` truncates over-length input by default rather
than rejecting it, and returns a normal-looking 200 either way. Nothing in the
response tells you content was dropped — which is precisely why the chunker has
to be told the truth up front, and why a plausible-looking wrong number here is
worse than a loud crash.

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
├─ Local, free, no API key?
│  └─ Use OnnxEmbeddingProvider (nothing to install beyond @vibe-agent-toolkit/rag)
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
3. ONNX all-MiniLM-L6-v2 (384 dims) - Good quality

**Speed (fastest to slowest):**
1. ONNX - Local WASM inference, no network round-trip
2. OpenAI - Network round-trip per batch

**Cost (cheapest to most expensive):**
1. ONNX - Free (compute cost only)
2. OpenAI text-embedding-3-small - ~$0.0001/1K tokens
3. OpenAI text-embedding-3-large - ~$0.0003/1K tokens

### Dimension Considerations

**More dimensions = better semantic understanding, but:**
- Larger storage requirements
- Slower search (marginal)
- Higher API costs (for cloud providers)

**Recommendations:**
- **384 dims** (ONNX) - Sufficient for most use cases
- **1536 dims** (OpenAI small) - Better for complex domains (legal, medical, technical)
- **3072 dims** (OpenAI large) - Highest accuracy needed (enterprise search, research)

### Mixing Providers (Don't Do This)

**CRITICAL**: Never mix embedding providers for the same vector database table.

```typescript
// WRONG - Different providers for indexing vs querying
const indexProvider = new OnnxEmbeddingProvider(); // 384 dims
await ragProvider.indexResources(resources);

const queryProvider = new OpenAIEmbeddingProvider({ apiKey }); // 1536 dims
await ragProvider.query({ query: 'test' }); // Won't work - dimension mismatch
```

**Why?** Vector databases require consistent dimensions. Once you index with a provider, you must use the same provider (and model) for queries.

**Solution:** Pick one provider and stick with it. To switch providers, re-index all documents.

## Advanced Patterns

### Lazy Initialization

Defer the expensive part — loading the model — until first use, without
deferring the provider's description of itself:

```typescript
import type { EmbeddingProvider } from '@vibe-agent-toolkit/rag';

export class LazyEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  readonly maxInputTokens: number;

  private innerPromise: Promise<EmbeddingProvider> | null = null;

  /**
   * @param spec - Identity of the model that WILL be loaded. Known up front
   *   because it is what selects the model, not something the load discovers.
   * @param load - Constructs the real provider on first use.
   */
  constructor(
    spec: Pick<EmbeddingProvider, 'name' | 'model' | 'dimensions' | 'maxInputTokens'>,
    private readonly load: () => Promise<EmbeddingProvider>,
  ) {
    this.name = spec.name;
    this.model = spec.model;
    this.dimensions = spec.dimensions;
    this.maxInputTokens = spec.maxInputTokens;
  }

  private async getInner(): Promise<EmbeddingProvider> {
    // Load only once, cache for future calls
    this.innerPromise ??= this.load();
    return this.innerPromise;
  }

  async embed(text: string): Promise<number[]> {
    return (await this.getInner()).embed(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return (await this.getInner()).embedBatch(texts);
  }

  async dispose(): Promise<void> {
    // Nothing to release if the model was never loaded.
    if (!this.innerPromise) return;
    await (await this.innerPromise).dispose?.();
  }
}
```

**Why `maxInputTokens` cannot be lazy.** `dimensions` and `maxInputTokens` are
plain synchronous properties, and the chunker reads `maxInputTokens` *before*
your first `embed()` call — that is the whole point of it, sizing text to the
model. So there is no `await` available to go and ask the loaded model. Pass the
numbers in with the model identity that selects the weights in the first place;
if you find yourself unable to state them without loading, the load is choosing
the model, and that decision belongs to the caller.

Belt and braces: assert the loaded provider matches what you promised, so a
mismatch surfaces as an error rather than as truncated corpus.

```typescript
private async getInner(): Promise<EmbeddingProvider> {
  this.innerPromise ??= this.load().then((inner) => {
    if (inner.maxInputTokens !== this.maxInputTokens || inner.dimensions !== this.dimensions) {
      throw new Error(
        `LazyEmbeddingProvider declared ${this.model} as ${this.dimensions}d/` +
          `${this.maxInputTokens} tokens, but loaded ${inner.model} as ` +
          `${inner.dimensions}d/${inner.maxInputTokens} tokens.`,
      );
    }
    return inner;
  });
  return this.innerPromise;
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

Add rate limiting for cloud APIs. This one is a pure decorator: it changes *when*
requests go out and nothing about the model, so every descriptive member is
delegated to the provider it wraps.

```typescript
import pLimit from 'p-limit';
import type { EmbeddingProvider } from '@vibe-agent-toolkit/rag';

export class RateLimitedProvider implements EmbeddingProvider {
  private limiter = pLimit(10); // Max 10 concurrent requests

  constructor(private readonly inner: EmbeddingProvider) {}

  get name(): string { return this.inner.name; }
  get model(): string { return this.inner.model; }
  get dimensions(): number { return this.inner.dimensions; }

  // Delegated, never restated. This wrapper does not know which model it is in
  // front of, and a decorator that hardcoded a limit here would quietly
  // mis-size every chunk for every provider it was ever pointed at.
  get maxInputTokens(): number { return this.inner.maxInputTokens; }

  async embed(text: string): Promise<number[]> {
    return this.limiter(() => this.inner.embed(text));
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const tasks = texts.map(text =>
      this.limiter(() => this.inner.embed(text))
    );
    return Promise.all(tasks);
  }

  async dispose(): Promise<void> {
    await this.inner.dispose?.();
  }
}
```

**The rule for any wrapper** — rate limiting, caching, retries, metrics: forward
`dimensions` and `maxInputTokens` to the wrapped provider as getters rather than
copying them in the constructor. A getter cannot go stale, and it makes the
wrapper's honesty structural rather than something a future edit can quietly
break.

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
1. Clear the store, then re-index with the new provider — `vat rag clear && vat rag index`, or
   `await ragProvider.clear()` followed by `await ragProvider.indexResources(resources)`.
   ⚠️ `vat rag index` on its own is **not** enough: change detection is a content hash of the
   source document, so an unchanged file is skipped and its stale vectors survive. There is no
   `--force`.
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

### Retrieval quality is poor and nothing errored

**Problem:** Queries return chunks that look truncated, or documents you know are
indexed never come back. No error, no warning — indexing reported success.

**Likely cause:** your provider's `maxInputTokens` is larger than what the model
actually reads, so the chunker sized text the model then discarded before
inference. This is silent by construction: both ONNX and hosted APIs truncate
rather than reject.

**Check, in order:**

1. Print it — `console.log(provider.model, provider.maxInputTokens)` — and compare
   against the model card, not against what the code says.
2. If the provider wraps another provider, confirm `maxInputTokens` is a getter
   delegating to the inner one, not a constant.
3. For `OnnxEmbeddingProvider`, watch for its truncation warning, or pass
   `onTruncation` to count exactly what was dropped.
4. If the limit was wrong, fix it and **re-index** — the bad chunks are already
   in the database.

### Model download hangs (ONNX)

**Problem:** First run hangs downloading model.

**Solution:**
- **Check network** - Model downloads from Hugging Face
- **Wait** - all-MiniLM-L6-v2 (quantized) is ~23MB, takes 30-60s on slow connections
- **Use cache** - Models cache to `~/.cache/vat-onnx-models/`, subsequent runs are instant

## Related Documentation

- [RAG Usage Guide](./guides/rag-usage-guide.md) - Using RAG providers with embedding providers
- [RAG Architecture](./architecture/rag.md) - Chunking strategy and how the budget derives from `maxInputTokens`
- [Resources Package](../packages/resources/README.md) - Parsing markdown for RAG indexing
- [LanceDB RAG Provider](../packages/rag-lancedb/README.md) - Vector database implementation — `resolveChunkingConfig()` lives here
