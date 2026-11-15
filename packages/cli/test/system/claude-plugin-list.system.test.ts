/**
 * System tests for `vat claude plugin list` command.
 */



import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { PLUGIN_LIST_REPORT_SCHEMA } from '../../src/commands/claude/plugin/list-schema.js';

import {
  createTempDirTracker,
  executeCliAndParseYaml,
  fakeHomeEnv,
  getBinPath,
  writeTestFile,
} from './test-common.js';

const TEMP_DIR_PREFIX = 'vat-plugin-list-test-';

/**
 * Create an isolated fake home directory for a single list test.
 * Extracted to eliminate the repeated createTempDir/fakeHome/mkdirSyncReal pattern.
 */
function createListTestHome(createTempDir: () => string): string {
  const tempDir = createTempDir();
  const fakeHome = safePath.join(tempDir, 'home');
  mkdirSyncReal(fakeHome, { recursive: true });
  return fakeHome;
}

/**
 * Run `vat claude plugin list` against a fake home directory and return the parsed output.
 * Extracted to eliminate the repeated executeCliAndParseYaml + fakeHomeEnv + status-check pattern.
 */
async function runPluginList(
  binPath: string,
  fakeHome: string,
  extraArgs: string[] = []
): Promise<{ status: number | null; parsed: Record<string, unknown> }> {
  const { result, parsed } = await executeCliAndParseYaml(
    binPath,
    ['claude', 'plugin', 'list', ...extraArgs],
    { env: fakeHomeEnv(fakeHome) }
  );
  return { status: result.status, parsed };
}

describe('claude plugin list command (system test)', () => {
  const binPath = getBinPath(import.meta.url);
  const { createTempDir, cleanupTempDirs } = createTempDirTracker(TEMP_DIR_PREFIX);

  afterEach(() => {
    cleanupTempDirs();
  });

  it('returns empty listings when nothing installed, both registries consulted', async () => {
    const fakeHome = createListTestHome(createTempDir);

    const { status, parsed } = await runPluginList(binPath, fakeHome);

    expect(status).toBe(0);
    const report = PLUGIN_LIST_REPORT_SCHEMA.parse(parsed);
    expect(report.status).toBe('ok');
    expect(report.examined).toBe(2);
    expect(report.data).toMatchObject({ target: 'code', plugins: [], legacySkills: [] });
    expect(report.data?.sources.pluginRegistry).toBe(safePath.join(fakeHome, '.claude', 'plugins', 'installed_plugins.json'));
    expect(report.data?.sources.legacySkillsDir).toBe(safePath.join(fakeHome, '.claude', 'skills'));
  });

  it('lists plugins from registry', async () => {
    const tempDir = createTempDir();
    const fakeHome = safePath.join(tempDir, 'home');
    const pluginsDir = safePath.join(fakeHome, '.claude', 'plugins');
    mkdirSyncReal(safePath.join(pluginsDir, 'marketplaces', 'test-market', 'plugins', 'my-skill'), { recursive: true });

    const now = new Date().toISOString();
    writeTestFile(safePath.join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'my-skill@test-market': [
          { scope: 'user', installPath: '', version: '1.0.0', installedAt: now, lastUpdated: now },
        ],
      },
    }));

    const { status, parsed } = await runPluginList(binPath, fakeHome);

    expect(status).toBe(0);
    const plugins = PLUGIN_LIST_REPORT_SCHEMA.parse(parsed).data?.plugins;
    expect(plugins).toHaveLength(1);
    expect(plugins?.[0]).toMatchObject({ name: 'my-skill', marketplace: 'test-market', version: '1.0.0' });
  });

  it('lists legacy skills from ~/.claude/skills/', async () => {
    const tempDir = createTempDir();
    const fakeHome = safePath.join(tempDir, 'home');
    const skillsDir = safePath.join(fakeHome, '.claude', 'skills', 'legacy-skill');
    mkdirSyncReal(skillsDir, { recursive: true });
    writeTestFile(safePath.join(skillsDir, 'SKILL.md'), '# legacy-skill\nOld-style skill');

    const { status, parsed } = await runPluginList(binPath, fakeHome);

    expect(status).toBe(0);
    expect(PLUGIN_LIST_REPORT_SCHEMA.parse(parsed).data?.legacySkills).toMatchObject([{ name: 'legacy-skill', type: 'directory' }]);
  });

  it('refuses a plugin registry that is not JSON as INPUT_UNREADABLE, not INTERNAL_ERROR', async () => {
    const fakeHome = createListTestHome(createTempDir);
    mkdirSyncReal(safePath.join(fakeHome, '.claude', 'plugins'), { recursive: true });
    writeTestFile(safePath.join(fakeHome, '.claude', 'plugins', 'installed_plugins.json'), '{ "plugins": ');

    const { status, parsed } = await runPluginList(binPath, fakeHome);

    expect(status).toBe(2);
    expect(PLUGIN_LIST_REPORT_SCHEMA.parse(parsed)).toMatchObject({ status: 'error', error: { code: 'INPUT_UNREADABLE' } });
  });

  it('list --target claude.ai refuses with USAGE_INVALID, exit 2', async () => {
    const fakeHome = createListTestHome(createTempDir);

    const { status, parsed } = await runPluginList(binPath, fakeHome, ['--target', 'claude.ai']);

    // The command cannot do what was asked; it is not a finding about a plugin.
    expect(status).toBe(2);
    const report = PLUGIN_LIST_REPORT_SCHEMA.parse(parsed);
    expect(report.status).toBe('error');
    expect(report).toMatchObject({ error: { code: 'USAGE_INVALID' } });
  });
});
