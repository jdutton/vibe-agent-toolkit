import { homedir } from 'node:os';


import { toForwardSlash, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { getClaudeUserPaths, getClaudeProjectPaths } from '../src/paths/claude-paths.js';

describe('getClaudeUserPaths', () => {
  beforeEach(() => { delete process.env['CLAUDE_CONFIG_DIR']; });
  afterEach(() => { delete process.env['CLAUDE_CONFIG_DIR']; });

  it('should return absolute paths to Claude directories', () => {
    const paths = getClaudeUserPaths();

    // All paths should be absolute
    expect(paths.claudeDir).toMatch(/^[/\\]|^[A-Za-z]:[/\\]/);
    expect(paths.pluginsDir).toMatch(/^[/\\]|^[A-Za-z]:[/\\]/);
    expect(paths.skillsDir).toMatch(/^[/\\]|^[A-Za-z]:[/\\]/);
    expect(paths.marketplacesDir).toMatch(/^[/\\]|^[A-Za-z]:[/\\]/);
  });

  it('should default to ~/.claude when CLAUDE_CONFIG_DIR is not set', () => {
    const paths = getClaudeUserPaths();
    const home = homedir();

    expect(paths.claudeDir).toBe(safePath.join(home, '.claude'));
    expect(paths.pluginsDir).toBe(safePath.join(home, '.claude', 'plugins'));
    expect(paths.skillsDir).toBe(safePath.join(home, '.claude', 'skills'));
    expect(paths.marketplacesDir).toBe(safePath.join(home, '.claude', 'plugins', 'marketplaces'));
    expect(paths.pluginsCacheDir).toBe(safePath.join(home, '.claude', 'plugins', 'cache'));
    expect(paths.knownMarketplacesPath).toBe(safePath.join(home, '.claude', 'plugins', 'known_marketplaces.json'));
    expect(paths.installedPluginsPath).toBe(safePath.join(home, '.claude', 'plugins', 'installed_plugins.json'));
    expect(paths.userSettingsPath).toBe(safePath.join(home, '.claude', 'settings.json'));
    expect(paths.userDotJsonPath).toBe(safePath.join(home, '.claude.json'));
  });

  it('should use CLAUDE_CONFIG_DIR when set', () => {
    const customDir = '/custom/claude';
    process.env['CLAUDE_CONFIG_DIR'] = customDir;
    const paths = getClaudeUserPaths();

    expect(paths.claudeDir).toBe(customDir);
    expect(paths.pluginsDir).toBe(safePath.join(customDir, 'plugins'));
    expect(paths.skillsDir).toBe(safePath.join(customDir, 'skills'));
    expect(paths.userSettingsPath).toBe(safePath.join(customDir, 'settings.json'));
  });

  it('should return consistent paths on multiple calls', () => {
    const paths1 = getClaudeUserPaths();
    const paths2 = getClaudeUserPaths();

    expect(paths1.claudeDir).toBe(paths2.claudeDir);
    expect(paths1.pluginsDir).toBe(paths2.pluginsDir);
    expect(paths1.skillsDir).toBe(paths2.skillsDir);
    expect(paths1.marketplacesDir).toBe(paths2.marketplacesDir);
  });
});

describe('getClaudeProjectPaths', () => {
  it('should return project-relative paths', () => {
    const paths = getClaudeProjectPaths('/my/project');
    expect(toForwardSlash(paths.projectSettingsPath)).toBe('/my/project/.claude/settings.json');
    expect(toForwardSlash(paths.projectSettingsLocalPath)).toBe('/my/project/.claude/settings.local.json');
    expect(toForwardSlash(paths.claudeMdPath)).toBe('/my/project/.claude/CLAUDE.md');
    expect(toForwardSlash(paths.mcpJsonPath)).toBe('/my/project/.mcp.json');
  });
});
