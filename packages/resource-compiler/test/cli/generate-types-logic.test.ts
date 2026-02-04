/**
 * Unit tests for generate-types command logic
 * Tests the core functionality without CLI process.exit calls
 */

/* eslint-disable security/detect-non-literal-fs-filename -- Test file with controlled inputs */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { glob } from 'glob';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { parseMarkdown } from '../../src/compiler/markdown-parser.js';
import { generateMarkdownDeclarationFile, getDeclarationPath } from '../../src/transformer/declaration-generator.js';
import { createMultipleMarkdownFiles, verifyOperationResults } from '../test-file-helpers.js';

/**
 * Test suite helper
 */
function setupGenerateTypesLogicTestSuite(testPrefix: string) {
  const suite = {
    inputDir: '',
    beforeEach: () => {
      const tmpBase = normalizedTmpdir();
      suite.inputDir = mkdtempSync(join(tmpBase, `${testPrefix}-input-`));
    },
    afterEach: () => {
      if (suite.inputDir) {
        rmSync(suite.inputDir, { recursive: true, force: true });
      }
    },
  };
  return suite;
}

/**
 * Direct implementation of generate-types logic for testing
 */
async function generateTypesForDirectory(
  inputDir: string,
  pattern: string,
): Promise<Array<{ sourcePath: string; declarationPath: string; success: boolean }>> {
  const files = await glob(pattern, {
    cwd: inputDir,
    absolute: true,
    nodir: true,
  });

  const results = [];

  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const resource = parseMarkdown(content);
      const declaration = generateMarkdownDeclarationFile(filePath, resource);
      const declarationPath = getDeclarationPath(filePath);

      writeFileSync(declarationPath, declaration, 'utf-8');

      results.push({
        sourcePath: filePath,
        declarationPath,
        success: true,
      });
    } catch {
      // Silently ignore errors and mark as failed
      results.push({
        sourcePath: filePath,
        declarationPath: getDeclarationPath(filePath),
        success: false,
      });
    }
  }

  return results;
}

const suite = setupGenerateTypesLogicTestSuite('gen-types-logic');

describe('generate-types logic', () => {
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  describe('basic functionality', () => {
    it('should generate .md.d.ts for single markdown file', async () => {
      const mdContent = `---
title: Test Document
---

# Test

## Section One

Content here.`;

      const mdPath = join(suite.inputDir, 'test.md');
      writeFileSync(mdPath, mdContent, 'utf-8');

      const results = await generateTypesForDirectory(suite.inputDir, '**/*.md');

      expect(results).toHaveLength(1);
      expect(results[0]?.success).toBe(true);

      const dtsPath = join(suite.inputDir, 'test.md.d.ts');
      expect(existsSync(dtsPath)).toBe(true);

      const dtsContent = readFileSync(dtsPath, 'utf-8');
      expect(dtsContent).toContain('export interface Fragment');
      expect(dtsContent).toContain('export const meta:');
      expect(dtsContent).toContain('readonly title: string;');
      expect(dtsContent).toContain('export const text: string;');
      expect(dtsContent).toContain('export const fragments:');
      expect(dtsContent).toContain('readonly sectionOne: Fragment;');
    });

    it('should generate declarations for multiple markdown files', async () => {
      const files = ['doc1.md', 'doc2.md', 'doc3.md'];

      createMultipleMarkdownFiles(suite.inputDir, files);

      const results = await generateTypesForDirectory(suite.inputDir, '**/*.md');

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.success)).toBe(true);

      for (const file of files) {
        const dtsPath = join(suite.inputDir, `${file}.d.ts`);
        expect(existsSync(dtsPath)).toBe(true);

        const dtsContent = readFileSync(dtsPath, 'utf-8');
        expect(dtsContent).toContain('export interface Fragment');
      }
    });

    it('should maintain directory structure', async () => {
      const files = [
        'root.md',
        'docs/guide.md',
        'docs/api/reference.md',
        'examples/basic.md',
      ];

      createMultipleMarkdownFiles(suite.inputDir, files, (file) => `# ${file}\n\n## Content\n\nTest content`);

      const results = await generateTypesForDirectory(suite.inputDir, '**/*.md');

      expect(results).toHaveLength(4);
      expect(results.every((r) => r.success)).toBe(true);

      expect(existsSync(join(suite.inputDir, 'root.md.d.ts'))).toBe(true);
      expect(existsSync(join(suite.inputDir, 'docs/guide.md.d.ts'))).toBe(true);
      expect(existsSync(join(suite.inputDir, 'docs/api/reference.md.d.ts'))).toBe(true);
      expect(existsSync(join(suite.inputDir, 'examples/basic.md.d.ts'))).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should continue on individual file errors', async () => {
      writeFileSync(join(suite.inputDir, 'valid.md'), '# Valid\n\n## Section\n\nContent', 'utf-8');
      writeFileSync(join(suite.inputDir, 'broken.md'), '---\nbroken: [unclosed\n---\n\n## Test', 'utf-8');
      writeFileSync(join(suite.inputDir, 'also-valid.md'), '# Also Valid\n\n## Section\n\nMore', 'utf-8');

      const results = await generateTypesForDirectory(suite.inputDir, '**/*.md');

      verifyOperationResults(results, 3, 2);

      expect(existsSync(join(suite.inputDir, 'valid.md.d.ts'))).toBe(true);
      expect(existsSync(join(suite.inputDir, 'also-valid.md.d.ts'))).toBe(true);
      expect(existsSync(join(suite.inputDir, 'broken.md.d.ts'))).toBe(false);
    });
  });

  describe('declaration content', () => {
    it('should generate correct types for complex frontmatter', async () => {
      const mdContent = `---
title: "Test with quotes"
version: 1.0
enabled: true
tags: [one, two, three]
---

## Fragment One

Content`;

      writeFileSync(join(suite.inputDir, 'complex.md'), mdContent, 'utf-8');

      await generateTypesForDirectory(suite.inputDir, '**/*.md');

      const dtsContent = readFileSync(join(suite.inputDir, 'complex.md.d.ts'), 'utf-8');

      expect(dtsContent).toContain('readonly title: string;');
      expect(dtsContent).toContain('readonly version: number;');
      expect(dtsContent).toContain('readonly enabled: boolean;');
      expect(dtsContent).toContain('readonly tags: readonly string[];');
    });

    it('should handle markdown with no frontmatter', async () => {
      const mdContent = `# Simple Document

## Section

Content without frontmatter.`;

      writeFileSync(join(suite.inputDir, 'simple.md'), mdContent, 'utf-8');

      await generateTypesForDirectory(suite.inputDir, '**/*.md');

      const dtsContent = readFileSync(join(suite.inputDir, 'simple.md.d.ts'), 'utf-8');

      expect(dtsContent).toContain('export const meta: {}');
      expect(dtsContent).toContain('readonly section: Fragment;');
    });

    it('should handle markdown with no fragments', async () => {
      const mdContent = `---
title: No Fragments
---

# Just Content

No H2 headings here.`;

      writeFileSync(join(suite.inputDir, 'no-fragments.md'), mdContent, 'utf-8');

      await generateTypesForDirectory(suite.inputDir, '**/*.md');

      const dtsContent = readFileSync(join(suite.inputDir, 'no-fragments.md.d.ts'), 'utf-8');

      expect(dtsContent).toContain('export const fragments: {}');
      expect(dtsContent).toContain('export type FragmentName = never;');
    });
  });
});
