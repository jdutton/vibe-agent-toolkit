/**
 * `vat claude plugin build` — assemble Claude plugin artifacts from plugins/<name>/
 *
 * Reads vibe-agent-toolkit.config.yaml → claude.marketplaces.
 * For each plugin, assembles the plugin bundle from its own plugins/<name>/ directory
 * (commands, hooks, agents, .mcp.json, skills/, .claude-plugin/plugin.json) and
 * imports pool skills (from dist/skills/) via the `skills:` selector.
 */

import { mkdir, readdir } from 'node:fs/promises';

import { conventionalSuiteProbe, createProjectRegistry, getMarketplaceOutputDir, getPluginSourceDir, isSkillPackagingInputError, listPluginSourceSkillDirs, listUntrackedPluginSkillDirs, materializeIssue, packageSkillInto, packagingConfigToPackageOptions, pluginDirInMarketplace, skillNameToFsPath, stagedPathMapper, type ConventionalSuiteProbe, type DeclaredEvalSuite, type PackageSkillResult } from '@vibe-agent-toolkit/agent-skills';
import type { ClaudeMarketplaceConfig, ClaudeMarketplacePluginEntry, ExternalPluginSource, ProjectConfig, ResourceRegistry, SkillsConfig } from '@vibe-agent-toolkit/resources';
import { buildReport, toFindings, type Finding, type Gate, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { applyTreePlan, writeFileUnder, compareCodeUnits, direntKindFollowing, everyInOrder, forEachInOrder, type FsSide, isSingleFsSegment, issueLocation, isTreeChangeResidue, mapInOrder, pathPresent, planTreeChanges, relativeEscapesRoot, safePath, toForwardSlash, VatError, withFsFault } from '@vibe-agent-toolkit/utils';
import { onCrawlOutput } from '@vibe-agent-toolkit/utils/crawl';
import { Command } from 'commander';

import { readPluginLocalSkillName } from '../../../commands/skills/skill-discovery.js';
import { CommandRefusalError, errorMessageOf, refusalCodeOf } from '../../../utils/command-refusal.js';
import { loadConfig } from '../../../utils/config-loader.js';
import { endWithReport, leftoverFindingsOf, leftoverIssue, NOTHING_FINISHED, refusalReport, type FinishedWork } from '../../../utils/document-writer.js';
import {
  collectPostBuildIssues,
  formatIssueLines,
  formatIssueSetHeading,
  formatPackagedFileCount,
  issuesToRenderAtVerbosity,
} from '../../../utils/issue-rendering.js';
import { createLogger } from '../../../utils/logger.js';
import { copyFileIntoMarketplace, copyTreeIntoMarketplace, writingMarketplace } from '../../../utils/marketplace-io.js';
import { readPackageJsonOrAbsent } from '../../../utils/package-json.js';
import { requireInputPath } from '../../../utils/project-root-policy.js';
import { withResourcePopulationSource } from '../../../utils/resource-loader.js';
import { collectDeclaredEvalSuites, mergeSkillPackagingConfig, pluginLocalSkillConfigEntry } from '../../../utils/skill-packaging-config.js';
import type { PhaseOutcome } from '../../phase-utils.js';
import { packagingFailedIssue } from '../../skills/build.js';
import { discoverSkillsFromConfig } from '../../skills/skill-discovery.js';
import { assertMarketplaceDeclared, loadClaudeProjectConfig } from '../claude-config.js';

import type { PluginBuildData } from './build-schema.js';
import { buildMarketplaceJson, type MarketplaceJsonPluginEntry } from './marketplace-json.js';
import { resolvePluginChangelogPath } from './plugin-changelog.js';
import { applyPluginFiles, foldedSegment } from './plugin-files.js';
import { mergePluginJson, resolveVersion } from './plugin-json-merge.js';
import {
  parsePluginJsonFiles,
  readAuthorPluginJson,
  verifyNoCaseCollidingPluginNames,
  verifyPluginDirCaseMatch,
} from './plugin-validators.js';
import { treeCopyPlugin, type TreeCopyResult } from './tree-copy.js';

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
  /**
   * Source-relative paths of the in-tree FILE symlinks the tree-copy resolved
   * and shipped BY CONTENT (each also counted in `treeFilesCopied`). Not in the
   * published report: it reaches programmatic callers of
   * {@link runClaudePluginBuild} through this result, and the operator through
   * one `<path> (symlink, copied by content)` stderr line per link — a bundle
   * is a plain tree, so the target's bytes travel under the link's name.
   * Always present (`[]` when there were none), like the other tree-copy facts.
   */
  symlinksCopied: string[];
  explicitFilesCopied: number;
  localSkillsPackaged: number;
  /**
   * Every finding for the WHOLE plugin: its plugin-local skills' post-build
   * findings PLUS plugin-level findings that belong to no skill (a dead
   * `exclude:` pattern, say). Published as the report's `findings`, so a
   * warning a built plugin shipped is named, not only counted.
   */
  issues: ValidationIssue[];
}

/**
 * A plugin whose plugin-local skills emitted error-severity post-build
 * findings. The build stops there, before the plugin is assembled: the findings
 * are published and fail the gate (exit 1) — a finding, never a crash.
 */
interface PluginGateFailure {
  /** The one sentence naming the plugin and the failing skills. */
  reason: string;
  /** Every finding the plugin's skills emitted, the failing ones included. */
  issues: ValidationIssue[];
}

/**
 * A plugin entry that references another marketplace/repo's plugin instead of
 * being built locally (`pluginDef.externalSource` is set). VAT never creates a
 * directory or writes a plugin.json for it — the empty-plugin guard, tree-copy,
 * skills packaging, and files[] mapping in {@link buildPlugin} all assume local
 * content, none of which applies here.
 */
export interface ExternalPluginBuildResult {
  pluginName: string;
  pluginVersion: string | undefined;
  source: ExternalPluginSource;
}

