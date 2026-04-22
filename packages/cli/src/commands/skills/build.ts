/**
 * Build skills from source into dist/skills/ during package build
 *
 * Reads skills config from vibe-agent-toolkit.config.yaml, discovers SKILL.md
 * files via include/exclude globs, reads frontmatter for skill names, merges
 * packaging config (schema defaults -> config defaults -> per-skill overrides),
 * validates, and packages into dist/skills/<name>/.
 */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';


import {
  detectSkillCollisions,
  mergeFilesConfig,
  packageSkills,
  validateSkillForPackaging,
  type PackageSkillResult,
  type PackagingValidationResult,
  type SkillBuildSpec,
  type SkillPackagingConfig,
  type SkillRef,
} from '@vibe-agent-toolkit/agent-skills';
import type { Target } from '@vibe-agent-toolkit/claude-marketplace';
import type {
  SkillPackagingConfig as ConfigSkillPackagingConfig,
  SkillsConfig,
} from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { handleCommandError } from '../../utils/command-error.js';
import { loadConfig } from '../../utils/config-loader.js';
import { type createLogger } from '../../utils/logger.js';
import { applyConfigVerdicts } from '../../utils/verdict-helpers.js';
import {
  verifyNoCaseCollidingPluginNames,
} from '../claude/plugin/plugin-validators.js';

import {
  filterSkillsByName,
  setupCommandContext,
  writeYamlHeader,
  type DiscoveredSkill,
} from './command-helpers.js';
import {
  discoverPluginLocalSkills,
  type PluginLocalSkill,
} from './plugin-skill-discovery.js';
import { discoverSkillsFromConfig } from './skill-discovery.js';

export interface SkillsBuildCommandOptions {
  skill?: string;
  dryRun?: boolean;
  debug?: boolean;
}

/**
 * Sanitize skill names with colon namespaces for filesystem paths.
 *
 * Skill names use colon-namespacing (e.g. "vibe-agent-toolkit:vat-audit") which is
 * valid in YAML/JSON but invalid as a directory name on Windows. Replace colons with
 * double-underscore -- unambiguous, reversible, and safe on all platforms.
 */
function skillNameToFsPath(name: string): string {
  return name.replaceAll(':', '__');
}

/**
 * Compute the output directory for a discovered skill.
 *
 * Plugin-local skills land in dist/plugins/<pluginOwner>/skills/<skill>/ so
 * that `vat claude plugin build` can stream them into the plugin bundle
 * without moving files around. Pool skills remain at dist/skills/<skill>/.
 */
function skillOutputDir(cwd: string, skill: DiscoveredSkill): string {
  const fsName = skillNameToFsPath(skill.name);
  return skill.pluginOwner
    ? safePath.resolve(cwd, 'dist', 'plugins', skill.pluginOwner, 'skills', fsName)
    : safePath.resolve(cwd, 'dist', 'skills', fsName);
}

export function createBuildCommand(): Command {
  const command = new Command('build');

  command
    .description('Build skills from config yaml (discovers SKILL.md files via globs)')
    .argument('[path]', 'Path to project directory (default: current directory)')
    .option('--skill <name>', 'Build specific skill only')
    .option('--dry-run', 'Preview build without creating files')
    .option('--debug', 'Enable debug logging')
    .action(buildCommand)
    .addHelpText(
      'after',
      `
Description:
  Discovers SKILL.md files using include/exclude globs from the skills
  section of vibe-agent-toolkit.config.yaml. Reads each SKILL.md's
  frontmatter to extract the skill name, merges packaging config
  (schema defaults -> config yaml defaults -> per-skill overrides),
  validates, and packages into dist/skills/<name>/.

Config Structure (vibe-agent-toolkit.config.yaml):
  version: 1
  skills:
    include: ["resources/skills/**/SKILL.md"]
    exclude: ["resources/skills/draft/**"]
    defaults:
      linkFollowDepth: 2
      resourceNaming: basename
    config:
      my-skill:
        linkFollowDepth: full
        validation:
          severity:
            LINK_TO_NAVIGATION_FILE: ignore
          allow:
            LINK_DROPPED_BY_DEPTH:
              - paths: ["docs/**"]
                reason: depth drop is intentional for large reference docs

Validation:
  Both pre-build and post-build checks use the unified validation framework.
  Override per-code severity (error/warning/ignore) or allow specific paths
  via validation.severity and validation.allow in vibe-agent-toolkit.config.yaml.
  See docs/validation-codes.md for all codes and their defaults.

Output:
  YAML summary -> stdout (for programmatic parsing)
  Build progress -> stderr (for human reading)

Exit Codes:
  0 - All skills built successfully (or dry-run preview)
  1 - One or more skills emitted validation errors
  2 - System error (config invalid, directory not found)

Example:
  $ vat skills build                    # Build all skills from config
`
    );

  return command;
}

