/**
 * Skills validate command - Commander.js wrapper
 */

import { Command } from 'commander';

import { validateCommand } from './validate.js';

export function createValidateCommand(): Command {
  const command = new Command('validate');

  command
    .description('Validate skills for packaging (reads vat.skills from package.json)')
    .argument('[path]', 'Path to directory with package.json (default: current directory)')
    .option('--skill <name>', 'Validate specific skill only')
    .option('-d, --debug', 'Enable debug logging')
    .action(validateCommand)
    .addHelpText(
      'after',
      `
Description:
  Validates skills declared in package.json vat.skills field using
  enhanced packaging validation. Checks size/complexity, link depth,
  navigation patterns, and applies validation overrides.

  Reads skills from package.json vat.skills and runs validateSkillForPackaging()
  for each skill. Supports validation overrides with expiration checking.

Validation Checks:
  Required (non-overridable):
    - Valid YAML frontmatter
    - Skill has a name
    - No reserved words (anthropic/claude)
    - No broken internal links
    - No circular references
    - Links stay within package boundary
    - No filename collisions
    - Forward slashes in paths (not backslashes)

  Best practices (overridable):
    - SKILL.md ≤500 lines (recommended)
    - Total skill size ≤2000 lines
    - File count ≤6 files
    - Reference depth ≤2 levels
    - No links to navigation files (README.md, index.md)
    - Description ≥50 characters
    - Progressive disclosure pattern

Validation Overrides:
  Configure overrides in package.json vat.skills:

  {
    "vat": {
      "skills": [{
        "name": "my-skill",
        "source": "./SKILL.md",
        "path": "./dist/skills/my-skill",
        "ignoreValidationErrors": {
          "SKILL_LENGTH_EXCEEDS_RECOMMENDED": "Complex domain requires detailed examples",
          "SKILL_TOO_MANY_FILES": {
            "reason": "Migration in progress - will split skill",
            "expires": "2026-06-01"
          }
        }
      }]
    }
  }

  Non-overridable rules (required for correctness) cannot be ignored.
  Expired overrides are reported as errors.

Output:
  YAML summary → stdout (for programmatic parsing)
  Detailed errors → stderr (for human reading)

  Output includes:
    - status: success/error
    - skillsValidated: number of skills validated
    - results: per-skill validation details (activeErrors, ignoredErrors, expiredOverrides)
    - durationSecs: validation time

Exit Codes:
  0 - All validations passed (or all errors ignored by valid overrides)
  1 - Active validation errors found (or expired overrides)
  2 - System error (file not found, invalid config, etc.)

Examples:
  $ vat skills validate                    # Validate all skills in package.json
  $ vat skills validate --skill my-skill   # Validate specific skill only
  $ vat skills validate packages/my-pkg/   # Validate skills in specific directory
`
    );

  return command;
}