export interface MarketplaceBuildResult {
  name: string;
  /** The plugins assembled — all of them unless {@link MarketplaceBuildResult.gate} stopped the build. */
  plugins: PluginBuildResult[];
  /** Plugins referenced via `externalSource` — see {@link ExternalPluginBuildResult}. */
  externalPlugins: ExternalPluginBuildResult[];
  /** The plugin that failed the gate, when one did: the marketplace is then not replaced — the previous one stays. */
  gate: PluginGateFailure | undefined;
  /**
   * What the marketplace's plan made and could not remove — the previous marketplace parked by
   * the swap, a staged tree a gated build discarded — each the warning naming it.
   */
  residue: ValidationIssue[];
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

  A plugin entry with externalSource is REFERENCED, not built: no local dir,
  tree-copy, or skills packaging — its externalSource object (github/url/npm/pip)
  is emitted verbatim as that entry's marketplace.json source, so it resolves to
  wherever the other marketplace/repo actually publishes it. Use this to
  cherry-pick a plugin from one marketplace into another without vendoring it.

  Each marketplace is built whole beside dist/.claude/plugins/marketplaces/
  <marketplace> and swapped in once every plugin passed: a failure, or a plugin
  the post-build gate stops, leaves the previous marketplace exactly as it was.

Output structure:
  dist/.claude/plugins/marketplaces/<marketplace>/
    .claude-plugin/marketplace.json
    plugins/<plugin>/
      .claude-plugin/plugin.json
      skills/<skillName>/SKILL.md

Output:
  YAML report -> stdout: status (ok | findings | error), summary, examined
  (marketplaces built), findings (each with its location), and data:
  marketplacesBuilt, pluginsBuilt, pluginsReferenced, skillsPackaged, and
  marketplaces[] of { name, status, reason?, plugins[] { name, outputPath,
  skills }, externalPlugins[] }. Paths are relative to the directory holding
  vibe-agent-toolkit.config.yaml.
  Build progress -> stderr

