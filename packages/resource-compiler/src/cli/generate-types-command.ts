/**
 * CLI generate-types command implementation
 */

/* eslint-disable security/detect-non-literal-fs-filename -- CLI tool with user-provided paths */

import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';

import type { Command } from 'commander';
import { glob } from 'glob';

import { parseMarkdown } from '../compiler/markdown-parser.js';
import { generateMarkdownDeclarationFile, getDeclarationPath } from '../transformer/declaration-generator.js';

import { exitWithResults, printOperationSummary } from './compile-utils.js';

/**
 * Result of generating a single declaration file
 */
interface GenerateTypeResult {
  /** Path to the source markdown file */
  sourcePath: string;
  /** Path to the generated .md.d.ts file */
  declarationPath: string;
  /** Whether generation succeeded */
  success: boolean;
  /** Error message if generation failed */
  error?: string;
}

/**
 * Process a single markdown file and generate its declaration
 *
 * @param filePath - Path to markdown file
 * @param inputDir - Base input directory
 * @param verbose - Enable verbose logging
 * @returns Generation result
 */
function processMarkdownFile(
  filePath: string,
  inputDir: string,
  verbose: boolean,
): GenerateTypeResult {
  try {
    if (verbose) {
      const relativePath = relative(inputDir, filePath);
      console.log(`Processing: ${relativePath}`);
    }

    // Read and parse markdown
    const content = readFileSync(filePath, 'utf-8');
    const resource = parseMarkdown(content);

    // Generate declaration
    const declaration = generateMarkdownDeclarationFile(filePath, resource);
    const declarationPath = getDeclarationPath(filePath);

    // Write declaration file
    writeFileSync(declarationPath, declaration, 'utf-8');

    if (verbose) {
      const relativeDeclarationPath = relative(inputDir, declarationPath);
      console.log(`  Generated: ${relativeDeclarationPath}`);
    }

    return {
      sourcePath: filePath,
      declarationPath,
      success: true,
    };
  } catch (error) {
    if (verbose) {
      console.error(`  Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      sourcePath: filePath,
      declarationPath: getDeclarationPath(filePath),
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Generate .md.d.ts files for all markdown files in a directory
 *
 * @param inputDir - Directory to search for markdown files
 * @param pattern - Glob pattern for matching markdown files
 * @param verbose - Enable verbose logging
 * @returns Array of generation results
 */
async function generateTypes(
  inputDir: string,
  pattern: string,
  verbose: boolean,
): Promise<GenerateTypeResult[]> {
  // Find all markdown files
  const files = await glob(pattern, {
    cwd: inputDir,
    absolute: true,
    nodir: true,
  });

  if (verbose) {
    console.log(`Found ${files.length} markdown files`);
  }

  // Process each file
  return files.map((filePath) => processMarkdownFile(filePath, inputDir, verbose));
}


/**
 * Register the generate-types command with Commander
 *
 * @param program - Commander program instance
 */
export function registerGenerateTypesCommand(program: Command): void {
  program
    .command('generate-types')
    .description('Generate .md.d.ts declaration files for markdown resources')
    .argument('<input>', 'Input directory containing markdown files')
    .option('-p, --pattern <pattern>', 'Glob pattern for markdown files', '**/*.md')
    .option('-v, --verbose', 'Enable verbose logging', false)
    .action(async (input: string, options: { pattern: string; verbose: boolean }) => {
      try {
        if (options.verbose) {
          console.log(`Generating type declarations for markdown files in: ${input}`);
          console.log(`Pattern: ${options.pattern}`);
        }

        const results = await generateTypes(input, options.pattern, options.verbose);

        // Summary
        console.log('');
        console.log('Type generation complete:');
        printOperationSummary(results, 'Generated');

        exitWithResults(results);
      } catch (error) {
        console.error('Type generation error:', error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
}