/**
 * Display active validation errors
 */
function displayActiveErrors(
  validationResult: PackagingValidationResult,
  logger: ReturnType<typeof createLogger>
): void {
  if (validationResult.activeErrors.length > 0) {
    logger.error(`\n   Active errors (${validationResult.activeErrors.length}):`);
    for (const error of validationResult.activeErrors) {
      logger.error(`     [${String(error.code)}] ${String(error.message)}`);
      if (error.location) {
        logger.error(`       Location: ${String(error.location)}`);
      }
      if (error.fix) {
        logger.error(`       Fix: ${String(error.fix)}`);
      }
    }
  }
}

/**
 * Display expired allow warnings
 */
function displayExpiredAllowEntries(
  validationResult: PackagingValidationResult,
  logger: ReturnType<typeof createLogger>
): void {
  const expiredWarnings = validationResult.activeWarnings.filter(w => w.code === 'ALLOW_EXPIRED');
  if (expiredWarnings.length > 0) {
    logger.error(`\n   Expired allow entries (${expiredWarnings.length}):`);
    for (const warn of expiredWarnings) {
      logger.error(`     ${String(warn.message)}`);
    }
  }
}

/**
 * Log post-build integrity issues, prefixed by resolved severity.
 *
 * Errors are emitted to stderr; warnings and info to stderr as well so they
 * appear in the human-readable stream (not the YAML stdout stream).
 */
function logPostBuildIssues(
  result: PackageSkillResult,
  logger: ReturnType<typeof createLogger>,
): void {
  if (!result.postBuildIssues || result.postBuildIssues.length === 0) return;
  const label = result.hasErrors ? 'post-build error(s)' : 'post-build warning(s)';
  logger.info(`   ${result.postBuildIssues.length} ${label}:`);
  for (const issue of result.postBuildIssues) {
    const prefix = issue.severity === 'error' ? 'ERROR' : 'WARNING';
    logger.info(`     [${prefix}] [${String(issue.code)}] ${String(issue.message)}`);
    if (issue.location) {
      logger.info(`       Location: ${String(issue.location)}`);
    }
    if (issue.fix) {
      logger.info(`       Fix: ${String(issue.fix)}`);
    }
  }
}

/**
 * Display allowed issues for context
 */
function displayIgnoredErrors(
  validationResult: PackagingValidationResult,
  logger: ReturnType<typeof createLogger>
): void {
  if (validationResult.ignoredErrors.length > 0) {
    logger.info(`\n   Allowed issues (${validationResult.ignoredErrors.length}):`);
    for (const record of validationResult.ignoredErrors) {
      logger.info(`     [${String(record.code)}] ${String(record.location)} (allowed: ${record.reason})`);
    }
  }
}

/**
 * Merge packaging config: schema defaults -> config yaml defaults -> per-skill overrides.
 *
 * Uses shallow merge (spread) since all SkillPackagingConfig fields are top-level.
 * The excludeReferencesFromBundle and validation fields are objects,
 * but per-skill overrides should fully replace (not deep-merge) the defaults for those fields.
 */
