/**
 * RAG command group
 */

import { Command } from 'commander';

import { lazyAction, type OptionalBackend } from '../../utils/optional-backend.js';

/**
 * The RAG lane ships as an optional install.
 *
 * `rag-lancedb` carries a platform-native LanceDB binary
 * and pulls `onnxruntime-web` and `gpt-tokenizer` behind it -- 275 MB of a
 * 351 MB install, and 1,350 ms of cold module load, for a lane most vat
 * commands never touch.
 */
const RAG_BACKEND: OptionalBackend = {
  feature: 'RAG',
  packageName: '@vibe-agent-toolkit/rag-lancedb',
};

// Common option descriptions
const DB_PATH_OPTION = '--db <path>';
const DB_PATH_DESC = 'Database path (default: .rag-db in project root)';
const DEBUG_OPTION_DESC = 'Enable debug logging';

export function createRagCommand(): Command {
  const rag = new Command('rag');

  rag
    .description('Semantic search over markdown documentation using vector embeddings')
    .helpCommand(false) // Disable redundant 'help' command, use --help instead
    .addHelpText(
      'after',
      `
Description:
  RAG enables semantic search over your documentation. Index markdown files
  to create vector embeddings, then query using natural language to find
  relevant content based on meaning (not just keyword matching).

Workflow:
  1. Index markdown files → Creates vector database
  2. Query database → Returns semantically similar content
  3. Stats → Monitor database size and model info
  4. Clear → Reset database when needed

Example:
  $ vat rag index docs/                # Recursively index all *.md under docs/
  $ vat rag query "error handling"     # Search for relevant content

Configuration:
  Create vibe-agent-toolkit.config.yaml in project root to control
  which files are included/excluded from indexing.
`
    );

  rag
    .command('index [path]')
    .description('Index markdown resources into vector database')
    .option(DB_PATH_OPTION, DB_PATH_DESC)
    .option('--debug', DEBUG_OPTION_DESC)
    .action(lazyAction('rag index', RAG_BACKEND, async () => (await import('./index-command.js')).indexCommand))
    .addHelpText(
      'after',
      `
Description:
  Indexes markdown files into LanceDB vector database for semantic search.
  Processes documents by chunking text, generating vector embeddings using
  transformer models, and storing in a local vector database. Supports
  incremental updates (skips unchanged files).

  Path argument: base directory to crawl (defaults to current directory)
  When path specified: recursively finds all *.md files (ignores config)
  When no path: uses vibe-agent-toolkit.config.yaml include/exclude patterns

Output:
  A YAML report on stdout (status ok, findings or error); examined counts
  the resources submitted. Its data holds:
  - resourcesIndexed: new/updated files
  - resourcesSkipped: unchanged files (content hash match)
  - resourcesEmpty: files that chunked to nothing (frontmatter-only or blank);
    recorded, not searchable, not an error
  - resourcesUpdated: files with new content
  - chunksCreated / chunksDeleted: chunks added, and removed from updated files
  Each file NOT in the index (unreadable, or failed to chunk or embed) is a
  RAG_DOCUMENT_INDEX_FAILED finding at its path; its content is not searchable.

Exit Codes:
  0 - Every submitted file indexed (or skipped as unchanged)
  1 - Findings: at least one file is not in the index
  2 - Could not run (error.code says why: USAGE_INVALID for a missing path or
      --db, INPUT_UNREADABLE, CONFIG_INVALID, BACKEND_UNAVAILABLE when the RAG
      backend is not installed)

Requirements:
  projectRoot: optional (tolerates absence — use --db to specify path)
  config:      required fields (rag.*) for indexing without --db

  See docs/concepts/roots-and-config.md for terminology.

Example:
  $ vat rag index docs/                # Recursively index all *.md under docs/
  $ vat rag index                      # Recursively index from current directory
  $ vat rag index --db custom.db       # Use custom database path
`
    );

  rag
    .command('query <text>')
    .description('Search RAG database with semantic query')
    .option(DB_PATH_OPTION, DB_PATH_DESC)
    .option('--limit <n>', 'Maximum results to return (default: 10)', Number.parseInt)
    .option('--debug', DEBUG_OPTION_DESC)
    .action(lazyAction('rag query', RAG_BACKEND, async () => (await import('./query-command.js')).queryCommand))
    .addHelpText(
      'after',
      `
Description:
  Searches vector database using semantic similarity. Converts your query
  to a vector embedding and finds the most relevant document chunks based
  on meaning (not just keywords). Returns full chunk content with metadata.

Output:
  A YAML report on stdout (status ok, or error); examined counts the chunks
  in the index searched, so a query matching nothing is ok. Its data holds:
  - root: the directory every filePath is relative to
  - query: original search text
  - stats: totalMatches, searchDurationMs, embedding.model
  - chunks: matching document chunks with full content

Each chunk includes:
  - chunkId, resourceId, filePath (identifiers)
  - headingPath, headingLevel, startLine, endLine (location)
  - title, type, tags (metadata)
  - contentHash, tokenCount, embeddingModel, embeddedAt (technical)
  - content (full text, not truncated)

Exit Codes:
  0 - Searched
  2 - Could not run (error.code: INPUT_UNREADABLE when nothing is indexed yet
      or the database cannot be read, USAGE_INVALID with no --db and no
      project or a --db that is not a RAG database — nothing there, a file,
      or a directory holding anything but the tables vat rag index writes —
      BACKEND_UNAVAILABLE)

Requirements:
  projectRoot: optional (tolerates absence — use --db to specify path)
  config:      required file with rag.* for default db lookup

  See docs/concepts/roots-and-config.md for terminology.

Example:
  $ vat rag query "error handling"     # Search for relevant content
  $ vat rag query "configuration" --limit 5
`
    );

  rag
    .command('stats')
    .description('Show RAG database statistics')
    .option(DB_PATH_OPTION, DB_PATH_DESC)
    .option('--debug', DEBUG_OPTION_DESC)
    .action(lazyAction('rag stats', RAG_BACKEND, async () => (await import('./stats-command.js')).statsCommand))
    .addHelpText(
      'after',
      `
Description:
  Displays vector database statistics including indexed content count,
  embedding model information, and database metadata. Use this to verify
  indexing completed successfully and monitor database size.

Output:
  A YAML report on stdout (status ok, or error); examined is 1, the database
  opened. Its data holds:
  - totalChunks: number of document chunks indexed
  - totalResources: number of unique documents indexed
  - dbSizeBytes: database size on disk
  - embeddingModel: model used for vector embeddings
  - lastIndexed: ISO 8601 timestamp of the most recent indexing

Exit Codes:
  0 - Reported (an existing database holding nothing reports zeros)
  2 - Could not run (error.code: USAGE_INVALID with no --db and no project or
      a --db that is not a RAG database — nothing there, a file, or a
      directory holding anything but the tables vat rag index writes —
      INPUT_UNREADABLE when the project has no database yet or it cannot be
      read, BACKEND_UNAVAILABLE). Never creates the database.

Requirements:
  projectRoot: optional (tolerates absence — use --db to specify path)
  config:      required file with rag.* for default db lookup

  See docs/concepts/roots-and-config.md for terminology.

Example:
  $ vat rag stats                      # Show database statistics
  $ vat rag stats --db custom.db       # Stats for specific database
`
    );

  rag
    .command('clear')
    .description('Delete entire RAG database directory')
    .option(DB_PATH_OPTION, DB_PATH_DESC)
    .option('--debug', DEBUG_OPTION_DESC)
    .action(lazyAction('rag clear', RAG_BACKEND, async () => (await import('./clear-command.js')).clearCommand))
    .addHelpText(
      'after',
      `
Description:
  Deletes the entire RAG database directory and all indexed data.
  Use this when changing embedding models, fixing corruption, or
  starting fresh with a clean database.

Warning:
  This operation cannot be undone. The database directory will be
  permanently deleted. Re-run 'vat rag index' to rebuild from source.

  Only a RAG database is removed: a directory holding nothing but the tables
  vat rag index writes. It is removed without being opened, so a database
  whose files are damaged can still be cleared. Any other directory is
  refused and left untouched.

Output:
  A YAML report on stdout (status ok, or error); examined is 1, the database
  removed. Its data is { cleared: true }.

Exit Codes:
  0 - Cleared
  2 - Could not run (error.code: USAGE_INVALID with no --db and no project or
      a --db that is not a RAG database — nothing there, a file, or a
      directory holding anything but the tables vat rag index writes —
      INPUT_UNREADABLE when the project has no database yet or it cannot be
      listed, BACKEND_UNAVAILABLE)

Requirements:
  projectRoot: optional (tolerates absence — use --db to specify path)
  config:      required file with rag.* for default db lookup

  See docs/concepts/roots-and-config.md for terminology.

Example:
  $ vat rag clear                      # Clear default database (.rag-db/)
  $ vat rag clear --db custom.db       # Clear specific database
`
    );

  return rag;
}

export { showRagVerboseHelp } from './help.js';
