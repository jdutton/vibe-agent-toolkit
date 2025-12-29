/**
 * RAG command group
 */

import { Command } from 'commander';

import { indexCommand } from './index-command.js';
import { queryCommand } from './query-command.js';

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
    .option('--db <path>', 'Database path (default: .rag-db in project root)')
    .option('--debug', 'Enable debug logging')
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
    .option('--db <path>', 'Database path (default: .rag-db in project root)')
    .option('--limit <n>', 'Maximum results to return (default: 10)', parseInt)
    .option('--debug', 'Enable debug logging')
    .action(queryCommand)
    .addHelpText(
      'after',
      `
Description:
  Searches vector database using semantic similarity. Returns ranked
  results with truncated content (200 chars max per result).

Output Fields:
  status, query, totalMatches, searchDurationMs, embeddingModel, results, duration
  Each result: rank, score, resourceId, filePath, content, headingPath, title

Exit Codes:
  0 - Success  |  2 - System error (no database)

Example:
  $ vat rag query "RAG architecture"   # Search for RAG architecture
  $ vat rag query "API" --limit 5      # Limit to 5 results
`
    );

  return rag;
}
