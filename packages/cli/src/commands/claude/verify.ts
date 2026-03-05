/**
 * `vat claude verify` — validate Claude plugin artifacts at conventional paths
 *
 * For each marketplace in claude.marketplaces, verifies built artifacts at:
 *   dist/.claude/plugins/marketplaces/<marketplaceName>/plugins/<pluginName>/
 *
 * For each plugin:
 *   - .claude-plugin/plugin.json must exist and validate against PluginJsonSchema
 *   - At least one skills/{name}/SKILL.md must exist
 *
 * If claude.managedSettings is configured: validates against ManagedSettingsSchema
 */

import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { MarketplaceManifestSchema, PluginJsonSchema } from '@vibe-agent-toolkit/agent-skills';
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
  Validates built Claude plugin artifacts at conventional paths.
  Does not build anything — validates what already exists.

  For each marketplace in claude.marketplaces, checks:
    dist/.claude/plugins/marketplaces/<name>/plugins/<plugin>/
      .claude-plugin/plugin.json       — validates against PluginJsonSchema
      .claude-plugin/marketplace.json  — validates against MarketplaceManifestSchema
      skills/*/SKILL.md                — at least one must exist

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

async function verifyMarketplace(
  name: string,
  config: ClaudeMarketplaceConfig,
  configDir: string,
  logger: ReturnType<typeof createLogger>
): Promise<MarketplaceResult> {
  const result: MarketplaceResult = { name, errors: [], status: 'valid' };

  for (const plugin of config.plugins) {
    const pluginDir = join(
      configDir, 'dist', '.claude', 'plugins', 'marketplaces', name, 'plugins', plugin.name
    );

    // Verify .claude-plugin/plugin.json exists and validates
    const pluginJsonPath = join(pluginDir, '.claude-plugin', 'plugin.json');
    try {
      const pluginErrors = await validateJsonFile(pluginJsonPath, PluginJsonSchema, logger);
      result.errors.push(...pluginErrors);
    } catch {
      result.errors.push({
        file: pluginJsonPath,
        error: 'plugin.json not found — run vat build (or vat claude build) to generate it',
      });
    }

    // Verify at least one skills/*/SKILL.md exists
    const skillsDir = join(pluginDir, 'skills');
    const hasSkills = await verifySkillsExist(skillsDir);
    if (!hasSkills) {
      result.errors.push({
        file: skillsDir,
        error: 'No skills/*/SKILL.md found — run vat build (or vat claude build) to generate skills',
      });
    }
  }

  // Verify .claude-plugin/marketplace.json
  const marketplaceDir = join(
    configDir, 'dist', '.claude', 'plugins', 'marketplaces', name
  );
  const marketplaceJsonPath = join(marketplaceDir, '.claude-plugin', 'marketplace.json');
  try {
    const mpErrors = await validateJsonFile(marketplaceJsonPath, MarketplaceManifestSchema, logger);
    result.errors.push(...mpErrors);
  } catch {
    result.errors.push({
      file: marketplaceJsonPath,
      error: 'marketplace.json not found — run vat build (or vat claude build) to generate it',
    });
  }

  result.status = result.errors.length > 0 ? 'error' : 'valid';
  return result;
}

/**
 * Check that at least one skills/{name}/SKILL.md file exists in the given directory.
 */
async function verifySkillsExist(skillsDir: string): Promise<boolean> {
  let entries: string[];
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- skillsDir resolved from config
    entries = await readdir(skillsDir);
  } catch {
    return false;
  }

  for (const entry of entries) {
    try {
      const skillMdPath = join(skillsDir, entry, 'SKILL.md');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from config
      await readFile(skillMdPath, 'utf-8');
      return true;
    } catch {
      // This entry doesn't have a SKILL.md, check the next one
    }
  }

  return false;
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
