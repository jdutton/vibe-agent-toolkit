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
import { basename } from 'node:path';

import { countBySeverity, type SeverityCounts, type ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import { createProjectRegistry, getPluginOutputDir, getPluginSourceDir, listPluginSourceSkillDirs, listUntrackedPluginSkillDirs, materializeIssue, packageSkill, packagingConfigToPackageOptions, skillNameToFsPath, type DeclaredEvalSuite, type PackageSkillResult } from '@vibe-agent-toolkit/agent-skills';
import type { ClaudeMarketplaceConfig, ClaudeMarketplacePluginEntry, ResourceRegistry, SkillsConfig } from '@vibe-agent-toolkit/resources';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { readSkillName } from '../../../commands/skills/skill-discovery.js';
import { handleCommandError } from '../../../utils/command-error.js';
import { loadConfig } from '../../../utils/config-loader.js';
import {
  collectPostBuildIssues,
  formatIssueLines,
  formatIssueSetHeading,
  formatPackagedFileCount,
  issuesToRenderAtVerbosity,
  sumSeverityCounts,
} from '../../../utils/issue-rendering.js';
import { createLogger } from '../../../utils/logger.js';
import { writeYamlOutput } from '../../../utils/output.js';
import { collectDeclaredEvalSuites, mergeSkillPackagingConfig } from '../../../utils/skill-packaging-config.js';
import { discoverSkillsFromConfig } from '../../skills/skill-discovery.js';
import { loadClaudeProjectConfig } from '../claude-config.js';

import { buildMarketplaceJson } from './marketplace-json.js';
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
  verbose?: boolean;
}

const CLAUDE_PLUGIN_DIRNAME = '.claude-plugin';

interface PluginBuildResult {
  pluginName: string;
  pluginDir: string;
  pluginVersion: string | undefined;
  /**
   * The plugin's merged `author` (config-owned name/email plus the subfields
   * config cannot express, passed through from the author's plugin.json). Carried
   * up so marketplace.json republishes THIS object rather than rebuilding one
   * from the config `owner` and silently dropping the passthrough subfields.
   */
  pluginAuthor: Record<string, unknown>;
  skillsCopied: string[];
  commandsCopied: number;
  hooksCopied: number;
  agentsCopied: number;
  mcpCopied: number;
  treeFilesCopied: number;
  explicitFilesCopied: number;
  localSkillsPackaged: number;
  /**
   * Per-severity findings for the WHOLE plugin: its plugin-local skills'
   * post-build findings PLUS plugin-level findings that belong to no skill (a
   * dead `exclude:` pattern, say).
   *
   * Published rather than folded into the plugin's success/failure: the build
   * gate is two-valued (a warning does not fail it), so a bare `status` cannot
   * say whether a "built" plugin shipped warnings or info findings — and the
   * reading a consumer takes from silence is the reassuring one.
   *
   * Named for the plugin, not for its skills: as `localSkillIssueCounts` this
   * field silently defined "a plugin's findings" as "its skills' findings", so
   * a plugin-level finding had nowhere to land and was written to stderr beside
   * a published `warnings: 0`.
   */
  issueCounts: SeverityCounts;
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
    .option('-v, --verbose', 'Show every individual finding, not just the errors')
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
  - Tree-copies plugins/<name>/ non-skill content (commands, hooks, agents, .mcp.json)
  - Packages each plugin-local skill (plugins/<name>/skills/*) with the same
    packager used for pool skills — links rewritten, files: applied, declared
    test input excluded. Skills are never copied verbatim.
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

  On stderr, each packaged skill's findings heading names the whole set and
  its severity breakdown, and errors are always printed in full beneath it.
  Warnings and info findings stay collapsed into that heading unless
  --verbose. The stdout YAML is NOT affected by --verbose: its issueCounts
  cover every finding at every verbosity.

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
 *
 * `options.verbose` affects the stderr findings report ONLY (see
 * `summarizePackagedSkillIssues`); it changes nothing this function returns, so a
 * programmatic caller — `vat skill test`, which builds a marketplace purely to
 * stage a skill — can leave it off and still get the same result objects.
 */
export async function runClaudePluginBuild(
  configDir: string,
  options: {
    marketplace?: string;
    logger?: ReturnType<typeof createLogger>;
    verbose?: boolean;
  } = {},
): Promise<MarketplaceBuildResult[]> {
  const logger = options.logger ?? createLogger({});
  const verbose = options.verbose === true;

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

  // Load the project's skills config (defaults + per-skill) so each plugin-local
  // skill is PACKAGED with its own effective packaging config — the same config
  // `vat skills build` would use for it. Undefined when no config, in which case
  // plugin-local skills package with schema defaults.
  const skillsConfig = projectConfig?.skills;

  logger.info(`Building Claude plugin artifacts`);
  logger.info(`   Config: ${safePath.join(configDir, 'vibe-agent-toolkit.config.yaml')}`);
  logger.info(`   Skills available: ${availableSkills.length}`);

  // THE registry for this build: one crawl+parse of the project's markdown,
  // shared by every plugin-local skill in every marketplace. `packageSkill`
  // builds this itself when it is not given one, so omitting it does not fail —
  // it just re-reads the whole project once per skill, which is how a 46-skill
  // build came to take longer than a 30-minute CI budget.
  const sharedRegistry = await createProjectRegistry(configDir);
  logger.debug(`Project registry: ${sharedRegistry.getAllResources().length} markdown resources (built once)`);

  // THE project's declared eval suites for this build, assembled ONCE and threaded
  // to every plugin-local skill. Test input never ships, and the rule is
  // project-wide: a file ANY skill declares as its eval suite is an answer key, so
  // a plugin-local skill's bundle must exclude the OTHER skills' suites too — not
  // just its own. Discovery is not free, hence once per run rather than per skill.
  const projectSkills = skillsConfig === undefined
    ? []
    : collectDeclaredEvalSuites(skillsConfig, await discoverSkillsFromConfig(skillsConfig, configDir));
  logger.debug(`Project declared eval suites: ${projectSkills.length}`);

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
    const result = await buildMarketplace({
      name,
      config: mpConfig,
      availableSkills,
      configDir,
      skillsConfig,
      rootVersion,
      registry: sharedRegistry,
      projectSkills,
      logger,
      verbose,
    });
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
      verbose: options.verbose === true,
    });

