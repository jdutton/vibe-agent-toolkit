# vat rag - RAG (Retrieval-Augmented Generation) Commands

## Overview

The `vat rag` commands provide semantic search capabilities over your markdown documentation
using vector embeddings. RAG enables you to query your docs using natural language and get
back the most relevant content based on meaning, not just keyword matching.

## Quick Start

```bash
# 1. Index your documentation (recursively finds all *.md under docs/)
vat rag index docs/

# 2. Query for relevant content
vat rag query "error handling patterns"

# 3. Check database statistics
vat rag stats

# 4. Clear database when needed
vat rag clear
```

## Commands

### vat rag index [path]

**Purpose:** Index markdown files into vector database for semantic search

**What it does:**
1. Discovers markdown files recursively (respects config include/exclude patterns)
2. Chunks documents into smaller pieces for efficient embedding
3. Generates vector embeddings using transformer models (Xenova/all-MiniLM-L6-v2)
4. Stores chunks and embeddings in LanceDB vector database
5. Supports incremental updates (skips files with unchanged content)

**Path Argument Behavior:**
- `[path]` specifies the **base directory** to start crawling from
- Recursively finds all `*.md` files under that directory (default pattern: `**/*.md`)
- When path is specified, **config patterns are ignored** (to avoid pattern conflicts)
- To use config patterns, run without path argument: `vat rag index`

**Options:**
- `[path]` - Base directory to crawl (defaults to current directory)
- `--db <path>` - Database path (default: `.rag-db` in project root)
- `--debug` - Enable debug logging

**Exit Codes:**
- `0` - Indexing completed successfully
- `2` - System error (config invalid, database error, etc.)

**Output:** YAML on stdout with indexing statistics

**Example:**
```bash
# Index all *.md files recursively under docs/
vat rag index docs/
# Equivalent to: find all files matching docs/**/*.md pattern

# Output:
# ---
# status: success
# resourcesIndexed: 12
# resourcesSkipped: 0
# resourcesUpdated: 0
# chunksCreated: 48
# chunksDeleted: 0
# duration: 2.4s
# ---
```

**Incremental Updates:**

The index command is idempotent - run it multiple times and it will:
- Skip files with unchanged content (content hash matching)
- Update files that changed (delete old chunks, add new ones)
- Add new files that weren't previously indexed

```bash
# First run: indexes all *.md files recursively under docs/
vat rag index docs/

# Second run (no changes): skips all files (content hash match)
vat rag index docs/
# resourcesSkipped: 12, chunksCreated: 0

# After editing one file: updates only that file
vat rag index docs/
# resourcesSkipped: 11, resourcesUpdated: 1
# chunksDeleted: 4, chunksCreated: 5
```

### vat rag query <text>

**Purpose:** Search vector database using semantic similarity

**What it does:**
1. Converts your query text to a vector embedding
2. Searches database for chunks with similar embeddings (cosine similarity)
3. Returns ranked results with full chunk content and metadata
4. Results are ordered by relevance (most similar first)

**Options:**
- `<text>` - Query text (required)
- `--limit <n>` - Maximum results to return (default: 10)
- `--db <path>` - Database path (default: `.rag-db` in project root)
- `--debug` - Enable debug logging

**Exit Codes:**
- `0` - Query completed successfully
- `2` - System error (no database, embedding error, etc.)

**Output:** YAML on stdout with query results

**Example:**
```bash
vat rag query "error handling patterns" --limit 5

# Output:
# ---
# status: success
# query: error handling patterns
# stats:
#   totalMatches: 5
#   searchDurationMs: 62
#   embedding:
#     model: Xenova/all-MiniLM-L6-v2
# duration: 65ms
# chunks:
#   - chunkId: doc1-chunk2
#     resourceId: doc1-hash
#     filePath: docs/guide.md
#     headingPath: Error Handling > Try-Catch Patterns
#     headingLevel: 2
#     startLine: 42
#     endLine: 58
#     title: Developer Guide
#     type: markdown
#     contentHash: abc123...
#     tokenCount: 245
#     embeddingModel: Xenova/all-MiniLM-L6-v2
#     embeddedAt: 2025-12-29T10:30:45.123Z
#     content: |
#       ## Try-Catch Patterns
#
#       When handling errors in async code...
#       [full content, not truncated]
#   - [more chunks...]
# ---
```