function mergePackagingConfig(
  defaults: ConfigSkillPackagingConfig | undefined,
  perSkill: ConfigSkillPackagingConfig | undefined,
): SkillPackagingConfig {
  const merged = {
    ...defaults,
    ...perSkill,
  };

  // Strip undefined values to satisfy exactOptionalPropertyTypes.
  // Spread of optional Zod-inferred types can produce explicit `undefined` values
  // which are not assignable to optional-but-not-undefined properties.
  const result: SkillPackagingConfig = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }

  // Special merge for files: additive with per-skill dest override
  if (defaults?.files !== undefined || perSkill?.files !== undefined) {
    const mergedFiles = mergeFilesConfig(defaults?.files, perSkill?.files);
    if (mergedFiles.length > 0) {
      (result as Record<string, unknown>)['files'] = mergedFiles;
    }
  }

  return result;
}

/**
 * Validate skill before building
 */
async function validateSkillOrExit(
  skillName: string,
  sourcePath: string,
  packagingConfig: SkillPackagingConfig,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  logger.debug(`   Validating skill: ${skillName}`);

  const validationResult = await validateSkillForPackaging(sourcePath, packagingConfig);
  applyConfigVerdicts(
    validationResult,
    packagingConfig.targets as readonly Target[] | undefined,
    sourcePath,
  );

  if (validationResult.status !== 'error') {
    if (validationResult.ignoredErrors.length > 0) {
      logger.debug(`   ${validationResult.ignoredErrors.length} issue(s) allowed by config`);
    }
    return;
  }

  // Validation failed - display all errors and exit
  logger.error(`\nSkill validation failed: ${skillName}`);
  logger.error(`   Source: ${sourcePath}`);

  displayActiveErrors(validationResult, logger);
  displayExpiredAllowEntries(validationResult, logger);
  displayIgnoredErrors(validationResult, logger);

  logger.error(`\n   Build aborted due to validation errors`);
  process.exit(1);
}

/**
 * Output dry-run results
 */
function skillOutputRelPath(skill: DiscoveredSkill): string {
  const fsName = skillNameToFsPath(skill.name);
  return skill.pluginOwner
    ? `dist/plugins/${skill.pluginOwner}/skills/${fsName}`
    : `dist/skills/${fsName}`;
}

function outputDryRunYaml(
  skills: DiscoveredSkill[],
  duration: number
): void {
  writeYamlHeader({
    status: 'success',
    dryRun: true,
    skillsFound: skills.length,
  });
  process.stdout.write(`skills:\n`);
  for (const skill of skills) {
    process.stdout.write(`  - name: ${skill.name}\n`);
    process.stdout.write(`    source: ${skill.sourcePath}\n`);
    process.stdout.write(`    output: ${skillOutputRelPath(skill)}\n`);
  }
  process.stdout.write(`duration: ${duration}ms\n`);
}

/**
 * Perform dry-run preview
 */
function performDryRun(
  skillsToBuild: DiscoveredSkill[],
  duration: number,
  logger: ReturnType<typeof createLogger>
): void {
  logger.info(`Dry-run: Analyzing skill build...`);
  logger.info(`   Skills to build: ${skillsToBuild.length}`);

  logger.info(`\nSkills:`);
  for (const skill of skillsToBuild) {
    logger.info(`   ${skill.name}`);
    logger.info(`      Source: ${skill.sourcePath}`);
    logger.info(`      Output: ${skillOutputRelPath(skill)}`);
  }

  outputDryRunYaml(skillsToBuild, duration);

  logger.info(`\nDry-run complete (no files created)`);
  logger.info(`   Run without --dry-run to build the skills`);
}

/**
 * Output build results
 */
