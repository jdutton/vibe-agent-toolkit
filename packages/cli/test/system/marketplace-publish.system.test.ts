/* eslint-disable sonarjs/no-duplicate-string, sonarjs/no-os-command-from-path, sonarjs/publicly-writable-directories */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createTempDirTracker,
  executeCli,
  getBinPath,
  writeTestFile,
} from './test-common.js';

const binPath = getBinPath(import.meta.url);
const TEMP_DIR_PREFIX = 'vat-marketplace-publish-test-';
const PUBLISH_ARGS = ['claude', 'marketplace', 'publish'] as const;

/**
 * Write the standard config YAML used by most publish tests.
 */
function writePublishConfig(tempDir: string): void {
  writeTestFile(join(tempDir, 'vibe-agent-toolkit.config.yaml'), `version: 1
skills:
  include:
    - "skills/**/SKILL.md"
claude:
  marketplaces:
    test-mp:
      owner:
        name: Test Org
      publish:
        branch: test-branch
        changelog: CHANGELOG.md
        readme: README.md
        license: mit
      plugins:
        - name: test-plugin
          skills: "*"
`);
}

/**
 * Write the common project files (config, package.json, changelog, readme)
 * used by most publish tests. Changelog content is configurable.
 */
function writeProjectFiles(tempDir: string, changelogContent: string): void {
  writePublishConfig(tempDir);
  writeTestFile(join(tempDir, 'package.json'), JSON.stringify({ name: 'test-project', version: '1.0.0' }));
  writeTestFile(join(tempDir, 'CHANGELOG.md'), changelogContent);
  writeTestFile(join(tempDir, 'README.md'), '# Test Marketplace\n');
}

/**
 * Create built marketplace artifacts that the publish command expects.
 */
function createBuildOutput(tempDir: string): void {
  const mpDir = join(tempDir, 'dist', '.claude', 'plugins', 'marketplaces', 'test-mp');
  mkdirSyncReal(join(mpDir, '.claude-plugin'), { recursive: true });
  writeTestFile(
    join(mpDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'test-mp',
      description: 'Test marketplace',
      version: '1.0.0',
      owner: { name: 'Test Org' },
      plugins: [{ name: 'test-plugin', source: './plugins/test-plugin' }],
    }),
  );

  const pluginDir = join(mpDir, 'plugins', 'test-plugin', '.claude-plugin');
  mkdirSyncReal(pluginDir, { recursive: true });
  writeTestFile(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({ name: 'test-plugin', description: 'Test plugin', version: '1.0.0' }),
  );
}

/**
 * Initialize a git repo in the temp directory with a fake remote.
 */
function initGitRepo(tempDir: string): void {
  spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tempDir, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir, encoding: 'utf-8' });
  spawnSync('git', ['add', '.'], { cwd: tempDir, encoding: 'utf-8' });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir, encoding: 'utf-8' });
  spawnSync('git', ['remote', 'add', 'origin', '/tmp/fake-remote.git'], { cwd: tempDir, encoding: 'utf-8' });
}

describe('vat claude marketplace publish (system)', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker(TEMP_DIR_PREFIX);

  afterEach(() => {
    cleanupTempDirs();
  });

  it('should succeed with --dry-run when marketplace is fully configured', () => {
    const tempDir = createTempDir();

    writeProjectFiles(tempDir, '# Changelog\n\n## [Unreleased]\n\n- Added marketplace publish\n');
    createBuildOutput(tempDir);
    initGitRepo(tempDir);

    const result = executeCli(binPath, [...PUBLISH_ARGS, '--dry-run'], { cwd: tempDir });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('success');
  });

  it('should fail when no build output exists', () => {
    const tempDir = createTempDir();

    writeProjectFiles(tempDir, '# Changelog\n\n## [Unreleased]\n\n- Changes\n');
    initGitRepo(tempDir);

    const result = executeCli(binPath, [...PUBLISH_ARGS, '--dry-run'], { cwd: tempDir });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('build output not found');
  });

  it('should fail when no publish config exists', () => {
    const tempDir = createTempDir();

    // Config without publish section
    writeTestFile(join(tempDir, 'vibe-agent-toolkit.config.yaml'), `version: 1
skills:
  include:
    - "skills/**/SKILL.md"
claude:
  marketplaces:
    test-mp:
      owner:
        name: Test Org
      plugins:
        - name: test-plugin
          skills: "*"
`);
    writeTestFile(join(tempDir, 'package.json'), JSON.stringify({ name: 'test-project', version: '1.0.0' }));
    initGitRepo(tempDir);

    const result = executeCli(binPath, [...PUBLISH_ARGS, '--dry-run'], { cwd: tempDir });

    expect(result.status).not.toBe(0);
  });

  it('should fail when changelog has empty [Unreleased] section', () => {
    const tempDir = createTempDir();

    writeProjectFiles(tempDir, '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2025-01-01\n\n- Old change\n');
    createBuildOutput(tempDir);
    initGitRepo(tempDir);

    const result = executeCli(binPath, [...PUBLISH_ARGS, '--dry-run'], { cwd: tempDir });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('empty [Unreleased]');
  });
});
