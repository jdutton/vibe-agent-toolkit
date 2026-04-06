/**
 * Unified vat install command — system tests
 *
 * Tests auto-detection of resource type and correct routing to install directory.
 */

import * as fs from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cleanupTestTempDir,
  createTestTempDir,
  executeCli,
  getBinPath,
  writeTestFile,
} from './test-common.js';

/**
 * Create isolated source and install directories for a test scenario.
 * Returns both dirs so the caller can create resources in sourceDir and verify installDir.
 */
function createTestDirs(
  tempDir: string,
  scenario: string,
): { sourceDir: string; installDir: string } {
  const sourceDir = safePath.join(tempDir, `${scenario}-sources`);
  const installDir = safePath.join(tempDir, `${scenario}-install`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirs are controlled in tests
  fs.mkdirSync(sourceDir, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirs are controlled in tests
  fs.mkdirSync(installDir, { recursive: true });
  return { sourceDir, installDir };
}

/**
 * Run `vat install` and return the result.
 */
function runInstall(
  binPath: string,
  cwd: string,
  resourcePath: string,
  installFlags: string[],
  extraFlags: string[] = [],
): ReturnType<typeof executeCli> {
  return executeCli(binPath, ['install', resourcePath, ...installFlags, ...extraFlags], { cwd });
}

/**
 * Set up a minimal agent skill directory with SKILL.md at root.
 */
function createSkillDir(parentDir: string, name: string): string {
  const skillDir = safePath.join(parentDir, name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- skillDir is controlled in tests
  fs.mkdirSync(skillDir, { recursive: true });
  writeTestFile(
    safePath.join(skillDir, 'SKILL.md'),
    `---
name: ${name}
description: Test skill for unified install command
version: 1.0.0
---

# ${name}

This is a test skill.
`
  );
  return skillDir;
}

/**
 * Set up a minimal claude plugin directory with .claude-plugin/plugin.json.
 */
function createPluginDir(parentDir: string, name: string): string {
  const pluginDir = safePath.join(parentDir, name);
  const claudePluginDir = safePath.join(pluginDir, '.claude-plugin');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirs are controlled in tests
  fs.mkdirSync(claudePluginDir, { recursive: true });
  writeTestFile(
    safePath.join(claudePluginDir, 'plugin.json'),
    JSON.stringify({
      type: 'plugin',
      name,
      resources: [],
    })
  );
  return pluginDir;
}

/**
 * Set up a minimal claude marketplace directory with .claude-plugin/marketplace.json.
 */
function createMarketplaceDir(parentDir: string, name: string): string {
  const marketplaceDir = safePath.join(parentDir, name);
  const claudePluginDir = safePath.join(marketplaceDir, '.claude-plugin');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirs are controlled in tests
  fs.mkdirSync(claudePluginDir, { recursive: true });
  writeTestFile(
    safePath.join(claudePluginDir, 'marketplace.json'),
    JSON.stringify({
      type: 'marketplace',
      name,
      resources: [],
    })
  );
  return marketplaceDir;
}

// CLI flag constants to avoid string duplication (sonarjs/no-duplicate-string)
const SKILLS_DIR_FLAG = '--skills-dir';
const PLUGINS_DIR_FLAG = '--plugins-dir';
const MARKETPLACES_DIR_FLAG = '--marketplaces-dir';

describe('Unified vat install command (system test)', () => {
  let binPath: string;
  let tempDir: string;

  beforeAll(() => {
    binPath = getBinPath(import.meta.url);
    tempDir = createTestTempDir('vat-install-unified-');
  });

  afterAll(() => {
    cleanupTestTempDir(tempDir);
  });

  it('auto-detects agent skill from SKILL.md and installs', () => {
    const { sourceDir, installDir } = createTestDirs(tempDir, 'skill');
    const skillDir = createSkillDir(sourceDir, 'test-skill');

    const result = runInstall(binPath, tempDir, skillDir, [SKILLS_DIR_FLAG, installDir]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('agent-skill');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- installDir is controlled in tests
    expect(fs.existsSync(safePath.join(installDir, 'test-skill'))).toBe(true);
  });

  it('auto-detects claude plugin and installs to plugins dir', () => {
    const { sourceDir, installDir } = createTestDirs(tempDir, 'plugin');
    const pluginDir = createPluginDir(sourceDir, 'test-plugin');

    const result = runInstall(binPath, tempDir, pluginDir, [PLUGINS_DIR_FLAG, installDir]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('claude-plugin');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- installDir is controlled in tests
    expect(fs.existsSync(safePath.join(installDir, 'test-plugin'))).toBe(true);
  });

  it('--type flag overrides auto-detection', () => {
    const { sourceDir, installDir } = createTestDirs(tempDir, 'type-override');
    const skillDir = createSkillDir(sourceDir, 'override-skill');

    const result = runInstall(
      binPath,
      tempDir,
      skillDir,
      ['--type', 'agent-skill', SKILLS_DIR_FLAG, installDir],
    );

    expect(result.status).toBe(0);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- installDir is controlled in tests
    expect(fs.existsSync(safePath.join(installDir, 'override-skill'))).toBe(true);
  });

  it('auto-detects claude marketplace and installs to marketplaces dir', () => {
    const { sourceDir, installDir } = createTestDirs(tempDir, 'marketplace');
    const marketplaceDir = createMarketplaceDir(sourceDir, 'test-marketplace');

    const result = runInstall(binPath, tempDir, marketplaceDir, [MARKETPLACES_DIR_FLAG, installDir]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('claude-marketplace');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- installDir is controlled in tests
    expect(fs.existsSync(safePath.join(installDir, 'test-marketplace'))).toBe(true);
  });

  it('--dry-run previews without creating files', () => {
    const { sourceDir, installDir } = createTestDirs(tempDir, 'dry-run');
    const skillDir = createSkillDir(sourceDir, 'dry-run-skill');

    const result = runInstall(binPath, tempDir, skillDir, [SKILLS_DIR_FLAG, installDir], ['--dry-run']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('dryRun: true');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- installDir is controlled in tests
    expect(fs.existsSync(safePath.join(installDir, 'dry-run-skill'))).toBe(false);
  });

  it('fails with exit code 1 when source does not match detected type', () => {
    const { sourceDir, installDir } = createTestDirs(tempDir, 'mismatch');
    const skillDir = createSkillDir(sourceDir, 'mismatch-skill');

    // Pass --type claude-plugin for a skill dir — should fail
    const result = runInstall(
      binPath,
      tempDir,
      skillDir,
      ['--type', 'claude-plugin', PLUGINS_DIR_FLAG, installDir],
    );

    expect(result.status).toBe(1);
  });

  it('fails with exit code 2 when source directory does not exist', () => {
    const result = executeCli(binPath, ['install', '/nonexistent/path/to/resource'], {
      cwd: tempDir,
    });

    expect(result.status).toBe(2);
  });

  it('--dry-run succeeds when resource is already installed', () => {
    const { sourceDir, installDir } = createTestDirs(tempDir, 'dry-run-exists');
    const skillDir = createSkillDir(sourceDir, 'already-installed-skill');

    // First: actually install it
    const installResult = runInstall(binPath, tempDir, skillDir, [SKILLS_DIR_FLAG, installDir]);
    expect(installResult.status).toBe(0);

    // Second: dry-run should succeed (not fail with "already installed")
    const dryRunResult = runInstall(
      binPath,
      tempDir,
      skillDir,
      [SKILLS_DIR_FLAG, installDir],
      ['--dry-run'],
    );
    expect(dryRunResult.status).toBe(0);
    expect(dryRunResult.stdout).toContain('dryRun: true');
    expect(dryRunResult.stdout).toContain('alreadyInstalled: true');
  });

  it('--force overwrites existing installation', () => {
    const { sourceDir, installDir } = createTestDirs(tempDir, 'force');
    const skillDir = createSkillDir(sourceDir, 'force-skill');

    // First install
    const firstResult = runInstall(binPath, tempDir, skillDir, [SKILLS_DIR_FLAG, installDir]);
    expect(firstResult.status).toBe(0);

    // Second install without --force should fail
    const secondResult = runInstall(binPath, tempDir, skillDir, [SKILLS_DIR_FLAG, installDir]);
    expect(secondResult.status).toBe(1);

    // Third install with --force should succeed
    const thirdResult = runInstall(
      binPath,
      tempDir,
      skillDir,
      [SKILLS_DIR_FLAG, installDir],
      ['--force'],
    );
    expect(thirdResult.status).toBe(0);
  });
});
