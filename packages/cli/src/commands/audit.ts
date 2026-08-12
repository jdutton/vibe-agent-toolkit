/**
 * Audit command - audits plugins, marketplaces, registries, and Agent Skills
 * Top-level command: vat audit [path]
 */

import * as fs from 'node:fs';
import { existsSync as fsExistsSync } from 'node:fs';
import { basename } from 'node:path';

import {
  calculateValidationStatus,
  countBySeverity,
  type SeverityCounts,
  type ValidationIssue,
} from '@vibe-agent-toolkit/schema';
import {
  crawlAndResolveRegistry,
  detectDeclaredButMissing,
  detectMarketplacePluginSourceMissing,
  resetPackagingRegistryCache,
  detectPresentButUndeclared,
  detectReferenceTargetMissing,
  detectResourceFormat,
  enumerateSurfaces,
  validate,
  validateMarketplace,
  validateSkill,
  validateSkillForPackaging,
  type EvidenceRecord,
  type PackagingValidationResult,
  type SkillPackagingConfig,
  type SkillValidationSharedContext,
  type Surface,
  type ValidateOptions,
  type ValidationResult,
} from '@vibe-agent-toolkit/agent-skills';
import {
  analyzeCompatibility,
  checkSettingsCompatibility,
  detectSkillClaudePluginNameMismatch,
  crawlSkillLinkRegistry,
  extractClaudeMarketplaceInventory,
  extractClaudePluginInventory,
  getClaudeUserPaths,
  readEffectiveSettings,
  validatePlugin,
  type ClaudeMarketplaceInventory,
  type ClaudePluginInventory,
  type CompatibilityResult,
  type EffectiveSettings,
  type Target,
} from '@vibe-agent-toolkit/claude-marketplace';
import { detectFormat } from '@vibe-agent-toolkit/discovery';
import {
  findProjectRoot,
  gitFindRoot,
  type GitTracker,
  isAbsolutePath,
  isGitUrl,
  issueLocation,
  parseGitUrl,
  resetProjectRootCaches,
  safePath,
} from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';
import picomatch from 'picomatch';

import {
  resetSkillDiscoveryCache,
  resolveProjectDeclaredEvalSuites,
  resolveSkillPackagingConfig,
  stripValidationAllowForDisplay,
} from '../skill-resolution/packaging-config.js';
import { handleCommandError } from '../utils/command-error.js';
import {
  ConfigLoadError,
  loadConfig,
  resetLoadedConfigCache,
} from '../utils/config-loader.js';
import {
  countCollapsedFindings,
  formatCollapsedFindingsHint,
  formatIssueLines,
  formatSeverityBreakdown,
  issuesToRenderAtVerbosity,
} from '../utils/issue-rendering.js';
import { resolveIssueSeverity } from '../utils/issue-severity.js';
import { createLogger } from '../utils/logger.js';
import { writeYamlOutput } from '../utils/output.js';
import { relativizePathEntries } from '../utils/relativize-paths.js';
import { mergeSkillPackagingConfig } from '../utils/skill-packaging-config.js';
import { renderSkillQualityFooter } from '../utils/skill-quality-footer.js';
import { computeConfigVerdicts } from '../utils/verdict-helpers.js';

import {
  crawlOwnsSubtree,
  distributedTreeFindings,
  getOrCreateGitTracker,
  gitTrackerForProjectRoot,
  isWithin,
  resetGitTrackerCache,
} from './audit/distributed-tree.js';
import { withClonedRepo } from './audit/git-url-clone.js';
import { buildHierarchicalOutput } from './audit/hierarchical-output.js';
import {
  renderProvenanceHeader,
  rewritePathsInResults,
  type Provenance,
} from './audit/provenance.js';
import { createAuditSettingsCommand } from './audit-settings.js';
import { discoverSkillsFromConfig } from './skills/skill-discovery.js';

export interface AuditCommandOptions {
  compat?: boolean;
  debug?: boolean;
  exclude?: string[];
  includeArtifacts?: boolean;
  recursive?: boolean; // Commander sets this to false when --no-recursive is used
  settings?: string | boolean; // true = auto-discover, string = explicit path
  user?: boolean;
  verbose?: boolean; // Commander sets this for --verbose
  warnUnreferencedFiles?: boolean; // Commander sets this for --warn-unreferenced-files
}

/** Resource type constant for agent skills, avoiding duplicate string literals. */
const RESOURCE_TYPE_AGENT_SKILL: ValidationResult['type'] = 'agent-skill';
/** Resource type constant for Claude plugins, avoiding duplicate string literals. */
const RESOURCE_TYPE_CLAUDE_PLUGIN: ValidationResult['type'] = 'claude-plugin';

/**
 * Config-aware context for VAT project scanning. Built once per audit, passed through recursion.
 * @internal Exported for integration testing only.
 */
export interface VATProjectContext {
  /** Map of absolute SKILL.md path → merged SkillPackagingConfig (without validation.allow) */
  skillConfigs: Map<string, SkillPackagingConfig>;
}

const VAT_CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';

/**
 * Build config-aware context for a single VAT project at `scanRoot`.
 *
 * VAT's design: one `vibe-agent-toolkit.config.yaml` per project. Configs do
 * NOT compose across projects. This helper loads only the config at
 * `scanRoot` (no walk) and expands its declared skills into a map keyed by
 * absolute SKILL.md path.
 *
 * Used by compat analysis to resolve the plugin-level `targets` union. For
 * scan-time per-skill validation, see {@link resolveSkillPackagingConfig} —
 * audit walks UP from each discovered SKILL.md to its nearest-ancestor
 * config (via `findProjectRoot` + `loadConfigCached`) so per-skill packaging
 * rules still apply when auditing from above a project.
 *
 * Returns `null` if `scanRoot` has no config or the config has no skills.
 */
async function buildVATProjectContext(
  scanRoot: string,
  logger: ReturnType<typeof createLogger>,
): Promise<VATProjectContext | null> {
  const configPath = safePath.join(scanRoot, VAT_CONFIG_FILENAME);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- scanRoot is a controlled parameter
  if (!fs.existsSync(configPath)) {
    return null;
  }

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(scanRoot);
  } catch (error) {
    logger.debug(`Config-aware audit: skipping invalid config in ${scanRoot}: ${String(error)}`);
    return null;
  }

  if (config?.skills === undefined) return null;

  const skillConfigs = new Map<string, SkillPackagingConfig>();
  try {
    const discovered = await discoverSkillsFromConfig(config.skills, scanRoot);
    const { defaults, config: perSkillConfig } = config.skills;

    for (const skill of discovered) {
      const absPath = safePath.resolve(skill.sourcePath);
      const packagingConfig = stripValidationAllowForDisplay(
        mergeSkillPackagingConfig(
          defaults as Record<string, unknown> | undefined,
          perSkillConfig?.[skill.name] as Record<string, unknown> | undefined,
        ),
      );
      skillConfigs.set(absPath, packagingConfig);
    }

    logger.debug(`Config-aware audit: found ${discovered.length} skill(s) in ${scanRoot}`);
  } catch (error) {
    logger.debug(`Config-aware audit: failed to discover skills in ${scanRoot}: ${String(error)}`);
  }

  if (skillConfigs.size === 0) {
    return null;
  }

  return { skillConfigs };
}

/**
 * Convert PackagingValidationResult to ValidationResult for consistent audit output.
 * In audit mode, we merge allErrors (which includes both errors and warnings after
 * severity resolution but WITHOUT allow suppression) into the standard issues array.
 *
 * Compat verdicts (COMPAT_TARGET_*) are computed from the result's observations
 * and the config-level targets, then merged into the issue list.
 */
/**
 * The one-line human summary of a severity distribution.
 *
 * Every result that carries findings renders its counts the same way, so a reader
 * comparing two entries is comparing the same sentence.
 */
function formatCountsSummary(counts: SeverityCounts): string {
  return `${counts.errors} errors, ${counts.warnings} warnings, ${counts.info} info`;
}

/**
 * Append findings to a result and re-derive everything that describes them.
 *
 * The audit pipeline appends detector findings AFTER the primary validator has
 * already published a status, a counts block and a summary line. Pushing into
 * `issues` alone left all three describing the pre-append issue list — a plugin
 * with a warning reported `status: success`, `issueCounts: {0,0,0}` and
 * `summary: Valid plugin` in the very document that listed the warning.
 *
 * Mutates in place, because the audit pipeline hands these results around by
 * reference and there is no single place a rebuilt copy could be swapped in.
 */
function appendIssues(result: ValidationResult, issues: readonly ValidationIssue[]): void {
  if (issues.length === 0) {
    return;
  }
  result.issues.push(...issues);
  const counts = countBySeverity(result.issues);
  result.status = calculateValidationStatus(result.issues);
  result.issueCounts = counts;
  result.summary = formatCountsSummary(counts);
}

function packagingResultToValidationResult(
  skillPath: string,
  result: PackagingValidationResult,
  configTargets: ReadonlyArray<Target> | undefined,
  locationRoot: string,
): ValidationResult {
  // allErrors contains all emitted issues (errors + warnings) after severity resolution
  // but without allow suppression — exactly what audit wants. Verdicts are
  // computed from the observations carried on the result.
  const verdictIssues = computeConfigVerdicts(
    result.observations,
    configTargets,
    skillPath,
    locationRoot,
  );
  const issues = verdictIssues.length > 0
    ? [...result.allErrors, ...verdictIssues]
    : result.allErrors;
  const issueCounts = countBySeverity(issues);

  const out: ValidationResult = {
    path: skillPath,
    type: RESOURCE_TYPE_AGENT_SKILL,
    status: calculateValidationStatus(issues),
    summary: formatCountsSummary(issueCounts),
    issues,
    issueCounts,
    metadata: {
      lineCount: result.metadata.skillLines,
      name: result.skillName,
    },
  };
  if (result.evidence.length > 0) {
    out.evidence = result.evidence;
  }
  return out;
}

/**
 * Validate a single SKILL.md file, using config-aware validation if available.
 * Used for direct SKILL.md and vat-agent paths passed to `vat audit`.
 *
 * @param crawlTree Whether this call owns the presence-side crawl of the skill's
 *   directory (see {@link appendDistributedTreeFindings} below). REQUIRED
 *   and never defaulted, because the wrong answer is silent in both directions: a
 *   skill nested inside a plugin is already crawled by `validatePlugin` at any
 *   depth, so crawling again reports one file twice, while omitting it for a
 *   standalone bundle is the blindness this parameter exists to end.
 */
async function validateSingleSkill(
  skillPath: string,
  options: AuditCommandOptions,
  logger: ReturnType<typeof createLogger>,
  locationRoot: string,
  crawlTree: boolean,
  isVATGenerated?: boolean
): Promise<ValidationResult> {
  // Try config-aware validation: walk UP to the skill's nearest-ancestor
  // vibe-agent-toolkit.config.yaml and apply the skill's packaging block. A
  // broken governing config is tolerated here (audit is a bulk linter): log it
  // and fall back to config-free validation rather than aborting the scan.
  let fullConfig: Awaited<ReturnType<typeof resolveSkillPackagingConfig>>;
  try {
    fullConfig = await resolveSkillPackagingConfig(skillPath);
  } catch (err) {
    if (!(err instanceof ConfigLoadError)) throw err;
    logger.debug(`  Ignoring broken governing config for ${skillPath}: ${err.message}`);
    fullConfig = null;
  }
  const skillConfig = fullConfig === null ? null : stripValidationAllowForDisplay(fullConfig);
  if (skillConfig !== null) {
    logger.debug(`  Using config-aware validation for: ${skillPath}`);
    const { gitTracker } = await resolveScanContext(safePath.resolve(skillPath), locationRoot, logger);
    // Key the shared registry on the same project root the validator derives,
    // so every skill under one root parses the corpus once for the whole run
    // instead of once each.
    const skillDir = safePath.resolve(skillPath, '..');
    const projectRoot = findProjectRoot(skillDir) ?? skillDir;
    // The project's declared eval suites, memoized per config root, so this lane
    // predicts the same bundle the packager produces: no skill's report counts a
    // SIBLING skill's eval suite as an ordinary bundled file.
    const sharedCtx: SkillValidationSharedContext = {
      registry: await crawlAndResolveRegistry(projectRoot),
      locationRoot,
      projectSkills: await resolveProjectDeclaredEvalSuites(skillPath),
    };
    if (gitTracker !== null) {
      sharedCtx.gitTracker = gitTracker;
    }
    const packagingResult = await validateSkillForPackaging(skillPath, skillConfig, 'source', sharedCtx);
    const configAware = packagingResultToValidationResult(
      skillPath,
      packagingResult,
      skillConfig.targets as readonly Target[] | undefined,
      locationRoot,
    );
    await appendDistributedTreeFindings(configAware, skillPath, locationRoot, crawlTree);
    return configAware;
  }

  // Fallback: basic validation
  const validateOptions: ValidateOptions = { skillPath, locationRoot };
  if (options.warnUnreferencedFiles) {
    validateOptions.checkUnreferencedFiles = true;
  }
  if (isVATGenerated === true) {
    validateOptions.isVATGenerated = true;
  }
  const result = await validateSkill(validateOptions);
  await appendDistributedTreeFindings(result, skillPath, locationRoot, crawlTree);
  return result;
}

