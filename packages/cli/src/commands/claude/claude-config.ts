/**
 * Shared config loading utilities for `vat claude` subcommands.
 */

import { dirname } from 'node:path';

import { parseConfigFile, type ClaudeConfig } from '@vibe-agent-toolkit/resources';
import { findConfigFile } from '@vibe-agent-toolkit/utils';

import { CommandRefusalError } from '../../utils/command-refusal.js';

export interface LoadedClaudeConfig {
  configPath: string;
  configDir: string;
  claudeConfig: ClaudeConfig;
}

/**
 * Find, parse, and return the claude: section of the project config.
 * Refuses `CONFIG_INVALID` when no config file is found; a config that does
 * not parse throws the parser's coded error.
 * Returns undefined for claudeConfig when the claude: section is absent.
 */
export async function loadClaudeProjectConfig(): Promise<{
  configPath: string;
  configDir: string;
  claudeConfig: ClaudeConfig | undefined;
}> {
  // findConfigFile from utils is synchronous; await of a non-promise is a no-op.
  const configPath = findConfigFile(process.cwd());
  if (!configPath) {
    throw new CommandRefusalError('CONFIG_INVALID', 'No vibe-agent-toolkit.config.yaml found. Run from a project directory.');
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

/**
 * Refuse a `--marketplace <name>` the config does not declare — the
 * invocation's mistake, like an undeclared `--collection`. A declared
 * marketplace the verb then has nothing to do with is not this refusal.
 *
 * @param requested - The `--marketplace` value, when one was passed
 * @param declared - The names under `claude.marketplaces`
 * @throws {CommandRefusalError} `USAGE_INVALID` naming the declared marketplaces
 */
export function assertMarketplaceDeclared(requested: string | undefined, declared: readonly string[]): void {
  if (requested === undefined || declared.includes(requested)) return;
  throw new CommandRefusalError(
    'USAGE_INVALID',
    `Marketplace "${requested}" is not declared in claude.marketplaces (declared: ${declared.length === 0 ? 'none' : declared.join(', ')}).`,
  );
}
