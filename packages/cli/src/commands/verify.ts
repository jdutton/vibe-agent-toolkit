/**
 * `vat verify` — top-level verification orchestration
 *
 * Validates everything in scope, in dependency order:
 *   1. vat resources validate  (link integrity, collection schemas)
 *   2. vat skills validate     (SKILL.md frontmatter validation)
 *   3. vat claude marketplace validate  (strict marketplace validation, when configured)
 *   4. consistency check  (skill distribution integrity — package.json, plugin assignment)
 */

import { existsSync } from 'node:fs';

import { computeTreeCopiedSkillLocations, mergeFilesConfig } from '@vibe-agent-toolkit/agent-skills';
import { safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { handleCommandError } from '../utils/command-error.js';
import { loadConfig } from '../utils/config-loader.js';
import { createLogger } from '../utils/logger.js';
import { writeYamlOutput } from '../utils/output.js';
import { requireProjectRoot } from '../utils/project-root-policy.js';

import { runConsistencyChecks, type ConsistencyIssue } from './consistency-check.js';
import { resolveBinPath, runPhase, type Phase, type PhaseResult } from './phase-utils.js';
import { discoverSkillsFromConfig } from './skills/skill-discovery.js';

export interface VerifyCommandOptions {
  only?: string;
  debug?: boolean;
}

export function createVerifyTopLevelCommand(): Command {
  const command = new Command('verify');

  command
    .description('Verify built artifacts (resources + skills + marketplace + consistency); marketplace/consistency read dist/ — run after vat build')
    .option('--only <phase>', 'Verify only a specific phase: resources, skills, marketplace, consistency')
    .option('--debug', 'Enable debug logging')
    .action(verifyTopLevelCommand)
    .addHelpText(
      'after',
      `
Description:
  Verifies all project artifacts. The marketplace and consistency phases
  read the built dist/ tree, so run this after 'vat build'.

  For source-only validation that needs no build (resources + skills,
  suitable for pre-commit and CI-before-build), use 'vat validate'.

  Phases:
    resources    → link integrity, collection frontmatter schemas
    skills       → SKILL.md frontmatter and packaging validation
    marketplace  → strict marketplace validation (when configured)
    consistency  → skill distribution integrity (package.json, plugin assignment)

Output:
  YAML summary for each phase → stdout
  Validation errors → stderr

Exit Codes:
  0 - All phases passed
  1 - Validation errors found
  2 - System error

Requirements:
  projectRoot: required (errors if no vibe-agent-toolkit.config.yaml or .git/ ancestor)
  config:      required file (used to discover phases and outputs)

  See docs/concepts/roots-and-config.md for terminology.

Example:
  $ vat verify                         # Verify everything
  $ vat verify --only skills           # Verify skills only
  $ vat verify --only marketplace      # Verify marketplace only
`
    );

  return command;
}

/** Result of checking files config dests for a single (skill, outputDir) pair */
export interface FilesDestCheckResult {
  skillName: string;
  /** The actual output directory that was checked (pool dir or plugin-tree dir). */
  outputDir: string;
  missing: string[];
}

/**
 * Sanitize skill names with colon namespaces for filesystem paths.
 * Mirrors the logic in build.ts.
 */
function skillNameToFsPath(name: string): string {
  return name.replaceAll(':', '__');
}

/** Internal pending-check record: one per (skillName, outputDir) candidate. */
type CheckEntry = {
  skillName: string;
  outputDir: string;
  mergedFiles: ReturnType<typeof mergeFilesConfig>;
};

/**
 * Register a check for (skillName, outputDir, mergedFiles) in the dedup map.
 *
 * Skips silently if:
 *   - mergedFiles is empty (no entries to verify)
 *   - outputDir does not exist on disk (not a candidate)
 *   - the key was already added (dedup guard)
 */
function tryAddCheckEntry(
  checks: Map<string, CheckEntry>,
  skillName: string,
  outputDir: string,
  mergedFiles: ReturnType<typeof mergeFilesConfig>,
): void {
  if (mergedFiles.length === 0) return;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- outputDir is resolved from config, not user input
  if (!existsSync(outputDir)) return;
  const key = `${skillName}\0${outputDir}`;
  if (!checks.has(key)) {
    checks.set(key, { skillName, outputDir, mergedFiles });
  }
}

/**
 * Check that all dest paths from the merged files config exist in the built output.
 *
 * Checks each skill's dests in the location(s) where `vat build` actually wrote them:
 *   - Pool skills: `dist/skills/<fsName>/`            (only when that dir exists)
 *   - Tree-copy skills: `dist/.claude/plugins/.../skills/<name>/` (only when that dir exists)
 *
 * A dest is "missing" ONLY when absent from a candidate dir that exists. If a skill
 * has no existing candidate dir, it is not reported (build didn't run for that mode).
 *
 * @returns One result per (skill, outputDir) pair where dests are absent.
 */
export function checkFilesConfigDests(cwd: string): FilesDestCheckResult[] {
  try {
    const config = loadConfig(cwd);
    if (!config) return [];

    const skillsConfig = config.skills;
    const defaults = skillsConfig?.defaults;

    // Dedup map: key = `skillName\0outputDir` → check entry
    const checks = new Map<string, CheckEntry>();

    // --- Pool/config skills: candidate dir is dist/skills/<fsName> ---
    for (const skillName of Object.keys(skillsConfig?.config ?? {})) {
      const perSkill = skillsConfig?.config?.[skillName];
      const mergedFiles = mergeFilesConfig(defaults?.files, perSkill?.files);
      const outputDir = safePath.resolve(cwd, 'dist', 'skills', skillNameToFsPath(skillName));
      tryAddCheckEntry(checks, skillName, outputDir, mergedFiles);
    }

    // --- Tree-copy skills: candidate dirs are plugin output skill dirs ---
    for (const loc of computeTreeCopiedSkillLocations(config, cwd)) {
      const perSkill = skillsConfig?.config?.[loc.skillDirName];
      const mergedFiles = mergeFilesConfig(defaults?.files, perSkill?.files);
      tryAddCheckEntry(checks, loc.skillDirName, loc.skillOutputDir, mergedFiles);
    }

    // --- Run each pending check and collect results ---
    const results: FilesDestCheckResult[] = [];
    for (const { skillName, outputDir, mergedFiles } of checks.values()) {
      const missing: string[] = [];
      for (const entry of mergedFiles) {
        const destPath = safePath.resolve(outputDir, entry.dest);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- destPath resolved from config
        if (!existsSync(destPath)) {
          missing.push(entry.dest);
        }
      }
      if (missing.length > 0) {
        results.push({ skillName, outputDir, missing });
      }
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Check whether the current project has claude.marketplaces configured.
 * Returns the marketplace names if present, empty array otherwise.
 */
function getClaudeMarketplaceNames(): string[] {
  try {
    const config = loadConfig(process.cwd());
    if (config?.claude?.marketplaces) {
      return Object.keys(config.claude.marketplaces);
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Log files-config-dests errors to stderr.
 */
function reportFilesDestErrors(
  results: FilesDestCheckResult[],
  logger: ReturnType<typeof createLogger>
): void {
  logger.error('\n▶ Phase: files-config-dests');
  for (const { skillName, outputDir, missing } of results) {
    logger.error(`  Skill '${skillName}': missing dest file(s) in ${outputDir}/:`);
    for (const dest of missing) {
      logger.error(`    - ${dest}`);
    }
  }
}

/**
 * Log consistency check issues to stderr.
 */
function reportConsistencyIssues(
  issues: ConsistencyIssue[],
  logger: ReturnType<typeof createLogger>
): void {
  logger.error('\n▶ Phase: consistency');

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const infos = issues.filter((i) => i.severity === 'info');

  for (const issue of errors) {
    logger.error(`  ERROR [${issue.code}]: ${issue.message}`);
    logger.error(`    Fix: ${issue.fix}`);
  }
  for (const issue of warnings) {
    logger.error(`  WARN [${issue.code}]: ${issue.message}`);
    logger.error(`    Fix: ${issue.fix}`);
  }
  for (const issue of infos) {
    logger.info(`  INFO [${issue.code}]: ${issue.message}`);
  }
}

function buildPhaseList(options: VerifyCommandOptions): Phase[] {
  const { only } = options;
  const phases: Phase[] = [];

  if (!only || only === 'resources') {
    phases.push({ name: 'resources', args: ['resources', 'validate'] });
  }

  if (!only || only === 'skills') {
    phases.push({ name: 'skills', args: ['skills', 'validate'] });
  }

  if (!only || only === 'marketplace') {
    // Only add marketplace phase(s) when config exists and has marketplaces
    const marketplaceNames = getClaudeMarketplaceNames();
    for (const name of marketplaceNames) {
      const marketplaceBuildPath = `dist/.claude/plugins/marketplaces/${name}`;
      phases.push({
        name: `marketplace:${name}`,
        args: ['claude', 'marketplace', 'validate', marketplaceBuildPath],
      });
    }
  }

  return phases;
}

/**
 * Run the consistency check phase and return whether errors were found.
 */
async function runConsistencyPhase(
  logger: ReturnType<typeof createLogger>,
  phaseResults: PhaseResult[]
): Promise<boolean> {
  const config = loadConfig(process.cwd());
  if (!config?.skills) {
    return false;
  }

  const discoveredSkills = await discoverSkillsFromConfig(config.skills, process.cwd());
  const consistencyResult = runConsistencyChecks(discoveredSkills, config, process.cwd());

  if (consistencyResult.summary.errors > 0) {
    reportConsistencyIssues(consistencyResult.issues, logger);
    phaseResults.push({ name: 'consistency', status: 'failed' });
    return true;
  }

  if (consistencyResult.summary.warnings > 0 || consistencyResult.summary.infos > 0) {
    reportConsistencyIssues(consistencyResult.issues, logger);
  }
  phaseResults.push({ name: 'consistency', status: 'passed' });
  return false;
}

async function verifyTopLevelCommand(options: VerifyCommandOptions): Promise<void> {
  // Spec §7: `vat verify` requires a projectRoot.
  requireProjectRoot(process.cwd(), 'vat verify');

  const phases = buildPhaseList(options);

  // Consistency is an in-process phase, not a subprocess. Allow --only consistency
  // to produce an empty subprocess phase list without throwing.
  if (phases.length === 0 && options.only !== 'consistency') {
    throw new Error(`Unknown phase: ${options.only ?? ''}. Valid phases: resources, skills, marketplace, consistency`);
  }

  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();
  const binPath = resolveBinPath();

  try {
    logger.info(`🔍 vat verify (phases: ${phases.map((p) => p.name).join(' → ')})`);

    const phaseResults: PhaseResult[] = [];
    for (const phase of phases) {
      logger.info(`\n▶ Phase: ${phase.name}`);
      phaseResults.push(runPhase(binPath, phase));
    }

    let hasErrors = phaseResults.some((r) => r.status === 'failed');

    // Post-build files config check: verify all dest paths exist in built output
    if (!options.only || options.only === 'skills') {
      const filesDestResults = checkFilesConfigDests(process.cwd());
      if (filesDestResults.length > 0) {
        hasErrors = true;
        reportFilesDestErrors(filesDestResults, logger);
        phaseResults.push({ name: 'files-config-dests', status: 'failed' });
      }
    }

    // Consistency check: cross-reference discovered skills vs package.json and plugin assignments
    if (!options.only || options.only === 'consistency' || options.only === 'skills') {
      const consistencyHasErrors = await runConsistencyPhase(logger, phaseResults);
      if (consistencyHasErrors) {
        hasErrors = true;
      }
    }

    const duration = Date.now() - startTime;

    writeYamlOutput({
      status: hasErrors ? 'error' : 'success',
      phases: phaseResults,
      duration: `${duration}ms`,
    });

    process.exit(hasErrors ? 1 : 0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Verify');
  }
}
