/**
 * `vat skill` command group — singular, single-skill focused operations.
 *
 * Distinct from `vat skills` (plural), which operates on the project's whole
 * skill set (validate, build, package, list, install). `vat skill` subcommands
 * zoom in on one skill at a time.
 */

import { Command } from 'commander';

import { createSkillReviewCommand } from './review.js';

export function createSkillCommand(): Command {
  const command = new Command('skill');

  command
    .description('Single-skill focused operations (review a specific skill in depth)')
    .helpCommand(false)
    .addHelpText(
      'after',
      `
Example:
  $ vat skill review packages/my-agents/src/skills/ado/SKILL.md

For detailed command help:
  $ vat skill <command> --help
`,
    );

  command.addCommand(createSkillReviewCommand());

  return command;
}
