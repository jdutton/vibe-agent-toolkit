/**
 * System tests for `vat claude plugin list` command.
 */

import { join } from 'node:path';

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

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
  const fakeHome = join(tempDir, 'home');
  mkdirSyncReal(fakeHome, { recursive: true });
  return fakeHome;
}

/**
 * Run `vat claude plugin list` against a fake home directory and return the parsed output.
 * Extracted to eliminate the repeated executeCliAndParseYaml + fakeHomeEnv + status-check pattern.
 */
function runPluginList(
  binPath: string,
  fakeHome: string,
  extraArgs: string[] = []
): { status: number | null; parsed: Record<string, unknown> } {
  const { result, parsed } = executeCliAndParseYaml(
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

  it('returns empty counts when nothing installed', () => {
    const fakeHome = createListTestHome(createTempDir);

    const { status, parsed } = runPluginList(binPath, fakeHome);

    expect(status).toBe(0);
    expect(parsed.status).toBe('success');
    expect(parsed.target).toBe('code');
    const sources = parsed.sources as Record<string, number>;
    expect(sources.pluginRegistry).toBe(0);
    expect(sources.legacySkillsDir).toBe(0);
  });

  it('lists plugins from registry', () => {
    const tempDir = createTempDir();
    const fakeHome = join(tempDir, 'home');
    const pluginsDir = join(fakeHome, '.claude', 'plugins');
    mkdirSyncReal(join(pluginsDir, 'marketplaces', 'test-market', 'plugins', 'my-skill'), { recursive: true });

    const now = new Date().toISOString();
    writeTestFile(join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'my-skill@test-market': [
          { scope: 'user', installPath: '', version: '1.0.0', installedAt: now, lastUpdated: now },
        ],
      },
    }));

    const { status, parsed } = runPluginList(binPath, fakeHome);

    expect(status).toBe(0);
    const sources = parsed.sources as Record<string, number>;
    expect(sources.pluginRegistry).toBe(1);
    const plugins = parsed.plugins as Array<Record<string, unknown>>;
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({ name: 'my-skill', marketplace: 'test-market', version: '1.0.0' });
  });

  it('counts legacy skills from ~/.claude/skills/', () => {
    const tempDir = createTempDir();
    const fakeHome = join(tempDir, 'home');
    const skillsDir = join(fakeHome, '.claude', 'skills', 'legacy-skill');
    mkdirSyncReal(skillsDir, { recursive: true });
    writeTestFile(join(skillsDir, 'SKILL.md'), '# legacy-skill\nOld-style skill');

    const { status, parsed } = runPluginList(binPath, fakeHome);

    expect(status).toBe(0);
    const sources = parsed.sources as Record<string, number>;
    expect(sources.legacySkillsDir).toBe(1);
  });

  it('returns not-available for unsupported --target', () => {
    const fakeHome = createListTestHome(createTempDir);

    const { status, parsed } = runPluginList(binPath, fakeHome, ['--target', 'claude.ai']);

    expect(status).toBe(1);
    expect(parsed.status).toBe('not-available');
  });
});
