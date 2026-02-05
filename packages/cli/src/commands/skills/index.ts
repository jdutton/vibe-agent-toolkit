/**
 * Skills command group
 *
 * Commands for packaging, distributing, and managing Claude skills
 */

import { Command } from 'commander';

import { createInstallCommand } from './install.js';
import { createListCommand } from './list.js';
import { createPackageCommand } from './package.js';

export function createSkillsCommand(): Command {
  const command = new Command('skills');

  command
    .description('Package, install, and manage Claude Code skills')
    .helpCommand(false)
    .addHelpText(
      'after',
      `
Examples:
  $ vat skills package resources/skills/SKILL.md      # Package a skill
  $ vat skills install ./my-skill.zip                 # Install from ZIP
  $ vat skills list                                   # List installed skills

Distribution Workflow:
  1. Package: Create distributable ZIP from SKILL.md
  2. Share: Distribute ZIP via GitHub releases, email, etc.
  3. Install: Users extract to ~/.claude/plugins/

For detailed command help:
  $ vat skills package --help
  $ vat skills install --help
  $ vat skills list --help
`
    );

  // Add subcommands
  command.addCommand(createPackageCommand());
  command.addCommand(createInstallCommand());
  command.addCommand(createListCommand());

  return command;
}

// No verbose help for skills command yet - can be added later if needed
