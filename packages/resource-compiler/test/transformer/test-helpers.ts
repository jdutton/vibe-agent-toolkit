/**
 * Shared test helpers for transformer tests
 */

import ts from 'typescript';

import type { MarkdownImportInfo } from '../../src/transformer/import-detector.js';

/**
 * Helper to convert AST to JavaScript code string
 */
export function astToCode(node: ts.Node): string {
  const printer = ts.createPrinter();
  const sourceFile = ts.createSourceFile(
    'temp.ts',
    '',
    ts.ScriptTarget.ES2024,
    false,
    ts.ScriptKind.TS,
  );
  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);
}

/**
 * Helper to create a TypeScript source file from code
 */
export function createSourceFile(code: string): ts.SourceFile {
  return ts.createSourceFile(
    'test.ts',
    code,
    ts.ScriptTarget.ES2024,
    true,
    ts.ScriptKind.TS,
  );
}

/**
 * Helper to get first import declaration from source
 */
export function getFirstImport(sourceFile: ts.SourceFile): ts.ImportDeclaration | null {
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      return statement;
    }
  }
  return null;
}

/**
 * Helper to create a mock import node from code string
 */
export function createMockImportNode(code: string): ts.ImportDeclaration {
  const sourceFile = createSourceFile(code);

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      return statement;
    }
  }

  throw new Error('No import declaration found');
}

/**
 * Create a standard test MarkdownImportInfo
 */
export function createTestImportInfo(
  code: string,
  identifier: string,
  modulePath: string,
  importType: 'namespace' | 'default' | 'named',
): MarkdownImportInfo {
  return {
    node: createMockImportNode(code),
    identifier,
    modulePath,
    importType,
  };
}

/**
 * Helper to extract import info with assertions
 */
export function getImportInfo(code: string, extractFn: (node: ts.ImportDeclaration) => MarkdownImportInfo | null): MarkdownImportInfo {
  const sourceFile = createSourceFile(code);
  const importNode = getFirstImport(sourceFile);

  if (!importNode) {
    throw new Error('No import node found');
  }

  const info = extractFn(importNode);

  if (!info) {
    throw new Error('Failed to extract import info');
  }

  return info;
}
