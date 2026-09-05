---
title: RAG Usage Guide
description: Practical examples for using the VAT RAG system in real-world scenarios
category: guide
tags: [rag, documentation, examples, configuration]
audience: intermediate
---

# RAG Usage Guide

This guide provides practical examples for using the VAT RAG system in real-world scenarios.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Configuration Examples](#configuration-examples)
3. [Agent Integration](#agent-integration)
4. [Advanced Patterns](#advanced-patterns)
5. [Content Transform](#content-transform)
6. [Document Storage](#document-storage)
7. [Example Projects](#example-projects)

---

## Quick Start

### 1. Index Your Documentation

```bash
# Index all markdown files in docs/
vat rag index docs/

# Output:
# status: success
# resourcesIndexed: 42
# chunksCreated: 156
# duration: 2134ms
```

### 2. Search Your Documentation

```bash
# Ask a question in natural language
vat rag query "How do I configure agent tools?"

# Output shows relevant chunks:
# status: success
# chunks:
#   - content: "Agent tools are configured in the spec.tools section..."
#     filePath: docs/agent-configuration.md
#     headingPath: Configuration > Tools
```

### 3. View Database Statistics

```bash
vat rag stats

# Output:
# totalChunks: 156
# totalResources: 42
# embeddingModel: Xenova/all-MiniLM-L6-v2
# dbSizeBytes: 2458624
```

---

## Configuration Examples

### How RAG is actually configured

**There is no `rag:` section in `vibe-agent-toolkit.config.yaml`, and there never has been.**
`ProjectConfigSchema` is `.strict()` and accepts exactly six top-level keys — `version`, `skills`,
`resources`, `claude`, `extents`, `test` (`packages/resources/src/schemas/project-config.ts`). An
unrecognized top-level key is not stripped, it is *refused*: the config fails to load and **every**
`vat` command exits, not just the RAG ones.

Three separate surfaces configure a RAG run, and only the first is a config file:

| What you want to control | Where it lives | Notes |
|---|---|---|
| Which files get indexed | `resources.include` / `resources.exclude` in `vibe-agent-toolkit.config.yaml` | Read by `vat rag index` when no path argument is given |
| Where the database lives | `--db <path>`, on every `vat rag` subcommand | Defaults to `<projectRoot>/.rag-db` |
| Embedding provider, chunk budget, content transform, document storage | `LanceDBRAGProvider.create({ … })` — **library only** | The CLI passes only `dbPath` and `readonly`; there is no flag and no config key for any of these |

Three consequences worth stating plainly, because each one used to be documented the other way round
here:

- **There is no "store" concept in config.** Multiple databases are multiple `--db` invocations,
  which is exactly what the Usage blocks below show.
- **`collections:` does not scope indexing.** A collection labels files that were already crawled,
  so that per-collection validation and `mimeType` can apply to them; it does not narrow the crawl.
  With no `resources.include`, the crawl defaults to `**/*.md`, `**/*.html`, `**/*.htm` across the
  whole project root (`DEFAULT_RESOURCE_INCLUDE`, `resource-registry.ts:199`). Write
  `resources.include` when you mean "index only these".
- **The embedding model is not selectable from the CLI.** `vat rag index` constructs
  `LanceDBRAGProvider` with `{ dbPath, readonly: false }` and nothing else, so every CLI run uses
  the default `OnnxEmbeddingProvider` (`Xenova/all-MiniLM-L6-v2`, `maxInputTokens: 256`) and the
  chunk budget derived from it. To use OpenAI embeddings or override the chunk budget you must
  drive the library yourself — see [Selecting an embedding provider](#selecting-an-embedding-provider).

### Example 1: Simple Project

**Use Case**: Index one documentation directory into the default database

**vibe-agent-toolkit.config.yaml**:

```yaml
version: 1

resources:
  include:
    - docs/**/*.md
    - README.md
```

**Usage**:

```bash
# Index using the config's include patterns, into <projectRoot>/.rag-db
vat rag index

# Query the same default database
vat rag query "installation guide"
```

### Example 2: Multi-Language Documentation

**Use Case**: Separate RAG databases for different languages

There is no config that maps a subtree to a database — the mapping is made on the command line, one
`--db` per database. The config's job here is only to keep non-documentation markdown out of the
crawl.

**Config**:

```yaml
version: 1

resources:
  include:
    - docs/**/*.md
  exclude:
    - '**/node_modules/**'
    - '**/dist/**'
```

**Usage**:

```bash
# Index each language into its own database.
# The path argument narrows the crawl to that subtree; the config's `exclude`
# still applies, but its `include` is replaced by the default resource patterns
# scoped to the subtree.
vat rag index --db ./dist/rag-en docs/en/
vat rag index --db ./dist/rag-fr docs/fr/
vat rag index --db ./dist/rag-es docs/es/

# Query by language
vat rag query "installation" --db ./dist/rag-en
vat rag query "installation" --db ./dist/rag-fr
```

### Example 3: API Documentation + Examples

**Use Case**: Separate databases for API reference vs usage examples

Collections earn their place here: they attach per-collection *validation* to each subtree. They do
not decide what gets indexed — the `--db` + path pairs below do that.

**Config**:

```yaml
version: 1

resources:
  exclude:
    - '**/node_modules/**'
    - '**/dist/**'

  collections:
    api-reference:
      include:
        - api-docs/**/*.md
      validation:
        frontmatterSchema: schemas/api-frontmatter.json
        mode: permissive

    examples:
      include:
        - examples/**/*.md
```

> ⚠️ **Chunk size is not settable from YAML.** There is no config key for it at any level: the CLI
> constructs `LanceDBRAGProvider` without `targetChunkSize` or `paddingFactor`, so every `vat rag
> index` run uses the budget derived from the embedding provider's own `maxInputTokens`. The working
> override is the library one — `LanceDBRAGProvider.create({ targetChunkSize, paddingFactor, … })`.
> Overriding *upward* is never available: the ceiling belongs to the model, and
> `resolveChunkingConfig` clamps an over-large target and warns.

**Usage**:

```bash
# Index each subtree into its own database
vat rag index --db ./dist/api-rag api-docs/
vat rag index --db ./dist/examples-rag examples/

# Search API docs
vat rag query "authentication endpoint" --db ./dist/api-rag

# Search examples
vat rag query "authentication example" --db ./dist/examples-rag
```

### Example 4: Agent Development Project

**Use Case**: Agent toolkit with multiple agents and a shared knowledge base

Agents are discovered by their `agent.yaml` files on disk — there is no `agents:` key in
`vibe-agent-toolkit.config.yaml`, and adding one makes the config unloadable. Run `vat agent list`
to see what was discovered.

**Config**:

```yaml
version: 1

resources:
  exclude:
    - '**/node_modules/**'
    - '**/dist/**'
    - '**/.git/**'

  collections:
    toolkit-docs:
      include:
        - docs/**/*.md
        - README.md
    agent-guides:
      include:
        - guides/**/*.md
    api-reference:
      include:
        - api/**/*.md
```

**Usage**:

```bash
vat rag index --db ./dist/agent-knowledge-rag docs/
vat rag index --db ./dist/guide-rag guides/
vat rag index --db ./dist/api-rag api/
```

### Selecting an embedding provider

The CLI has no switch for this. Both providers ship from `@vibe-agent-toolkit/rag` and are passed to
the provider factory as `embeddingProvider`:

```typescript
import { OpenAIEmbeddingProvider } from '@vibe-agent-toolkit/rag';
import { LanceDBRAGProvider } from '@vibe-agent-toolkit/rag-lancedb';

const provider = await LanceDBRAGProvider.create({
  dbPath: './dist/api-rag',
  // Default is OnnxEmbeddingProvider (Xenova/all-MiniLM-L6-v2, 256 input tokens).
  embeddingProvider: new OpenAIEmbeddingProvider({
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: 'text-embedding-3-small',   // 8192 input tokens
  }),
  // Optional: a SMALLER chunk target than the model's ceiling, for finer retrieval.
  targetChunkSize: 256,
});
```

`OpenAIEmbeddingProvider` loads the `openai` package at construction time; it is an optional
dependency, so install it in your project before using this path.

A database is bound to the embedding model that built it. Changing the provider means re-indexing
into a fresh path (or `vat rag clear` first).

---

## Agent Integration

> ⚠️ **There is no `rag` tool type in an agent manifest.** `ToolSchema` is `.strict()` and its `type`
> is `z.enum(['mcp', 'library', 'builtin'])` with no `config` key
> (`packages/schema/src/tool.ts`), so a tool entry written as `type: rag` fails manifest validation.
> `AgentManifestSchema` is also `.strict()` and accepts only `metadata`, `spec` and `tests` — an
> `apiVersion:` or `kind:` line is refused, not ignored. The manifest carries an optional `spec.rag`
> block that *validates* (`RAGConfigSchema`, marked "details TBD in Phase 2"), but no runtime reads
> it. Until it does, RAG wiring for an agent is TypeScript you write, shown below.

### Example: Code Review Agent with RAG

**Agent Manifest** (`agent.yaml`) — the manifest declares the agent; it does not declare the RAG
database:

```yaml
metadata:
  name: code-review-agent
  version: 1.0.0
  description: Reviews code against best practices documentation

spec:
  llm:
    provider: anthropic
    model: claude-sonnet-5

  prompts:
    system:
      $ref: ./prompts/system.md
```

**System Prompt** (`prompts/system.md`):

```markdown
You are a code review assistant. When reviewing code:

1. Use the search_best_practices tool to find relevant documentation
2. Compare code against documented best practices
3. Provide specific, actionable feedback

Example tool usage:
- Query: "error handling best practices"
- Query: "async await patterns"
- Query: "security guidelines"
```

**TypeScript Integration**:

```typescript
import { loadAgentManifest } from '@vibe-agent-toolkit/agent-config';
import { LanceDBRAGProvider } from '@vibe-agent-toolkit/rag-lancedb';

const manifest = await loadAgentManifest('./code-review-agent');

// The database path is the caller's to choose — the manifest has no field for it.
const ragProvider = await LanceDBRAGProvider.create({
  dbPath: './dist/best-practices-rag',
  readonly: true,
});

// Agent uses RAG during review
async function reviewCode(code: string) {
  // Search for relevant best practices
  const practices = await ragProvider.query({
    text: `best practices for: ${extractTopics(code)}`,
    limit: 5,
  });

  // Use practices as context for LLM review
  const review = await callLLM({
    prompt: `Review this code using these best practices:\n\n${formatPractices(practices)}\n\nCode:\n${code}`,
  });

  return review;
}
```

### Example: Documentation Assistant

**Use Case**: Agent that answers questions about project documentation

**Agent Setup** — again in TypeScript, not in `agent.yaml`, for the reason given at the top of this
section:

```typescript
import { LanceDBRAGProvider } from '@vibe-agent-toolkit/rag-lancedb';

const ragProvider = await LanceDBRAGProvider.create({
  dbPath: './dist/docs-rag',
  readonly: true,
});
```

**Usage**:

```typescript
// User asks question
const userQuestion = "How do I configure authentication?";

// Agent searches docs
const relevantDocs = await ragProvider.query({
  text: userQuestion,
  limit: 10,
});

// Agent synthesizes answer from chunks
const context = relevantDocs.chunks
  .map(chunk => `${chunk.filePath}:\n${chunk.content}`)
  .join('\n\n');

const answer = await llm.complete({
  system: "Answer based on documentation provided.",
  user: `Question: ${userQuestion}\n\nDocumentation:\n${context}`,
});
```

---

## Advanced Patterns

### Pattern 1: Hybrid Search (Vector + Keyword)

**Coming Soon**: Combine semantic search with exact keyword matching

```typescript
// Future API
const results = await ragProvider.query({
  text: "authentication",
  filters: {
    keywords: ["OAuth", "JWT"],    // Must contain these keywords
    filePath: "docs/security/**",   // Only search security docs
  },
});
```

### Pattern 2: Incremental Indexing

**Use Case**: Update only changed files

```bash
# Initial index
vat rag index docs/

# Make changes to docs/api.md
# ...

# Re-index (skips unchanged files automatically)
vat rag index docs/

# Output:
# resourcesIndexed: 1    # Only api.md
# resourcesSkipped: 41   # All others unchanged
# chunksDeleted: 5       # Old chunks from api.md
# chunksCreated: 6       # New chunks from api.md
```

### Pattern 3: Multi-Store Querying

**Use Case**: Search across multiple RAG stores

```typescript
const stores = await Promise.all([
  LanceDBRAGProvider.create({ dbPath: './dist/api-rag', readonly: true }),
  LanceDBRAGProvider.create({ dbPath: './dist/guides-rag', readonly: true }),
  LanceDBRAGProvider.create({ dbPath: './dist/examples-rag', readonly: true }),
]);

// Query all stores in parallel
const results = await Promise.all(
  stores.map(store => store.query({ text: userQuestion, limit: 5 }))
);

// Merge and deduplicate results
const allChunks = results.flatMap(r => r.chunks);
const uniqueChunks = deduplicateByContentHash(allChunks);
const topResults = sortByScore(uniqueChunks).slice(0, 10);
```

### Pattern 4: CI/CD Integration

**Use Case**: Build RAG database during deployment

**GitHub Actions** (`.github/workflows/build-rag.yml`):

```yaml
name: Build RAG Database

on:
  push:
    paths:
      - 'docs/**'
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1

      - name: Install dependencies
        run: bun install

      - name: Build RAG database
        run: |
          bun run vat rag clear
          bun run vat rag index docs/

      - name: Upload RAG database
        uses: actions/upload-artifact@v4
        with:
          name: rag-database
          path: .rag-db/

      - name: Commit RAG database to dist/
        if: github.ref == 'refs/heads/main'
        run: |
          mv .rag-db dist/docs-rag
          git config user.name github-actions
          git config user.email github-actions@github.com
          git add dist/docs-rag
          git commit -m "chore: update RAG database"
          git push
```

---

## Content Transform

Content transforms rewrite markdown links before content is chunked, embedded, and persisted. This is useful when RAG-indexed content needs links rewritten for the consumer context -- for example, converting local file links to MCP resource URIs, or stripping links entirely for cleaner LLM context.

### Programmatic API

Pass `contentTransform` when creating a RAG provider to apply link rewriting during indexing:

```typescript
import { LanceDBRAGProvider } from '@vibe-agent-toolkit/rag-lancedb';
import type { ContentTransformOptions } from '@vibe-agent-toolkit/resources';

const contentTransform: ContentTransformOptions = {
  linkRewriteRules: [
    {
      match: { type: 'local_file' },
      template: '{{link.text}} (see: {{link.href}})',
    },
    {
      match: { type: 'external' },
      template: '[{{link.text}}]({{link.href}})',  // Keep external links as-is
    },
  ],
};

const provider = await LanceDBRAGProvider.create({
  dbPath: './dist/rag-db',
  contentTransform,
});
```

### Template Variables

Templates use Mustache-style `{{variable}}` placeholders. The following variables are available:

| Variable | Description |
|----------|-------------|
| `link.text` | Link display text |
| `link.href` | Original href (without fragment) |
| `link.fragment` | Fragment portion including `#` (or empty string) |
| `link.type` | Link type: `local_file`, `anchor`, `external`, `email`, `unknown` |
| `link.resource.id` | Target resource ID (requires `resourceRegistry`) |
| `link.resource.filePath` | Target resource file path (requires `resourceRegistry`) |
| `link.resource.extension` | File extension (requires `resourceRegistry`) |
| `link.resource.mimeType` | Inferred MIME type (requires `resourceRegistry`) |
| `link.resource.frontmatter.*` | Frontmatter fields (requires `resourceRegistry`) |

### Match Criteria

Rules are evaluated in order; the first matching rule wins. Each rule's `match` object supports:

- `type` -- link type(s) to match (e.g., `'local_file'`, `'external'`, or an array of types)
- `pattern` -- glob pattern(s) matched against the target resource's `filePath`
- `excludeResourceIds` -- resource IDs to exclude from matching

### Advanced Example: Resource Registry

When a `resourceRegistry` is provided, templates can reference resolved resource metadata for richer rewriting:

```typescript
import { transformContent, type LinkRewriteRule } from '@vibe-agent-toolkit/resources';

const rules: LinkRewriteRule[] = [
  {
    match: { type: 'local_file', pattern: 'docs/**/*.md' },
    template: '{{link.text}} (resource: {{link.resource.id}}, type: {{link.resource.mimeType}})',
  },
];

// transformContent is also available as a standalone function
const transformed = transformContent(content, resource.links, {
  linkRewriteRules: rules,
  resourceRegistry: myRegistry,
});
```

### Key Behavior Notes

- Content hash is computed on **transformed** content, so changing transform rules triggers re-indexing.
- Links matching no rule are left untouched.
- When no `contentTransform` is provided, content is stored as-is (original behavior).

---

## Document Storage

By default, the RAG provider only stores chunked content for vector search. When `storeDocuments: true` is enabled, the full source document is also persisted in a separate `rag_documents` table. This enables the "search then retrieve" pattern -- find relevant chunks via vector search, then fetch the complete document for full context.

### Programmatic API

```typescript
const provider = await LanceDBRAGProvider.create({
  dbPath: './dist/rag-db',
  storeDocuments: true,
});

// Index resources (documents are stored automatically)
await provider.indexResources(resources);

// After finding relevant chunks via query...
const result = await provider.query({ text: 'authentication setup', limit: 5 });

// Retrieve full document for top result
const chunk = result.chunks[0];
if (chunk) {
  const doc = await provider.getDocument(chunk.resourceId);
  // doc.content — full document text
  // doc.tokenCount — total tokens
  // doc.totalChunks — number of chunks produced
  // doc.metadata — frontmatter metadata
  // doc.indexedAt — when it was indexed
}
```

### DocumentResult Fields

| Field | Type | Description |
|-------|------|-------------|
| `resourceId` | `string` | Source resource ID |
| `filePath` | `string` | Absolute file path |
| `content` | `string` | Full document content (transformed if applicable) |
| `contentHash` | `string` | SHA-256 hash of stored content |
| `tokenCount` | `number` | Token count of full document |
| `totalChunks` | `number` | Number of chunks produced |
| `indexedAt` | `Date` | When the document was indexed |
| `metadata` | `Record<string, unknown>` | Frontmatter metadata |

### Combined Example: Content Transform + Document Storage

Both features compose naturally. When used together, the stored document content reflects the transformed output:

```typescript
const provider = await LanceDBRAGProvider.create({
  dbPath: './dist/rag-db',
  storeDocuments: true,
  contentTransform: {
    linkRewriteRules: [
      {
        match: { type: 'local_file' },
        template: '{{link.text}} (see: {{link.href}})',
      },
    ],
  },
});

// Both chunks AND full documents will have transformed content
```

### Key Behavior Notes

- When `storeDocuments` is not enabled (default), `getDocument()` returns `null`.
- Documents are automatically updated/deleted when their resource is updated/deleted.
- Full document content reflects any `contentTransform` rules applied.

---

## Example Projects

### Example 1: Personal Knowledge Base

**Structure**:

```
my-knowledge-base/
├── notes/
│   ├── programming/
│   ├── productivity/
│   └── learning/
├── bookmarks/
│   └── articles.md
├── vibe-agent-toolkit.config.yaml
└── .rag-db/
```

**Config**:

```yaml
version: 1

resources:
  include:
    - notes/**/*.md
    - bookmarks/**/*.md
```

`include` — not `collections` — is what narrows the crawl, and `.rag-db` is the default database
path, so `vat rag index` with no arguments does the right thing here.

**Usage**:

```bash
# Index all notes
vat rag index

# Search notes
vat rag query "how to use docker compose"
vat rag query "productivity tips"
vat rag query "typescript generics"
```

### Example 2: Team Documentation Portal

**Structure**:

```
team-docs/
├── onboarding/
├── processes/
├── technical/
├── agents/
│   └── doc-assistant/
├── vibe-agent-toolkit.config.yaml
└── dist/
    └── docs-rag/
```

**Config**:

```yaml
version: 1

resources:
  include:
    - onboarding/**/*.md
    - processes/**/*.md
    - technical/**/*.md
```

The agent under `agents/doc-assistant/` needs no config entry — it is discovered by its own
`agent.yaml`. The database path is given on the command line below, and the embedding model is the
CLI default; an OpenAI model would mean driving `LanceDBRAGProvider.create` yourself, per
[Selecting an embedding provider](#selecting-an-embedding-provider).

**Deploy**:

```bash
# Build RAG database at the path shown in the tree above
bun run vat rag index --db ./dist/docs-rag

# Deploy doc-assistant agent
bun run vat agent build doc-assistant
bun run vat agent install doc-assistant

# Team members query via agent
vat agent run doc-assistant "What's our code review process?"
```

---

**See Also**:
- [RAG Architecture](../architecture/rag.md)
