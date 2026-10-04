// Test files legitimately use dynamic file paths

/**
 * System tests for `vat claude plugin install` command.
 */

import * as fs from 'node:fs';
import { chmodSync } from 'node:fs';


import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import * as tar from 'tar';
import { afterEach, describe, expect, it } from 'vitest';

import { PLUGIN_INSTALL_REPORT_SCHEMA } from '../../src/commands/claude/plugin/install-schema.js';

import {
  createTempDirTracker,
  executeCliAndParseYaml,
  fakeHomeEnv,
  getBinPath,
  writeTestFile,
} from './test-common.js';

const TEMP_DIR_PREFIX = 'vat-plugin-install-test-';

/** Write `content` at `filePath`, creating its directory. */
function plantFile(filePath: string, content: string): void {
  mkdirSyncReal(safePath.join(filePath, '..'), { recursive: true });
  writeTestFile(filePath, content);
}

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

type InstallReport = ReturnType<typeof PLUGIN_INSTALL_REPORT_SCHEMA.parse>;

/** Run `vat claude plugin install <args>` under `fakeHome` and parse the report it publishes. */
async function runInstall(
  binPath: string,
  fakeHome: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ status: number | null; output: string; report: InstallReport }> {
  const { result, parsed } = await executeCliAndParseYaml(binPath, ['claude', 'plugin', 'install', ...args], {
    env: { ...fakeHomeEnv(fakeHome), ...env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}`, report: PLUGIN_INSTALL_REPORT_SCHEMA.parse(parsed) };
}

/**
 * Run `vat claude plugin install <projectDir>` and assert it exits 0 with status: ok.
 * Returns the parsed report for further assertions.
 */
async function runPluginInstall(binPath: string, projectDir: string, fakeHome: string): Promise<InstallReport> {
  const { status, report } = await runInstall(binPath, fakeHome, [projectDir]);
  expect(status).toBe(0);
  expect(report.status).toBe('ok');
  return report;
}

describe('claude plugin install command (system test)', () => {
  const binPath = getBinPath(import.meta.url);
  const { createTempDir, cleanupTempDirs } = createTempDirTracker(TEMP_DIR_PREFIX);

  afterEach(() => {
    cleanupTempDirs();
  });

  it('installs from local directory with plugin tree', async () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);

    const { projectDir } = setupPluginTestProject(tempDir, 'pkg-local', 'test-market', [
      { name: 'my-skill' },
    ]);

    await runPluginInstall(binPath, projectDir, fakeHome);

    expect(
      fs.existsSync(safePath.join(claudeDir, PLUGINS_MARKETPLACES, 'test-market', 'plugins', 'my-skill'))
    ).toBe(true);

    const installed = JSON.parse(
      fs.readFileSync(safePath.join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf-8')
    ) as { plugins: Record<string, unknown> };
    expect(Object.keys(installed.plugins)).toContain('my-skill@test-market');
  });

  it('refuses --target claude.ai as NOT_IMPLEMENTED, exit 2', async () => {
    const tempDir = createTempDir();

    const { status, report } = await runInstall(binPath, safePath.join(tempDir, 'home'), ['npm:@test/fake', '--target', 'claude.ai']);

    // The command cannot do what was asked; it is not a finding about a skill.
    expect(status).toBe(2);
    expect(report).toMatchObject({ status: 'error', error: { code: 'NOT_IMPLEMENTED' } });
  });

  it('refuses an unknown --target as USAGE_INVALID, exit 2', async () => {
    const tempDir = createTempDir();

    const { status, report } = await runInstall(binPath, safePath.join(tempDir, 'home'), ['npm:@test/fake', '--target', 'bogus']);

    expect(status).toBe(2);
    expect(report).toMatchObject({ status: 'error', error: { code: 'USAGE_INVALID' } });
  });

  it('refuses a missing source as USAGE_INVALID, never INTERNAL_ERROR', async () => {
    const tempDir = createTempDir();

    const { status, report } = await runInstall(binPath, safePath.join(tempDir, 'home'), []);

    expect(status).toBe(2);
    expect(report).toMatchObject({ status: 'error', error: { code: 'USAGE_INVALID' } });
  });

  it('refuses a source path that names nothing as USAGE_INVALID', async () => {
    const tempDir = createTempDir();

    const { status, report } = await runInstall(binPath, safePath.join(tempDir, 'home'), [safePath.join(tempDir, 'never-created')]);

    expect(status).toBe(2);
    expect(report).toMatchObject({ status: 'error', error: { code: 'USAGE_INVALID' } });
  });

  it('reports the skills already installed when a later one refuses', async () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);
    const packageDir = safePath.join(tempDir, 'two-skills');
    plantFile(safePath.join(packageDir, 'package.json'), JSON.stringify({ name: '@test/two', version: '1.0.0', vat: { skills: [SKILL_ALPHA, SKILL_BETA] } }));
    for (const skill of [SKILL_ALPHA, SKILL_BETA]) plantFile(safePath.join(packageDir, 'dist', 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
    // Skill 2 of 2 is already installed and --force is not passed.
    plantFile(safePath.join(claudeDir, 'skills', SKILL_BETA, 'SKILL.md'), '# already here\n');

    const { status, report } = await runInstall(binPath, fakeHome, [packageDir]);

    expect(status).toBe(2);
    expect(report).toMatchObject({ status: 'error', error: { code: 'USAGE_INVALID' }, examined: 1 });
    // Skill 1 is on disk, so the report says so — not "nothing finished".
    expect(report.data?.skills.map((skill) => skill.name)).toStrictEqual([SKILL_ALPHA]);
    expect(fs.existsSync(safePath.join(claudeDir, 'skills', SKILL_ALPHA, 'SKILL.md'))).toBe(true);
  });

  it('refuses a plugin it could not register as INPUT_UNREADABLE — never ok', async () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);
    const { projectDir } = setupPluginTestProject(tempDir, 'unregistrable', 'reg-market', [{ name: 'reg-plugin', skills: ['reg-skill'] }]);
    // settings.json is present and not JSON: registration cannot enable the plugin.
    plantFile(safePath.join(claudeDir, 'settings.json'), '{ "enabledPlugins": ');

    const { status, report } = await runInstall(binPath, fakeHome, [projectDir]);

    expect(status).toBe(2);
    expect(report).toMatchObject({ status: 'error', error: { code: 'INPUT_UNREADABLE' } });
    expect(fs.readFileSync(safePath.join(claudeDir, 'settings.json'), 'utf-8')).toBe('{ "enabledPlugins": ');
    // The marketplace was copied before registration refused: the report says what is on disk.
    expect(report.data?.skills.map((skill) => skill.name)).toStrictEqual(['reg-skill']);
    expect(fs.existsSync(safePath.join(claudeDir, PLUGINS_MARKETPLACES, 'reg-market', 'plugins', 'reg-plugin', 'skills', 'reg-skill'))).toBe(true);
  });

  it.skipIf(CANNOT_DENY_READS)('refuses a skills directory it cannot examine as INPUT_UNREADABLE, never INTERNAL_ERROR', async () => {
    const { tempDir, fakeHome } = createInstallTestContext(createTempDir);
    const skillDir = safePath.join(tempDir, 'locked-target-skill');
    plantFile(safePath.join(skillDir, 'SKILL.md'), '---\nname: locked-target\ndescription: A skill.\n---\n\n# locked-target\n');
    const lockedSkillsDir = safePath.join(tempDir, 'locked-skills');
    mkdirSyncReal(lockedSkillsDir, { recursive: true });
    chmodSync(lockedSkillsDir, 0o000);
    try {
      const { status, report } = await runInstall(binPath, fakeHome, [skillDir, '-s', lockedSkillsDir]);

      expect(status).toBe(2);
      expect(report).toMatchObject({ status: 'error', error: { code: 'INPUT_UNREADABLE' } });
    } finally {
      chmodSync(lockedSkillsDir, 0o755);
    }
  });

  it('refuses a marketplace copy that failed as RUN_INCOMPLETE, never INTERNAL_ERROR', async () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);
    const { projectDir } = setupPluginTestProject(tempDir, 'uncopyable', 'copy-market', [{ name: 'copy-plugin', skills: ['copy-skill'] }]);
    // A FILE where the marketplaces directory must go: the copy cannot land.
    plantFile(safePath.join(claudeDir, PLUGINS_MARKETPLACES), 'not a directory');

    const { status, report } = await runInstall(binPath, fakeHome, [projectDir]);

    expect(status).toBe(2);
    expect(report).toMatchObject({ status: 'error', error: { code: 'RUN_INCOMPLETE' } });
  });

  it('publishes an ok report with no skills when --npm-postinstall is not a global npm install', async () => {
    const tempDir = createTempDir();
    const fakeHome = safePath.join(tempDir, 'home');
    mkdirSyncReal(fakeHome, { recursive: true });

    // Build env without npm_config_global so isGlobalNpmInstall() returns false
    const { status, output, report } = await runInstall(binPath, fakeHome, ['--npm-postinstall'], { npm_lifecycle_event: '', npm_command: '' });

    // A skip is an answer — an `npm install -g` must never fail on it.
    expect(status).toBe(0);
    expect(report).toMatchObject({ status: 'ok', examined: 1, data: { sourceType: 'npm-postinstall', skills: [] } });
    expect(output).toContain('Skipping');
  });

  it('installs multiple plugins from a single project directory', async () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);

    const { projectDir } = setupPluginTestProject(tempDir, 'multi-pkg', MULTI_MARKET, [
      { name: SKILL_ALPHA },
      { name: SKILL_BETA },
    ]);

    await runPluginInstall(binPath, projectDir, fakeHome);

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

    await runPluginInstall(binPath, tgzPath, fakeHome);
    expect(
      fs.existsSync(safePath.join(claudeDir, PLUGINS_MARKETPLACES, 'tgz-market', 'plugins', 'tgz-skill'))
    ).toBe(true);
  });

  it('reinstall overwrites existing plugin tree', async () => {
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);

    const { projectDir } = setupPluginTestProject(tempDir, 'overwrite-pkg', 'ow-market', [
      { name: 'ow-skill' },
    ]);

    // First install
    const first = await executeCliAndParseYaml(binPath, ['claude', 'plugin', 'install', projectDir], {
      env: fakeHomeEnv(fakeHome),
    });
    expect(first.result.status).toBe(0);

    // Modify the skill file so we can detect the overwrite
    const installedSkillDir = safePath.join(claudeDir, PLUGINS_MARKETPLACES, 'ow-market', 'plugins', 'ow-skill');
    fs.writeFileSync(safePath.join(installedSkillDir, 'extra-sentinel.txt'), 'sentinel');

    // Second install (should overwrite — marketplace dir is rm-ed and re-copied)
    const second = await executeCliAndParseYaml(binPath, ['claude', 'plugin', 'install', projectDir], {
      env: fakeHomeEnv(fakeHome),
    });
    expect(second.result.status).toBe(0);

    // After reinstall the skill dir should exist but the sentinel should be gone
    expect(fs.existsSync(installedSkillDir)).toBe(true);
    expect(fs.existsSync(safePath.join(installedSkillDir, 'extra-sentinel.txt'))).toBe(false);
  });

  it('reports every installed skill when plugin has skills/ subdirectory', async () => {
    // Regression test: installPluginTreeAndExit previously passed [] to outputInstallSuccess
    // regardless of how many skills were actually copied, always reporting no installed skills.
    const { tempDir, fakeHome } = createInstallTestContext(createTempDir);

    const { projectDir } = setupPluginTestProject(tempDir, 'pkg-skills-count', 'skills-market', [
      { name: 'my-plugin', skills: [SKILL_ALPHA, SKILL_BETA, 'skill-gamma'] },
    ]);

    const report = await runPluginInstall(binPath, projectDir, fakeHome);

    expect(report.data?.skills).toHaveLength(3);
    const skillNames = (report.data?.skills ?? []).map(s => s.name);
    expect(skillNames).toContain(SKILL_ALPHA);
    expect(skillNames).toContain(SKILL_BETA);
    expect(skillNames).toContain('skill-gamma');
  });

  it('installs a plain skill directory under its declared name, not the directory leaf', async () => {
    // The package.json branch of this same command installs each skill under
    // the name declared in `vat.skills`; the plain-directory branch used the
    // directory leaf, so one command answered "what is this skill called?" two
    // different ways depending on which branch it took.
    const { tempDir, fakeHome, claudeDir } = createInstallTestContext(createTempDir);

    const skillDir = safePath.join(tempDir, 'checkout-folder');
    mkdirSyncReal(skillDir, { recursive: true });
    writeTestFile(
      safePath.join(skillDir, 'SKILL.md'),
      '---\nname: declared-skill\ndescription: Declares a name unlike its folder.\n---\n\n# declared-skill\n',
    );

    const report = await runPluginInstall(binPath, skillDir, fakeHome);

    expect(report.data?.skills[0]?.name).toBe('declared-skill');
    expect(fs.existsSync(safePath.join(claudeDir, 'skills', 'declared-skill', 'SKILL.md'))).toBe(
      true,
    );
    expect(fs.existsSync(safePath.join(claudeDir, 'skills', 'checkout-folder'))).toBe(false);
  });
});
