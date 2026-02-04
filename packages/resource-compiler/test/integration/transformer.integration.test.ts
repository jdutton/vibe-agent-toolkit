/**
 * Integration tests for TypeScript transformer
 * Tests the transformer with real TypeScript compilation
 */

/* eslint-disable security/detect-non-literal-fs-filename -- Test file with controlled inputs */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { mkdirSyncReal, normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import ts from 'typescript';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { parseMarkdown } from '../../src/compiler/markdown-parser.js';
import { generateMarkdownDeclarationFile, getDeclarationPath } from '../../src/transformer/declaration-generator.js';
import { createTransformer } from '../../src/transformer/transformer.js';

// Test constants
const DIST_INDEX_PATH = 'dist/index.js';

/**
 * Test suite helper for transformer integration tests
 */
function setupTransformerIntegrationSuite(testPrefix: string) {
  const suite = {
    projectDir: '',
    beforeEach: () => {
      const tmpBase = normalizedTmpdir();
      suite.projectDir = mkdtempSync(join(tmpBase, `${testPrefix}-project-`));
    },
    afterEach: () => {
      if (suite.projectDir) {
        rmSync(suite.projectDir, { recursive: true, force: true });
      }
    },
  };
  return suite;
}

/**
 * Helper to create a test TypeScript project with markdown imports
 */
function createTestProject(
  projectDir: string,
  tsCode: string,
  markdownFiles: Record<string, string>,
): void {
  // Create src directory
  const srcDir = join(projectDir, 'src');
  mkdirSyncReal(srcDir, { recursive: true });

  // Write TypeScript file
  writeFileSync(join(srcDir, 'index.ts'), tsCode, 'utf-8');

  // Create resources directory
  const resourcesDir = join(srcDir, 'resources');
  mkdirSyncReal(resourcesDir, { recursive: true });

  // Write markdown files and their declarations
  for (const [fileName, content] of Object.entries(markdownFiles)) {
    const mdPath = join(resourcesDir, fileName);
    writeFileSync(mdPath, content, 'utf-8');

    // Generate and write declaration file
    const resource = parseMarkdown(content);
    const declaration = generateMarkdownDeclarationFile(mdPath, resource);
    const dtsPath = getDeclarationPath(mdPath);
    writeFileSync(dtsPath, declaration, 'utf-8');
  }

  // Create tsconfig.json
  const tsConfig = {
    compilerOptions: {
      target: 'ES2024',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      outDir: './dist',
      rootDir: './src',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
    },
    include: ['src/**/*'],
  };
  writeFileSync(join(projectDir, 'tsconfig.json'), JSON.stringify(tsConfig, null, 2), 'utf-8');
}

/**
 * Helper to create and compile a test project, expecting success
 */
function compileTestProjectSuccess(
  projectDir: string,
  tsCode: string,
  markdownFiles: Record<string, string>,
): { result: { success: boolean; diagnostics: ts.Diagnostic[] }; outputPath: string } {
  createTestProject(projectDir, tsCode, markdownFiles);
  const result = compileWithTransformer(projectDir);
  expect(result.success).toBe(true);
  expect(result.diagnostics).toHaveLength(0);
  const outputPath = join(projectDir, DIST_INDEX_PATH);
  return { result, outputPath };
}

/**
 * Helper to compile TypeScript project with transformer
 */
function compileWithTransformer(projectDir: string): { success: boolean; diagnostics: ts.Diagnostic[] } {
  const configPath = join(projectDir, 'tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);

  if (configFile.error) {
    return { success: false, diagnostics: [configFile.error] };
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    projectDir,
  );

  // Create custom compiler host with transformer
  const transformer = createTransformer();
  const compilerHost = ts.createCompilerHost(parsedConfig.options);

  // Create program with transformer
  const program = ts.createProgram({
    rootNames: parsedConfig.fileNames,
    options: parsedConfig.options,
    host: compilerHost,
  });

  // Emit with transformer
  const emitResult = program.emit(
    undefined,
    undefined,
    undefined,
    undefined,
    {
      before: [transformer],
    },
  );

  const allDiagnostics = [...ts.getPreEmitDiagnostics(program), ...emitResult.diagnostics];

  return {
    success: !emitResult.emitSkipped && allDiagnostics.length === 0,
    diagnostics: allDiagnostics,
  };
}

const suite = setupTransformerIntegrationSuite('transformer-int');

describe('TypeScript transformer integration', () => {
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  describe('single markdown import', () => {
    it('should compile TypeScript file with default markdown import', () => {
      const tsCode = `import prompts from './resources/prompts.md';

console.log(prompts.text);
console.log(prompts.meta.title);
console.log(prompts.fragments.introduction.text);
`;

      const markdownFiles = {
        'prompts.md': `---
title: System Prompts
version: 1.0
---

# Prompts

## Introduction

Welcome to the system.

## Conclusion

Thank you for using our system.`,
      };

      createTestProject(suite.projectDir, tsCode, markdownFiles);

      const result = compileWithTransformer(suite.projectDir);

      if (!result.success) {
        console.error('Compilation errors:');
        for (const diagnostic of result.diagnostics) {
          const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
          console.error(`  ${message}`);
        }
      }

      expect(result.success).toBe(true);
      expect(result.diagnostics).toHaveLength(0);

      // Verify output file exists
      const outputPath = join(suite.projectDir, DIST_INDEX_PATH);
      expect(existsSync(outputPath)).toBe(true);

      // Verify generated code contains inlined resource
      const output = readFileSync(outputPath, 'utf-8');
      expect(output).toContain('System Prompts');
      expect(output).toContain('Welcome to the system');
      expect(output).toContain('introduction');
      expect(output).toContain('conclusion');
    });

    it('should compile TypeScript file with namespace markdown import', () => {
      const tsCode = `import * as doc from './resources/doc.md';

console.log(doc.text);
console.log(doc.fragments.overview.body);
`;

      const markdownFiles = {
        'doc.md': `# Documentation

## Overview

This is the overview section.`,
      };

      const { outputPath } = compileTestProjectSuccess(suite.projectDir, tsCode, markdownFiles);

      expect(existsSync(outputPath)).toBe(true);

      const output = readFileSync(outputPath, 'utf-8');
      expect(output).toContain('overview');
    });

    it('should compile TypeScript file with named markdown imports', () => {
      const tsCode = `import { text, fragments } from './resources/guide.md';

console.log(text);
console.log(fragments.gettingStarted.header);
`;

      const markdownFiles = {
        'guide.md': `# User Guide

## Getting Started

Follow these steps to get started.`,
      };

      const { outputPath } = compileTestProjectSuccess(suite.projectDir, tsCode, markdownFiles);

      const output = readFileSync(outputPath, 'utf-8');
      expect(output).toContain('gettingStarted');
    });
  });

  describe('multiple markdown imports', () => {
    it('should compile TypeScript file with multiple markdown imports', () => {
      const tsCode = `import prompts from './resources/prompts.md';
import guide from './resources/guide.md';

console.log(prompts.text);
console.log(guide.text);
console.log(prompts.fragments.intro.text);
console.log(guide.fragments.setup.text);
`;

      const markdownFiles = {
        'prompts.md': `# System Prompts

## Intro

System prompt text.`,
        'guide.md': `# User Guide

## Setup

Setup instructions.`,
      };

      const { outputPath } = compileTestProjectSuccess(suite.projectDir, tsCode, markdownFiles);

      const output = readFileSync(outputPath, 'utf-8');
      expect(output).toContain('System prompt text');
      expect(output).toContain('Setup instructions');
    });

    it('should handle mixed import styles', () => {
      const tsCode = `import defaultDoc from './resources/doc1.md';
import * as namespacedDoc from './resources/doc2.md';
import { text, fragments } from './resources/doc3.md';

console.log(defaultDoc.text);
console.log(namespacedDoc.text);
console.log(text);
`;

      const markdownFiles = {
        'doc1.md': '# Doc 1\n\n## Section\n\nContent 1',
        'doc2.md': '# Doc 2\n\n## Section\n\nContent 2',
        'doc3.md': '# Doc 3\n\n## Section\n\nContent 3',
      };

      createTestProject(suite.projectDir, tsCode, markdownFiles);

      const result = compileWithTransformer(suite.projectDir);

      expect(result.success).toBe(true);
      expect(result.diagnostics).toHaveLength(0);
    });
  });

  describe('type safety', () => {
    it('should provide type-safe access to markdown exports', () => {
      const tsCode = `import prompts from './resources/prompts.md';

// Type-safe access
const title: string = prompts.meta.title;
const intro: string = prompts.fragments.introduction.text;
const fragmentNames: ('introduction' | 'conclusion')[] = ['introduction', 'conclusion'];

console.log(title, intro, fragmentNames);
`;

      const markdownFiles = {
        'prompts.md': `---
title: System Prompts
---

# Prompts

## Introduction

Intro text.

## Conclusion

Conclusion text.`,
      };

      compileTestProjectSuccess(suite.projectDir, tsCode, markdownFiles);
    });
  });

  describe('error scenarios', () => {
    it('should fail compilation if markdown file does not exist', () => {
      const tsCode = `import missing from './resources/missing.md';

console.log(missing.text);
`;

      createTestProject(suite.projectDir, tsCode, {});

      const result = compileWithTransformer(suite.projectDir);

      // Should have compilation error about missing module
      expect(result.success).toBe(false);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    });

    it('should handle regular TypeScript compilation errors', () => {
      const tsCode = `import prompts from './resources/prompts.md';

// Type error: property doesn't exist
console.log(prompts.nonExistent);
`;

      const markdownFiles = {
        'prompts.md': `# Test

## Section

Content.`,
      };

      createTestProject(suite.projectDir, tsCode, markdownFiles);

      const result = compileWithTransformer(suite.projectDir);

      // Should have type error
      expect(result.success).toBe(false);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    });
  });

  describe('complex markdown structures', () => {
    it('should handle markdown with complex frontmatter', () => {
      const tsCode = `import doc from './resources/complex.md';

const title: string = doc.meta.title;
const version: number = doc.meta.version;
const enabled: boolean = doc.meta.enabled;
const tags: readonly string[] = doc.meta.tags;

console.log(title, version, enabled, tags);
`;

      const markdownFiles = {
        'complex.md': `---
title: Complex Document
version: 2.5
enabled: true
tags: [typescript, markdown, compiler]
---

# Complex

## Details

Detailed content.`,
      };

      compileTestProjectSuccess(suite.projectDir, tsCode, markdownFiles);
    });

    it('should handle markdown with many fragments', () => {
      const tsCode = `import guide from './resources/guide.md';

const sections = [
  guide.fragments.intro,
  guide.fragments.installation,
  guide.fragments.configuration,
  guide.fragments.usage,
  guide.fragments.troubleshooting,
];

console.log(sections.map(s => s.header).join(', '));
`;

      const markdownFiles = {
        'guide.md': `# Guide

## Intro

Introduction section.

## Installation

Installation steps.

## Configuration

Configuration details.

## Usage

Usage instructions.

## Troubleshooting

Troubleshooting tips.`,
      };

      compileTestProjectSuccess(suite.projectDir, tsCode, markdownFiles);
    });
  });
});
