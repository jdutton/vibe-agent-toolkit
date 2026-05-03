/**
 * Audit command - audits plugins, marketplaces, registries, and Agent Skills
 * Top-level command: vat audit [path]
 */

import type { Dirent } from 'node:fs';
import * as fs from 'node:fs';
import { existsSync as fsExistsSync } from 'node:fs';

import {
  detectResourceFormat,
  enumerateSurfaces,
  validate,
  validateMarketplace,
  validateSkill,
  validateSkillForPackaging,
  type EvidenceRecord,
  type PackagingValidationResult,
  type SkillPackagingConfig,
  type Surface,
  type ValidateOptions,
  type ValidationIssue,
  type ValidationResult,
} from '@vibe-agent-toolkit/agent-skills';
import {
  analyzeCompatibility,
  checkSettingsCompatibility,
  getClaudeUserPaths,
  readEffectiveSettings,
  validatePlugin,
  type CompatibilityResult,
  type EffectiveSettings,
  type Target,
} from '@vibe-agent-toolkit/claude-marketplace';
import { detectFormat } from '@vibe-agent-toolkit/discovery';
import { gitFindRoot, GitTracker, isAbsolutePath, safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';
import picomatch from 'picomatch';

import { handleCommandError } from '../utils/command-error.js';
import {
  findGoverningConfig,
  loadConfig,
  resetGoverningConfigCache,
} from '../utils/config-loader.js';
import { isGitUrl, parseGitUrl } from '../utils/git-url.js';
import { createLogger } from '../utils/logger.js';
import { writeYamlOutput } from '../utils/output.js';
import { renderSkillQualityFooter } from '../utils/skill-quality-footer.js';
import { computeConfigVerdicts } from '../utils/verdict-helpers.js';

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

/**
 * Merge per-skill config for audit: keeps all packaging options but strips
 * validation.allow (audit shows everything). Preserves validation.severity.
 *
 * Strips undefined values from the spread to satisfy exactOptionalPropertyTypes.
 */
function mergeSkillConfigForAudit(
  defaults: Record<string, unknown> | undefined,
  perSkillOverrides: Record<string, unknown> | undefined
): SkillPackagingConfig {
  const merged = { ...defaults, ...perSkillOverrides };
  const packagingConfig: SkillPackagingConfig = {};

  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined && key !== 'validation') {
      (packagingConfig as Record<string, unknown>)[key] = value;
    }
  }

  // Keep validation.severity but strip validation.allow
  const mergedValidation = merged['validation'] as { severity?: unknown; allow?: unknown } | undefined;
  if (mergedValidation?.severity !== undefined) {
    (packagingConfig as Record<string, unknown>)['validation'] = { severity: mergedValidation.severity };
  }

  return packagingConfig;
}

const VAT_CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';

/**
 * Cache of `configRoot → (absSkillPath → skillName)` derived from
 * `discoverSkillsFromConfig`. Audit walks up from each SKILL.md it discovers
 * to the skill's nearest-ancestor config; re-expanding the governing config's
 * skills-globs per skill is O(N²) on multi-skill packages and dominates audit
 * wall time on Windows (per-path FS spawns amplify the cost). The cache
 * collapses it back to one expansion per configRoot per audit invocation.
 *
 * Invalidated at the top of {@link auditCommand} alongside the other scoped
 * caches so test suites that mutate fixtures between in-process audits do not
 * see stale discovery data.
 */
const configSkillDiscoveryCache: Map<string, Map<string, string>> = new Map();

function resetConfigSkillDiscoveryCache(): void {
  configSkillDiscoveryCache.clear();
}

async function getDiscoveredSkillsByPath(
  skillsSection: NonNullable<ReturnType<typeof loadConfig>>['skills'],
  configRoot: string,
): Promise<Map<string, string>> {
  const cached = configSkillDiscoveryCache.get(configRoot);
  if (cached !== undefined) {
    return cached;
  }
  const map = new Map<string, string>();
  if (skillsSection !== undefined) {
    const discovered = await discoverSkillsFromConfig(skillsSection, configRoot);
    for (const entry of discovered) {
      map.set(safePath.resolve(entry.sourcePath), entry.name);
    }
  }
  configSkillDiscoveryCache.set(configRoot, map);
  return map;
}

