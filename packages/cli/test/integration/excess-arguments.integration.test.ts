/**
 * Every `vat` verb refuses a positional operand it never declared.
 *
 * Commander 12 defaults `allowExcessArguments` to `true`, so `vat audit skills
 * does-not-exist` audited `skills`, never mentioned the second path, and exited
 * 0. `applyCommandTreePolicy` turns the check on for every node; this suite
 * builds the whole tree the way `bin.ts` does and proves it, leaf by leaf, so a
 * command added later is covered without anyone remembering to add a case.
 *
 * No action ever runs: a root `preAction` hook throws a sentinel. Commander
 * checks mandatory options, unknown options and the argument count BEFORE it
 * runs hooks or the action, so the real check still runs, and a command that
 * ACCEPTED the operand ends on the sentinel instead of doing any work. A hook
 * rather than replacing each action, because a group can carry an action of
 * its own (`audit` does) and nothing public says which ones do.
 */

import { Command, CommanderError, type Argument, type Option } from 'commander';
import { beforeAll, describe, expect, it } from 'vitest';

import { COMMAND_LOADERS } from '../../src/command-loaders.js';
import { applyCommandTreePolicy } from '../../src/command-tree.js';
import { doctorCommand } from '../../src/commands/doctor.js';

const EXTRA = 'zz-excess-operand';

/** Commands whose action refuses operands with its own, better message. */
const HAND_REFUSING = ['build', 'validate', 'verify'];

/**
 * Leaves whose last argument is variadic — they absorb any number of operands,
 * so "excess" does not exist for them. Listed so a new one is a visible change.
 */
const VARIADIC_LEAVES = ['claude context'];

/** Thrown by the root `preAction` hook: the command accepted its argv. */
class AcceptedSentinel extends Error {}

interface Node {
  readonly path: readonly string[];
  readonly command: Command;
}

function walk(command: Command, path: readonly string[], out: Node[]): Node[] {
  for (const sub of command.commands) {
    const subPath = [...path, sub.name()];
    out.push({ path: subPath, command: sub });
    walk(sub, subPath, out);
  }
  return out;
}

function placeholderFor(argument: Argument): string {
  return argument.argChoices?.[0] ?? 'placeholder';
}

function mandatoryOptionArgv(option: Option): string[] {
  const flag = option.long ?? option.short ?? option.flags;
  if (!option.required && !option.optional) return [flag];
  return [flag, option.argChoices?.[0] ?? 'placeholder'];
}

/**
 * The path to `node`, a value for EVERY argument it declares (optional ones
 * too, so an optional operand cannot absorb the extra), its mandatory options,
 * and then one operand more than it declares.
 */
function excessArgv(node: Node): string[] {
  const mandatory = node.command.options.filter((option) => option.mandatory);
  return [
    ...node.path,
    ...node.command.registeredArguments.map((argument) => placeholderFor(argument)),
    ...mandatory.flatMap((option) => mandatoryOptionArgv(option)),
    EXTRA,
  ];
}

function isVariadic(command: Command): boolean {
  return command.registeredArguments.at(-1)?.variadic === true;
}

/**
 * Parse `argv` against `root`; returns the CommanderError it ended on, or
 * `undefined` when the command accepted the argv (the sentinel fired).
 */
async function parseEnding(root: Command, argv: string[]): Promise<CommanderError | undefined> {
  try {
    await root.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) return error;
    if (error instanceof AcceptedSentinel) return undefined;
    throw error;
  }
  throw new Error(`'${argv.join(' ')}' neither ended nor reached the preAction hook`);
}

describe('every vat verb refuses an excess positional argument', () => {
  let root: Command;
  let nodes: Node[];

  beforeAll(async () => {
    root = new Command('vat');
    for (const load of Object.values(COMMAND_LOADERS)) root.addCommand(await load());
    doctorCommand(root);
    applyCommandTreePolicy(root);

    nodes = walk(root, [], []);
    const silent = { writeOut: (): void => {}, writeErr: (): void => {} };
    root.configureOutput(silent);
    root.hook('preAction', () => {
      throw new AcceptedSentinel();
    });
    for (const node of nodes) node.command.configureOutput(silent);
  });

  it('refuses the extra operand on every leaf that does not refuse it by hand', async () => {
    const leaves = nodes.filter(
      (node) => node.command.commands.length === 0 && !HAND_REFUSING.includes(node.path.join(' ')),
    );
    const accepted: string[] = [];
    for (const leaf of leaves.filter((node) => !isVariadic(node.command))) {
      const argv = excessArgv(leaf);
      const ending = await parseEnding(root, argv);
      if (ending?.code !== 'commander.excessArguments') {
        accepted.push(`${argv.join(' ')} → ${ending?.code ?? 'accepted'}`);
      }
    }
    // Guard against a walk that reached nothing: the tree has dozens of leaves.
    expect(leaves.length).toBeGreaterThan(40);
    expect(accepted).toEqual([]);

    const variadic = leaves.filter((node) => isVariadic(node.command)).map((node) => node.path.join(' '));
    expect(variadic.toSorted((a, b) => a.localeCompare(b))).toEqual(VARIADIC_LEAVES);
  });

  it('leaves build, validate and verify to refuse operands with their own message', async () => {
    for (const name of HAND_REFUSING) {
      const ending = await parseEnding(root, [name, EXTRA]);
      expect(ending, name).toBeUndefined();
    }
  });

  // A group with an action of its own (`audit` takes a path AND has
  // subcommands) is a verb too; one without ends on "unknown command".
  it('ends every command group on a usage error when given an operand beyond what it declares', async () => {
    const groups = nodes.filter((node) => node.command.commands.length > 0);
    expect(groups.length).toBeGreaterThan(5);

    const accepted: string[] = [];
    for (const group of groups) {
      const argv = excessArgv(group);
      const ending = await parseEnding(root, argv);
      if (ending === undefined || ending.exitCode === 0) accepted.push(argv.join(' '));
    }
    expect(accepted).toEqual([]);
  });
});
