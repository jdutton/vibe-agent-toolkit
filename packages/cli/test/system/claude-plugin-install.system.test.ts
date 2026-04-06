/* eslint-disable security/detect-non-literal-fs-filename */
// Test files legitimately use dynamic file paths

/**
 * System tests for `vat claude plugin install` command.
 */

import * as fs from 'node:fs';


import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import * as tar from 'tar';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createTempDirTracker,
  executeCliAndParseYaml,
  fakeHomeEnv,
  getBinPath,
  writeTestFile,
} from './test-common.js';

const TEMP_DIR_PREFIX = 'vat-plugin-install-test-';

// String constants to avoid sonarjs/no-duplicate-string violations
// Used as suffix after claudeDir (which already includes '.claude')
const PLUGINS_MARKETPLACES = safePath.join('plugins', 'marketplaces');
const MULTI_MARKET = 'multi-market';
const SKILL_ALPHA = 'skill-alpha';
const SKILL_BETA = 'skill-beta';

/**
 * Create an isolated temp/home/claudeDir context for a single test.
 * Extracted to eliminate the repeated 4-line setup block across tests.
 */
function createInstallTestContext(createTempDir: () => string): {
  tempDir: string;
  fakeHome: string;
  claudeDir: string;
} {
  const tempDir = createTempDir();
  const fakeHome = safePath.join(tempDir, 'home');
  const claudeDir = safePath.join(fakeHome, '.claude');
  mkdirSyncReal(fakeHome, { recursive: true });
  return { tempDir, fakeHome, claudeDir };
}

/**
 * Create a plugin tree directory structure that mirrors the output of `vat build`.
 * Places files at: <projectDir>/dist/.claude/plugins/marketplaces/<marketplace>/plugins/<plugin>/
 *
 * When `skills` is provided on a plugin entry, they are placed in the proper
 * `plugins/<plugin>/skills/<skillName>/` subdirectory (real `vat build` layout).
 * When omitted, a flat `SKILL.md` is written at the plugin root (legacy test layout).
 */
function setupPluginTestProject(
  baseDir: string,
  name: string,
  marketplaceName: string,
  plugins: Array<{ name: string; skills?: string[] }>
): { projectDir: string; marketplacesDir: string } {
  const projectDir = safePath.join(baseDir, name);
  mkdirSyncReal(projectDir, { recursive: true });

  writeTestFile(
    safePath.join(projectDir, 'package.json'),
    JSON.stringify({ name: '@test/my-plugin-pkg', version: '1.2.3' })
  );

  const marketplacesDir = safePath.join(projectDir, 'dist', '.claude', 'plugins', 'marketplaces');
  for (const plugin of plugins) {
    const pluginDir = safePath.join(marketplacesDir, marketplaceName, 'plugins', plugin.name);
    mkdirSyncReal(pluginDir, { recursive: true });
    writeTestFile(safePath.join(pluginDir, 'plugin.json'), JSON.stringify({ name: plugin.name, version: '1.2.3' }));

    if (plugin.skills) {
      for (const skillName of plugin.skills) {
        const skillDir = safePath.join(pluginDir, 'skills', skillName);
        mkdirSyncReal(skillDir, { recursive: true });
        writeTestFile(safePath.join(skillDir, 'SKILL.md'), `# ${skillName}\nTest skill content`);
      }
    } else {
      writeTestFile(safePath.join(pluginDir, 'SKILL.md'), `# ${plugin.name}\nTest plugin content`);
    }
  }

  return { projectDir, marketplacesDir };
}

/**
 * Run `vat claude plugin install <projectDir>` and assert it exits 0 with status: success.
 * Returns parsed YAML output for further assertions.
 */
function runPluginInstall(
  binPath: string,
  projectDir: string,
  fakeHome: string
): ReturnType<typeof executeCliAndParseYaml> {
  const out = executeCliAndParseYaml(binPath, [
    'claude', 'plugin', 'install', projectDir,
  ], { env: fakeHomeEnv(fakeHome) });
  expect(out.result.status).toBe(0);
  expect(out.parsed.status).toBe('success');
  return out;
}