/**
 * Crawl a DISTRIBUTED skill's own directory for agent-instruction files and
 * append what it finds. Mutates `result`, like every other additive detector
 * pass in this command.
 *
 * Which trees count as distributed — and why the config's declaration is NOT the
 * discriminator any more — lives with the classifier in
 * `./audit/distributed-tree.ts` (`classifyScannedSkillTree`). In short: a repository that never adopted
 * VAT declares nothing, and an adopting repo's `include` globs never enumerate
 * its drafts and fixtures, so "not declared" swept up two populations of
 * ordinary repo source.
 *
 * Called from BOTH lanes — config-aware and wild — deliberately. It used to be
 * reachable only from the wild one, which left the abandoned discriminator alive
 * at the caller in its purest suppressing form: adding a `vibe-agent-toolkit.config.yaml`
 * to a dotfiles repo removed findings from skills installed under `~/.claude`,
 * because a config-aware match returned before the classifier was ever asked.
 * Whether the project also declares a skill says nothing about where that skill
 * lives, so it must not decide whether the question gets asked.
 *
 * @param crawlTree `false` when a plugin lane already crawled this subtree — see
 *   {@link validateSingleSkill}.
 */
async function appendDistributedTreeFindings(
  result: ValidationResult,
  skillPath: string,
  locationRoot: string,
  crawlTree: boolean,
): Promise<void> {
  appendIssues(result, await distributedTreeFindings(skillPath, locationRoot, crawlTree));
}

/**
 * Collect repeated option values into an array (used for --exclude)
 */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Create audit command
 * Top-level command: vat audit [path]
 */
export function createAuditCommand(): Command {
  const audit = new Command('audit');

  audit
    .description('Audit Claude plugins, marketplaces, registries, and skills')
    .argument(
      '[git-url-or-path]',
      'Path or git URL to audit. An argument that names an existing file or directory is always treated as a path. Otherwise, URL forms: https://host/owner/repo.git[#ref[:subpath]], git@host:owner/repo.git, ssh://..., owner/repo (GitHub shorthand), or a GitHub web URL like https://github.com/owner/repo/tree/<ref>/<subpath>. Default: current directory.'
    )
    .option('--no-recursive', 'Disable recursive directory scanning (scans top level only)')
    .option('--exclude <glob>', 'Exclude paths matching glob pattern (repeatable)', collect, [])
    .option('--include-artifacts', 'Include gitignored paths (build artifacts, dependencies) that are excluded by default')
    .option('--user', 'Audit user-level Claude resources (default: $CLAUDE_CONFIG_DIR or ~/.claude — scans plugins/, skills/, marketplaces/)')
    // `-v` short form: `vat audit -v` used to print the version (the root
    // `-v, --version` shadowed every subcommand), and after that alias was
    // removed it exited 1 as an unknown option — while five sibling verbs
    // accepted it. Advertising only the long form is what made the CHANGELOG's
    // "`-v` means `--verbose` on every verb" claim untrue.
    .option('-v, --verbose', 'Show all scanned resources, including those without issues')
    .option('--warn-unreferenced-files', 'Warn about files not referenced in skill markdown')
    .option('--compat', 'Run compatibility analysis for each plugin (shows claude-code, claude-cowork, claude-chat support)')
    .option('--settings [file]', 'Check plugins against Claude settings (auto-discover or specify file; requires --compat)')
    .option('--debug', 'Enable debug logging')
    .action(async function (this: Command, targetPath: string | undefined) {
      // `--debug` is declared on both the root program and this command;
      // Commander binds it to the program, so the command's own `opts()`
      // arrives empty. Use `optsWithGlobals()` to merge both layers.
      await auditCommand(targetPath, this.optsWithGlobals() as AuditCommandOptions);
    })
    .addCommand(createAuditSettingsCommand())
    .addHelpText(
      'after',
      `
Description:
  Audits Claude plugins, marketplaces, registries, and Agent Skills for
  quality, correctness, and compatibility. Automatically detects resource
  type and validates accordingly. Outputs YAML report to stdout,
  errors/warnings to stderr.

  Supported resource types:
  - Plugin directories (.claude-plugin/plugin.json)
  - Marketplace directories (.claude-plugin/marketplace.json)
  - Registry files (installed_plugins.json, known_marketplaces.json)
  - Agent Skills (SKILL.md files)
  - VAT agents (agent.yaml + SKILL.md)

  Path or URL to audit: resource directory, registry file, SKILL.md file,
  scan directory, or a git URL (HTTPS, SSH, GitHub shorthand, GitHub web URL).
  An argument naming an existing file or directory is always a path — bare
  owner/repo shorthand only applies when nothing of that name exists
  locally, so "vat audit plugins/arc" audits your directory and never
  contacts the network. When given a URL, VAT shallow-clones to a temp
  directory, audits, and cleans up on exit. See packages/cli/docs/audit.md
  for URL forms.
  Default: current directory
  Use --user to audit user-level installation automatically

  --user scope:
  - By default, scans $CLAUDE_CONFIG_DIR if set, otherwise ~/.claude.
  - Inside the chosen directory, scans:
    - plugins/ (installed plugins)
    - skills/ (standalone skills)
    - marketplaces/ (marketplace plugins)
  - Skips: projects/, logs/, cache/

  Multi-dir workflows:
    for dir in ~/.claude ~/.claude-personal; do
      CLAUDE_CONFIG_DIR="$dir" vat audit --user --verbose
    done
  (See packages/cli/docs/audit.md for details.)

Validation Behavior:
  Advisory only: audit surfaces all validation issues for inspection.
  Unlike 'vat skills validate', audit:
  - NEVER applies validation.allow (allowed codes are always shown)
  - Respects validation.severity: codes set to 'ignore' are hidden
  - ALWAYS exits 0 for validation results (never gates on errors)

  For gated validation (CI/CD), use: vat skills validate
  For the full list of codes and severity defaults, see: docs/validation-codes.md

  Default: Validates SKILL.md and all transitively linked markdown files
  --warn-unreferenced-files: Also detect files not referenced in skill

Validation Checks:
  Errors (must fix):
  - Missing or invalid manifests/frontmatter
  - Schema validation failures
  - Broken links to other files (Skills only)
  - Reserved words in names (Skills only)
  - XML tags in frontmatter fields (Skills only)
  - Windows-style backslashes in paths (Skills only)

  Warnings (should fix):
  - Skill exceeds recommended length (>5000 lines)
  - Compat smells — requires browser auth, local shell, or external CLI
    (COMPAT_REQUIRES_BROWSER_AUTH, COMPAT_REQUIRES_LOCAL_SHELL,
    COMPAT_REQUIRES_EXTERNAL_CLI). See docs/validation-codes.md.
  - Unreferenced files detected (with --warn-unreferenced-files)

Gitignore-Aware Scanning:
  When scanning inside a git repository, paths matched by .gitignore are
  skipped by default. This excludes build artifacts (dist/), dependencies
  (node_modules/), and any other project-specific ignored paths without
  requiring a hardcoded list.

  Use --include-artifacts to scan gitignored paths (e.g., to audit a
  bundled marketplace plugin in dist/).

  User-supplied --exclude patterns are always applied on top.
  Outside a git repository, no automatic exclusions apply.

Config-Aware Validation:
  The governing vibe-agent-toolkit.config.yaml is found by walking UP from
  the audited path, so a built bundle deep under dist/ is still governed by
  its project's config. Audit uses that project's build settings
  (linkFollowDepth, files, excludeReferencesFromBundle) to validate skills,
  which prevents false warnings for links the build pipeline resolves.

  Config-aware mode never applies validation.allow — audit always shows
  all issues. validation.severity IS applied: a code set to 'ignore' is
  hidden. skills.defaults.validation.severity applies project-wide (skills,
  plugins and marketplaces alike); skills.config.<name>.validation.severity
  layers on top for that skill.

Exit Codes:
  0 - Always (even when validation errors are surfaced)
  2 - System error (config invalid, directory not found)

Examples:
  $ vat audit ./plugins/              # Audit recursively (default)
  $ vat audit --user                  # Audit default ~/.claude (or $CLAUDE_CONFIG_DIR)
  $ CLAUDE_CONFIG_DIR=~/.claude-work vat audit --user   # Scan a custom Claude config dir
  $ vat audit --no-recursive ./dir/   # Top level only, no subdirectories
  $ vat audit --include-artifacts ./repo/   # Include gitignored paths
  $ vat audit --exclude "vendor/**" ./repo/   # Add extra exclusions
  $ vat audit --compat ./plugin/      # Include per-surface compatibility analysis
  $ vat audit https://github.com/octocat/Hello-World.git   # Audit a remote git repo
`
    );

  return audit;
}


/**
 * Which of the Claude install roots a `--user` run actually walks.
 *
 * The three roots read as siblings and are NOT: `marketplacesDir` is
 * `<claudeDir>/plugins/marketplaces`, i.e. INSIDE `pluginsDir`. A recursive walk
 * of `plugins/` already reaches every installed marketplace, so scanning
 * `marketplaces/` afterwards audited each marketplace-installed plugin and skill
 * a SECOND time, in a second result, under the identical `path:`. On one real
 * machine that turned 7 distinct agent-instruction files into 12 reported rows —
 * and it inflates every finding class, not one code, because the whole subject
 * is re-audited rather than one detector re-firing.
 *
 * The containment test is `isWithin`, the same one the provenance classifier
 * uses, so "inside" means the same thing on both sides and on Windows.
 *
 * Gated on `recursive`, and that is not defensive dressing: under
 * `--no-recursive` a walk of `plugins/` stops at its top level and never reaches
 * `marketplaces/`, so dropping the nested root there would replace a double
 * count with no coverage at all.
 *
 * Pure, and exported for that reason: the shape of the defect is "the list of
 * roots was wrong", which is assertable as a list.
 *
 * @internal Exported for unit testing only — not part of the public CLI API.
 */
export function userScanTargets(candidates: readonly string[], recursive: boolean): string[] {
  const resolved = candidates.map((dir) => safePath.resolve(dir));
  if (!recursive) return resolved;
  return resolved.filter(
    (dir) => !resolved.some((other) => other !== dir && isWithin(other, dir)),
  );
}

/**
 * Handle --user audit: scans ~/.claude/plugins, ~/.claude/skills, ~/.claude/marketplaces
 * and outputs hierarchical YAML. Calls process.exit() when done.
 */
async function auditUserDirectories(
  recursive: boolean,
  options: AuditCommandOptions,
  startTime: number,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  const { claudeDir, pluginsDir, skillsDir, marketplacesDir } = getClaudeUserPaths();
  // --user scans three sibling directories; they share ONE enclosing Claude
  // config dir, so that is the run's single stated root.
  const scanRoot = safePath.resolve(claudeDir);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: path constructed from os.homedir()
  const pluginsDirExists = fs.existsSync(pluginsDir);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: path constructed from os.homedir()
  const skillsDirExists = fs.existsSync(skillsDir);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: path constructed from os.homedir()
  const marketplacesDirExists = fs.existsSync(marketplacesDir);

  if (!pluginsDirExists && !skillsDirExists && !marketplacesDirExists) {
    logger.error(`No user-level Claude directories found:`);
    logger.error(`  Plugins: ${pluginsDir}`);
    logger.error(`  Skills: ${skillsDir}`);
    logger.error(`  Marketplaces: ${marketplacesDir}`);
    logger.error('Claude plugins/skills/marketplaces have not been installed yet.');
    process.exit(2);
  }

  const results: ValidationResult[] = [];

  // The roots that exist, minus any one another already covers — see
  // {@link userScanTargets}. `marketplaces/` lives inside `plugins/`.
  const present = [
    ...(pluginsDirExists ? [pluginsDir] : []),
    ...(skillsDirExists ? [skillsDir] : []),
    ...(marketplacesDirExists ? [marketplacesDir] : []),
  ];
  for (const target of userScanTargets(present, recursive)) {
    logger.debug(`Auditing user-level resources at: ${target}`);
    results.push(...await getValidationResults(target, recursive, options, logger, scanRoot));
  }

  // Run compatibility analysis if --compat flag is set
  const compatMap = options.compat
    ? await runCompatAnalysis(results, logger, scanRoot)  // --settings not supported in --user mode
    : undefined;

  const verbose = options.verbose ?? false;
  const skillResults = results.filter((r: ValidationResult) => SKILL_RESULT_TYPES.has(r.type));
  const hierarchical = buildHierarchicalOutput(skillResults, verbose, scanRoot);
  const summary = calculateHierarchicalSummary(results, hierarchical, startTime, compatMap, verbose, scanRoot);
  writeYamlOutput(summary);
  if (verbose) {
    renderVerboseEvidence(results, scanRoot, logger);
  }
  logHierarchicalSummary(results, logger);
}

