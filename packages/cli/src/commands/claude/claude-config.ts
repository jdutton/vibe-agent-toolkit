/**
 * Shared config loading utilities for `vat claude` subcommands.
 */

import { dirname } from 'node:path';

import { parseConfigFile, type ClaudeConfig } from '@vibe-agent-toolkit/resources';
import { findConfigFile } from '@vibe-agent-toolkit/utils';

export interface LoadedClaudeConfig {
  configPath: string;
  configDir: string;
  claudeConfig: ClaudeConfig;
}

/**
 * Find, parse, and return the claude: section of the project config.
 * Throws if the config file cannot be found or parsed.
 * Returns null for claudeConfig when the claude: section is absent.
 */
export async function loadClaudeProjectConfig(): Promise<{
  configPath: string;
  configDir: string;
  claudeConfig: ClaudeConfig | undefined;
}> {
  // findConfigFile from utils is synchronous; await of a non-promise is a no-op.
  const configPath = findConfigFile(process.cwd());
  if (!configPath) {
    throw new Error('No vibe-agent-toolkit.config.yaml found. Run from a project directory.');
  }

  // No `onUnknownKeys` argument: `parseConfigFile` already DEFAULTS to writing
  // the warning to stderr, which is exactly what this lane needs — unknown keys
  // are a warning rather than a refusal, and stderr keeps the YAML document on
  // stdout machine-readable. Passing a callback byte-identical to the default
  // said "this command has an opinion here" while changing nothing, so a later
  // reader would have to diff it against the default to learn it was dead.
  const config = await parseConfigFile(configPath);
  const configDir = dirname(configPath);

  return { configPath, configDir, claudeConfig: config.claude };
}