    const duration = Date.now() - startTime;
    const totalPlugins = results.flatMap((r) => r.plugins).length;
    const totalSkills = results.flatMap((r) => r.plugins).flatMap((p) => p.skillsCopied).length;

    const allPlugins = results.flatMap((r) => r.plugins);

    // KNOWN, DELIBERATELY NOT FIXED — this lane NAMES NOTHING. Every level of this
    // document publishes severity counts and no findings: `vat build --only claude`
    // on a real adopter monorepo published `warnings: 70, info: 30` with zero named
    // findings anywhere in the document, at any verbosity. A reader is told how many
    // things are wrong and never which. The findings exist — `summarizePackagedSkillIssues`
    // and `reportPluginIssues` render them — but only to stderr, where no CI consumer
    // reads them.
    //
    // Same class as the `validationFailedSkills` rows in ../../skills/build.ts, a
    // different lane. Fixing it means carrying `ValidationIssue[]` up through
    // `PluginBuildResult`/`MarketplaceBuildResult` beside the counts they already
    // carry, then publishing it on the plugin rows below.
    writeYamlOutput({
      status: 'success',
      // The build gate is two-valued and a warning does not fail it, so the
      // distribution has to travel next to the status rather than inside it.
      issueCounts: sumSeverityCounts(allPlugins.map((p) => p.issueCounts)),
      marketplacesBuilt: results.filter((r) => r.status === 'built').length,
      pluginsBuilt: totalPlugins,
      skillsPackaged: totalSkills,
      marketplaces: results.map((r) => ({
        name: r.name,
        status: r.status,
        ...(r.reason ? { reason: r.reason } : {}),
        plugins: r.plugins.map((p) => ({
          name: p.pluginName,
          // KNOWN, DELIBERATELY NOT FIXED — an ABSOLUTE path, so stdout carries
          // `$HOME`. Measured on a real adopter monorepo run: 5 places in the
          // published document. Failure MESSAGES in this change were scrubbed of
          // absolute project paths and are confirmed clean; the success-path fields
          // like this one were not, so the leak survives in the reports CI keeps.
          //
          // Do NOT relativize it on its own. It is blocked on the same undecided
          // question as `skills[].outputPath` in ../../skills/build.ts: which root
          // these reports anchor on. Picking one here picks it by accident, and the
          // two build lanes then publish paths in two coordinate systems.
          dir: p.pluginDir,
          skills: p.skillsCopied,
          commandsCopied: p.commandsCopied,
          hooksCopied: p.hooksCopied,
          agentsCopied: p.agentsCopied,
          mcpCopied: p.mcpCopied,
          treeFilesCopied: p.treeFilesCopied,
          explicitFilesCopied: p.explicitFilesCopied,
          localSkillsPackaged: p.localSkillsPackaged,
          issueCounts: p.issueCounts,
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

/**
 * Inputs for one marketplace build. An object rather than a positional list:
 * every field is threaded straight through to {@link buildPlugin}, which already
 * takes an object, and two of them (`skillsConfig`, `rootVersion`) are optional
 * strings/undefined that a positional call site can transpose in silence.
 */
interface BuildMarketplaceInput {
  name: string;
  config: ClaudeMarketplaceConfig;
  availableSkills: string[];
  configDir: string;
  skillsConfig: SkillsConfig | undefined;
  rootVersion: string | undefined;
  /** THE project registry, built once per run (see runClaudePluginBuild). */
  registry: ResourceRegistry;
  /** THE project's declared eval suites, assembled once per run (same reason). */
  projectSkills: readonly DeclaredEvalSuite[];
  logger: ReturnType<typeof createLogger>;
  /** Render every finding, not just the errors (stderr only). */
  verbose: boolean;
}

async function buildMarketplace(input: BuildMarketplaceInput): Promise<MarketplaceBuildResult> {
  const { name, config, availableSkills, configDir, skillsConfig, rootVersion, registry, projectSkills, logger, verbose } = input;
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
      registry,
      projectSkills,
      logger,
      verbose,
    });
    plugins.push(pluginResult);
  }

  // Generate .claude-plugin/marketplace.json
  const marketplaceDir = marketplaceBaseDir;
  const claudePluginDir = safePath.join(marketplaceDir, CLAUDE_PLUGIN_DIRNAME);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved paths
  await mkdir(claudePluginDir, { recursive: true });

  // Each entry's author is the plugin's own MERGED author (see marketplace-json.ts),
  // so marketplace.json and that plugin's plugin.json cannot disagree.
  const marketplaceJson = buildMarketplaceJson({
    name,
    owner: config.owner,
    plugins: plugins.map((p) => ({
      name: p.pluginName,
      description: config.plugins.find((pd) => pd.name === p.pluginName)?.description,
      version: p.pluginVersion,
      author: p.pluginAuthor,
    })),
  });

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
): Promise<Record<string, unknown>> {
  const pluginJsonDir = safePath.join(pluginDir, CLAUDE_PLUGIN_DIRNAME);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved paths
  await mkdir(pluginJsonDir, { recursive: true });

  const { merged, author, warnings } = mergePluginJson({
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
  return author;
}

/**
 * Copy pool skills (from dist/skills/) selected by the plugin's skills: selector
 * into the plugin bundle's skills/ directory.
 *
 * `destOverrides` maps a selected skill's NAME to the `skills/`-relative directory
 * it must land in, and carries the collision referee's decision (see
 * {@link resolveCollidingSkills}): when the pool copy wins over a plugin-local copy,
 * it takes over the plugin-local skill's own authored directory path rather than the
 * default `skills/<fsName>`. That keeps ONE invariant true for every plugin-local
 * skill, refereed or not — it ships at the path it was authored at, which is exactly
 * what `DistributedSkillLocation.skillOutputDir` promises every consumer of the
 * layout module. Without it a NESTED collision (`skills/group/foo` losing to pool
 * `foo`) landed at `skills/foo`, and `vat skill test foo` then hard-failed looking for
 * a dist at `skills/group/foo` that the build never wrote.
 */
async function copyPoolSkills(
  pluginDef: ClaudeMarketplacePluginEntry,
  marketplaceAvailable: string[],
  configDir: string,
  pluginDir: string,
  destOverrides: ReadonlyMap<string, string>,
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

    const fsPath = destOverrides.get(skillName) ?? skillNameToFsPath(skillName);
    const destPath = safePath.join(pluginDir, 'skills', fsPath);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved paths
    await mkdir(destPath, { recursive: true });
    cpSync(skillDistPath, destPath, { recursive: true });
    copied.push(fsPath);
    logger.info(`         ${skillName} -> skills/${fsPath}`);
  }

  return copied;
}

/** One plugin-local skill, discovered once and carried through every later phase. */
interface PluginLocalSkill {
  /** Forward-slash dir path relative to the plugin's `skills/` dir (`a`, `group/b`). */
  skillDirPath: string;
  /** Absolute path to its `SKILL.md`. */
  skillPath: string;
  /** Its DECLARED name (frontmatter → H1 → filename), the key per-skill config uses. */
  skillName: string;
}

/**
 * Discover the plugin's own skills ONCE, resolving each one's declared name.
 *
 * Every later phase — the collision referee, the packager, and the tree-copy's
 * exclusion list — reads this one list, so "which directories under `skills/` are
 * skills" has exactly one answer per build. Two independent listings is the shape
 * that previously let a directory be excluded by one phase and skipped by the
 * other, shipping NOWHERE with no diagnostic.
 *
 * {@link listPluginSourceSkillDirs} supplies the directories: recursive (a nested
 * `skills/<group>/<skill>/SKILL.md` is a skill Claude Code loads, so VAT packages
 * it) and filtered to the same git-visible file set the tree-copy sees (a
 * gitignored/untracked skill dir must not be published by one producer when the
 * other would never have shipped it).
 */
async function discoverPluginLocalSkills(
  pluginSourceDir: string,
  logger: ReturnType<typeof createLogger>,
): Promise<PluginLocalSkill[]> {
  // Git visibility is the right filter, but a SILENT drop is not: a skill the author
  // just created and has not `git add`ed is simply absent from the built plugin, and
  // a build that says "success" while omitting it reads as one that shipped it.
  // Gitignored dirs are excluded from this list — ignoring one IS the instruction.
  for (const dir of listUntrackedPluginSkillDirs(pluginSourceDir)) {
    logger.info(
      `warning: skills/${dir}/SKILL.md exists but is not tracked by git, so it was NOT packaged ` +
        `into this plugin (the plugin build ships tracked files only). Run \`git add\` on it, or ` +
        `add it to .gitignore to silence this.`,
    );
  }
  const skills: PluginLocalSkill[] = [];
  for (const skillDirPath of listPluginSourceSkillDirs(pluginSourceDir)) {
    const skillPath = safePath.join(pluginSourceDir, 'skills', skillDirPath, 'SKILL.md');
    // Resolved through the SAME reader `vat skills build` uses — per-skill config is
    // keyed by name, so two answers would mean two effective configs.
    const skillName = await readSkillName(skillPath) ?? lastPathSegment(skillDirPath);
    skills.push({ skillDirPath, skillPath, skillName });
  }
  return skills;
}

/** Trailing segment of a skill dir path (`group/nested` → `nested`). */
function lastPathSegment(dirPath: string): string {
  return basename(dirPath);
}

/**
 * PACKAGE each plugin-local skill (a skill living in the plugin's own `skills/`
 * source tree) with the SAME packager that produces pool skills.
 *
 * This is the "one production path" rule. A plugin-local skill used to be
 * tree-copied VERBATIM — every byte in its source directory shipped, links were
 * never rewritten, and `files:` had to be re-applied separately because the
 * packager never ran. That produced a materially different artifact from the
 * pool path for the same kind of thing, and the difference was invisible: it
 * shipped eval suites (answer keys included), scratch files, and un-rewritten
 * links. The collision referee already conceded the point by preferring the
 * pool copy whenever both existed.
 *
 * Now both paths run `packageSkill`, so "what ships in a skill" has exactly one
 * answer: link-reachable resources plus declared `files:`, links rewritten,
 * declared test input excluded, post-build checks applied.
 *
 * `input.skills` is the already-refereed set: pool-sourced collisions have been
 * filtered out by {@link resolveCollidingSkills} and are copied in by Phase 3
 * instead. Returns each packaged skill's result for error reporting.
 *
 * The returned list is also the ONLY definition of "which dirs under `skills/` did
 * the packager produce": the tree-copy exclusion list is derived from it (see
 * Phase 2b in {@link buildPlugin}), so a directory absent from it is a directory
 * the tree-copy still ships.
 */
export async function packagePluginLocalSkills(input: {
  skills: readonly PluginLocalSkill[];
  pluginDir: string;
  skillsConfig: SkillsConfig | undefined;
  /**
   * THE project registry for this build, built once by {@link runClaudePluginBuild}.
   *
   * Not optional, and not defaulted: `packageSkill` silently falls back to
   * crawling and parsing every markdown file in the project when it gets no
   * registry, so an omission here costs one whole-project scan PER SKILL rather
   * than failing. That is exactly what this lane used to do.
   */
  registry: ResourceRegistry;
  /**
   * THE project's declared eval suites, assembled once by {@link runClaudePluginBuild}.
   *
   * Not optional, and not defaulted, for the same reason as `registry` above: an
   * omission would not fail, it would silently package one skill's bundle carrying
   * ANOTHER skill's eval answer key — the failure mode a default value hid the first
   * time this rule shipped.
   */
  projectSkills: readonly DeclaredEvalSuite[];
  logger: ReturnType<typeof createLogger>;
}): Promise<Array<{ skillDirPath: string; result: PackageSkillResult }>> {
  const packaged: Array<{ skillDirPath: string; result: PackageSkillResult }> = [];
  // KNOWN GAP — NO PER-SKILL CONTAINMENT. `packageSkill` reports most problems by
  // RETURNING a result whose `hasErrors` is set, but it THROWS on structural packaging
  // failures (filename collisions, unreadable sources). This loop awaits it bare, so one
  // throw escapes the whole plugin build and discards every skill packaged before it —
  // while the partial `skills/<dir>/` trees already written stay on disk, described by
  // nothing.
  //
  // This is the SAME defect, in the same shape, that `packageSkills` had until commit
  // ba140fae ("fix(skills): one unbuildable skill no longer discards the whole build").
  // Copy that fix: it wraps each iteration in try/catch and returns a
  // `SkillPackageOutcome` discriminated union (`built` | `failed`) carrying the error,
  // deliberately NOT a synthetic `PackageSkillResult` (which would have to invent
  // `outputPath`/`skill`/`files`, so consumers would report a file count for a bundle
  // that is not on disk).
  //
  // Why it matters concretely: a `vat build` on a 90-skill adopter (2026-07-30) hit 3
  // filename collisions across three separate skills and, thanks to `packageSkills`'
  // containment, still built the other 87. This lane would have thrown all 90 away.
  //
  // Note the containment this lane lacks is for a skill that THROWS, and a filename
  // collision no longer throws — it is a returned finding. The remaining throw paths
  // are an absent or unreadable `files:` source; do not use a collision as the fixture
  // when adding that guard, or the test will pass without the guard existing.
  for (const { skillDirPath, skillPath, skillName } of input.skills) {
    // Per-skill config is keyed by the skill's declared NAME; the directory path and
    // its trailing segment are fallbacks for the common cases where they coincide.
    // The fallback LIST must stay a superset of `vat verify`'s (checkFilesConfigDests
    // cannot read declared names, so it tries path-then-leaf): if verify resolved a
    // key the build did not, verify would check `files:` dests for a skill the build
    // was never told to copy them into, and fail a build that had in fact succeeded.
    const packagingConfig = mergeSkillPackagingConfig(
      input.skillsConfig?.defaults,
      input.skillsConfig?.config?.[skillName] ??
        input.skillsConfig?.config?.[skillDirPath] ??
        input.skillsConfig?.config?.[lastPathSegment(skillDirPath)],
    );

    const skillOutputDir = safePath.join(input.pluginDir, 'skills', skillDirPath);
    // KNOWN GAP — false ALLOW_UNUSED for plugin-local skills. If you are here, please
    // consider fixing it while the hood is open.
    //
    // This loop omits `allowLedger`, and omitting it is a positive claim that THIS
    // call is the whole run (see PackageSkillOptions.allowLedger). That claim is FALSE
    // here: we are looping. `validation.allow` is declared once per package but matched
    // once per skill, so an entry matched while packaging skill A is reported unused
    // while packaging skill B. `vat skills build` had exactly this bug and fixed it by
    // creating one ledger for the invocation, threading it through, and draining it
    // once after the last skill — see `runSkillBuild` in ../../skills/build.ts, which
    // is the model to copy.
    //
    // Why it is not fixed here: this lane has no channel for RUN-level issues in its
    // YAML output (every issue it reports is attributed to a skill dir), and inventing
    // a second reporting shape was worse than leaving one honest comment. Fixing this
    // properly means adding that channel first.
    //
    // Why it measures zero today: VAT's own plugins are assembled from the shared skill
    // pool by copy-in, so this loop packages nothing. A project with plugin-local
    // `skills/` directories AND package-scoped `validation.allow` entries still sees the
    // false warnings. This is also the last thing blocking a promotion of ALLOW_UNUSED
    // from `warning` to `error`, which would turn those false positives into hard build
    // failures.
    //
    // That promotion is now MEASURABLE rather than open-ended. On the 90-skill adopter
    // (2026-07-30) this lane's ledger drains to 17 unused allow entries, against 14 in
    // the `vat skills build` (`skills`) lane — so the work this comment gates is a
    // bounded 17-entry reconciliation, not an unbounded one. UNVERIFIED how much of the
    // 17 - 14 delta is the false-positive class described above versus genuinely dead
    // entries; nobody has classified them entry by entry.
    const result = await packageSkill(skillPath, {
      ...packagingConfigToPackageOptions(
        packagingConfig,
        { skillPath, outputPath: skillOutputDir },
        input.projectSkills,
      ),
      registry: input.registry,
    });
    input.logger.info(
      `         ${skillName} -> skills/${skillDirPath} (${formatPackagedFileCount(result)})`,
    );
    packaged.push({ skillDirPath, result });
  }
  return packaged;
}

/**
 * Summarize post-build issues for the plugin-local skills: the lines to print,
 * the dirs that emitted errors, and the per-severity distribution.
 *
 * Mirrors `vat skills build`: a skill whose packaged output fails validation
 * fails the build, so the two lanes hold the same bar, and they now render
 * findings through the same helper — this lane used to label every non-error
 * severity `[WARNING]`, so `info` findings were reported as warnings, and it
 * read only `postBuildIssues`, so a skill failing purely on the built-output
 * validation aborted the plugin build with no issue text at all.
 *
 * `verbose` governs the RENDERED lines and nothing else: `withErrors` (what the
 * caller fails the plugin on) and `issueCounts` (what stdout publishes) are
 * computed from the whole set at every verbosity, so quieting the report cannot
 * quiet the gate. Per the shared policy in `issuesToRenderAtVerbosity`, errors
 * always get a full block; warnings and info collapse into the per-skill heading
 * above them, which still names the complete severity breakdown.
 *
 * Pure so the whole rendered set is assertable.
 */
export function summarizePackagedSkillIssues(
  packaged: Array<{ skillDirPath: string; result: PackageSkillResult }>,
  verbose: boolean,
): { lines: string[]; withErrors: string[]; issueCounts: SeverityCounts } {
  const lines: string[] = [];
  const withErrors: string[] = [];
  const perSkillCounts: SeverityCounts[] = [];

  for (const { skillDirPath, result } of packaged) {
    const issues = collectPostBuildIssues(result);
    perSkillCounts.push(countBySeverity(issues));
    if (issues.length > 0) {
      lines.push(`         ${skillDirPath}: ${formatIssueSetHeading(issues, 'post-build')}`);
      for (const issue of issuesToRenderAtVerbosity(issues, verbose)) {
        lines.push(...formatIssueLines(issue, '         '));
      }
    }
    if (result.hasErrors) withErrors.push(skillDirPath);
  }

  return { lines, withErrors, issueCounts: sumSeverityCounts(perSkillCounts) };
}

/** Print the summary to stderr and return what the caller gates on. */
function reportPackagedSkillIssues(
  packaged: Array<{ skillDirPath: string; result: PackageSkillResult }>,
  logger: ReturnType<typeof createLogger>,
  verbose: boolean,
): { withErrors: string[]; issueCounts: SeverityCounts } {
  const { lines, withErrors, issueCounts } = summarizePackagedSkillIssues(packaged, verbose);
  for (const line of lines) {
    logger.info(line);
  }
  return { withErrors, issueCounts };
}

/**
 * Turn the tree-copy's dead `exclude:` patterns into located, coded findings.
 *
 * Built through `materializeIssue` so severity / fix / reference come from
 * `CODE_REGISTRY` — the same construction site every other producer uses, which
 * is what keeps docs, runtime, and tests from drifting.
 *
 * `location` is the plugin SOURCE dir in project-relative coordinates: that is
 * the tree the pattern failed to match, and the four-anchor contract requires a
 * path the reader can open. The pattern itself travels in `detail` (the message)
 * because it is not a path — a pattern is not openable and does not belong in
 * `location` or `link`.
 */
function unusedExcludeIssues(
  unusedExcludePatterns: readonly string[],
  configDir: string,
  pluginSourceDir: string,
): ValidationIssue[] {
  const sourceRel = toForwardSlash(safePath.relative(configDir, pluginSourceDir));
  return unusedExcludePatterns.map((pattern) =>
    materializeIssue('PLUGIN_EXCLUDE_PATTERN_UNUSED', {
      location: sourceRel,
      detail: `'${pattern}' under ${sourceRel}`,
    }),
  );
}

/**
 * Print the plugin-level findings to stderr and return their severity counts.
 *
 * Rendered IN FULL at every verbosity — `issuesToRenderAtVerbosity(…, true)` —
 * rather than collapsing warnings into the heading. The verbosity collapse
 * exists for high-cardinality per-file findings (one adopter skill carries 348
 * of one code); these are bounded by the number of `exclude:` entries the author
 * wrote, and each names a specific line of their config. Collapsing them would
 * reproduce the exact silence this reporting path was added to remove. The
 * shared helper is still what decides it, so `ignore` (an adopter's
 * `validation.allow`) is honored here like everywhere else.
 */
function reportPluginIssues(
  issues: readonly ValidationIssue[],
  logger: ReturnType<typeof createLogger>,
): SeverityCounts {
  if (issues.length > 0) {
    logger.info(`         plugin: ${formatIssueSetHeading(issues)}`);
    for (const issue of issuesToRenderAtVerbosity(issues, true)) {
      for (const line of formatIssueLines(issue, '         ')) {
        logger.info(line);
      }
    }
  }
  return countBySeverity(issues);
}

/** A plugin-local skill and the pool skill whose output directory it would overwrite. */
interface SkillDirConflict {
  skill: PluginLocalSkill;
  poolSkillFsPath: string;
}

/**
 * Split the plugin's own skills into those that COLLIDE with its resolved pool
 * selector and those that do not. A colliding skill would otherwise be produced
 * twice — once by the local packager, once by the Phase 3 pool copy-in — putting
 * two definitions of the same skill in one plugin.
 *
 * Matched on the DECLARED NAME, and ONLY the declared name. Name is what makes two
 * copies the same skill: a skill named `foo` authored in `skills/bar/` collides
 * with pool `foo` just as surely as one in `skills/foo/`, and a NESTED skill
 * (`skills/group/foo/`) collides too even though its directory path shares no
 * segment with the pool copy's `skills/foo/`. A dirname-only comparison missed all
 * of those, and the nested case shipped the skill twice, at two depths, in one plugin.
 *
 * The directory leaf is deliberately NOT also matched. It adds nothing (when a
 * skill's `SKILL.md` declares no name, {@link discoverPluginLocalSkills} already
 * falls back to that leaf, so the name comparison covers it) and it over-matches:
 * a plugin-local skill named `bar` living in `skills/foo/`, in a plugin that selects
 * an unrelated pool skill `foo`, was refereed away as if it were the pool's `foo` —
 * so `bar` was neither packaged nor tree-copied and shipped NOWHERE, under a warning
 * claiming a skill named `bar` had been "selected from the pool".
 *
 * `conflicts` is the residue that name-matching alone cannot resolve: a
 * non-colliding plugin-local skill whose authored directory is the same directory a
 * selected pool skill copies into. Two DIFFERENT skills, one output dir — the
 * packager and the Phase 3 copy would write over each other. There is no correct
 * winner, so the caller fails the build instead of silently picking one.
 */
function resolveCollidingSkills(
  skills: readonly PluginLocalSkill[],
  selectedSkillNames: string[],
): { colliding: PluginLocalSkill[]; packageable: PluginLocalSkill[]; conflicts: SkillDirConflict[] } {
  const selectedFsNames = new Set(selectedSkillNames.map((name) => skillNameToFsPath(name)));
  const colliding: PluginLocalSkill[] = [];
  const packageable: PluginLocalSkill[] = [];
  const conflicts: SkillDirConflict[] = [];
  for (const skill of skills) {
    if (selectedFsNames.has(skillNameToFsPath(skill.skillName))) {
      colliding.push(skill);
      continue;
    }
    packageable.push(skill);
    const clash = [...selectedFsNames].find(
      (fsName) =>
        toForwardSlash(skill.skillDirPath) === fsName ||
        toForwardSlash(skill.skillDirPath).startsWith(`${toForwardSlash(fsName)}/`),
    );
    if (clash !== undefined) conflicts.push({ skill, poolSkillFsPath: clash });
  }
  return { colliding, packageable, conflicts };
}

interface BuildPluginInput {
  marketplaceName: string;
  pluginDef: ClaudeMarketplacePluginEntry;
  marketplaceAvailable: string[];
  configDir: string;
  skillsConfig: SkillsConfig | undefined;
  owner: ClaudeMarketplaceConfig['owner'];
  rootVersion: string | undefined;
  /** THE project registry, built once per run (see runClaudePluginBuild). */
  registry: ResourceRegistry;
  /** THE project's declared eval suites, assembled once per run (same reason). */
  projectSkills: readonly DeclaredEvalSuite[];
  logger: ReturnType<typeof createLogger>;
  /** Render every finding, not just the errors (stderr only). */
  verbose: boolean;
}

async function buildPlugin(input: BuildPluginInput): Promise<PluginBuildResult> {
  const { marketplaceName, pluginDef, marketplaceAvailable, configDir, skillsConfig, owner, rootVersion, registry, projectSkills, logger, verbose } =
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

  // Phase 1.4: discover the plugin's own skills ONCE (recursive; git-visible only),
  // resolving each declared name. Every phase below reads this list.
  const localSkills = pluginSourceExists
    ? await discoverPluginLocalSkills(pluginSourceDir, logger)
    : [];

  // Phase 1.5: collision referee. Resolve the plugin's pool selector BEFORE the
  // tree-copy so a skill present in BOTH the plugin's own skills/ tree AND the
  // resolved pool selector is sourced from exactly one place. Both copies are now
  // packager output, so the referee is no longer about "raw copy ships dead links"
  // — it is about not producing the same skill twice, at two depths, in one dir.
  const selectedSkillNames = resolvePluginSkills(pluginDef, marketplaceAvailable);
  const { colliding: collidingSkills, packageable, conflicts } = resolveCollidingSkills(
    localSkills,
    selectedSkillNames,
  );
  if (conflicts.length > 0) {
    const pluginSourceRel = toForwardSlash(safePath.relative(configDir, pluginSourceDir));
    throw new Error(
      `Plugin '${pluginDef.name}': two DIFFERENT skills claim the same output directory.\n` +
        conflicts
          .map(({ skill, poolSkillFsPath }) =>
            `  - skills/${skill.skillDirPath} holds the plugin-local skill "${skill.skillName}", ` +
            `but the plugin's skills: selector also copies a pool skill into skills/${poolSkillFsPath}.`,
          )
          .join('\n') +
        `\nRename the plugin-local directory under ${pluginSourceRel}/skills/, or drop the pool skill ` +
        `from this plugin's skills: selector. (Only a same-NAME collision has a winner — the pool copy; ` +
        `two different skills sharing one directory does not.)`,
    );
  }
  // The pool copy takes over the plugin-local skill's OWN authored directory (see
  // copyPoolSkills) so "a plugin-local skill ships at its authored path" holds
  // whether it was packaged locally or refereed to the pool.
  const poolDestOverrides = new Map(
    collidingSkills.map(({ skillName, skillDirPath }) => [skillName, skillDirPath]),
  );
  for (const { skillName, skillDirPath } of collidingSkills) {
    logger.info(
      `warning: skill "${skillName}" is selected from the pool AND present at ` +
        `${toForwardSlash(safePath.relative(configDir, pluginSourceDir))}/skills/${skillDirPath}/ — ` +
        `using the pool-packaged copy (dist/skills/${skillNameToFsPath(skillName)}) and not packaging ` +
        `the plugin-local copy. It ships at skills/${skillDirPath}, the path it was authored at.`,
    );
  }

  // Phase 2a: PACKAGE each non-colliding plugin-local skill with the same packager
  // that produces pool skills — one production path for skills (see
  // packagePluginLocalSkills). This subsumes the old separate files: application:
  // the packager owns files: semantics, so no lane re-implements them. Runs BEFORE
  // the tree-copy so the tree-copy's exclusion list can be derived from what this
  // actually produced.
  const packagedLocalSkills = await packagePluginLocalSkills({
    skills: packageable,
    pluginDir,
    skillsConfig,
    registry,
    projectSkills,
    logger,
  });
  const { withErrors: skillsWithErrors, issueCounts: localSkillCounts } =
    reportPackagedSkillIssues(packagedLocalSkills, logger, verbose);
  if (skillsWithErrors.length > 0) {
    throw new Error(
      `Plugin '${pluginDef.name}': ${skillsWithErrors.length} plugin-local skill(s) emitted ` +
        `post-build validation errors: ${skillsWithErrors.join(', ')}`,
    );
  }
  const localSkillsPackaged = packagedLocalSkills.length;

  // Phase 2b: tree copy of everything the other phases did NOT produce (commands,
  // hooks, agents, .mcp.json, root files), skipping .claude-plugin/ and respecting
  // .gitignore.
  //
  // The exclusion list is the set of `skills/<dir>` entries some OTHER phase
  // produces: the ones the packager just wrote (Phase 2a) plus the pool-sourced
  // collisions Phase 3 copies in. Both halves come from the SAME Phase 1.4
  // discovery, partitioned — never from a second listing of `skills/` — which is
  // what makes "excluded here" and "produced elsewhere" the same set by
  // construction. Two independent filters over the same directory would let a dir
  // be excluded by one and skipped by the other, and it would then ship NOWHERE,
  // with no diagnostic.
  //
  // What remains for the tree-copy is everything under `skills/` that is NOT a
  // skill: a `shared/` helper dir, `_templates/`, or the bare PARENT segment of a
  // nested skill (`skills/group/` when the skill is `skills/group/nested/`). A
  // directory holding a SKILL.md is never copied verbatim at any depth — that is
  // exactly how eval suites, scratch files, and un-rewritten links used to ship.
  const producedSkillDirs = [
    ...packagedLocalSkills.map(({ skillDirPath }) => skillDirPath),
    ...collidingSkills.map(({ skillDirPath }) => skillDirPath),
  ];
  const treeResult = pluginSourceExists
    ? await treeCopyPlugin({
        sourceDir: pluginSourceDir,
        destDir: pluginDir,
        excludeSkillDirs: producedSkillDirs,
        ...(pluginDef.exclude ? { exclude: pluginDef.exclude } : {}),
        warn: (m) => logger.info(`warning: ${m}`),
      })
    : {
        commandsCopied: 0,
        hooksCopied: 0,
        agentsCopied: 0,
        mcpCopied: 0,
        filesCopied: 0,
        // No source dir means the tree-copy never ran, so EVERY declared pattern
        // matched nothing. Reporting `[]` here would make the one configuration
        // in which `exclude:` is unambiguously dead the one configuration that
        // says nothing about it.
        unusedExcludePatterns: pluginDef.exclude ?? [],
      };

  // Plugin-level findings: they belong to the plugin, not to any one skill, and
  // they are summed into the SAME `issueCounts` the skills' findings land in.
  // Anything else republishes the bug: a build that changed what ships while its
  // machine-readable report said `warnings: 0`.
  const pluginIssueCounts = reportPluginIssues(
    unusedExcludeIssues(treeResult.unusedExcludePatterns, configDir, pluginSourceDir),
    logger,
  );

  // Phase 3: pool-skill copy-in (from dist/skills/ via the plugin's skills: selector).
  const skillsCopied = await copyPoolSkills(
    pluginDef,
    marketplaceAvailable,
    configDir,
    pluginDir,
    poolDestOverrides,
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

  const pluginAuthor = await writeMergedPluginJson(
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
    pluginAuthor,
    skillsCopied,
    commandsCopied: treeResult.commandsCopied,
    hooksCopied: treeResult.hooksCopied,
    agentsCopied: treeResult.agentsCopied,
    mcpCopied: treeResult.mcpCopied,
    treeFilesCopied: treeResult.filesCopied,
    explicitFilesCopied,
    localSkillsPackaged,
    issueCounts: sumSeverityCounts([localSkillCounts, pluginIssueCounts]),
  };
}