/** Skill resource types that can have per-skill validation config. */
const SKILL_RESULT_TYPES: ReadonlySet<ValidationResult['type']> = new Set([RESOURCE_TYPE_AGENT_SKILL, 'vat-agent']);

/**
 * The invocation scan root: the ONE base every `path` and `location` in a
 * report is expressed relative to.
 *
 * This is an ANCHOR, not a validation-policy boundary. Deliberately NOT
 * {@link deriveConfigRoot} — a config root is discovered per resource by
 * walking up, and a single `vat audit` spans many of them, so using it as the
 * anchor emits one document in many coordinate systems. The scan root is
 * whatever the operator pointed the command at, so it is well defined even
 * where no config or git root exists at all (auditing `~/.claude`, a plugin
 * cache, a bare directory of skills).
 *
 * A file target anchors at its containing directory, so its own `path` reads as
 * the bare filename rather than as an empty string.
 *
 * @internal Exported so tests and the corpus runner derive the run root the same
 *   way the command does, instead of hand-rolling a second answer.
 */
export function deriveScanRoot(targetPath: string): string {
  const resolved = safePath.resolve(targetPath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved is the operator's own audit target
  const isDirectory = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
  return isDirectory ? resolved : safePath.resolve(resolved, '..');
}

/**
 * Derive the project root directory for config loading.
 *
 * Walks UP from the audit target through {@link findProjectRoot} — the same
 * discovery ladder (`vibe-agent-toolkit.config.yaml`, then `.git/`) that
 * `resolveSkillPackagingConfig` uses per skill, so the two cannot disagree about
 * which project governs a path.
 *
 * It used to guess by SHAPE instead: a directory argument resolved to ITSELF and
 * a `SKILL.md` argument to exactly two levels up. Neither reaches a project root
 * from a built bundle — `vat audit dist/skills/demo` looked for the config inside
 * the bundle, found none, and `applySeverityFilter` early-returned. The effect was
 * that `severity.PACKAGED_AGENT_INSTRUCTION_FILE: ignore` — the opt-out this very
 * command's `fix` text tells the reader to write — did nothing whenever audit was
 * pointed at the bundle rather than at the project. Measured: `warnings: 1` with
 * the override and without it, from the same tree, while `vat audit .` on that
 * same project honoured it.
 *
 * `null` (no config and no git anywhere above) falls back to the target itself,
 * which is what the shape-based version returned for every path.
 */
function deriveConfigRoot(targetPath: string | undefined): string {
  const start = targetPath === undefined ? process.cwd() : deriveScanRoot(targetPath);
  return findProjectRoot(start) ?? start;
}

/**
 * Build the recalculated status and summary after issues have been filtered.
 */
function buildFilteredResult(
  result: ValidationResult,
  filteredIssues: ValidationResult['issues']
): ValidationResult {
  const counts = countBySeverity(filteredIssues);

  return {
    ...result,
    status: calculateValidationStatus(filteredIssues),
    // Spreading `result` carried the PRE-filter `issueCounts` forward, so a
    // `severity: ignore` config left the counts describing findings the report
    // no longer contained. The counts are re-derived, never inherited.
    issueCounts: counts,
    summary: formatCountsSummary(counts),
    issues: filteredIssues,
  };
}

/**
 * Apply severity resolution to validation results.
 *
 * Audit is advisory only: it applies `validation.severity` to decide what to
 * show and at what severity, but deliberately ignores `validation.allow`.
 *
 * **Both directions, via the one shared resolver.** This used to compute the
 * merged override map correctly and then consult it for a single value —
 * `issues.filter(i => effective[i.code] !== 'ignore')` — so `ignore` worked
 * while `error`, `warning` and `info` fell through untouched. Measured end to
 * end on a real adopter tree: `severity: error` at BOTH scopes left
 * `severity: warning`, `errors: 0`, `status: warning`, while `vat verify` on the
 * same config promoted correctly. Two lanes, one config key, opposite answers.
 *
 * Status and counts are re-derived from the resolved severities by
 * {@link buildFilteredResult}, so a promotion moves the reported status. It does
 * NOT move this command's exit code — `vat audit` is advisory and its exit-code
 * behaviour is a separate, pre-existing question tracked in its own issue. That
 * asymmetry with `vat verify` (whose exit code IS severity-derived) is
 * deliberate here rather than overlooked.
 *
 * Two scopes, both live:
 *  - `skills.defaults.validation.severity` — the PROJECT-WIDE map, applied to
 *    every result this run produced, including `claude-plugin` and `marketplace`
 *    ones. It used to be applied only to skill-typed results, which left the
 *    opt-out inert for the population that motivated it: the false positive
 *    `PACKAGED_AGENT_INSTRUCTION_FILE` was kept at `warning` for — an official
 *    plugin's intentional scaffold template — is a finding on a PLUGIN tree, and
 *    no per-skill key can name it. Measured before the fix: a plugin result kept
 *    its warning with `severity: ignore` set at `skills.defaults`.
 *  - `skills.config.<name>.validation.severity` — layered on top, and only for a
 *    result that names a skill, since that key is keyed by skill name.
 *
 * KNOWN, DELIBERATELY NOT FIXED — per-skill scope cannot reach a finding nested
 * inside a plugin tree, even when that finding IS attributable to a skill.
 * `vat audit <plugin dir>` reports two findings: the plugin root's `CLAUDE.md`
 * (attributable to no skill, which is the case the project-wide scope above was
 * added for) and an `AGENTS.md` nested inside one of the plugin's OWN skills,
 * which is attributable. Measured: neither moves under
 * `skills.config.<that skill>` nor under `skills.config.<the plugin's name>`;
 * only the project-wide `skills.defaults` moves them. The mechanism is the line
 * below — a `claude-plugin` result is not in `SKILL_RESULT_TYPES`, so `skillName`
 * is `undefined` and the per-skill map is never consulted, no matter which name
 * the adopter writes.
 *
 * The consequence worth stating plainly: an adopter with ONE intentional
 * agent-instruction file in ONE plugin has to silence the code project-wide in
 * this lane, losing the detector everywhere else. The marketplace lane has the
 * same project-wide-only limitation for a different reason, recorded there: both
 * marketplace config schemas are `.strict()` with no `validation` key at all.
 *
 * @param results - Raw validation results from skill/plugin validators
 * @param config - Parsed VATConfig (may be undefined if no config file)
 * @returns New results array with ignored codes removed from issues
 */
function applySeverityFilter(
  results: ValidationResult[],
  config: ReturnType<typeof loadConfig>
): ValidationResult[] {
  if (config?.skills === undefined) {
    return results;
  }

  const skillsConfig = config.skills;
  const defaultSeverity = skillsConfig.defaults?.validation?.severity ?? {};

  return results.map(result => {
    const skillName = SKILL_RESULT_TYPES.has(result.type) ? result.metadata?.name : undefined;
    const perSkillSeverity = skillName === undefined
      ? {}
      : (skillsConfig.config?.[skillName]?.validation?.severity ?? {});

    // Merge: per-skill overrides default
    const effectiveSeverity: Record<string, string> = { ...defaultSeverity, ...perSkillSeverity };

    if (Object.keys(effectiveSeverity).length === 0) {
      return result;
    }

    const resolvedIssues = resolveIssueSeverity(result.issues, { severity: effectiveSeverity });

    // Short-circuit only when NOTHING moved. Comparing lengths alone was the old
    // test, and it is blind to the promote direction by construction: a resolved
    // `error` keeps the array exactly as long as it was, so an early return on
    // equal lengths discarded every re-severitied issue and reported the raw
    // ones. The severities have to be compared too.
    const unchanged =
      resolvedIssues.length === result.issues.length &&
      resolvedIssues.every((issue, index) => issue.severity === result.issues[index]?.severity);

    if (unchanged) {
      return result;
    }

    return buildFilteredResult(result, resolvedIssues);
  });
}

/**
 * Resolve `--settings`-driven EffectiveSettings if both --settings and
 * --compat flags are present. Logs warnings for misconfiguration paths.
 */
async function resolveEffectiveSettings(
  options: AuditCommandOptions,
  scanPath: string,
  logger: ReturnType<typeof createLogger>,
): Promise<EffectiveSettings | undefined> {
  if (!options.settings) return undefined;
  if (!options.compat) {
    logger.error('Warning: --settings requires --compat to be effective');
    return undefined;
  }
  const settingsFile = typeof options.settings === 'string' ? options.settings : undefined;
  try {
    return await readEffectiveSettings({ settingsFile, projectDir: scanPath });
  } catch (err) {
    logger.error(`Warning: could not load settings: ${String(err)}`);
    return undefined;
  }
}

interface AuditAtPathOverrides {
  provenance?: Provenance;
  tempRoot?: string;
}

/**
 * Run the audit pipeline at `scanPath` and assemble the report document,
 * without writing anything. The document states its coordinate system once
 * (`root`) and every `path`/`location` beneath it is relative to that root.
 *
 * @internal Exported for integration testing only — not part of the public CLI API.
 */
export async function buildAuditReport(
  scanPath: string,
  options: AuditCommandOptions,
  startTime: number,
  logger: ReturnType<typeof createLogger>,
): Promise<{
  results: ValidationResult[];
  document: ReturnType<typeof calculateSummary>;
}> {
  const recursive: boolean = options.recursive !== false;
  logger.debug(`Auditing resources at: ${scanPath}`);

  const scanRoot = deriveScanRoot(scanPath);
  const rawResults = await getValidationResults(scanPath, recursive, options, logger, scanRoot);

  // Load config for severity filtering (audit ignores allow; only severity matters).
  const config = loadConfig(deriveConfigRoot(scanPath));

  // Apply severity filtering: hide codes whose effective severity is 'ignore'.
  // Allow is deliberately NOT applied — audit is advisory only.
  const results = applySeverityFilter(rawResults, config);

  const effectiveSettings = await resolveEffectiveSettings(options, scanPath, logger);

  // Build config-aware context scoped to the single derived config root —
  // used by compat analysis to resolve the plugin-level `targets` union.
  // VAT's design: one config per project, no composition.
  const vatContextForCompat = await buildVATProjectContext(deriveConfigRoot(scanPath), logger);

  // Run compatibility analysis if --compat flag is set
  const compatMap = options.compat
    ? await runCompatAnalysis(results, logger, scanRoot, effectiveSettings, vatContextForCompat)
    : undefined;

  const verbose = options.verbose ?? false;
  return {
    results,
    document: calculateSummary(results, startTime, compatMap, verbose, scanRoot),
  };
}

/** Strip the run root from a report whose base cannot be named as a path. */
function withoutRoot<T extends { root: string }>(document: T): Omit<T, 'root'> {
  const copy: Record<string, unknown> = { ...document };
  delete copy['root'];
  return copy as Omit<T, 'root'>;
}

async function runAuditAtPath(
  scanPath: string,
  options: AuditCommandOptions,
  overrides: AuditAtPathOverrides = {}
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();
  const verbose = options.verbose ?? false;

  const { results, document } = await buildAuditReport(scanPath, options, startTime, logger);

  // A URL audit's run root is a random tempdir: not reproducible and useless to
  // a reader. The provenance header states the base instead (url @ ref @ commit)
  // and every path below is already relative to the clone, so drop `root`
  // rather than print a path nobody can resolve.
  const finalDocument =
    overrides.tempRoot === undefined ? document : rewritePathsInResults(withoutRoot(document), overrides.tempRoot);
  if (overrides.provenance) {
    process.stdout.write(renderProvenanceHeader(overrides.provenance));
  }
  writeYamlOutput(finalDocument);
  if (verbose) {
    renderVerboseEvidence(results, document.root, logger);
  }
  handleAuditResults(results, document, logger, verbose);
  logger.debug(`Audit complete in ${Date.now() - startTime}ms`);
}

async function runUrlAudit(rawInput: string, options: AuditCommandOptions): Promise<void> {
  const parsed = parseGitUrl(rawInput);
  await withClonedRepo(
    parsed,
    { keepTempForDebug: options.debug === true },
    async ({ targetDir, tempdir, provenance }) => {
      // Re-enter the audit pipeline against the cloned target. Strip --user
      // (it doesn't apply to URL audits).
      const innerOptions: AuditCommandOptions = { ...options, user: false };
      await runAuditAtPath(targetDir, innerOptions, {
        provenance,
        tempRoot: tempdir,
      });
    }
  );
}

export async function auditCommand(
  targetPath: string | undefined,
  options: AuditCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  resetAuditCaches();

  try {
    // A local path always wins. `isGitUrl` accepts bare `owner/repo` GitHub
    // shorthand, which is indistinguishable from an ordinary two-segment
    // relative path (`plugins/arc`, `docs/guides`, `packages/cli`). Asking
    // the URL question first meant those never got audited — the command
    // cloned https://github.com/<that>.git instead, reaching out to the
    // network with a name derived from the caller's own directory layout.
    // Shorthand is a fallback for arguments that name nothing on disk.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- targetPath is the user's own audit target; existence is the question being asked
    if (targetPath !== undefined && !fsExistsSync(targetPath) && isGitUrl(targetPath)) {
      await runUrlAudit(targetPath, options);
      return;
    }

    // Commander sets options.recursive to false when --no-recursive is passed, true otherwise
    const recursive: boolean = options.recursive !== false;

    if (options.user) {
      await auditUserDirectories(recursive, options, startTime, logger);
      return;
    }

    const scanPath = targetPath ? safePath.resolve(targetPath) : process.cwd();
    await runAuditAtPath(scanPath, options);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'AgentAudit');
  }
}