function outputBuildYaml(
  results: Array<{ name: string; result: PackageSkillResult }>,
  duration: number
): void {
  writeYamlHeader({
    status: 'success',
    skillsBuilt: results.length,
  });
  process.stdout.write(`skills:\n`);
  for (const { name, result } of results) {
    process.stdout.write(`  - name: ${name}\n`);
    process.stdout.write(`    outputPath: ${result.outputPath}\n`);
    process.stdout.write(`    filesPackaged: ${result.files.dependencies.length + 1}\n`);
  }
  process.stdout.write(`duration: ${duration}ms\n`);
}

interface CleanStaleOptions {
  skillName?: string;
  declaredPlugins: string[];
}

async function removeIfExists(dir: string): Promise<boolean> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved path
  if (!existsSync(dir)) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

/**
 * Clean stale skill output directories before building.
 *
 * Full build: clear dist/skills/ and dist/plugins/<p>/skills/ for every declared plugin.
 * Single skill with `<plugin>/<skill>`: clear only that plugin-local output dir.
 * Single short name: clear dist/skills/<name>/ and every dist/plugins/<p>/skills/<name>/
 * that exists; warn if more than one matches (ambiguous).
 */
async function cleanStaleSkillOutputs(
  cwd: string,
  options: CleanStaleOptions,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const { skillName, declaredPlugins } = options;

  if (!skillName) {
    await removeIfExists(safePath.resolve(cwd, 'dist', 'skills'));
    for (const plugin of declaredPlugins) {
      await removeIfExists(safePath.resolve(cwd, 'dist', 'plugins', plugin, 'skills'));
    }
    return;
  }

  const slashIndex = skillName.indexOf('/');
  if (slashIndex >= 0) {
    const pluginName = skillName.slice(0, slashIndex);
    const localName = skillName.slice(slashIndex + 1);
    if (pluginName && localName) {
      await removeIfExists(
        safePath.resolve(cwd, 'dist', 'plugins', pluginName, 'skills', skillNameToFsPath(localName)),
      );
    }
    return;
  }

  const matches: string[] = [];
  const poolDir = safePath.resolve(cwd, 'dist', 'skills', skillNameToFsPath(skillName));
  if (await removeIfExists(poolDir)) matches.push('pool');
  for (const plugin of declaredPlugins) {
    const pluginDir = safePath.resolve(
      cwd,
      'dist',
      'plugins',
      plugin,
      'skills',
      skillNameToFsPath(skillName),
    );
    if (await removeIfExists(pluginDir)) matches.push(plugin);
  }
  if (matches.length > 1) {
    const pluginOnly = matches.filter((m) => m !== 'pool');
    logger.info(
      `warning: Ambiguous --skill ${skillName}: matched pool skill AND plugin-local skill(s) in [${pluginOnly.join(', ')}]. ` +
        `Use --skill <plugin>/<name> to disambiguate.`,
    );
  }
}

interface DeclaredPlugin {
  name: string;
  source?: string;
  skills?: '*' | string[];
}

function collectDeclaredPlugins(
  config: ReturnType<typeof loadConfig>,
): DeclaredPlugin[] {
  const plugins: DeclaredPlugin[] = [];
  const marketplaces = config?.claude?.marketplaces;
  if (!marketplaces) return plugins;
  for (const marketplace of Object.values(marketplaces)) {
    for (const plugin of marketplace.plugins) {
      const entry: DeclaredPlugin = { name: plugin.name };
      if (plugin.source !== undefined) entry.source = plugin.source;
      if (plugin.skills !== undefined) entry.skills = plugin.skills;
      plugins.push(entry);
    }
  }
  return plugins;
}

function resolveSelectedPoolNames(
  selector: '*' | string[] | undefined,
  pool: readonly DiscoveredSkill[],
): Set<string> {
  if (selector === '*') return new Set(pool.map((s) => s.name));
  if (Array.isArray(selector)) return new Set(selector);
  return new Set<string>();
}

