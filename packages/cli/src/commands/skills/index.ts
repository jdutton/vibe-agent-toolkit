// packages/cli/src/commands/skills/index.ts
/**
 * Skills command group
 *
 * Commands for packaging and validating Claude skills (vendor-neutral toolchain).
 * Installing skills into Claude is now handled by: vat claude plugin
 */

import { Command } from 'commander';

import { createBuildCommand } from './build.js';
import { listCommand } from './list.js';
import { createPackageCommand } from './package.js';
import { createValidateCommand } from './validate-command.js';

export function createSkillsCommand(): Command {
  const command = new Command('skills');

  command
    .description('Build and validate Claude Code skills (vendor-neutral packaging)')
    .helpCommand(false)
    .addHelpText('after', `
Examples:
  $ vat skills validate                               # Validate all skills
  $ vat skills build                                  # Build skills from package.json
  $ vat skills list                                   # List skills in project

Build & Install Workflow:
  1. Validate: vat skills validate
  2. Build: vat skills build (creates dist/.claude/plugins/)
  3. Install: vat claude plugin install --dev (symlink) or npm:@scope/package

For detailed command help:
  $ vat skills <command> --help
`);

  command.addCommand(createValidateCommand());
  command.addCommand(createBuildCommand());
  command.addCommand(createPackageCommand());
  command.addCommand(createListCommand());

  return command;
}

function createListCommand(): Command {
  const listCmd = new Command('list');

  listCmd
    .description('List skills in project or user installation')
    .argument('[path]', 'Path to list skills from (default: current directory)')
    .option('-u, --user', 'List user-installed skills in ~/.claude')
    .option('-v, --verbose', 'Show detailed information')
    .option('--debug', 'Enable debug logging')
    .action(listCommand)
    .addHelpText('after', `
Description:
  Lists all skills in the project (default) or user installation (--user flag).
  Discovers SKILL.md files and reports validation status.

  - Project mode (default): List skills in project with config boundaries
  - User mode (--user): List skills in ~/.claude installation
  - Path mode: List skills at specific path

Validation Status:
  ✅ valid: Filename is "SKILL.md" (uppercase)
  ⚠️  warning: Non-standard filename detected (skill.md, Skill.md, etc.)

Output:
  YAML summary → stdout (for programmatic parsing)
  Human-readable list → stderr

Exit Codes:
  0 - List successful
  2 - System error

Example:
  $ vat skills list                    # List project skills
  $ vat skills list --user             # List user-installed skills
`);

  return listCmd;
}
