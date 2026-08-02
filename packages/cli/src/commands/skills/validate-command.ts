/**
 * Skills validate command - Commander.js wrapper
 */

import { existsSync, statSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { type SkillsValidateCommandOptions, validateCommand } from './validate.js';

/** The name `loadConfig` looks for in the directory this command is pointed at. */
const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';

const COMMAND = 'vat skills validate';

/**
 * Why the path the operator typed cannot scope this run — or `undefined` when it
 * can.
 *
 * `vat skills validate <path>` takes the path as "read the config in THIS
 * directory". Nothing checked that the directory existed or held one: the path
 * was resolved, `loadConfig` found nothing there, and the run printed
 * "No skills section in config yaml — nothing to validate" and exited **0**. In
 * a package where the bare invocation validates 13 skills, one mistyped
 * character rescoped it to nothing and still reported success — the same
 * "went wide / went narrow and reported success" defect
 * `rejectPositionalArguments` was added to `vat verify` / `vat validate`
 * / `vat build` for, arrived at from the opposite direction.
 *
 * Only an EXPLICIT argument is judged. With no argument the command means "the
 * current directory", and a cwd that happens to hold no config is the documented
 * nothing-to-do case, not a mis-scoped run.
 *
 * `VAT_TEST_CONFIG` is honoured for the same reason `loadConfig` honours it: when
 * it is set, the config does not come from the named directory at all, so
 * demanding one there would reject a scope that is in fact resolvable.
 *
 * Pure — returns the message instead of writing it, so both answers are
 * assertable without capturing a stream.
 *
 * `vat skills build` carries the identical `[path]` argument and the identical
 * hole; it is deliberately left alone here rather than half-converged.
 */
export function unscopableSkillsPath(pathArg: string | undefined): string | undefined {
  if (pathArg === undefined) return undefined;

  const resolved = safePath.resolve(pathArg);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a CLI argument is the subject of this check
  if (!existsSync(resolved)) return 'no such directory';
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- ditto; existence was just established
  if (!statSync(resolved).isDirectory()) return 'not a directory';

  if (process.env['VAT_TEST_CONFIG'] !== undefined) return undefined;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- ditto
  if (!existsSync(safePath.join(resolved, CONFIG_FILENAME))) {
    return `no ${CONFIG_FILENAME} there`;
  }
  return undefined;
}

/**
 * Refuse to run when the operator scoped the command at something it cannot
 * read a config from.
 *
 * Exit 2, matching `rejectPositionalArguments`: exit 1 on this command is
 * documented as "validation errors found", and reporting a usage error as 1
 * tells a CI gate the project's skills are broken when nothing was inspected.
 */
function rejectUnscopablePath(pathArg: string | undefined): void {
  const reason = unscopableSkillsPath(pathArg);
  if (reason === undefined) return;

  process.stderr.write(
    `error: '${COMMAND}' cannot scope to '${String(pathArg)}' (${reason}).\n` +
      `\n` +
      `  '${COMMAND} <path>' reads the ${CONFIG_FILENAME} in the directory it is\n` +
      `  pointed at. This argument used to be accepted and the run silently\n` +
      `  rescoped to NOTHING: it printed "nothing to validate" and exited 0, so an\n` +
      `  operator who mistyped a path got a green tick for a scan that never\n` +
      `  happened.\n` +
      `\n` +
      `  Fix: point '${COMMAND}' at a directory holding a ${CONFIG_FILENAME},\n` +
      `  or run it with no argument to use the current directory.\n` +
      `  To inspect ONE skill or bundle by path, use: vat audit <path>\n`,
  );
  process.exit(2);
}

export function createValidateCommand(): Command {
  const command = new Command('validate');

  command
    .description('Validate skills for packaging (reads skills config from config yaml)')
    .argument('[path]', 'Path to directory with config yaml (default: current directory)')
    .option('--skill <name>', 'Validate specific skill only')
    .option('-v, --verbose', 'Show all validated skills and every individual finding, including excluded reference paths')
    .option('-d, --debug', 'Enable debug logging')
    .action(async (pathArg: string | undefined, options: SkillsValidateCommandOptions) => {
      rejectUnscopablePath(pathArg);
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
