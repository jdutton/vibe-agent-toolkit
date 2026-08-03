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
    // Resolved, not taken verbatim: on Windows a rooted-but-driveless spelling
    // like this one only becomes absolute after `resolve`.
    const customDir = safePath.resolve('/custom/claude');
    process.env['CLAUDE_CONFIG_DIR'] = '/custom/claude';
    const paths = getClaudeUserPaths();

    expect(paths.claudeDir).toBe(customDir);
    expect(paths.pluginsDir).toBe(safePath.join(customDir, 'plugins'));
    expect(paths.skillsDir).toBe(safePath.join(customDir, 'skills'));
    expect(paths.userSettingsPath).toBe(safePath.join(customDir, 'settings.json'));
  });

  // A8 — `??` is nullish coalescing, so `CLAUDE_CONFIG_DIR=` (the ordinary way a
  // shell or a CI env block blanks a variable) produced claudeDir `''`, and every
  // path below it became RELATIVE: `skills`, `plugins`. Consumers resolve those
  // against `process.cwd()`, so `$cwd/skills` — the conventional source pool —
  // became a Claude install root and ordinary source tripped install-root rules.
  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('should ignore a %s CLAUDE_CONFIG_DIR and fall back to ~/.claude', (_label, value) => {
    process.env['CLAUDE_CONFIG_DIR'] = value;
    const paths = getClaudeUserPaths();

    expect(paths.claudeDir).toBe(safePath.join(homedir(), '.claude'));
    expect(paths.skillsDir).toBe(safePath.join(homedir(), '.claude', 'skills'));
  });

  // C7 — a relative value made every derived path resolve against whatever
  // `process.cwd()` happened to be in the consumer, so the same tree classified
  // two different ways depending on where the command was invoked from.
  it('should resolve a relative CLAUDE_CONFIG_DIR to an absolute path', () => {
    process.env['CLAUDE_CONFIG_DIR'] = 'relclaude';
    const paths = getClaudeUserPaths();

    expect(paths.claudeDir).toBe(safePath.resolve('relclaude'));
    expect(paths.skillsDir).toBe(safePath.join(safePath.resolve('relclaude'), 'skills'));
  });

  // A `~` written in a `.env` file or a CI variable block is never expanded by a
  // shell, and resolving it literally yields `$cwd/~/.claude` — a directory that
  // exists nowhere, silently disabling every install-root check.
  it('should expand a leading ~ in CLAUDE_CONFIG_DIR', () => {
    process.env['CLAUDE_CONFIG_DIR'] = '~/.claude-alt';
    const paths = getClaudeUserPaths();

    expect(paths.claudeDir).toBe(safePath.join(homedir(), '.claude-alt'));
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
    expect(toForwardSlash(paths.mcpJsonPath)).toBe('/my/project/.mcp.json');
  });
});
