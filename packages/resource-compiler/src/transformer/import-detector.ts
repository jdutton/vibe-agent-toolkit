/**
 * Import detection utilities for TypeScript AST
 * Detects .md imports and extracts import information
 */

import ts from 'typescript';

/**
 * Information about a detected .md import
 */
export interface MarkdownImportInfo {
  /** The import declaration node */
  node: ts.ImportDeclaration;
  /** The identifier name (e.g., "Core" in "import * as Core") */
  identifier: string;
  /** The module specifier path (e.g., "./prompts/core.md") */
  modulePath: string;
  /** The type of import (namespace, named, or default) */
  importType: 'namespace' | 'named' | 'default';
}

/**
 * Check if an import declaration imports a .md file
 *
 * @param node - The import declaration to check
 * @returns True if it imports a .md file
 *
 * @example
 * ```typescript
 * import * as Core from './core.md';  // true
 * import { foo } from './bar.ts';     // false
 * ```
 */
export function isMarkdownImport(node: ts.ImportDeclaration): boolean {
  const moduleSpecifier = node.moduleSpecifier;

  if (!ts.isStringLiteral(moduleSpecifier)) {
    return false;
  }

  const modulePath = moduleSpecifier.text;
  return modulePath.endsWith('.md');
}

/**
 * Extract import information from a markdown import declaration
 *
 * @param node - The import declaration node
 * @returns Import information or null if invalid
 *
 * @example
 * ```typescript
 * // import * as Core from './core.md'
 * extractImportInfo(node) // { identifier: 'Core', modulePath: './core.md', ... }
 *
 * // import Core from './core.md'
 * extractImportInfo(node) // { identifier: 'Core', modulePath: './core.md', importType: 'default' }
 * ```
 */
export function extractImportInfo(node: ts.ImportDeclaration): MarkdownImportInfo | null {
  if (!isMarkdownImport(node)) {
    return null;
  }

  const moduleSpecifier = node.moduleSpecifier as ts.StringLiteral;
  const modulePath = moduleSpecifier.text;

  const importClause = node.importClause;
  if (!importClause) {
    return null;
  }

  // Handle namespace import: import * as Core from './core.md'
  if (importClause.namedBindings && ts.isNamespaceImport(importClause.namedBindings)) {
    const identifier = importClause.namedBindings.name.text;
    return {
      node,
      identifier,
      modulePath,
      importType: 'namespace',
    };
  }

  // Handle default import: import Core from './core.md'
  if (importClause.name) {
    const identifier = importClause.name.text;
    return {
      node,
      identifier,
      modulePath,
      importType: 'default',
    };
  }

  // Handle named imports: import { foo } from './core.md'
  if (importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
    // For now, we'll use the first named import
    const firstElement = importClause.namedBindings.elements[0];
    if (!firstElement) {
      return null;
    }

    const identifier = firstElement.name.text;
    return {
      node,
      identifier,
      modulePath,
      importType: 'named',
    };
  }

  return null;
}

/**
 * Find all markdown imports in a source file
 *
 * @param sourceFile - The TypeScript source file to scan
 * @returns Array of markdown import information
 *
 * @example
 * ```typescript
 * const sourceFile = ts.createSourceFile(...);
 * const mdImports = findMarkdownImports(sourceFile);
 * // [{ identifier: 'Core', modulePath: './core.md', ... }]
 * ```
 */
export function findMarkdownImports(sourceFile: ts.SourceFile): MarkdownImportInfo[] {
  const markdownImports: MarkdownImportInfo[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const importInfo = extractImportInfo(node);
      if (importInfo) {
        markdownImports.push(importInfo);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return markdownImports;
}
