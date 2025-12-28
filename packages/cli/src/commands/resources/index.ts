/**
 * Resources command group
 */

import { Command } from 'commander';

import { scanCommand } from './scan.js';

export function createResourcesCommand(): Command {
  const resources = new Command('resources');

  resources
    .description('Markdown resource scanning and validation');

  resources
    .command('scan [path]')
    .description('Discover markdown resources in directory')
    .option('--debug', 'Enable debug logging')
    .action(scanCommand);

  return resources;
}
