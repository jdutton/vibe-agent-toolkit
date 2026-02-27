/**
 * `vat claude verify` — validate Claude plugin marketplace artifacts
 *
 * Validates existing marketplace.json, plugin.json, and managed-settings.json files
 * against their schemas. Does not build anything — validates what exists.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
  ClaudePluginSchema,
  MarketplaceSchema,
} from '@vibe-agent-toolkit/agent-skills';
import { ManagedSettingsSchema } from '@vibe-agent-toolkit/claude-marketplace';
import { type ClaudeMarketplaceConfig } from '@vibe-agent-toolkit/resources';
import { Command } from 'commander';

import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';
import { writeYamlOutput } from '../../utils/output.js';

import { loadClaudeProjectConfig } from './claude-config.js';

export interface ClaudeVerifyCommandOptions {
  marketplace?: string;
  debug?: boolean;
}

type VerifyStatus = 'valid' | 'error' | 'skipped';

interface VerifyError {
  file: string;
  error: string;
}

interface MarketplaceResult {
  name: string;
  file?: string;
  status: VerifyStatus;
  errors: VerifyError[];
}

export function createVerifyCommand(): Command {
  const command = new Command('verify');

  command
    .description('Validate Claude marketplace and plugin artifacts against schemas')
    .option('--marketplace <name>', 'Verify specific marketplace only')
    .option('--debug', 'Enable debug logging')
    .action(verifyCommand)
    .addHelpText(
      'after',
      `
Description:
  Validates existing Claude plugin artifacts against their schemas.
  Does not build anything — validates what already exists.

  For each marketplace in claude.marketplaces:
  - file: variant: validates that marketplace.json against MarketplaceSchema
  - inline variant: validates generated marketplace.json and each plugin.json
  If claude.managedSettings is configured: validates against ManagedSettingsSchema

Output:
  YAML report → stdout
  Validation errors → stderr

Exit Codes:
  0 - All artifacts valid
  1 - Validation errors found
  2 - System error (config not found, file not readable, etc.)

Example:
  $ vat claude verify                        # Verify all marketplaces
  $ vat claude verify --marketplace acme     # Verify specific marketplace
`
    );

  return command;
}

async function verifyCommand(options: ClaudeVerifyCommandOptions): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const { configDir, claudeConfig } = await loadClaudeProjectConfig();

    if (!claudeConfig) {
      writeYamlOutput({
        status: 'success',
        message: 'No claude: section in config — nothing to verify',
        duration: `${Date.now() - startTime}ms`,
      });
      process.exit(0);
    }

    const errors: VerifyError[] = [];
    const marketplaceResults: MarketplaceResult[] = [];

    // Verify each marketplace
    const marketplaces = claudeConfig.marketplaces ?? {};
    for (const name of Object.keys(marketplaces)) {
      const mpConfig = marketplaces[name] as ClaudeMarketplaceConfig;

      // Skip if --marketplace filter specified and doesn't match
      if (options.marketplace && options.marketplace !== name) {
        continue;
      }

      logger.info(`🔍 Verifying marketplace: ${name}`);
      const result = await verifyMarketplace(name, mpConfig, configDir, logger);
      marketplaceResults.push(result);
      errors.push(...result.errors);
    }

    // Verify managed-settings.json if configured
    let managedSettingsResult: { status: VerifyStatus; errors: VerifyError[] } = {
      status: 'skipped',
      errors: [],
    };
    if (claudeConfig.managedSettings) {
      logger.info(`🔍 Verifying managed-settings: ${claudeConfig.managedSettings}`);
      managedSettingsResult = await verifyManagedSettings(
        claudeConfig.managedSettings,
        configDir,
        logger
      );
      errors.push(...managedSettingsResult.errors);
    }

    const hasErrors = errors.length > 0;

    // Emit errors to stderr
    for (const err of errors) {
      process.stderr.write(`${err.file}: ${err.error}\n`);
    }

    const duration = Date.now() - startTime;
    writeYamlOutput({
      status: hasErrors ? 'error' : 'success',
      marketplaces: marketplaceResults.map((r) => ({
        name: r.name,
        status: r.status,
        ...(r.file ? { file: r.file } : {}),
        ...(r.errors.length > 0 ? { errors: r.errors.map((e) => e.error) } : {}),
      })),
      ...(claudeConfig.managedSettings
        ? {
            managedSettings: {
              status: managedSettingsResult.status,
              ...(managedSettingsResult.errors.length > 0
                ? { errors: managedSettingsResult.errors.map((e) => e.error) }
                : {}),
            },
          }
        : {}),
      errorsFound: errors.length,
      duration: `${duration}ms`,
    });

    process.exit(hasErrors ? 1 : 0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'ClaudeVerify');
  }
}

async function verifyInlineMarketplace(
  config: ClaudeMarketplaceConfig,
  configDir: string,
  logger: ReturnType<typeof createLogger>
): Promise<{ file: string; errors: VerifyError[] }> {
  const marketplaceJsonPath = config.output?.marketplaceJson
    ? resolveRelativePath(config.output.marketplaceJson, configDir)
    : join(configDir, 'dist', '.claude-plugin', 'marketplace.json');

  const errors: VerifyError[] = [];

  try {
    const fileErrors = await validateJsonFile(marketplaceJsonPath, MarketplaceSchema, logger);
    errors.push(...fileErrors);
  } catch {
    // File does not exist — report as verification error (run vat build to generate it)
    errors.push({
      file: marketplaceJsonPath,
      error: `marketplace.json not found — run vat build (or vat claude build) to generate it`,
    });
  }

  const pluginsDir = config.output?.pluginsDir
    ? resolveRelativePath(config.output.pluginsDir, configDir)
    : join(configDir, 'dist', 'plugins');

  for (const plugin of config.plugins ?? []) {
    const pluginJsonPath = join(pluginsDir, plugin.name, '.claude-plugin', 'plugin.json');
    try {
      const pluginErrors = await validateJsonFile(pluginJsonPath, ClaudePluginSchema, logger);
      errors.push(...pluginErrors);
    } catch {
      // File does not exist — report as verification error (run vat build to generate it)
      errors.push({
        file: pluginJsonPath,
        error: `plugin.json not found — run vat build (or vat claude build) to generate it`,
      });
    }
  }

  return { file: marketplaceJsonPath, errors };
}

async function verifyMarketplace(
  name: string,
  config: ClaudeMarketplaceConfig,
  configDir: string,
  logger: ReturnType<typeof createLogger>
): Promise<MarketplaceResult> {
  const result: MarketplaceResult = { name, errors: [], status: 'valid' };

  if (config.file) {
    // Source-layout: validate the referenced marketplace.json
    const filePath = resolveRelativePath(config.file, configDir);
    result.file = filePath;
    const fileErrors = await validateJsonFile(filePath, MarketplaceSchema, logger);
    result.errors.push(...fileErrors);
  } else {
    // Inline: validate generated artifacts if they exist
    const { file, errors } = await verifyInlineMarketplace(config, configDir, logger);
    result.file = file;
    result.errors.push(...errors);
  }

  result.status = result.errors.length > 0 ? 'error' : 'valid';
  return result;
}

async function verifyManagedSettings(
  settingsPath: string,
  configDir: string,
  logger: ReturnType<typeof createLogger>
): Promise<{ status: VerifyStatus; errors: VerifyError[] }> {
  const filePath = resolveRelativePath(settingsPath, configDir);
  const fileErrors = await validateJsonFile(filePath, ManagedSettingsSchema, logger);
  return {
    status: fileErrors.length > 0 ? 'error' : 'valid',
    errors: fileErrors,
  };
}

async function validateJsonFile(
  filePath: string,
  schema: { safeParse: (data: unknown) => { success: boolean; error?: { errors: Array<{ path: (string | number)[]; message: string }> } } },
  logger: ReturnType<typeof createLogger>
): Promise<VerifyError[]> {
  let content: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath resolved from config
    content = await readFile(filePath, 'utf-8');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read file ${filePath}: ${msg}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return [{ file: filePath, error: `Invalid JSON: ${msg}` }];
  }

  const result = schema.safeParse(parsed);
  if (result.success) {
    logger.debug(`   ✅ ${filePath}`);
    return [];
  }

  const errors = result.error?.errors ?? [];
  return errors.map((e) => ({
    file: filePath,
    error: `${e.path.join('.') || 'root'}: ${e.message}`,
  }));
}

function resolveRelativePath(filePath: string, baseDir: string): string {
  if (isAbsolute(filePath)) {
    return filePath;
  }
  return resolve(baseDir, filePath);
}