/**
 * Dispatch a single surface to the matching validator. Keeps the multi-surface
 * branch of {@link getValidationResults} focused so cognitive complexity stays
 * within the ESLint budget.
 */
async function validateSurface(
  surface: Surface,
  options: AuditCommandOptions,
  logger: ReturnType<typeof createLogger>,
  locationRoot: string,
): Promise<ValidationResult> {
  if (surface.type === RESOURCE_TYPE_AGENT_SKILL) {
    // No crawl: this arm only runs for a MULTI-surface root, which in practice is
    // skill-claude-plugin (SKILL.md beside .claude-plugin/plugin.json). The plugin
    // surface below crawls that same directory at any depth, so crawling here
    // would report every agent-instruction file in it a second time.
    return validateSingleSkill(surface.path, options, logger, locationRoot, false);
  }
  if (surface.type === RESOURCE_TYPE_CLAUDE_PLUGIN) {
    return validatePlugin(surface.path, { locationRoot });
  }
  return validateMarketplace(surface.path, { locationRoot });
}

/**
 * Validate every surface enumerated at a directory root (used when
 * `enumerateSurfaces` returns more than one — e.g., skill-claude-plugin).
 */
async function validateMultipleSurfaces(
  surfaces: readonly Surface[],
  scanPath: string,
  options: AuditCommandOptions,
  logger: ReturnType<typeof createLogger>,
  locationRoot: string,
): Promise<ValidationResult[]> {
  logger.debug(
    `Detected ${surfaces.length.toString()} surfaces at ${scanPath}: ${surfaces.map((s) => s.type).join(', ')}`,
  );
  const results: ValidationResult[] = [];
  for (const surface of surfaces) {
    results.push(await validateSurface(surface, options, logger, locationRoot));
  }
  return results;
}

/**
 * Additive inventory-detector pass — runs the pure-function detectors
 * introduced in Tasks 3.2/3.3/4b.1 alongside the existing audit pipeline.
 * This is NOT a replacement for any existing walker; it is a parallel check
 * that appends findings to the same ValidationResult after the primary
 * validation has already run.
 *
 * When `prebuiltInv` is provided for the `claude-plugin` type, the caller has
 * already extracted the inventory (e.g., to surface parse errors) and the
 * extractor is not called again.
 */
async function runInventoryDetectors(
  scanPath: string,
  type: ValidationResult['type'],
  locationRoot: string,
  prebuiltInv?: ClaudePluginInventory | ClaudeMarketplaceInventory,
): Promise<ValidationIssue[]> {
  if (type === RESOURCE_TYPE_CLAUDE_PLUGIN) {
    const inv = prebuiltInv?.kind === 'plugin' ? prebuiltInv : await pluginInventoryAt(scanPath);
    return [
      ...detectDeclaredButMissing(inv, locationRoot),
      ...detectPresentButUndeclared(inv, locationRoot),
      ...detectReferenceTargetMissing(inv, locationRoot),
      ...(inv.vendor === 'claude-code' ? detectSkillClaudePluginNameMismatch(inv, locationRoot) : []),
    ];
  }
  if (type === 'marketplace') {
    const inv = prebuiltInv?.kind === 'marketplace' ? prebuiltInv : await extractClaudeMarketplaceInventory(scanPath);
    return detectMarketplacePluginSourceMissing(inv, locationRoot);
  }
  return [];
}

/**
 * Recurse into co-located, path-source plugins declared by a marketplace and
 * dispatch each through the same audit pipeline used when audit is pointed
 * directly at a plugin.
 *
 * Only `discovered.plugins[]` are visited — the marketplace extractor populates
 * that list with path-source entries that exist on disk; remote (git/npm)
 * sources never appear there. Each plugin path is also de-duplicated and
 * compared against the marketplace path itself to avoid re-auditing a
 * co-located self-source (e.g., `source: "./"`).
 */
async function recurseIntoMarketplacePlugins(
  marketplaceInv: ClaudeMarketplaceInventory,
  recursive: boolean,
  options: AuditCommandOptions,
  logger: ReturnType<typeof createLogger>,
  locationRoot: string,
): Promise<ValidationResult[]> {
  const marketplaceRoot = safePath.resolve(marketplaceInv.path);
  const seen = new Set<string>([marketplaceRoot]);
  const results: ValidationResult[] = [];
  for (const plugin of marketplaceInv.discovered.plugins) {
    const pluginPath = safePath.resolve(plugin.path);
    if (seen.has(pluginPath)) {
      logger.debug(`  Skipping marketplace-recurse into already-visited path: ${pluginPath}`);
      continue;
    }
    seen.add(pluginPath);
    logger.debug(`  Recursing into marketplace path-source plugin: ${pluginPath}`);
    // Same run root — recursing into a co-located plugin must NOT re-anchor.
    const pluginResults = await getValidationResults(pluginPath, recursive, options, logger, locationRoot);
    results.push(...pluginResults);
  }
  return results;
}

/**
 * Append plugin inventory findings to the matching plugin result in a
 * multi-surface result list. Mutates in place.
 */
async function appendPluginInventoryToSurfaceResults(
  surfaceResults: ValidationResult[],
  scanPath: string,
  logger: ReturnType<typeof createLogger>,
  locationRoot: string,
): Promise<void> {
  const inventoryIssues = await runInventoryDetectors(scanPath, RESOURCE_TYPE_CLAUDE_PLUGIN, locationRoot);
  logger.debug(`Inventory detectors emitted ${inventoryIssues.length.toString()} issues for plugin (multi-surface) at ${scanPath}`);
  for (const r of surfaceResults) {
    if (r.type === RESOURCE_TYPE_CLAUDE_PLUGIN) {
      appendIssues(r, inventoryIssues);
      break;
    }
  }
}

/**
 * Surface `inventory.parseErrors[]` as `PLUGIN_INVALID_JSON` findings on
 * `result`, skipping the plugin.json manifest entry (which is already covered
 * by `validatePlugin`). Only hooks/hooks.json and .mcp.json parse errors reach
 * this helper; they are appended with error severity.
 */
function appendInventoryParseErrors(
	result: ValidationResult,
	inv: ClaudePluginInventory,
	locationRoot: string,
): void {
	const pluginJsonSuffix = safePath.join('.claude-plugin', 'plugin.json');
	const parseIssues: ValidationIssue[] = [];
	for (const err of inv.parseErrors) {
		if (err.path.endsWith(pluginJsonSuffix)) continue;
		parseIssues.push({
			severity: 'error',
			code: 'PLUGIN_INVALID_JSON',
			message: err.message,
			location: issueLocation(err.path, locationRoot),
		});
	}
	// Status was hand-set to 'error' here while `issueCounts` and `summary` kept
	// describing the pre-append list. One appender derives all three.
	appendIssues(result, parseIssues);
}

/**
 * @internal Exported for integration testing only — not part of the public CLI API.
 *
 * @param locationRoot - The invocation scan root: the ONE base every emitted
 *   `ValidationIssue.location` in this run is expressed relative to. It is an
 *   ANCHOR, not a validation-policy boundary — per-skill governing-config
 *   discovery still decides packaging rules, but it must never decide how a
 *   location reads, or a run spanning several configs emits one document in
 *   several coordinate systems. Recursion passes it through unchanged.
 */
export async function getValidationResults(
	scanPath: string,
	recursive: boolean,
	options: AuditCommandOptions,
	logger: ReturnType<typeof createLogger>,
	locationRoot: string,
): Promise<ValidationResult[]> {
	const format = detectFormat(scanPath);

	// Special handling for direct SKILL.md file
	if (format === RESOURCE_TYPE_AGENT_SKILL) {
		logger.debug('Detected single Agent Skill');
		return [await validateSingleSkill(scanPath, options, logger, locationRoot, true)];
	}

	// Special handling for VAT agent: validate its SKILL.md
	if (format === 'vat-agent') {
		const skillPath = safePath.join(scanPath, 'SKILL.md');
		logger.debug('Detected VAT agent, validating SKILL.md');
		return [await validateSingleSkill(skillPath, options, logger, locationRoot, true, true)];
	}

	// Enumerate all manifest surfaces at the directory root. If multiple are
	// present (e.g., skill-claude-plugin: SKILL.md + .claude-plugin/plugin.json),
	// validate each independently. This intentionally bypasses
	// detectResourceFormat's single-answer collapse so the skill surface is not
	// swallowed by the plugin surface.
	const surfaces = await enumerateSurfaces(scanPath);
	if (surfaces.length > 1) {
		const surfaceResults = await validateMultipleSurfaces(surfaces, scanPath, options, logger, locationRoot);
		if (surfaces.some((s) => s.type === RESOURCE_TYPE_CLAUDE_PLUGIN)) {
			// Build exclusion set from skill paths already validated as surfaces, so that
			// validatePluginSkillsViaInventory does not double-count a root SKILL.md that
			// enumerateSurfaces already returned as an agent-skill surface.
			const alreadyValidated = new Set(
				surfaces
					.filter((s) => s.type === RESOURCE_TYPE_AGENT_SKILL)
					.map((s) => safePath.resolve(s.path)),
			);
			surfaceResults.push(...(await validatePluginSkillsViaInventory(scanPath, options, logger, locationRoot, alreadyValidated)));
			await appendPluginInventoryToSurfaceResults(surfaceResults, scanPath, logger, locationRoot);
		}
		return surfaceResults;
	}

	// For plugin/marketplace directories or registry files, use unified validator
	const resourceFormat = await detectResourceFormat(scanPath);

	if (resourceFormat.type !== 'unknown') {
		logger.debug(`Detected ${resourceFormat.type} at: ${scanPath}`);
		const result = await validate(scanPath, { validatePlugin, locationRoot });
		if (resourceFormat.type === RESOURCE_TYPE_CLAUDE_PLUGIN) {
			// Build the inventory once; reuse it for both parse-error surfacing and detectors.
			const inv = await pluginInventoryAt(scanPath);
			appendInventoryParseErrors(result, inv, locationRoot);
			const pluginInventoryIssues = await runInventoryDetectors(scanPath, RESOURCE_TYPE_CLAUDE_PLUGIN, locationRoot, inv);
			appendIssues(result, pluginInventoryIssues);
			logger.debug(`Inventory detectors emitted ${pluginInventoryIssues.length.toString()} issues for plugin at ${scanPath}`);
			// Also validate every skill the plugin ships via the inventory walker.
			const skillResults = await validatePluginSkillsViaInventory(scanPath, options, logger, locationRoot);
			return [result, ...skillResults];
		}
		if (resourceFormat.type === 'marketplace') {
			// Build the marketplace inventory once; reuse it for both detectors and
			// recursion into co-located, path-source plugins. discovered.plugins[]
			// is populated only for path sources that exist on disk (git/npm/unknown
			// sources are declarations only and stay out of scope).
			const marketplaceInv = await extractClaudeMarketplaceInventory(scanPath);
			const marketplaceInventoryIssues = await runInventoryDetectors(scanPath, 'marketplace', locationRoot, marketplaceInv);
			appendIssues(result, marketplaceInventoryIssues);
			logger.debug(`Inventory detectors emitted ${marketplaceInventoryIssues.length.toString()} issues for marketplace at ${scanPath}`);
			const pluginResults = await recurseIntoMarketplacePlugins(marketplaceInv, recursive, options, logger, locationRoot);
			return [result, ...pluginResults];
		}
		return [result];
	}

	// If unknown format, check if it's a directory we can scan
	const fsp = await import('node:fs/promises');
	try {
		const stat = await fsp.stat(scanPath);
		if (stat.isDirectory()) {
			logger.debug('Scanning directory for resources');

			// The project's `resources.exclude` is applied by the scan context,
			// on the project-root basis its globs were written against — NOT
			// merged into `options.exclude`, whose patterns are relative to the
			// directory the operator named. See resolveProjectExcludes.
			return scanDirectory(
				scanPath,
				recursive,
				options,
				logger,
				await resolveScanContext(scanPath, locationRoot, logger),
			);
		}
	} catch {
		// Path doesn't exist or not accessible, let validate() handle it
	}

	// Unknown resource type - use unified validator which will return appropriate error
	logger.debug(`Unknown resource type at: ${scanPath}`);
	const result = await validate(scanPath, { locationRoot });
	return [result];
}

