/**
 * RAG command group
 */

import { Command } from 'commander';

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
    .description('RAG (Retrieval-Augmented Generation) operations')
    .helpCommand(false) // Disable redundant 'help' command, use --help instead
    .addHelpText(
      'after',
      `
Example:
  $ vat rag index docs/                # Index markdown into vector DB

Configuration:
  Create vibe-agent-toolkit.config.yaml in project root.
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
  Indexes markdown files into LanceDB vector database for RAG queries.
  Chunks documents, generates embeddings, and stores in vector database.
  Default: current directory. Respects config include/exclude patterns.

Output Fields:
  status, resourcesIndexed, resourcesSkipped, chunksCreated, duration

Exit Codes:
  0 - Success  |  2 - System error

Example:
  $ vat rag index docs/                # Index docs directory
  $ vat rag index --db custom.db       # Custom database path
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
  Searches vector database using semantic similarity. Returns ranked
  results with truncated content (200 chars max per result).

Output Fields:
  status, query, totalMatches, searchDurationMs, embeddingModel, results, duration
  Each result: rank, resourceId, filePath, content, headingPath, title

Exit Codes:
  0 - Success  |  2 - System error (no database)

Example:
  $ vat rag query "RAG architecture"   # Search for relevant content
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
  Displays database statistics including total chunks, resources,
  and embedding model information.

Output Fields:
  totalChunks, totalResources, dbSizeBytes, embeddingModel, lastIndexed, duration

Exit Codes:
  0 - Success  |  2 - System error (no database)

Example:
  $ vat rag stats                      # Show database statistics
`
    );

  return rag;
}
