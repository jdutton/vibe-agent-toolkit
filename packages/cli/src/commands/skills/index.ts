/**
 * Skills command group
 *
 * Commands for packaging, distributing, and managing Claude skills
 */

import { Command } from 'commander';

import { createInstallCommand } from './install.js';
import { createListCommand } from './list.js';
import { createPackageCommand } from './package.js';
import { createValidateCommand } from './validate-command.js';

export function createSkillsCommand(): Command {
  const command = new Command('skills');

  command
    .description('Package, install, and manage Claude Code skills')
    .helpCommand(false)
    .addHelpText(
      'after',
      `
Examples:
  $ vat skills validate                               # Validate all skills
  $ vat skills package resources/skills/SKILL.md      # Package a skill
  $ vat skills install ./my-skill.zip                 # Install from ZIP
  $ vat skills list                                   # List installed skills

Distribution Workflow:
  1. Validate: Ensure SKILL.md is valid
  2. Package: Create distributable ZIP from SKILL.md
  3. Share: Distribute ZIP via GitHub releases, email, etc.
  4. Install: Users extract to ~/.claude/plugins/

For detailed command help:
  $ vat skills validate --help
  $ vat skills package --help
  $ vat skills install --help
  $ vat skills list --help
`
    );

  // Add subcommands
  command.addCommand(createPackageCommand());
  command.addCommand(createInstallCommand());
  command.addCommand(createListCommand());
  command.addCommand(createValidateCommand());

  return command;
}

// No verbose help for skills command yet - can be added later if needed
