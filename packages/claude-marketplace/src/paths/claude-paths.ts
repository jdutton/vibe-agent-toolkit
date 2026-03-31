/**
 * Claude user and project directory paths
 *
 * Cross-platform utilities for accessing Claude's user-level and project-level directories.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ClaudeUserPaths {
  /** ~/.claude directory */
  claudeDir: string;
  /** ~/.claude/plugins directory */
  pluginsDir: string;
  /** ~/.claude/skills directory */
  skillsDir: string;
  /** ~/.claude/plugins/marketplaces directory (marketplace clone storage) */
  marketplacesDir: string;
  /** ~/.claude/plugins/cache directory (installed plugin file cache) */
  pluginsCacheDir: string;
  /** ~/.claude/plugins/known_marketplaces.json */
  knownMarketplacesPath: string;
  /** ~/.claude/plugins/installed_plugins.json */
  installedPluginsPath: string;
  /** ~/.claude/settings.json */
  userSettingsPath: string;
  /** ~/.claude.json */
  userDotJsonPath: string;
}

export interface ClaudeProjectPaths {
  /** <projectDir>/.claude/settings.json */
  projectSettingsPath: string;
  /** <projectDir>/.claude/settings.local.json */
  projectSettingsLocalPath: string;
  /** <projectDir>/.claude/CLAUDE.md */
  claudeMdPath: string;
  /** <projectDir>/.mcp.json */
  mcpJsonPath: string;
}

/**
 * Get user-level Claude directories and settings paths.
 *
 * Returns absolute paths to Claude user directories and settings files.
 * Paths are constructed but not checked for existence (caller's responsibility).
 *
 * @example
 * ```typescript
 * const { claudeDir, pluginsDir, userSettingsPath } = getClaudeUserPaths();
 * // claudeDir: /Users/username/.claude
 * // pluginsDir: /Users/username/.claude/plugins
 * // userSettingsPath: /Users/username/.claude/settings.json
 * ```
 */
export function getClaudeUserPaths(): ClaudeUserPaths {
  const home = homedir();
  const claudeDir = process.env['CLAUDE_CONFIG_DIR'] ?? join(home, '.claude');
  const pluginsDir = join(claudeDir, 'plugins');

  return {
    claudeDir,
    pluginsDir,
    skillsDir: join(claudeDir, 'skills'),
    marketplacesDir: join(pluginsDir, 'marketplaces'),
    pluginsCacheDir: join(pluginsDir, 'cache'),
    knownMarketplacesPath: join(pluginsDir, 'known_marketplaces.json'),
    installedPluginsPath: join(pluginsDir, 'installed_plugins.json'),
    userSettingsPath: join(claudeDir, 'settings.json'),
    userDotJsonPath: join(home, '.claude.json'),
  };
}

/**
 * Get project-level Claude paths relative to a project directory.
 *
 * @param projectDir - Absolute path to the project root
 */
export function getClaudeProjectPaths(projectDir: string): ClaudeProjectPaths {
  const claudeDir = join(projectDir, '.claude');

  return {
    projectSettingsPath: join(claudeDir, 'settings.json'),
    projectSettingsLocalPath: join(claudeDir, 'settings.local.json'),
    claudeMdPath: join(claudeDir, 'CLAUDE.md'),
    mcpJsonPath: join(projectDir, '.mcp.json'),
  };
}
