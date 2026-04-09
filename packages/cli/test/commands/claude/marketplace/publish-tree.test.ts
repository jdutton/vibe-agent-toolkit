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

/**
 * Create a minimal marketplace build output under sourceDir so composePublishTree
 * can find it. Returns the marketplace name used.
 */
function seedMarketplaceBuild(sourceDir: string, mpName = 'test-mp'): string {
  const pluginDir = safePath.join(
    sourceDir, 'dist', '.claude', 'plugins', 'marketplaces', mpName, '.claude-plugin',
  );
  mkdirSyncReal(pluginDir, { recursive: true });
  writeFileSync(safePath.join(pluginDir, 'marketplace.json'), `{"name":"${mpName}"}`);
  return mpName;
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
    const mpName = seedMarketplaceBuild(sourceDir);

    const sourceChangelog = '# Changelog\n\n## [Unreleased]\n\n### Added\n- Feature\n';
    writeFileSync(safePath.join(sourceDir, 'CHANGELOG.md'), sourceChangelog);
    writeFileSync(safePath.join(sourceDir, 'README.md'), '# My Marketplace\n');

    const result = await composePublishTree({
      marketplaceName: mpName,
      configDir: sourceDir,
      outputDir,
      version: '1.0.0',
      changelog: { sourcePath: 'CHANGELOG.md' },
      readme: { sourcePath: 'README.md' },
      license: { type: 'spdx', value: 'mit', ownerName: 'Test Org' },
    });

    expect(existsSync(safePath.join(outputDir, '.claude-plugin', 'marketplace.json'))).toBe(true);
    expect(existsSync(safePath.join(outputDir, 'CHANGELOG.md'))).toBe(true);
    expect(existsSync(safePath.join(outputDir, 'README.md'))).toBe(true);
    expect(existsSync(safePath.join(outputDir, 'LICENSE'))).toBe(true);
    expect(result.version).toBe('1.0.0');

    // CHANGELOG must be copied BYTE-FOR-BYTE — no stamping, no mutation.
    const changelogContent = readFileSync(safePath.join(outputDir, 'CHANGELOG.md'), 'utf-8');
    expect(changelogContent).toBe(sourceChangelog);

    // Release notes still flow to the commit body via changelogDelta.
    expect(result.changelogDelta).toContain('### Added');
    expect(result.changelogDelta).toContain('- Feature');
  });

  it('should fail when build output does not exist', async () => {
    const sourceDir = makeTempDir(tempDirs);
    const outputDir = makeTempDir(tempDirs);

    await expect(composePublishTree({
      marketplaceName: 'nonexistent',
      configDir: sourceDir,
      outputDir,
      version: '1.0.0',
    })).rejects.toThrow(/build output/i);
  });

  it('should fail when changelog has neither unreleased content nor matching version section', async () => {
    const sourceDir = makeTempDir(tempDirs);
    const outputDir = makeTempDir(tempDirs);
    const mpName = seedMarketplaceBuild(sourceDir);

    // Empty [Unreleased] and a stamped section for a DIFFERENT version
    writeFileSync(
      safePath.join(sourceDir, 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\n### Added\n- Old\n',
    );

    await expect(composePublishTree({
      marketplaceName: mpName,
      configDir: sourceDir,
      outputDir,
      version: '1.0.0',
      changelog: { sourcePath: 'CHANGELOG.md' },
    })).rejects.toThrow(/neither.*\[Unreleased\].*nor.*\[1\.0\.0\]/i);
  });

  it('should publish a pre-stamped changelog when [Unreleased] is empty (Workflow B)', async () => {
    const sourceDir = makeTempDir(tempDirs);
    const outputDir = makeTempDir(tempDirs);
    const mpName = seedMarketplaceBuild(sourceDir);

    const sourceChangelog =
      '# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - 2026-04-09\n\n### Added\n- New feature X\n- New feature Y\n\n## [1.1.0] - 2026-03-15\n\n### Fixed\n- Old bug\n';
    writeFileSync(safePath.join(sourceDir, 'CHANGELOG.md'), sourceChangelog);

    const result = await composePublishTree({
      marketplaceName: mpName,
      configDir: sourceDir,
      outputDir,
      version: '1.2.0',
      changelog: { sourcePath: 'CHANGELOG.md' },
    });

    expect(result.version).toBe('1.2.0');
    // Commit body uses the stamped [1.2.0] section, not [Unreleased] and not [1.1.0].
    expect(result.changelogDelta).toContain('New feature X');
    expect(result.changelogDelta).toContain('New feature Y');
    expect(result.changelogDelta).not.toContain('Old bug');

    // Published CHANGELOG is BYTE-IDENTICAL to source.
    const changelogContent = readFileSync(safePath.join(outputDir, 'CHANGELOG.md'), 'utf-8');
    expect(changelogContent).toBe(sourceChangelog);
  });

  it('should prefer stamped [X.Y.Z] over [Unreleased] when both have content', async () => {
    const sourceDir = makeTempDir(tempDirs);
    const outputDir = makeTempDir(tempDirs);
    const mpName = seedMarketplaceBuild(sourceDir);

    const sourceChangelog =
      '# Changelog\n\n## [Unreleased]\n\n### Added\n- Work-in-progress for next release\n\n## [1.2.0] - 2026-04-09\n\n### Added\n- Released feature\n';
    writeFileSync(safePath.join(sourceDir, 'CHANGELOG.md'), sourceChangelog);

    const result = await composePublishTree({
      marketplaceName: mpName,
      configDir: sourceDir,
      outputDir,
      version: '1.2.0',
      changelog: { sourcePath: 'CHANGELOG.md' },
    });

    // Commit body comes from the stamped section, not [Unreleased].
    expect(result.changelogDelta).toContain('Released feature');
    expect(result.changelogDelta).not.toContain('Work-in-progress');

    // Published CHANGELOG is BYTE-IDENTICAL (both sections preserved, nothing mutated).
    const changelogContent = readFileSync(safePath.join(outputDir, 'CHANGELOG.md'), 'utf-8');
    expect(changelogContent).toBe(sourceChangelog);
  });
});