/**
 * Inventory-driven plugin skill walker. Builds the plugin inventory via
 * `extractClaudePluginInventory` and dispatches `validateSingleSkill` for each
 * discovered skill, including root-level skills in skill-claude-plugin shape.
 *
 * @param excludeSkillPaths - Resolved absolute paths to skip. Used in the
 *   multi-surface branch to avoid double-counting a root SKILL.md that
 *   `validateMultipleSurfaces` already validated as an `agent-skill` surface.
 */
async function validatePluginSkillsViaInventory(
	scanPath: string,
	options: AuditCommandOptions,
	logger: ReturnType<typeof createLogger>,
	locationRoot: string,
	excludeSkillPaths: ReadonlySet<string> = new Set(),
): Promise<ValidationResult[]> {
	const inv = await pluginInventoryAt(scanPath);
	const results: ValidationResult[] = [];
	for (const skill of inv.discovered.skills) {
		const resolvedPath = safePath.resolve(skill.files.skillMd);
		if (excludeSkillPaths.has(resolvedPath)) {
			logger.debug(`  Skipping already-validated skill (inventory): ${skill.files.skillMd}`);
			continue;
		}
		logger.debug(`  Validating plugin-bundled skill (inventory): ${skill.files.skillMd}`);
		// No crawl: `validatePlugin` already scanned the whole plugin tree, nested
		// skill directories included, so this lane would duplicate its findings.
		results.push(await validateSingleSkill(skill.files.skillMd, options, logger, locationRoot, false));
	}
	return results;
}

/**
 * Resolve the config-layer targets to pass to `analyzeCompatibility` for a
 * single plugin directory.
 *
 * Strategy for multi-skill plugins: take the **union** of every in-plugin
 * skill's `targets`. Rationale — a plugin is only "covered" for a target when
 * it can satisfy every skill it ships, so the plugin-level declaration should
 * include any target that any of its skills declares. This mirrors how the
 * verdict engine treats the plugin as a whole rather than slicing
 * capabilities per-skill. Skills that omit `targets` contribute nothing
 * (their declaration is silent, not zero).
 *
 * Returns `undefined` when there is no config context, no skills in the
 * plugin, or no skill declares targets — which preserves the pre-existing
 * behavior (plugin.json / marketplace.json wins; otherwise undeclared).
 */
function resolveConfigTargetsForPlugin(
  pluginDir: string,
  vatContext: VATProjectContext | null,
): Target[] | undefined {
  if (vatContext === null) return undefined;

  const pluginDirAbs = safePath.resolve(pluginDir);
  const union = new Set<Target>();

  for (const [skillPathAbs, packagingConfig] of vatContext.skillConfigs) {
    const rel = safePath.relative(pluginDirAbs, skillPathAbs);
    // Skill lives inside the plugin directory iff relative path does not
    // start with '..' and is not absolute.
    if (rel === '' || rel.startsWith('..') || isAbsolutePath(rel)) continue;

    const skillTargets = packagingConfig.targets;
    if (skillTargets === undefined) continue;
    for (const t of skillTargets) {
      union.add(t);
    }
  }

  return union.size === 0 ? undefined : [...union];
}

/**
 * Run compatibility analysis on plugin results and return a map of path -> CompatibilityResult.
 * Non-plugin results are skipped silently.
 * When effectiveSettings is provided, also runs settings conflict detection.
 *
 * `locationRoot` is the invocation scan root: the ONE base every emitted
 * evidence `location.file` is relative to. One audit run spans many plugin
 * directories, so anchoring evidence at each plugin would mix coordinate
 * systems in a single document.
 *
 * When vatContext is provided, config-layer `targets` declarations are
 * threaded through to the analyzer so `vat audit .` inside a VAT project
 * matches `vat skills validate` verdicts. See
 * {@link resolveConfigTargetsForPlugin} for the multi-skill union strategy.
 *
 * @internal Exported for integration testing only — not part of the public CLI API.
 */
export async function runCompatAnalysis(
  results: ValidationResult[],
  logger: ReturnType<typeof createLogger>,
  locationRoot: string,
  effectiveSettings?: EffectiveSettings,
  vatContext: VATProjectContext | null = null,
): Promise<Map<string, CompatibilityResult>> {
  const compatMap = new Map<string, CompatibilityResult>();

  for (const result of results) {
    if (result.type !== RESOURCE_TYPE_CLAUDE_PLUGIN) continue;

    try {
      logger.debug(`Running compatibility analysis for: ${result.path}`);
      const configTargets = resolveConfigTargetsForPlugin(result.path, vatContext);
      const analyzeOptions = configTargets === undefined
        ? undefined
        : { configTargets };
      const compat = await analyzeCompatibility(result.path, locationRoot, analyzeOptions);

      // Settings conflict detection (when --settings flag is used)
      if (effectiveSettings === undefined) {
        compatMap.set(result.path, compat);
      } else {
        try {
          const settingsConflicts = await checkSettingsCompatibility(result.path, effectiveSettings);
          compatMap.set(result.path, { ...compat, settingsConflicts });
        } catch (settingsErr) {
          logger.debug(`Settings compat check skipped for ${result.path}: ${String(settingsErr)}`);
          compatMap.set(result.path, compat);
        }
      }
    } catch (err) {
      // Log but do not fail the audit — compat analysis is best-effort
      logger.debug(`Compatibility analysis skipped for ${result.path}: ${String(err)}`);
    }
  }

  return compatMap;
}

/**
 * Merge compatibility analysis results into validation result output objects.
 * Returns an array of plain objects ready for YAML serialization.
 * When settingsConflicts are present, adds a `settings:` block for cleaner output.
 */
function mergeCompatIntoResults(
  results: ValidationResult[],
  compatMap: Map<string, CompatibilityResult>
): Array<ValidationResult & { compatibility?: Omit<CompatibilityResult, 'settingsConflicts'>; settings?: { compatible: boolean; conflicts: CompatibilityResult['settingsConflicts'] } }> {
  return results.map(r => {
    const compat = compatMap.get(r.path);
    if (compat === undefined) return r;

    // Extract settingsConflicts from compat to render as a separate `settings:` block
    const { settingsConflicts, ...compatWithoutSettings } = compat;

    if (settingsConflicts !== undefined) {
      return {
        ...r,
        compatibility: compatWithoutSettings,
        settings: {
          compatible: settingsConflicts.length === 0,
          conflicts: settingsConflicts,
        },
      };
    }

    return { ...r, compatibility: compat };
  });
}

/**
 * Apply compatibility data to results if a compatMap is provided and non-empty.
 * Returns the original results array when no compat data is available.
 */
function applyCompatMap(
  results: ValidationResult[],
  compatMap?: Map<string, CompatibilityResult>
): Array<ValidationResult & { compatibility?: CompatibilityResult }> {
  if (compatMap !== undefined && compatMap.size > 0) {
    return mergeCompatIntoResults(results, compatMap);
  }
  return results;
}

/**
 * Strip `evidence` from per-file results and `compatibility.evidence` when
 * the audit is not running in --verbose mode. Producing the field at all
 * (even as `[]`) would clutter terse YAML; we omit the key entirely.
 */
function stripCompatEvidence(compat: CompatibilityResult): Omit<CompatibilityResult, 'evidence'> {
  const out: Record<string, unknown> = { ...compat };
  delete out['evidence'];
  return out as Omit<CompatibilityResult, 'evidence'>;
}

function applyVerboseFilter<T extends ValidationResult & { compatibility?: CompatibilityResult }>(
  results: T[],
  verbose: boolean,
): T[] {
  if (verbose) return results;
  return results.map(r => {
    const stripped = { ...r } as Record<string, unknown>;
    delete stripped['evidence'];
    if (r.compatibility !== undefined) {
      stripped['compatibility'] = stripCompatEvidence(r.compatibility);
    }
    return stripped as unknown as T;
  });
}

/**
 * Nested carriers inside a file entry that publish their own `path`.
 *
 * `linkedFiles[].path` sat absolute in every document while every sibling
 * `path` and `location` beside it was root-relative — 532 of them in a single
 * `vat audit --user` run. Naming the carrier here is what re-bases it; a new
 * carrier that is not named keeps shipping absolute paths.
 */
const NESTED_PATH_CARRIERS = ['linkedFiles'] as const;

function calculateSummary(
  results: ValidationResult[],
  startTime: number,
  compatMap: Map<string, CompatibilityResult> | undefined,
  verbose: boolean,
  root: string,
) {
  const { entries, ...base } = buildBaseSummary(results, startTime);
  const withCompat = applyCompatMap(entries, compatMap);
  return {
    // Stated once, first, and the only absolute path in the document.
    root,
    ...base,
    files: relativizePathEntries(applyVerboseFilter(withCompat, verbose), root, NESTED_PATH_CARRIERS),
  };
}

/**
 * Maps a CAPABILITY_* observation code to the family of pattern IDs whose
 * evidence supports that capability claim. Returns a predicate that matches
 * any evidence record belonging to the family.
 */
function evidencePredicateForCode(code: string): ((e: EvidenceRecord) => boolean) | null {
  switch (code) {
    case 'CAPABILITY_LOCAL_SHELL':
      return e => (
        e.patternId === 'FENCED_SHELL_BLOCK' ||
        e.patternId === 'ALLOWED_TOOLS_LOCAL_SHELL' ||
        e.patternId === 'PROSE_LOCAL_SHELL_TOOL_REFERENCE' ||
        e.patternId === 'HOOK_COMMAND_INVOKES_BINARY' ||
        e.patternId.startsWith('SCRIPT_FILE_')
      );
    case 'CAPABILITY_EXTERNAL_CLI':
      return e => e.patternId.startsWith('EXTERNAL_CLI_');
    case 'CAPABILITY_BROWSER_AUTH':
      return e => e.patternId.startsWith('BROWSER_AUTH_');
    default:
      return null;
  }
}

/** Format an evidence record as a single rendering line. */
function formatEvidenceLine(ev: EvidenceRecord): string {
  const loc = ev.location.line === undefined
    ? ev.location.file
    : `${ev.location.file}:${ev.location.line}`;
  return `    evidence: [${ev.patternId}] at ${loc} — ${ev.matchText}`;
}

/** Render the evidence supporting a single CAPABILITY_* issue. */
function renderIssueEvidence(
  issue: ValidationIssue,
  evidenceSources: EvidenceRecord[],
  logger: ReturnType<typeof createLogger>,
): void {
  const predicate = evidencePredicateForCode(issue.code);
  if (!predicate) return;
  const matched = evidenceSources.filter(predicate);
  if (matched.length === 0) return;
  logger.info(`  [${issue.code}] ${issue.message}`);
  for (const ev of matched) {
    logger.info(formatEvidenceLine(ev));
  }
}

