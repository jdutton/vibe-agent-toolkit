/**
 * CLI compile command implementation
 */

import type { Command } from 'commander';

import { compileMarkdownResources } from '../compiler/markdown-compiler.js';

import { addCompileOptions, printCompilationSummary } from './compile-utils.js';

/**
 * Register the compile command with Commander
 *
 * @param program - Commander program instance
 */
export function registerCompileCommand(program: Command): void {
  addCompileOptions(
    program
      .command('compile')
      .description('Compile markdown resources to JavaScript and TypeScript'),
  ).action(async (input: string, output: string, options: { pattern: string; verbose: boolean }) => {
      try {
        const results = await compileMarkdownResources({
          inputDir: input,
          outputDir: output,
          pattern: options.pattern,
          verbose: options.verbose,
        });

        // Summary
        console.log('');
        console.log('Compilation complete:');
        printCompilationSummary(results);

        // Exit with error if any failures
        const failureCount = results.filter((r) => !r.success).length;
        if (failureCount > 0) {
          process.exit(1);
        }

        process.exit(0);
      } catch (error) {
        console.error('Compilation error:', error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
}
