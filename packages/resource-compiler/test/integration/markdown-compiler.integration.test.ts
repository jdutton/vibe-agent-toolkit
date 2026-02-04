/**
 * Integration tests for markdown compiler orchestrator
 */

/* eslint-disable security/detect-non-literal-fs-filename -- Test file with controlled inputs */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { mkdirSyncReal, normalizedTmpdir, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { compileMarkdownResources } from '../../src/compiler/markdown-compiler.js';
import type { CompileResult } from '../../src/compiler/types.js';

/**
 * Test suite helper for markdown compiler integration tests
 */
function setupMarkdownCompilerTestSuite(testPrefix: string) {
  const suite = {
    inputDir: '',
    outputDir: '',
    beforeEach: () => {
      const tmpBase = normalizedTmpdir();
      suite.inputDir = mkdtempSync(join(tmpBase, `${testPrefix}-input-`));
      suite.outputDir = mkdtempSync(join(tmpBase, `${testPrefix}-output-`));
    },
    afterEach: () => {
      if (suite.inputDir) {
        rmSync(suite.inputDir, { recursive: true, force: true });
      }
      if (suite.outputDir) {
        rmSync(suite.outputDir, { recursive: true, force: true });
      }
    },
  };
  return suite;
}

/**
 * Helper to compile a single markdown file and verify results
 */
async function compileAndVerifyFile(
  inputDir: string,
  outputDir: string,
  fileName: string,
  content: string,
): Promise<CompileResult[]> {
  const inputFile = join(inputDir, fileName);
  writeFileSync(inputFile, content, 'utf-8');

  return compileMarkdownResources({
    inputDir,
    outputDir,
  });
}

const suite = setupMarkdownCompilerTestSuite('md-compiler');

describe('compileMarkdownResources', () => {
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  describe('single file compilation', () => {
    it('should compile a simple markdown file', async () => {
      // Create input file
      const mdContent = `# Test Document

## Introduction

This is a test document.

## Conclusion

Final thoughts.`;

      const inputFile = join(suite.inputDir, 'test.md');
      writeFileSync(inputFile, mdContent, 'utf-8');

      // Compile
      const results = await compileMarkdownResources({
        inputDir: suite.inputDir,
        outputDir: suite.outputDir,
      });

      // Verify results
      expect(results).toHaveLength(1);
      expect(results[0]?.success).toBe(true);

      // Verify output files exist
      const jsPath = join(suite.outputDir, 'test.js');
      const dtsPath = join(suite.outputDir, 'test.d.ts');

      expect(existsSync(jsPath)).toBe(true);
      expect(existsSync(dtsPath)).toBe(true);

      // Verify JavaScript content
      const jsContent = readFileSync(jsPath, 'utf-8');
      expect(jsContent).toContain('export const meta =');
      expect(jsContent).toContain('export const text =');
      expect(jsContent).toContain('export const fragments =');
      expect(jsContent).toContain('introduction');
      expect(jsContent).toContain('conclusion');

      // Verify TypeScript declarations
      const dtsContent = readFileSync(dtsPath, 'utf-8');
      expect(dtsContent).toContain('export interface Fragment');
      expect(dtsContent).toContain('export const meta:');
      expect(dtsContent).toContain('export const text: string');
      expect(dtsContent).toContain('export const fragments:');
      expect(dtsContent).toContain('readonly introduction: Fragment');
      expect(dtsContent).toContain('readonly conclusion: Fragment');
    });

    it('should compile markdown with frontmatter', async () => {
      const mdContent = `---
title: Test Document
version: 1.0
---

# Test

## Section One

Content here.`;

      const results = await compileAndVerifyFile(
        suite.inputDir,
        suite.outputDir,
        'with-frontmatter.md',
        mdContent,
      );

      expect(results).toHaveLength(1);
      expect(results[0]?.success).toBe(true);

      const jsPath = join(suite.outputDir, 'with-frontmatter.js');
      const jsContent = readFileSync(jsPath, 'utf-8');

      expect(jsContent).toContain('title: "Test Document"');
      expect(jsContent).toContain('version: 1');
    });

    it('should handle compilation errors gracefully', async () => {
      // Create a file with invalid YAML frontmatter
      const mdContent = `---
title: Test
broken: [unclosed
---

## Section`;

      const results = await compileAndVerifyFile(
        suite.inputDir,
        suite.outputDir,
        'broken.md',
        mdContent,
      );

      expect(results).toHaveLength(1);
      expect(results[0]?.success).toBe(false);
      expect(results[0]?.error).toBeDefined();
    });
  });

  describe('directory tree compilation', () => {
    it('should compile multiple files in flat directory', async () => {
      // Create multiple files
      const files = ['doc1.md', 'doc2.md', 'doc3.md'];

      for (const file of files) {
        const content = `# ${file}

## Section

Content for ${file}`;
        writeFileSync(join(suite.inputDir, file), content, 'utf-8');
      }

      const results = await compileMarkdownResources({
        inputDir: suite.inputDir,
        outputDir: suite.outputDir,
      });

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.success)).toBe(true);

      // Verify all output files exist
      for (const file of files) {
        const baseName = file.replace('.md', '');
        expect(existsSync(join(suite.outputDir, `${baseName}.js`))).toBe(true);
        expect(existsSync(join(suite.outputDir, `${baseName}.d.ts`))).toBe(true);
      }
    });

    it('should maintain directory structure', async () => {
      // Create nested directory structure
      const files = [
        'root.md',
        'docs/guide.md',
        'docs/api/reference.md',
        'examples/basic.md',
      ];

      for (const file of files) {
        const content = `# ${file}

## Content

Test content`;
        const filePath = join(suite.inputDir, file);
        const dir = join(filePath, '..');
        mkdirSyncReal(dir, { recursive: true }); // Ensure directory exists
        writeFileSync(filePath, content, 'utf-8');
      }

      const results = await compileMarkdownResources({
        inputDir: suite.inputDir,
        outputDir: suite.outputDir,
      });

      expect(results).toHaveLength(4);
      expect(results.every((r) => r.success)).toBe(true);

      // Verify directory structure is maintained
      expect(existsSync(join(suite.outputDir, 'root.js'))).toBe(true);
      expect(existsSync(join(suite.outputDir, 'docs/guide.js'))).toBe(true);
      expect(existsSync(join(suite.outputDir, 'docs/api/reference.js'))).toBe(true);
      expect(existsSync(join(suite.outputDir, 'examples/basic.js'))).toBe(true);

      expect(existsSync(join(suite.outputDir, 'root.d.ts'))).toBe(true);
      expect(existsSync(join(suite.outputDir, 'docs/guide.d.ts'))).toBe(true);
      expect(existsSync(join(suite.outputDir, 'docs/api/reference.d.ts'))).toBe(true);
      expect(existsSync(join(suite.outputDir, 'examples/basic.d.ts'))).toBe(true);
    });

    it('should respect glob pattern', async () => {
      // Create multiple files with different extensions
      writeFileSync(join(suite.inputDir, 'include.md'), '# Test\n\n## Section\n\nContent', 'utf-8');
      writeFileSync(join(suite.inputDir, 'exclude.txt'), 'Not markdown', 'utf-8');
      writeFileSync(join(suite.inputDir, 'also-include.md'), '# Test 2\n\n## Section\n\nContent', 'utf-8');

      const results = await compileMarkdownResources({
        inputDir: suite.inputDir,
        outputDir: suite.outputDir,
        pattern: '**/*.md',
      });

      // Should only compile .md files
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.success)).toBe(true);

      expect(existsSync(join(suite.outputDir, 'include.js'))).toBe(true);
      expect(existsSync(join(suite.outputDir, 'also-include.js'))).toBe(true);
      expect(existsSync(join(suite.outputDir, 'exclude.js'))).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should report errors without stopping compilation', async () => {
      // Create mix of valid and invalid files
      writeFileSync(join(suite.inputDir, 'valid.md'), '# Valid\n\n## Section\n\nContent', 'utf-8');
      writeFileSync(join(suite.inputDir, 'broken.md'), '---\nbroken: [unclosed\n---\n\n## Test', 'utf-8');
      writeFileSync(join(suite.inputDir, 'also-valid.md'), '# Also Valid\n\n## Section\n\nMore', 'utf-8');

      const results = await compileMarkdownResources({
        inputDir: suite.inputDir,
        outputDir: suite.outputDir,
      });

      expect(results).toHaveLength(3);

      const validResults = results.filter((r) => r.success);
      const failedResults = results.filter((r) => !r.success);

      expect(validResults).toHaveLength(2);
      expect(failedResults).toHaveLength(1);

      // Valid files should be compiled
      expect(existsSync(join(suite.outputDir, 'valid.js'))).toBe(true);
      expect(existsSync(join(suite.outputDir, 'also-valid.js'))).toBe(true);

      // Broken file should not produce output
      expect(existsSync(join(suite.outputDir, 'broken.js'))).toBe(false);
    });

    it('should handle empty input directory', async () => {
      const results = await compileMarkdownResources({
        inputDir: suite.inputDir,
        outputDir: suite.outputDir,
      });

      expect(results).toHaveLength(0);
    });
  });

  describe('output verification', () => {
    it('should generate valid JavaScript syntax', async () => {
      const mdContent = `---
title: "Test with 'quotes'"
tags: [one, two]
---

## Fragment One

Content with "quotes" and 'apostrophes'.`;

      writeFileSync(join(suite.inputDir, 'quotes.md'), mdContent, 'utf-8');

      const results = await compileMarkdownResources({
        inputDir: suite.inputDir,
        outputDir: suite.outputDir,
      });

      expect(results[0]?.success).toBe(true);

      const jsPath = join(suite.outputDir, 'quotes.js');
      const jsContent = readFileSync(jsPath, 'utf-8');

      // Should escape quotes properly
      expect(jsContent).toContain(String.raw`\"quotes\"`);
      expect(jsContent).toContain(String.raw`\'apostrophes\'`);

      // Verify it has valid module exports
      expect(jsContent).toContain('export const meta =');
      expect(jsContent).toContain('export const text =');
      expect(jsContent).toContain('export const fragments =');
    });

    it('should generate valid TypeScript declarations', async () => {
      const mdContent = `---
title: Test
count: 42
enabled: true
---

## Section

Content`;

      const results = await compileAndVerifyFile(
        suite.inputDir,
        suite.outputDir,
        'types.md',
        mdContent,
      );

      expect(results[0]?.success).toBe(true);

      const dtsPath = join(suite.outputDir, 'types.d.ts');
      const dtsContent = readFileSync(dtsPath, 'utf-8');

      // Should infer correct types
      expect(dtsContent).toContain('readonly title: string');
      expect(dtsContent).toContain('readonly count: number');
      expect(dtsContent).toContain('readonly enabled: boolean');
    });
  });

  describe('result metadata', () => {
    it('should return correct paths in results', async () => {
      const results = await compileAndVerifyFile(
        suite.inputDir,
        suite.outputDir,
        'test.md',
        '# Test\n\n## Section\n\nContent',
      );

      const result = results[0] as CompileResult;

      expect(result.success).toBe(true);
      expect(toForwardSlash(result.sourcePath)).toContain('test.md');
      expect(toForwardSlash(result.jsPath)).toContain('test.js');
      expect(toForwardSlash(result.dtsPath)).toContain('test.d.ts');
    });

    it('should preserve relative paths in nested directories', async () => {
      const nestedPath = 'docs/guides/getting-started.md';
      const filePath = join(suite.inputDir, nestedPath);
      const dir = join(filePath, '..');

      mkdirSyncReal(dir, { recursive: true });
      writeFileSync(filePath, '# Guide\n\n## Step 1\n\nContent', 'utf-8');

      const results = await compileMarkdownResources({
        inputDir: suite.inputDir,
        outputDir: suite.outputDir,
      });

      const result = results[0] as CompileResult;

      expect(result.success).toBe(true);
      expect(toForwardSlash(result.jsPath)).toContain('docs/guides/getting-started.js');
      expect(toForwardSlash(result.dtsPath)).toContain('docs/guides/getting-started.d.ts');
    });
  });
});
