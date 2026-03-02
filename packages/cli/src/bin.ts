#!/usr/bin/env node

/**
 * Main entry point for vat CLI
 * Uses Commander.js for command structure
 */

import { resolve } from 'node:path';

import { Command } from 'commander';

import { createAgentCommand, showAgentVerboseHelp } from './commands/agent/index.js';
import { createAuditCommand } from './commands/audit.js';
import { createBuildTopLevelCommand } from './commands/build.js';
import { createClaudeCommand } from './commands/claude/index.js';
import { doctorCommand } from './commands/doctor.js';
import { createInstallCommand } from './commands/install.js';
import { createMCPCommand } from './commands/mcp/index.js';
import { createRagCommand, showRagVerboseHelp } from './commands/rag/index.js';
import { createResourcesCommand, showResourcesVerboseHelp } from './commands/resources/index.js';
import { createSkillsCommand } from './commands/skills/index.js';
import { createVerifyTopLevelCommand } from './commands/verify.js';
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
  .description('Agent-friendly toolkit for building, testing, and deploying portable AI agents')
  .version(getVersionString(version, context), '-v, --version', 'Output version number')
  .option('--cwd <dir>', 'Change working directory before running any command')
  .option('--debug', 'Enable debug logging')
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
  $ vat resources validate docs/       # Validate markdown links (run before commit)
  $ vat --cwd packages/my-agents build # Build from a subdirectory

Environment:
  VAT_DEBUG=1                          # Show context detection details

For command details: vat resources --help
For comprehensive help: vat --help --verbose
For agent guidance: docs/cli/CLAUDE.md
`
  );

// Change working directory before any subcommand runs (if --cwd flag provided)
program.hook('preAction', () => {
  const { cwd } = program.opts<{ cwd?: string }>();
  if (cwd) {
    // Resolve relative to original cwd BEFORE chdir
    process.chdir(resolve(cwd));
  }
});

// Handle --help --verbose at root level before parsing
// Manually check process.argv since --verbose is not a root-level option
const hasHelp = process.argv.includes('--help') || process.argv.includes('-h');
const hasVerbose = process.argv.includes('--verbose');
const hasSubcommand = process.argv.slice(2).some(arg => !arg.startsWith('-'));

if (hasHelp && hasVerbose && !hasSubcommand) {
  // Root level: vat --help --verbose
  showVerboseHelp();
  process.exit(0);
}

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

// Add command groups (audit is common, should be first)
program.addCommand(createAuditCommand());
program.addCommand(createInstallCommand());
program.addCommand(createResourcesCommand());
program.addCommand(createRagCommand());
program.addCommand(createAgentCommand());
program.addCommand(createMCPCommand());
program.addCommand(createSkillsCommand());
program.addCommand(createClaudeCommand());

// Add top-level orchestration commands
program.addCommand(createBuildTopLevelCommand());
program.addCommand(createVerifyTopLevelCommand());

// Add standalone commands
doctorCommand(program);

// Handle unknown commands
program.on('command:*', (operands) => {
  const logger = createLogger();
  logger.error(`error: unknown command '${String(operands[0] ?? 'unknown')}'`);
  logger.error('');
  program.help({ error: true });
});

program.parse();

function showVerboseHelp(): void {
  const helpContent = loadVerboseHelp(); // Loads from docs/cli/index.md
  process.stdout.write(helpContent);
  process.stdout.write('\n');
}
