/**
 * Resources command group
 */

import { Command } from 'commander';

import { scanCommand } from './scan.js';
import { validateCommand } from './validate.js';

export function createResourcesCommand(): Command {
  const resources = new Command('resources');

  resources
    .description('Markdown resource scanning and validation')
    .option('--verbose', 'Show verbose help')
    .helpCommand(false) // Disable redundant 'help' command, use --help instead
    .addHelpText(
      'after',
      `
Example:
  $ vat resources validate docs/       # Validate markdown in docs directory

Configuration:
  Create vibe-agent-toolkit.config.yaml in project root. See --help --verbose for schema.
`
    );

  resources
    .command('scan [path]')
    .description('Discover markdown resources in directory')
    .option('--debug', 'Enable debug logging')
    .action(scanCommand)
    .addHelpText(
      'after',
      `
Description:
  Scans for markdown files and reports statistics. Outputs YAML to stdout.
  Default: current directory. Respects config include/exclude patterns.

Output Fields:
  status, filesScanned, linksFound, duration

Example:
  $ vat resources scan docs/           # Scan docs directory
`
    );

  resources
    .command('validate [path]')
    .description('Validate markdown resources (link integrity, anchors)')
    .option('--debug', 'Enable debug logging')
    .action(validateCommand)
    .addHelpText(
      'after',
      `
Description:
  Validates internal links and anchors in markdown files. Outputs YAML to stdout,
  errors to stderr. External URLs are NOT validated (by design).

Checks:
  Internal file links, anchor links (#heading), cross-file anchors (file.md#heading)

Exit Codes:
  0 - Success  |  1 - Validation errors  |  2 - System error

Example:
  $ vat resources validate docs/        # Validate docs directory
`
    );

  return resources;
}

export { showResourcesVerboseHelp } from './help.js';
