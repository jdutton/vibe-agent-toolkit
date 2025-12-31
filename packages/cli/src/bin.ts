#!/usr/bin/env node

/**
 * Main entry point for vat CLI
 * Uses Commander.js for command structure
 */

import { Command } from 'commander';

import { createAgentCommand, showAgentVerboseHelp } from './commands/agent/index.js';
import { createRagCommand, showRagVerboseHelp } from './commands/rag/index.js';
import { createResourcesCommand, showResourcesVerboseHelp } from './commands/resources/index.js';
import { loadVerboseHelp } from './utils/help-loader.js';
import { createLogger } from './utils/logger.js';
import { version, getVersionString, type VersionContext } from './version.js';

const program = new Command();

// Context detection from environment
const context: VersionContext | null = process.env['VAT_CONTEXT']
  ? ({
      type: process.env['VAT_CONTEXT'] as 'dev' | 'local' | 'global',
      path: process.env['VAT_CONTEXT_PATH'],
    } as VersionContext)
  : null;

program
  .name('vat')
  .description('Vibe Agent Toolkit - Build, test, and deploy portable AI agents')
  .version(getVersionString(version, context), '-v, --version', 'Output version number')
  .option('--debug', 'Enable debug logging')
  .option('--verbose', 'Show verbose help (markdown format)')
  .helpCommand(false) // Disable redundant 'help' command, use --help instead
  .showHelpAfterError()
  .configureOutput({
    writeOut: (str) => process.stdout.write(str), // Help goes to stdout (pipeable)
    writeErr: (str) => process.stderr.write(str), // Errors go to stderr
  })
  .addHelpText(
    'after',
    `
Example:
  $ vat resources validate docs/       # Validate markdown links

For command details: vat resources --help
`
  );

// Handle --help --verbose at root level only
// Don't handle --verbose if a subcommand was specified
const hasSubcommand = process.argv.slice(2).some(arg => !arg.startsWith('-'));

program.on('option:verbose', () => {
  const opts = program.opts();
  // Only show root verbose help if no subcommand is present
  if (opts['verbose'] && !hasSubcommand && program.args.length === 0) {
    showVerboseHelp();
    process.exit(0);
  }
});

// Special handling for "resources --verbose" before parsing
if (process.argv.includes('resources') && process.argv.includes('--verbose')) {
  const argv = process.argv.slice(2);
  const resourcesIndex = argv.indexOf('resources');
  // Check if there's no subcommand after 'resources'
  const afterResources = argv.slice(resourcesIndex + 1);
  const hasSubcommand = afterResources.some(arg => !arg.startsWith('-'));

  if (!hasSubcommand) {
    showResourcesVerboseHelp();
    process.exit(0);
  }
}

// Special handling for "rag --verbose" before parsing
if (process.argv.includes('rag') && process.argv.includes('--verbose')) {
  const argv = process.argv.slice(2);
  const ragIndex = argv.indexOf('rag');
  // Check if there's no subcommand after 'rag'
  const afterRag = argv.slice(ragIndex + 1);
  const hasSubcommand = afterRag.some(arg => !arg.startsWith('-'));

  if (!hasSubcommand) {
    showRagVerboseHelp();
    process.exit(0);
  }
}

// Special handling for "agent --verbose" before parsing
if (process.argv.includes('agent') && process.argv.includes('--verbose')) {
  const argv = process.argv.slice(2);
  const agentIndex = argv.indexOf('agent');
  // Check if there's no subcommand after 'agent'
  const afterAgent = argv.slice(agentIndex + 1);
  const hasSubcommand = afterAgent.some(arg => !arg.startsWith('-'));

  if (!hasSubcommand) {
    showAgentVerboseHelp();
    process.exit(0);
  }
}

// Add command groups
program.addCommand(createResourcesCommand());
program.addCommand(createRagCommand());
program.addCommand(createAgentCommand());

// Handle unknown commands
program.on('command:*', (operands) => {
  const logger = createLogger();
  logger.error(`error: unknown command '${operands[0]}'`);
  logger.error('');
  program.help({ error: true });
});

program.parse();

function showVerboseHelp(): void {
  const helpContent = loadVerboseHelp(); // Loads from docs/cli/index.md
  process.stdout.write(helpContent);
  process.stdout.write('\n');
}
