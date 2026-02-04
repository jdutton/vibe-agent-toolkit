/**
 * CLI watch command implementation
 */

import { watch } from 'chokidar';
import type { Command } from 'commander';

import { compileMarkdownResources } from '../compiler/markdown-compiler.js';

import { addCompileOptions, printCompilationSummary } from './compile-utils.js';

/**
 * Register the watch command with Commander
 *
 * @param program - Commander program instance
 */
export function registerWatchCommand(program: Command): void {
  addCompileOptions(
    program
      .command('watch')
      .description('Watch markdown files and recompile on changes'),
  ).action(async (input: string, output: string, options: { pattern: string; verbose: boolean }) => {
      console.log(`Watching ${input} for changes...`);
      console.log(`Pattern: ${options.pattern}`);
      console.log(`Output: ${output}`);
      console.log('');

      // Initial compilation
      try {
        const results = await compileMarkdownResources({
          inputDir: input,
          outputDir: output,
          pattern: options.pattern,
          verbose: options.verbose,
        });

        const successCount = results.filter((r) => r.success).length;
        const failureCount = results.filter((r) => !r.success).length;

        console.log(`Initial compilation: ${successCount} succeeded, ${failureCount} failed`);
        console.log('');
      } catch (error) {
        console.error('Initial compilation error:', error instanceof Error ? error.message : String(error));
      }

      // Set up file watcher
      const watcher = watch(options.pattern, {
        cwd: input,
        persistent: true,
        ignoreInitial: true,
      });

      watcher.on('add', (path) => {
        console.log(`[${new Date().toLocaleTimeString()}] File added: ${path}`);
        void recompileAll(input, output, options.pattern, options.verbose);
      });

      watcher.on('change', (path) => {
        console.log(`[${new Date().toLocaleTimeString()}] File changed: ${path}`);
        void recompileAll(input, output, options.pattern, options.verbose);
      });

      watcher.on('unlink', (path) => {
        console.log(`[${new Date().toLocaleTimeString()}] File removed: ${path}`);
        void recompileAll(input, output, options.pattern, options.verbose);
      });

      watcher.on('error', (error) => {
        console.error('Watcher error:', error);
      });

      // Keep process alive
      process.on('SIGINT', () => {
        console.log('');
        console.log('Stopping file watcher...');
        void watcher.close();
        process.exit(0);
      });
    });
}

/**
 * Recompile all matching files
 */
async function recompileAll(
  input: string,
  output: string,
  pattern: string,
  verbose: boolean,
): Promise<void> {
  try {
    const results = await compileMarkdownResources({
      inputDir: input,
      outputDir: output,
      pattern,
      verbose,
    });

    printCompilationSummary(results);
  } catch (error) {
    console.error('Recompilation error:', error instanceof Error ? error.message : String(error));
  }
}
