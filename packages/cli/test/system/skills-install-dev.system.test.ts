/* eslint-disable security/detect-non-literal-fs-filename, sonarjs/no-duplicate-string */
// Test fixtures legitimately use dynamic file paths

/**
 * System tests for claude plugin install --dev command
 *
 * The --dev command now reads the pre-built plugin tree from
 * dist/.claude/plugins/marketplaces/ and creates symlinks to dist/skills/.
 * Skills appear in Claude Code as {plugin}:{skill} instead of the flat {skill} name.
 */

import { existsSync, lstatSync } from 'node:fs';
import * as fs from 'node:fs';


import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, describe, expect, it } from 'vitest';

import {
  createPackageAndHomeContext,
  createTempDirTracker,
  executeCliAndParseYaml,
  fakeHomeEnv,
  getBinPath,
  writeTestFile,
} from './test-common.js';

const binPath = getBinPath(import.meta.url);

const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-install-dev-test-');

afterAll(() => {
  cleanupTempDirs();
});

const MARKETPLACE_NAME = 'test-market';
const PLUGIN_NAME = 'test-plugin';

/**
 * Create a test project with:
 * - package.json containing vat.skills[] metadata
 * - dist/skills/{name}/ for built skills
 * - dist/.claude/plugins/marketplaces/{market}/plugins/{plugin}/skills/{name}/ for the plugin tree
 * - dist/.claude/plugins/marketplaces/{market}/.claude-plugin/marketplace.json
 * - dist/.claude/plugins/marketplaces/{market}/plugins/{plugin}/.claude-plugin/plugin.json
 */
function createDevTestProject(
  baseDir: string,
  name: string,
  skills: Array<{ name: string; built: boolean }>
): { projectDir: string; fakeHome: string } {
  const { packageDir: projectDir, fakeHome } = createPackageAndHomeContext(safePath.join(baseDir, name));

  fs.writeFileSync(
    safePath.join(projectDir, 'package.json'),
    JSON.stringify({
      name: '@test/my-package',
      version: '1.0.0',
      vat: { version: '1.0', skills: skills.map(s => s.name) },
    })
  );

  // Create dist/skills/ directories for built skills
  for (const skill of skills) {
    if (skill.built) {
      const skillDir = safePath.join(projectDir, 'dist', 'skills', skill.name);
      mkdirSyncReal(skillDir, { recursive: true });
      writeTestFile(safePath.join(skillDir, 'SKILL.md'), `# ${skill.name}\nTest skill content`);
    }
  }

  // Create plugin tree structure (mirrors what vat claude plugin build produces)
  const mpDir = safePath.join(projectDir, 'dist', '.claude', 'plugins', 'marketplaces', MARKETPLACE_NAME);
  const claudePluginDir = safePath.join(mpDir, '.claude-plugin');
  const pluginDir = safePath.join(mpDir, 'plugins', PLUGIN_NAME);
  const pluginClaudePluginDir = safePath.join(pluginDir, '.claude-plugin');

  mkdirSyncReal(claudePluginDir, { recursive: true });
  mkdirSyncReal(pluginClaudePluginDir, { recursive: true });

  writeTestFile(
    safePath.join(claudePluginDir, 'marketplace.json'),
    JSON.stringify({ name: MARKETPLACE_NAME, owner: { name: 'test' }, plugins: [{ name: PLUGIN_NAME }] })
  );
  writeTestFile(
    safePath.join(pluginClaudePluginDir, 'plugin.json'),
    JSON.stringify({ name: PLUGIN_NAME, description: 'test plugin' })
  );

  // Add skill dirs to plugin tree (only for built skills)
  for (const skill of skills) {
    if (skill.built) {
      const skillInPluginDir = safePath.join(pluginDir, 'skills', skill.name);
      mkdirSyncReal(skillInPluginDir, { recursive: true });
      writeTestFile(safePath.join(skillInPluginDir, 'SKILL.md'), `# ${skill.name}\nTest skill content`);
    }
  }

  return { projectDir, fakeHome };
}

/**
 * Execute --dev install with a fake home directory
 */
async function executeDevInstall(
  projectDir: string,
  fakeHome: string,
  extraArgs: string[] = []
): Promise<{ status: number | null; stderr: string; parsed: Record<string, unknown> }> {
  const { result, parsed } = await executeCliAndParseYaml(
    binPath,
    ['claude', 'plugin', 'install', '--dev', ...extraArgs],
    { cwd: projectDir, env: fakeHomeEnv(fakeHome) }
  );
  return { status: result.status, stderr: result.stderr, parsed };
}

/**
 * Get expected symlink path for a skill in the fake home
 */
function expectedSkillPath(fakeHome: string, skillName: string): string {
  return safePath.join(fakeHome, '.claude', 'plugins', 'marketplaces', MARKETPLACE_NAME, 'plugins', PLUGIN_NAME, 'skills', skillName);
}

/**
 * Set up a dev test project, run `claude plugin install --dev`, and assert
 * the install succeeded. Returns the fake home and parsed output so individual
 * tests can make their own extra assertions.
 */
