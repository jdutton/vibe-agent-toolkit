/**
 * Skills validate command - Commander.js wrapper
 */

import { Command } from 'commander';

import { validateCommand } from './validate.js';

export function createValidateCommand(): Command {
  const command = new Command('validate');

  command
    .description('Validate SKILL.md files (links, frontmatter, skill rules)')
    .argument('[path]', 'Path to validate (default: current directory)')
    .option('-d, --debug', 'Enable debug logging')
    .action(validateCommand)
    .addHelpText(
      'after',
      `
Description:
  Validates all SKILL.md files using both resource validation (markdown,
  links, frontmatter) and skill-specific validation (reserved words, XML
  tags, console compatibility). Reports all errors in a unified format.

  Replaces the two-step validation approach (vat resources validate +
  validate-skills script) with a single command.

Validation Checks:
  Resource validation:
    - Internal file links (relative paths)
    - Anchor links within files (#heading)
    - Cross-file anchor links (file.md#heading)
    - Frontmatter schema (if SKILL.md has frontmatter)

  Skill-specific validation:
    - Reserved word checks (name field)
    - XML tag detection (name/description fields)
    - Console compatibility warnings
    - Frontmatter required fields (name, description)

Output:
  YAML summary → stdout (for programmatic parsing)
  Detailed errors → stderr (for human reading)

  Output includes:
    - status: success/error
    - skillsValidated: number of SKILL.md files found
    - results: per-skill validation details
    - durationSecs: validation time

Exit Codes:
  0 - All validations passed
  1 - Validation errors found
  2 - System error (file not found, config invalid, etc.)

Example:
  $ vat skills validate                    # Validate all skills in current directory
  $ vat skills validate packages/          # Validate skills in packages directory
`
    );

  return command;
}