/**
 * The name a findings block is headed with — never the empty string.
 *
 * `issueLocation` answers "where is this, relative to the scan root", and for a
 * result that IS the scan root (auditing a plugin directory produces exactly
 * that) the honest relative path is `''`. Rendered straight into a heading, that
 * produced ` — 2 warnings:` — the operator was told a nameless something had two
 * warnings and then, because warnings collapse at default verbosity, shown
 * neither. Fall back in decreasing order of usefulness to the reader:
 *
 *  1. the relative path, whenever there is one (the common case, unchanged);
 *  2. the resource's own name from metadata already on the result — for a plugin
 *     or skill this is the most recognisable subject there is;
 *  3. the last path segment, i.e. the scanned directory's own name;
 *  4. `'.'`, the minimum honest way to say "the root you pointed me at".
 *
 * Every step reads data already in hand — no new I/O, and no re-deriving a path
 * the caller already resolved.
 */
function findingSubject(result: ValidationResult, root: string): string {
  const location = issueLocation(result.path, root);
  if (location !== '') return location;
  const name = result.metadata?.name;
  if (name !== undefined && name !== '') return name;
  // `basename` is empty for a filesystem root ('/' or 'C:\'), which is the only
  // case left that '.' has to cover.
  const directoryName = basename(result.path);
  return directoryName === '' ? '.' : directoryName;
}

/**
 * Render supporting evidence beneath each CAPABILITY_* issue when the
 * audit was invoked with --verbose. Evidence comes from the validation
 * result itself (per-file SKILL evidence) and from any attached
 * `compatibility.evidence` (plugin-level scanner output).
 */
function renderVerboseEvidence(
  results: Array<ValidationResult & { compatibility?: CompatibilityResult }>,
  root: string,
  logger: ReturnType<typeof createLogger>,
): void {
  for (const result of results) {
    const capabilityIssues = (result.issues ?? []).filter((i: ValidationIssue) =>
      i.code.startsWith('CAPABILITY_'),
    );
    if (capabilityIssues.length === 0) continue;

    const evidenceSources: EvidenceRecord[] = [
      ...(result.evidence ?? []),
      ...(result.compatibility?.evidence ?? []),
    ];
    if (evidenceSources.length === 0) continue;

    logger.info(`\n${findingSubject(result, root)} — supporting evidence:`);
    for (const issue of capabilityIssues) {
      renderIssueEvidence(issue, evidenceSources, logger);
    }
  }
}

function handleAuditResults(
  results: ValidationResult[],
  summary: { root: string; summary: FileStatusCounts; files?: Array<{ compatibility?: CompatibilityResult }> },
  logger: ReturnType<typeof createLogger>,
  verbose: boolean,
): void {
  const {
    filesWithErrors: errorCount,
    filesWithWarnings: warningCount,
    filesPassed: successCount,
  } = summary.summary;

  // Report settings conflicts (advisory, non-blocking)
  const totalSettingsConflicts = (summary.files ?? []).reduce((sum, f) => {
    return sum + (f.compatibility?.settingsConflicts?.length ?? 0);
  }, 0);
  if (totalSettingsConflicts > 0) {
    logger.error(`\u26a0 ${totalSettingsConflicts} settings conflict(s) found — see 'settings' section in YAML output`);
  }

  // Audit is advisory only — always exit 0 for validation results.
  // Use vat skills validate for gated validation (exit 1 on errors).
  if (errorCount > 0) {
    logger.error(`Audit failed: ${errorCount} file(s) with errors`);
    logFindingsForStatus(results, 'error', summary.root, logger.error.bind(logger), verbose);
  } else if (warningCount > 0) {
    logger.info(`Audit passed with warnings: ${warningCount} file(s)`);
    logFindingsForStatus(results, 'warning', summary.root, logger.info.bind(logger), verbose);
  } else {
    // `success` means "nothing actionable", NOT "nothing to see" — name the
    // informational findings or the YAML and the stderr line disagree.
    const withFindings = countResultsWithFindings(results);
    logger.info(
      withFindings > 0
        ? `Audit successful: ${successCount} file(s) passed (${withFindings} with informational findings)`
        : `Audit successful: ${successCount} file(s) passed`,
    );
  }

  renderAuditFooter(results, logger);
  process.exit(0);
}

/**
 * Render the skill-quality checklist footer when audit results contain
 * skill-level findings (warnings/errors on SKILL.md files) or when any of
 * the newer skill-quality codes fired.
 */
function renderAuditFooter(
  results: ValidationResult[],
  logger: ReturnType<typeof createLogger>,
): void {
  const emittedCodes = new Set<string>();
  let hasSkillFindings = false;

  for (const result of results) {
    const isSkill = result.type === RESOURCE_TYPE_AGENT_SKILL;
    for (const issue of result.issues) {
      emittedCodes.add(issue.code);
      if (isSkill && (issue.severity === 'error' || issue.severity === 'warning')) {
        hasSkillFindings = true;
      }
    }
  }

  renderSkillQualityFooter(logger, hasSkillFindings, emittedCodes);
}

/**
 * The stderr findings report for a set of audit results — the HUMAN channel.
 *
 * Deliberately NOT the YAML document. `vat audit` publishes a machine-readable
 * report on stdout that CI and tooling parse, and that document carries every
 * finding at every verbosity; this stream is read by a person, and on a 90-skill
 * corpus it printed 26,480 lines, 3,480 of them occurrences of a single
 * high-cardinality warning code. The two channels answer different questions, so
 * only this one collapses.
 *
 * Which findings render in full is not decided here — it is
 * {@link issuesToRenderAtVerbosity}, shared with the other findings-reporting
 * verbs so `vat audit`, `vat skills validate` and `vat skills build` cannot drift
 * onto three answers again. Errors always render; warnings and info collapse
 * unless `verbose`; allow-listed findings never render.
 *
 * The severity breakdown on each file's heading is load-bearing, not decoration.
 * For a warning-only file at default verbosity that heading is the ENTIRE report
 * for that file, so dropping the counts would turn the collapse into silence —
 * the failure direction `issue-rendering.ts` exists to prevent. The trailing
 * line names the collapsed total and both ways to see it, for the same reason.
 *
 * That trailing line points at THIS audit's YAML report, deliberately — do not
 * broaden it back into a claim about "the YAML report" in general. It is only
 * true of the verbs that emit full `issues:` arrays, and which verbs those are
 * has changed: `vat skills build` now publishes them too, so the sentence is
 * shared rather than re-spelled (see `formatCollapsedFindingsHint`, which takes
 * the report name for exactly this reason). Any verb that publishes counts alone
 * must still not use it — there, it would send a CI consumer to a document that
 * cannot answer the question.
 *
 * Pure: takes results, returns lines. It reads `issues` and never rewrites it,
 * because `runAuditAtPath` builds the YAML document from the very same array.
 *
 * @internal Exported for unit testing only — not part of the public CLI API.
 */
export function formatAuditFindingsLines(
  results: readonly ValidationResult[],
  root: string,
  verbose: boolean,
): string[] {
  const lines: string[] = [];
  let collapsed = 0;

  for (const result of results) {
    const rendered = issuesToRenderAtVerbosity(result.issues, verbose);
    // What --verbose WOULD show, minus what this verbosity shows. Derived from
    // the policy rather than re-stating it, so the count cannot contradict it.
    collapsed += countCollapsedFindings(result.issues, verbose);

    // The heading is unconditional and counts the WHOLE set — for a
    // warning-only file at default verbosity it IS the report. The trailing
    // colon is what varies: it introduces the blocks below, so a heading with
    // nothing beneath it does not print one. Same rule, same reason, as
    // `formatPostBuildIssueReport` in `skills/build.ts` — a colon promising a
    // list the current verbosity will not print is a promise the renderer
    // already knows it will break.
    const heading = `\n${findingSubject(result, root)} — ${formatSeverityBreakdown(countBySeverity(result.issues))}`;
    lines.push(rendered.length === 0 ? heading : `${heading}:`);
    for (const issue of rendered) {
      lines.push(...formatIssueLines(issue, '  '));
    }
  }

  const hint = formatCollapsedFindingsHint(collapsed, 'audit');
  if (hint !== undefined) lines.push(hint);

  return lines;
}

/**
 * Write one status class's findings to stderr beneath the run banner.
 *
 * The banner counts FILES and the blocks below count FINDINGS; both are needed,
 * and `logFn` picks the channel the calling branch already established.
 */
function logFindingsForStatus(
  results: ValidationResult[],
  status: ValidationResult['status'],
  root: string,
  logFn: (message: string) => void,
  verbose: boolean,
): void {
  const selected = results.filter((r: ValidationResult) => r.status === status);
  for (const line of formatAuditFindingsLines(selected, root, verbose)) {
    logFn(line);
  }
}

/**
 * Check whether a path should be excluded during directory scanning.
 * For directories, checks both bare path and path with trailing slash
 * so patterns like "dist/**" prune the directory itself.
 */
function isExcludedPath(
  isMatch: ReturnType<typeof picomatch>,
  relativePath: string,
  isDirectory: boolean
): boolean {
  if (isDirectory) {
    return isMatch(relativePath) || isMatch(relativePath + '/');
  }
  return isMatch(relativePath);
}

/**
 * Does the SKILL.md at `skillMdPath` own its own presence-side crawl, or has an
 * ancestor crawl already covered it?
 *
 * The single place the walk answers that question, for both owner kinds — see
 * {@link ScanContext.crawledRoot}. `isWithin` rather than a bare
 * `crawledRoot === null`: the claim is a containment claim and it is spelled
 * once, in the module that already got the separator right.
 */
function ownsOwnCrawl(scanCtx: ScanContext, skillMdPath: string): boolean {
  return scanCtx.crawledRoot === null || !isWithin(scanCtx.crawledRoot, safePath.resolve(skillMdPath));
}

/**
 * Hand the descending context an owner for everything below `owner`, unless one
 * is already claimed. First owner wins, and `null` claims nothing.
 */
function claimSubtree(scanCtx: ScanContext, owner: string | null): ScanContext {
  if (owner === null || scanCtx.crawledRoot !== null) return scanCtx;
  return { ...scanCtx, crawledRoot: safePath.resolve(owner) };
}

/**
 * The context this directory's SUBDIRECTORIES are walked with.
 *
 * A `SKILL.md` here means this directory's own crawl reaches every descendant at
 * any depth, so it — not each nested skill in turn — owns the subtree below.
 *
 * Resolved before the entry loop rather than inside it: `SKILL.md` and the
 * subdirectories it governs are siblings in one `readdir`, and their order is
 * the filesystem's to choose, so deciding this mid-loop would make the verdict
 * depend on it.
 *
 * Conditional on the crawl actually RUNNING ({@link crawlOwnsSubtree}), not on
 * the SKILL.md merely existing: a repo-source skill's crawl is skipped
 * entirely, so claiming its subtree would trade a double count for a missed
 * finding — and provenance is not monotone down a tree.
 */
async function contextForDescendants(
  dirPath: string,
  entries: readonly { name: string; isFile: () => boolean }[],
  scanCtx: ScanContext,
): Promise<ScanContext> {
  if (!entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) return scanCtx;
  const skillMd = safePath.join(dirPath, 'SKILL.md');
  if (!ownsOwnCrawl(scanCtx, skillMd)) return scanCtx;
  if (!await crawlOwnsSubtree(skillMd)) return scanCtx;
  return claimSubtree(scanCtx, dirPath);
}

/**
 * Handle file entry during directory scan
 */
