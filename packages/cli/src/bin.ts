#!/usr/bin/env node

/**
 * Main entry point for vat CLI
 * Uses Commander.js for command structure
 */


import { safePath } from '@vibe-agent-toolkit/utils';
import { describeStdioBlocking, makeStdioBlocking } from '@vibe-agent-toolkit/utils/process';
import { Command, CommanderError } from 'commander';

import { COMMAND_LOADERS } from './command-loaders.js';
import { registerCacheControl } from './commands/cache/cache-control.js';
import { exitCodeForCommanderEnding } from './utils/command-error.js';
import { loadVerboseHelp, writeHelpSync } from './utils/help-loader.js';
import { createLogger } from './utils/logger.js';
import { createRootArgvGrammar } from './utils/root-argv.js';
import { version, getVersionString, type VersionContext } from './version.js';

// Before ANY output: a piped stdio is non-blocking, and every command here exits
// the moment it finishes, so unflushed bytes would be discarded. See output.ts.
const stdioBlocking = makeStdioBlocking();

// Reported by hand rather than through the parsed `--debug` option because this
// has to run before Commander parses anything — the same reason the verbose-help
// checks below read process.argv directly. Reaching through an internal Node
// handle can fail silently, and a truncated report with no explanation is the
// exact failure this reporting exists to make diagnosable.
if (process.argv.includes('--debug')) {
  process.stderr.write(`[DEBUG] ${describeStdioBlocking(stdioBlocking)}\n`);
}

const program = new Command();

// Context detection from environment
const context: VersionContext | null = process.env['VAT_CONTEXT']
  ? ({
      type: process.env['VAT_CONTEXT'] as 'dev' | 'local' | 'global',
      path: process.env['VAT_CONTEXT_PATH'],
    } as VersionContext)
  : null;

program
  .name('vat')
  .description('Agent-friendly toolkit for building, testing, and deploying portable AI agents')
  // `import.meta.filename`, NOT process.argv[1] and NOT anything cwd-derived:
  // this is the file Node actually loaded (symlinks already resolved), so it
  // identifies the running build even when the wrapper's cwd-derived context
  // resolves to a bare 'global'. See getVersionString for the incident.
  // Long form ONLY. A short `-v` here is registered on the ROOT program, and
  // Commander resolves root options before the subcommand's own — so it silently
  // shadowed the `-v, --verbose` that validate/verify/build/skills-build each
  // advertise in their own --help. `vat validate -v` printed the version and
  // exited 0 without validating, making a CI step spelled that way a
  // permanently-green gate that ran nothing. Do not re-add the short flag.
  .version(getVersionString(version, context, import.meta.filename), '--version', 'Output version number')
  .option('--cwd <dir>', 'Change working directory before running any command')
  .option('--debug', 'Enable debug logging')
  .helpCommand(false) // Disable redundant 'help' command, use --help instead
  // `--debug` is declared BOTH here and, separately, on 47 subcommands. Commander
  // resolves the root's definition first (the same precedence documented for the
  // `-v` incident above), so the subcommand's own `--debug` was never populated:
  // every action received `options.debug === undefined` no matter where the flag
  // sat on the line, and every `logger.debug(...)` in the CLI — 59 read sites —
  // was unreachable through its own documented flag. Measured, not inferred: with
  // the root declaration removed the subcommand's option populates normally.
  //
  // Copying the root's value down at dispatch fixes all of them at once, and
  // leaves a subcommand that sets `--debug` on its own (no root flag) untouched.
  .hook('preAction', (thisCommand, actionCommand) => {
    if (thisCommand.opts()['debug'] === true) {
      actionCommand.setOptionValue('debug', true);
    }
  })
  .showHelpAfterError()
  .configureOutput({
    writeOut: (str) => process.stdout.write(str), // Help goes to stdout (pipeable)
    writeErr: (str) => process.stderr.write(str), // Errors go to stderr
  })
  .addHelpText(
    'after',
    `
Example:
  $ vat resources validate docs/       # Validate markdown links (run before commit)
  $ vat --cwd packages/my-agents build # Build from a subdirectory

Environment:
  VAT_DEBUG=1                          # Show context detection details
  VAT_CACHE=0                          # Disable disk caches (same as --no-cache)

For command details: vat resources --help
For comprehensive help: vat --help --verbose
`
  );

// Root `--no-cache`, plus the preAction hook that exports it as VAT_CACHE=0 so
// it survives into the child processes that actually parse. See
// commands/cache/index.ts for why an env var and not a plumbed flag, and for
// what this does about the identically-named flag on `vat resources validate`.
registerCacheControl(program);

// Change working directory before any subcommand runs (if --cwd flag provided)
program.hook('preAction', () => {
  const { cwd } = program.opts<{ cwd?: string }>();
  if (cwd) {
    // Resolve relative to original cwd BEFORE chdir
    process.chdir(safePath.resolve(cwd));
  }
});

