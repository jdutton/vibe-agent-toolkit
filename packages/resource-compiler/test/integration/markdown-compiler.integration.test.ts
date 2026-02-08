/**
 * Integration tests for markdown compiler orchestrator
 */

/* eslint-disable security/detect-non-literal-fs-filename -- Test file with controlled inputs */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { mkdirSyncReal, setupSyncTempDirSuite, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

import { compileMarkdownResources } from '../../src/compiler/markdown-compiler.js';
import type { CompileResult } from '../../src/compiler/types.js';
import { createMultipleMarkdownFiles, verifyOperationResults } from '../test-file-helpers.js';

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

const suite = setupSyncTempDirSuite('md-compiler');

describe('compileMarkdownResources', () => {
  let inputDir: string;
  let outputDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(() => {
    suite.beforeEach();
    const tempDir = suite.getTempDir();
    inputDir = join(tempDir, 'input');
    outputDir = join(tempDir, 'output');
    mkdirSyncReal(inputDir);
    mkdirSyncReal(outputDir);
  });

  describe('single file compilation', () => {
    it('should compile a simple markdown file', async () => {
      // Create input file
      const mdContent = `# Test Document

## Introduction

This is a test document.

## Conclusion

Final thoughts.`;

      const inputFile = join(inputDir, 'test.md');
      writeFileSync(inputFile, mdContent, 'utf-8');

      // Compile
      const results = await compileMarkdownResources({
        inputDir: inputDir,
        outputDir: outputDir,
      });

      // Verify results
      expect(results).toHaveLength(1);
      expect(results[0]?.success).toBe(true);

      // Verify output files exist
      const jsPath = join(outputDir, 'test.js');
      const dtsPath = join(outputDir, 'test.d.ts');

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
        inputDir,
        outputDir,
        'with-frontmatter.md',
        mdContent,
      );

      expect(results).toHaveLength(1);
      expect(results[0]?.success).toBe(true);

      const jsPath = join(outputDir, 'with-frontmatter.js');
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
        inputDir,
        outputDir,
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

      createMultipleMarkdownFiles(inputDir, files);

      const results = await compileMarkdownResources({
        inputDir: inputDir,
        outputDir: outputDir,
      });

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.success)).toBe(true);

      // Verify all output files exist
      for (const file of files) {
        const baseName = file.replace('.md', '');
        expect(existsSync(join(outputDir, `${baseName}.js`))).toBe(true);
        expect(existsSync(join(outputDir, `${baseName}.d.ts`))).toBe(true);
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

      createMultipleMarkdownFiles(inputDir, files, (file) => `# ${file}\n\n## Content\n\nTest content`);

      const results = await compileMarkdownResources({
        inputDir: inputDir,
        outputDir: outputDir,
      });

      expect(results).toHaveLength(4);
      expect(results.every((r) => r.success)).toBe(true);

      // Verify directory structure is maintained
      expect(existsSync(join(outputDir, 'root.js'))).toBe(true);
      expect(existsSync(join(outputDir, 'docs/guide.js'))).toBe(true);
      expect(existsSync(join(outputDir, 'docs/api/reference.js'))).toBe(true);
      expect(existsSync(join(outputDir, 'examples/basic.js'))).toBe(true);

      expect(existsSync(join(outputDir, 'root.d.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'docs/guide.d.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'docs/api/reference.d.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'examples/basic.d.ts'))).toBe(true);
    });

    it('should respect glob pattern', async () => {
      // Create multiple files with different extensions
      writeFileSync(join(inputDir, 'include.md'), '# Test\n\n## Section\n\nContent', 'utf-8');
      writeFileSync(join(inputDir, 'exclude.txt'), 'Not markdown', 'utf-8');
      writeFileSync(join(inputDir, 'also-include.md'), '# Test 2\n\n## Section\n\nContent', 'utf-8');

      const results = await compileMarkdownResources({
        inputDir: inputDir,
        outputDir: outputDir,
        pattern: '**/*.md',
      });

      // Should only compile .md files
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.success)).toBe(true);

      expect(existsSync(join(outputDir, 'include.js'))).toBe(true);
      expect(existsSync(join(outputDir, 'also-include.js'))).toBe(true);
      expect(existsSync(join(outputDir, 'exclude.js'))).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should report errors without stopping compilation', async () => {
      // Create mix of valid and invalid files
      writeFileSync(join(inputDir, 'valid.md'), '# Valid\n\n## Section\n\nContent', 'utf-8');
      writeFileSync(join(inputDir, 'broken.md'), '---\nbroken: [unclosed\n---\n\n## Test', 'utf-8');
      writeFileSync(join(inputDir, 'also-valid.md'), '# Also Valid\n\n## Section\n\nMore', 'utf-8');

      const results = await compileMarkdownResources({
        inputDir: inputDir,
        outputDir: outputDir,
      });

      verifyOperationResults(results, 3, 2);

      // Valid files should be compiled
      expect(existsSync(join(outputDir, 'valid.js'))).toBe(true);
      expect(existsSync(join(outputDir, 'also-valid.js'))).toBe(true);

      // Broken file should not produce output
      expect(existsSync(join(outputDir, 'broken.js'))).toBe(false);
    });

    it('should handle empty input directory', async () => {
      const results = await compileMarkdownResources({
        inputDir: inputDir,
        outputDir: outputDir,
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

      writeFileSync(join(inputDir, 'quotes.md'), mdContent, 'utf-8');

      const results = await compileMarkdownResources({
        inputDir: inputDir,
        outputDir: outputDir,
      });

      expect(results[0]?.success).toBe(true);

      const jsPath = join(outputDir, 'quotes.js');
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
        inputDir,
        outputDir,
        'types.md',
        mdContent,
      );

      expect(results[0]?.success).toBe(true);

      const dtsPath = join(outputDir, 'types.d.ts');
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
        inputDir,
        outputDir,
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
      const filePath = join(inputDir, nestedPath);
      const dir = join(filePath, '..');

      mkdirSyncReal(dir, { recursive: true });
      writeFileSync(filePath, '# Guide\n\n## Step 1\n\nContent', 'utf-8');

      const results = await compileMarkdownResources({
        inputDir: inputDir,
        outputDir: outputDir,
      });

      const result = results[0] as CompileResult;

      expect(result.success).toBe(true);
      expect(toForwardSlash(result.jsPath)).toContain('docs/guides/getting-started.js');
      expect(toForwardSlash(result.dtsPath)).toContain('docs/guides/getting-started.d.ts');
    });
  });
});