  On stderr, each packaged skill's findings heading names the whole set and
  its severity breakdown, and errors are always printed in full beneath it.
  Warnings and info findings stay collapsed into that heading unless
  --verbose. The stdout report is NOT affected by --verbose: its findings
  are every finding at every verbosity.

Exit Codes:
  0 - Built; findings, if any, are warnings or info
  1 - An error-severity finding: a plugin-local skill failed the post-build
      gate (the build stops there — that marketplace is not replaced and
      nothing after it is built), or no marketplace is configured
      (RESOURCE_CHECK_BROKEN)
  2 - The build could not run (error.code): USAGE_INVALID (an undeclared
      --marketplace), CONFIG_INVALID (no config; an empty or colliding plugin
      declaration; an invalid files[].dest), INPUT_UNREADABLE (a plugin file
      that is not JSON, a pool skill or files[].source nothing built, a
      symlink no bundle can ship, a file the build copies -- LICENSE,
      README.md, CHANGELOG.md, a plugin file, a files[].source, a built skill
      in dist/skills -- that the OS will not read), RUN_INCOMPLETE (the packager refused a
      plugin-local skill's content, e.g. a skill files: source that does not
      exist — the SKILL_PACKAGING_FAILED finding names the skill — or the OS
      would not let the build write its output: a full disk, a read-only
      dist/; no finding). Known gap: a disk so full that the git snapshot
      of the project fails first is still INTERNAL_ERROR ("git did not
      answer ...").

Example:
  $ vat skills build && vat claude plugin build    # Build skills then wrap for Claude
`
    );

  return command;
}

/**
 * What `vat claude plugin build` writes in the project at `configDir`: every marketplace it
 * replaces lives under this one tree. The one definition — the build's own declaration of its
 * outputs, and what `vat build` tells its skills phase the run writes after it.
 */
export function pluginBuildOutput(configDir: string): string {
  return safePath.join(configDir, 'dist', '.claude', 'plugins', 'marketplaces');
}

/**
 * Which side of the run `dist/skills` — the pool skills this build copies in — is on. Under
 * `vat claude plugin build` it is an INPUT another build wrote (`source`: a refusal is fixed by
 * rebuilding it); under `vat build` the run's own skills phase wrote it, so it is one of the
 * run's outputs (`destination`). Asked of the run's ONE declaration of what it writes
 * (`onCrawlOutput`), never decided here a second way.
 */
function distSkillsSide(distSkillsDir: string, outputs: readonly string[]): FsSide {
  return onCrawlOutput(distSkillsDir, outputs) ? 'destination' : 'source';
}

/**
 * Discover available skill names by listing directories in dist/skills/.
 *
 * @param outputs - What the run writes (its one declaration), which decides `dist/skills`' side
 */
function discoverBuiltSkills(configDir: string, outputs: readonly string[]): Promise<string[]> {
  const skillsDir = safePath.join(configDir, 'dist', 'skills');

  // A probe or a listing the OS refuses is on dist/skills' side of the run (see `distSkillsSide`).
  const side = distSkillsSide(skillsDir, outputs);
  // The run's own output is "not built" only once `dist/` agrees; another build's is taken at the probe's word.
  if (!pathPresent(skillsDir, 'follow', side, side === 'destination' ? 'confirmed' : 'probe')) {
    return Promise.resolve([]);
  }

  return withFsFault({ side, origin: 'content', action: 'list the built skills', path: skillsDir }, async () => {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const kinds = await Promise.all(entries.map((entry) => direntKindFollowing(skillsDir, entry)));
    // A staged or parked tree a concurrent or killed `vat skills build` left beside a bundle is no skill.
    return entries.filter((entry, i) => kinds[i] === 'directory' && !isTreeChangeResidue(entry.name)).map((entry) => entry.name);
  });
}

/**
 * Build Claude plugin artifacts for a project — the non-exiting orchestration
 * core shared by the `vat claude plugin build` CLI action and `vat skill test`
 * (which builds a declared skill's owning marketplace before staging its dist).
 *
 * Pushes each marketplace into `built` as it finishes, so a caller whose catch
 * reads the same array publishes the marketplaces that finished before a throw.
 * A marketplace whose plugin failed the gate ({@link MarketplaceBuildResult.gate})
 * is pushed and ends the run. Never calls `process.exit` and never writes stdout.
 *
 * `configDir` is threaded in (the project root that holds
 * vibe-agent-toolkit.config.yaml), so callers that already know the root build
 * against it rather than re-discovering from cwd. `projectConfig` is the config
 * the caller already parsed from it, so the file is read (and any unknown-key
 * warning printed) once per run. `options.marketplace` restricts
 * the build to a single marketplace by name, and refuses a name the config does
 * not declare.
 *
 * `options.verbose` affects the stderr findings report ONLY (see
 * `summarizePackagedSkillIssues`); it changes nothing this function returns.
 */
async function buildClaudePluginMarketplaces(
  configDir: string,
  projectConfig: ProjectConfig | undefined,
  options: {
    marketplace?: string | undefined;
    logger: ReturnType<typeof createLogger>;
    verbose: boolean;
    /** What the RUN already wrote that this build reads (`vat build`: `dist/skills`); `[]` when it wrote nothing. */
    runOutputs: readonly string[];
  },
  built: MarketplaceBuildResult[],
): Promise<void> {
  const { logger, verbose } = options;
  // The run's ONE declaration of what it writes: the marketplaces this build replaces, and what the
  // run wrote before it. A fault on, in or above any of them is the destination's.
  const outputs = [pluginBuildOutput(configDir), ...options.runOutputs];

  const marketplaces = projectConfig?.claude?.marketplaces ?? {};
  assertMarketplaceDeclared(options.marketplace, Object.keys(marketplaces));
  if (Object.keys(marketplaces).length === 0) {
    return;
  }

  // Read version from root package.json — lowest-precedence fallback in the
  // per-plugin version chain (config > plugin.json > root). Used so Claude
  // Code caches by version instead of "unknown/" when no per-plugin version
  // is supplied.
  // No package.json: the version is omitted. One that is there and cannot be
  // read is refused by name — it used to be omitted too, which cached every
  // plugin under "unknown/" for a reason the build never printed.
  const rootPkg = readPackageJsonOrAbsent(safePath.join(configDir, 'package.json'));
  const rootVersion = typeof rootPkg?.['version'] === 'string' ? rootPkg['version'] : undefined;

  // Discover available skills from dist/skills/ for pool-to-plugin selectors
  const availableSkills = await discoverBuiltSkills(configDir, outputs);

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
  //
  // On the projection lane when this process selected it — the same selector,
  // store and ignore oracle `vat resources validate` uses. `createProjectRegistry`
  // re-applies its own markdown-only `include` to whatever the source offers, so
  // this is a change of COST, not of what the build sees.
  const sharedRegistry = await withResourcePopulationSource(
    { root: configDir },
    (populationSource) =>
      createProjectRegistry(configDir, {
        // What this run writes (see `outputs` above). A fault on, in or above it (the project
        // root included) is the destination's.
        outputs,
        ...(populationSource !== undefined && { populationSource }),
      }),
  );
  logger.debug(`Project registry: ${sharedRegistry.getAllResources().length} markdown resources (built once)`);

  // THE project's declared eval suites for this build, assembled ONCE and threaded
  // to every plugin-local skill. Test input never ships, and the rule is
  // project-wide: a file ANY skill declares as its eval suite is an answer key, so
  // a plugin-local skill's bundle must exclude the OTHER skills' suites too — not
  // just its own. Discovery is not free, hence once per run rather than per skill.
  // `'refuse'`: a bundle assembled around a directory discovery could not
  // list may ship another skill's answer key. The throw carries the classified
  // fault (a `source` listing), which the command publishes as the table says.
  const projectSkills = skillsConfig === undefined
    ? []
    : collectDeclaredEvalSuites(skillsConfig, await discoverSkillsFromConfig(skillsConfig, configDir, 'refuse'));
  logger.debug(`Project declared eval suites: ${projectSkills.length}`);

  // Once per run for the same reason, and it is the costlier half: resolving a skill's
  // test-input dirs probes the filesystem for a conventional eval suite under the
  // subject AND under every entry of `projectSkills`, so a probe rebuilt per skill is
  // O(S) per skill and O(S²) per run. Measured in the lane that shares this helper
  // (`vat resources validate`, 103-skill adopter): 10,815 `existsSync` calls over 103
  // distinct paths, half of that command's entire filesystem traffic.
  //
  // Run-scoped, never module-scoped: the answer is a filesystem snapshot, and a cache
  // outliving the run would keep answering for a tree that has since changed.
  const suiteProbe = conventionalSuiteProbe();

  const allPluginNames: string[] = [];
  for (const mp of Object.values(marketplaces)) {
    for (const p of mp.plugins) allPluginNames.push(p.name);
  }
  verifyNoCaseCollidingPluginNames(allPluginNames);

  // In order, stopping at the first gated marketplace: each writes its own tree
  // and the log reads marketplace by marketplace.
  await everyInOrder(Object.keys(marketplaces), async (name) => {
    // Skip if --marketplace filter specified and doesn't match
    if (options.marketplace && options.marketplace !== name) {
      return true;
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
      suiteProbe,
      outputs,
      logger,
      verbose,
    });
    built.push(result);
    return result.gate === undefined;
  });
}

/**
 * {@link buildClaudePluginMarketplaces} for a programmatic caller that only
 * wants the built tree: one result per marketplace built (empty when no
 * `claude.marketplaces` are configured), and a throw — carrying the gate's
 * reason — when a plugin failed the post-build gate, since there is then no
 * complete marketplace to stage from.
 */
export async function runClaudePluginBuild(
  configDir: string,
  options: {
    marketplace?: string;
    logger?: ReturnType<typeof createLogger>;
    verbose?: boolean;
    /** What the caller's run already wrote that this build reads (its `dist/skills`, when it built them); `[]` for none. */
    runOutputs: readonly string[];
  },
): Promise<MarketplaceBuildResult[]> {
  const built: MarketplaceBuildResult[] = [];
  await buildClaudePluginMarketplaces(
    configDir,
    loadConfig(configDir),
    { marketplace: options.marketplace, logger: options.logger ?? createLogger({}), verbose: options.verbose === true, runOutputs: options.runOutputs },
    built,
  );
  const gated = built.find((result) => result.gate !== undefined)?.gate;
  if (gated !== undefined) throw new Error(gated.reason);
  return built;
}

/** Plugin build has no `--strict`: warnings never fail it. */
const GATE: Gate = { strict: false };

/** Every finding the built marketplaces carry, the stopped plugin's included. */
function marketplaceIssues(result: MarketplaceBuildResult): ValidationIssue[] {
  return [...result.plugins.flatMap((plugin) => plugin.issues), ...(result.gate?.issues ?? []), ...result.residue];
}

/**
 * The report's `data` for the marketplaces built — paths relative to
 * `configDir`, the directory whose config the build read.
 */
function pluginBuildData(configDir: string, built: readonly MarketplaceBuildResult[]): PluginBuildData {
  const plugins = built.flatMap((result) => result.plugins);
  return {
    marketplacesBuilt: built.filter((result) => result.gate === undefined).length,
    pluginsBuilt: plugins.length,
    pluginsReferenced: built.flatMap((result) => result.externalPlugins).length,
    skillsPackaged: plugins.flatMap((plugin) => plugin.skillsCopied).length,
    marketplaces: built.map((result) => ({
      name: result.name,
      status: toFindings(marketplaceIssues(result)).length === 0 ? 'ok' : 'findings',
      ...(result.gate === undefined ? {} : { reason: result.gate.reason }),
      plugins: result.plugins.map((plugin) => ({
        name: plugin.pluginName,
        outputPath: toForwardSlash(safePath.relative(configDir, plugin.pluginDir)),
        skills: plugin.skillsCopied,
      })),
      // Referenced, not built — no output path. `source` is the same object
      // emitted verbatim into marketplace.json, so the report and the artifact
      // can never disagree about what a reference points at.
      externalPlugins: result.externalPlugins.map((plugin) => ({
        name: plugin.pluginName,
        ...(plugin.pluginVersion === undefined ? {} : { version: plugin.pluginVersion }),
        source: plugin.source,
      })),
    })),
  };
}

/**
 * The packager refused one plugin-local skill's own CONTENT — a `files:` source
 * that is not there, a bundled nested `SKILL.md`, a name that is no path segment.
 *
 * That is the project's to fix, so it is coded where it is caught: the run
 * stopped (`RUN_INCOMPLETE`) on a `SKILL_PACKAGING_FAILED` finding at the skill —
 * the refusal `vat skill test run` and `vat agent build` publish for the same
 * cause. An uncoded packager throw is not wrapped: it stays a defect.
 */
class SkillPackagingStop extends CommandRefusalError {
  /** The refused skill's `SKILL.md`, absolute. */
  readonly skillPath: string;

  constructor(cause: unknown, skillPath: string) {
    super('RUN_INCOMPLETE', errorMessageOf(cause), { cause });
    this.skillPath = skillPath;
  }
}

/**
 * `finished`, plus the `SKILL_PACKAGING_FAILED` finding a {@link SkillPackagingStop} stands for.
 *
 * @param finished - What the run finished before it stopped
 * @param error - What stopped it
 * @param configDir - The project root the finding's `location` is relative to, when known
 */
function withPackagingStop(finished: FinishedWork, error: unknown, configDir: string | undefined): FinishedWork {
  if (!(error instanceof SkillPackagingStop)) return finished;
  const relative = configDir === undefined ? undefined : issueLocation(error.skillPath, configDir);
  const location = relative === undefined || relativeEscapesRoot(relative) ? undefined : relative;
  return { ...finished, findings: [...finished.findings, ...toFindings([packagingFailedIssue(error.message, location, 'rebuild', error.cause)])] };
}

/** What the marketplaces built so far are, as the report or a refusal's finished work. */
function builtWork(configDir: string, built: readonly MarketplaceBuildResult[]): FinishedWork & { data: PluginBuildData; findings: Finding[] } {
  return {
    examined: built.length,
    findings: toFindings(built.flatMap(marketplaceIssues)),
    data: pluginBuildData(configDir, built),
  };
}

/**
 * Build every configured plugin marketplace and hand back the report — the
 * refusal branch when it could not run, carrying the marketplaces that
 * finished — printing it nowhere.
 *
 * ONE function for both lanes: `vat claude plugin build` publishes it with
 * `endWithReport`, and `vat build`'s `claude` phase (run only when
 * `claude.marketplaces` is configured) folds it. The report is the one BEFORE
 * the writer's run-integrity pass.
 */
export async function runClaudePluginBuildPhase(options: PluginBuildCommandOptions, runOutputs: readonly string[]): Promise<PhaseOutcome> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();
  const built: MarketplaceBuildResult[] = [];
  let configDir: string | undefined;

  try {
    const loaded = loadClaudeProjectConfig();
    configDir = loaded.configDir;
    // The config this lane already parsed is handed down, so the build reads it
    // once (and warns about an unknown key once).
    await buildClaudePluginMarketplaces(
      configDir,
      loaded.projectConfig,
      { marketplace: options.marketplace, logger, verbose: options.verbose === true, runOutputs },
      built,
    );
    const work = builtWork(configDir, built);
    return { report: buildReport({ ...work, gate: GATE, durationMs: Date.now() - startTime }) };
  } catch (error) {
    const finished = configDir === undefined || built.length === 0 ? NOTHING_FINISHED : builtWork(configDir, built);
    return { report: refusalReport(refusalCodeOf(error), error, GATE, withPackagingStop(finished, error, configDir)) };
  }
}

async function pluginBuildCommand(options: PluginBuildCommandOptions): Promise<void> {
  // This command offers no `--format`: the report is YAML.
  // On its own, this verb writes nothing before its marketplaces: `dist/skills` is an input.
  endWithReport('claude plugin build', (await runClaudePluginBuildPhase(options, [])).report, 'yaml');
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

  // In order: the log names the files in this order, and the first failed copy is the one reported.
  await forEachInOrder(['LICENSE', 'README.md', 'CHANGELOG.md'], async (file) => {
    const override = overrides[file];
    const srcPath = override ? safePath.join(configDir, override) : safePath.join(configDir, file);
    // Absent is skipped; a file the OS will not let the build examine refuses, never skipped as absent.
    if (pathPresent(srcPath, 'follow', 'source', 'probe')) {
      await copyFileIntoMarketplace(srcPath, { root: marketplaceDir, relative: file }, issueLocation(srcPath, configDir), issueLocation(safePath.join(marketplaceDir, file), configDir));
      if (override) {
        logger.info(`   ${file} (from publish.${file === 'README.md' ? 'readme' : 'changelog'}: ${override})`);
      } else {
        logger.info(`   ${file} (copied from project root)`);
      }
    }
  });
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
  /** The run's conventional-suite probe, created once beside `projectSkills`. */
  suiteProbe: ConventionalSuiteProbe;
  /** What the run writes — its one declaration (see `buildClaudePluginMarketplaces`). */
  outputs: readonly string[];
  logger: ReturnType<typeof createLogger>;
  /** Render every finding, not just the errors (stderr only). */
  verbose: boolean;
}

/**
 * Thrown from a marketplace's staging fill when a plugin failed the gate: the plan discards what
 * it staged, and the previous marketplace stays exactly as it was. One per marketplace.
 */
class MarketplaceNotEarned extends VatError {
  constructor(name: string) {
    super('PLUGIN_BUILD_NOT_EARNED', `marketplace ${name}: a plugin failed the gate, so the build does not replace the previous marketplace`);
  }
}

/**
 * Build ONE marketplace as one tree-change plan: a `replace` of
 * `dist/.claude/plugins/marketplaces/<name>` whose staged tree the whole build is written
 * into ({@link buildMarketplaceInto}). It lands only when every plugin passed the gate; a
 * failure anywhere — a refused write, a refused input, a gated plugin — leaves the previous
 * marketplace byte-equal (orphaned plugins of a previous build go with the swap).
 */
async function buildMarketplace(input: BuildMarketplaceInput): Promise<MarketplaceBuildResult> {
  const { name, configDir } = input;
  // The config schema already refuses a name that is not one path segment; this re-check keeps the
  // replace below from ever aiming outside dist/ if a caller skips it.
  if (!isSingleFsSegment(name)) {
    throw new CommandRefusalError('CONFIG_INVALID', `Marketplace name ${JSON.stringify(name)} is not a single path segment; rename it in vibe-agent-toolkit.config.yaml under claude.marketplaces.`);
  }
  const marketplaceDir = getMarketplaceOutputDir(configDir, name);
  const notEarned = new MarketplaceNotEarned(name);
  // A holder, not a `let`: the fill assigns it inside the plan, where flow analysis cannot see.
  const holder: { built?: MarketplaceBuildResult; staged?: string } = {};
  const plan = await planTreeChanges([{
    op: 'replace',
    dest: marketplaceDir,
    ownership: { kind: 'vat-state' },
    label: `marketplace ${name}`,
    fill: {
      from: 'write',
      write: async (staged) => {
        holder.staged = staged;
        holder.built = await buildMarketplaceInto(input, staged);
        if (holder.built.gate !== undefined) throw notEarned;
      },
    },
  }]);
  let residue: ValidationIssue[];
  try {
    residue = (await applyTreePlan(plan)).warnings.map(({ message, path }) => leftoverIssue(message, path));
  } catch (error: unknown) {
    if (error !== notEarned) throw error;
    residue = leftoverFindingsOf(error);
  }
  const { built, staged } = holder;
  // The plan resolves, or ends gated, only once its fill has run.
  if (built === undefined || staged === undefined) throw new Error(`plugin build: the plan for marketplace ${name} ended without building it`);
  return landedMarketplace(built, stagedPathMapper(configDir, staged, marketplaceDir), residue);
}

/** A marketplace built into its staged tree, every path it names re-anchored onto where it landed. */
function landedMarketplace(built: MarketplaceBuildResult, landedPath: (value: string) => string, residue: ValidationIssue[]): MarketplaceBuildResult {
  const landedIssues = (issues: readonly ValidationIssue[]): ValidationIssue[] =>
    issues.map((issue) => (issue.location === undefined ? issue : { ...issue, location: landedPath(issue.location) }));
  return {
    ...built,
    plugins: built.plugins.map((plugin) => ({ ...plugin, pluginDir: landedPath(plugin.pluginDir), issues: landedIssues(plugin.issues) })),
    gate: built.gate === undefined ? undefined : { ...built.gate, issues: landedIssues(built.gate.issues) },
    residue,
  };
}

/** The whole marketplace build, into `marketplaceDir`: its plan's staged tree. */
async function buildMarketplaceInto(input: BuildMarketplaceInput, marketplaceDir: string): Promise<MarketplaceBuildResult> {
  const { name, config, availableSkills, configDir, skillsConfig, rootVersion, registry, projectSkills, suiteProbe, outputs, logger, verbose } = input;
  const plugins: PluginBuildResult[] = [];
  const externalPlugins: ExternalPluginBuildResult[] = [];

  // Marketplace-level skills filter restricts pool available to plugins that use "*"
  const marketplaceAvailable = resolveMarketplaceAvailableSkills(config, availableSkills);

  let gate: PluginGateFailure | undefined;
  // In order, stopping at the first gated plugin: each writes into this marketplace's tree.
  await everyInOrder(config.plugins, async (pluginDef) => {
    // externalSource plugins are never built or copied — they route straight
    // to a marketplace.json entry referencing the other repo. Every phase
    // buildPlugin runs (empty-plugin guard, tree-copy, skills packaging,
    // plugin.json merge) assumes local content, none of which exists here.
    if (pluginDef.externalSource) {
      logger.info(`      Referencing external plugin: ${pluginDef.name} (${pluginDef.externalSource.source})`);
      // No rootVersion fallback here (unlike a built plugin): this marketplace
      // does not own or build the referenced plugin, so tagging it with THIS
      // repo's package.json version would misrepresent what version the other
      // repo actually publishes. Only an explicit config version applies.
      externalPlugins.push({
        pluginName: pluginDef.name,
        pluginVersion: pluginDef.version,
        source: pluginDef.externalSource,
      });
      return true;
    }

    const outcome = await buildPlugin({
      marketplaceDir,
      pluginDef,
      marketplaceAvailable,
      configDir,
      skillsConfig,
      owner: config.owner,
      rootVersion,
      registry,
      projectSkills,
      suiteProbe,
      outputs,
      logger,
      verbose,
    });
    if (outcome.kind === 'gated') {
      gate = outcome.failure;
      return false;
    }
    plugins.push(outcome.result);
    return true;
  });
  if (gate !== undefined) {
    // No marketplace.json over a plugin that was never assembled: the plan discards the staged tree.
    return { name, plugins, externalPlugins, gate, residue: [] };
  }

  // Generate .claude-plugin/marketplace.json
  // Each BUILT entry's author is the plugin's own MERGED author (see
  // marketplace-json.ts), so marketplace.json and that plugin's plugin.json
  // cannot disagree. External entries carry no author — see marketplace-json.ts.
  const marketplaceJson = buildMarketplaceJson({
    name,
    owner: config.owner,
    plugins: [
      ...plugins.map((p): MarketplaceJsonPluginEntry => ({
        kind: 'built',
        name: p.pluginName,
        description: config.plugins.find((pd) => pd.name === p.pluginName)?.description,
        version: p.pluginVersion,
        author: p.pluginAuthor,
      })),
      ...externalPlugins.map((p): MarketplaceJsonPluginEntry => ({
        kind: 'external',
        name: p.pluginName,
        description: config.plugins.find((pd) => pd.name === p.pluginName)?.description,
        version: p.pluginVersion,
        source: p.source,
      })),
    ],
  });

  const marketplaceJsonPath = safePath.join(marketplaceDir, CLAUDE_PLUGIN_DIRNAME, 'marketplace.json');
  await writingMarketplace(`write ${marketplaceJsonPath}`, () =>
    writeFileUnder(marketplaceDir, `${CLAUDE_PLUGIN_DIRNAME}/marketplace.json`, JSON.stringify(marketplaceJson, null, 2), { existing: 'replace', writing: 'the marketplace manifest' }));
  logger.info(`   .claude-plugin/marketplace.json`);

  await copyDistributionFiles(marketplaceDir, configDir, config, logger);

  return { name, plugins, externalPlugins, gate: undefined, residue: [] };
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
  // `*` is the selector's ONE wildcard (any run of characters, none included); every other character
  // is itself. Matched by its literal pieces, in order — never compiled to a regular expression, where
  // a `.` or a `(` in a skill name's selector would mean something else.
  const pieces = selector.split('*');
  const first = pieces[0] ?? '';
  const last = pieces.at(-1) ?? '';
  if (pieces.length === 1) return skillName === selector;
  if (skillName.length < first.length + last.length || !skillName.startsWith(first) || !skillName.endsWith(last)) return false;
  const end = skillName.length - last.length;
  let from = first.length;
  for (const piece of pieces.slice(1, -1)) {
    const at = skillName.indexOf(piece, from);
    if (at === -1 || at + piece.length > end) return false;
    from = at + piece.length;
  }
  return true;
}

async function writeMergedPluginJson(
  pluginDef: ClaudeMarketplacePluginEntry,
  authorJson: Record<string, unknown> | undefined,
  pluginVersion: string | undefined,
  pluginDir: string,
  owner: ClaudeMarketplaceConfig['owner'],
  logger: ReturnType<typeof createLogger>,
): Promise<Record<string, unknown>> {
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
  const pluginJsonPath = safePath.join(pluginDir, CLAUDE_PLUGIN_DIRNAME, 'plugin.json');
  await writingMarketplace(`write ${pluginJsonPath}`, () =>
    writeFileUnder(pluginDir, `${CLAUDE_PLUGIN_DIRNAME}/plugin.json`, JSON.stringify(merged, null, 2), { existing: 'replace', writing: 'the merged plugin.json' }));
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
  outputs: readonly string[],
  logger: ReturnType<typeof createLogger>,
): Promise<string[]> {
  // By destination path, whatever order the selector or `readdir` named them in — every directory
  // before anything under it, since a path sorts after each of its prefixes. A pool skill that holds a
  // link is then always in place before a skill landing under it, so that layout is refused one way
  // (the link, an input fault) and never as this run's own half-written output. Compared as a
  // filesystem that folds names compares them (`Group/sub` is under `group` there); the name breaks a
  // tie, so two skills sent to one destination are also copied in one order on every host.
  const selected = resolvePluginSkills(pluginDef, marketplaceAvailable)
    .map((skillName) => {
      const fsPath = destOverrides.get(skillName) ?? skillNameToFsPath(skillName);
      return { skillName, fsPath, placed: toForwardSlash(fsPath).split('/').map(foldedSegment).join('/') };
    })
    .toSorted((a, b) => compareCodeUnits(a.placed, b.placed) || compareCodeUnits(a.skillName, b.skillName));
  const copied: string[] = [];

  // In order: each copy writes into the plugin dir, `destOverrides` may collide, and the first failure wins.
  await forEachInOrder(selected, async ({ skillName, fsPath }) => {
    const skillDistPath = safePath.join(configDir, 'dist', 'skills', skillName);
    requireInputPath(skillDistPath, {
      origin: 'content',
      message: `Skill "${skillName}" not built at dist/skills/${skillName}. Run: vat skills build (or vat build to build everything)`,
    });

    const destPath = safePath.join(pluginDir, 'skills', fsPath);
    // A file in dist/skills the OS will not read is on dist/skills' side of the run (`distSkillsSide`):
    // an input another build wrote (INPUT_UNREADABLE, fixed by rebuilding it), or this run's own output.
    await copyTreeIntoMarketplace(
      { path: skillDistPath, side: distSkillsSide(skillDistPath, outputs) },
      // From the plugin's own directory down: an earlier pool copy may have left a link on the way.
      { root: pluginDir, relative: `skills/${toForwardSlash(fsPath)}` },
      `dist/skills/${skillName}`,
      issueLocation(destPath, configDir),
    );
    copied.push(fsPath);
    logger.info(`         ${skillName} -> skills/${fsPath}`);
  });

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
function discoverPluginLocalSkills(
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
  // In order: a SKILL.md that will not read must be the first one named, deterministically.
  return mapInOrder(listPluginSourceSkillDirs(pluginSourceDir), async (skillDirPath) => {
    const skillSourceDir = safePath.join(pluginSourceDir, 'skills', skillDirPath);
    // Resolved through the SAME reader `vat skills build` and `vat verify` use — per-skill
    // config is keyed by name, so two answers would mean two effective configs.
    const skillName = await readPluginLocalSkillName(skillSourceDir, skillDirPath);
    return { skillDirPath, skillPath: safePath.join(skillSourceDir, 'SKILL.md'), skillName };
  });
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
  /**
   * The run's conventional-suite probe, created once beside `projectSkills`.
   *
   * Required for the same reason and threaded the same way: resolving test-input
   * dirs probes the filesystem under the subject AND under every `projectSkills`
   * entry, so a probe rebuilt inside this per-skill loop would be O(S²) for the run.
   */
  suiteProbe: ConventionalSuiteProbe;
  /** What the run writes — its one declaration (see `buildClaudePluginMarketplaces`). */
  outputs: readonly string[];
  logger: ReturnType<typeof createLogger>;
}): Promise<Array<{ skillDirPath: string; result: PackageSkillResult }>> {
  const packaged: Array<{ skillDirPath: string; result: PackageSkillResult }> = [];
  // KNOWN GAP — NO PER-SKILL CONTAINMENT. `packageSkill` reports most problems by
  // RETURNING a result whose `hasErrors` is set, but it THROWS on structural packaging
  // failures (filename collisions, unreadable sources). One throw escapes the whole
  // plugin build and discards every skill packaged before it — while the partial
  // `skills/<dir>/` trees already written stay on disk, described by nothing.
  //
  // What IS done: the packager's refusal of a skill's own content is CODED where it is
  // caught below (`SkillPackagingStop`), so the stopped run names the skill and is not
  // published as a defect in VAT. It still stops the run; containment is the gap.
  //
  // This is the SAME defect, in the same shape, that `packageSkills` had until commit
  // ba140fae ("fix(skills): one unbuildable skill no longer discards the whole build").
  // Copy that fix: it wraps each iteration in try/catch and returns a
  // `SkillPackageOutcome` discriminated union (`built` | `failed`) carrying the error,
  // deliberately NOT a synthetic `PackageSkillResult` (which would have to invent
  // `outputPath`/`skill`/`files`, so consumers would report a file count for a bundle
  // that is not on disk).
  //
  // Why it matters concretely: a `vat build` on a 90-skill adopter hit 3
  // filename collisions across three separate skills and, thanks to `packageSkills`'
  // containment, still built the other 87. This lane would have thrown all 90 away.
  //
  // Note the containment this lane lacks is for a skill that THROWS, and a filename
  // collision no longer throws — it is a returned finding. The remaining throw paths
  // are an absent or unreadable `files:` source; do not use a collision as the fixture
  // when adding that guard, or the test will pass without the guard existing.
  // In order: every skill packages against the one shared registry, and the log follows `input.skills`.
  await forEachInOrder(input.skills, async ({ skillDirPath, skillPath, skillName }) => {
    // Per-skill config goes through `pluginLocalSkillConfigEntry` — the one lookup
    // `vat verify` also uses to check what this packaged — so verify never checks
    // `files:` dests or severity overrides this build did not apply.
    const packagingConfig = mergeSkillPackagingConfig(
      input.skillsConfig?.defaults,
      pluginLocalSkillConfigEntry(input.skillsConfig?.config, { skillName, skillDirPath }),
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
    // this lane's ledger drains to 17 unused allow entries, against 14 in
    // the `vat skills build` (`skills`) lane — so the work this comment gates is a
    // bounded 17-entry reconciliation, not an unbounded one. UNVERIFIED how much of the
    // 17 - 14 delta is the false-positive class described above versus genuinely dead
    // entries; nobody has classified them entry by entry.
    // In place: the plugin dir is inside the marketplace's staged tree, which its plan lands whole.
    const { result } = await packageSkillInto(skillPath, skillOutputDir, {
      ...packagingConfigToPackageOptions(
        packagingConfig,
        { skillPath, outputPath: skillOutputDir },
        input.projectSkills,
        input.suiteProbe,
      ),
      registry: input.registry,
    }, input.outputs).catch((error: unknown) => {
      throw isSkillPackagingInputError(error) ? new SkillPackagingStop(error, skillPath) : error;
    });
    input.logger.info(
      `         ${skillName} -> skills/${skillDirPath} (${formatPackagedFileCount(result)})`,
    );
    packaged.push({ skillDirPath, result });
  });
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
): { lines: string[]; withErrors: string[]; issues: ValidationIssue[] } {
  const lines: string[] = [];
  const withErrors: string[] = [];
  const all: ValidationIssue[] = [];

  for (const { skillDirPath, result } of packaged) {
    const issues = collectPostBuildIssues(result);
    all.push(...issues);
    if (issues.length > 0) {
      lines.push(`         ${skillDirPath}: ${formatIssueSetHeading(issues, 'post-build')}`);
      for (const issue of issuesToRenderAtVerbosity(issues, verbose)) {
        lines.push(...formatIssueLines(issue, '         '));
      }
    }
    if (result.hasErrors) withErrors.push(skillDirPath);
  }

  return { lines, withErrors, issues: all };
}

/** Print the summary to stderr and return what the caller gates on. */
function reportPackagedSkillIssues(
  packaged: Array<{ skillDirPath: string; result: PackageSkillResult }>,
  logger: ReturnType<typeof createLogger>,
  verbose: boolean,
): { withErrors: string[]; issues: ValidationIssue[] } {
  const { lines, withErrors, issues } = summarizePackagedSkillIssues(packaged, verbose);
  for (const line of lines) {
    logger.info(line);
  }
  return { withErrors, issues };
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
 * Print the plugin-level findings to stderr.
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
): void {
  if (issues.length > 0) {
    logger.info(`         plugin: ${formatIssueSetHeading(issues)}`);
    for (const issue of issuesToRenderAtVerbosity(issues, true)) {
      for (const line of formatIssueLines(issue, '         ')) {
        logger.info(line);
      }
    }
  }
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
  /** The marketplace tree the plugin is built into: its plan's staged tree. */
  marketplaceDir: string;
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
  /** The run's conventional-suite probe, created once beside `projectSkills`. */
  suiteProbe: ConventionalSuiteProbe;
  /** What the run writes — its one declaration (see `buildClaudePluginMarketplaces`). */
  outputs: readonly string[];
  logger: ReturnType<typeof createLogger>;
  /** Render every finding, not just the errors (stderr only). */
  verbose: boolean;
}

/** A plugin assembled, or stopped by the post-build gate before it was. */
type PluginBuildOutcome =
  | { kind: 'built'; result: PluginBuildResult }
  | { kind: 'gated'; failure: PluginGateFailure };

async function buildPlugin(input: BuildPluginInput): Promise<PluginBuildOutcome> {
  const { marketplaceDir, pluginDef, marketplaceAvailable, configDir, skillsConfig, owner, rootVersion, registry, projectSkills, suiteProbe, outputs, logger, verbose } =
    input;
  const pluginDir = pluginDirInMarketplace(marketplaceDir, pluginDef.name);
  const pluginSourceDir = getPluginSourceDir(configDir, pluginDef);

  logger.info(`      Building plugin: ${pluginDef.name}`);

  // Phase 1: validators.
  await verifyPluginDirCaseMatch(configDir, pluginDef.name);

  const pluginSourceExists = pathPresent(pluginSourceDir, 'follow', 'source', 'probe');
  const hasExplicitFiles = (pluginDef.files?.length ?? 0) > 0;
  const hasPoolSkills =
    pluginDef.skills === '*'
      ? marketplaceAvailable.length > 0
      : pluginDef.skills.length > 0;
  if (!pluginSourceExists && !hasExplicitFiles && !hasPoolSkills) {
    throw new CommandRefusalError(
      'CONFIG_INVALID',
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
  await writingMarketplace(`create ${pluginDir}`, () => mkdir(pluginDir, { recursive: true }));

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
    throw new CommandRefusalError(
      'CONFIG_INVALID',
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
    suiteProbe,
    outputs,
    logger,
  });
  const { withErrors: skillsWithErrors, issues: localSkillIssues } =
    reportPackagedSkillIssues(packagedLocalSkills, logger, verbose);
  if (skillsWithErrors.length > 0) {
    return {
      kind: 'gated',
      failure: {
        reason:
          `Plugin '${pluginDef.name}': ${skillsWithErrors.length} plugin-local skill(s) emitted ` +
          `post-build validation errors: ${skillsWithErrors.join(', ')}`,
        issues: localSkillIssues,
      },
    };
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
  // Typed as the tree-copy's own result so the no-source literal must carry
  // EVERY field the copy returns: an untyped literal made `treeResult` a union
  // that compiled while the reads below silently skipped a field only one arm had.
  const treeResult: TreeCopyResult = pluginSourceExists
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
        symlinksCopied: [],
      };
  for (const link of treeResult.symlinksCopied) {
    logger.info(`         ${link} (symlink, copied by content)`);
  }

  // Plugin-level findings: they belong to the plugin, not to any one skill, and
  // they join the SAME `issues` the skills' findings land in. Anything else
  // republishes the bug: a build that changed what ships while its
  // machine-readable report said `warnings: 0`.
  const pluginIssues = unusedExcludeIssues(treeResult.unusedExcludePatterns, configDir, pluginSourceDir);
  reportPluginIssues(pluginIssues, logger);

  // Phase 3: pool-skill copy-in (from dist/skills/ via the plugin's skills: selector).
  const skillsCopied = await copyPoolSkills(
    pluginDef,
    marketplaceAvailable,
    configDir,
    pluginDir,
    poolDestOverrides,
    outputs,
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
    const target = { root: pluginDir, relative: 'CHANGELOG.md' };
    await copyFileIntoMarketplace(
      changelogPath,
      target,
      issueLocation(changelogPath, configDir),
      issueLocation(safePath.join(target.root, target.relative), configDir),
    );
    logger.info(`         CHANGELOG.md`);
  }

  return { kind: 'built', result: {
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
    symlinksCopied: treeResult.symlinksCopied,
    explicitFilesCopied,
    localSkillsPackaged,
    issues: [...localSkillIssues, ...pluginIssues],
  } };
}

/** Test-facing seam: the pure decisions of this module, reached by its unit tests. */
export const __internal = {
  builtWork,
  landedMarketplace,
  marketplaceIssues,
  matchesSelector,
  pluginBuildData,
  reportPackagedSkillIssues,
  reportPluginIssues,
  resolveCollidingSkills,
  resolveMarketplaceAvailableSkills,
  resolvePluginSkills,
  SkillPackagingStop,
  unusedExcludeIssues,
  withPackagingStop,
};
