# RAG Usage Guide

This guide provides practical examples for using the VAT RAG system in real-world scenarios.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Configuration Examples](#configuration-examples)
3. [Agent Integration](#agent-integration)
4. [Advanced Patterns](#advanced-patterns)
5. [Example Projects](#example-projects)

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

### Example 1: Simple Project

**Use Case**: Single documentation directory, one RAG store

**vibe-agent-toolkit.config.yaml**:

```yaml
version: 1

resources:
  collections:
    docs:
      include:
        - ./docs/**/*.md
        - ./README.md

rag:
  stores:
    main:
      db: ./.rag-db
      resources: docs
```

**Usage**:

```bash
# Index uses config automatically
vat rag index

# Query uses default store
vat rag query "installation guide"
```

### Example 2: Multi-Language Documentation

**Use Case**: Separate RAG stores for different languages

**Config**:

```yaml
version: 1

resources:
  collections:
    docs-en:
      include:
        - ./docs/en/**/*.md
    docs-fr:
      include:
        - ./docs/fr/**/*.md
    docs-es:
      include:
        - ./docs/es/**/*.md

rag:
  stores:
    en-rag:
      db: ./dist/rag-en
      resources: docs-en
    fr-rag:
      db: ./dist/rag-fr
      resources: docs-fr
    es-rag:
      db: ./dist/rag-es
      resources: docs-es
```

**Usage**:

```bash
# Index each language separately
vat rag index --db ./dist/rag-en docs/en/
vat rag index --db ./dist/rag-fr docs/fr/
vat rag index --db ./dist/rag-es docs/es/

# Query by language
vat rag query "installation" --db ./dist/rag-en
vat rag query "installation" --db ./dist/rag-fr
```

### Example 3: API Documentation + Examples

**Use Case**: Separate stores for API reference vs usage examples

**Config**:

```yaml
version: 1

resources:
  defaults:
    exclude:
      - '**/node_modules/**'
      - '**/dist/**'

  collections:
    api-reference:
      include:
        - ./api-docs/**/*.md
      metadata:
        defaults:
          type: api-reference
          tags: [api, reference]

    examples:
      include:
        - ./examples/**/*.{md,js,ts}
      metadata:
        defaults:
          type: example
          tags: [example, tutorial]

rag:
  defaults:
    embedding:
      provider: openai
      model: text-embedding-3-small
    chunking:
      targetSize: 256  # Smaller chunks for API docs

  stores:
    api-rag:
      db: ./dist/api-rag
      resources: api-reference

    examples-rag:
      db: ./dist/examples-rag
      resources: examples
      chunking:
        targetSize: 512  # Larger chunks for examples
```

**Usage**:

```bash
# Index both stores
vat rag index --db ./dist/api-rag api-docs/
vat rag index --db ./dist/examples-rag examples/

# Search API docs
vat rag query "authentication endpoint" --db ./dist/api-rag

# Search examples
vat rag query "authentication example" --db ./dist/examples-rag
```

### Example 4: Agent Development Project

**Use Case**: Agent toolkit with multiple agents and shared knowledge base

**Config**:

```yaml
version: 1

resources:
  defaults:
    exclude:
      - '**/node_modules/**'
      - '**/dist/**'
      - '**/.git/**'

  collections:
    toolkit-docs:
      include:
        - ./docs/**/*.md
        - ./README.md
    agent-guides:
      include:
        - ./guides/**/*.md
    api-reference:
      include:
        - ./api/**/*.md

agents:
  include:
    - ./packages/*/agents/**
    - ./agents/**

rag:
  defaults:
    embedding:
      provider: transformers-js
      model: Xenova/all-MiniLM-L6-v2
    chunking:
      targetSize: 512
      paddingFactor: 0.9

  stores:
    agent-knowledge:
      db: ./dist/agent-knowledge-rag
      resources: toolkit-docs
    guide-rag:
      db: ./dist/guide-rag
      resources: agent-guides
    api-rag:
      db: ./dist/api-rag
      resources: api-reference
      chunking:
        targetSize: 256  # Smaller for API docs
```

---

## Agent Integration

### Example: Code Review Agent with RAG

**Agent Manifest** (`agent.yaml`):

```yaml
apiVersion: v1
kind: Agent
metadata:
  name: code-review-agent
  version: 1.0.0
  description: Reviews code against best practices documentation

spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4-20250514

  prompts:
    system:
      $ref: ./prompts/system.md

  tools:
    - name: search_best_practices
      type: rag
      config:
        dbPath: ../../dist/best-practices-rag
        description: Search coding best practices documentation
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
import { createRAGProvider } from '@vibe-agent-toolkit/rag-lancedb';

const manifest = await loadAgentManifest('./code-review-agent');

// Create RAG provider for tool
const ragTool = manifest.spec.tools.find(t => t.type === 'rag');
const ragProvider = await createRAGProvider({
  dbPath: ragTool.config.dbPath,
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

**Agent Setup**:

```yaml
# doc-assistant/agent.yaml
spec:
  tools:
    - name: search_docs
      type: rag
      config:
        dbPath: ../dist/docs-rag
        description: Search project documentation
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
const stores = [
  createRAGProvider({ dbPath: './dist/api-rag' }),
  createRAGProvider({ dbPath: './dist/guides-rag' }),
  createRAGProvider({ dbPath: './dist/examples-rag' }),
];

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
  collections:
    all-notes:
      include:
        - ./notes/**/*.md
        - ./bookmarks/**/*.md

rag:
  stores:
    knowledge:
      db: ./.rag-db
      resources: all-notes
```

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
  collections:
    team-docs:
      include:
        - ./onboarding/**/*.md
        - ./processes/**/*.md
        - ./technical/**/*.md

agents:
  include:
    - ./agents/**

rag:
  stores:
    team-knowledge:
      db: ./dist/docs-rag
      resources: team-docs
      embedding:
        provider: openai
        model: text-embedding-3-small
```

**Deploy**:

```bash
# Build RAG database
bun run vat rag index

# Deploy doc-assistant agent
bun run vat agent build doc-assistant
bun run vat agent install doc-assistant

# Team members query via agent
vat agent run doc-assistant "What's our code review process?"
```

---

**See Also**:
- [RAG Architecture](../architecture/rag.md)
