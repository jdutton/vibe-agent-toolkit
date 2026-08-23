#!/usr/bin/env node

/**
 * Main entry point for vat CLI
 * Uses Commander.js for command structure
 */


import { describeStdioBlocking, makeStdioBlocking, safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { registerCacheControl } from './commands/cache/cache-control.js';
import { loadVerboseHelp, writeHelpSync } from './utils/help-loader.js';
import { createLogger } from './utils/logger.js';
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

// Handle --help --verbose at root level before parsing
// Manually check process.argv since --verbose is not a root-level option
const hasHelp = process.argv.includes('--help') || process.argv.includes('-h');
const hasVerbose = process.argv.includes('--verbose');
const hasSubcommand = process.argv.slice(2).some(arg => !arg.startsWith('-'));

if (hasHelp && hasVerbose && !hasSubcommand) {
  // Root level: vat --help --verbose
  showVerboseHelp();
  process.exit(0);
}

// Special handling for "resources --verbose" before parsing
if (process.argv.includes('resources') && process.argv.includes('--verbose')) {
  const argv = process.argv.slice(2);
  const resourcesIndex = argv.indexOf('resources');
  // Check if there's no subcommand after 'resources'
  const afterResources = argv.slice(resourcesIndex + 1);
  const hasSubcommand = afterResources.some(arg => !arg.startsWith('-'));

  if (!hasSubcommand) {
    (await import('./commands/resources/index.js')).showResourcesVerboseHelp();
    process.exit(0);
  }
}

// Special handling for "rag --verbose" before parsing
if (process.argv.includes('rag') && process.argv.includes('--verbose')) {
  const argv = process.argv.slice(2);
  const ragIndex = argv.indexOf('rag');
  // Check if there's no subcommand after 'rag'
  const afterRag = argv.slice(ragIndex + 1);
  const hasSubcommand = afterRag.some(arg => !arg.startsWith('-'));

  if (!hasSubcommand) {
    (await import('./commands/rag/index.js')).showRagVerboseHelp();
    process.exit(0);
  }
}

// Special handling for "agent --verbose" before parsing
if (process.argv.includes('agent') && process.argv.includes('--verbose')) {
  const argv = process.argv.slice(2);
  const agentIndex = argv.indexOf('agent');
  // Check if there's no subcommand after 'agent'
  const afterAgent = argv.slice(agentIndex + 1);
  const hasSubcommand = afterAgent.some(arg => !arg.startsWith('-'));

  if (!hasSubcommand) {
    (await import('./commands/agent/index.js')).showAgentVerboseHelp();
    process.exit(0);
  }
}

/**
 * Every top-level command, behind a loader.
 *
 * The factories are NOT called at module scope. Each one transitively pulls
 * `@vibe-agent-toolkit/resources` (~1.6s of module load on Windows, dominated
 * by the markdown toolchain), so importing all fifteen made every invocation
 * — `vat --version` included — pay for the whole CLI surface. Registration
 * order here is the order they appear in `--help`; audit is common, so first.
 */
const COMMAND_LOADERS: Record<string, () => Promise<Command>> = {
  audit: async () => (await import('./commands/audit.js')).createAuditCommand(),
  corpus: async () => (await import('./commands/corpus/index.js')).createCorpusCommand(),
  inventory: async () => (await import('./commands/inventory.js')).createInventoryCommand(),
  resources: async () => (await import('./commands/resources/index.js')).createResourcesCommand(),
  rag: async () => (await import('./commands/rag/index.js')).createRagCommand(),
  agent: async () => (await import('./commands/agent/index.js')).createAgentCommand(),
  mcp: async () => (await import('./commands/mcp/index.js')).createMCPCommand(),
  skills: async () => (await import('./commands/skills/index.js')).createSkillsCommand(),
  skill: async () => (await import('./commands/skill/index.js')).createSkillCommand(),
  claude: async () => (await import('./commands/claude/index.js')).createClaudeCommand(),
  cache: async () => (await import('./commands/cache/index.js')).createCacheCommand(),
  build: async () => (await import('./commands/build.js')).createBuildTopLevelCommand(),
  validate: async () => (await import('./commands/validate.js')).createValidateTopLevelCommand(),
  verify: async () => (await import('./commands/verify.js')).createVerifyTopLevelCommand(),
};

/** Registers `doctor`, which attaches itself to the program rather than being added. */
const loadDoctor = async (): Promise<void> =>
  (await import('./commands/doctor.js')).doctorCommand(program);

/**
 * The command the user actually asked for, or `undefined`.
 *
 * The first non-flag argument — `undefined` for `vat` and `vat --version`, and
 * an unrecognised name when the user typed something we do not have.
 */
const requestedCommand = process.argv.slice(2).find(arg => !arg.startsWith('-'));

/**
 * Whether this invocation is answerable without any command module.
 *
 * Only `--version`/`-V` is: commander prints the version itself. A bare `vat`
 * and every unknown command render help, which must list the whole tree.
 */
const versionOnly =
  requestedCommand === undefined
  && process.argv.length > 2
  && process.argv.slice(2).every(arg => arg === '--version' || arg === '-V');

if (requestedCommand === 'doctor') {
  await loadDoctor();
} else if (requestedCommand !== undefined && requestedCommand in COMMAND_LOADERS) {
  const load = COMMAND_LOADERS[requestedCommand];
  /* c8 ignore next -- the `in` check above already proved the key is present */
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

program.parse();

function showVerboseHelp(): void {
  writeHelpSync(loadVerboseHelp()); // Loads from packages/cli/docs/index.md
}
