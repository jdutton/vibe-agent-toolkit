/**
 * `vat claude build` — generate Claude plugin marketplace artifacts
 *
 * Reads vibe-agent-toolkit.config.yaml → claude.marketplaces and package.json → vat.skills.
 * Wraps pre-built dist/skills/ output into Claude plugin directory structure.
 * Generates plugin.json and marketplace.json metadata files.
 */

import { existsSync } from 'node:fs';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { VatSkillMetadata } from '@vibe-agent-toolkit/agent-schema';
import { type ClaudeMarketplaceConfig } from '@vibe-agent-toolkit/resources';
import { Command } from 'commander';

import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';
import { writeYamlOutput } from '../../utils/output.js';
import { readPackageJson } from '../skills/shared.js';

import { loadClaudeProjectConfig } from './claude-config.js';

export interface ClaudeBuildCommandOptions {
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
  status: 'built' | 'skipped' | 'error';
  reason?: string;
  plugins: PluginBuildResult[];
  marketplaceJsonPath?: string;
}

export function createBuildCommand(): Command {
  const command = new Command('build');

  command
    .description('Generate Claude plugin marketplace artifacts from pre-built skills')
    .option('--marketplace <name>', 'Build specific marketplace only')
    .option('--debug', 'Enable debug logging')
    .action(buildCommand)
    .addHelpText(
      'after',
      `
Description:
  Reads vibe-agent-toolkit.config.yaml and package.json to build Claude plugin
  artifacts from pre-built dist/skills/ output. Must run vat skills build first.

  For each inline marketplace (skips file: entries):
  - Matches skill selectors against vat.skills names (exact or glob)
  - Copies dist/skills/<name>/ into plugin directory structure
  - Generates plugin.json and marketplace.json

  Source-layout (file:) marketplaces are skipped (they are verified, not built).

Output paths (defaults, overridable via config):
  dist/plugins/<plugin-name>/           ← plugin directory
  dist/.claude-plugin/marketplace.json  ← marketplace catalog

Output:
  YAML summary → stdout
  Build progress → stderr

Exit Codes:
  0 - Build successful
  1 - Build error (missing skills, invalid config)
  2 - System error

Example:
  $ vat skills build && vat claude build    # Build skills then wrap for Claude
  $ vat claude build --marketplace acme     # Build specific marketplace
`
    );

  return command;
}

