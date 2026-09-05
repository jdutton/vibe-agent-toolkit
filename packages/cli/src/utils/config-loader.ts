/**
 * Configuration file loading and validation
 *
 * Environment Variables:
 * - VAT_TEST_CONFIG: Override config file path for testing (absolute path)
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { formatConfigValidationError, ProjectConfigSchema, type ProjectConfig } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import * as yaml from 'yaml';

const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';

/**
 * A `vibe-agent-toolkit.config.yaml` exists but failed to parse or validate.
 *
 * Distinct from "no config found" (which surfaces as `undefined`): a *broken*
 * config is a hard error the user must fix, not something to silently treat as
 * absent. Commands that resolve a skill through a config (`vat skill review`,
 * `vat skill test`) should surface this; a bulk linter (`vat audit`) may catch
 * it and fall back to config-free validation.
 */
export class ConfigLoadError extends Error {
  readonly projectRoot: string;
  constructor(projectRoot: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'ConfigLoadError';
    this.projectRoot = projectRoot;
    if (cause instanceof Error) this.cause = cause;
  }
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
    const parsed = yaml.parse(content);

    // Validate with canonical schema from resources package.
    //
    // 🔑 The message comes from the shared formatter, NOT from `error.message`.
    // In Zod 3 that property is a **JSON dump of the issue array**, and it was
    // what an adopter got: five verbs exiting 2 in under a second on a blob that
    // never named this file, never said which key was refused in words, and
    // offered no remedy. Every strict block in the schema is a refusal an
    // adopter has to be able to act on from the terminal alone.
    const result = ProjectConfigSchema.safeParse(parsed);

    if (!result.success) {
      throw new Error(
        formatConfigValidationError(result.error, { configPath, schema: ProjectConfigSchema }),
      );
    }

    return result.data;
  } catch (error) {
    if (error instanceof Error) {
      // `cause` is load-bearing, not decoration: callers decide whether to
      // degrade or abort by asking `isFilesystemAccessError`, which reads the
      // errno off the error. Re-wrapping without it produced a plain Error with
      // no `code`, so an unreadable config read as "a bug in VAT" and aborted the
      // whole run — the exact failure `vat audit`'s guard exists to prevent,
      // reintroduced by a message-formatting layer.
      throw new Error(`Failed to load config: ${error.message}`, { cause: error });
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
 */
const loadedConfigCache: Map<string, ProjectConfig | null> = new Map();

/**
 * Companion cache for {@link loadConfigCached}: a broken config's
 * {@link ConfigLoadError}, keyed by `projectRoot`, so a broken config re-throws
 * the same error on every skill in a scan without re-parsing.
 */
const loadErrorCache: Map<string, ConfigLoadError> = new Map();

/**
 * Reset the cache used by {@link loadConfigCached}.
 *
 * Call at the start of each independent CLI invocation (e.g. `vat audit`) so
 * in-process callers don't observe stale config data across runs.
 */
export function resetLoadedConfigCache(): void {
  loadedConfigCache.clear();
  loadErrorCache.clear();
}

/**
 * Cached variant of {@link loadConfig} keyed by `projectRoot`.
 *
 * Returns the parsed config, or `undefined` when no config file exists. A config
 * file that exists but fails to parse/validate throws {@link ConfigLoadError} —
 * a broken config is a hard error, NOT silently treated as "no config" (that
 * conflation silently downgraded `vat skill review` and would let `vat skill
 * test` stage the wrong artifact). Both outcomes are cached (the error too) so a
 * broken config re-throws without re-parsing on every skill in a scan. A test
 * that edits a broken config into a good one between calls must invoke
 * {@link resetLoadedConfigCache} (audit's `resetAuditCaches()` does this).
 *
 * Callers that intentionally tolerate a broken config (e.g. `vat audit`, a bulk
 * linter that should still validate the skill itself) catch `ConfigLoadError`.
 */
export function loadConfigCached(projectRoot: string): ProjectConfig | undefined {
  const cachedError = loadErrorCache.get(projectRoot);
  if (cachedError !== undefined) throw cachedError;
  const cached = loadedConfigCache.get(projectRoot);
  if (cached !== undefined) return cached ?? undefined;
  try {
    const config = loadConfig(projectRoot);
    loadedConfigCache.set(projectRoot, config ?? null);
    return config;
  } catch (err) {
    // loadConfig returns undefined when the file is ABSENT and only throws when
    // it EXISTS but is broken — so reaching here means a genuinely broken config.
    const configErr = err instanceof ConfigLoadError ? err : new ConfigLoadError(projectRoot, err);
    loadErrorCache.set(projectRoot, configErr);
    throw configErr;
  }
}
