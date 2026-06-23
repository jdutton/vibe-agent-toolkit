/**
 * `vat claude plugin build` — assemble Claude plugin artifacts from plugins/<name>/
 *
 * Reads vibe-agent-toolkit.config.yaml → claude.marketplaces.
 * For each plugin, assembles the plugin bundle from its own plugins/<name>/ directory
 * (commands, hooks, agents, .mcp.json, skills/, .claude-plugin/plugin.json) and
 * imports pool skills (from dist/skills/) via the `skills:` selector.
 */

import { cpSync, existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';

import { applyFilesConfig, getPluginOutputDir, getPluginSourceDir, listPluginSourceSkillDirs, mergeFilesConfig, skillNameToFsPath } from '@vibe-agent-toolkit/agent-skills';
import type { ClaudeMarketplaceConfig, ClaudeMarketplacePluginEntry, SkillsConfig } from '@vibe-agent-toolkit/resources';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { handleCommandError } from '../../../utils/command-error.js';
import { loadConfig } from '../../../utils/config-loader.js';
import { createLogger } from '../../../utils/logger.js';
import { writeYamlOutput } from '../../../utils/output.js';
import { loadClaudeProjectConfig } from '../claude-config.js';

import { resolvePluginChangelogPath } from './plugin-changelog.js';
import { applyPluginFiles } from './plugin-files.js';
import { mergePluginJson, resolveVersion } from './plugin-json-merge.js';
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
  pluginVersion: string | undefined;
  skillsCopied: string[];
  commandsCopied: number;
  hooksCopied: number;
  agentsCopied: number;
  mcpCopied: number;
  treeFilesCopied: number;
  explicitFilesCopied: number;
  skillFilesCopied: number;
}

export interface MarketplaceBuildResult {
  name: string;
  status: 'built' | 'error';
  reason?: string;
  plugins: PluginBuildResult[];
}

