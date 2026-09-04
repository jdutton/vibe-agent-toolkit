/**
 * Configuration file parser for vibe-agent-toolkit.config.yaml
 *
 * Discovers and parses project configuration files with directory tree walk-up.
 */

import { findConfigFile } from '@vibe-agent-toolkit/utils';
import { readTextContent } from '@vibe-agent-toolkit/utils/fs';
import { parse as parseYaml } from 'yaml';

import { formatConfigValidationError } from './config-issues.js';
import { ProjectConfigSchema, type ProjectConfig } from './schemas/project-config.js';

/**
 * Parse a project configuration file.
 *
 * Reads the YAML file, parses it, and validates against the schema.
 *
 * @param configPath - Absolute path to config file
 * @returns Parsed and validated configuration
 * @throws Error if file cannot be read, YAML is invalid, or validation fails
 *
 * @example
 * ```typescript
 * const config = await parseConfigFile('/project/vibe-agent-toolkit.config.yaml');
 * console.log(`Version: ${config.version}`);
 * console.log(`Collections: ${Object.keys(config.resources?.collections ?? {}).join(', ')}`);
 * ```
 */
export async function parseConfigFile(configPath: string): Promise<ProjectConfig> {
  // Read file content through the one decoder. An adopter's config file is
  // authored by hand on whatever platform they use — PowerShell 5.1 writes
  // UTF-16LE by default — and `readFile(path, 'utf-8')` would hand the YAML
  // parser mojibake, or a BOM that makes the first key unparseable.
  const { text: content } = await readTextContent(configPath);

  // Parse YAML
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (error) {
    throw new Error(`Invalid YAML in config file: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Validate against schema. The message is built by the ONE formatter both
  // config readers share — this one and the CLI's `utils/config-loader.ts`.
  // They used to format the same `ZodError` two different ways and neither named
  // the file, which is how a strict-schema refusal reached an adopter as a raw
  // JSON dump with no remedy in it.
  const result = ProjectConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      formatConfigValidationError(result.error, { configPath, schema: ProjectConfigSchema }),
    );
  }

  return result.data;
}

/**
 * Load project configuration by discovering and parsing config file.
 *
 * Walks up the directory tree from startDir to find the config file,
 * then parses and validates it.
 *
 * @param startDir - Directory to start searching from (default: process.cwd())
 * @returns Parsed configuration, or undefined if no config file found
 * @throws Error if config file is found but cannot be parsed or is invalid
 *
 * @example
 * ```typescript
 * const config = await loadConfig();
 * if (config) {
 *   console.log('Using project config');
 * } else {
 *   console.log('No config found, using defaults');
 * }
 * ```
 */
export async function loadConfig(startDir: string = process.cwd()): Promise<ProjectConfig | undefined> {
  // findConfigFile from utils is synchronous; awaiting a non-promise is a no-op.
  const configPath = findConfigFile(startDir);
  if (!configPath) {
    return undefined;
  }

  return await parseConfigFile(configPath);
}
