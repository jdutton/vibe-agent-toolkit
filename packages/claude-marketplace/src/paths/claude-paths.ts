/**
 * Claude user and project directory paths
 *
 * Cross-platform utilities for accessing Claude's user-level and project-level directories.
 */

import { homedir } from 'node:os';

import { safePath } from '@vibe-agent-toolkit/utils';

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
  /** <projectDir>/.mcp.json */
  mcpJsonPath: string;
}

/**
 * Build ClaudeUserPaths from a resolved claudeDir root.
 * Called by getClaudeUserPaths and by callers with a custom install root.
 */
export function buildClaudeUserPaths(claudeDir: string): ClaudeUserPaths {
  const pluginsDir = safePath.join(claudeDir, 'plugins');
  const home = homedir();

  return {
    claudeDir,
    pluginsDir,
    skillsDir: safePath.join(claudeDir, 'skills'),
    marketplacesDir: safePath.join(pluginsDir, 'marketplaces'),
    pluginsCacheDir: safePath.join(pluginsDir, 'cache'),
    knownMarketplacesPath: safePath.join(pluginsDir, 'known_marketplaces.json'),
    installedPluginsPath: safePath.join(pluginsDir, 'installed_plugins.json'),
    userSettingsPath: safePath.join(claudeDir, 'settings.json'),
    userDotJsonPath: safePath.join(home, '.claude.json'),
  };
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
  return buildClaudeUserPaths(resolveClaudeDir(homedir()));
}

/**
 * The install root `CLAUDE_CONFIG_DIR` names, as an ABSOLUTE path — or `~/.claude`
 * when it names nothing usable.
 *
 * Three shapes of the variable used to leak straight through `??` and
 * `join`, and each one silently relocated every install root derived from it:
 *
 * - **Blank.** `CLAUDE_CONFIG_DIR=` is how a shell and a CI env block unset a
 *   value, but the empty string is not nullish, so `??` kept it and the derived
 *   paths became the RELATIVE strings `skills`, `plugins`. Whoever resolved them
 *   first anchored them at `process.cwd()` — turning `$cwd/skills`, the
 *   conventional source pool, into a Claude install root.
 * - **Relative.** Same anchor problem, without the accident: the same tree
 *   classified differently depending on where the command was invoked from.
 * - **`~`-prefixed.** Nothing expands `~` inside a `.env` file or a CI variable
 *   block, and resolving it literally yields `$cwd/~/.claude` — a directory that
 *   exists nowhere, so every install-root test quietly answers "no".
 *
 * Resolved HERE, at the single place the variable is read, rather than in each
 * consumer: a consumer that forgets is not distinguishable from one that has no
 * opinion.
 */
function resolveClaudeDir(home: string): string {
  const configured = process.env['CLAUDE_CONFIG_DIR']?.trim();
  if (configured === undefined || configured.length === 0) {
    return safePath.join(home, '.claude');
  }
  if (configured === '~' || configured.startsWith('~/') || configured.startsWith('~\\')) {
    return safePath.join(home, configured.slice(1));
  }
  return safePath.resolve(configured);
}

/**
 * Get project-level Claude paths relative to a project directory.
 *
 * @param projectDir - Absolute path to the project root
 */
export function getClaudeProjectPaths(projectDir: string): ClaudeProjectPaths {
  const claudeDir = safePath.join(projectDir, '.claude');

  return {
    projectSettingsPath: safePath.join(claudeDir, 'settings.json'),
    projectSettingsLocalPath: safePath.join(claudeDir, 'settings.local.json'),
    mcpJsonPath: safePath.join(projectDir, '.mcp.json'),
  };
}
