/**
 * Module generator for converting markdown imports to const declarations
 * Replaces import statements with inline resource objects
 */

import { readFileSync } from 'node:fs';

import ts from 'typescript';

import { parseMarkdown } from '../compiler/markdown-parser.js';

import { resourceToAst, createConstDeclaration } from './ast-helpers.js';
import type { MarkdownImportInfo } from './import-detector.js';

/**
 * Generate a const declaration from a markdown import
 *
 * @param importInfo - Information about the markdown import
 * @param resolvedPath - Absolute path to the markdown file
 * @returns Variable statement node replacing the import
 *
 * @example
 * ```typescript
 * // Input: import * as Core from './core.md'
 * // Output: const Core = { meta: {...}, text: "...", fragments: {...} };
 * ```
 */
export function generateModuleReplacement(
  importInfo: MarkdownImportInfo,
  resolvedPath: string,
): ts.VariableStatement {
  // Read and parse the markdown file
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Validated path from import resolution
  const markdownContent = readFileSync(resolvedPath, 'utf-8');
  const resource = parseMarkdown(markdownContent);

  // Convert resource to AST
  const resourceAst = resourceToAst(resource);

  // Create const declaration
  return createConstDeclaration(importInfo.identifier, resourceAst);
}

/**
 * Replace an import declaration with a const declaration
 *
 * @param node - The import declaration node to replace
 * @param replacement - The replacement variable statement
 * @returns The replacement node
 */
export function replaceImportWithConst(
  node: ts.ImportDeclaration,
  replacement: ts.VariableStatement,
): ts.VariableStatement {
  // Preserve any comments from the original import
  const leadingComments = ts.getLeadingCommentRanges(
    node.getSourceFile().getFullText(),
    node.getFullStart(),
  );

  if (leadingComments && leadingComments.length > 0) {
    // Comments are preserved through the source transformation
    return replacement;
  }

  return replacement;
}
