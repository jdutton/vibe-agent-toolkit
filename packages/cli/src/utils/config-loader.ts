/**
 * Configuration file loading and validation
 *
 * Environment Variables:
 * - VAT_TEST_CONFIG: Override config file path for testing (absolute path)
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { ProjectConfigSchema, type ProjectConfig } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import * as yaml from 'yaml';

const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';

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
    const parsed = yaml.parse(content);

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
 * Layer 2 cache for {@link loadConfigCached}.
 *
 * Keyed by `projectRoot` → parsed {@link ProjectConfig} (or `null` if the
 * file failed to load). Avoids re-parsing the same config yaml repeatedly
 * when audit walks up from many sibling skills sharing one governing config.
 *
 * Tests that mutate fixtures between runs must call
 * {@link resetLoadedConfigCache} to invalidate this cache.
 *
 * See spec docs/superpowers/specs/2026-05-17-root-model-and-leading-slash-design.md §8.
 */
const loadedConfigCache: Map<string, ProjectConfig | null> = new Map();

/**
 * Reset the cache used by {@link loadConfigCached}.
 *
 * Call at the start of each independent CLI invocation (e.g. `vat audit`) so
 * in-process callers don't observe stale config data across runs.
 */
export function resetLoadedConfigCache(): void {
  loadedConfigCache.clear();
}

/**
 * Cached variant of {@link loadConfig} keyed by `projectRoot`.
 *
 * Both successful loads and parse failures are cached (failures as `null`)
 * so a broken config doesn't re-parse on every skill in the same scan. A
 * test that edits a broken config into a good one between calls must invoke
 * {@link resetLoadedConfigCache} (audit's `resetAuditCaches()` does this).
 */
export function loadConfigCached(projectRoot: string): ProjectConfig | undefined {
  const cached = loadedConfigCache.get(projectRoot);
  if (cached !== undefined) return cached ?? undefined;
  try {
    const config = loadConfig(projectRoot);
    loadedConfigCache.set(projectRoot, config ?? null);
    return config;
  } catch {
    // Cache failures as null so a broken config doesn't re-parse per skill.
    loadedConfigCache.set(projectRoot, null);
    return undefined;
  }
}
