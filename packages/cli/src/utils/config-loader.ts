/**
 * Configuration file loading and validation
 *
 * Environment Variables:
 * - VAT_TEST_CONFIG: Override config file path for testing (absolute path)
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { ProjectConfigSchema, type ProjectConfig } from '@vibe-agent-toolkit/resources';
import * as yaml from 'js-yaml';

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
 *
 * @param projectRoot - Project root directory
 * @returns Validated configuration or undefined if not found
 * @throws Error if config file exists but is invalid
 *
 * @remarks
 * Can be overridden with VAT_TEST_CONFIG environment variable for testing.
 * When set, VAT_TEST_CONFIG should be an absolute path to a config file.
 *
 * @example
 * ```typescript
 * // Normal usage
 * const config = loadConfig('/path/to/project');
 *
 * // Test usage with override
 * process.env.VAT_TEST_CONFIG = '/path/to/test/fixtures/config.yaml';
 * const config = loadConfig('/any/path'); // Uses override path
 * ```
 */
export function loadConfig(projectRoot: string): ProjectConfig | undefined {
  // Override for testing: VAT_TEST_CONFIG provides explicit config path
  const configPath = process.env['VAT_TEST_CONFIG'] ?? join(projectRoot, CONFIG_FILENAME);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- configPath is derived from projectRoot parameter or env override
  if (!existsSync(configPath)) {
    return undefined;
  }

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- configPath is derived from projectRoot parameter
    const content = readFileSync(configPath, 'utf-8');
    const parsed = yaml.load(content);

    // Validate with canonical schema from resources package
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

/**
 * Get the directory containing a config file path.
 */
export function getConfigDir(configPath: string): string {
  return dirname(configPath);
}
