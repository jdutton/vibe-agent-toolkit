/**
 * CLI compile command implementation
 */

import type { Command } from 'commander';

import { compileMarkdownResources } from '../compiler/markdown-compiler.js';

import { addCompileOptions, printCompilationSummary, exitWithResults } from './compile-utils.js';

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

        exitWithResults(results);
      } catch (error) {
        console.error('Compilation error:', error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
}
