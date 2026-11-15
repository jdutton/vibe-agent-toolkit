// Test file — all file operations are in temp directories, duplicated strings acceptable
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';


import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { composePublishTree, type ComposeOptions } from '../../../../src/commands/claude/marketplace/publish-tree.js';
import { refusalCodeOf } from '../../../../src/utils/command-refusal.js';

function makeTempDir(tempDirs: string[]): string {
  const dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-publish-tree-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * Create a minimal marketplace build output under sourceDir so composePublishTree
 * can find it. Returns the marketplace name used.
 *
 * Pass `plugins` to seed entries into the staged marketplace.json — used by
 * tests that exercise version derivation from staged content.
 */
function seedMarketplaceBuild(
  sourceDir: string,
  mpName = 'test-mp',
  plugins: { name: string; version?: string }[] = [],
): string {
  const pluginDir = safePath.join(
    sourceDir, 'dist', '.claude', 'plugins', 'marketplaces', mpName, '.claude-plugin',
  );
  mkdirSyncReal(pluginDir, { recursive: true });
  const json: Record<string, unknown> = { name: mpName };
  if (plugins.length > 0) {
    json.plugins = plugins;
  }
  writeFileSync(safePath.join(pluginDir, 'marketplace.json'), JSON.stringify(json));
  return mpName;
}

/**
 * Seed a marketplace build with the given plugin entries and run
 * composePublishTree against it, returning the result. Used by the issue-#110
 * version derivation tests so each case stays focused on its assertion.
 */
async function deriveVersionFor(
  tempDirs: string[],
  mpName: string,
  plugins: { name: string; version?: string }[],
) {
  const sourceDir = makeTempDir(tempDirs);
  const outputDir = makeTempDir(tempDirs);
  seedMarketplaceBuild(sourceDir, mpName, plugins);
  return composePublishTree({
    marketplaceName: mpName,
    configDir: sourceDir,
    outputDir,
  });
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
    const mpName = seedMarketplaceBuild(sourceDir, 'test-mp', [
      { name: 'only-plugin', version: '1.0.0' },
    ]);

    const sourceChangelog = '# Changelog\n\n## [Unreleased]\n\n### Added\n- Feature\n';
    writeFileSync(safePath.join(sourceDir, 'CHANGELOG.md'), sourceChangelog);
    writeFileSync(safePath.join(sourceDir, 'README.md'), '# My Marketplace\n');

    const result = await composePublishTree({
      marketplaceName: mpName,
      configDir: sourceDir,
      outputDir,
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
    })).rejects.toThrow(/build output/i);
  });

  it('refuses missing build output as INPUT_UNREADABLE, naming it project-relative', async () => {
    const sourceDir = makeTempDir(tempDirs);
    const error = await composePublishTree({ marketplaceName: 'nonexistent', configDir: sourceDir, outputDir: makeTempDir(tempDirs) })
      .then(() => undefined, (thrown: unknown) => thrown);
    expect(refusalCodeOf(error)).toBe('INPUT_UNREADABLE');
    expect((error as Error).message).toBe('Marketplace build output not found at dist/.claude/plugins/marketplaces/nonexistent. Run "vat build" first.');
  });

  // A build that stopped half-way leaves the directory and no manifest. That is
  // the project's state, never a defect in VAT: it must not surface as a raw ENOENT.
  it('refuses build output holding no marketplace.json as INPUT_UNREADABLE, naming it project-relative', async () => {
    const sourceDir = makeTempDir(tempDirs);
    mkdirSyncReal(safePath.join(sourceDir, 'dist', '.claude', 'plugins', 'marketplaces', 'half-built', 'plugins'), { recursive: true });
    const error = await composePublishTree({ marketplaceName: 'half-built', configDir: sourceDir, outputDir: makeTempDir(tempDirs) })
      .then(() => undefined, (thrown: unknown) => thrown);
    expect(refusalCodeOf(error)).toBe('INPUT_UNREADABLE');
    expect((error as Error).message).toBe(
      'Marketplace build output at dist/.claude/plugins/marketplaces/half-built holds no .claude-plugin/marketplace.json — the build did not finish. Run "vat build" first.',
    );
  });

  // A damaged manifest is the project's state — whether it is not JSON at all, or
  // valid JSON that is not a manifest — never a SyntaxError or TypeError out of VAT.
  it.each([
    ['not JSON', '{ "name": ', 'is not valid JSON'],
    ['null', 'null', 'is not a marketplace manifest'],
    ['an array', '[]', 'is not a marketplace manifest'],
    ['a non-array plugins', '{"plugins":"all"}', 'is not a marketplace manifest'],
    ['a plugins entry that is not an object', '{"plugins":[null]}', 'is not a marketplace manifest'],
  ])('refuses a built marketplace.json that is %s as INPUT_UNREADABLE', async (_what, body, why) => {
    const sourceDir = makeTempDir(tempDirs);
    const mpName = seedMarketplaceBuild(sourceDir);
    writeFileSync(
      safePath.join(sourceDir, 'dist', '.claude', 'plugins', 'marketplaces', mpName, '.claude-plugin', 'marketplace.json'),
      body,
    );
    const error = await composePublishTree({ marketplaceName: mpName, configDir: sourceDir, outputDir: makeTempDir(tempDirs) })
      .then(() => undefined, (thrown: unknown) => thrown);
    expect(refusalCodeOf(error)).toBe('INPUT_UNREADABLE');
    expect((error as Error).message).toContain(`dist/.claude/plugins/marketplaces/${mpName}/.claude-plugin/marketplace.json ${why}`);
  });

  // A `publish.<key>` naming a file that is not there is the config's mistake.
  it.each<[string, Partial<ComposeOptions>]>([
    ['publish.changelog', { changelog: { sourcePath: 'NOPE.md' } }],
    ['publish.readme', { readme: { sourcePath: 'NOPE.md' } }],
    ['publish.license', { license: { type: 'file', filePath: 'NOPE.md' } }],
  ])('refuses a %s naming no file as CONFIG_INVALID', async (key, configured) => {
    const sourceDir = makeTempDir(tempDirs);
    const mpName = seedMarketplaceBuild(sourceDir, 'test-mp', [{ name: 'only-plugin', version: '1.0.0' }]);
    const error = await composePublishTree({ marketplaceName: mpName, configDir: sourceDir, outputDir: makeTempDir(tempDirs), ...configured })
      .then(() => undefined, (thrown: unknown) => thrown);
    expect(refusalCodeOf(error)).toBe('CONFIG_INVALID');
    expect((error as Error).message).toBe(`${key} names NOPE.md, which does not exist.`);
  });

  it('refuses a changelog with no release notes as INPUT_UNREADABLE', async () => {
    const sourceDir = makeTempDir(tempDirs);
    const mpName = seedMarketplaceBuild(sourceDir, 'test-mp', [{ name: 'only-plugin', version: '1.0.0' }]);
    writeFileSync(safePath.join(sourceDir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n');
    const error = await composePublishTree({
      marketplaceName: mpName, configDir: sourceDir, outputDir: makeTempDir(tempDirs), changelog: { sourcePath: 'CHANGELOG.md' },
    }).then(() => undefined, (thrown: unknown) => thrown);
    expect(refusalCodeOf(error)).toBe('INPUT_UNREADABLE');
  });

  it('should fail when changelog has neither unreleased content nor matching version section', async () => {
    const sourceDir = makeTempDir(tempDirs);
    const outputDir = makeTempDir(tempDirs);
    const mpName = seedMarketplaceBuild(sourceDir, 'test-mp', [
      { name: 'only-plugin', version: '1.0.0' },
    ]);

    // Empty [Unreleased] and a stamped section for a DIFFERENT version
    writeFileSync(
      safePath.join(sourceDir, 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\n### Added\n- Old\n',
    );

    await expect(composePublishTree({
      marketplaceName: mpName,
      configDir: sourceDir,
      outputDir,
      changelog: { sourcePath: 'CHANGELOG.md' },
    })).rejects.toThrow(/neither.*\[Unreleased\].*nor.*\[1\.0\.0\]/i);
  });

  it('should publish a pre-stamped changelog when [Unreleased] is empty (Workflow B)', async () => {
    const sourceDir = makeTempDir(tempDirs);
    const outputDir = makeTempDir(tempDirs);
    const mpName = seedMarketplaceBuild(sourceDir, 'test-mp', [
      { name: 'only-plugin', version: '1.2.0' },
    ]);

    const sourceChangelog =
      '# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - 2026-04-09\n\n### Added\n- New feature X\n- New feature Y\n\n## [1.1.0] - 2026-03-15\n\n### Fixed\n- Old bug\n';
    writeFileSync(safePath.join(sourceDir, 'CHANGELOG.md'), sourceChangelog);

    const result = await composePublishTree({
      marketplaceName: mpName,
      configDir: sourceDir,
      outputDir,
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
    const mpName = seedMarketplaceBuild(sourceDir, 'test-mp', [
      { name: 'only-plugin', version: '1.2.0' },
    ]);

    const sourceChangelog =
      '# Changelog\n\n## [Unreleased]\n\n### Added\n- Work-in-progress for next release\n\n## [1.2.0] - 2026-04-09\n\n### Added\n- Released feature\n';
    writeFileSync(safePath.join(sourceDir, 'CHANGELOG.md'), sourceChangelog);

    const result = await composePublishTree({
      marketplaceName: mpName,
      configDir: sourceDir,
      outputDir,
      changelog: { sourcePath: 'CHANGELOG.md' },
    });

    // Commit body comes from the stamped section, not [Unreleased].
    expect(result.changelogDelta).toContain('Released feature');
    expect(result.changelogDelta).not.toContain('Work-in-progress');

    // Published CHANGELOG is BYTE-IDENTICAL (both sections preserved, nothing mutated).
    const changelogContent = readFileSync(safePath.join(outputDir, 'CHANGELOG.md'), 'utf-8');
    expect(changelogContent).toBe(sourceChangelog);
  });

  // Issue #110: ComposeResult.version must reflect what is actually being published —
  // derived from the staged marketplace.json, not the project root package.json that
  // the caller previously passed in.

  it('derives version from the single plugin when the marketplace has exactly one plugin', async () => {
    const result = await deriveVersionFor(tempDirs, 'single-mp', [
      { name: 'only-plugin', version: '0.0.4' },
    ]);
    expect(result.version).toBe('0.0.4');
  });

  it('returns undefined version when the marketplace has multiple plugins', async () => {
    const result = await deriveVersionFor(tempDirs, 'multi-mp', [
      { name: 'plugin-a', version: '0.1.0' },
      { name: 'plugin-b', version: '0.2.0' },
    ]);
    expect(result.version).toBeUndefined();
  });

  it('returns undefined version when no plugin entry has a usable version field', async () => {
    const result = await deriveVersionFor(tempDirs, 'unversioned-mp', [
      { name: 'only-plugin' },
    ]);
    expect(result.version).toBeUndefined();
  });
});
