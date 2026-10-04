/**
 * Skills validate command - Commander.js wrapper
 */

import { Command } from 'commander';

import { type SkillsValidateCommandOptions, validateCommand } from './validate.js';

export function createValidateCommand(): Command {
  const command = new Command('validate');

  command
    .description('Validate skills for packaging (reads skills config from config yaml)')
    .argument('[path]', 'Path to directory with config yaml (default: current directory)')
    .option('--skill <name>', 'Validate specific skill only')
    .option('-v, --verbose', 'Print every finding in full on stderr, with allowed issues and excluded reference paths')
    .option('-d, --debug', 'Enable debug logging')
    .action(async (pathArg: string | undefined, options: SkillsValidateCommandOptions) => {
      await validateCommand(pathArg, options);
    })
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
    - A YAML frontmatter block that parses. A matched file with none — a
      README the glob drifted onto, a SKILL.md that lost its fence — is
      refused as SKILL_MISSING_FRONTMATTER at error, not passed as a skill.
      (A block without a name is legal — agentskills.io makes name optional.)
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

Output (YAML on stdout — the report envelope):
  status: ok | findings | error. findings means at least one finding was
          published; error means the run did not finish (error.code says why).
  examined: the number of skills validated.
  summary: the findings by severity — every skill's plus the run's.
  findings[]: every finding, flat — {code, severity, message, location, …};
          location is relative to data.root. Run-level findings (validation.allow
          entries no skill matched) are here too, with no skill attached.
  data.root: the directory the config was read from.
  data.skills[]: one row per skill validated, clean or not —
          {name, status, summary, allowed}. allowed counts the findings
          validation.allow suppressed; they are never published as findings.

  stderr is the human report: one line per skill with findings and every
  error in full. --verbose adds every warning and info in full, the allowed
  issues and the excluded reference paths. The document is the same either way.

  A run that validated ZERO skills — skills.include globs that matched no
  SKILL.md, or a config with no skills: block — is not a clean run: the
  document carries one non-overridable RESOURCE_CHECK_BROKEN at error, exit 1,
  and stderr names the globs that matched nothing.

Exit Codes (derived from the document):
  0 - status ok, or findings with no error-severity finding (warnings and
      info never fail this command; allowed findings are not published)
  1 - status findings with at least one error-severity finding, including
      a run that validated no skill
  2 - status error: the run did not finish — USAGE_INVALID for a [path] that
      names no directory holding a config, an unknown --skill, or no project
      root; INPUT_UNREADABLE for a directory the OS will not list;
      CONFIG_INVALID for a config that does not parse

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
