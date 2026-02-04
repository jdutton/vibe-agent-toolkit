/**
 * CLI entry point for resource compiler
 */

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
  const program = createCLIProgram();
  await program.parseAsync(argv);
}
