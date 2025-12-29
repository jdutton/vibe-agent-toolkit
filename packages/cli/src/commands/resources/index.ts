/**
 * Resources command group
 */

import { Command } from 'commander';

import { showResourcesVerboseHelp } from './help.js';
import { scanCommand } from './scan.js';
import { validateCommand } from './validate.js';

export function createResourcesCommand(): Command {
  const resources = new Command('resources');

  resources
    .description('Markdown resource scanning and validation')
    .option('--verbose', 'Show verbose help');

  resources
    .command('scan [path]')
    .description('Discover markdown resources in directory')
    .option('--debug', 'Enable debug logging')
    .action(scanCommand);

  resources
    .command('validate [path]')
    .description('Validate markdown resources (link integrity, anchors)')
    .option('--debug', 'Enable debug logging')
    .action(validateCommand);

  return resources;
}

export { showResourcesVerboseHelp };
