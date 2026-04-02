import { Command } from 'commander';

import { createMarketplacePublishCommand } from './publish.js';
import { createMarketplaceValidateCommand } from './validate.js';

export function createMarketplaceCommand(): Command {
  const command = new Command('marketplace');

  command
    .description('Validate and publish Claude plugin marketplaces')
    .helpCommand(false)
    .addHelpText('after', `
Description:
  Standalone marketplace validation and publishing.

  validate: Strict validation of a marketplace directory (works without config)
  publish:  Push built marketplace to a Git branch for distribution

Example:
  $ vat claude marketplace validate .                  # Validate current directory
  $ vat claude marketplace publish                     # Publish to claude-marketplace branch
  $ vat claude marketplace publish --dry-run           # Preview publish without pushing
`);

  command.addCommand(createMarketplaceValidateCommand());
  command.addCommand(createMarketplacePublishCommand());

  return command;
}