export function createPluginBuildCommand(): Command {
  const command = new Command('build');

  command
    .description('Generate Claude plugin artifacts from plugin directories and pre-built skills')
    .option('--marketplace <name>', 'Build specific marketplace only')
    .option('--debug', 'Enable debug logging')
    .action(pluginBuildCommand)
    .addHelpText(
      'after',
      `
Description:
  Reads vibe-agent-toolkit.config.yaml and assembles each Claude plugin bundle
  from its own plugins/<name>/ directory, plus pool skills selected via the
  plugin's skills: selector.

  For each marketplace, for each plugin:
  - Tree-copies plugins/<name>/ (commands, hooks, agents, skills, .mcp.json) verbatim
  - Imports pool skills (dist/skills/) via the plugin's skills: selector
  - Applies explicit files: source→dest mappings for compiled artifacts
  - Merges plugin.json with author, description, and VAT-supplied metadata
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
  1 - Build error (empty plugin, invalid config)
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
  const skillsDir = safePath.join(configDir, 'dist', 'skills');

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from config
  if (!existsSync(skillsDir)) {
    return [];
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from config
  const entries = await readdir(skillsDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/**
 * Build Claude plugin artifacts for a project — the non-exiting orchestration
 * core shared by the `vat claude plugin build` CLI action and `vat skill test`
 * (which builds a declared skill's owning marketplace before staging its dist).
 *
 * Throws on any build error; never calls `process.exit` and never emits the YAML
 * summary — those belong to the CLI wrapper. Returns one result per built
 * marketplace (empty when no `claude.marketplaces` are configured).
 *
 * `configDir` is threaded in (the project root that holds
 * vibe-agent-toolkit.config.yaml), so callers that already know the root build
 * against it rather than re-discovering from cwd. `options.marketplace` restricts
 * the build to a single marketplace by name.
 */
export async function runClaudePluginBuild(
  configDir: string,
  options: { marketplace?: string; logger?: ReturnType<typeof createLogger> } = {},
): Promise<MarketplaceBuildResult[]> {
  const logger = options.logger ?? createLogger({});

  const projectConfig = loadConfig(configDir);
  const marketplaces = projectConfig?.claude?.marketplaces;
  if (!marketplaces || Object.keys(marketplaces).length === 0) {
    return [];
  }

  // Read version from root package.json — lowest-precedence fallback in the
  // per-plugin version chain (config > plugin.json > root). Used so Claude
  // Code caches by version instead of "unknown/" when no per-plugin version
  // is supplied.
  let rootVersion: string | undefined;
  try {
    const pkgPath = safePath.join(configDir, 'package.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- configDir is the project root
    const pkgRaw = readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(pkgRaw) as { version?: string };
    rootVersion = pkg.version;
  } catch {
    // No package.json or unreadable — version will be omitted
  }

  // Discover available skills from dist/skills/ for pool-to-plugin selectors
  const availableSkills = await discoverBuiltSkills(configDir);

  // Load the project's skills config (defaults + per-skill) so the plugin build
  // can apply each tree-copied skill's skill-level `files:` mapping — the
  // verbatim tree-copy never runs the skill-packager, so without this a skill's
  // build-provided artifacts (a bundled engine, generated data, a catalog)
  // would be missing from the shipped plugin tree. Undefined when no config.
  const skillsConfig = projectConfig?.skills;

  logger.info(`Building Claude plugin artifacts`);
  logger.info(`   Config: ${safePath.join(configDir, 'vibe-agent-toolkit.config.yaml')}`);
  logger.info(`   Skills available: ${availableSkills.length}`);

  const results: MarketplaceBuildResult[] = [];

  const allPluginNames: string[] = [];
  for (const mp of Object.values(marketplaces)) {
    for (const p of mp.plugins) allPluginNames.push(p.name);
  }
  verifyNoCaseCollidingPluginNames(allPluginNames);

  for (const name of Object.keys(marketplaces)) {
    // Skip if --marketplace filter specified and doesn't match
    if (options.marketplace && options.marketplace !== name) {
      continue;
    }

    const mpConfig = marketplaces[name] as ClaudeMarketplaceConfig;

    logger.info(`\n   Building marketplace: ${name}`);
    const result = await buildMarketplace(
      name,
      mpConfig,
      availableSkills,
      configDir,
      skillsConfig,
      rootVersion,
      logger,
    );
    results.push(result);

    if (result.status === 'error') {
      throw new Error(
        `Claude plugin build failed for marketplace '${name}': ${result.reason ?? 'unknown error'}`,
      );
    }
  }

  return results;
}

async function pluginBuildCommand(options: PluginBuildCommandOptions): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const { configDir, claudeConfig } = await loadClaudeProjectConfig();

    if (!claudeConfig?.marketplaces || Object.keys(claudeConfig.marketplaces).length === 0) {
      writeYamlOutput({
        status: 'success',
        message: 'No claude.marketplaces configured — nothing to build',
        duration: `${Date.now() - startTime}ms`,
      });
      process.exit(0);
    }

    const results = await runClaudePluginBuild(configDir, {
      ...(options.marketplace ? { marketplace: options.marketplace } : {}),
      logger,
    });

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
          skillFilesCopied: p.skillFilesCopied,
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
  availableSkills: string[],
  configDir: string,
  skillsConfig: SkillsConfig | undefined,
  rootVersion: string | undefined,
  logger: ReturnType<typeof createLogger>,
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

  // Marketplace-level skills filter restricts pool available to plugins that use "*"
  const marketplaceAvailable = resolveMarketplaceAvailableSkills(config, availableSkills);

  for (const pluginDef of config.plugins) {
    const pluginResult = await buildPlugin({
      marketplaceName: name,
      pluginDef,
      marketplaceAvailable,
      configDir,
      skillsConfig,
      owner: config.owner,
      rootVersion,
      logger,
    });
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
        ...(p.pluginVersion ? { version: p.pluginVersion } : {}),
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

/**
 * Resolve which pool skills are available to plugins in this marketplace.
 *
 * When marketplace declares `skills: [...]`, restricts the pool to matching skills
 * (affecting plugins that use `skills: "*"`). Omit or `"*"` = allow all.
 */
function resolveMarketplaceAvailableSkills(
  config: ClaudeMarketplaceConfig,
  availableSkills: string[],
): string[] {
  if (config.skills === undefined || config.skills === '*') {
    return availableSkills;
  }
  const filter = new Set<string>();
  for (const selector of config.skills) {
    for (const skillName of availableSkills) {
      if (matchesSelector(skillName, selector)) {
        filter.add(skillName);
      }
    }
  }
  return [...filter];
}

/**
 * Resolve which skills a plugin gets based on its `skills` selector.
 * "*" means all marketplace-available skills; string[] means match each selector
 * against available skill names.
 */
function resolvePluginSkills(
  pluginDef: ClaudeMarketplacePluginEntry,
  availableSkills: string[],
): string[] {
  if (pluginDef.skills === '*') {
    return availableSkills;
  }

  const matched = new Set<string>();
  for (const selector of pluginDef.skills) {
    // Also try the fs-safe form (colon -> __) since dist/skills/ dirnames use the fs-safe form.
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
 * Check if a skill name matches a selector.
 * Supports exact match and simple glob patterns (prefix*, suffix*, *contains*).
 */
function matchesSelector(skillName: string, selector: string): boolean {
  if (selector === '*') {
    return true;
  }

  // eslint-disable-next-line security/detect-non-literal-regexp -- selector is from project config, bounded by name format
  const regex = new RegExp(`^${selector.replaceAll('*', '.*')}$`);
  return regex.test(skillName);
}

/**
 * Read the author-supplied .claude-plugin/plugin.json from the plugin source dir,
 * if present. Returns undefined when the file doesn't exist; throws on invalid JSON.
 */
function readAuthorPluginJson(
  pluginSourceDir: string,
): (Record<string, unknown> & { version?: string }) | undefined {
  const authorPluginJsonPath = safePath.join(pluginSourceDir, CLAUDE_PLUGIN_DIRNAME, 'plugin.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
  if (!existsSync(authorPluginJsonPath)) {
    return undefined;
  }
  try {
    return JSON.parse(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
      readFileSync(authorPluginJsonPath, 'utf-8'),
    ) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `Author .claude-plugin/plugin.json is not valid JSON: ${(e as Error).message}`,
    );
  }
}

async function writeMergedPluginJson(
  pluginDef: ClaudeMarketplacePluginEntry,
  authorJson: Record<string, unknown> | undefined,
  pluginVersion: string | undefined,
  pluginDir: string,
  owner: ClaudeMarketplaceConfig['owner'],
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const pluginJsonDir = safePath.join(pluginDir, CLAUDE_PLUGIN_DIRNAME);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved paths
  await mkdir(pluginJsonDir, { recursive: true });

  const { merged, warnings } = mergePluginJson({
    vat: {
      name: pluginDef.name,
      version: pluginVersion,
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

/**
 * Copy pool skills (from dist/skills/) selected by the plugin's skills: selector
 * into the plugin bundle's skills/ directory.
 */
async function copyPoolSkills(
  pluginDef: ClaudeMarketplacePluginEntry,
  marketplaceAvailable: string[],
  configDir: string,
  pluginDir: string,
  logger: ReturnType<typeof createLogger>,
): Promise<string[]> {
  const selected = resolvePluginSkills(pluginDef, marketplaceAvailable);
  const copied: string[] = [];

  for (const skillName of selected) {
    const skillDistPath = safePath.join(configDir, 'dist', 'skills', skillName);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from config
    if (!existsSync(skillDistPath)) {
      throw new Error(
        `Skill "${skillName}" not built at ${skillDistPath}. ` +
          `Run: vat skills build (or vat build to build everything)`,
      );
    }

    const fsPath = skillNameToFsPath(skillName);
    const destPath = safePath.join(pluginDir, 'skills', fsPath);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved paths
    await mkdir(destPath, { recursive: true });
    cpSync(skillDistPath, destPath, { recursive: true });
    copied.push(fsPath);
    logger.info(`         ${skillName} -> skills/${fsPath}`);
  }

  return copied;
}

/**
 * Apply each tree-copied (plugin-source) skill's skill-level `files:` mapping
 * into the distributed skill dir, mirroring what `vat skills build` does for pool
 * skills. The plugin tree-copy is verbatim and never runs the skill-packager, so
 * a skill whose build-provided artifacts live in its own dir would otherwise ship
 * without them. Pool skills (copied from dist/skills/) already had `files:` baked
 * in by `vat skills build`, so only plugin-source skills are processed here.
 * Returns the number of files copied.
 */
async function applyTreeCopiedSkillFiles(input: {
  pluginSourceDir: string;
  pluginDir: string;
  configDir: string;
  skillsConfig: SkillsConfig | undefined;
  logger: ReturnType<typeof createLogger>;
}): Promise<number> {
  // Enumerate via the shared layout helper so build and verify resolve a plugin's
  // tree-copied skills through ONE definition — verify's files-config-dests check
  // (via computeTreeCopiedSkillLocations) and this write path can never diverge.
  let copied = 0;
  for (const skillName of listPluginSourceSkillDirs(input.pluginSourceDir)) {
    const filesConfig = mergeFilesConfig(
      input.skillsConfig?.defaults?.files,
      input.skillsConfig?.config?.[skillName]?.files,
    );
    if (filesConfig.length === 0) continue;

    const skillOutputDir = safePath.join(input.pluginDir, 'skills', skillName);
    const dests = await applyFilesConfig({
      filesConfig,
      projectRoot: input.configDir,
      skillOutputDir,
    });
    for (const dest of dests) {
      input.logger.info(`         ${skillName} files: -> skills/${skillName}/${dest}`);
    }
    copied += dests.length;
  }
  return copied;
}

interface BuildPluginInput {
  marketplaceName: string;
  pluginDef: ClaudeMarketplacePluginEntry;
  marketplaceAvailable: string[];
  configDir: string;
  skillsConfig: SkillsConfig | undefined;
  owner: ClaudeMarketplaceConfig['owner'];
  rootVersion: string | undefined;
  logger: ReturnType<typeof createLogger>;
}

async function buildPlugin(input: BuildPluginInput): Promise<PluginBuildResult> {
  const { marketplaceName, pluginDef, marketplaceAvailable, configDir, skillsConfig, owner, rootVersion, logger } =
    input;
  const pluginDir = getPluginOutputDir(configDir, marketplaceName, pluginDef.name);
  const pluginSourceDir = getPluginSourceDir(configDir, pluginDef);

  logger.info(`      Building plugin: ${pluginDef.name}`);

  // Phase 1: validators.
  await verifyPluginDirCaseMatch(configDir, pluginDef.name);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled path
  const pluginSourceExists = existsSync(pluginSourceDir);
  const hasExplicitFiles = (pluginDef.files?.length ?? 0) > 0;
  const hasPoolSkills =
    pluginDef.skills === '*'
      ? marketplaceAvailable.length > 0
      : pluginDef.skills.length > 0;
  if (!pluginSourceExists && !hasExplicitFiles && !hasPoolSkills) {
    throw new Error(
      `Plugin '${pluginDef.name}' has no content: no plugin dir found at ` +
        `'${toForwardSlash(safePath.relative(configDir, pluginSourceDir))}', no files mapped, and no skills selected. ` +
        `Add one of: (a) create the plugin directory, ` +
        `(b) add files: [{ source, dest }, ...] in config, ` +
        `(c) select pool skills via skills: "*" or skills: [names].`,
    );
  }

  if (pluginSourceExists) {
    await parsePluginJsonFiles(pluginSourceDir);
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved paths
  await mkdir(pluginDir, { recursive: true });

  // Phase 2: tree copy (skips .claude-plugin/, respects .gitignore).
  const treeResult = pluginSourceExists
    ? await treeCopyPlugin({
        sourceDir: pluginSourceDir,
        destDir: pluginDir,
        warn: (m) => logger.info(`warning: ${m}`),
      })
    : { commandsCopied: 0, hooksCopied: 0, agentsCopied: 0, mcpCopied: 0, filesCopied: 0 };

  // Phase 2.5: apply each tree-copied plugin-source skill's skill-level files:
  // mapping into the distributed skill dir (the tree-copy is verbatim and never
  // runs the skill-packager). Pool skills (Phase 3) already had files: baked in
  // by `vat skills build`, so this only touches plugin-source skills.
  const skillFilesCopied = pluginSourceExists
    ? await applyTreeCopiedSkillFiles({ pluginSourceDir, pluginDir, configDir, skillsConfig, logger })
    : 0;

  // Phase 3: pool-skill copy-in (from dist/skills/ via the plugin's skills: selector).
  const skillsCopied = await copyPoolSkills(
    pluginDef,
    marketplaceAvailable,
    configDir,
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
  // Read author plugin.json once, resolve version once — single source of
  // truth that flows into both the merged plugin.json and marketplace.json.
  const authorJson = readAuthorPluginJson(pluginSourceDir);
  const pluginVersion = resolveVersion(
    pluginDef,
    authorJson,
    rootVersion,
    { warn: (message) => logger.info(`warning: ${message}`) },
  );

  await writeMergedPluginJson(
    pluginDef,
    authorJson,
    pluginVersion,
    pluginDir,
    owner,
    logger,
  );

  // Phase 6: per-plugin CHANGELOG copy. Resolves to <pluginSourceDir>/CHANGELOG.md
  // by default, or `entry.changelog` (relative to plugin source) when configured.
  // No-op when neither resolves — marketplace-level CHANGELOG (handled in
  // copyDistributionFiles) is unaffected.
  const changelogPath = resolvePluginChangelogPath(pluginSourceDir, pluginDef);
  if (changelogPath) {
    cpSync(changelogPath, safePath.join(pluginDir, 'CHANGELOG.md'));
    logger.info(`         CHANGELOG.md`);
  }

  return {
    pluginName: pluginDef.name,
    pluginDir,
    pluginVersion,
    skillsCopied,
    commandsCopied: treeResult.commandsCopied,
    hooksCopied: treeResult.hooksCopied,
    agentsCopied: treeResult.agentsCopied,
    mcpCopied: treeResult.mcpCopied,
    treeFilesCopied: treeResult.filesCopied,
    explicitFilesCopied,
    skillFilesCopied,
  };
}
