/**
 * Tests for module generator
 */

import { join } from 'node:path';

import ts from 'typescript';
import { describe, it, expect } from 'vitest';

import { generateModuleReplacement } from '../../src/transformer/module-generator.js';

import { astToCode, createTestImportInfo } from './test-helpers.js';

const FIXTURES_DIR = join(import.meta.dirname, '../transformer-fixtures');
const SAMPLE_MD_PATH = './sample.md';
const SAMPLE_MD_FILE = 'sample.md';
const IMPORT_AS_SAMPLE = `import * as Sample from '${SAMPLE_MD_PATH}';`;
const CONST_SAMPLE = 'const Sample';

/**
 * Helper to generate and get code from sample import
 */
function generateSampleCode(): string {
  const importInfo = createTestImportInfo(IMPORT_AS_SAMPLE, 'Sample', SAMPLE_MD_PATH, 'namespace');
  const resolvedPath = join(FIXTURES_DIR, SAMPLE_MD_FILE);
  const replacement = generateModuleReplacement(importInfo, resolvedPath);
  return astToCode(replacement);
}

describe('generateModuleReplacement', () => {
  it('should generate replacement for namespace import', () => {
    const importInfo = createTestImportInfo(IMPORT_AS_SAMPLE, 'Sample', SAMPLE_MD_PATH, 'namespace');
    const resolvedPath = join(FIXTURES_DIR, SAMPLE_MD_FILE);
    const replacement = generateModuleReplacement(importInfo, resolvedPath);

    expect(ts.isVariableStatement(replacement)).toBe(true);

    const code = astToCode(replacement);

    expect(code).toContain(CONST_SAMPLE);
    expect(code).toContain('meta');
    expect(code).toContain('text');
    expect(code).toContain('fragments');
    expect(code).toContain('title');
    expect(code).toContain('Sample Resource');
  });

  it('should generate replacement for default import', () => {
    const importInfo = createTestImportInfo(
      `import Sample from '${SAMPLE_MD_PATH}';`,
      'Sample',
      SAMPLE_MD_PATH,
      'default',
    );
    const resolvedPath = join(FIXTURES_DIR, SAMPLE_MD_FILE);
    const replacement = generateModuleReplacement(importInfo, resolvedPath);

    const code = astToCode(replacement);

    expect(code).toContain(CONST_SAMPLE);
  });

  it('should include frontmatter in replacement', () => {
    const code = generateSampleCode();

    expect(code).toContain('Sample Resource');
    expect(code).toContain('version: 1');
  });

  it('should include fragments in replacement', () => {
    const code = generateSampleCode();

    expect(code).toContain('introduction');
    expect(code).toContain('gettingStarted');
    expect(code).toContain('conclusion');
  });

  it('should handle markdown file with no fragments', () => {
    const importInfo = createTestImportInfo(
      `import * as Empty from './empty.md';`,
      'Empty',
      './empty.md',
      'namespace',
    );

    const resolvedPath = join(FIXTURES_DIR, 'empty.md');
    const replacement = generateModuleReplacement(importInfo, resolvedPath);
    const code = astToCode(replacement);

    expect(code).toContain('const Empty');
    expect(code).toContain('meta');
    expect(code).toContain('text');
    expect(code).toContain('fragments');
  });

  it('should use correct identifier from import info', () => {
    const importInfo = createTestImportInfo(
      `import * as CustomName from '${SAMPLE_MD_PATH}';`,
      'CustomName',
      SAMPLE_MD_PATH,
      'namespace',
    );
    const resolvedPath = join(FIXTURES_DIR, SAMPLE_MD_FILE);
    const replacement = generateModuleReplacement(importInfo, resolvedPath);
    const code = astToCode(replacement);

    expect(code).toContain('const CustomName');
    expect(code).not.toContain('const Sample');
  });
});
