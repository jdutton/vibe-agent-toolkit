/**
 * Tests for AST helpers
 */

import ts from 'typescript';
import { describe, it, expect } from 'vitest';

import type { MarkdownResource } from '../../src/compiler/types.js';
import { resourceToAst, createConstDeclaration } from '../../src/transformer/ast-helpers.js';

import { astToCode } from './test-helpers.js';

describe('resourceToAst', () => {
  it('should convert simple resource to AST', () => {
    const resource: MarkdownResource = {
      frontmatter: { title: 'Test' },
      content: 'Content here',
      fragments: [],
    };

    const ast = resourceToAst(resource);
    const code = astToCode(ast);

    expect(code).toContain('meta');
    expect(code).toContain('title');
    expect(code).toContain('Test');
    expect(code).toContain('text');
    expect(code).toContain('Content here');
    expect(code).toContain('fragments');
  });

  it('should convert resource with fragments', () => {
    const resource: MarkdownResource = {
      frontmatter: {},
      content: '## Intro\n\nText',
      fragments: [
        {
          heading: 'Intro',
          slug: 'intro',
          camelCase: 'intro',
          header: '## Intro',
          body: 'Text',
          text: '## Intro\n\nText',
        },
      ],
    };

    const ast = resourceToAst(resource);
    const code = astToCode(ast);

    expect(code).toContain('intro');
    expect(code).toContain('Intro');
    expect(code).toContain('Text');
  });

  it('should handle complex frontmatter', () => {
    const resource: MarkdownResource = {
      frontmatter: {
        title: 'Test',
        version: 1,
        enabled: true,
        tags: ['a', 'b'],
        nested: { key: 'value' },
      },
      content: 'Content',
      fragments: [],
    };

    const ast = resourceToAst(resource);
    const code = astToCode(ast);

    expect(code).toContain('title');
    expect(code).toContain('Test');
    expect(code).toContain('version');
    expect(code).toContain('1');
    expect(code).toContain('enabled');
    expect(code).toContain('true');
    expect(code).toContain('tags');
    expect(code).toContain('nested');
    expect(code).toContain('key');
    expect(code).toContain('value');
  });

  it('should handle empty frontmatter', () => {
    const resource: MarkdownResource = {
      frontmatter: {},
      content: 'Just content',
      fragments: [],
    };

    const ast = resourceToAst(resource);
    const code = astToCode(ast);

    expect(code).toContain('meta');
    expect(code).toContain('{}');
  });

  it('should handle multiple fragments', () => {
    const resource: MarkdownResource = {
      frontmatter: {},
      content: 'Content',
      fragments: [
        {
          heading: 'First',
          slug: 'first',
          camelCase: 'first',
          header: '## First',
          body: 'Body 1',
          text: '## First\n\nBody 1',
        },
        {
          heading: 'Second',
          slug: 'second',
          camelCase: 'second',
          header: '## Second',
          body: 'Body 2',
          text: '## Second\n\nBody 2',
        },
      ],
    };

    const ast = resourceToAst(resource);
    const code = astToCode(ast);

    expect(code).toContain('first');
    expect(code).toContain('second');
    expect(code).toContain('Body 1');
    expect(code).toContain('Body 2');
  });

  it('should escape special characters in strings', () => {
    const resource: MarkdownResource = {
      frontmatter: { quote: 'He said "hello"' },
      content: 'Content with\nnewline',
      fragments: [],
    };

    const ast = resourceToAst(resource);

    // Should create valid AST without throwing
    expect(ast).toBeDefined();
  });
});

describe('createConstDeclaration', () => {
  it('should create const declaration', () => {
    const value = ts.factory.createObjectLiteralExpression([
      ts.factory.createPropertyAssignment('key', ts.factory.createStringLiteral('value')),
    ]);

    const statement = createConstDeclaration('MyConst', value);
    const code = astToCode(statement);

    expect(code).toContain('const MyConst');
    expect(code).toContain('key');
    expect(code).toContain('value');
  });

  it('should handle different identifier names', () => {
    const value = ts.factory.createNumericLiteral(42);
    const statement = createConstDeclaration('TestVariable', value);
    const code = astToCode(statement);

    expect(code).toContain('const TestVariable');
    expect(code).toContain('42');
  });

  it('should create valid variable statement node', () => {
    const value = ts.factory.createStringLiteral('test');
    const statement = createConstDeclaration('Var', value);

    expect(ts.isVariableStatement(statement)).toBe(true);
  });
});
