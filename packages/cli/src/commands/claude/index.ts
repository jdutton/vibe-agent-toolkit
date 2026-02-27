/**
 * Claude command group
 *
 * Commands for building and verifying Claude plugin marketplace artifacts
 */

import { Command } from 'commander';

import { createBuildCommand } from './build.js';
import { createVerifyCommand } from './verify.js';

export function createClaudeCommand(): Command {
  const command = new Command('claude');

  command
    .description('Build and verify Claude plugin marketplace artifacts')
    .helpCommand(false)
    .addHelpText(
      'after',
      `
Description:
  Commands for working with Claude Code plugin marketplaces and plugin.json artifacts.
  Reads claude: section from vibe-agent-toolkit.config.yaml.

Examples:
  $ vat claude build                     # Generate plugin artifacts from pre-built skills
  $ vat claude verify                    # Validate marketplace.json and plugin.json files
  $ vat claude verify --marketplace lfa  # Verify a specific marketplace

Workflow:
  1. Configure: Add claude: section to vibe-agent-toolkit.config.yaml
  2. Build: vat skills build (build portable skills first)
  3. Package: vat claude build (wrap skills into Claude plugin format)
  4. Verify: vat claude verify (validate generated artifacts)

Or use the top-level commands:
  $ vat build     # Runs skills build then claude build
  $ vat verify    # Validates everything (resources, skills, claude)
`
    );

  command.addCommand(createBuildCommand());
  command.addCommand(createVerifyCommand());

  return command;
}
