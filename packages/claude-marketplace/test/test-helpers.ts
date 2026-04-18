import { mkdtempSync, rmSync } from 'node:fs';


import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach } from 'vitest';

import type { ClaudeUserPaths } from '../src/paths/claude-paths.js';

export interface SetupPluginTestPathsOptions {
  /** If true, also creates paths.skillsDir for legacy skill tests */
  withSkillsDir?: boolean;
}

/**
 * Set up a fresh temp directory with Claude paths for each test suite.
 *
 * Always creates marketplacesDir and pluginsCacheDir.
 * Pass `{ withSkillsDir: true }` to also create skillsDir (needed by plugin-list tests).
 *
 * Usage:
 *   const { getPaths } = setupPluginTestPaths();
 *   // or
 *   const { getPaths } = setupPluginTestPaths({ withSkillsDir: true });
 */
export function setupPluginTestPaths(opts: SetupPluginTestPathsOptions = {}): { getPaths: () => ClaudeUserPaths } {
  let tempDir = '';
  beforeEach(() => {
    tempDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-plugin-test-'));
    const paths = buildTestPaths(tempDir);
    mkdirSyncReal(paths.marketplacesDir, { recursive: true });
    mkdirSyncReal(paths.pluginsCacheDir, { recursive: true });
    if (opts.withSkillsDir === true) {
      mkdirSyncReal(paths.skillsDir, { recursive: true });
    }
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });
  return { getPaths: () => buildTestPaths(tempDir) };
}

/**
 * Build test ClaudeUserPaths rooted in a temp base directory.
 * Uses a flat structure: base/.claude/plugins/... to avoid duplicating getClaudeUserPaths.
 */
export function buildTestPaths(base: string): ClaudeUserPaths {
  const root = safePath.join(base, '.claude');
  const plugins = safePath.join(root, 'plugins');
  return {
    claudeDir: root,
    pluginsDir: plugins,
    skillsDir: safePath.join(root, 'skills'),
    marketplacesDir: safePath.join(plugins, 'marketplaces'),
    pluginsCacheDir: safePath.join(plugins, 'cache'),
    knownMarketplacesPath: safePath.join(plugins, 'known_marketplaces.json'),
    installedPluginsPath: safePath.join(plugins, 'installed_plugins.json'),
    userSettingsPath: safePath.join(root, 'settings.json'),
    userDotJsonPath: safePath.join(base, '.claude.json'),
  };
}

/** Build a markdown bash code block containing a single command */
export function bashCodeBlock(command: string): string {
  return ['```bash', command, '```'].join('\n');
}
