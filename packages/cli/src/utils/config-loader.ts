/**
 * Configuration file loading and validation
 *
 * Environment Variables:
 * - VAT_TEST_CONFIG: Override config file path for testing (absolute path)
 */

import { readFileSync, existsSync } from 'node:fs';
import {  dirname, parse } from 'node:path';

import { ProjectConfigSchema, type ProjectConfig } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import * as yaml from 'js-yaml';

const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';

/**
 * Find configuration file by walking up directory tree
 * @param startDir - Starting directory (defaults to cwd)
 * @returns Path to config file, or null if not found
 */
export function findConfigPath(startDir?: string): string | null {
  let currentDir = safePath.resolve(startDir ?? process.cwd());
  const root = parse(currentDir).root;

  while (currentDir !== root) {
    const configPath = safePath.join(currentDir, CONFIG_FILENAME);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Dynamic path walking is required for config file search
    if (existsSync(configPath)) {
      return configPath;
    }
    const parent = dirname(currentDir);
    if (parent === currentDir) break; // safety: at filesystem root
    currentDir = parent;
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
  const configPath = process.env['VAT_TEST_CONFIG'] ?? safePath.join(projectRoot, CONFIG_FILENAME);

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

/**
 * Module-level cache keyed by configRoot → parsed ProjectConfig (or null if
 * the file failed to load). Avoids re-parsing the same config yaml repeatedly
 * when audit walks up from many sibling skills.
 *
 * Tests that mutate fixtures between runs must call {@link resetGoverningConfigCache}
 * to invalidate this cache.
 */
const governingConfigCache: Map<string, ProjectConfig | null> = new Map();

/**
 * Reset the governing-config cache used by {@link findGoverningConfig}.
 * Call at the start of each `vat audit` invocation so in-process test suites
 * that mutate fixtures between runs do not observe stale config data.
 */
export function resetGoverningConfigCache(): void {
  governingConfigCache.clear();
}

/**
 * Walk UP from `skillDir` looking for the nearest-ancestor
 * `vibe-agent-toolkit.config.yaml`. Loads and caches the config on first hit.
 *
 * Returns the parsed config plus the `configRoot` (directory that contained the
 * yaml), or `null` if no config is found anywhere up the tree.
 *
 * **Cache behavior:** Both successful loads and parse failures are cached
 * (failures as `null`) so a broken config doesn't re-parse on every skill in
 * the same scan. A test that edits a broken config into a good one between
 * calls must invoke {@link resetGoverningConfigCache} to pick up the new
 * state — the audit CLI entrypoint already does this via `resetAuditCaches()`.
 */
export function findGoverningConfig(
  skillDir: string
): { config: ProjectConfig; configRoot: string } | null {
  const configPath = findConfigPath(skillDir);
  if (configPath === null) {
    return null;
  }
  const configRoot = dirname(configPath);

  const cached = governingConfigCache.get(configRoot);
  if (cached !== undefined) {
    return cached === null ? null : { config: cached, configRoot };
  }

  try {
    const config = loadConfig(configRoot);
    if (config === undefined) {
      governingConfigCache.set(configRoot, null);
      return null;
    }
    governingConfigCache.set(configRoot, config);
    return { config, configRoot };
  } catch {
    // Invalid config — cache as null so we don't re-parse on every skill.
    governingConfigCache.set(configRoot, null);
    return null;
  }
}
