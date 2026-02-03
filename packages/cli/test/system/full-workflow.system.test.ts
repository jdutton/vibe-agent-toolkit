/* eslint-disable sonarjs/slow-regex */
// Test assertions legitimately use regex patterns

import { it, beforeAll, afterAll } from 'vitest';

import { describe, expect, fs, getBinPath, join, spawnSync } from './test-common.js';
import {
  createTestTempDir,
  executeCli,
  executeScanAndParse,
  executeValidateAndParse,
  setupTestProject,
} from './test-helpers.js';

const binPath = getBinPath(import.meta.url);

describe('Full CLI workflow (system test)', () => {
  let tempDir: string;
  let projectDir: string;

  beforeAll(() => {
    tempDir = createTestTempDir('vat-system-test-');

    const configContent = `version: 1
resources:
  include:
    - "docs/**/*.md"
  exclude:
    - "node_modules/**"
`;
    projectDir = setupTestProject(tempDir, {
      name: 'test-project',
      config: configContent,
      withDocs: true,
    });

    const docsDir = join(projectDir, 'docs');
    fs.writeFileSync(
      join(docsDir, 'README.md'),
      '# Documentation\n\n[Guide](./guide.md)\n[API](#api)\n\n## API\n\nAPI docs here.'
    );

    fs.writeFileSync(
      join(docsDir, 'guide.md'),
      '# Guide\n\n[Back to README](./README.md)'
    );

    fs.writeFileSync(
      join(docsDir, 'broken.md'),
      '# Broken\n\n[Missing](./missing.md)\n[Bad anchor](./README.md#nonexistent)'
    );
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should scan project and find all resources', () => {
    const { result, parsed } = executeScanAndParse(binPath, projectDir);

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
    expect(parsed.filesScanned).toBe(3); // README, guide, broken
    expect(parsed.linksFound).toBeGreaterThan(0);
  });

  it('should validate and detect broken links', () => {
    const { result, parsed } = executeValidateAndParse(binPath, projectDir);

    expect(result.status).toBe(1); // Validation failed
    expect(parsed.status).toBe('failed');
    expect(parsed.errorsFound).toBe(2); // missing.md + #nonexistent

    // Check test-format errors on stderr (use text format)
    const textResult = executeCli(binPath, ['resources', 'validate', '--format', 'text'], { cwd: projectDir });
    expect(textResult.stderr).toContain('broken.md');
    expect(textResult.stderr).toContain('missing.md');
    expect(textResult.stderr).toContain('#nonexistent');
  });

  it('should validate successfully after fixing links', () => {
    // Fix broken.md
    fs.writeFileSync(
      join(projectDir, 'docs/broken.md'),
      '# Fixed\n\n[Back](./README.md#api)'
    );

    const { result, parsed } = executeValidateAndParse(binPath, projectDir);

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
  });

  it('should show version with context in dev mode', () => {
    const result = spawnSync('node', [binPath, '--version'], {
      encoding: 'utf-8',
      env: { ...process.env, VAT_CONTEXT: 'dev', VAT_CONTEXT_PATH: '/test/path' },
    });

    expect(result.status).toBe(0);
    // eslint-disable-next-line security/detect-unsafe-regex -- Simple semver pattern for test validation
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+(-[a-z0-9.]+)?-dev \(\/test\/path\)/);
  });

  it('should show comprehensive help with --help --verbose', () => {
    const result = spawnSync('node', [binPath, '--help', '--verbose'], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('# vat - Vibe Agent Toolkit CLI');
    expect(result.stdout).toContain('resources');
    expect(result.stdout).toContain('Exit Code Summary');
  });

  it('should show resources verbose help', () => {
    const result = spawnSync('node', [binPath, 'resources', '--help', '--verbose'], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('vat resources');
    expect(result.stdout).toContain('scan');
    expect(result.stdout).toContain('validate');
  });

  it('should ignore external URLs and not report them as errors', () => {
    // Create a file with only external URLs (no broken internal links)
    fs.writeFileSync(
      join(projectDir, 'docs/external.md'),
      '# External Links\n\n[GitHub](https://github.com)\n[NPM](https://npmjs.com)\n[Docs](https://example.com/docs)'
    );

    const { result, parsed } = executeValidateAndParse(binPath, projectDir);

    // Should pass validation (external URLs are not validated)
    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');

    // Should not have any errors
    expect(parsed.errorsFound).toBeUndefined();

    // Stdout should not contain "External URL" messages
    expect(result.stdout).not.toContain('External URL');
    expect(result.stdout).not.toContain('external_url');
  });
});
