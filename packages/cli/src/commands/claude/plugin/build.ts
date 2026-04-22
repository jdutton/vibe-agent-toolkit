/**
 * `vat claude plugin build` — assemble Claude plugin artifacts from plugins/<name>/
 *
 * Reads vibe-agent-toolkit.config.yaml → claude.marketplaces.
 * For each plugin, assembles the plugin bundle from its own plugins/<name>/ directory
 * (commands, hooks, agents, .mcp.json, skills/, .claude-plugin/plugin.json).
 * The top-level skills: pool is an independent build target and is never imported.
 */

import { cpSync, existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';

import type { ClaudeMarketplaceConfig, ClaudeMarketplacePluginEntry } from '@vibe-agent-toolkit/resources';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { handleCommandError } from '../../../utils/command-error.js';
import { createLogger } from '../../../utils/logger.js';
import { writeYamlOutput } from '../../../utils/output.js';
import { loadClaudeProjectConfig } from '../claude-config.js';

import { applyPluginFiles } from './plugin-files.js';
import { mergePluginJson } from './plugin-json-merge.js';
import {
  parsePluginJsonFiles,
  verifyNoCaseCollidingPluginNames,
  verifyPluginDirCaseMatch,
} from './plugin-validators.js';
import { treeCopyPlugin } from './tree-copy.js';

export interface PluginBuildCommandOptions {
  marketplace?: string;
  debug?: boolean;
}

const CLAUDE_PLUGIN_DIRNAME = '.claude-plugin';

interface PluginBuildResult {
  pluginName: string;
  pluginDir: string;
  skillsCopied: string[];
  commandsCopied: number;
  hooksCopied: number;
  agentsCopied: number;
  mcpCopied: number;
  treeFilesCopied: number;
  explicitFilesCopied: number;
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
  Reads vibe-agent-toolkit.config.yaml and assembles each Claude plugin bundle
  from its own plugins/<name>/ directory.

  For each marketplace, for each plugin:
  - Tree-copies plugins/<name>/ (commands, hooks, agents, .mcp.json) verbatim
  - Copies plugin-local skills from dist/plugins/<name>/skills/ (built by vat skills build)
  - Applies explicit files: source→dest mappings for compiled artifacts
  - Merges plugin.json with author, description, and VAT-supplied metadata
  - Generates marketplace.json with plugin registry and relative source paths

Output structure:
  dist/.claude/plugins/marketplaces/<marketplace>/
    .claude-plugin/marketplace.json
    plugins/<plugin>/
      .claude-plugin/plugin.json
      skills/<skillName>/SKILL.md   (plugin-local, from vat skills build)

Output:
  YAML summary -> stdout
  Build progress -> stderr

Exit Codes:
  0 - Build successful
  1 - Build error (empty plugin, invalid config)
  2 - System error

Example:
  $ vat skills build && vat claude plugin build    # Build skills then wrap for Claude
`
    );

  return command;
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
      const pkgPath = safePath.join(configDir, 'package.json');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- configDir from loadClaudeProjectConfig
      const pkgRaw = readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(pkgRaw) as { version?: string };
      packageVersion = pkg.version;
    } catch {
      // No package.json or unreadable — version will be omitted
    }

    logger.info(`Building Claude plugin artifacts`);
    logger.info(`   Config: ${configPath}`);

    const results: MarketplaceBuildResult[] = [];

    const marketplaces = claudeConfig.marketplaces;
    const allPluginNames: string[] = [];
    for (const mp of Object.values(marketplaces)) {
      for (const p of mp.plugins) allPluginNames.push(p.name);
    }
    verifyNoCaseCollidingPluginNames(allPluginNames);

    for (const name of Object.keys(marketplaces)) {
      const mpConfig = marketplaces[name] as ClaudeMarketplaceConfig;

      // Skip if --marketplace filter specified and doesn't match
      if (options.marketplace && options.marketplace !== name) {
        continue;
      }

      logger.info(`\n   Building marketplace: ${name}`);
      const result = await buildMarketplace(name, mpConfig, configDir, packageVersion, logger);
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
          commandsCopied: p.commandsCopied,
          hooksCopied: p.hooksCopied,
          agentsCopied: p.agentsCopied,
          mcpCopied: p.mcpCopied,
          treeFilesCopied: p.treeFilesCopied,
          explicitFilesCopied: p.explicitFilesCopied,
        })),
      })),
      duration: `${duration}ms`,
    });

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'ClaudePluginBuild');
  }
}

/**
 * Copy distribution files (LICENSE, README.md, CHANGELOG.md) to marketplace output.
 * README.md and CHANGELOG.md can be overridden via publish.readme / publish.changelog config.
 */
async function copyDistributionFiles(
  marketplaceDir: string,
  configDir: string,
  config: ClaudeMarketplaceConfig,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const overrides: Record<string, string | undefined> = {
    'README.md': config.publish?.readme,
    'CHANGELOG.md': config.publish?.changelog,
  };

  for (const file of ['LICENSE', 'README.md', 'CHANGELOG.md']) {
    const override = overrides[file];
    const srcPath = override ? safePath.join(configDir, override) : safePath.join(configDir, file);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- file is from static list or config
    if (existsSync(srcPath)) {
      cpSync(srcPath, safePath.join(marketplaceDir, file));
      if (override) {
        logger.info(`   ${file} (from publish.${file === 'README.md' ? 'readme' : 'changelog'}: ${override})`);
      } else {
        logger.info(`   ${file} (copied from project root)`);
      }
    }
  }
}

async function buildMarketplace(
  name: string,
  config: ClaudeMarketplaceConfig,
  configDir: string,
  packageVersion: string | undefined,
  logger: ReturnType<typeof createLogger>
): Promise<MarketplaceBuildResult> {
  const plugins: PluginBuildResult[] = [];

  // Clean stale marketplace directory before rebuilding — removes orphaned plugins
  const marketplaceBaseDir = safePath.join(
    configDir,
    'dist',
    '.claude',
    'plugins',
    'marketplaces',
    name,
  );
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from config
  if (existsSync(marketplaceBaseDir)) {
    await rm(marketplaceBaseDir, { recursive: true, force: true });
  }

  for (const pluginDef of config.plugins) {
    const pluginResult = await buildPlugin(
      name,
      pluginDef,
      configDir,
      config.owner,
      packageVersion,
      logger
    );
    plugins.push(pluginResult);
  }

  // Generate .claude-plugin/marketplace.json
  const marketplaceDir = marketplaceBaseDir;
  const claudePluginDir = safePath.join(marketplaceDir, CLAUDE_PLUGIN_DIRNAME);
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
  await writeFile(safePath.join(claudePluginDir, 'marketplace.json'), JSON.stringify(marketplaceJson, null, 2));
  logger.info(`   .claude-plugin/marketplace.json`);

  await copyDistributionFiles(marketplaceDir, configDir, config, logger);

  return { name, status: 'built', plugins };
}

async function copyPluginLocalSkills(
  pluginDef: ClaudeMarketplacePluginEntry,
  configDir: string,
  pluginSourceDir: string,
  pluginDir: string,
  logger: ReturnType<typeof createLogger>,
): Promise<string[]> {
  const copied: string[] = [];
  const localSkillsRoot = safePath.join(configDir, 'dist', 'plugins', pluginDef.name, 'skills');
  const sourceSkillsDir = safePath.join(pluginSourceDir, 'skills');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
  const sourceSkillsDeclared = existsSync(pluginSourceDir) && existsSync(sourceSkillsDir);
  const sourceSkillsDisplayPath = toForwardSlash(
    safePath.join(pluginDef.source ?? safePath.join('plugins', pluginDef.name), 'skills'),
  );

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
  if (!existsSync(localSkillsRoot)) {
    if (sourceSkillsDeclared) {
      logger.info(
        `warning: Plugin '${pluginDef.name}' declares plugin-local skills under ${sourceSkillsDisplayPath}/ ` +
          `but dist/plugins/${pluginDef.name}/skills/ does not exist. Run 'vat skills build' first.`,
      );
    }
    return copied;
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
  const localEntries = await readdir(localSkillsRoot, { withFileTypes: true });
  const subdirs = localEntries.filter((e) => e.isDirectory());
  if (subdirs.length === 0 && sourceSkillsDeclared) {
    logger.info(
      `warning: Plugin '${pluginDef.name}' has ${sourceSkillsDisplayPath}/ on disk but ` +
        `dist/plugins/${pluginDef.name}/skills/ is empty. Run 'vat skills build' before ` +
        `'vat claude plugin build' (or chain them: vat skills build && vat claude plugin build).`,
    );
  }
  for (const entry of subdirs) {
    const src = safePath.join(localSkillsRoot, entry.name);
    const dst = safePath.join(pluginDir, 'skills', entry.name);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved paths
    await mkdir(dst, { recursive: true });
    cpSync(src, dst, { recursive: true });
    copied.push(entry.name);
    logger.info(`         ${entry.name} (plugin-local) -> skills/${entry.name}`);
  }
  return copied;
}

async function writeMergedPluginJson(
  pluginDef: ClaudeMarketplacePluginEntry,
  pluginSourceDir: string,
  pluginDir: string,
  owner: ClaudeMarketplaceConfig['owner'],
  packageVersion: string | undefined,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const pluginJsonDir = safePath.join(pluginDir, CLAUDE_PLUGIN_DIRNAME);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved paths
  await mkdir(pluginJsonDir, { recursive: true });

  const authorPluginJsonPath = safePath.join(pluginSourceDir, CLAUDE_PLUGIN_DIRNAME, 'plugin.json');
  let authorJson: Record<string, unknown> | undefined;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
  if (existsSync(authorPluginJsonPath)) {
    try {
      authorJson = JSON.parse(
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
        readFileSync(authorPluginJsonPath, 'utf-8'),
      ) as Record<string, unknown>;
    } catch (e) {
      throw new Error(
        `Author .claude-plugin/plugin.json is not valid JSON: ${(e as Error).message}`,
      );
    }
  }

  const { merged, warnings } = mergePluginJson({
    vat: {
      name: pluginDef.name,
      version: packageVersion,
      author: { name: owner.name, ...(owner.email ? { email: owner.email } : {}) },
    },
    configDescription: pluginDef.description,
    authorJson,
  });
  for (const w of warnings) logger.info(`warning: ${w}`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved paths
  await writeFile(safePath.join(pluginJsonDir, 'plugin.json'), JSON.stringify(merged, null, 2));
  logger.info(`         .claude-plugin/plugin.json`);
}

async function buildPlugin(
  marketplaceName: string,
  pluginDef: ClaudeMarketplacePluginEntry,
  configDir: string,
  owner: ClaudeMarketplaceConfig['owner'],
  packageVersion: string | undefined,
  logger: ReturnType<typeof createLogger>
): Promise<PluginBuildResult> {
  const pluginDir = safePath.join(
    configDir, 'dist', '.claude', 'plugins', 'marketplaces',
    marketplaceName, 'plugins', pluginDef.name,
  );
  const pluginSourceDir = safePath.join(
    configDir,
    pluginDef.source ?? safePath.join('plugins', pluginDef.name),
  );

  logger.info(`      Building plugin: ${pluginDef.name}`);

  // Phase 1: validators.
  await verifyPluginDirCaseMatch(configDir, pluginDef.name);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
  const pluginSourceExists = existsSync(pluginSourceDir);
  const hasExplicitFiles = (pluginDef.files?.length ?? 0) > 0;
  if (!pluginSourceExists && !hasExplicitFiles) {
    throw new Error(
      `Plugin '${pluginDef.name}' has no content: no plugin dir found at ` +
        `'${toForwardSlash(safePath.relative(configDir, pluginSourceDir))}' and no files mapped. ` +
        `Add one of: (a) create the plugin directory, ` +
        `(b) add files: [{ source, dest }, ...] in config.`,
    );
  }

  if (pluginSourceExists) {
    await parsePluginJsonFiles(pluginSourceDir);
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved paths
  await mkdir(pluginDir, { recursive: true });

  // Phase 2: tree copy (skips skills/ and .claude-plugin/, respects .gitignore).
  const treeResult = pluginSourceExists
    ? await treeCopyPlugin({
        sourceDir: pluginSourceDir,
        destDir: pluginDir,
        warn: (m) => logger.info(`warning: ${m}`),
      })
    : { commandsCopied: 0, hooksCopied: 0, agentsCopied: 0, mcpCopied: 0, filesCopied: 0 };

  // Phase 3: plugin-local skill copy-in (from dist/plugins/<name>/skills/).
  const skillsCopied = await copyPluginLocalSkills(
    pluginDef,
    configDir,
    pluginSourceDir,
    pluginDir,
    logger,
  );

  // Phase 4: files[] mapping (may overwrite tree-copied files).
  let explicitFilesCopied = 0;
  if (pluginDef.files && pluginDef.files.length > 0) {
    await applyPluginFiles({
      projectRoot: configDir,
      pluginOutputDir: pluginDir,
      entries: pluginDef.files,
      info: (m) => logger.info(m),
    });
    explicitFilesCopied = pluginDef.files.length;
  }

  // Phase 5: plugin.json merge-write (always last, always wins).
  await writeMergedPluginJson(
    pluginDef,
    pluginSourceDir,
    pluginDir,
    owner,
    packageVersion,
    logger,
  );

  return {
    pluginName: pluginDef.name,
    pluginDir,
    skillsCopied,
    commandsCopied: treeResult.commandsCopied,
    hooksCopied: treeResult.hooksCopied,
    agentsCopied: treeResult.agentsCopied,
    mcpCopied: treeResult.mcpCopied,
    treeFilesCopied: treeResult.filesCopied,
    explicitFilesCopied,
  };
}
