/* eslint-disable sonarjs/no-duplicate-string, sonarjs/no-os-command-from-path */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
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
  writeTestFile(safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'), `version: 1
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
  writeTestFile(safePath.join(tempDir, 'package.json'), JSON.stringify({ name: 'test-project', version: '1.0.0' }));
  writeTestFile(safePath.join(tempDir, 'CHANGELOG.md'), changelogContent);
  writeTestFile(safePath.join(tempDir, 'README.md'), '# Test Marketplace\n');
}

/**
 * Create built marketplace artifacts that the publish command expects.
 * Includes a script file in a nested skills directory to catch cp() bugs
 * that drop non-markdown files (e.g., Node 22 async cp regression).
 */
function createBuildOutput(tempDir: string): void {
  const mpDir = safePath.join(tempDir, 'dist', '.claude', 'plugins', 'marketplaces', 'test-mp');
  mkdirSyncReal(safePath.join(mpDir, '.claude-plugin'), { recursive: true });
  writeTestFile(
    safePath.join(mpDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'test-mp',
      description: 'Test marketplace',
      version: '1.0.0',
      owner: { name: 'Test Org' },
      plugins: [{ name: 'test-plugin', source: './plugins/test-plugin' }],
    }),
  );

  const pluginDir = safePath.join(mpDir, 'plugins', 'test-plugin', '.claude-plugin');
  mkdirSyncReal(pluginDir, { recursive: true });
  writeTestFile(
    safePath.join(pluginDir, 'plugin.json'),
    JSON.stringify({ name: 'test-plugin', description: 'Test plugin', version: '1.0.0' }),
  );

  // Add a script in a nested skills directory — catches cp() bugs that drop non-markdown files
  const skillScriptsDir = safePath.join(mpDir, 'plugins', 'test-plugin', 'skills', 'my-skill', 'scripts');
  mkdirSyncReal(skillScriptsDir, { recursive: true });
  writeTestFile(safePath.join(skillScriptsDir, 'cli.mjs'), '#!/usr/bin/env node\nconsole.log("cli");');
}

/**
 * Initialize a git repo in the temp directory with a fake remote.
 */
/**
 * Create a bare git repo to serve as a fake remote.
 * Using a real bare repo avoids git fetch timeouts on CI (Ubuntu).
 */
function createBareRemote(tempDir: string): string {
  const bareDir = safePath.join(tempDir, '.bare-remote');
  spawnSync('git', ['init', '--bare', '-b', 'main', bareDir], { encoding: 'utf-8' });
  return bareDir;
}

function initGitRepo(tempDir: string): void {
  const bareRemote = createBareRemote(tempDir);
  spawnSync('git', ['init', '-b', 'main'], { cwd: tempDir, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tempDir, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir, encoding: 'utf-8' });
  spawnSync('git', ['add', '.'], { cwd: tempDir, encoding: 'utf-8' });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir, encoding: 'utf-8' });
  spawnSync('git', ['remote', 'add', 'origin', bareRemote], { cwd: tempDir, encoding: 'utf-8' });
}

/** Set up a fully configured publish project and run dry-run publish */
async function setupAndDryRunPublish(
  createTempDir: () => string,
  changelog = '# Changelog\n\n## [Unreleased]\n\n- Changes\n',
): Promise<{ tempDir: string; result: Awaited<ReturnType<typeof executeCli>> }> {
  const tempDir = createTempDir();
  writeProjectFiles(tempDir, changelog);
  createBuildOutput(tempDir);
  initGitRepo(tempDir);
  const result = await executeCli(binPath, [...PUBLISH_ARGS, '--dry-run'], { cwd: tempDir });
  return { tempDir, result };
}

/**
 * Run dry-run publish against a project configured to fail, and assert the
 * failure shape. Pass `withBuildOutput: true` for tests that need build
 * artifacts to exist but still expect a later-stage failure.
 */
async function expectDryRunPublishFailure(
  createTempDir: () => string,
  opts: { changelog: string; stderrContains: string; withBuildOutput?: boolean; expectedStatus?: number },
): Promise<void> {
  const tempDir = createTempDir();
  writeProjectFiles(tempDir, opts.changelog);
  if (opts.withBuildOutput) {
    createBuildOutput(tempDir);
  }
  initGitRepo(tempDir);
  const result = await executeCli(binPath, [...PUBLISH_ARGS, '--dry-run'], { cwd: tempDir });
  expect(result.status).toBe(opts.expectedStatus ?? 2);
  expect(result.stderr).toContain(opts.stderrContains);
}

describe('vat claude marketplace publish (system)', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker(TEMP_DIR_PREFIX);

  afterEach(() => {
    cleanupTempDirs();
  });

  it('should succeed with --dry-run when marketplace is fully configured', async () => {
    const { result } = await setupAndDryRunPublish(createTempDir, '# Changelog\n\n## [Unreleased]\n\n- Added marketplace publish\n');

    expect(result.status, `Expected exit 0 but got ${String(result.status)}. stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('success');
  });

  it('should fail when no build output exists', async () => {
    await expectDryRunPublishFailure(createTempDir, {
      changelog: '# Changelog\n\n## [Unreleased]\n\n- Changes\n',
      stderrContains: 'build output not found',
    });
  });

  it('should fail when no publish config exists', async () => {
    const tempDir = createTempDir();

    // Config without publish section
    writeTestFile(safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'), `version: 1
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
    writeTestFile(safePath.join(tempDir, 'package.json'), JSON.stringify({ name: 'test-project', version: '1.0.0' }));
    initGitRepo(tempDir);

    const result = await executeCli(binPath, [...PUBLISH_ARGS, '--dry-run'], { cwd: tempDir });

    expect(result.status).not.toBe(0);
  });

  it('should preserve non-markdown files (e.g., .mjs scripts) through publish pipeline', async () => {
    const { result } = await setupAndDryRunPublish(createTempDir, '# Changelog\n\n## [Unreleased]\n\n- Added scripts\n');

    expect(result.status, `Expected exit 0 but got ${String(result.status)}. stderr: ${result.stderr}`).toBe(0);

    // Extract the temp repo path from the dry-run output
    const tmpRepoMatch = /Commit staged at:\s*(\S+)/.exec(result.stderr);
    expect(tmpRepoMatch, 'Should print temp repo path in dry-run mode').not.toBeNull();
    const tmpRepoPath = tmpRepoMatch?.[1] ?? '';
    expect(tmpRepoPath).not.toBe('');

    // Verify the .mjs script file survived the compose→cpSync pipeline
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test path from CLI output
    const allFiles = readdirSync(tmpRepoPath, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && !entry.parentPath.includes('.git'))
      .map(entry => safePath.relative(tmpRepoPath, safePath.join(entry.parentPath, entry.name)));

    const mjsFiles = allFiles.filter(f => f.endsWith('.mjs'));
    expect(mjsFiles.length, `Expected .mjs files in publish output but found none. All files: ${allFiles.join(', ')}`).toBeGreaterThan(0);
    expect(allFiles.some(f => f.includes('cli.mjs'))).toBe(true);
  });

  it('should fail when changelog has empty [Unreleased] section', async () => {
    await expectDryRunPublishFailure(createTempDir, {
      changelog: '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2025-01-01\n\n- Old change\n',
      stderrContains: 'empty [Unreleased]',
      withBuildOutput: true,
    });
  });
});
