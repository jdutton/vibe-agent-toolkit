import { existsSync, readFileSync, rmSync } from 'node:fs';


import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { MARKETPLACE_VALIDATE_REPORT_SCHEMA, type MarketplaceValidateReport } from '../../src/commands/claude/marketplace/validate-schema.js';

import {
  createTempDirTracker,
  executeCliAndParseYaml,
  getBinPath,
  writeTestFile,
} from './test-common.js';

const binPath = getBinPath(import.meta.url);
const TEMP_DIR_PREFIX = 'vat-marketplace-validate-test-';
const VALIDATE_ARGS = ['claude', 'marketplace', 'validate'] as const;

/**
 * Create a minimal valid marketplace directory structure.
 */
function createValidMarketplace(tempDir: string): void {
  // marketplace.json
  mkdirSyncReal(safePath.join(tempDir, '.claude-plugin'), { recursive: true });
  writeTestFile(
    safePath.join(tempDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'test-mp',
      description: 'Test marketplace',
      version: '1.0.0',
      owner: { name: 'Test Owner' },
      plugins: [{ name: 'test-plugin', source: './plugins/test-plugin' }],
    }),
  );

  // plugin with valid plugin.json
  mkdirSyncReal(safePath.join(tempDir, 'plugins', 'test-plugin', '.claude-plugin'), { recursive: true });
  writeTestFile(
    safePath.join(tempDir, 'plugins', 'test-plugin', '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'test-plugin', description: 'Test plugin', version: '1.0.0', author: { name: 'Test Owner' }, license: 'MIT' }),
  );

  // skill within plugin
  mkdirSyncReal(safePath.join(tempDir, 'plugins', 'test-plugin', 'skills', 'test-skill'), { recursive: true });
  writeTestFile(
    safePath.join(tempDir, 'plugins', 'test-plugin', 'skills', 'test-skill', 'SKILL.md'),
    [
      '---',
      'name: test-skill',
      'description: A comprehensive test skill for marketplace validation and packaging tests',
      'metadata:',
      '  version: 1.0.0',
      '---',
      '',
      '# test-skill',
      '',
      'This is a test skill for marketplace validation.',
    ].join('\n'),
  );

  // Required files
  writeTestFile(safePath.join(tempDir, 'LICENSE'), 'MIT License\n\nCopyright (c) 2025 Test');
  writeTestFile(safePath.join(tempDir, 'README.md'), '# Test Marketplace\n\nA test marketplace.');
  writeTestFile(safePath.join(tempDir, 'CHANGELOG.md'), '# Changelog\n\n## 1.0.0\n\n- Initial release');
}

/** Run marketplace validate; the published document parsed with the verb's own registry schema. */
async function validateMarketplaceAt(tempDir: string): Promise<{ status: number | null; document: MarketplaceValidateReport }> {
  const { result, parsed } = await executeCliAndParseYaml(binPath, [...VALIDATE_ARGS, tempDir]);
  return { status: result.status, document: MARKETPLACE_VALIDATE_REPORT_SCHEMA.parse(parsed) as MarketplaceValidateReport };
}

/**
 * Run marketplace validate and assert a specific finding is published with the
 * expected severity. Every finding is flat on the envelope, so the code and the
 * severity it resolved to are stated together at every verbosity.
 */
async function validateAndExpectIssue(
  tempDir: string,
  expectedCode: string,
  expectedSeverity: string,
  expectedExitCode: number,
): Promise<void> {
  const { status, document } = await validateMarketplaceAt(tempDir);

  expect(status).toBe(expectedExitCode);
  const matchingIssue = document.findings.find(i => i.code === expectedCode);
  expect(matchingIssue).toBeDefined();
  expect(matchingIssue?.severity).toBe(expectedSeverity);
}

describe('vat claude marketplace validate (system)', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker(TEMP_DIR_PREFIX);

  afterEach(() => {
    cleanupTempDirs();
  });

  it('should validate a valid marketplace directory with exit 0', async () => {
    const tempDir = createTempDir();
    createValidMarketplace(tempDir);

    expect(existsSync(safePath.join(tempDir, '.claude-plugin', 'marketplace.json'))).toBe(true);

    const { status, document } = await validateMarketplaceAt(tempDir);

    expect(status).toBe(0);
    expect(document.status).toBe('ok');
    expect(document.examined).toBe(1);
    expect(document.data.root).toBe(tempDir);
    expect(document.data.plugins.map((plugin) => [plugin.name, plugin.path, plugin.manifestRead, plugin.status])).toEqual([
      ['test-plugin', 'plugins/test-plugin', true, 'ok'],
    ]);
  });

  it('should fail with exit 1 when marketplace.json is missing', async () => {
    const tempDir = createTempDir();
    mkdirSyncReal(tempDir, { recursive: true });

    const { status, document } = await validateMarketplaceAt(tempDir);

    // A finding about the directory, exit 1 — the path exists, so it is not a refusal.
    expect(status).toBe(1);
    expect(document.status).toBe('findings');
    expect(document.data.marketplace).toBeNull();
    expect(document.findings.map((finding) => finding.code)).toContain('MARKETPLACE_MISSING_MANIFEST');
  });

  it('should report MARKETPLACE_MISSING_LICENSE as error when LICENSE is missing', async () => {
    const tempDir = createTempDir();
    createValidMarketplace(tempDir);
    rmSync(safePath.join(tempDir, 'LICENSE'));

    await validateAndExpectIssue(tempDir, 'MARKETPLACE_MISSING_LICENSE', 'error', 1);
  });

  it('should report PLUGIN_MISSING_VERSION as error (not warning) in strict mode', async () => {
    const tempDir = createTempDir();
    createValidMarketplace(tempDir);

    // Overwrite plugin.json without version
    writeTestFile(
      safePath.join(tempDir, 'plugins', 'test-plugin', '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'test-plugin', description: 'Test plugin' }),
    );

    await validateAndExpectIssue(tempDir, 'PLUGIN_MISSING_VERSION', 'error', 1);
  });

  it('should exit 0 with warning when README.md is missing', async () => {
    const tempDir = createTempDir();
    createValidMarketplace(tempDir);
    rmSync(safePath.join(tempDir, 'README.md'));

    await validateAndExpectIssue(tempDir, 'MARKETPLACE_MISSING_README', 'warning', 0);
  });

  it('should report LINK_INTEGRITY_BROKEN as error for a skill link that escapes the skill boundary to a missing target (Fix 3)', async () => {
    const tempDir = createTempDir();
    createValidMarketplace(tempDir);

    const skillPath = safePath.join(tempDir, 'plugins', 'test-plugin', 'skills', 'test-skill', 'SKILL.md');
    const skillContent = readFileSync(skillPath, 'utf-8');
    writeTestFile(
      skillPath,
      `${skillContent}\n\nSee [escaped](../nonexistent.md) for details.\n`,
    );

    await validateAndExpectIssue(tempDir, 'LINK_INTEGRITY_BROKEN', 'error', 1);
  });
});