async function buildCommand(options: ClaudeBuildCommandOptions): Promise<void> {
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

    // Read package.json for skill definitions
    const packageJson = await readPackageJson(configDir);
    const vatSkills: VatSkillMetadata[] = packageJson.vat?.skills ?? [];

    logger.info(`📦 Building Claude plugin artifacts`);
    logger.info(`   Config: ${configPath}`);
    logger.info(`   Skills available: ${vatSkills.length}`);

    const results: MarketplaceBuildResult[] = [];

    const marketplaces = claudeConfig.marketplaces;
    for (const name of Object.keys(marketplaces)) {
      const mpConfig = marketplaces[name] as ClaudeMarketplaceConfig;

      // Skip if --marketplace filter specified and doesn't match
      if (options.marketplace && options.marketplace !== name) {
        continue;
      }

      logger.info(`\n🏪 Building marketplace: ${name}`);
      const result = await buildMarketplace(name, mpConfig, vatSkills, configDir, logger);
      results.push(result);

      if (result.status === 'error') {
        logger.error(`   ❌ Failed: ${result.reason ?? 'unknown error'}`);
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
        ...(r.marketplaceJsonPath ? { marketplaceJson: r.marketplaceJsonPath } : {}),
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
    handleCommandError(error, logger, startTime, 'ClaudeBuild');
  }
}

async function buildMarketplace(
  name: string,
  config: ClaudeMarketplaceConfig,
  vatSkills: VatSkillMetadata[],
  configDir: string,
  logger: ReturnType<typeof createLogger>
): Promise<MarketplaceBuildResult> {
  // Source-layout (file:) marketplaces are skipped — verify only, not built
  if (config.file) {
    logger.info(`   Skipping (source-layout file: ${config.file})`);
    return { name, status: 'skipped', reason: 'source-layout (file: only — use vat claude verify)', plugins: [] };
  }

  // Resolve skill selectors against vat.skills
  const selectedSkills = resolveSkillSelectors(config.skills ?? [], vatSkills);
  logger.info(`   Matched ${selectedSkills.length} skill(s): ${selectedSkills.map((s) => s.name).join(', ')}`);

  // Determine output paths
  const pluginsDir = config.output?.pluginsDir
    ? resolveRelativePath(config.output.pluginsDir, configDir)
    : join(configDir, 'dist', 'plugins');

  const marketplaceJsonPath = config.output?.marketplaceJson
    ? resolveRelativePath(config.output.marketplaceJson, configDir)
    : join(configDir, 'dist', '.claude-plugin', 'marketplace.json');

  const plugins: PluginBuildResult[] = [];
  const pluginEntries: unknown[] = [];

  const pluginDefs = config.plugins ?? [{ name, skills: '*' as const }];

  for (const pluginDef of pluginDefs) {
    // Determine which skills go into this plugin
    const pluginSkills =
      pluginDef.skills === '*' || pluginDef.skills === undefined
        ? selectedSkills
        : selectedSkills.filter((s) =>
            Array.isArray(pluginDef.skills) ? pluginDef.skills.includes(s.name) : true
          );

    const pluginResult = await buildPlugin(
      pluginDef.name,
      pluginSkills,
      configDir,
      pluginsDir,
      logger
    );
    plugins.push(pluginResult);

    // Build plugin entry for marketplace.json.
    // `source` is required by the Claude marketplace format — use a relative path from
    // the marketplace.json location to the plugin directory so the artifact is portable
    // regardless of where the npm package is installed.
    const pluginDir = join(pluginsDir, pluginDef.name);
    const relativeSource = relative(dirname(marketplaceJsonPath), pluginDir);
    pluginEntries.push({
      name: pluginDef.name,
      source: relativeSource,
      ...(pluginDef.version ? { version: pluginDef.version } : {}),
      skills: pluginResult.skillsCopied.map((skillName) => `skills/${skillName}`),
    });
  }

  // Generate marketplace.json
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from config
  await mkdir(dirname(marketplaceJsonPath), { recursive: true });
  const marketplace = {
    name,
    ...(config.owner ? { owner: config.owner } : {}),
    ...(config.metadata ? { metadata: config.metadata } : {}),
    plugins: pluginEntries,
  };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from config
  await writeFile(marketplaceJsonPath, JSON.stringify(marketplace, null, 2));
  logger.info(`   ✅ marketplace.json → ${marketplaceJsonPath}`);

  return {
    name,
    status: 'built',
    plugins,
    marketplaceJsonPath,
  };
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
  pluginName: string,
  skills: VatSkillMetadata[],
  configDir: string,
  pluginsDir: string,
  logger: ReturnType<typeof createLogger>
): Promise<PluginBuildResult> {
  const pluginDir = join(pluginsDir, pluginName);
  const skillsCopied: string[] = [];

  logger.info(`   📦 Building plugin: ${pluginName}`);

  for (const skill of skills) {
    const skillDistPath = resolveRelativePath(skill.path, configDir);

    // Verify skill is built
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from config
    if (!existsSync(skillDistPath)) {
      throw new Error(
        `Skill "${skill.name}" not built at ${skillDistPath}. ` +
          `Run: vat skills build (or vat build to build everything)`
      );
    }

    // Copy skill into plugin directory structure.
    // Use skillNameToFsPath to strip colons — colon-namespaced skill names (e.g.
    // "pkg:sub-skill") are valid VAT identifiers but invalid directory names on Windows.
    const fsPath = skillNameToFsPath(skill.name);
    const destPath = join(pluginDir, 'skills', fsPath);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved paths
    await mkdir(destPath, { recursive: true });
    await cp(skillDistPath, destPath, { recursive: true });
    skillsCopied.push(fsPath);
    logger.info(`      ✅ ${skill.name} → skills/${fsPath}`);
  }

  // Generate plugin.json
  const pluginJsonDir = join(pluginDir, '.claude-plugin');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved paths
  await mkdir(pluginJsonDir, { recursive: true });
  const pluginJson = {
    name: pluginName,
    skills: skillsCopied.map((skillName) => `skills/${skillName}`),
  };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved paths
  await writeFile(join(pluginJsonDir, 'plugin.json'), JSON.stringify(pluginJson, null, 2));
  logger.info(`      ✅ .claude-plugin/plugin.json`);

  return { pluginName, pluginDir, skillsCopied };
}

/**
 * Resolve skill selectors (exact names or glob patterns) against available skills.
 * Supports exact name match and simple glob suffix like "acme-*".
 */
function resolveSkillSelectors(
  selectors: string[],
  availableSkills: VatSkillMetadata[]
): VatSkillMetadata[] {
  if (selectors.length === 0) {
    return availableSkills;
  }

  const matched = new Set<string>();
  for (const selector of selectors) {
    for (const skill of availableSkills) {
      if (matchesSelector(skill.name, selector)) {
        matched.add(skill.name);
      }
    }
  }

  return availableSkills.filter((s) => matched.has(s.name));
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

function resolveRelativePath(filePath: string, baseDir: string): string {
  if (isAbsolute(filePath)) {
    return filePath;
  }
  return resolve(baseDir, filePath);
}
