/**
 * RAG command group
 */

import { Command } from 'commander';

import { indexCommand } from './index-command.js';

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

  return rag;
}