**Chunk Fields Explained:**

Each chunk includes comprehensive metadata:

**Identifiers:**
- `chunkId` - Unique ID for this chunk
- `resourceId` - ID of source document (content-based hash)

**Location:**
- `filePath` - Path to source markdown file
- `headingPath` - Full heading hierarchy (e.g., "Guide > Setup > Installation")
- `headingLevel` - Markdown heading level (1-6)
- `startLine` / `endLine` - Line numbers in source file

**Metadata:**
- `title` - Document title (from frontmatter or first heading)
- `type` - Resource type (always "markdown" currently)
- `tags` - Tags from frontmatter (if present)

**Technical:**
- `contentHash` - Hash of chunk content (for change detection)
- `tokenCount` - Approximate token count for this chunk
- `embeddingModel` - Model used to generate embedding
- `embeddedAt` - Timestamp when embedding was created

**Context:**
- `previousChunkId` - ID of previous chunk in same document (if exists)
- `nextChunkId` - ID of next chunk in same document (if exists)

**Content:**
- `content` - Full text content of the chunk (not truncated)

### vat rag stats

**Purpose:** Display vector database statistics and metadata

**What it does:**
1. Queries database for total chunk and resource counts
2. Shows embedding model information
3. Reports database size and last indexed timestamp
4. Useful for verifying indexing completed successfully

**Options:**
- `--db <path>` - Database path (default: `.rag-db` in project root)
- `--debug` - Enable debug logging

**Exit Codes:**
- `0` - Stats retrieved successfully
- `2` - System error (no database exists)

**Output:** YAML on stdout with database statistics

**Example:**
```bash
vat rag stats

# Output:
# ---
# status: success
# totalChunks: 48
# totalResources: 12
# dbSizeBytes: 0
# embeddingModel: Xenova/all-MiniLM-L6-v2
# lastIndexed: 2025-12-29T10:30:45.123Z
# duration: 15ms
# ---
```

**Field Descriptions:**
- `totalChunks` - Total document chunks in database
- `totalResources` - Unique documents indexed
- `dbSizeBytes` - Database size (0 if not available from provider)
- `embeddingModel` - Transformer model used for embeddings
- `lastIndexed` - Timestamp of most recent indexing operation

### vat rag clear

**Purpose:** Delete entire RAG database directory

**What it does:**
1. Closes database connection
2. Deletes entire database directory (`.rag-db/` by default)
3. Removes all indexed data and embeddings
4. Cannot be undone - use with caution

**When to use:**
- Changing embedding models (incompatible with existing embeddings)
- Database corruption detected
- Starting fresh after major documentation restructure
- Testing/development (reset to clean state)

**Options:**
- `--db <path>` - Database path (default: `.rag-db` in project root)
- `--debug` - Enable debug logging

**Exit Codes:**
- `0` - Database cleared successfully
- `2` - System error

**Output:** YAML on stdout with confirmation

**Example:**
```bash
vat rag clear

# Output:
# ---
# status: success
# message: Database cleared
# duration: 12ms
# ---
```

**Warning:** This operation is **permanent and cannot be undone**. The entire
database directory will be deleted. After clearing, re-run `vat rag index` to
rebuild the database from your markdown source files.

## Configuration

RAG respects the same `vibe-agent-toolkit.config.yaml` patterns as other commands:

```yaml
version: 1
resources:
  include:
    - "docs/**/*.md"
    - "README.md"
  exclude:
    - "node_modules/**"
    - "docs/plans/**"  # Exclude planning docs
    - "**/test/**"
```

**Note:** RAG only indexes files that match the configured patterns. Update your
config to control which markdown files are indexed.

## How RAG Works

### 1. Document Chunking