async function handleFileEntry(
  entry: { name: string },
  fullPath: string,
  options: AuditCommandOptions,
  logger: ReturnType<typeof createLogger>,
  scanCtx: ScanContext,
): Promise<ValidationResult | null> {
  const { locationRoot } = scanCtx;

  // Check for registry files
  if (entry.name === 'installed_plugins.json' || entry.name === 'known_marketplaces.json') {
    logger.debug(`Validating registry: ${fullPath}`);
    return validate(fullPath, { locationRoot });
  }

  // Check for SKILL.md
  if (entry.name === 'SKILL.md') {
    logger.debug(`Validating Agent Skill: ${fullPath}`);

    // Config-aware: walk UP to the skill's nearest-ancestor config and apply
    // ONLY that skill's declared packaging rules. Configs do not compose
    // across VAT projects — audit does not merge rules across sibling configs.
    const fullConfig = await resolveSkillPackagingConfig(fullPath);
    const skillConfig = fullConfig === null ? null : stripValidationAllowForDisplay(fullConfig);
    if (skillConfig !== null) {
      logger.debug(`  Using config-aware validation for: ${fullPath}`);
      // Thread the per-scan tracker into packaging validation so gitignore
      // checks in the link-graph walk stay O(1).
      // `projectSkills`: same project-wide test-input rule as the lane above,
      // resolved through the same per-config-root memo.
      const projectSkills = await resolveProjectDeclaredEvalSuites(fullPath);
      const sharedCtx: SkillValidationSharedContext = scanCtx.gitTracker === null
        ? { locationRoot, projectSkills }
        : { gitTracker: scanCtx.gitTracker, locationRoot, projectSkills };
      const packagingResult = await validateSkillForPackaging(fullPath, skillConfig, 'source', sharedCtx);
      const configAware = packagingResultToValidationResult(
        fullPath,
        packagingResult,
        skillConfig.targets as readonly Target[] | undefined,
        locationRoot,
      );
      await appendDistributedTreeFindings(configAware, fullPath, locationRoot, ownsOwnCrawl(scanCtx, fullPath));
      return configAware;
    }

    // Wild mode: basic validation
    const validateOptions: ValidateOptions = { skillPath: fullPath, locationRoot };
    if (options.warnUnreferencedFiles) {
      validateOptions.checkUnreferencedFiles = true;
    }
    const result = await validateSkill(validateOptions);
    // Wild mode is where the distributed-tree question is even ASKED; the
    // classifier answers it. Suppressed under a plugin ancestor, which already
    // crawled this whole subtree at any depth.
    await appendDistributedTreeFindings(result, fullPath, locationRoot, ownsOwnCrawl(scanCtx, fullPath));
    return result;
  }

  return null;
}

/**
 * Handle directory entry during directory scan
 */
async function handleDirectoryEntry(
  fullPath: string,
  recursive: boolean,
  options: AuditCommandOptions,
  logger: ReturnType<typeof createLogger>,
  baseDir: string,
  scanCtx: ScanContext,
  nestedConfigLog: Set<string>,
): Promise<ValidationResult[]> {
  const fs = await import('node:fs/promises');
  const { locationRoot } = scanCtx;
  const results: ValidationResult[] = [];

  // Check if directory contains a plugin or marketplace
  const claudePluginDir = safePath.join(fullPath, '.claude-plugin');
  const hasClaudePlugin = await fs.access(claudePluginDir).then(() => true).catch(() => false);

  if (hasClaudePlugin) {
    logger.debug(`Validating resource directory: ${fullPath}`);
    const result = await validate(fullPath, { validatePlugin, locationRoot });
    const inv = await pluginInventoryAt(fullPath);
    appendInventoryParseErrors(result, inv, locationRoot);
    results.push(result);
  }

  // Recurse into subdirectories (both plugin/marketplace dirs and regular dirs).
  // Below a plugin, `validatePlugin` has already crawled the whole subtree for
  // agent-instruction files, so every crawl below must stand down or one file
  // is reported twice. See {@link ScanContext.crawledRoot} — first owner wins,
  // and it never clears on the way down.
  const childCtx = claimSubtree(scanCtx, hasClaudePlugin ? fullPath : null);
  if (recursive) {
    const subResults = await scanDirectory(fullPath, recursive, options, logger, childCtx, baseDir, nestedConfigLog);
    results.push(...subResults);
  }

  return results;
}

/**
 * The per-scan "git context" a walker needs: the detected git root (for
 * reporting / ancestor gating) and a pre-populated {@link GitTracker} with the
 * repo's active set of non-ignored files. The tracker lets every subsequent
 * ignore check answer in O(1) without spawning `git check-ignore`.
 */
interface ScanContext {
  gitRoot: string | null;
  gitTracker: GitTracker | null;
  /**
   * The run's single anchor base — the invocation scan root every emitted
   * `location` and `path` is expressed relative to. Carried here rather than as
   * a parallel parameter so the directory walk cannot thread a git root down
   * one branch and an anchor base down another.
   */
  locationRoot: string;
  /**
   * The governing project's `resources.exclude`, compiled against the project
   * root. `null` when there is no governing config, it declares no excludes, or
   * the operator pointed the scan AT an excluded tree.
   */
  projectExcludes: ExcludeMatcher | null;
  /**
   * The directory whose presence-side crawl already owns everything below this
   * point — or `null` while nothing does.
   *
   * `detectPackagedAgentInstructionFiles` matches at ANY depth, so whichever
   * crawl runs highest in the tree already reports every agent-instruction file
   * beneath it, nested skill directories included. Every crawl below it must
   * stand down or one file is reported once per ancestor, in as many results,
   * and the run's `issueCounts` — the number a CI gate reads — counts it that
   * many times.
   *
   * TWO kinds of owner reach this field, and it used to hold only the first:
   *
   * - a **plugin** directory, crawled by `validatePlugin`;
   * - a **skill** directory whose own crawl {@link crawlOwnsSubtree} confirms
   *   will run. A skill nested under another skill had no guard at all, so a
   *   chain of 20 nested skills holding one `CLAUDE.md` each produced 210
   *   warnings for 20 files — quadratic in nesting depth.
   *
   * A path, not a boolean, so the owner can be named in the containment test
   * and so the two owner kinds stay one concept. Carried on the context rather
   * than as a parameter because it must survive every level of
   * {@link scanDirectory} recursion below the owner, not just the immediate
   * child. First owner wins: it is set once and never cleared on the way down.
   */
  crawledRoot: string | null;
}

/**
 * A compiled exclude rule plus the base its patterns are relative to.
 *
 * Audit applies two exclude sources with DIFFERENT bases, which is why the base
 * travels with the matcher instead of being assumed. `--exclude` is typed at the
 * command line about the directory the operator named, so it is relative to the
 * scan base. `resources.exclude` is written in a config file about that config's
 * own project, so it is relative to the project root — matching it against
 * scan-relative paths makes one config mean different things depending on which
 * subdirectory you happened to name.
 */
interface ExcludeMatcher {
  isMatch: ReturnType<typeof picomatch>;
  base: string;
  /** Prefix for the debug breadcrumb, so the two sources stay distinguishable. */
  label: string;
}

/**
 * Compile the governing project's `resources.exclude` for a scan.
 *
 * The config is found by walking UP from the scan directory ({@link findProjectRoot}),
 * not by looking in it. Looking only in the scan directory is how a path argument
 * silently voided every exclude the project had declared: `vat audit
 * packages/x/resources/skills/` found no config there, so a package that excludes
 * its deliberately-broken eval fixtures had them audited as production skills the
 * moment anyone named a subdirectory. Commit 8a466b0c fixed the same defect for
 * `vat resources validate|scan` and `vat rag index`; this is the lane it missed.
 * The rule is the same one that commit established: a path argument says WHICH
 * tree to audit, and `exclude` applies either way.
 *
 * With one deliberate exception, mirroring the gitignore rule in
 * {@link resolveScanContext}: when the operator points the scan AT an excluded
 * tree, their explicit intent wins and the excludes are dropped for that run.
 * Otherwise naming an excluded directory would report `filesScanned: 0,
 * status: success` — a green run that scanned nothing.
 */
function resolveProjectExcludes(
  scanDir: string,
  logger: ReturnType<typeof createLogger>,
): ExcludeMatcher | null {
  const projectRoot = findProjectRoot(scanDir);
  if (projectRoot === null) return null;

  let patterns: readonly string[];
  try {
    patterns = loadConfig(projectRoot)?.resources?.exclude ?? [];
  } catch (err) {
    // Audit is a bulk linter over trees it does not own; a broken governing
    // config must not abort the scan. Say so rather than dropping it silently.
    logger.debug(`Ignoring unreadable config at ${projectRoot}: ${String(err)}`);
    return null;
  }
  if (patterns.length === 0) return null;

  // dot:true so excludes like `**/.cache/*` match through dotfile dirs;
  // without it the exclude silently never fires.
  const isMatch = picomatch([...patterns], { dot: true });
  const scanRelToProject = safePath.relative(projectRoot, safePath.resolve(scanDir)).replaceAll('\\', '/');
  if (scanRelToProject !== '' && isExcludedPath(isMatch, scanRelToProject, true)) {
    logger.debug(
      `Scan root ${scanRelToProject} is excluded by the config at ${projectRoot}; ` +
        'auditing it anyway because it was named explicitly',
    );
    return null;
  }

  return { isMatch, base: projectRoot, label: 'excluded by config' };
}

/**
 * Cache of (projectRoot → registry for the *inventory* link walk).
 *
 * Deliberately separate from the validator's own registry memo (which now lives
 * beside `crawlAndResolveRegistry`, so this lane no longer keeps a second copy of
 * that cache): the validator's registry crawls markdown AND HTML, while the
 * inventory walk has always been markdown-only. Sharing one registry between them
 * would quietly widen the link graph `files.linked` is computed from, which is a
 * behaviour change and not this fix's business. Two crawls per project root is
 * still two, not two per skill.
 */
const inventoryRegistryCache: Map<string, Promise<Awaited<ReturnType<typeof crawlSkillLinkRegistry>>>> = new Map();

/** Build (once per run, per root) the registry the plugin inventory link walk needs. */
async function getOrCreateInventoryRegistry(
  projectRoot: string,
): Promise<Awaited<ReturnType<typeof crawlSkillLinkRegistry>>> {
  const cached = inventoryRegistryCache.get(projectRoot);
  if (cached !== undefined) {
    return cached;
  }
  const pending = crawlSkillLinkRegistry(projectRoot);
  inventoryRegistryCache.set(projectRoot, pending);
  return pending;
}

/**
 * `extractClaudePluginInventory` for a plugin directory, handing it the shared
 * inventory registry so each skill it walks does not re-parse the corpus.
 *
 * A PROVIDER, not an awaited registry, and only when there is a project root — the same
 * two rules `vat inventory`'s `linkRegistryProviderFor` follows, for the same two reasons:
 *
 * 1. **Unresolved.** `extractClaudePluginInventory` promises "never throws — all failures
 *    surface via parseErrors[]", and that promise holds only while the crawl runs inside
 *    `walkLinkedFiles`'s try/catch. Awaiting it here moved the crawl outside that catch,
 *    so one unreadable markdown file anywhere under the root aborted the WHOLE audit with
 *    `status: error` and exit code 2 instead of degrading three link walks. The extractor
 *    memoizes the provider and caches even a rejection, so the failed crawl is still
 *    attempted once, not once per skill.
 * 2. **Only a project root.** Reuse is gated on exact `registry.baseDir === projectRoot`
 *    equality against the root `walkLinkedFiles` derives per skill
 *    (`findProjectRoot(dirname(skillMd)) ?? dirname(skillMd)`). With no project root that
 *    per-skill fallback is each skill's OWN directory, so a registry rooted at the plugin
 *    matches nothing: it would be crawled, compared, discarded, and re-crawled per skill.
 *    No root, no provider.
 *
 * The third argument is unconditional where the second is not: a
 * {@link gitTrackerForProjectRoot} is asked per skill, about that skill's own root, and
 * answers `undefined` for a root it cannot serve — so there is no "no root, no source"
 * case to encode here. This is the call site that carried all 786 measured
 * `git check-ignore` spawns.
 */
async function pluginInventoryAt(dir: string): Promise<Awaited<ReturnType<typeof extractClaudePluginInventory>>> {
  const projectRoot = findProjectRoot(dir);
  return extractClaudePluginInventory(
    dir,
    projectRoot === null ? undefined : () => getOrCreateInventoryRegistry(projectRoot),
    gitTrackerForProjectRoot,
  );
}

/**
 * Reset all module-level audit caches. Must be called at the start of every
 * independent audit invocation so in-process callers (CLI entrypoint AND
 * integration tests that share a vitest worker) don't observe stale trackers,
 * governing configs, or skill-discovery maps from a prior run.
 */
export function resetAuditCaches(): void {
  resetGitTrackerCache();
  resetPackagingRegistryCache();
  inventoryRegistryCache.clear();
  resetProjectRootCaches();
  resetLoadedConfigCache();
  resetSkillDiscoveryCache();
}

/**
 * Resolve the effective git root and build a per-repo {@link GitTracker} for a
 * scan. On the first call for a scan (no tracker yet), detects the git root
 * from `dirPath` and constructs a tracker pre-populated with the repo's
 * non-ignored files.
 *
 * If the scan root itself is gitignored (e.g., user explicitly targeted
 * `dist/`), returns `{ gitRoot: null, gitTracker: null }` to disable gitignore
 * filtering — the user's explicit intent takes precedence over .gitignore.
 */