/**
 * Build config-aware context for a single VAT project at `scanRoot`.
 *
 * VAT's design: one `vibe-agent-toolkit.config.yaml` per project. Configs do
 * NOT compose across projects. This helper loads only the config at
 * `scanRoot` (no walk) and expands its declared skills into a map keyed by
 * absolute SKILL.md path.
 *
 * Used by compat analysis to resolve the plugin-level `targets` union. For
 * scan-time per-skill validation, see {@link findGoverningConfig} — audit
 * walks UP from each discovered SKILL.md to its nearest-ancestor config so
 * per-skill packaging rules still apply when auditing from above a project.
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
      const packagingConfig = mergeSkillConfigForAudit(
        defaults as Record<string, unknown> | undefined,
        perSkillConfig?.[skill.name] as Record<string, unknown> | undefined,
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
 * Resolve the per-skill packaging config for a single discovered SKILL.md.
 *
 * Walks UP from the skill's directory to the nearest-ancestor
 * `vibe-agent-toolkit.config.yaml`. If that config declares a matching skill
 * (by resolving its `skills.include`/`config` globs and comparing sourcePath
 * to this skill's absolute path), merges `skills.defaults` + the per-skill
 * `skills.config[name]` block via {@link mergeSkillConfigForAudit} and
 * returns the result.
 *
 * Returns `null` in "wild mode" cases: no governing config, the config has no
 * `skills` section, or the skill is not declared in any `skills.config[name]`
 * entry. Callers should fall back to basic (non-packaging) validation.
 *
 * Does NOT merge across configs — audit does not compose configs across VAT
 * projects. Only the nearest-ancestor config contributes.
 */
async function resolveSkillPackagingConfig(
  skillPath: string,
): Promise<SkillPackagingConfig | null> {
  const absSkillPath = safePath.resolve(skillPath);
  const skillDir = safePath.resolve(safePath.join(absSkillPath, '..'));
  const governing = findGoverningConfig(skillDir);
  if (governing === null) return null;

  const { config, configRoot } = governing;
  if (config.skills === undefined) return null;

  const { defaults, config: perSkillConfig } = config.skills;

  // Find which declared skill (by name) corresponds to this skill path.
  // The discovery map is cached per governing configRoot so audits against
  // multi-skill packages don't re-expand the same globs N times.
  let matchedName: string | undefined;
  try {
    const byPath = await getDiscoveredSkillsByPath(config.skills, configRoot);
    matchedName = byPath.get(absSkillPath);
  } catch {
    return null;
  }

  if (matchedName === undefined) {
    // Governing config exists but does not declare this skill — fall back to
    // wild mode (no config composition across unrelated skills).
    return null;
  }

  return mergeSkillConfigForAudit(
    defaults as Record<string, unknown> | undefined,
    perSkillConfig?.[matchedName] as Record<string, unknown> | undefined,
  );
}

/**
 * Convert PackagingValidationResult to ValidationResult for consistent audit output.
 * In audit mode, we merge allErrors (which includes both errors and warnings after
 * severity resolution but WITHOUT allow suppression) into the standard issues array.
 *
 * Compat verdicts (COMPAT_TARGET_*) are computed from the result's observations
 * and the config-level targets, then merged into the issue list.
 */