async function setupAndDevInstall(
  name: string,
  skills: Array<{ name: string; built: boolean }>,
): Promise<{ fakeHome: string; parsed: Record<string, unknown> }> {
  const tempDir = createTempDir();
  const { projectDir, fakeHome } = createDevTestProject(tempDir, name, skills);
  const { status, parsed } = await executeDevInstall(projectDir, fakeHome);
  expect(status).toBe(0);
  expect(parsed.status).toBe('success');
  return { fakeHome, parsed };
}

describe('claude plugin install --dev command (system test)', () => {
  it('should symlink a single skill', async () => {
    const { fakeHome, parsed } = await setupAndDevInstall('single', [
      { name: 'my-skill', built: true },
    ]);

    expect(parsed.sourceType).toBe('dev');
    expect(parsed.symlink).toBe(true);
    expect(parsed.skillsInstalled).toBe(1);

    const installedPath = expectedSkillPath(fakeHome, 'my-skill');
    expect(existsSync(installedPath)).toBe(true);
    expect(lstatSync(installedPath).isSymbolicLink()).toBe(true);
  });

  it('should symlink all skills from multi-skill package', async () => {
    const { fakeHome, parsed } = await setupAndDevInstall('multi', [
      { name: 'skill-alpha', built: true },
      { name: 'skill-beta', built: true },
    ]);

    expect(parsed.skillsInstalled).toBe(2);
    expect(lstatSync(expectedSkillPath(fakeHome, 'skill-alpha')).isSymbolicLink()).toBe(true);
    expect(lstatSync(expectedSkillPath(fakeHome, 'skill-beta')).isSymbolicLink()).toBe(true);
  });

  it('should fail when plugin tree not found', async () => {
    const tempDir = createTempDir();
    const { packageDir: projectDir, fakeHome } = createPackageAndHomeContext(safePath.join(tempDir, 'no-tree'));

    fs.writeFileSync(
      safePath.join(projectDir, 'package.json'),
      JSON.stringify({ name: '@test/my-package', version: '1.0.0', vat: { skills: ['my-skill'] } })
    );
    // No plugin tree created

    const { status, stderr } = await executeDevInstall(projectDir, fakeHome);

    expect(status).not.toBe(0);
    expect(stderr).toContain('Plugin tree not found');
  });

  it('should not create symlinks with --dry-run', async () => {
    const tempDir = createTempDir();
    const { projectDir, fakeHome } = createDevTestProject(tempDir, 'dryrun', [
      { name: 'dry-skill', built: true },
    ]);

    const { status, parsed } = await executeDevInstall(projectDir, fakeHome, ['--dry-run']);

    expect(status).toBe(0);
    expect(parsed.status).toBe('success');
    expect(parsed.dryRun).toBe(true);
    expect(parsed.skillsInstalled).toBe(1);
    expect(existsSync(expectedSkillPath(fakeHome, 'dry-skill'))).toBe(false);
  });

  it('should be idempotent on re-run (overwrites without --force)', async () => {
    const tempDir = createTempDir();
    const { projectDir, fakeHome } = createDevTestProject(tempDir, 'idempotent', [
      { name: 'dup-skill', built: true },
    ]);

    // First install succeeds
    const first = await executeDevInstall(projectDir, fakeHome);
    expect(first.status).toBe(0);

    // Second install also succeeds — marketplace dir is always reset
    const { status, parsed } = await executeDevInstall(projectDir, fakeHome);

    expect(status).toBe(0);
    expect(parsed.status).toBe('success');
    expect(parsed.skillsInstalled).toBe(1);
    expect(lstatSync(expectedSkillPath(fakeHome, 'dup-skill')).isSymbolicLink()).toBe(true);
  });

  it('should warn and skip skills not in dist/skills/', async () => {
    const tempDir = createTempDir();
    // Create plugin tree with unbuilt-skill referenced but no dist/skills/unbuilt-skill/
    const { packageDir: projectDir, fakeHome } = createPackageAndHomeContext(safePath.join(tempDir, 'missing-built'));

    fs.writeFileSync(
      safePath.join(projectDir, 'package.json'),
      JSON.stringify({ name: '@test/my-package', version: '1.0.0', vat: { skills: ['unbuilt-skill'] } })
    );

    // Create plugin tree but no dist/skills/unbuilt-skill
    const mpDir = safePath.join(projectDir, 'dist', '.claude', 'plugins', 'marketplaces', MARKETPLACE_NAME);
    const pluginDir = safePath.join(mpDir, 'plugins', PLUGIN_NAME);
    const skillInPluginDir = safePath.join(pluginDir, 'skills', 'unbuilt-skill');
    mkdirSyncReal(safePath.join(mpDir, '.claude-plugin'), { recursive: true });
    mkdirSyncReal(safePath.join(pluginDir, '.claude-plugin'), { recursive: true });
    mkdirSyncReal(skillInPluginDir, { recursive: true });
    writeTestFile(safePath.join(mpDir, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: MARKETPLACE_NAME }));
    writeTestFile(safePath.join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: PLUGIN_NAME }));
    writeTestFile(safePath.join(skillInPluginDir, 'SKILL.md'), '# unbuilt-skill');

    const { status, parsed } = await executeDevInstall(projectDir, fakeHome);

    // Should exit 0 but 0 skills installed (all skipped due to missing dist)
    expect(status).toBe(0);
    expect(parsed.skillsInstalled).toBe(0);
  });
});