async function resolveScanContext(
  dirPath: string,
  locationRoot: string,
  logger: ReturnType<typeof createLogger>,
): Promise<ScanContext> {
  const projectExcludes = resolveProjectExcludes(dirPath, logger);
  const detectedRoot = gitFindRoot(dirPath);
  if (detectedRoot === null) {
    return { gitRoot: null, gitTracker: null, locationRoot, projectExcludes, crawledRoot: null };
  }

  const tracker = await getOrCreateGitTracker(detectedRoot);

  // If the scan root itself is gitignored (e.g. user targeted `dist/`), disable
  // gitignore filtering so the user's explicit intent wins.
  if (tracker.isIgnoredByActiveSet(dirPath)) {
    return { gitRoot: null, gitTracker: null, locationRoot, projectExcludes, crawledRoot: null };
  }

  return { gitRoot: detectedRoot, gitTracker: tracker, locationRoot, projectExcludes, crawledRoot: null };
}

/**
 * Build the gitignore exclusion map for a set of entry paths.
 * Returns null when gitignore filtering is not applicable (no git root,
 * --include-artifacts, or outside a git repo).
 */
function buildGitIgnoreMap(
  entryPaths: string[],
  gitTracker: GitTracker | null,
  includeArtifacts: boolean,
): Map<string, boolean> | null {
  if (gitTracker === null || includeArtifacts) {
    return null;
  }
  const map = new Map<string, boolean>();
  for (const entryPath of entryPaths) {
    map.set(entryPath, gitTracker.isIgnoredByActiveSet(entryPath));
  }
  return map;
}

/**
 * Check whether a directory entry should be skipped during scanning.
 * Returns a reason string for debug logging, or null if the entry should be kept.
 */
function getSkipReason(
  entry: { name: string; isDirectory: () => boolean },
  fullPath: string,
  gitIgnoredMap: Map<string, boolean> | null,
  excludeMatchers: readonly ExcludeMatcher[]
): string | null {
  // Always skip .git directory (not reported by git check-ignore)
  if (entry.isDirectory() && entry.name === '.git') {
    return '.git';
  }

  // Skip gitignored paths
  if (gitIgnoredMap !== null && gitIgnoredMap.get(fullPath) === true) {
    return `gitignored: ${entry.name}`;
  }

  // Each matcher answers against ITS OWN base — see {@link ExcludeMatcher}.
  for (const matcher of excludeMatchers) {
    const relativePath = safePath.relative(matcher.base, fullPath).replaceAll('\\', '/');
    if (isExcludedPath(matcher.isMatch, relativePath, entry.isDirectory())) {
      return `${matcher.label}: ${relativePath}`;
    }
  }

  return null;
}

async function scanDirectory(
  dirPath: string,
  recursive: boolean,
  options: AuditCommandOptions,
  logger: ReturnType<typeof createLogger>,
  scanCtx: ScanContext,
  baseDir?: string,
  nestedConfigLog?: Set<string>
): Promise<ValidationResult[]> {
  const fs = await import('node:fs/promises');
  const results: ValidationResult[] = [];
  const userExcludes = options.exclude ?? [];
  const resolvedBaseDir = baseDir ?? dirPath;

  // The git context (root + tracker) and the run's anchor base are built once by
  // the caller; every recursion reuses them unchanged.
  const resolvedScanCtx = scanCtx;
  const resolvedNestedLog = nestedConfigLog ?? new Set<string>();

  // Top-down pre-warm of findProjectRoot's walk-up cache (spec §8). The first
  // call here drives a single ancestor walk; every subsequent recursion is a
  // Layer-1 hit chain. By the time we reach leaf SKILL.md files,
  // resolveSkillPackagingConfig's per-skill walk-up is all cache hits.
  findProjectRoot(dirPath);

  // Emit a one-time info breadcrumb when we encounter a nested
  // vibe-agent-toolkit.config.yaml that is NOT at the scan root. Configs do
  // not compose across VAT projects; the message reminds operators that
  // only per-skill packaging rules from this config still apply.
  const nestedConfigPath = safePath.join(dirPath, VAT_CONFIG_FILENAME);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirPath is a controlled scan path
  if (dirPath !== resolvedBaseDir && fsExistsSync(nestedConfigPath) && !resolvedNestedLog.has(nestedConfigPath)) {
    resolvedNestedLog.add(nestedConfigPath);
    const rel = safePath.relative(resolvedBaseDir, nestedConfigPath).replaceAll('\\', '/');
    logger.info(
      `Nested vibe-agent-toolkit.config.yaml detected at ${rel} — configs do not compose across VAT projects. Per-skill packaging rules from this config still apply to skills declared in it.`,
    );
  }

  // Compile picomatch for user-supplied --exclude patterns.
  // dot:true so excludes like `**/private/*` match through dotfile dirs
  // (`.claude/.../private/x`); without it the exclude silently never fires.
  // These are relative to the scan base; the config's excludes carry their own
  // (project-root) base on the matcher — see {@link ExcludeMatcher}.
  const excludeMatchers: ExcludeMatcher[] = [];
  if (userExcludes.length > 0) {
    excludeMatchers.push({
      isMatch: picomatch(userExcludes, { dot: true }),
      base: resolvedBaseDir,
      label: 'excluded',
    });
  }
  if (resolvedScanCtx.projectExcludes !== null) {
    excludeMatchers.push(resolvedScanCtx.projectExcludes);
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  const descendCtx = await contextForDescendants(dirPath, entries, resolvedScanCtx);

  // Build full paths and batch-check gitignore status
  const entryPaths = entries.map(e => safePath.join(dirPath, e.name));
  const gitIgnoredMap = buildGitIgnoreMap(entryPaths, resolvedScanCtx.gitTracker, options.includeArtifacts ?? false);

  for (const entry of entries) {
    const fullPath = safePath.join(dirPath, entry.name);

    const skipReason = getSkipReason(entry, fullPath, gitIgnoredMap, excludeMatchers);
    if (skipReason !== null) {
      logger.debug(`Excluding path: ${skipReason}`);
      continue;
    }

    if (entry.isFile()) {
      const result = await handleFileEntry(entry, fullPath, options, logger, resolvedScanCtx);
      if (result !== null) {
        results.push(result);
      }
    } else if (entry.isDirectory()) {
      // `descendCtx`, not `resolvedScanCtx`: this level's own skill (if any)
      // owns everything below, including this subdirectory.
      const dirResults = await handleDirectoryEntry(fullPath, recursive, options, logger, resolvedBaseDir, descendCtx, resolvedNestedLog);
      results.push(...dirResults);
    }
  }

  return results;
}

/**
 * Calculate overall status from validation results
 */
function calculateOverallStatus(results: ValidationResult[]): 'success' | 'warning' | 'error' {
  const errorCount = results.filter((r: ValidationResult) => r.status === 'error').length;
  const warningCount = results.filter((r: ValidationResult) => r.status === 'warning').length;

  if (errorCount > 0) {
    return 'error';
  }
  if (warningCount > 0) {
    return 'warning';
  }
  return 'success';
}

/**
 * How many results carry at least one finding.
 *
 * Counted from the results, not from the rendered hierarchy. The hierarchy is a
 * PROJECTION of the results — in `--verbose` it contains every scanned skill,
 * findings or not, so counting its entries reported "N with issues" equal to the
 * number scanned. The predicate itself is the only thing that answers this.
 */
function countResultsWithFindings(results: ValidationResult[]): number {
  return results.filter((r: ValidationResult) => r.issues.length > 0).length;
}

/**
 * How many FILES ended in each status. A different denominator from
 * {@link SeverityCounts}, which counts FINDINGS — hence the `files` prefix on
 * every field. `summary.warnings: 0` used to sit one line above
 * `issues.warnings: 1` in the same document: the same word, two units, and no
 * way for a reader to tell which one they were looking at.
 */
interface FileStatusCounts {
  filesScanned: number;
  filesPassed: number;
  filesWithWarnings: number;
  filesWithErrors: number;
}

/** Count files by their own status. */
function countFilesByStatus(results: ValidationResult[]): FileStatusCounts {
  return {
    filesScanned: results.length,
    filesPassed: results.filter((r: ValidationResult) => r.status === 'success').length,
    filesWithWarnings: results.filter((r: ValidationResult) => r.status === 'warning').length,
    filesWithErrors: results.filter((r: ValidationResult) => r.status === 'error').length,
  };
}

/**
 * Build base summary structure (used by both flat and hierarchical), together
 * with the entries the document will publish.
 *
 * `issueCounts` is named exactly as it is on every individual file entry, and
 * means the same thing at both levels: findings, by severity. `summary` only ever
 * counts files.
 *
 * The header total and every per-file total come from ONE traversal of the
 * final issue set, and the entries carrying those per-file totals are returned
 * from the same pass. Before that, the header was derived from the issue
 * records while each file's `issueCounts` was whatever its producer had
 * published — and a producer that appends findings after publishing (or never
 * sets the counts at all: `validatePlugin` writes `status` and `summary` but
 * not `issueCounts`) left the two disagreeing inside one document. A real
 * `vat audit --user` run said 55/422/504 in the header over per-file counts
 * summing to 55/360/405, with 91 of 614 entries declaring `{0,0,0}` above the
 * findings they listed. Re-deriving here means the header and the sum are the
 * same arithmetic on the same array, so they cannot drift again no matter what
 * a producer forgets.
 *
 * `linkedFiles[].issues` are deliberately NOT added: every linked finding is
 * also present in its owner's `issues`, so the nested list is a VIEW of records
 * already counted, not extra records. `audit-report-coherence.integration.test.ts`
 * pins that subset relation, because counting once is only correct while it holds.
 */
function buildBaseSummary<T extends ValidationResult>(
  results: T[],
  startTime: number
): {
  entries: T[];
  status: string;
  summary: FileStatusCounts;
  issueCounts: SeverityCounts;
  duration: string;
} {
  const issueCounts: SeverityCounts = { errors: 0, warnings: 0, info: 0 };
  const entries = results.map((result) => {
    const counts = countBySeverity(result.issues);
    issueCounts.errors += counts.errors;
    issueCounts.warnings += counts.warnings;
    issueCounts.info += counts.info;
    return { ...result, issueCounts: counts };
  });

  return {
    entries,
    status: calculateOverallStatus(entries),
    summary: countFilesByStatus(entries),
    issueCounts,
    duration: `${Date.now() - startTime}ms`,
  };
}

/**
 * Calculate summary for hierarchical output
 */
function calculateHierarchicalSummary(
  results: ValidationResult[],
  hierarchical: ReturnType<typeof buildHierarchicalOutput>,
  startTime: number,
  compatMap: Map<string, CompatibilityResult> | undefined,
  verbose: boolean,
  root: string,
) {
  const { entries, ...base } = buildBaseSummary(results, startTime);
  const withCompat = applyCompatMap(entries, compatMap);

  return {
    root,
    ...base,
    summary: {
      ...base.summary,
      marketplaces: hierarchical.marketplaces.length,
      cachedPlugins: hierarchical.cachedPlugins.length,
      standalonePlugins: hierarchical.standalonePlugins.length,
      standaloneSkills: hierarchical.standaloneSkills.length,
    },
    files: relativizePathEntries(applyVerboseFilter(withCompat, verbose), root, NESTED_PATH_CARRIERS),
    hierarchical,
  };
}

/**
 * Log hierarchical summary to stderr
 */
function logHierarchicalSummary(
  results: ValidationResult[],
  logger: ReturnType<typeof createLogger>
): void {
  const status = calculateOverallStatus(results);
  const skillsWithIssues = countResultsWithFindings(results);
  const totalSkills = results.length;

  // Audit is advisory only — always exit 0 for validation results.
  // Use vat skills validate for gated validation (exit 1 on errors).
  if (status === 'error') {
    const errorCount = results.filter((r: ValidationResult) => r.status === 'error').length;
    logger.error(`Audit found ${errorCount} skill(s) with errors (${totalSkills} scanned, ${skillsWithIssues} with issues)`);
  } else if (status === 'warning') {
    const warningCount = results.filter((r: ValidationResult) => r.status === 'warning').length;
    logger.info(`Audit passed with warnings: ${warningCount} skill(s) (${totalSkills} scanned, ${skillsWithIssues} with issues)`);
  } else if (skillsWithIssues > 0) {
    // `success` means "nothing actionable", NOT "nothing to see". Saying only
    // "N passed" over a pile of info findings is how they stayed invisible.
    logger.info(`Audit successful: ${totalSkills} skill(s) passed (${skillsWithIssues} with informational findings)`);
  } else {
    logger.info(`Audit successful: ${totalSkills} skill(s) passed`);
  }

  renderAuditFooter(results, logger);
  process.exit(0);
}
