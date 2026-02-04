/**
 * Shared utilities for CLI commands
 */

import type { Command } from 'commander';

import type { CompileResult } from '../compiler/types.js';

/**
 * Generic result type for CLI operations
 */
interface OperationResult {
  sourcePath: string;
  success: boolean;
  error?: string;
}

/**
 * Print operation summary (generic)
 *
 * @param results - Operation results
 * @param operationName - Name of the operation (e.g., "Recompiled", "Generated")
 */
export function printOperationSummary(results: OperationResult[], operationName: string): void {
  const successCount = results.filter((r) => r.success).length;
  const failureCount = results.filter((r) => !r.success).length;

  console.log(`  ${operationName}: ${successCount} succeeded, ${failureCount} failed`);

  if (failureCount > 0) {
    const failures = results.filter((r) => !r.success);
    for (const failure of failures) {
      console.error(`  Error: ${failure.sourcePath}: ${failure.error ?? 'Unknown error'}`);
    }
  }
}

/**
 * Print compilation summary
 *
 * @param results - Compilation results
 */
export function printCompilationSummary(results: CompileResult[]): void {
  printOperationSummary(results, 'Recompiled');
}

/**
 * Exit with appropriate code based on results
 *
 * @param results - Operation results
 */
export function exitWithResults(results: OperationResult[]): never {
  const failureCount = results.filter((r) => !r.success).length;
  process.exit(failureCount > 0 ? 1 : 0);
}

/**
 * Add common compile/watch options to a command
 *
 * @param command - Commander command instance
 * @returns Command with options added
 */
export function addCompileOptions(command: Command): Command {
  return command
    .argument('<input>', 'Input directory containing markdown files')
    .argument('<output>', 'Output directory for compiled files')
    .option('-p, --pattern <pattern>', 'Glob pattern for markdown files', '**/*.md')
    .option('-v, --verbose', 'Enable verbose logging', false);
}
