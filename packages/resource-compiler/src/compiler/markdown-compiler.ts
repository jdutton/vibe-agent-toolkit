/**
 * Markdown compiler orchestrator - coordinates the compilation pipeline
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { mkdirSyncReal, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { glob } from 'glob';

import { generateTypeScriptDeclarations } from './dts-generator.js';
import { generateJavaScript } from './javascript-generator.js';
import { parseMarkdown } from './markdown-parser.js';
import type { CompileOptions, CompileResult } from './types.js';

/**
 * Compile markdown resources to JavaScript and TypeScript declarations
 *
 * @param options - Compilation options
 * @returns Array of compilation results for each file
 *
 * @example
 * ```typescript
 * const results = await compileMarkdownResources({
 *   inputDir: './resources',
 *   outputDir: './dist/resources',
 *   pattern: '**\/*.md',
 *   verbose: true,
 * });
 *
 * for (const result of results) {
 *   if (result.success) {
 *     console.log(`✓ Compiled ${result.sourcePath}`);
 *   } else {
 *     console.error(`✗ Failed ${result.sourcePath}: ${result.error}`);
 *   }
 * }
 * ```
 */
export async function compileMarkdownResources(
  options: CompileOptions,
): Promise<CompileResult[]> {
  const { inputDir, outputDir, pattern = '**/*.md', verbose = false } = options;

  if (verbose) {
    console.log(`Compiling markdown resources from ${inputDir}`);
    console.log(`Pattern: ${pattern}`);
    console.log(`Output: ${outputDir}`);
  }

  // Find all markdown files matching pattern
  const files = await glob(pattern, {
    cwd: inputDir,
    absolute: false,
    nodir: true,
  });

  if (verbose) {
    console.log(`Found ${files.length} markdown files`);
  }

  const results: CompileResult[] = [];

  for (const file of files) {
    const result = await compileSingleFile(file, inputDir, outputDir, verbose);
    results.push(result);
  }

  return results;
}

/**
 * Compile a single markdown file
 *
 * @param relativeFilePath - Path relative to inputDir
 * @param inputDir - Input directory
 * @param outputDir - Output directory
 * @param verbose - Enable verbose logging
 * @returns Compilation result
 */
async function compileSingleFile(
  relativeFilePath: string,
  inputDir: string,
  outputDir: string,
  verbose: boolean,
): Promise<CompileResult> {
  const sourcePath = join(inputDir, relativeFilePath);

  try {
    // Read markdown file
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Controlled input from glob
    const markdownContent = readFileSync(sourcePath, 'utf-8');

    if (verbose) {
      console.log(`  Processing ${relativeFilePath}...`);
    }

    // Parse markdown
    const resource = parseMarkdown(markdownContent);

    // Generate JavaScript code
    const jsCode = generateJavaScript(resource);

    // Generate TypeScript declarations
    const dtsCode = generateTypeScriptDeclarations(resource);

    // Calculate output paths (maintain directory structure)
    const fileBaseName = relativeFilePath.replace(/\.md$/i, '');

    const jsRelativePath = `${fileBaseName}.js`;
    const dtsRelativePath = `${fileBaseName}.d.ts`;

    const jsPath = join(outputDir, jsRelativePath);
    const dtsPath = join(outputDir, dtsRelativePath);

    // Ensure output directories exist
    const jsDir = dirname(jsPath);
    const dtsDir = dirname(dtsPath);

    mkdirSyncReal(jsDir, { recursive: true });
    if (jsDir !== dtsDir) {
      mkdirSyncReal(dtsDir, { recursive: true });
    }

    // Write output files
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Controlled output path
    writeFileSync(jsPath, jsCode, 'utf-8');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Controlled output path
    writeFileSync(dtsPath, dtsCode, 'utf-8');

    if (verbose) {
      console.log(`    ✓ ${toForwardSlash(jsRelativePath)}`);
      console.log(`    ✓ ${toForwardSlash(dtsRelativePath)}`);
    }

    return {
      sourcePath,
      jsPath,
      dtsPath,
      success: true,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (verbose) {
      console.error(`    ✗ Failed to compile ${relativeFilePath}: ${errorMessage}`);
    }

    return {
      sourcePath,
      jsPath: '',
      dtsPath: '',
      success: false,
      error: errorMessage,
    };
  }
}
