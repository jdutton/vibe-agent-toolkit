/**
 * `vat claude plugin build` — generate Claude plugin artifacts from pre-built skills
 *
 * Reads vibe-agent-toolkit.config.yaml → claude.marketplaces.
 * Discovers available skills from dist/skills/ (built by `vat skills build`).
 * Wraps skills into Claude plugin directory structure with plugin.json metadata.
 */

import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ClaudeMarketplaceConfig, ClaudeMarketplacePluginEntry } from '@vibe-agent-toolkit/resources';
import { Command } from 'commander';

import { handleCommandError } from '../../../utils/command-error.js';
import { createLogger } from '../../../utils/logger.js';
import { writeYamlOutput } from '../../../utils/output.js';
import { loadClaudeProjectConfig } from '../claude-config.js';

export interface PluginBuildCommandOptions {
  marketplace?: string;
  debug?: boolean;
}

interface PluginBuildResult {
  pluginName: string;
  pluginDir: string;
  skillsCopied: string[];
}

interface MarketplaceBuildResult {
  name: string;
  status: 'built' | 'error';
  reason?: string;
  plugins: PluginBuildResult[];
}

export function createPluginBuildCommand(): Command {
  const command = new Command('build');

  command
    .description('Generate Claude plugin artifacts from pre-built skills')
    .option('--marketplace <name>', 'Build specific marketplace only')
    .option('--debug', 'Enable debug logging')
    .action(pluginBuildCommand)
    .addHelpText(
      'after',
      `
Description:
  Reads vibe-agent-toolkit.config.yaml to build Claude plugin artifacts
  from pre-built dist/skills/ output. Must run vat skills build first.

  For each marketplace, for each plugin:
  - Resolves skill selectors ("*" or name list) against dist/skills/ directories
  - Copies matched skills into plugin directory structure
  - Generates plugin.json with name, description, and author
  - Generates marketplace.json with plugin registry and relative source paths

Output structure:
  dist/.claude/plugins/marketplaces/<marketplace>/
    .claude-plugin/marketplace.json
    plugins/<plugin>/
      .claude-plugin/plugin.json
      skills/<skillName>/SKILL.md

Output:
  YAML summary -> stdout
  Build progress -> stderr

Exit Codes:
  0 - Build successful
  1 - Build error (missing skills, invalid config)
  2 - System error

Example:
  $ vat skills build && vat claude plugin build    # Build skills then wrap for Claude
`
    );

  return command;
}

/**
 * Discover available skill names by listing directories in dist/skills/.
 */
async function discoverBuiltSkills(configDir: string): Promise<string[]> {
  const skillsDir = join(configDir, 'dist', 'skills');

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from config
  if (!existsSync(skillsDir)) {
    return [];
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from config
  const entries = await readdir(skillsDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function pluginBuildCommand(options: PluginBuildCommandOptions): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const { configPath, configDir, claudeConfig } = await loadClaudeProjectConfig();

    if (!claudeConfig?.marketplaces || Object.keys(claudeConfig.marketplaces).length === 0) {
      writeYamlOutput({
        status: 'success',
        message: 'No claude.marketplaces configured — nothing to build',
        duration: `${Date.now() - startTime}ms`,
      });
      process.exit(0);
    }

    // Read version from package.json — used in plugin.json so Claude Code
    // caches by version instead of "unknown/"
    let packageVersion: string | undefined;
    try {
      const pkgPath = join(configDir, 'package.json');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- configDir from loadClaudeProjectConfig
      const pkgRaw = readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(pkgRaw) as { version?: string };
      packageVersion = pkg.version;
    } catch {
      // No package.json or unreadable — version will be omitted
    }

    // Discover available skills from dist/skills/
    const availableSkills = await discoverBuiltSkills(configDir);

    logger.info(`Building Claude plugin artifacts`);
    logger.info(`   Config: ${configPath}`);
    logger.info(`   Skills available: ${availableSkills.length} (${availableSkills.join(', ')})`);

    const results: MarketplaceBuildResult[] = [];

    const marketplaces = claudeConfig.marketplaces;
    for (const name of Object.keys(marketplaces)) {
      const mpConfig = marketplaces[name] as ClaudeMarketplaceConfig;

      // Skip if --marketplace filter specified and doesn't match
      if (options.marketplace && options.marketplace !== name) {
        continue;
      }

      logger.info(`\n   Building marketplace: ${name}`);
      const result = await buildMarketplace(name, mpConfig, availableSkills, configDir, packageVersion, logger);
      results.push(result);

      if (result.status === 'error') {
        logger.error(`   Failed: ${result.reason ?? 'unknown error'}`);
        const duration = Date.now() - startTime;
        writeYamlOutput({
          status: 'error',
          error: result.reason ?? 'Build failed',
          marketplace: name,
          duration: `${duration}ms`,
        });
        process.exit(1);
      }
    }

    const duration = Date.now() - startTime;
    const totalPlugins = results.flatMap((r) => r.plugins).length;
    const totalSkills = results.flatMap((r) => r.plugins).flatMap((p) => p.skillsCopied).length;

    writeYamlOutput({
      status: 'success',
      marketplacesBuilt: results.filter((r) => r.status === 'built').length,
      pluginsBuilt: totalPlugins,
      skillsPackaged: totalSkills,
      marketplaces: results.map((r) => ({
        name: r.name,
        status: r.status,
        ...(r.reason ? { reason: r.reason } : {}),
        plugins: r.plugins.map((p) => ({
          name: p.pluginName,
          dir: p.pluginDir,
          skills: p.skillsCopied,
        })),
      })),
      duration: `${duration}ms`,
    });

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'ClaudePluginBuild');
  }
}