/**
 * Detect pool-vs-local skill collisions within each plugin's selection set.
 *
 * Spec §Design → Skill stream: "Only a pool-vs-local collision within the same
 * plugin's selection set is an error." Filter pool refs to only those pool skills
 * the plugin actually selects (via `skills: "*"`, array, or omission).
 */
function enforcePluginSkillCollisions(
  declaredPlugins: readonly DeclaredPlugin[],
  pool: readonly DiscoveredSkill[],
  pluginLocal: readonly PluginLocalSkill[],
): void {
  for (const plugin of declaredPlugins) {
    const pluginLocals = pluginLocal.filter((s) => s.plugin === plugin.name);
    const selectedPoolNames = resolveSelectedPoolNames(plugin.skills, pool);

    const poolRefs: SkillRef[] = pool
      .filter((s) => selectedPoolNames.has(s.name))
      .map((s) => ({
        name: s.name,
        origin: 'pool',
        sourcePath: s.sourcePath,
      }));
    const localRefs: SkillRef[] = pluginLocals.map((s) => ({
      name: s.name,
      origin: 'plugin-local',
      plugin: s.plugin,
      sourcePath: s.sourcePath,
    }));

    const collisions = detectSkillCollisions([...poolRefs, ...localRefs]);
    if (collisions.length > 0) {
      throw new Error(collisions.map((c) => c.message).join('\n'));
    }
  }
}

async function discoverAllSkills(
  skillsConfig: SkillsConfig,
  config: NonNullable<ReturnType<typeof loadConfig>>,
  cwd: string,
  logger: ReturnType<typeof createLogger>,
): Promise<{ all: DiscoveredSkill[]; declaredPlugins: DeclaredPlugin[] }> {
  logger.info(`Discovering skills from config...`);
  const discoveredSkills = await discoverSkillsFromConfig(skillsConfig, cwd);

  const declaredPlugins = collectDeclaredPlugins(config);
  verifyNoCaseCollidingPluginNames(declaredPlugins.map((p) => p.name));

  const sourceOverrides: Record<string, string> = {};
  for (const plugin of declaredPlugins) {
    if (plugin.source) sourceOverrides[plugin.name] = plugin.source;
  }

  const pluginLocal = await discoverPluginLocalSkills({
    projectRoot: cwd,
    pluginNames: declaredPlugins.map((p) => p.name),
    sourceOverrides,
    warn: (m) => logger.info(`warning: ${m}`),
  });

  enforcePluginSkillCollisions(declaredPlugins, discoveredSkills, pluginLocal);

  const pluginSkillsAsDiscovered: DiscoveredSkill[] = pluginLocal.map((p) => ({
    name: p.name,
    sourcePath: p.sourcePath,
    pluginOwner: p.plugin,
  }));
  return { all: [...discoveredSkills, ...pluginSkillsAsDiscovered], declaredPlugins };
}