describe('claude plugin install command (system test)', () => {
  const binPath = getBinPath(import.meta.url);
  const { createTempDir, cleanupTempDirs } = createTempDirTracker(TEMP_DIR_PREFIX);

  afterEach(() => {
    cleanupTempDirs();
  });

  it('installs from local directory with plugin tree', () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);

    const { projectDir } = setupPluginTestProject(tempDir, 'pkg-local', 'test-market', [
      { name: 'my-skill' },
    ]);

    runPluginInstall(binPath, projectDir, fakeHome);

    expect(
      fs.existsSync(safePath.join(claudeDir, PLUGINS_MARKETPLACES, 'test-market', 'plugins', 'my-skill'))
    ).toBe(true);

    const installed = JSON.parse(
      fs.readFileSync(safePath.join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf-8')
    ) as { plugins: Record<string, unknown> };
    expect(Object.keys(installed.plugins)).toContain('my-skill@test-market');
  });

  it('shows structured stub for --target claude.ai', () => {
    const tempDir = createTempDir();
    const { result, parsed } = executeCliAndParseYaml(binPath, [
      'claude', 'plugin', 'install', 'npm:@test/fake',
      '--target', 'claude.ai',
    ], { env: fakeHomeEnv(safePath.join(tempDir, 'home')) });

    expect(result.status).toBe(1);
    expect(parsed.status).toBe('not-available');
    expect(parsed.requestedTarget).toBe('claude.ai');
  });

  it('skips install when not a global npm install (--npm-postinstall)', () => {
    const tempDir = createTempDir();
    const fakeHome = safePath.join(tempDir, 'home');
    mkdirSyncReal(fakeHome, { recursive: true });

    // Build env without npm_config_global so isGlobalNpmInstall() returns false
    const { result } = executeCliAndParseYaml(binPath, ['claude', 'plugin', 'install', '--npm-postinstall'], {
      env: { ...fakeHomeEnv(fakeHome), npm_lifecycle_event: '', npm_command: '' },
    });

    expect(result.status).toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('Skipping');
  });

  it('installs multiple plugins from a single project directory', () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);

    const { projectDir } = setupPluginTestProject(tempDir, 'multi-pkg', MULTI_MARKET, [
      { name: SKILL_ALPHA },
      { name: SKILL_BETA },
    ]);

    runPluginInstall(binPath, projectDir, fakeHome);

    expect(fs.existsSync(safePath.join(claudeDir, PLUGINS_MARKETPLACES, MULTI_MARKET, 'plugins', SKILL_ALPHA))).toBe(true);
    expect(fs.existsSync(safePath.join(claudeDir, PLUGINS_MARKETPLACES, MULTI_MARKET, 'plugins', SKILL_BETA))).toBe(true);
  });

  it('installs from npm tarball (.tgz) with plugin tree', async () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);

    const { projectDir } = setupPluginTestProject(tempDir, 'pkg-tgz', 'tgz-market', [
      { name: 'tgz-skill' },
    ]);

    // Create tarball in npm pack format: all files under package/ prefix
    const tgzPath = safePath.join(tempDir, 'my-pkg-1.0.0.tgz');
    await tar.create({ gzip: true, file: tgzPath, cwd: projectDir, prefix: 'package' }, ['.']);

    const { result, parsed } = executeCliAndParseYaml(binPath, [
      'claude', 'plugin', 'install', tgzPath,
    ], { env: fakeHomeEnv(fakeHome) });

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('success');
    expect(
      fs.existsSync(safePath.join(claudeDir, PLUGINS_MARKETPLACES, 'tgz-market', 'plugins', 'tgz-skill'))
    ).toBe(true);
  });

  it('reinstall overwrites existing plugin tree', () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);

    const { projectDir } = setupPluginTestProject(tempDir, 'overwrite-pkg', 'ow-market', [
      { name: 'ow-skill' },
    ]);

    // First install
    const first = executeCliAndParseYaml(binPath, ['claude', 'plugin', 'install', projectDir], {
      env: fakeHomeEnv(fakeHome),
    });
    expect(first.result.status).toBe(0);

    // Modify the skill file so we can detect the overwrite
    const installedSkillDir = safePath.join(claudeDir, PLUGINS_MARKETPLACES, 'ow-market', 'plugins', 'ow-skill');
    fs.writeFileSync(safePath.join(installedSkillDir, 'extra-sentinel.txt'), 'sentinel');

    // Second install (should overwrite — marketplace dir is rm-ed and re-copied)
    const second = executeCliAndParseYaml(binPath, ['claude', 'plugin', 'install', projectDir], {
      env: fakeHomeEnv(fakeHome),
    });
    expect(second.result.status).toBe(0);

    // After reinstall the skill dir should exist but the sentinel should be gone
    expect(fs.existsSync(installedSkillDir)).toBe(true);
    expect(fs.existsSync(safePath.join(installedSkillDir, 'extra-sentinel.txt'))).toBe(false);
  });

  it('reports correct skillsInstalled count when plugin has skills/ subdirectory', () => {
    // Regression test: installPluginTreeAndExit previously passed [] to outputInstallSuccess
    // regardless of how many skills were actually copied, always reporting skillsInstalled: 0.
    const { tempDir, fakeHome } = createInstallTestContext(createTempDir);

    const { projectDir } = setupPluginTestProject(tempDir, 'pkg-skills-count', 'skills-market', [
      { name: 'my-plugin', skills: [SKILL_ALPHA, SKILL_BETA, 'skill-gamma'] },
    ]);

    const { parsed } = runPluginInstall(binPath, projectDir, fakeHome);

    expect(parsed.skillsInstalled).toBe(3);
    expect(parsed.skills).toHaveLength(3);
    const skillNames = (parsed.skills as Array<{ name: string }>).map(s => s.name);
    expect(skillNames).toContain(SKILL_ALPHA);
    expect(skillNames).toContain(SKILL_BETA);
    expect(skillNames).toContain('skill-gamma');
  });
});
