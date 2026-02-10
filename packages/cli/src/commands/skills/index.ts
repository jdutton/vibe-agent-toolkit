/**
 * Skills command group
 *
 * Commands for packaging, distributing, and managing Claude skills
 */

import { Command } from 'commander';

import { createBuildCommand } from './build.js';
import { createInstallCommand } from './install.js';
import { listCommand } from './list.js';
import { createPackageCommand } from './package.js';
import { createUninstallCommand } from './uninstall.js';
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
  $ vat skills build                                  # Build skills from package.json
  $ vat skills install --dev                          # Dev-install (symlink) all skills
  $ vat skills install --build                        # Build then dev-install
  $ vat skills uninstall --all                        # Uninstall all package skills
  $ vat skills list --user                            # List installed skills

Distribution Workflow:
  1. Validate: Ensure SKILL.md is valid
  2. Build: Build skills into dist/ (for npm packages)
  3. Package: Create distributable ZIP from SKILL.md
  4. Share: Distribute via npm or GitHub releases
  5. Install: Users install from npm or extract ZIP to ~/.claude/plugins/

Development Workflow:
  1. Build: vat skills build
  2. Install: vat skills install --dev (or --build to combine)
  3. Iterate: Rebuild, /reload-skills in Claude Code
  4. Clean up: vat skills uninstall --all

For detailed command help:
  $ vat skills <command> --help
`
    );

  // Add subcommands
  command.addCommand(createValidateCommand());
  command.addCommand(createBuildCommand());
  command.addCommand(createPackageCommand());
  command.addCommand(createInstallCommand());
  command.addCommand(createUninstallCommand());
  command.addCommand(createListCommand());

  return command;
}

/**
 * Create list command
 */
function createListCommand(): Command {
  const listCmd = new Command('list');

  listCmd
    .description('List skills in project or user installation')
    .argument('[path]', 'Path to list skills from (default: current directory)')
    .option('-u, --user', 'List user-installed skills in ~/.claude')
    .option('-v, --verbose', 'Show detailed information')
    .option('--debug', 'Enable debug logging')
    .action(listCommand)
    .addHelpText(
      'after',
      `
Description:
  Lists all skills in the project (default) or user installation (--user flag).
  Discovers SKILL.md files and reports validation status.

  Supports three modes:
    - Project mode (default): List skills in project with config boundaries
    - User mode (--user): List skills in ~/.claude installation
    - Path mode: List skills at specific path

Validation Status:
  ✅ valid: Filename is "SKILL.md" (uppercase)
  ⚠️  warning: Non-standard filename detected (skill.md, Skill.md, etc.)

Output:
  YAML summary → stdout (for programmatic parsing)
  Human-readable list → stderr (for human reading)

  Output includes:
    - status: success
    - context: project/user
    - skillsFound: number of skills discovered
    - skills: array of skill objects with validation status

Exit Codes:
  0 - List operation successful (warnings don't fail)
  2 - System error (directory not found, config invalid, etc.)

Examples:
  $ vat skills list                    # List project skills (default)
  $ vat skills list --user             # List user-installed skills
  $ vat skills list packages/          # List skills at specific path
  $ vat skills list --verbose          # Show full paths and warnings
`
    );

  return listCmd;
}

// No verbose help for skills command yet - can be added later if needed
