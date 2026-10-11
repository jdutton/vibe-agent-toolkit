/**
 * MCP command group - expose VAT agents via Model Context Protocol
 */

import { Command } from 'commander';

import { listCollectionsCommand } from './list-collections.js';
import { serveCommand } from './serve.js';

/**
 * Create MCP command group
 */
export function createMCPCommand(): Command {
  const mcp = new Command('mcp');

  mcp
    .description('Expose agents via Model Context Protocol (MCP) for Claude Desktop')
    .addHelpText(
      'after',
      `
Description:
  MCP Gateway exposes VAT agents as tools that Claude Desktop and other
  MCP clients can discover and use.

  Phase 1: Package-scoped collections (@scope/package or ./path)
  Phase 2+: Global discovery registry with versioning

Examples:
  $ vat mcp list-collections                       # Show known packages
  $ vat mcp serve @vibe-agent-toolkit/vat-example-cat-agents
  $ vat mcp serve ./packages/vat-example-cat-agents  # Local development
`
    );

  // vat mcp list-collections
  mcp
    .command('list-collections')
    .description('List known MCP agent packages')
    .option('--debug', 'Enable debug logging')
    .addHelpText(
      'after',
      `
Output:
  A YAML report on stdout (status ok); examined is 1, the built-in package
  list read. Its data.packages holds each package's name and description.
  A human listing with usage examples goes to stderr.

Exit Codes:
  0 - Listed  |  2 - Could not run (error.code INTERNAL_ERROR: a VAT defect)
`
    )
    .action(listCollectionsCommand);

  // vat mcp serve <package>
  mcp
    .command('serve <package>')
    .description('Start MCP server for agent package')
    .option('--debug', 'Enable debug logging')
    .option('--print-config', 'Print Claude Desktop configuration and exit')
    .addHelpText(
      'after',
      `
Description:
  Starts an MCP stdio server exposing agents from the specified package.
  The server runs until terminated (Ctrl+C).

  Supports:
    - Package names: @scope/package (from node_modules)
    - File paths: ./path or /abs/path (local development)
    - Collection suffix: package:collection-name (if multiple)

  For Claude Desktop integration, add the generated config to:
    ~/.claude/config.json

Output:
  - MCP protocol messages on stdout (for Claude Desktop)
  - Logs to stderr (does not interfere with MCP protocol)
  - --print-config: the Claude Desktop config JSON alone on stdout (its
    instructions on stderr), so it can be redirected into a file

Exit Codes:
  0 - Served until stdin closed, or printed the config
  2 - Could not run (the message on stderr; no document — stdout is the protocol)

Examples:
  # Production (from npm)
  $ vat mcp serve @vibe-agent-toolkit/vat-example-cat-agents

  # Local development (file path)
  $ vat mcp serve ./packages/vat-example-cat-agents

  # Show Claude Desktop config
  $ vat mcp serve @vibe-agent-toolkit/vat-example-cat-agents --print-config

Claude Desktop Config:
  Add to ~/.claude/config.json:
  {
    "mcpServers": {
      "vat-agents": {
        "command": "vat",
        "args": ["mcp", "serve", "@vibe-agent-toolkit/vat-example-cat-agents"]
      }
    }
  }
`
    )
    .action(serveCommand);

  return mcp;
}