async function buildMarketplace(
  name: string,
  config: ClaudeMarketplaceConfig,
  availableSkills: string[],
  configDir: string,
  packageVersion: string | undefined,
  logger: ReturnType<typeof createLogger>
): Promise<MarketplaceBuildResult> {
  const plugins: PluginBuildResult[] = [];

  // Clean stale marketplace directory before rebuilding — removes orphaned plugins
  const marketplaceOutputDir = join(configDir, 'dist', '.claude', 'plugins', 'marketplaces', name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from config
  if (existsSync(marketplaceOutputDir)) {
    await rm(marketplaceOutputDir, { recursive: true, force: true });
  }

  for (const pluginDef of config.plugins) {
    // Resolve which skills this plugin gets
    const resolvedSkills = resolvePluginSkills(pluginDef, availableSkills);
    logger.info(`   Plugin "${pluginDef.name}": ${resolvedSkills.length} skill(s) matched`);

    if (resolvedSkills.length === 0) {
      logger.info(`      (no skills matched selectors)`);
    }

    const pluginResult = await buildPlugin(
      name,
      pluginDef,
      resolvedSkills,
      configDir,
      config.owner,
      packageVersion,
      logger
    );
    plugins.push(pluginResult);
  }

  // Generate .claude-plugin/marketplace.json
  const marketplaceDir = join(configDir, 'dist', '.claude', 'plugins', 'marketplaces', name);
  const claudePluginDir = join(marketplaceDir, '.claude-plugin');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved paths
  await mkdir(claudePluginDir, { recursive: true });

  const marketplaceJson: Record<string, unknown> = {
    $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
    name,
    owner: {
      name: config.owner.name,
      ...(config.owner.email ? { email: config.owner.email } : {}),
    },
    plugins: plugins.map((p) => {
      const pluginDesc = config.plugins.find((pd) => pd.name === p.pluginName)?.description;
      return {
        name: p.pluginName,
        ...(pluginDesc ? { description: pluginDesc } : {}),
        source: `./plugins/${p.pluginName}`,
        author: {
          name: config.owner.name,
          ...(config.owner.email ? { email: config.owner.email } : {}),
        },
      };
    }),
  };

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved paths
  await writeFile(join(claudePluginDir, 'marketplace.json'), JSON.stringify(marketplaceJson, null, 2));
  logger.info(`   .claude-plugin/marketplace.json`);

  // Copy distribution files (LICENSE, README.md, CHANGELOG.md) from project root
  // to marketplace output when they exist — required/recommended by marketplace validate.
  const distFiles = ['LICENSE', 'README.md', 'CHANGELOG.md'];
  for (const file of distFiles) {
    const srcPath = join(configDir, file);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- file is from static list
    if (existsSync(srcPath)) {
      await cp(srcPath, join(marketplaceDir, file));
      logger.info(`   ${file} (copied from project root)`);
    }
  }

  return { name, status: 'built', plugins };
}

/**
 * Resolve which skills a plugin gets based on its `skills` selector.
 * "*" means all available skills; string[] means match each selector against available skill names.
 */
function resolvePluginSkills(
  pluginDef: ClaudeMarketplacePluginEntry,
  availableSkills: string[]
): string[] {
  if (pluginDef.skills === '*') {
    return availableSkills;
  }

  const matched = new Set<string>();
  for (const selector of pluginDef.skills) {
    // Also try the fs-safe form of the selector (colon → __) since
    // availableSkills are directory names which use the fs-safe form.
    const fsSelector = skillNameToFsPath(selector);
    for (const skillName of availableSkills) {
      if (matchesSelector(skillName, selector) || matchesSelector(skillName, fsSelector)) {
        matched.add(skillName);
      }
    }
  }

  return [...matched];
}

/**
 * Convert a skill name to a filesystem-safe path segment.
 *
 * Skill names use colon-namespacing (e.g. "vibe-agent-toolkit:resources") which is
 * valid in YAML/JSON but invalid as a directory name on Windows. Replace colons with
 * double-underscore — unambiguous, reversible, and safe on all platforms.
 */
function skillNameToFsPath(name: string): string {
  return name.replaceAll(':', '__');
}

async function buildPlugin(
  marketplaceName: string,
  pluginDef: ClaudeMarketplacePluginEntry,
  skills: string[],
  configDir: string,
  owner: ClaudeMarketplaceConfig['owner'],
  packageVersion: string | undefined,
  logger: ReturnType<typeof createLogger>
): Promise<PluginBuildResult> {
  const pluginDir = join(
    configDir, 'dist', '.claude', 'plugins', 'marketplaces',
    marketplaceName, 'plugins', pluginDef.name
  );
  const skillsCopied: string[] = [];

  logger.info(`      Building plugin: ${pluginDef.name}`);

  for (const skillName of skills) {
    const skillDistPath = join(configDir, 'dist', 'skills', skillName);

    // Verify skill is built
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from config
    if (!existsSync(skillDistPath)) {
      throw new Error(
        `Skill "${skillName}" not built at ${skillDistPath}. ` +
          `Run: vat skills build (or vat build to build everything)`
      );
    }

    // Copy skill into plugin directory structure.
    // Use skillNameToFsPath to strip colons — colon-namespaced skill names (e.g.
    // "pkg:sub-skill") are valid VAT identifiers but invalid directory names on Windows.
    const fsPath = skillNameToFsPath(skillName);
    const destPath = join(pluginDir, 'skills', fsPath);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved paths
    await mkdir(destPath, { recursive: true });
    await cp(skillDistPath, destPath, { recursive: true });
    skillsCopied.push(fsPath);
    logger.info(`         ${skillName} -> skills/${fsPath}`);
  }

  // Generate plugin.json — STRICT: only name, description, author
  const pluginJsonDir = join(pluginDir, '.claude-plugin');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved paths
  await mkdir(pluginJsonDir, { recursive: true });

  const pluginJson: Record<string, unknown> = {
    name: pluginDef.name,
    description: pluginDef.description ?? `${pluginDef.name} plugin`,
    ...(packageVersion ? { version: packageVersion } : {}),
    author: {
      name: owner.name,
      ...(owner.email ? { email: owner.email } : {}),
    },
  };

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved paths
  await writeFile(join(pluginJsonDir, 'plugin.json'), JSON.stringify(pluginJson, null, 2));
  logger.info(`         .claude-plugin/plugin.json`);

  return { pluginName: pluginDef.name, pluginDir, skillsCopied };
}

/**
 * Check if a skill name matches a selector.
 * Supports exact match and simple glob patterns (prefix*, suffix*, *contains*).
 */
function matchesSelector(skillName: string, selector: string): boolean {
  if (selector === '*') {
    return true;
  }

  // Convert simple glob to regex: replace * with .*
  // eslint-disable-next-line security/detect-non-literal-regexp -- selector is from project config, bounded by name format
  const regex = new RegExp(`^${selector.replaceAll('*', '.*')}$`);
  return regex.test(skillName);
}
