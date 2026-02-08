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
    .option('-u, --user', 'Validate user-installed skills in ~/.claude')
    .option('-d, --debug', 'Enable debug logging')
    .action(validateCommand)
    .addHelpText(
      'after',
      `
Description:
  Validates all SKILL.md files using both resource validation (markdown,
  links, frontmatter) and skill-specific validation (reserved words, XML
  tags, console compatibility). Reports all errors in a unified format.

  Supports three modes:
    - Project mode (default): Validate project skills with strict filename validation
    - User mode (--user): Validate ~/.claude skills with permissive validation
    - Path mode: Validate skills at specific path with strict validation

Validation Modes:
  Project mode (strict):
    - Respects vibe-agent-toolkit.config.yaml boundaries
    - Filename must be exactly "SKILL.md" (case-sensitive)
    - Errors on non-standard filenames (skill.md, Skill.md)

  User mode (permissive):
    - Scans ~/.claude/plugins and ~/.claude/skills
    - Filename warnings for non-standard names (not errors)
    - More tolerant for user-installed content

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

  Filename validation:
    - Must be "SKILL.md" (uppercase)
    - Strict mode: error on skill.md, Skill.md
    - Permissive mode: warning only

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
  1 - Validation errors found (warnings don't fail)
  2 - System error (file not found, config invalid, etc.)

Examples:
  $ vat skills validate                    # Project mode: validate all project skills
  $ vat skills validate --user             # User mode: validate ~/.claude skills
  $ vat skills validate packages/          # Path mode: validate specific directory
`
    );

  return command;
}