function packagingResultToValidationResult(
  skillPath: string,
  result: PackagingValidationResult,
  configTargets: ReadonlyArray<Target> | undefined,
): ValidationResult {
  // allErrors contains all emitted issues (errors + warnings) after severity resolution
  // but without allow suppression — exactly what audit wants. Verdicts are
  // computed from the observations carried on the result.
  const verdictIssues = computeConfigVerdicts(result.observations, configTargets, skillPath);
  const issues = verdictIssues.length > 0
    ? [...result.allErrors, ...verdictIssues]
    : result.allErrors;
  const errorCount = issues.filter(i => i.severity === 'error').length;
  const warningCount = issues.filter(i => i.severity === 'warning').length;
  const infoCount = issues.filter(i => i.severity === 'info').length;

  let status: ValidationResult['status'];
  if (errorCount > 0) {
    status = 'error';
  } else if (warningCount > 0) {
    status = 'warning';
  } else {
    status = 'success';
  }

  const out: ValidationResult = {
    path: skillPath,
    type: RESOURCE_TYPE_AGENT_SKILL,
    status,
    summary: `${errorCount} errors, ${warningCount} warnings, ${infoCount} info`,
    issues,
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
 */
async function validateSingleSkill(
  skillPath: string,
  options: AuditCommandOptions,
  logger: ReturnType<typeof createLogger>,
  isVATGenerated?: boolean
): Promise<ValidationResult> {
  // Try config-aware validation: walk UP to the skill's nearest-ancestor
  // vibe-agent-toolkit.config.yaml and apply the skill's packaging block.
  const skillConfig = await resolveSkillPackagingConfig(skillPath);
  if (skillConfig !== null) {
    logger.debug(`  Using config-aware validation for: ${skillPath}`);
    const { gitTracker } = await resolveScanContext(safePath.resolve(skillPath));
    const sharedCtx = gitTracker === null ? undefined : { gitTracker };
    const packagingResult = await validateSkillForPackaging(skillPath, skillConfig, 'source', sharedCtx);
    return packagingResultToValidationResult(
      skillPath,
      packagingResult,
      skillConfig.targets as readonly Target[] | undefined,
    );
  }

  // Fallback: basic validation
  const validateOptions: ValidateOptions = { skillPath };
  if (options.warnUnreferencedFiles) {
    validateOptions.checkUnreferencedFiles = true;
  }
  if (isVATGenerated === true) {
    validateOptions.isVATGenerated = true;
  }
  return validateSkill(validateOptions);
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
      'Path or git URL to audit. URL forms: https://host/owner/repo.git[#ref[:subpath]], git@host:owner/repo.git, ssh://..., owner/repo (GitHub shorthand), or a GitHub web URL like https://github.com/owner/repo/tree/<ref>/<subpath>. Default: current directory.'
    )
    .option('--no-recursive', 'Disable recursive directory scanning (scans top level only)')
    .option('--exclude <glob>', 'Exclude paths matching glob pattern (repeatable)', collect, [])
    .option('--include-artifacts', 'Include gitignored paths (build artifacts, dependencies) that are excluded by default')
    .option('--user', 'Audit user-level Claude resources (default: $CLAUDE_CONFIG_DIR or ~/.claude — scans plugins/, skills/, marketplaces/)')
    .option('--verbose', 'Show all scanned resources, including those without issues')
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
  When given a URL, VAT shallow-clones to a temp directory, audits, and
  cleans up on exit. See packages/cli/docs/audit.md for URL forms.
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
  When a vibe-agent-toolkit.config.yaml is found at the git root, audit
  uses the project's build settings (linkFollowDepth, files,
  excludeReferencesFromBundle) to validate skills. This prevents false
  warnings for links that the build pipeline resolves.

  Config-aware mode never applies validation.allow — audit always shows
  all issues. validation.severity is respected for display grouping.

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
 * Handle --user audit: scans ~/.claude/plugins, ~/.claude/skills, ~/.claude/marketplaces
 * and outputs hierarchical YAML. Calls process.exit() when done.
 */
async function auditUserDirectories(
  recursive: boolean,
  options: AuditCommandOptions,
  startTime: number,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  const { pluginsDir, skillsDir, marketplacesDir } = getClaudeUserPaths();

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

  if (pluginsDirExists) {
    logger.debug(`Auditing user-level plugins at: ${pluginsDir}`);
    results.push(...await getValidationResults(pluginsDir, recursive, options, logger));
  }

  if (skillsDirExists) {
    logger.debug(`Auditing user-level skills at: ${skillsDir}`);
    results.push(...await getValidationResults(skillsDir, recursive, options, logger));
  }

  if (marketplacesDirExists) {
    logger.debug(`Auditing user-level marketplaces at: ${marketplacesDir}`);
    results.push(...await getValidationResults(marketplacesDir, recursive, options, logger));
  }

  // Run compatibility analysis if --compat flag is set
  const compatMap = options.compat
    ? await runCompatAnalysis(results, logger)  // --settings not supported in --user mode
    : undefined;

  const verbose = options.verbose ?? false;
  const skillResults = results.filter((r: ValidationResult) => SKILL_RESULT_TYPES.has(r.type));
  const hierarchical = buildHierarchicalOutput(skillResults, verbose);
  const summary = calculateHierarchicalSummary(results, hierarchical, startTime, compatMap, verbose);
  writeYamlOutput(summary);
  if (verbose) {
    renderVerboseEvidence(results, logger);
  }
  logHierarchicalSummary(results, hierarchical, logger);
}

/**
 * Apply severity filtering to validation results.
 *
 * Audit is advisory only: it applies `validation.severity` to decide what to
 * show, but deliberately ignores `validation.allow`. Codes configured as
 * `severity: 'ignore'` are stripped from the result issues before rendering.
 *
 * The severity config is per-skill, keyed by skill name in
 * `config.skills.config[skillName].validation.severity`.
 * Defaults config (`config.skills.defaults.validation.severity`) is also
 * checked as a fallback.
 *
 * @param results - Raw validation results from skill/plugin validators
 * @param config - Parsed VATConfig (may be undefined if no config file)
 * @returns New results array with ignored codes removed from issues
 */
/** Skill resource types that can have per-skill validation config. */
const SKILL_RESULT_TYPES: ReadonlySet<ValidationResult['type']> = new Set([RESOURCE_TYPE_AGENT_SKILL, 'vat-agent']);

/**
 * Derive the project root directory for config loading.
 *
 * For a direct SKILL.md path, the project root is two levels up (skill dir → skills/ → project/).
 * For a directory or undefined path, use the directory itself (or cwd).
 */
function deriveConfigRoot(targetPath: string | undefined): string {
  if (targetPath === undefined) {
    return process.cwd();
  }
  if (targetPath.endsWith('SKILL.md')) {
    return safePath.resolve(safePath.join(targetPath, '..', '..'));
  }
  return safePath.resolve(targetPath);
}

/**
 * Build the recalculated status and summary after issues have been filtered.
 */
function buildFilteredResult(
  result: ValidationResult,
  filteredIssues: ValidationResult['issues']
): ValidationResult {
  const errorCount = filteredIssues.filter(i => i.severity === 'error').length;
  const warningCount = filteredIssues.filter(i => i.severity === 'warning').length;
  const infoCount = filteredIssues.filter(i => i.severity === 'info').length;

  let status: ValidationResult['status'];
  if (errorCount > 0) {
    status = 'error';
  } else if (warningCount > 0) {
    status = 'warning';
  } else {
    status = 'success';
  }

  return {
    ...result,
    status,
    summary: `${errorCount} errors, ${warningCount} warnings, ${infoCount} info`,
    issues: filteredIssues,
  };
}

/**
 * Apply severity filtering to validation results.
 *
 * Audit is advisory only: it applies `validation.severity` to decide what to
 * show, but deliberately ignores `validation.allow`. Codes configured as
 * `severity: 'ignore'` are stripped from the result issues before rendering.
 *
 * The severity config is per-skill, keyed by skill name in
 * `config.skills.config[skillName].validation.severity`.
 * Defaults config (`config.skills.defaults.validation.severity`) is also
 * checked as a fallback.
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
    if (!SKILL_RESULT_TYPES.has(result.type)) {
      return result;
    }

    const skillName = result.metadata?.name;
    const perSkillSeverity = skillName === undefined
      ? {}
      : (skillsConfig.config?.[skillName]?.validation?.severity ?? {});

    // Merge: per-skill overrides default
    const effectiveSeverity: Record<string, string> = { ...defaultSeverity, ...perSkillSeverity };

    if (Object.keys(effectiveSeverity).length === 0) {
      return result;
    }

    const filteredIssues = result.issues.filter(issue => effectiveSeverity[issue.code] !== 'ignore');

    if (filteredIssues.length === result.issues.length) {
      return result;
    }

    return buildFilteredResult(result, filteredIssues);
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

async function runAuditAtPath(
  scanPath: string,
  options: AuditCommandOptions,
  overrides: AuditAtPathOverrides = {}
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();
  const recursive: boolean = options.recursive !== false;
  logger.debug(`Auditing resources at: ${scanPath}`);

  const rawResults = await getValidationResults(scanPath, recursive, options, logger);

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
    ? await runCompatAnalysis(results, logger, effectiveSettings, vatContextForCompat)
    : undefined;

  const verbose = options.verbose ?? false;
  const summary = calculateSummary(results, startTime, compatMap, verbose);

  const finalSummary =
    overrides.tempRoot === undefined ? summary : rewritePathsInResults(summary, overrides.tempRoot);
  if (overrides.provenance) {
    process.stdout.write(renderProvenanceHeader(overrides.provenance));
  }
  writeYamlOutput(finalSummary);
  if (verbose) {
    renderVerboseEvidence(results, logger);
  }
  handleAuditResults(results, summary, logger);
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
    if (targetPath !== undefined && isGitUrl(targetPath)) {
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
): Promise<ValidationResult> {
  if (surface.type === RESOURCE_TYPE_AGENT_SKILL) {
    return validateSingleSkill(surface.path, options, logger);
  }
  if (surface.type === RESOURCE_TYPE_CLAUDE_PLUGIN) {
    return validatePlugin(surface.path);
  }
  return validateMarketplace(surface.path);
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
): Promise<ValidationResult[]> {
  logger.debug(
    `Detected ${surfaces.length.toString()} surfaces at ${scanPath}: ${surfaces.map((s) => s.type).join(', ')}`,
  );
  const results: ValidationResult[] = [];
  for (const surface of surfaces) {
    results.push(await validateSurface(surface, options, logger));
  }
  return results;
}

/**
 * For a Claude plugin directory, validate every skill it ships under
 * `<plugin>/skills/<name>/SKILL.md` and append the per-skill results.
 *
 * Plugins enumerate their skills via filesystem layout: each direct subdir
 * of `skills/` containing a `SKILL.md` is a distinct skill. Reference files
 * (no SKILL.md at the subdir root) are not separate skills and are reached
 * transitively when their parent skill is validated.
 *
 * Without this, `vat audit <plugin-dir>` would only validate `plugin.json`
 * and silently skip every skill the plugin ships — an asymmetry with
 * `vat audit <random-dir>`, which scans the markdown tree.
 */
async function validatePluginSkills(
  pluginPath: string,
  options: AuditCommandOptions,
  logger: ReturnType<typeof createLogger>,
): Promise<ValidationResult[]> {
  const skillsDir = safePath.join(pluginPath, 'skills');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- pluginPath is a controlled scan path
  if (!fsExistsSync(skillsDir)) {
    return [];
  }
  const fsp = await import('node:fs/promises');
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: ValidationResult[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = safePath.join(skillsDir, entry.name, 'SKILL.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- composed under skillsDir
    if (!fsExistsSync(skillPath)) continue;
    logger.debug(`  Validating plugin-bundled skill: ${skillPath}`);
    results.push(await validateSingleSkill(skillPath, options, logger));
  }
  return results;
}

/**
 * @internal Exported for integration testing only — not part of the public CLI API.
 */
export async function getValidationResults(
  scanPath: string,
  recursive: boolean,
  options: AuditCommandOptions,
  logger: ReturnType<typeof createLogger>
): Promise<ValidationResult[]> {
  const format = detectFormat(scanPath);

  // Special handling for direct SKILL.md file
  if (format === RESOURCE_TYPE_AGENT_SKILL) {
    logger.debug('Detected single Agent Skill');
    return [await validateSingleSkill(scanPath, options, logger)];
  }

  // Special handling for VAT agent: validate its SKILL.md
  if (format === 'vat-agent') {
    const skillPath = safePath.join(scanPath, 'SKILL.md');
    logger.debug('Detected VAT agent, validating SKILL.md');
    return [await validateSingleSkill(skillPath, options, logger, true)];
  }

  // Enumerate all manifest surfaces at the directory root. If multiple are
  // present (e.g., skill-claude-plugin: SKILL.md + .claude-plugin/plugin.json),
  // validate each independently. This intentionally bypasses
  // detectResourceFormat's single-answer collapse so the skill surface is not
  // swallowed by the plugin surface.
  const surfaces = await enumerateSurfaces(scanPath);
  if (surfaces.length > 1) {
    const surfaceResults = await validateMultipleSurfaces(surfaces, scanPath, options, logger);
    if (surfaces.some((s) => s.type === RESOURCE_TYPE_CLAUDE_PLUGIN)) {
      surfaceResults.push(...(await validatePluginSkills(scanPath, options, logger)));
    }
    return surfaceResults;
  }

  // For plugin/marketplace directories or registry files, use unified validator
  const resourceFormat = await detectResourceFormat(scanPath);

  if (resourceFormat.type !== 'unknown') {
    logger.debug(`Detected ${resourceFormat.type} at: ${scanPath}`);
    const result = await validate(scanPath, { validatePlugin });
    if (resourceFormat.type === RESOURCE_TYPE_CLAUDE_PLUGIN) {
      await appendPluginAssetParseIssues(result, scanPath);
      // Also validate every skill the plugin ships. Without this, audit
      // would short-circuit on the manifest and never open skill content.
      const skillResults = await validatePluginSkills(scanPath, options, logger);
      return [result, ...skillResults];
    }
    return [result];
  }

  // If unknown format, check if it's a directory we can scan
  const fs = await import('node:fs/promises');
  try {
    const stat = await fs.stat(scanPath);
    if (stat.isDirectory()) {
      logger.debug('Scanning directory for resources');

      // Merge resources.exclude from config with --exclude CLI flag patterns.
      // Both use the same picomatch semantics. Do NOT mutate options.
      const config = loadConfig(deriveConfigRoot(scanPath));
      const configExcludes = config?.resources?.exclude ?? [];
      const mergedOptions: AuditCommandOptions =
        configExcludes.length > 0
          ? { ...options, exclude: [...(options.exclude ?? []), ...configExcludes] }
          : options;

      return scanDirectory(scanPath, recursive, mergedOptions, logger);
    }
  } catch {
    // Path doesn't exist or not accessible, let validate() handle it
  }

  // Unknown resource type - use unified validator which will return appropriate error
  logger.debug(`Unknown resource type at: ${scanPath}`);
  const result = await validate(scanPath);
  return [result];
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
      const compat = await analyzeCompatibility(result.path, analyzeOptions);

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

function calculateSummary(
  results: ValidationResult[],
  startTime: number,
  compatMap: Map<string, CompatibilityResult> | undefined,
  verbose: boolean,
) {
  const base = buildBaseSummary(results, startTime);
  const withCompat = applyCompatMap(results, compatMap);
  return {
    ...base,
    files: applyVerboseFilter(withCompat, verbose),
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
 * Render supporting evidence beneath each CAPABILITY_* issue when the
 * audit was invoked with --verbose. Evidence comes from the validation
 * result itself (per-file SKILL evidence) and from any attached
 * `compatibility.evidence` (plugin-level scanner output).
 */
function renderVerboseEvidence(
  results: Array<ValidationResult & { compatibility?: CompatibilityResult }>,
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

    logger.info(`\n${result.path} — supporting evidence:`);
    for (const issue of capabilityIssues) {
      renderIssueEvidence(issue, evidenceSources, logger);
    }
  }
}

function handleAuditResults(
  results: ValidationResult[],
  summary: { summary: { errors: number; warnings: number; success: number }; files?: Array<{ compatibility?: CompatibilityResult }> },
  logger: ReturnType<typeof createLogger>
): void {
  const { errors: errorCount, warnings: warningCount, success: successCount } = summary.summary;

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
    logErrors(results, errorCount, logger);
  } else if (warningCount > 0) {
    logWarnings(results, warningCount, logger);
  } else {
    logger.info(`Audit successful: ${successCount} file(s) passed`);
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

function logErrors(
  results: ValidationResult[],
  errorCount: number,
  logger: ReturnType<typeof createLogger>
): void {
  logger.error(`Audit failed: ${errorCount} file(s) with errors`);
  const errorResults = results.filter((r: ValidationResult) => r.status === 'error');

  for (const result of errorResults) {
    logger.error(`\n${result.path}:`);
    const errorIssues = result.issues.filter((i: { severity: string }) => i.severity === 'error');
    logIssues(errorIssues, logger.error.bind(logger));
  }
}

function logWarnings(
  results: ValidationResult[],
  warningCount: number,
  logger: ReturnType<typeof createLogger>
): void {
  logger.info(`Audit passed with warnings: ${warningCount} file(s)`);
  const warningResults = results.filter((r: ValidationResult) => r.status === 'warning');

  for (const result of warningResults) {
    logger.info(`\n${result.path}:`);
    const warningIssues = result.issues.filter((i: { severity: string }) => i.severity === 'warning');
    logIssues(warningIssues, logger.info.bind(logger));
  }
}

function logIssues(
  issues: Array<{ code: string; message: string; location?: string; fix?: string }>,
  logFn: (message: string) => void
): void {
  for (const issue of issues) {
    logFn(`  [${issue.code}] ${issue.message}`);
    if (issue.location) {
      logFn(`    at: ${issue.location}`);
    }
    if (issue.fix) {
      logFn(`    fix: ${issue.fix}`);
    }
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
 * Handle file entry during directory scan
 */
async function handleFileEntry(
  entry: { name: string },
  fullPath: string,
  options: AuditCommandOptions,
  logger: ReturnType<typeof createLogger>,
  scanCtx: ScanContext,
): Promise<ValidationResult | null> {
  // Check for registry files
  if (entry.name === 'installed_plugins.json' || entry.name === 'known_marketplaces.json') {
    logger.debug(`Validating registry: ${fullPath}`);
    return validate(fullPath);
  }

  // Check for SKILL.md
  if (entry.name === 'SKILL.md') {
    logger.debug(`Validating Agent Skill: ${fullPath}`);

    // Config-aware: walk UP to the skill's nearest-ancestor config and apply
    // ONLY that skill's declared packaging rules. Configs do not compose
    // across VAT projects — audit does not merge rules across sibling configs.
    const skillConfig = await resolveSkillPackagingConfig(fullPath);
    if (skillConfig !== null) {
      logger.debug(`  Using config-aware validation for: ${fullPath}`);
      // Thread the per-scan tracker into packaging validation so gitignore
      // checks in the link-graph walk stay O(1).
      const sharedCtx = scanCtx.gitTracker === null ? undefined : { gitTracker: scanCtx.gitTracker };
      const packagingResult = await validateSkillForPackaging(fullPath, skillConfig, 'source', sharedCtx);
      return packagingResultToValidationResult(
        fullPath,
        packagingResult,
        skillConfig.targets as readonly Target[] | undefined,
      );
    }

    // Wild mode: basic validation
    const validateOptions: ValidateOptions = { skillPath: fullPath };
    if (options.warnUnreferencedFiles) {
      validateOptions.checkUnreferencedFiles = true;
    }
    return validateSkill(validateOptions);
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
  nestedConfigLog: Set<string>
): Promise<ValidationResult[]> {
  const fs = await import('node:fs/promises');
  const results: ValidationResult[] = [];

  // Check if directory contains a plugin or marketplace
  const claudePluginDir = safePath.join(fullPath, '.claude-plugin');
  const hasClaudePlugin = await fs.access(claudePluginDir).then(() => true).catch(() => false);

  if (hasClaudePlugin) {
    logger.debug(`Validating resource directory: ${fullPath}`);
    const result = await validate(fullPath, { validatePlugin });
    await appendPluginAssetParseIssues(result, fullPath);
    results.push(result);
  }

  // Recurse into subdirectories (both plugin/marketplace dirs and regular dirs)
  if (recursive) {
    const subResults = await scanDirectory(fullPath, recursive, options, logger, baseDir, scanCtx, nestedConfigLog);
    results.push(...subResults);
  }

  return results;
}

/**
 * Parse-only checks for full-plugin assets (hooks/hooks.json, .mcp.json).
 *
 * Appends error-severity findings to the plugin's ValidationResult when these
 * files are malformed. Does not throw — `vat audit` is advisory-only and must
 * always exit 0 for validation results.
 */
async function appendPluginAssetParseIssues(
  result: ValidationResult,
  pluginRoot: string,
): Promise<void> {
  const fs = await import('node:fs/promises');
  const checks: Array<{ path: string; label: string }> = [
    { path: safePath.join(pluginRoot, 'hooks', 'hooks.json'), label: 'hooks/hooks.json' },
    { path: safePath.join(pluginRoot, '.mcp.json'), label: '.mcp.json' },
  ];

  for (const { path, label } of checks) {
    let raw: string;
    try {
      raw = await fs.readFile(path, 'utf-8');
    } catch {
      continue;
    }
    try {
      JSON.parse(raw);
    } catch (e) {
      const issue: ValidationIssue = {
        severity: 'error',
        code: 'PLUGIN_INVALID_JSON',
        message: `${label} is not valid JSON: ${(e as Error).message}`,
        location: path,
      };
      result.issues.push(issue);
      result.status = 'error';
    }
  }
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
}

/** Cache of (gitRoot → initialized GitTracker) to avoid re-spawning ls-files. */
const gitTrackerCache: Map<string, GitTracker> = new Map();

/**
 * Reset all module-level audit caches. Must be called at the start of every
 * independent audit invocation so in-process callers (CLI entrypoint AND
 * integration tests that share a vitest worker) don't observe stale trackers,
 * governing configs, or skill-discovery maps from a prior run.
 */
export function resetAuditCaches(): void {
  gitTrackerCache.clear();
  resetGoverningConfigCache();
  resetConfigSkillDiscoveryCache();
}

async function getOrCreateGitTracker(gitRoot: string): Promise<GitTracker> {
  const cached = gitTrackerCache.get(gitRoot);
  if (cached !== undefined) {
    return cached;
  }
  const tracker = new GitTracker(gitRoot);
  await tracker.initialize();
  gitTrackerCache.set(gitRoot, tracker);
  return tracker;
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
async function resolveScanContext(dirPath: string): Promise<ScanContext> {
  const detectedRoot = gitFindRoot(dirPath);
  if (detectedRoot === null) {
    return { gitRoot: null, gitTracker: null };
  }

  const tracker = await getOrCreateGitTracker(detectedRoot);

  // If the scan root itself is gitignored (e.g. user targeted `dist/`), disable
  // gitignore filtering so the user's explicit intent wins.
  if (tracker.isIgnoredByActiveSet(dirPath)) {
    return { gitRoot: null, gitTracker: null };
  }

  return { gitRoot: detectedRoot, gitTracker: tracker };
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
  resolvedBaseDir: string,
  gitIgnoredMap: Map<string, boolean> | null,
  isMatch: ReturnType<typeof picomatch> | null
): string | null {
  // Always skip .git directory (not reported by git check-ignore)
  if (entry.isDirectory() && entry.name === '.git') {
    return '.git';
  }

  // Skip gitignored paths
  if (gitIgnoredMap !== null && gitIgnoredMap.get(fullPath) === true) {
    return `gitignored: ${entry.name}`;
  }

  // Check user-supplied --exclude patterns
  if (isMatch !== null) {
    const relativePath = safePath.relative(resolvedBaseDir, fullPath).replaceAll('\\', '/');
    if (isExcludedPath(isMatch, relativePath, entry.isDirectory())) {
      return `excluded: ${relativePath}`;
    }
  }

  return null;
}

async function scanDirectory(
  dirPath: string,
  recursive: boolean,
  options: AuditCommandOptions,
  logger: ReturnType<typeof createLogger>,
  baseDir?: string,
  scanCtx?: ScanContext,
  nestedConfigLog?: Set<string>
): Promise<ValidationResult[]> {
  const fs = await import('node:fs/promises');
  const results: ValidationResult[] = [];
  const userExcludes = options.exclude ?? [];
  const resolvedBaseDir = baseDir ?? dirPath;

  // First call in this scan: build the git context (root + tracker) once; every
  // subsequent recursion reuses them.
  const resolvedScanCtx: ScanContext = scanCtx ?? (await resolveScanContext(dirPath));
  const resolvedNestedLog = nestedConfigLog ?? new Set<string>();

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

  // Compile picomatch for user-supplied --exclude patterns
  const isMatch = userExcludes.length > 0 ? picomatch(userExcludes) : null;

  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  // Build full paths and batch-check gitignore status
  const entryPaths = entries.map(e => safePath.join(dirPath, e.name));
  const gitIgnoredMap = buildGitIgnoreMap(entryPaths, resolvedScanCtx.gitTracker, options.includeArtifacts ?? false);

  for (const entry of entries) {
    const fullPath = safePath.join(dirPath, entry.name);

    const skipReason = getSkipReason(entry, fullPath, resolvedBaseDir, gitIgnoredMap, isMatch);
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
      const dirResults = await handleDirectoryEntry(fullPath, recursive, options, logger, resolvedBaseDir, resolvedScanCtx, resolvedNestedLog);
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
 * Count all skills in hierarchical output
 */
function countAllSkills(hierarchical: ReturnType<typeof buildHierarchicalOutput>): number {
  let total = 0;

  // Count marketplace skills
  for (const marketplace of hierarchical.marketplaces) {
    for (const plugin of marketplace.plugins) {
      total += plugin.skills.length;
    }
  }

  // Count cached plugin skills
  for (const plugin of hierarchical.cachedPlugins) {
    total += plugin.skills.length;
  }

  // Count standalone plugin skills
  for (const plugin of hierarchical.standalonePlugins) {
    total += plugin.skills.length;
  }

  // Count standalone skills
  total += hierarchical.standaloneSkills.length;

  return total;
}

/**
 * Calculate issue counts from validation results
 */
function calculateIssueCounts(results: ValidationResult[]) {
  const successCount = results.filter((r: ValidationResult) => r.status === 'success').length;
  const warningCount = results.filter((r: ValidationResult) => r.status === 'warning').length;
  const errorCount = results.filter((r: ValidationResult) => r.status === 'error').length;

  const totalErrors = results.reduce((sum: number, r: ValidationResult) =>
    sum + r.issues.filter(i => i.severity === 'error').length, 0
  );
  const totalWarnings = results.reduce((sum: number, r: ValidationResult) =>
    sum + r.issues.filter(i => i.severity === 'warning').length, 0
  );
  const totalInfo = results.reduce((sum: number, r: ValidationResult) =>
    sum + r.issues.filter(i => i.severity === 'info').length, 0
  );

  return {
    successCount,
    warningCount,
    errorCount,
    totalErrors,
    totalWarnings,
    totalInfo,
  };
}

/**
 * Build base summary structure (used by both flat and hierarchical)
 */
function buildBaseSummary(
  results: ValidationResult[],
  startTime: number
): {
  status: string;
  summary: { filesScanned: number; success: number; warnings: number; errors: number };
  issues: { errors: number; warnings: number; info: number };
  duration: string;
} {
  const counts = calculateIssueCounts(results);
  const status = calculateOverallStatus(results);

  return {
    status,
    summary: {
      filesScanned: results.length,
      success: counts.successCount,
      warnings: counts.warningCount,
      errors: counts.errorCount,
    },
    issues: {
      errors: counts.totalErrors,
      warnings: counts.totalWarnings,
      info: counts.totalInfo,
    },
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
) {
  const base = buildBaseSummary(results, startTime);
  const withCompat = applyCompatMap(results, compatMap);

  return {
    ...base,
    summary: {
      ...base.summary,
      marketplaces: hierarchical.marketplaces.length,
      cachedPlugins: hierarchical.cachedPlugins.length,
      standalonePlugins: hierarchical.standalonePlugins.length,
      standaloneSkills: hierarchical.standaloneSkills.length,
    },
    files: applyVerboseFilter(withCompat, verbose),
    hierarchical,
  };
}

/**
 * Log hierarchical summary to stderr
 */
function logHierarchicalSummary(
  results: ValidationResult[],
  hierarchical: ReturnType<typeof buildHierarchicalOutput>,
  logger: ReturnType<typeof createLogger>
): void {
  const status = calculateOverallStatus(results);
  const skillsWithIssues = countAllSkills(hierarchical);
  const totalSkills = results.length;

  // Audit is advisory only — always exit 0 for validation results.
  // Use vat skills validate for gated validation (exit 1 on errors).
  if (status === 'error') {
    const errorCount = results.filter((r: ValidationResult) => r.status === 'error').length;
    logger.error(`Audit found ${errorCount} skill(s) with errors (${totalSkills} scanned, ${skillsWithIssues} with issues)`);
  } else if (status === 'warning') {
    const warningCount = results.filter((r: ValidationResult) => r.status === 'warning').length;
    logger.info(`Audit passed with warnings: ${warningCount} skill(s) (${totalSkills} scanned, ${skillsWithIssues} with issues)`);
  } else {
    logger.info(`Audit successful: ${totalSkills} skill(s) passed`);
  }

  renderAuditFooter(results, logger);
  process.exit(0);
}
