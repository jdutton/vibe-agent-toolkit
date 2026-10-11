/**
 * Configuration file parser for vibe-agent-toolkit.config.yaml
 *
 * Discovers and parses project configuration files with directory tree walk-up.
 */

import { findConfigFile, type FsFaultContext, type FsSide, VatError, withFsFault, withFsFaultSync } from '@vibe-agent-toolkit/utils';
import { readTextContent, readTextContentSync } from '@vibe-agent-toolkit/utils/fs';
import { parse as parseYaml } from 'yaml';

import { CONFIG_LOAD_CODE, parseConfigAllowingUnknownKeys } from './config-issues.js';
import { ProjectConfigSchema, type ProjectConfig } from './schemas/project-config.js';

/**
 * How a failed config read is classified: an errno is about the adopter's own
 * file — a `source` fault named by config for a verb that reads it, a
 * `destination` fault for the verb that edits it; anything else is a defect and
 * propagates as thrown.
 */
function configRead(configPath: string, side: FsSide): FsFaultContext {
  return { side, origin: 'config', action: `read config file ${configPath}`, path: configPath };
}

/**
 * Read a `vibe-agent-toolkit.config.yaml` through the one decoder — an adopter's
 * config may be UTF-16LE (PowerShell 5.1's default) or BOM-prefixed — coding a
 * read the OS refused. The ONE config read every reader shares, so one broken
 * file is classified the same way by every verb that reads it — `INPUT_UNREADABLE`
 * as a source; the one verb that edits it (`vat skill test configure`, unless
 * `--print`) reads it as its destination, `RUN_INCOMPLETE`.
 *
 * @param configPath - Path to the config file
 * @param side - `destination` when the verb reads the config to edit it (`vat skill test
 *   configure`): a refusal is then the run not finishing, not the input's fault
 * @returns The decoded text
 * @throws `FsFaultError` (origin `config`, on `side`) when the OS refuses the read
 */
export function readConfigText(configPath: string, side: FsSide = 'source'): Promise<string> {
  return withFsFault(configRead(configPath, side), async () => (await readTextContent(configPath)).text);
}

/**
 * {@link readConfigText}, synchronously.
 *
 * @param configPath - Path to the config file
 * @returns The decoded text
 * @throws `FsFaultError` (side `source`, origin `config`) when the OS refuses the read
 */
export function readConfigTextSync(configPath: string): string {
  return withFsFaultSync(configRead(configPath, 'source'), () => readTextContentSync(configPath).text);
}

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
 * @throws `FsFaultError` (side `source`, origin `config`) if the OS refuses the read; `VatError` `CONFIG_LOAD` if YAML is
 *   invalid, or validation fails for any reason other than an unknown key
 *
 * @example
 * ```typescript
 * const config = await parseConfigFile('/project/vibe-agent-toolkit.config.yaml', console.warn);
 * console.log(`Collections: ${Object.keys(config.resources?.collections ?? {}).join(', ')}`);
 * ```
 */
export async function parseConfigFile(
  configPath: string,
  onUnknownKeys: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): Promise<ProjectConfig> {
  const content = await readConfigText(configPath);

  // Parse YAML
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (error) {
    throw new VatError(CONFIG_LOAD_CODE, `Invalid YAML in config file: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
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
