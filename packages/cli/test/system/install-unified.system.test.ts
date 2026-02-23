/**
 * Unified vat install command — system tests
 *
 * Tests auto-detection of resource type and correct routing to install directory.
 */

import * as fs from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cleanupTestTempDir,
  createTestTempDir,
  executeCli,
  getBinPath,
  writeTestFile,
} from './test-common.js';

/**
 * Set up a minimal agent skill directory with SKILL.md at root.
 */
function createSkillDir(parentDir: string, name: string): string {
  const skillDir = join(parentDir, name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- skillDir is controlled in tests
  fs.mkdirSync(skillDir, { recursive: true });
  writeTestFile(
    join(skillDir, 'SKILL.md'),
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
  const pluginDir = join(parentDir, name);
  const claudePluginDir = join(pluginDir, '.claude-plugin');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirs are controlled in tests
  fs.mkdirSync(claudePluginDir, { recursive: true });
  writeTestFile(
    join(claudePluginDir, 'plugin.json'),
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
  const marketplaceDir = join(parentDir, name);
  const claudePluginDir = join(marketplaceDir, '.claude-plugin');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirs are controlled in tests
  fs.mkdirSync(claudePluginDir, { recursive: true });
  writeTestFile(
    join(claudePluginDir, 'marketplace.json'),
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
    const sourceDir = join(tempDir, 'sources');
    const installDir = join(tempDir, 'skills-install-1');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirs are controlled in tests
    fs.mkdirSync(sourceDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirs are controlled in tests
    fs.mkdirSync(installDir, { recursive: true });

    const skillDir = createSkillDir(sourceDir, 'test-skill');

    const result = executeCli(binPath, ['install', skillDir, SKILLS_DIR_FLAG, installDir], {
      cwd: tempDir,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('agent-skill');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- installDir is controlled in tests
    expect(fs.existsSync(join(installDir, 'test-skill'))).toBe(true);
  });

  it('auto-detects claude plugin and installs to plugins dir', () => {
    const sourceDir = join(tempDir, 'plugin-sources');
    const installDir = join(tempDir, 'plugins-install-1');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirs are controlled in tests
    fs.mkdirSync(sourceDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirs are controlled in tests
    fs.mkdirSync(installDir, { recursive: true });

    const pluginDir = createPluginDir(sourceDir, 'test-plugin');

    const result = executeCli(binPath, ['install', pluginDir, PLUGINS_DIR_FLAG, installDir], {
      cwd: tempDir,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('claude-plugin');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- installDir is controlled in tests
    expect(fs.existsSync(join(installDir, 'test-plugin'))).toBe(true);
  });

  it('--type flag overrides auto-detection', () => {
    const sourceDir = join(tempDir, 'type-override-sources');
    const installDir = join(tempDir, 'skills-install-2');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirs are controlled in tests
    fs.mkdirSync(sourceDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirs are controlled in tests
    fs.mkdirSync(installDir, { recursive: true });

    const skillDir = createSkillDir(sourceDir, 'override-skill');

    const result = executeCli(
      binPath,
      ['install', skillDir, '--type', 'agent-skill', SKILLS_DIR_FLAG, installDir],
      { cwd: tempDir }
    );

    expect(result.status).toBe(0);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- installDir is controlled in tests
    expect(fs.existsSync(join(installDir, 'override-skill'))).toBe(true);
  });

  it('auto-detects claude marketplace and installs to marketplaces dir', () => {
    const sourceDir = join(tempDir, 'marketplace-sources');
    const installDir = join(tempDir, 'marketplaces-install-1');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirs are controlled in tests
    fs.mkdirSync(sourceDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirs are controlled in tests
    fs.mkdirSync(installDir, { recursive: true });

    const marketplaceDir = createMarketplaceDir(sourceDir, 'test-marketplace');

    const result = executeCli(
      binPath,
      ['install', marketplaceDir, MARKETPLACES_DIR_FLAG, installDir],
      { cwd: tempDir }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('claude-marketplace');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- installDir is controlled in tests
    expect(fs.existsSync(join(installDir, 'test-marketplace'))).toBe(true);
  });

  it('--dry-run previews without creating files', () => {
    const sourceDir = join(tempDir, 'dry-run-sources');
    const installDir = join(tempDir, 'dry-run-install');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirs are controlled in tests
    fs.mkdirSync(sourceDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- installDir is controlled in tests
    fs.mkdirSync(installDir, { recursive: true });

    const skillDir = createSkillDir(sourceDir, 'dry-run-skill');

    const result = executeCli(
      binPath,
      ['install', skillDir, SKILLS_DIR_FLAG, installDir, '--dry-run'],
      { cwd: tempDir }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('dryRun: true');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- installDir is controlled in tests
    expect(fs.existsSync(join(installDir, 'dry-run-skill'))).toBe(false);
  });

  it('fails with exit code 1 when source does not match detected type', () => {
    const sourceDir = join(tempDir, 'mismatch-sources');
    const installDir = join(tempDir, 'mismatch-install');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirs are controlled in tests
    fs.mkdirSync(sourceDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- installDir is controlled in tests
    fs.mkdirSync(installDir, { recursive: true });

    const skillDir = createSkillDir(sourceDir, 'mismatch-skill');

    // Pass --type claude-plugin for a skill dir — should fail
    const result = executeCli(
      binPath,
      ['install', skillDir, '--type', 'claude-plugin', PLUGINS_DIR_FLAG, installDir],
      { cwd: tempDir }
    );

    expect(result.status).toBe(1);
  });

  it('fails with exit code 2 when source directory does not exist', () => {
    const result = executeCli(binPath, ['install', '/nonexistent/path/to/resource'], {
      cwd: tempDir,
    });

    expect(result.status).toBe(2);
  });

  it('--force overwrites existing installation', () => {
    const sourceDir = join(tempDir, 'force-sources');
    const installDir = join(tempDir, 'force-install');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirs are controlled in tests
    fs.mkdirSync(sourceDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- installDir is controlled in tests
    fs.mkdirSync(installDir, { recursive: true });

    const skillDir = createSkillDir(sourceDir, 'force-skill');

    // First install
    const firstResult = executeCli(binPath, ['install', skillDir, SKILLS_DIR_FLAG, installDir], {
      cwd: tempDir,
    });
    expect(firstResult.status).toBe(0);

    // Second install without --force should fail
    const secondResult = executeCli(binPath, ['install', skillDir, SKILLS_DIR_FLAG, installDir], {
      cwd: tempDir,
    });
    expect(secondResult.status).toBe(1);

    // Third install with --force should succeed
    const thirdResult = executeCli(
      binPath,
      ['install', skillDir, SKILLS_DIR_FLAG, installDir, '--force'],
      { cwd: tempDir }
    );
    expect(thirdResult.status).toBe(0);
  });
});
