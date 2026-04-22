---
name: vat-rag
description: Use when running `vat rag index` / `vat rag query` or configuring RAG for agent context — covers the CLI commands, native embedding providers and vector store support, chunking, custom metadata, and extension points for adding new backends.
---

# VAT RAG: Indexing and Querying Markdown with Native Providers

This skill covers VAT's RAG (retrieval-augmented generation) surface: the `vat rag` CLI commands, the embedding and vector-store providers that ship natively, and how to extend either side. For authoring the markdown that gets indexed (frontmatter schemas, collections) use `vibe-agent-toolkit:vat-knowledge-resources`.

## CLI Commands

```bash
# Index markdown into a local vector DB (default: .rag-db/)
vat rag index docs/

# Ask a natural-language question; returns the top chunks with file paths and heading context
vat rag query "How do I configure agent tools?"

# Inspect the current index
vat rag stats
```

`vat rag index` reads `vibe-agent-toolkit.config.yaml` when no path argument is given and respects the `rag` section for per-store configuration (multiple indices, content transforms, metadata schemas).

```bash
# Multi-store: index separate databases for different corpora
vat rag index --db ./dist/rag-en docs/en/
vat rag index --db ./dist/rag-fr docs/fr/

# Query a specific database
vat rag query "installation" --db ./dist/rag-en
```

See `vat rag --help` for the full flag surface and `docs/guides/rag-usage-guide.md` for end-to-end configuration examples.

## What Ships Natively

VAT's `@vibe-agent-toolkit/rag` package provides the core interfaces and a small set of ready-to-use providers. The goal is "works out of the box" for common cases, with clean extension points for everything else.

### Embedding providers

| Provider | Model | Where it runs |
|---|---|---|
| `TransformersEmbeddingProvider` | `Xenova/all-MiniLM-L6-v2` (default) | Local, via `transformers.js` — no API key, CPU inference |
| `OpenAIEmbeddingProvider` | `text-embedding-3-small` (default) | OpenAI API — requires `OPENAI_API_KEY` |

Both implement the `EmbeddingProvider` interface (`name`, `model`, `dimensions`, `embed(text)`, `embedBatch(texts)`), so the rest of the RAG pipeline doesn't care which one is wired in.

### Vector store

- `@vibe-agent-toolkit/rag-lancedb` — native LanceDB-backed store, lives on disk under `.rag-db/` by default. Supports approximate-nearest-neighbor search, metadata filtering, and incremental re-indexing.

### Chunking and metadata

- Hybrid heading-based + token-aware chunking via `chunkMarkdown`, integrated with `ResourceRegistry` so chunks inherit file-level metadata.
- `DefaultRAGMetadata` — sensible defaults for markdown docs (filePath, tags, type, headingPath, sourceUrl, etc.).
- Custom metadata — extend `DefaultRAGMetadataSchema` or replace it entirely. Use `createCustomRAGChunkSchema(MySchema)` to get type-safe chunks through the whole pipeline.

### Token counters

- `FastTokenCounter` — bytes/4 heuristic, zero-cost.
- `ApproximateTokenCounter` — `gpt-tokenizer`-backed, closer to reality for OpenAI-style models.

## Extension Points

The RAG interfaces are small on purpose. If something isn't supported natively, implement the interface in your own package:

- **Embedding provider** — implement `EmbeddingProvider` (cohere, Voyage, local LLM endpoints, etc.). Register via config or pass directly to `RAG.open({ embedding: myProvider })`.
- **Vector store** — implement `RAGQueryProvider` + `RAGAdminProvider` (pgvector, Pinecone, Qdrant, ChromaDB, etc.). The `@vibe-agent-toolkit/rag-lancedb` package is the reference implementation; mirror its shape.
- **Content transform** — hook into the chunking pipeline to rewrite markdown (e.g. strip HTML comments, expand templates) before it hits the embedder.
- **Custom metadata** — ship your own Zod schema and thread it through the CLI via config.

**Contributions welcome**: native support for additional embedding providers and vector stores is on the roadmap. If you've written a clean implementation of the RAG interfaces for another backend, open a PR — the target is a small, curated set of "we ship and test these" providers, with everything else available as community packages.

## Configuration

```yaml
version: 1

rag:
  stores:
    default:
      db: .rag-db/
      include: ["docs/**/*.md"]
      exclude: ["docs/drafts/**"]
      embedding:
        provider: transformers-js          # or: openai
        model: Xenova/all-MiniLM-L6-v2     # embedding-specific
```

Per-store configuration keeps multi-corpus projects (multilingual docs, product-vs-support splits) legible.

## Troubleshooting

- `vat rag query` returns empty: confirm `vat rag stats` shows non-zero chunks; re-run `vat rag index` after adding content.
- Slow first index with `transformers-js`: the model downloads on first use and caches under `~/.cache/transformers`.
- Drift between indexed content and live docs: re-index. LanceDB supports delete-by-filter, so `vat rag index --rebuild` for the specific store is safe.

## References

- `vibe-agent-toolkit:vat-knowledge-resources` — markdown collections and frontmatter schema validation (the content side)
- [RAG Usage Guide](../../../../../docs/guides/rag-usage-guide.md) — configuration walkthroughs for single-store, multi-store, and custom metadata
- [Embedding Providers](../../../../../docs/embedding-providers.md) — provider deep-dive and how to write new ones
- [@vibe-agent-toolkit/rag](../../../../../packages/rag/README.md) — package README with the full interface reference
