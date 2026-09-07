/**
 * Configuration file parser for vibe-agent-toolkit.config.yaml
 *
 * Discovers and parses project configuration files with directory tree walk-up.
 */

import { findConfigFile } from '@vibe-agent-toolkit/utils';
import { readTextContent } from '@vibe-agent-toolkit/utils/fs';
import { parse as parseYaml } from 'yaml';

import { parseConfigAllowingUnknownKeys } from './config-issues.js';
import { ProjectConfigSchema, type ProjectConfig } from './schemas/project-config.js';

/**
 * Parse a project configuration file.
 *
 * Reads the YAML file, parses it, and validates against the schema.
 *
 * An UNKNOWN key is reported through `onUnknownKeys` and then ignored, rather
 * than refused — see {@link parseConfigAllowingUnknownKeys} for why. Every other
 * validation failure still throws. The callback DEFAULTS to writing the warning
 * to stderr rather than to discarding it: a caller that says nothing still gets
 * the message out, because a config quietly losing keys is the failure the
 * strict schema was introduced to end.
 *
 * @param configPath - Absolute path to config file
 * @param onUnknownKeys - Receives a warning when unknown keys were dropped
 * @returns Parsed and validated configuration
 * @throws Error if file cannot be read, YAML is invalid, or validation fails for
 *   any reason other than an unknown key
 *
 * @example
 * ```typescript
 * const config = await parseConfigFile('/project/vibe-agent-toolkit.config.yaml', console.warn);
 * console.log(`Version: ${config.version}`);
 * console.log(`Collections: ${Object.keys(config.resources?.collections ?? {}).join(', ')}`);
 * ```
 */
export async function parseConfigFile(
  configPath: string,
  onUnknownKeys: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): Promise<ProjectConfig> {
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

  // Validate against schema. The message is built by the ONE formatter all THREE
  // config readers share — this one, the CLI's `utils/config-loader.ts`, and
  // `cli/commands/skill/test/configure.ts`. They used to format the same
  // `ZodError` three different ways and none named the file, which is how a
  // strict-schema refusal reached an adopter as a raw JSON dump with no remedy in
  // it. ⚠️ This comment said "both … readers" while a third one was still
  // printing the blob; count the `ProjectConfigSchema` call sites rather than
  // trusting the number here.
  return parseConfigAllowingUnknownKeys(
    ProjectConfigSchema,
    parsed,
    onUnknownKeys,
    { configPath },
  );
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
export async function loadConfig(
  startDir: string = process.cwd(),
  onUnknownKeys: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): Promise<ProjectConfig | undefined> {
  // findConfigFile from utils is synchronous; awaiting a non-promise is a no-op.
  const configPath = findConfigFile(startDir);
  if (!configPath) {
    return undefined;
  }

  // Defaulted, unlike `parseConfigFile`'s required callback: this is the
  // convenience entry point, and its default still SAYS something rather than
  // swallowing the warning. A caller that wants the message elsewhere passes it.
  return await parseConfigFile(configPath, onUnknownKeys);
}
