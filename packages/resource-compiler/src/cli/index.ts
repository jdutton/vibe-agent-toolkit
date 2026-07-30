/**
 * CLI entry point for resource compiler
 */

import { describeStdioBlocking, makeStdioBlocking } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { registerCompileCommand } from './compile-command.js';
import { registerGenerateTypesCommand } from './generate-types-command.js';
import { registerWatchCommand } from './watch-command.js';

/**
 * Create and configure the CLI program
 *
 * @returns Configured Commander program
 */
export function createCLIProgram(): Command {
  const program = new Command();

  program
    .name('vat-compile-resources')
    .description('Compile markdown resources to TypeScript with full IDE support')
    .version('0.2.0');

  // Register commands
  registerCompileCommand(program);
  registerWatchCommand(program);
  registerGenerateTypesCommand(program);

  return program;
}

/**
 * Run the CLI with provided arguments
 *
 * @param argv - Command-line arguments (defaults to process.argv)
 */
export async function runCLI(argv?: string[]): Promise<void> {
  // Before ANY output. Node makes a PIPE's stdio non-blocking, so `console.log`
  // is buffered and asynchronous, and every path through this CLI ends in an
  // immediate `process.exit()` (`exitWithResults`, and the two error handlers in
  // the compile/generate-types commands) which does not drain those buffers —
  // everything past the first pipe buffer was silently discarded with exit code
  // 0. This is the same mechanism, and the same helper, the main `vat` CLI's
  // entry points use; see `@vibe-agent-toolkit/cli`'s `utils/output.ts`.
  const stdioBlocking = makeStdioBlocking();

  // Reaching through an internal Node handle can fail quietly — Windows named
  // pipes do not present the POSIX shape — and a silent failure reverts this bin
  // to truncating with nothing to distinguish it from a working run. Read from
  // the environment rather than a parsed flag because this has to happen before
  // Commander sees the arguments, and this CLI declares no global `--debug`.
  if (process.env['VAT_DEBUG'] === '1') {
    console.error(`[vat debug] ${describeStdioBlocking(stdioBlocking)}`);
  }

  const program = createCLIProgram();
  await program.parseAsync(argv);
}
