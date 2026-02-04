/**
 * Tests for TypeScript transformer
 */

import { join } from 'node:path';

import ts from 'typescript';
import { describe, it, expect } from 'vitest';

import { createTransformer } from '../../src/transformer/transformer.js';

const FIXTURES_DIR = join(import.meta.dirname, '../transformer-fixtures');
const IMPORT_SAMPLE_CODE = `import * as Sample from './sample.md';`;
const TEST_TS_FILE = 'test.ts';
const CONST_SAMPLE = 'const Sample';

/**
 * Helper to transform TypeScript code
 */
function transformCode(sourceCode: string, fileName: string): string {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceCode,
    ts.ScriptTarget.ES2024,
    true,
    ts.ScriptKind.TS,
  );

  const transformer = createTransformer(undefined, {
    verbose: false,
  });

  const result = ts.transform(sourceFile, [transformer]);
  const transformedSourceFile = result.transformed[0];

  if (!transformedSourceFile) {
    throw new Error('Transformation failed');
  }

  const printer = ts.createPrinter();
  return printer.printFile(transformedSourceFile);
}

describe('createTransformer', () => {
  describe('namespace imports', () => {
    it('should transform namespace import to const declaration', () => {
      const fileName = join(FIXTURES_DIR, TEST_TS_FILE);

      const result = transformCode(IMPORT_SAMPLE_CODE, fileName);

      expect(result).toContain(CONST_SAMPLE);
      expect(result).not.toContain('import * as Sample');
      expect(result).toContain('meta');
      expect(result).toContain('text');
      expect(result).toContain('fragments');
    });

    it('should preserve identifier name', () => {
      const code = `import * as MyResource from './sample.md';`;
      const fileName = join(FIXTURES_DIR, TEST_TS_FILE);

      const result = transformCode(code, fileName);

      expect(result).toContain('const MyResource');
      expect(result).not.toContain('const Sample');
    });
  });

  describe('default imports', () => {
    it('should transform default import to const declaration', () => {
      const code = `import Sample from './sample.md';`;
      const fileName = join(FIXTURES_DIR, TEST_TS_FILE);

      const result = transformCode(code, fileName);

      expect(result).toContain(CONST_SAMPLE);
      expect(result).not.toContain('import Sample');
    });
  });

  describe('multiple imports', () => {
    it('should transform only .md imports', () => {
      const code = `
        import * as Sample from './sample.md';
        import { readFileSync } from 'node:fs';
        import * as Empty from './empty.md';
      `;
      const fileName = join(FIXTURES_DIR, TEST_TS_FILE);

      const result = transformCode(code, fileName);

      // .md imports should be transformed
      expect(result).toContain(CONST_SAMPLE);
      expect(result).toContain('const Empty');

      // Regular imports should be preserved (printer uses single quotes)
      expect(result).toContain('readFileSync');
    });

    it('should handle files with no .md imports', () => {
      const code = `
        import { readFileSync } from 'node:fs';
        const x = 5;
      `;
      const fileName = join(FIXTURES_DIR, TEST_TS_FILE);

      const result = transformCode(code, fileName);

      // Should be unchanged (printer uses single quotes)
      expect(result).toContain('readFileSync');
      expect(result).toContain('const x = 5');
    });
  });

  describe('content preservation', () => {
    it('should preserve code after imports', () => {
      const code = `
        import * as Sample from './sample.md';

        export function getTitle() {
          return Sample.meta.title;
        }
      `;
      const fileName = join(FIXTURES_DIR, TEST_TS_FILE);

      const result = transformCode(code, fileName);

      expect(result).toContain('export function getTitle()');
      expect(result).toContain('return Sample.meta.title');
    });

    it('should preserve block comments', () => {
      const code = `
        // This is a comment
        import * as Sample from './sample.md';
        /* Block comment */
      `;
      const fileName = join(FIXTURES_DIR, TEST_TS_FILE);

      const result = transformCode(code, fileName);

      // Block comments after code are preserved
      expect(result).toContain('Block comment');
    });
  });

  describe('error handling', () => {
    it('should handle non-existent .md file gracefully', () => {
      const code = `import * as Missing from './nonexistent.md';`;
      const fileName = join(FIXTURES_DIR, TEST_TS_FILE);

      // Should not throw, but should preserve original import
      const result = transformCode(code, fileName);

      // When file is not found, original import is preserved
      expect(result).toContain('import');
    });
  });

  describe('resource content', () => {
    it('should include frontmatter in transformed output', () => {
      const fileName = join(FIXTURES_DIR, TEST_TS_FILE);

      const result = transformCode(IMPORT_SAMPLE_CODE, fileName);

      expect(result).toContain('title');
      expect(result).toContain('Sample Resource');
      expect(result).toContain('version');
    });

    it('should include markdown content', () => {
      const fileName = join(FIXTURES_DIR, TEST_TS_FILE);

      const result = transformCode(IMPORT_SAMPLE_CODE, fileName);

      expect(result).toContain('This is a test markdown file');
    });

    it('should include fragments', () => {
      const fileName = join(FIXTURES_DIR, TEST_TS_FILE);

      const result = transformCode(IMPORT_SAMPLE_CODE, fileName);

      expect(result).toContain('introduction');
      expect(result).toContain('gettingStarted');
      expect(result).toContain('conclusion');
    });
  });
});

describe('transformer options', () => {
  it('should accept custom compiler options', () => {
    const sourceFile = ts.createSourceFile(
      'test.ts',
      `import * as Sample from './sample.md';`,
      ts.ScriptTarget.ES2024,
      true,
      ts.ScriptKind.TS,
    );

    const transformer = createTransformer(undefined, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.ESNext,
      },
    });

    const result = ts.transform(sourceFile, [transformer]);

    expect(result.transformed[0]).toBeDefined();
  });

  it('should support verbose mode', () => {
    const sourceFile = ts.createSourceFile(
      'test.ts',
      `const x = 5;`,
      ts.ScriptTarget.ES2024,
      true,
      ts.ScriptKind.TS,
    );

    const transformer = createTransformer(undefined, {
      verbose: true,
    });

    // Should not throw even with verbose enabled
    const result = ts.transform(sourceFile, [transformer]);

    expect(result.transformed[0]).toBeDefined();
  });
});
