import { homedir } from 'node:os';
import { join } from 'node:path';

import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, it, expect } from 'vitest';

import { getClaudeUserPaths, getClaudeProjectPaths } from '../src/paths/claude-paths.js';

describe('getClaudeUserPaths', () => {
  it('should return absolute paths to Claude directories', () => {
    const paths = getClaudeUserPaths();

    // All paths should be absolute
    expect(paths.claudeDir).toMatch(/^[/\\]|^[A-Za-z]:[/\\]/);
    expect(paths.pluginsDir).toMatch(/^[/\\]|^[A-Za-z]:[/\\]/);
    expect(paths.skillsDir).toMatch(/^[/\\]|^[A-Za-z]:[/\\]/);
    expect(paths.marketplacesDir).toMatch(/^[/\\]|^[A-Za-z]:[/\\]/);
  });

  it('should return paths based on user home directory', () => {
    const paths = getClaudeUserPaths();
    const home = homedir();

    expect(paths.claudeDir).toBe(join(home, '.claude'));
    expect(paths.pluginsDir).toBe(join(home, '.claude', 'plugins'));
    expect(paths.skillsDir).toBe(join(home, '.claude', 'skills'));
    expect(paths.marketplacesDir).toBe(join(home, '.claude', 'plugins', 'marketplaces'));
    expect(paths.pluginsCacheDir).toBe(join(home, '.claude', 'plugins', 'cache'));
    expect(paths.knownMarketplacesPath).toBe(join(home, '.claude', 'plugins', 'known_marketplaces.json'));
    expect(paths.installedPluginsPath).toBe(join(home, '.claude', 'plugins', 'installed_plugins.json'));
    expect(paths.userSettingsPath).toBe(join(home, '.claude', 'settings.json'));
    expect(paths.userDotJsonPath).toBe(join(home, '.claude.json'));
  });

  it('should return consistent paths on multiple calls', () => {
    const paths1 = getClaudeUserPaths();
    const paths2 = getClaudeUserPaths();

    expect(paths1.claudeDir).toBe(paths2.claudeDir);
    expect(paths1.pluginsDir).toBe(paths2.pluginsDir);
    expect(paths1.skillsDir).toBe(paths2.skillsDir);
    expect(paths1.marketplacesDir).toBe(paths2.marketplacesDir);
  });

  it('should use path.join for proper path construction', () => {
    const paths = getClaudeUserPaths();
    const home = homedir();

    // Verify no double slashes or backslashes
    expect(paths.claudeDir).not.toContain('//');
    expect(paths.claudeDir).not.toContain('\\\\');

    // Verify proper subdirectories relative to home
    expect(paths.pluginsDir).toContain(home);
    expect(paths.pluginsDir).toContain('.claude');
    expect(paths.skillsDir).toContain('.claude');
    expect(paths.marketplacesDir).toContain('.claude');
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
