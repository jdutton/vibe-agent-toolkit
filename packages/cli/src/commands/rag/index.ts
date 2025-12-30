/**
 * RAG command group
 */

import { Command } from 'commander';

import { clearCommand } from './clear-command.js';
import { indexCommand } from './index-command.js';
import { queryCommand } from './query-command.js';
import { statsCommand } from './stats-command.js';

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
  $ vat rag index docs/                # Index markdown into vector DB
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
    .action(indexCommand)
    .addHelpText(
      'after',
      `
Description:
  Indexes markdown files into LanceDB vector database for semantic search.
  Processes documents by chunking text, generating vector embeddings using
  transformer models, and storing in a local vector database. Supports
  incremental updates (skips unchanged files).

  Default path: current directory
  Respects: vibe-agent-toolkit.config.yaml include/exclude patterns

Output Structure (YAML):
  status: success/error
  resourcesIndexed: new/updated files
  resourcesSkipped: unchanged files (content hash match)
  resourcesUpdated: files with new content
  chunksCreated: total chunks added
  chunksDeleted: chunks removed from updated files
  duration: total indexing time

Exit Codes:
  0 - Success  |  2 - System error

Example:
  $ vat rag index docs/                # Index docs directory
  $ vat rag index                      # Index current directory
  $ vat rag index --db custom.db       # Use custom database path
`
    );

  rag
    .command('query <text>')
    .description('Search RAG database with semantic query')
    .option(DB_PATH_OPTION, DB_PATH_DESC)
    .option('--limit <n>', 'Maximum results to return (default: 10)', parseInt)
    .option('--debug', DEBUG_OPTION_DESC)
    .action(queryCommand)
    .addHelpText(
      'after',
      `
Description:
  Searches vector database using semantic similarity. Converts your query
  to a vector embedding and finds the most relevant document chunks based
  on meaning (not just keywords). Returns full chunk content with metadata.

Output Structure (YAML):
  status: success/error
  query: original search text
  stats:
    totalMatches: number of results
    searchDurationMs: query time
    embedding.model: model used for embeddings
  duration: total command time
  chunks: array of matching document chunks with full content

Each chunk includes:
  - chunkId, resourceId, filePath (identifiers)
  - headingPath, headingLevel, startLine, endLine (location)
  - title, type, tags (metadata)
  - contentHash, tokenCount, embeddingModel, embeddedAt (technical)
  - content (full text, not truncated)

Exit Codes:
  0 - Success  |  2 - System error (no database)

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
    .action(statsCommand)
    .addHelpText(
      'after',
      `
Description:
  Displays vector database statistics including indexed content count,
  embedding model information, and database metadata. Use this to verify
  indexing completed successfully and monitor database size.

Output Structure (YAML):
  status: success/error
  totalChunks: number of document chunks indexed
  totalResources: number of unique documents indexed
  dbSizeBytes: database size on disk (if available)
  embeddingModel: model used for vector embeddings
  lastIndexed: timestamp of most recent indexing
  duration: command execution time

Exit Codes:
  0 - Success  |  2 - System error (no database)

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
    .action(clearCommand)
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

Output Structure (YAML):
  status: success/error
  message: confirmation message
  duration: command execution time

Exit Codes:
  0 - Success  |  2 - System error

Example:
  $ vat rag clear                      # Clear default database (.rag-db/)
  $ vat rag clear --db custom.db       # Clear specific database
`
    );

  return rag;
}

export { showRagVerboseHelp } from './help.js';