/**
 * The argv this program was given, and the grammar every pre-parse decision
 * below reads it through.
 *
 * ⚠️ Built HERE, and not earlier: `createRootArgvGrammar` reads
 * `program.options`, which only holds `--no-cache` after
 * `registerCacheControl(program)` above. See that function for what a
 * prematurely-built grammar silently costs.
 */
const argv = process.argv.slice(2);
const rootArgv = createRootArgvGrammar(program.options);

// `--verbose` is not a commander option anywhere — it selects a hand-written
// help page — so these four checks run before parsing.
if (rootArgv.wantsRootVerboseHelp(argv)) {
  showVerboseHelp();
  process.exit(0);
}

/**
 * The command groups whose `--verbose` help page is a hand-written document.
 *
 * A table rather than three near-identical blocks: they diverged once already
 * (see `wantsGroupVerboseHelp`), and the loader stays inside the arrow so the
 * group's module is imported only when that group is the one being asked about.
 */
const VERBOSE_HELP_GROUPS: readonly { readonly group: string; readonly show: () => Promise<void> }[] = [
  {
    group: 'resources',
    show: async () => (await import('./commands/resources/index.js')).showResourcesVerboseHelp(),
  },
  {
    group: 'rag',
    show: async () => (await import('./commands/rag/index.js')).showRagVerboseHelp(),
  },
  {
    group: 'agent',
    show: async () => (await import('./commands/agent/index.js')).showAgentVerboseHelp(),
  },
];

for (const { group, show } of VERBOSE_HELP_GROUPS) {
  if (rootArgv.wantsGroupVerboseHelp(argv, group)) {
    await show();
    process.exit(0);
  }
}

/** Registers `doctor`, which attaches itself to the program rather than being added. */
const loadDoctor = async (): Promise<void> =>
  (await import('./commands/doctor.js')).doctorCommand(program);

const requestedCommand = rootArgv.requestedCommand(argv);

/**
 * Whether this invocation is answerable without any command module.
 *
 * Only `--version` is: commander prints the version itself. A bare `vat` and
 * every unknown command render help, which must list the whole tree.
 *
 * `-V` is deliberately NOT here. The short flag is unregistered on purpose (see
 * the `-v` incident above `.version()`), so commander errors on it and
 * `showHelpAfterError()` renders help — which, from a program with zero
 * commands loaded, had no `Commands:` section at all and told the user the tool
 * has no subcommands.
 */
const versionOnly =
  requestedCommand === undefined
  && argv.length > 0
  && argv.every(arg => arg === '--version');

if (requestedCommand === 'doctor') {
  await loadDoctor();
} else if (requestedCommand !== undefined && Object.hasOwn(COMMAND_LOADERS, requestedCommand)) {
  const load = COMMAND_LOADERS[requestedCommand];
  /* c8 ignore next -- the hasOwn check above already proved the key is present */
  if (load) program.addCommand(await load());
} else if (!versionOnly) {
  // Help, a bare `vat`, or an unknown command: the whole tree has to exist so
  // `--help` lists it and `command:*` can report what was not recognised.
  for (const load of Object.values(COMMAND_LOADERS)) program.addCommand(await load());
  await loadDoctor();
}

// Handle unknown commands
program.on('command:*', (operands) => {
  const logger = createLogger();
  logger.error(`error: unknown command '${String(operands[0] ?? 'unknown')}'`);
  logger.error('');
  program.help({ error: true });
});

/**
 * Route EVERY command's usage errors through VAT's exit-code contract.
 *
 * 🪤 **`exitOverride()` on the root alone reaches nothing.** Commander's
 * `_exit` reads `this._exitCallback` off the command that actually errored and
 * never walks up to a parent, and `addCommand()` — how every command here is
 * registered — does NOT copy inherited settings (only the `.command()` factory
 * does, at command.js:164). So the override has to be applied to each node.
 *
 * This must run AFTER the lazy dispatcher above has added whichever commands
 * this invocation needs, and after `loadDoctor()`, or it walks a tree that is
 * still empty and the very commands being invoked keep commander's default.
 *
 * @param command - The command whose subtree gets the override
 */
function overrideExitAcrossTree(command: Command): void {
  command.exitOverride();
  for (const sub of command.commands) overrideExitAcrossTree(sub);
}
overrideExitAcrossTree(program);

try {
  program.parse();
} catch (error) {
  // Only commander's own terminations land here. `parse()` is synchronous and
  // every action handler is async, so an action's failure is a floating
  // rejection and never reaches this catch — which is why rethrowing anything
  // else is the correct move rather than a swallow.
  if (!(error instanceof CommanderError)) throw error;
  process.exit(exitCodeForCommanderEnding(error.exitCode));
}

function showVerboseHelp(): void {
  writeHelpSync(loadVerboseHelp()); // Loads from packages/cli/docs/index.md
}
