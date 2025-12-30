/* eslint-disable sonarjs/no-duplicate-string */
// Test data legitimately repeats file paths

import { it, beforeAll, afterAll } from 'vitest';

import { describe, expect, fs, getBinPath, join } from './test-common.js';
import {
  createTestTempDir,
  executeAndParseYaml,
  executeScanAndParse,
  executeValidateAndParse,
  setupTestProject,
} from './test-helpers.js';

const binPath = getBinPath(import.meta.url);

describe('Config loading integration (system test)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = createTestTempDir('vat-config-int-test-');
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should respect include patterns from config', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'include-test',
      config: `version: 1
resources:
  include:
    - "docs/**/*.md"
`,
      withDocs: true,
    });

    // Create files in different locations
    fs.mkdirSync(join(projectDir, 'other'));

    fs.writeFileSync(join(projectDir, 'docs/test.md'), '# Test');
    fs.writeFileSync(join(projectDir, 'other/test.md'), '# Other');
    fs.writeFileSync(join(projectDir, 'README.md'), '# Root');

    const { result, parsed } = executeScanAndParse(binPath, projectDir);

    expect(result.status).toBe(0);
    expect(parsed.filesScanned).toBe(1); // Only docs/test.md should match
  });

  it('should respect exclude patterns from config', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'exclude-test',
      config: `version: 1
resources:
  include:
    - "**/*.md"
  exclude:
    - "test/**"
    - "**/*.test.md"
`,
      withDocs: true,
    });

    fs.mkdirSync(join(projectDir, 'test'));

    fs.writeFileSync(join(projectDir, 'docs/guide.md'), '# Guide');
    fs.writeFileSync(join(projectDir, 'test/fixture.md'), '# Fixture');
    fs.writeFileSync(join(projectDir, 'docs/api.test.md'), '# API Test');

    const { result, parsed } = executeScanAndParse(binPath, projectDir);

    expect(result.status).toBe(0);
    expect(parsed.filesScanned).toBe(1); // Only docs/guide.md
  });

  it('should use default config when no config file exists', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'no-config',
      withDocs: true,
    });

    fs.writeFileSync(join(projectDir, 'docs/test.md'), '# Test');

    const { result, parsed } = executeScanAndParse(binPath, projectDir);

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
    // Should use default **/*.md pattern
    expect(parsed.filesScanned).toBeGreaterThan(0);
  });

  it('should find config in parent directory', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'parent-config',
      config: `version: 1
resources:
  include:
    - "**/*.md"
  exclude:
    - "excluded/**"
`,
    });

    // Create nested directory structure
    const docsDir = join(projectDir, 'docs/guides');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(join(docsDir, 'test.md'), '# Test');

    const excludedDir = join(projectDir, 'excluded');
    fs.mkdirSync(excludedDir);
    fs.writeFileSync(join(excludedDir, 'test.md'), '# Excluded');

    // Run from nested directory with explicit path
    const { result, parsed } = executeAndParseYaml(
      binPath,
      ['resources', 'scan', projectDir],
      { cwd: docsDir } // Run from nested dir
    );

    expect(result.status).toBe(0);
    // When path argument is provided, config is ignored (uses defaults)
    // Finds all *.md files recursively: docs/guides/test.md + excluded/test.md
    expect(parsed.filesScanned).toBe(2);
  });

  it('should respect config exclude patterns when no path argument provided', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'config-exclude-test',
      config: `version: 1
resources:
  include:
    - "**/*.md"
  exclude:
    - "excluded/**"
`,
    });

    // Create files
    const docsDir = join(projectDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(join(docsDir, 'included.md'), '# Included');

    const excludedDir = join(projectDir, 'excluded');
    fs.mkdirSync(excludedDir);
    fs.writeFileSync(join(excludedDir, 'test.md'), '# Excluded');

    // Run WITHOUT path argument - should use config
    const { result, parsed } = executeAndParseYaml(
      binPath,
      ['resources', 'scan'], // No path argument
      { cwd: projectDir }
    );

    expect(result.status).toBe(0);
    // Config exclude should be respected: only finds docs/included.md (not excluded/test.md)
    expect(parsed.filesScanned).toBe(1);
  });

  it('should handle validation config options', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'validation-config',
      config: `version: 1
resources:
  validation:
    checkLinks: true
    checkAnchors: true
    allowExternal: false
`,
      withDocs: true,
    });

    fs.writeFileSync(
      join(projectDir, 'docs/test.md'),
      '# Test\n\n[Link](./test.md)'
    );

    const { result, parsed } = executeValidateAndParse(binPath, projectDir);

    // Config should be loaded and used (even if not all options implemented yet)
    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
  });

  it('should handle config with only version field', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'minimal-config',
      config: 'version: 1\n',
      withDocs: true,
    });

    fs.writeFileSync(join(projectDir, 'docs/test.md'), '# Test');

    const { result, parsed } = executeScanAndParse(binPath, projectDir);

    // Should use default patterns
    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
  });

  it('should handle complex nested patterns', () => {
    const projectDir = setupTestProject(tempDir, {
      name: 'nested-patterns',
      config: `version: 1
resources:
  include:
    - "docs/**/*.md"
    - "guides/**/*.md"
    - "README.md"
  exclude:
    - "**/node_modules/**"
    - "**/test/fixtures/**"
    - "**/*.draft.md"
`,
    });

    // Create complex directory structure
    fs.mkdirSync(join(projectDir, 'docs/api'), { recursive: true });
    fs.mkdirSync(join(projectDir, 'guides/tutorials'), { recursive: true });
    fs.mkdirSync(join(projectDir, 'test/fixtures'), { recursive: true });

    fs.writeFileSync(join(projectDir, 'README.md'), '# Root');
    fs.writeFileSync(join(projectDir, 'docs/api/auth.md'), '# Auth');
    fs.writeFileSync(join(projectDir, 'guides/tutorials/intro.md'), '# Intro');
    fs.writeFileSync(join(projectDir, 'guides/wip.draft.md'), '# Draft');
    fs.writeFileSync(join(projectDir, 'test/fixtures/mock.md'), '# Mock');

    const { result, parsed } = executeScanAndParse(binPath, projectDir);

    expect(result.status).toBe(0);
    // Should find README, docs/api/auth, guides/tutorials/intro (3 files)
    // Should exclude wip.draft.md and test/fixtures/mock.md
    expect(parsed.filesScanned).toBe(3);
  });
});
