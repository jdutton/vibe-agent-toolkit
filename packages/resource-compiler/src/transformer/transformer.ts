/**
 * TypeScript transformer for markdown imports
 * Converts: import * as X from './foo.md' → const X = { meta, text, fragments }
 */

/* eslint-disable sonarjs/no-nested-functions -- TypeScript transformer factory pattern requires 4 levels of nesting */

import ts from 'typescript';

import { findMarkdownImports } from './import-detector.js';
import { generateModuleReplacement, replaceImportWithConst } from './module-generator.js';
import { resolveMarkdownPath, createDefaultCompilerOptions } from './path-resolver.js';

/**
 * Options for the markdown import transformer
 */
export interface TransformerOptions {
  /** TypeScript compiler options for module resolution */
  compilerOptions?: ts.CompilerOptions;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Create a TypeScript transformer that converts markdown imports to const declarations
 *
 * @param program - The TypeScript program (optional, for better module resolution)
 * @param options - Transformer options
 * @returns Transformer factory function
 *
 * @example
 * ```typescript
 * // Use with ts-patch in tsconfig.json:
 * {
 *   "compilerOptions": {
 *     "plugins": [
 *       {
 *         "transform": "@vibe-agent-toolkit/resource-compiler/transformer",
 *         "afterDeclarations": true
 *       }
 *     ]
 *   }
 * }
 * ```
 */
export function createTransformer(
  _program?: ts.Program,
  options?: TransformerOptions,
): ts.TransformerFactory<ts.SourceFile> {
  const compilerOptions = options?.compilerOptions ?? createDefaultCompilerOptions();
  const verbose = options?.verbose ?? false;

  return (context: ts.TransformationContext) => {
    return (sourceFile: ts.SourceFile) => {
      // Find all markdown imports in the file
      const markdownImports = findMarkdownImports(sourceFile);

      if (markdownImports.length === 0) {
        // No markdown imports, return unchanged
        return sourceFile;
      }

      if (verbose) {
        console.log(
          `[markdown-transformer] Found ${markdownImports.length} markdown import(s) in ${sourceFile.fileName}`,
        );
      }

      // Create a visitor to transform the AST
      const visitor = (node: ts.Node): ts.Node => {
        // Check if this is an import declaration
        if (ts.isImportDeclaration(node)) {
          // Check if it's one of our markdown imports
          const importInfo = markdownImports.find((info) => info.node === node);

          if (importInfo) {
            // Resolve the markdown file path
            const resolvedPath = resolveMarkdownPath(
              importInfo.modulePath,
              sourceFile.fileName,
              compilerOptions,
            );

            if (!resolvedPath) {
              // File not found - log error and preserve original import
              if (verbose) {
                console.error(
                  `[markdown-transformer] Error: Cannot find markdown file: ${importInfo.modulePath}`,
                );
              }

              // Return the original node (transformation failed)
              return node;
            }

            if (verbose) {
              console.log(
                `[markdown-transformer] Transforming: ${importInfo.modulePath} → ${resolvedPath}`,
              );
            }

            // Generate the replacement const declaration
            const replacement = generateModuleReplacement(importInfo, resolvedPath);
            return replaceImportWithConst(node, replacement);
          }
        }

        // Visit children
        return ts.visitEachChild(node, visitor, context);
      };

      // Transform the source file
      return ts.visitNode(sourceFile, visitor) as ts.SourceFile;
    };
  };
}

/**
 * Default transformer export for ts-patch
 * Can be used directly in tsconfig.json plugins
 *
 * @param program - The TypeScript program
 * @returns Transformer factory
 */
export default function (program: ts.Program): ts.TransformerFactory<ts.SourceFile> {
  return createTransformer(program);
}
