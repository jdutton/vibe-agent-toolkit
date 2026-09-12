/**
 * `bin.ts`'s pre-parse argv decisions — the ones commander is never given a
 * chance to make.
 *
 * ## The defect these pin
 *
 * The three `--verbose` group help pages were selected with
 * `process.argv.includes('<group>') && process.argv.includes('--verbose')`,
 * which matches the word ANYWHERE on the line: as another command's
 * subcommand, as a path, as an option's value. Measured:
 *
 *     vat inventory resources --verbose   → printed RESOURCES' verbose help, exit 0
 *     vat resources scan rag --verbose    → printed RAG's verbose help, exit 0
 *
 * Neither ran the command the user typed, and neither said so. The second is
 * the worse shape: the user asked to scan a directory called `rag`, and the
 * process exited 0 having enumerated nothing.
 *
 * The remedy is to ask WHERE the token is, not whether it appears: the group
 * has to be the token commander itself would read as the command name, which is
 * the same question `requestedCommand` already answers for the lazy loader.
 * Both now come off one grammar, so a future root option cannot fix one and
 * leave the other behind.
 *
 * ## Why these tests are on the grammar and not on `bin.ts`
 *
 * `bin.ts` is the executable — importing it parses argv and runs a command — so
 * the grammar lives in its own module. The `program` here is the REAL root
 * program's option set (`--version`, `--cwd <dir>`, `--debug`, `--no-cache`),
 * rebuilt rather than mocked, because the whole point of the scan is that it
 * reads commander's own declarations: a hand-written flag list would keep
 * passing after someone adds a root option that consumes its next token.
 */

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { registerCacheControl } from '../src/commands/cache/cache-control.js';
import { createRootArgvGrammar } from '../src/utils/root-argv.js';

/**
 * The root program's option surface, declared exactly as `bin.ts` declares it.
 *
 * `registerCacheControl` last, for the reason `createRootArgvGrammar` documents:
 * built before it, `--no-cache` reads as an undeclared option.
 */
function rootGrammar(): ReturnType<typeof createRootArgvGrammar> {
  const program = new Command()
    .name('vat')
    .version('0.0.0-test', '--version', 'Output version number')
    .option('--cwd <dir>', 'Change working directory before running any command')
    .option('--debug', 'Enable debug logging');
  registerCacheControl(program);
  return createRootArgvGrammar(program.options);
}

/** `vat <argv>` — the tokens after the binary, as `bin.ts` slices them. */
function line(commandLine: string): string[] {
  return commandLine.split(' ').filter((token) => token.length > 0);
}

describe('requestedCommand', () => {
  it.each([
    { argv: 'audit', expected: 'audit' },
    { argv: 'resources validate docs/', expected: 'resources' },
    { argv: '--debug audit', expected: 'audit' },
    // `--cwd` consumes its value: `skills` is a directory here, and the verb is
    // the token AFTER it. The naive scan read `skills` and left `validate`
    // unregistered.
    { argv: '--cwd skills validate', expected: 'validate' },
    { argv: '--cwd=skills validate', expected: 'validate' },
    // Root help must list every command, so no single module may be loaded.
    { argv: '--help audit', expected: undefined },
    // An undeclared option ends commander's operand parsing at that token.
    { argv: '--verbose audit', expected: undefined },
    { argv: '', expected: undefined },
  ])('reads $argv as $expected', ({ argv, expected }) => {
    expect(rootGrammar().requestedCommand(line(argv))).toBe(expected);
  });
});

describe('wantsGroupVerboseHelp', () => {
  it.each([
    { argv: 'resources --verbose', group: 'resources' },
    { argv: 'rag --verbose', group: 'rag' },
    { argv: 'agent --verbose', group: 'agent' },
    // Root flags before the group are commander's business, not a disqualifier.
    { argv: '--debug resources --verbose', group: 'resources' },
    { argv: 'resources --help --verbose', group: 'resources' },
  ])('accepts $argv for $group', ({ argv, group }) => {
    expect(rootGrammar().wantsGroupVerboseHelp(line(argv), group)).toBe(true);
  });

  it.each([
    // THE FINDING: `resources` is inventory's subcommand, not the command.
    { argv: 'inventory resources --verbose', group: 'resources' },
    // THE FINDING, worse shape: `rag` is a directory the user asked to scan.
    { argv: 'resources scan rag --verbose', group: 'rag' },
    // ...and the same line must not be read as the RESOURCES page either: it
    // names a real subcommand, so commander has an actual command to run.
    { argv: 'resources scan rag --verbose', group: 'resources' },
    // An option's VALUE is not a command name.
    { argv: '--cwd resources --verbose', group: 'resources' },
    // The group is there and IS the command, but nobody asked for verbose help.
    { argv: 'resources --help', group: 'resources' },
    { argv: 'resources validate --verbose', group: 'resources' },
    // A different group entirely.
    { argv: 'rag --verbose', group: 'resources' },
  ])('refuses $argv for $group', ({ argv, group }) => {
    expect(rootGrammar().wantsGroupVerboseHelp(line(argv), group)).toBe(false);
  });
});

describe('wantsRootVerboseHelp', () => {
  it.each(['--help --verbose', '-h --verbose', '--verbose --help'])('accepts %s', (argv) => {
    expect(rootGrammar().wantsRootVerboseHelp(line(argv))).toBe(true);
  });

  it.each([
    // `docs` is --cwd's value, not a command: this IS the bare root help page.
    { argv: '--cwd docs --help --verbose', expected: true },
    // A command was named, so its own page is the one being asked for.
    { argv: 'audit --help --verbose', expected: false },
    { argv: '--help', expected: false },
    { argv: '--verbose', expected: false },
  ])('reads $argv as $expected', ({ argv, expected }) => {
    expect(rootGrammar().wantsRootVerboseHelp(line(argv))).toBe(expected);
  });
});
