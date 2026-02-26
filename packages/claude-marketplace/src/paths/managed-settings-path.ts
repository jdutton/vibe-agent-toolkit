/**
 * OS-aware path resolution for managed-settings.json
 *
 * Returns candidate paths in priority order. Callers should try each path and
 * use the first that exists and is readable.
 */

import { platform } from 'node:os';

/**
 * Returns candidate paths for managed-settings.json in priority order.
 * Windows returns two paths: current (Program Files) first, legacy (ProgramData) second.
 * Other platforms return a single path (or empty array for unknown platforms).
 */
export function getManagedSettingsCandidatePaths(): string[] {
  const p = platform();

  if (p === 'darwin') {
    return ['/Library/Application Support/ClaudeCode/managed-settings.json'];
  }

  if (p === 'linux') {
    return ['/etc/claude-code/managed-settings.json'];
  }

  if (p === 'win32') {
    // Current path only — legacy ProgramData path is treated as an error (see getSettingsPaths)
    return [String.raw`C:\Program Files\ClaudeCode\managed-settings.json`];
  }

  // Unknown platform — gracefully return nothing
  return [];
}

/**
 * The legacy Windows path that Claude Code previously used.
 * If a file exists here it is an error — IT admin must migrate.
 */
export const WINDOWS_LEGACY_MANAGED_SETTINGS_PATH =
  String.raw`C:\ProgramData\ClaudeCode\managed-settings.json`;
