/**
 * Shared config loading utilities for `vat claude` subcommands.
 */

import { dirname } from 'node:path';

import type { ClaudeConfig, ProjectConfig } from '@vibe-agent-toolkit/resources';
import { findConfigFile } from '@vibe-agent-toolkit/utils';

import { CommandRefusalError } from '../../utils/command-refusal.js';
import { loadConfig } from '../../utils/config-loader.js';

export interface LoadedClaudeConfig {
  configPath: string;
  configDir: string;
  claudeConfig: ClaudeConfig;
}

/**
 * Find, parse, and return the project config for a `vat claude` verb.
 * Refuses `CONFIG_INVALID` when no config file is found; a config that cannot
 * be read or does not parse throws the loader's coded error.
 *
 * Parsed by the CLI's `loadConfig` — the reader `claude plugin build` hands
 * on to the marketplace build — so a verb that loads here and builds there
 * reads the file once and warns about an unknown key once. It used to parse
 * through `parseConfigFile` as well, and printed the same warning twice.
 * `claudeConfig` is undefined when the `claude:` section is absent.
 */
export async function loadClaudeProjectConfig(): Promise<{
  configPath: string;
  configDir: string;
  projectConfig: ProjectConfig | undefined;
  claudeConfig: ClaudeConfig | undefined;
}> {
  // findConfigFile from utils is synchronous; await of a non-promise is a no-op.
  const configPath = findConfigFile(process.cwd());
  if (!configPath) {
    throw new CommandRefusalError('CONFIG_INVALID', 'No vibe-agent-toolkit.config.yaml found. Run from a project directory.');
  }

  const configDir = dirname(configPath);
  const projectConfig = loadConfig(configDir);

  return { configPath, configDir, projectConfig, claudeConfig: projectConfig?.claude };
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
