/* eslint-disable security/detect-non-literal-fs-filename, sonarjs/no-duplicate-string */
// Test file — all file operations are in temp directories, duplicated strings acceptable
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';


import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { composePublishTree } from '../../../../src/commands/claude/marketplace/publish-tree.js';

function makeTempDir(tempDirs: string[]): string {
  const dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-publish-tree-'));
  tempDirs.push(dir);
  return dir;
}

describe('publish-tree', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('should compose tree with marketplace artifacts, changelog, readme, and license', async () => {
    const sourceDir = makeTempDir(tempDirs);
    const outputDir = makeTempDir(tempDirs);

    // Create mock marketplace build output
    const mpDir = safePath.join(sourceDir, 'dist', '.claude', 'plugins', 'marketplaces', 'test-mp');
    const pluginDir = safePath.join(mpDir, '.claude-plugin');
    mkdirSyncReal(pluginDir, { recursive: true });
    writeFileSync(safePath.join(pluginDir, 'marketplace.json'), '{"name":"test-mp"}');

    // Create changelog source
    writeFileSync(safePath.join(sourceDir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### Added\n- Feature\n');

    // Create readme source
    writeFileSync(safePath.join(sourceDir, 'README.md'), '# My Marketplace\n');

    const result = await composePublishTree({
      marketplaceName: 'test-mp',
      configDir: sourceDir,
      outputDir,
      version: '1.0.0',
      date: '2026-04-01',
      changelog: { sourcePath: 'CHANGELOG.md' },
      readme: { sourcePath: 'README.md' },
      license: { type: 'spdx', value: 'mit', ownerName: 'Test Org' },
    });

    expect(existsSync(safePath.join(outputDir, '.claude-plugin', 'marketplace.json'))).toBe(true);
    expect(existsSync(safePath.join(outputDir, 'CHANGELOG.md'))).toBe(true);
    expect(existsSync(safePath.join(outputDir, 'README.md'))).toBe(true);
    expect(existsSync(safePath.join(outputDir, 'LICENSE'))).toBe(true);
    expect(result.version).toBe('1.0.0');

    // Changelog should be stamped
    const changelogContent = readFileSync(safePath.join(outputDir, 'CHANGELOG.md'), 'utf-8');
    expect(changelogContent).toContain('[1.0.0] - 2026-04-01');
  });

  it('should fail when build output does not exist', async () => {
    const sourceDir = makeTempDir(tempDirs);
    const outputDir = makeTempDir(tempDirs);

    await expect(composePublishTree({
      marketplaceName: 'nonexistent',
      configDir: sourceDir,
      outputDir,
      version: '1.0.0',
      date: '2026-04-01',
    })).rejects.toThrow(/build output/i);
  });

  it('should fail when changelog has empty unreleased section', async () => {
    const sourceDir = makeTempDir(tempDirs);
    const outputDir = makeTempDir(tempDirs);

    // Create marketplace build output
    const mpDir = safePath.join(sourceDir, 'dist', '.claude', 'plugins', 'marketplaces', 'test-mp', '.claude-plugin');
    mkdirSyncReal(mpDir, { recursive: true });
    writeFileSync(safePath.join(mpDir, 'marketplace.json'), '{}');

    // Empty unreleased changelog
    writeFileSync(safePath.join(sourceDir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n## [0.1.0]\n');

    await expect(composePublishTree({
      marketplaceName: 'test-mp',
      configDir: sourceDir,
      outputDir,
      version: '1.0.0',
      date: '2026-04-01',
      changelog: { sourcePath: 'CHANGELOG.md' },
    })).rejects.toThrow(/empty/i);
  });
});
