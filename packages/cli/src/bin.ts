#!/usr/bin/env node

/**
 * Main entry point for vat CLI
 * Uses Commander.js for command structure
 */

import { Command } from 'commander';

import { createResourcesCommand } from './commands/resources/index.js';
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
  .showHelpAfterError()
  .configureOutput({
    writeErr: (str) => process.stderr.write(str),
  });

// Handle --help --verbose
program.on('option:verbose', () => {
  const opts = program.opts();
  if (opts['verbose'] && program.args.length === 0) {
    showVerboseHelp();
    process.exit(0);
  }
});

// Add command groups
program.addCommand(createResourcesCommand());

// Handle unknown commands
program.on('command:*', (operands) => {
  const logger = createLogger();
  logger.error(`error: unknown command '${operands[0]}'`);
  logger.error('');
  program.help({ error: true });
});

program.parse();

function showVerboseHelp(): void {
  const logger = createLogger();
  logger.info(`# vat - Vibe Agent Toolkit CLI

## Overview

The \`vat\` command-line tool provides access to toolkit capabilities for building,
testing, and deploying portable AI agents.

## Usage

\`\`\`bash
vat [command] [options]
\`\`\`

## Commands

### resources
Markdown resource scanning and validation

- \`vat resources scan [path]\` - Discover markdown resources
- \`vat resources validate [path]\` - Validate link integrity

## Options

- \`--version\` - Show version number
- \`--help\` - Show help
- \`--help --verbose\` - Show comprehensive help (this output)
- \`--debug\` - Enable debug logging

## Exit Codes

- \`0\` - Success
- \`1\` - Validation errors (expected failures)
- \`2\` - System errors (unexpected failures)

## Examples

\`\`\`bash
# Show version
vat --version

# Scan markdown resources
vat resources scan docs/

# Validate all links
vat resources validate docs/
\`\`\`

## Configuration

Place \`vibe-agent-toolkit.config.yaml\` at project root:

\`\`\`yaml
version: 1
resources:
  include:
    - "docs/**/*.md"
  exclude:
    - "node_modules/**"
\`\`\`

## More Information

- Documentation: https://github.com/jdutton/vibe-agent-toolkit
- Issues: https://github.com/jdutton/vibe-agent-toolkit/issues
`);
}
