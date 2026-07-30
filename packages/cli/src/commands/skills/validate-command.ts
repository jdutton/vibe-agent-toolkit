/**
 * Skills validate command - Commander.js wrapper
 */

import { Command } from 'commander';

import { validateCommand } from './validate.js';

export function createValidateCommand(): Command {
  const command = new Command('validate');

  command
    .description('Validate skills for packaging (reads skills config from config yaml)')
    .argument('[path]', 'Path to directory with config yaml (default: current directory)')
    .option('--skill <name>', 'Validate specific skill only')
    .option('-v, --verbose', 'Show all validated skills and every individual finding, including excluded reference paths')
    .option('-d, --debug', 'Enable debug logging')
    .action(validateCommand)
    .addHelpText(
      'after',
      `
Description:
  Validates skills declared in vibe-agent-toolkit.config.yaml using the
  validation framework (severity + allow). Checks source-detectable link
  issues, size/complexity, and link depth. Applies per-skill severity
  overrides and per-path allow entries.

  Supports severity overrides and per-path allow entries (with optional
  expiry reminders via ALLOW_EXPIRED). See docs/validation-codes.md for
  the full code reference.

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

  Best practices (overridable via severity/allow):
    - SKILL.md ≤500 lines (recommended)
    - Total skill size ≤2000 lines
    - File count ≤6 files
    - Reference depth ≤2 levels
    - No links to navigation files (README.md, index.md)
    - No links to gitignored files
    - Description ≥50 characters
    - Progressive disclosure pattern

Validation Config:
  Configure via validation key in vibe-agent-toolkit.config.yaml skills.config:

  skills:
    config:
      my-skill:
        validation:
          severity:
            SKILL_LENGTH_EXCEEDS_RECOMMENDED: ignore
            LINK_TO_NAVIGATION_FILE: warning
          allow:
            SKILL_TOO_MANY_FILES:
              - reason: "Migration in progress - will split skill"
                expires: "2026-06-01"

  Allow entries accept an optional paths array (defaults to ["**/*"] — the
  whole skill). All codes are configurable via severity (error/warning/ignore)
  or allow entries. Expired allow entries are reported as ALLOW_EXPIRED warnings.

Output:
  YAML summary → stdout (for programmatic parsing)
  Findings report → stderr (for human reading)

  The stdout summary always publishes:
    - status: success/warning/error (worst actionable severity in the run)
    - issueCounts / runIssueCounts: the run total, always with all three
      buckets, and the run-level (project config) share of it. The run total
      always equals the sum of the per-skill rows plus runIssueCounts.
    - skillsValidated: number of skills validated (the true denominator)
    - durationSecs: validation time

  By default, results[] is one row per skill WITH findings — its issue counts
  and a per-code tally, dominant code first. A skill with no findings is
  omitted from the listing entirely; a zero count is an absent field, never
  "errors: 0". stderr prints the same thing as one line per skill.

  --verbose publishes every validated skill (findings or not) with its full
  detail: allErrors, ignoredErrors, observations, evidence and complete
  metadata on stdout, one block per individual finding on stderr. That form is
  meant for redirect-then-grep, not for reading — on a 90-skill repo it is
  ~30x the default output.

  Run-level findings (validation.allow entries no skill matched) are printed
  in full in both forms; they belong to the project config, not to any skill.

Exit Codes:
  0 - All validations passed (or all errors allowed by valid config)
  1 - Validation errors found (severity=error, not allowed)
  2 - System error (config invalid, skill path not found)

Requirements:
  projectRoot: required (errors if no vibe-agent-toolkit.config.yaml or .git/ ancestor)
  config:      optional (uses defaults if absent)

  See docs/concepts/roots-and-config.md for terminology.

Example:
  $ vat skills validate packages/my-pkg/   # Validate skills in specific directory
`
    );

  return command;
}
