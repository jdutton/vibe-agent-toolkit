import type { Command } from 'commander';

/**
 * Render a command's help exactly as a user sees it.
 *
 * 🪤 `helpInformation()` renders the built-in sections ONLY: Commander appends
 * an `addHelpText('after', …)` block in `outputHelp()`, and in this CLI nearly
 * every sentence that describes BEHAVIOUR lives in that block. A suite written
 * against `helpInformation()` sees an empty Description section and passes
 * every "the help does not say X" assertion vacuously.
 *
 * @param command - The command to render (already fully constructed)
 * @returns The rendered help, after-text included
 */
export function renderCommandHelp(command: Command): string {
  let captured = '';
  command.configureOutput({ writeOut: (text: string) => { captured += text; } });
  command.outputHelp();
  return captured;
}

/**
 * One subcommand of a command group, by name.
 *
 * @param group - The group, already fully constructed
 * @param name - The subcommand's name
 * @returns The subcommand
 * @throws When the group no longer exposes it, so a rename fails loudly
 */
export function subcommand(group: Command, name: string): Command {
  const found = group.commands.find((candidate) => candidate.name() === name);
  if (found === undefined) throw new Error(`command factory no longer exposes a '${name}' subcommand`);
  return found;
}
