/**
 * Resources command group
 */

import { Command } from 'commander';

import { scanCommand } from './scan.js';
import { validateCommand } from './validate.js';

export function createResourcesCommand(): Command {
  const resources = new Command('resources');

  resources
    .description('Markdown resource scanning and link validation (run before commit)')
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
  Recursively scans for markdown files and reports statistics. Outputs YAML to stdout.
  Path argument: base directory (defaults to current directory)
  When path specified: recursively finds all *.md files (ignores config)
  When no path: uses vibe-agent-toolkit.config.yaml include/exclude patterns

Output Fields:
  status, filesScanned, linksFound, duration

Example:
  $ vat resources scan docs/           # Recursively scan all *.md under docs/
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
  Recursively validates internal links and anchors in markdown files.
  Path argument: base directory (defaults to current directory)
  When path specified: recursively finds all *.md files (ignores config)
  When no path: uses vibe-agent-toolkit.config.yaml include/exclude patterns
  Outputs YAML to stdout, errors to stderr.
  External URLs are NOT validated (by design).

Checks:
  Internal file links, anchor links (#heading), cross-file anchors (file.md#heading)

Exit Codes:
  0 - Success  |  1 - Validation errors  |  2 - System error

Example:
  $ vat resources validate docs/        # Recursively validate all *.md under docs/
`
    );

  return resources;
}

export { showResourcesVerboseHelp } from './help.js';
