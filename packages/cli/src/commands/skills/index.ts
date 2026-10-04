// packages/cli/src/commands/skills/index.ts
/**
 * Skills command group
 *
 * Commands for packaging and validating Claude skills (vendor-neutral toolchain).
 * Installing skills into Claude is now handled by: vat claude plugin
 */

import { Command } from 'commander';

import { createBuildCommand } from './build.js';
import { createInstallCommand } from './install.js';
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
  3. Install: vat skills install <source> --target claude --scope project

For detailed command help:
  $ vat skills <command> --help
`);

  command.addCommand(createValidateCommand());
  command.addCommand(createBuildCommand());
  command.addCommand(createPackageCommand());
  command.addCommand(createInstallCommand());
  command.addCommand(createListCommand());

  return command;
}

function createListCommand(): Command {
  const listCmd = new Command('list');

  listCmd
    .description('List skills in project or user installation')
    .argument('[path]', 'Directory to list skills from (default: current directory), or an npm: / .tgz source')
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

Output (YAML report on stdout; the human-readable list goes to stderr):
  - status: ok, findings (a directory could not be listed), or error
  - examined: search roots scanned (the project, the package, or --user's two)
  - findings: one SCAN_PATH_UNREADABLE warning per directory the scan could
    not list — the listing is then a floor, not the answer
  - data.root: the one absolute path; every data.skills[].path is relative to it
  - data.skills[]: name (as the frontmatter declares it), path, valid, warning

Exit Codes:
  0 - Listed (an unlistable directory is a warning, not a failure)
  2 - Could not list: a [path] that names no readable directory (USAGE_INVALID
      or INPUT_UNREADABLE), a config that does not load, or an unusable npm:/.tgz source

Requirements:
  projectRoot: optional (tolerates absence; --user scope skips it entirely)
  config:      optional (uses defaults if absent)

  See docs/concepts/roots-and-config.md for terminology.

Example:
  $ vat skills list                    # List project skills
  $ vat skills list --user             # List user-installed skills
  $ vat skills list npm:@scope/pkg     # Preview a package's skills without installing
`);

  return listCmd;
}
