/**
 * Configuration file loading and validation
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import * as yaml from 'js-yaml';

import { ProjectConfigSchema, DEFAULT_CONFIG, type ProjectConfig } from '../schemas/config.js';

const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';

/**
 * Find configuration file by walking up directory tree
 * @param startDir - Starting directory (defaults to cwd)
 * @returns Path to config file, or null if not found
 */
export function findConfigPath(startDir?: string): string | null {
  let currentDir = startDir ?? process.cwd();
  const root = '/';

  while (currentDir !== root) {
    const configPath = join(currentDir, CONFIG_FILENAME);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Dynamic path walking is required for config file search
    if (existsSync(configPath)) {
      return configPath;
    }
    currentDir = join(currentDir, '..');
  }

  return null;
}

/**
 * Load and validate project configuration
 * @param projectRoot - Project root directory
 * @returns Validated configuration or default if not found
 * @throws Error if config file exists but is invalid
 */
export function loadConfig(projectRoot: string): ProjectConfig {
  const configPath = join(projectRoot, CONFIG_FILENAME);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- configPath is derived from projectRoot parameter
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- configPath is derived from projectRoot parameter
    const content = readFileSync(configPath, 'utf-8');
    const parsed = yaml.load(content);

    // Validate with Zod schema
    const result = ProjectConfigSchema.safeParse(parsed);

    if (!result.success) {
      throw new Error(
        `Invalid configuration file: ${result.error.message}`
      );
    }

    return result.data;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to load config: ${error.message}`);
    }
    throw error;
  }
}
