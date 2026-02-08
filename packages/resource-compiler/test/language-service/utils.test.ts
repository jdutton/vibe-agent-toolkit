/**
 * Tests for Language Service utility functions
 */

/* eslint-disable security/detect-non-literal-fs-filename -- Test files use dynamic paths */

import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { mkdirSyncReal, normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import ts from 'typescript';
import { describe, it, expect, beforeEach } from 'vitest';

import { clearCache } from '../../src/language-service/markdown-cache.js';
import {
  findNodeAtPosition,
  getMarkdownPathFromImport,
  getMarkdownPathFromExpression,
  findHeadingPosition,
  loadMarkdownResource,
} from '../../src/language-service/utils.js';

/**
 * Helper to find markdown path in AST by visiting all nodes
 */
function findMarkdownPathInAST(
  sourceFile: ts.SourceFile,
  finder: (node: ts.Node) => string | null,
): string | null {
  let result: string | null = null;
  function visit(node: ts.Node): void {
    const path = finder(node);
    if (path) {
      result = path;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return result;
}

/**
 * Helper to create source file and find markdown path using a finder function
 */
function testMarkdownPathFinder(
  sourceCode: string,
  finder: (node: ts.Node) => string | null,
): string | null {
  const sourceFile = ts.createSourceFile('test.ts', sourceCode, ts.ScriptTarget.ES2024, true);
  return findMarkdownPathInAST(sourceFile, finder);
}

/**
 * Helper to create source file and find expression info using a finder function
 */
function testExpressionFinder(
  sourceCode: string,
  finder: (node: ts.Node) => { markdownPath: string; fragmentName: string } | null,
): { markdownPath: string; fragmentName: string } | null {
  const sourceFile = ts.createSourceFile('test.ts', sourceCode, ts.ScriptTarget.ES2024, true);
  return findExpressionInfoInAST(sourceFile, finder);
}

/**
 * Helper to find expression info in AST by visiting all nodes
 */
function findExpressionInfoInAST(
  sourceFile: ts.SourceFile,
  finder: (node: ts.Node) => { markdownPath: string; fragmentName: string } | null,
): { markdownPath: string; fragmentName: string } | null {
  let result: { markdownPath: string; fragmentName: string } | null = null;
  function visit(node: ts.Node): void {
    const info = finder(node);
    if (info) {
      result = info;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return result;
}

describe('language-service utils', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(normalizedTmpdir(), `ls-utils-test-${Date.now()}`);
    mkdirSyncReal(testDir, { recursive: true });
    clearCache();
  });

  describe('findNodeAtPosition', () => {
    it('should find node at cursor position', () => {
      const sourceCode = 'const x = 5;';
      const sourceFile = ts.createSourceFile('test.ts', sourceCode, ts.ScriptTarget.ES2024, true);

      // Position at 'x'
      const node = findNodeAtPosition(ts, sourceFile, 6);

      expect(node).toBeDefined();
      expect(node?.kind).toBe(ts.SyntaxKind.Identifier);
      expect((node as ts.Identifier).text).toBe('x');
    });

    it('should return undefined for invalid position', () => {
      const sourceCode = 'const x = 5;';
      const sourceFile = ts.createSourceFile('test.ts', sourceCode, ts.ScriptTarget.ES2024, true);

      const node = findNodeAtPosition(ts, sourceFile, 9999);

      expect(node).toBeUndefined();
    });

    it('should find deepest node at position', () => {
      const sourceCode = 'const obj = { prop: 123 };';
      const sourceFile = ts.createSourceFile('test.ts', sourceCode, ts.ScriptTarget.ES2024, true);

      // Position at '123'
      const node = findNodeAtPosition(ts, sourceFile, 20);

      expect(node).toBeDefined();
      expect(node?.kind).toBe(ts.SyntaxKind.NumericLiteral);
    });
  });

  describe('getMarkdownPathFromImport', () => {
    it('should extract path from import declaration', () => {
      const markdownPath = testMarkdownPathFinder(
        `import Core from './core.md';`,
        (node) => getMarkdownPathFromImport(ts, node),
      );

      expect(markdownPath).toBe('./core.md');
    });

    it('should return null for non-markdown imports', () => {
      const markdownPath = testMarkdownPathFinder(
        `import { something } from './module.ts';`,
        (node) => getMarkdownPathFromImport(ts, node),
      );

      expect(markdownPath).toBeNull();
    });

    it('should extract path from dynamic import', () => {
      const markdownPath = testMarkdownPathFinder(
        `const core = await import('./core.md');`,
        (node) => getMarkdownPathFromImport(ts, node),
      );

      expect(markdownPath).toBe('./core.md');
    });

    it('should return null for non-import nodes', () => {
      const markdownPath = testMarkdownPathFinder(
        `const x = 5;`,
        (node) => getMarkdownPathFromImport(ts, node),
      );

      expect(markdownPath).toBeNull();
    });
  });

  describe('getMarkdownPathFromExpression', () => {
    it('should extract path and fragment from property access', () => {
      const sourceCode = `
        import Core from './core.md';
        const frag = Core.fragments.purposeDriven;
      `;
      const sourceFile = ts.createSourceFile('test.ts', sourceCode, ts.ScriptTarget.ES2024, true);

      let result: { markdownPath: string; fragmentName: string } | null = null;
      function visit(node: ts.Node): void {
        const info = getMarkdownPathFromExpression(ts, node, sourceFile);
        if (info) {
          result = info;
        }
        ts.forEachChild(node, visit);
      }
      visit(sourceFile);

      expect(result).not.toBeNull();
      expect(result?.markdownPath).toBe('./core.md');
      expect(result?.fragmentName).toBe('purposeDriven');
    });

    it('should return null for non-fragment property access', () => {
      const result = testExpressionFinder(
        `
        const obj = { prop: 123 };
        const val = obj.prop;
      `,
        (node) => {
          const sourceFile = node.getSourceFile();
          return getMarkdownPathFromExpression(ts, node, sourceFile);
        },
      );

      expect(result).toBeNull();
    });

    it('should return null when accessing non-markdown import', () => {
      const result = testExpressionFinder(
        `
        import Module from './module.ts';
        const val = Module.fragments.something;
      `,
        (node) => {
          const sourceFile = node.getSourceFile();
          return getMarkdownPathFromExpression(ts, node, sourceFile);
        },
      );

      expect(result).toBeNull();
    });
  });

  describe('findHeadingPosition', () => {
    it('should find position of H2 heading', () => {
      const content = `# Main Title

## First Section
Content here

## Second Section
More content`;

      const position = findHeadingPosition(content, 'First Section');

      expect(position).not.toBeNull();
      expect(position?.line).toBe(2);
      expect(position?.character).toBe(0);
    });

    it('should return null for non-existent heading', () => {
      const content = `## First Section
Content here`;

      const position = findHeadingPosition(content, 'Non Existent');

      expect(position).toBeNull();
    });

    it('should handle headings with special characters', () => {
      const content = `## API v2.0
Content here`;

      const position = findHeadingPosition(content, 'API v2.0');

      expect(position).not.toBeNull();
      expect(position?.line).toBe(0);
    });

    it('should only match exact heading text', () => {
      const content = `## Similar Heading
## Similar Heading Extra
Content`;

      const position = findHeadingPosition(content, 'Similar Heading');

      expect(position).not.toBeNull();
      expect(position?.line).toBe(0);
    });
  });

  describe('loadMarkdownResource', () => {
    it('should load and parse markdown file', () => {
      const testFile = join(testDir, 'test.md');
      writeFileSync(
        testFile,
        `---
title: Test
---
## Fragment One
Content one

## Fragment Two
Content two`,
      );

      const resource = loadMarkdownResource(testFile);

      expect(resource.frontmatter).toEqual({ title: 'Test' });
      expect(resource.fragments).toHaveLength(2);
      expect(resource.fragments[0]?.heading).toBe('Fragment One');
      expect(resource.fragments[1]?.heading).toBe('Fragment Two');

      unlinkSync(testFile);
    });

    it('should cache loaded resources', () => {
      const testFile = join(testDir, 'test.md');
      writeFileSync(testFile, '## Fragment\nContent');

      // First load
      const resource1 = loadMarkdownResource(testFile);

      // Second load - should return cached version
      const resource2 = loadMarkdownResource(testFile);

      expect(resource1).toBe(resource2); // Same object reference

      unlinkSync(testFile);
    });
  });
});