Large documents are split into smaller chunks (default: 512 tokens each) because:
- Transformer models have input length limits
- Smaller chunks provide more precise search results
- Users get exactly the relevant section, not entire documents

Chunks preserve context:
- Maintain heading hierarchy
- Link to previous/next chunks
- Include source file location (line numbers)

### 2. Vector Embeddings

Each chunk is converted to a 384-dimensional vector using the
`Xenova/all-MiniLM-L6-v2` transformer model. Semantically similar text produces
similar vectors, enabling semantic search.

**Example:**
- Query: "error handling"
- Matches: "exception management", "failure recovery", "try-catch patterns"
- Why: Similar meaning → similar vectors

### 3. Vector Search

When you query:
1. Query text → vector embedding (same model)
2. Database searches for chunks with similar vectors (cosine similarity)
3. Returns top N most similar chunks, ranked by relevance

## Database Storage

RAG uses LanceDB for local vector storage:

- **Format:** Columnar Apache Arrow format
- **Location:** `.rag-db/` directory (configurable)
- **Size:** Depends on documents (embeddings are 384 floats × chunk count)
- **Portability:** Database directory can be copied/moved

**Git:** Add `.rag-db/` to `.gitignore` (databases are generated, not source)

## Performance Tips

**Indexing:**
- First indexing takes time (embedding generation is CPU-intensive)
- Incremental updates are fast (only changed files re-indexed)
- Larger chunks = fewer chunks = faster indexing (but less precise search)

**Querying:**
- First query after starting CLI is slower (model loading)
- Subsequent queries are fast (model cached in memory)
- Use `--limit` to reduce result size for faster responses

**Chunk Size:**
Default 512 tokens balances:
- Precision (smaller chunks → more precise matches)
- Context (larger chunks → more complete information)
- Performance (fewer chunks → faster indexing/search)

## Embedding Model

Current model: `Xenova/all-MiniLM-L6-v2`

**Characteristics:**
- 384-dimensional embeddings
- Fast inference (~50ms per chunk)
- Good quality for documentation search
- Runs locally (no API calls, no cost, privacy-preserving)

**Changing Models:**

To use a different model, you'll need to:
1. Update model in code (currently hardcoded)
2. Run `vat rag clear` (embeddings are model-specific)
3. Re-index documents with new model

Different models produce incompatible embeddings - never mix embeddings from
different models in the same database.

## Integration Examples

### CI/CD: Verify documentation indexed

```yaml
# GitHub Actions
- name: Build RAG database
  run: vat rag index docs/

- name: Verify database created
  run: vat rag stats | grep 'totalChunks'
```

### CLI Tool: Query from script

```bash
#!/bin/bash
# Search docs and extract first result

query="$1"
result=$(vat rag query "$query" --limit 1)
echo "$result" | yq '.chunks[0].content'
```

### Pre-commit: Keep database fresh

```yaml
# .husky/pre-commit
vat rag index --debug
```

## Troubleshooting

### "No data indexed yet"

**Error:** Query or stats fails with "No data indexed yet"

**Solution:** Run `vat rag index` first to create the database

```bash
vat rag index docs/
vat rag query "your search"
```

### Outdated search results

**Problem:** Query returns content that no longer exists in docs

**Solution:** Re-index to update database (automatic change detection)

```bash
vat rag index docs/
```

### Database corruption

**Problem:** Errors about corrupted database or schema mismatches

**Solution:** Clear and rebuild

```bash
vat rag clear
vat rag index docs/
```

### Poor search results

**Problem:** Queries don't return expected content

**Possible causes:**
1. Content not indexed yet → Run `vat rag index`
2. Query too broad/vague → Be more specific
3. Chunk boundaries split relevant content → Adjust chunk size (future feature)

## More Information

- **GitHub:** https://github.com/jdutton/vibe-agent-toolkit
- **Issues:** https://github.com/jdutton/vibe-agent-toolkit/issues
- **Embedding Model:** https://huggingface.co/Xenova/all-MiniLM-L6-v2
- **LanceDB:** https://lancedb.com