async function validateAndBuild(
  skillsToBuild: DiscoveredSkill[],
  skillsConfig: SkillsConfig,
  cwd: string,
  logger: ReturnType<typeof createLogger>,
): Promise<Array<{ name: string; result: PackageSkillResult }>> {
  const validatedSpecs: Array<{
    skill: DiscoveredSkill;
    packagingConfig: SkillPackagingConfig;
  }> = [];

  for (const skill of skillsToBuild) {
    const packagingConfig = mergePackagingConfig(
      skillsConfig.defaults,
      skillsConfig.config?.[skill.name],
    );
    const outputDir = skillOutputDir(cwd, skill);
    logger.info(`\nBuilding skill: ${skill.name}`);
    logger.info(`   Source: ${skill.sourcePath}`);
    logger.info(`   Output: ${outputDir}`);
    await validateSkillOrExit(skill.name, skill.sourcePath, packagingConfig, logger);
    validatedSpecs.push({ skill, packagingConfig });
  }

  const specs: SkillBuildSpec[] = validatedSpecs.map(({ skill, packagingConfig }) => ({
    skillPath: skill.sourcePath,
    options: {
      outputPath: skillOutputDir(cwd, skill),
      formats: ['directory' as const],
      rewriteLinks: true,
      basePath: dirname(skill.sourcePath),
      ...(packagingConfig.resourceNaming && { resourceNaming: packagingConfig.resourceNaming }),
      ...(packagingConfig.stripPrefix && { stripPrefix: packagingConfig.stripPrefix }),
      ...(packagingConfig.linkFollowDepth !== undefined && {
        linkFollowDepth: packagingConfig.linkFollowDepth,
      }),
      ...(packagingConfig.excludeReferencesFromBundle && {
        excludeReferencesFromBundle: packagingConfig.excludeReferencesFromBundle,
      }),
      ...(packagingConfig.files && { files: packagingConfig.files }),
      ...(packagingConfig.validation && { validation: packagingConfig.validation }),
    },
  }));

  const packageResults = await packageSkills(specs, cwd);

  const results: Array<{ name: string; result: PackageSkillResult }> = [];
  const skillsWithErrors: string[] = [];
  for (const [i, spec] of validatedSpecs.entries()) {
    const result = packageResults[i];
    if (!result) continue;
    logger.info(`   Built ${result.files.dependencies.length + 1} files`);
    logPostBuildIssues(result, logger);
    if (result.hasErrors) skillsWithErrors.push(spec.skill.name);
    results.push({ name: spec.skill.name, result });
  }

  if (skillsWithErrors.length > 0) {
    logger.error(
      `\nBuild failed: ${skillsWithErrors.length} skill(s) emitted post-build validation errors`,
    );
    for (const name of skillsWithErrors) {
      logger.error(`   - ${name}`);
    }
    // Emit results first so callers can still see the YAML.
    return results;
  }

  return results;
}

async function buildCommand(
  pathArg: string | undefined,
  options: SkillsBuildCommandOptions
): Promise<void> {
  const { logger, cwd, startTime } = setupCommandContext(pathArg, options.debug);

  try {
    // Load config yaml from cwd (not workspace root — config lives next to the package)
    const config = loadConfig(cwd);

    if (!config?.skills) {
      logger.info('No skills configuration found — nothing to build');
      process.exit(0);
    }

    const skillsConfig = config.skills;
    const { all: allDiscoveredSkills, declaredPlugins } = await discoverAllSkills(
      skillsConfig,
      config,
      cwd,
      logger,
    );

    if (allDiscoveredSkills.length === 0) {
      throw new Error(
        `No SKILL.md files found matching include patterns: ${skillsConfig.include.join(', ')}`
      );
    }

    // Filter by skill name if specified
    const skillsToBuild = filterSkillsByName(allDiscoveredSkills, options.skill);

    logger.info(`Found ${skillsToBuild.length} skill(s) to build`);

    if (!options.dryRun) {
      const cleanOptions: CleanStaleOptions = {
        declaredPlugins: declaredPlugins.map((p) => p.name),
      };
      if (options.skill !== undefined) cleanOptions.skillName = options.skill;
      await cleanStaleSkillOutputs(cwd, cleanOptions, logger);
    }

    // Handle dry-run mode
    if (options.dryRun) {
      const duration = Date.now() - startTime;
      performDryRun(skillsToBuild, duration, logger);
      process.exit(0);
    }

    const results = await validateAndBuild(skillsToBuild, skillsConfig, cwd, logger);
    const duration = Date.now() - startTime;

    outputBuildYaml(results, duration);

    const hadErrors = results.some((r) => r.result.hasErrors);
    if (hadErrors) {
      process.exit(1);
    }

    logger.info(`\nBuilt ${results.length} skill(s) successfully`);
    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'SkillsBuild');
  }
}
