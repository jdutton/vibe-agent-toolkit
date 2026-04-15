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

import { mergeFilesConfig } from '@vibe-agent-toolkit/agent-skills';
import { safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { handleCommandError } from '../utils/command-error.js';
import { loadConfig } from '../utils/config-loader.js';
import { createLogger } from '../utils/logger.js';
import { writeYamlOutput } from '../utils/output.js';

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
    .description('Verify all project artifacts in dependency order (resources → skills → marketplace → consistency)')
    .option('--only <phase>', 'Verify only a specific phase: resources, skills, marketplace, consistency')
    .option('--debug', 'Enable debug logging')
    .action(verifyTopLevelCommand)
    .addHelpText(
      'after',
      `
Description:
  Validates all project artifacts without building anything. Each phase
  validates different aspects of the project.

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

Example:
  $ vat verify                         # Verify everything
  $ vat verify --only skills           # Verify skills only
  $ vat verify --only marketplace      # Verify marketplace only
`
    );

  return command;
}

/** Result of checking files config dests for a single skill */
interface FilesDestCheckResult {
  skillName: string;
  missing: string[];
}

/**
 * Sanitize skill names with colon namespaces for filesystem paths.
 * Mirrors the logic in build.ts.
 */
function skillNameToFsPath(name: string): string {
  return name.replaceAll(':', '__');
}

/**
 * Check that all dest paths from the merged files config exist in the built output.
 * Returns one result per skill that has files config entries.
 */
function checkFilesConfigDests(cwd: string): FilesDestCheckResult[] {
  try {
    const config = loadConfig(cwd);
    if (!config?.skills?.config && !config?.skills?.defaults?.files) {
      return [];
    }

    const skillsConfig = config.skills;
    const results: FilesDestCheckResult[] = [];

    // Collect all skill names from config
    const skillNames = Object.keys(skillsConfig.config ?? {});

    // Also check defaults-only (no per-skill config) — but we need skill names for output paths.
    // If there's no per-skill config we can't know which skills to check without discovery,
    // so we only check skills that are explicitly listed in config.
    for (const skillName of skillNames) {
      const perSkill = skillsConfig.config?.[skillName];
      const defaults = skillsConfig.defaults;

      const mergedFiles = mergeFilesConfig(defaults?.files, perSkill?.files);
      if (mergedFiles.length === 0) {
        continue;
      }

      const outputDir = safePath.resolve(cwd, 'dist', 'skills', skillNameToFsPath(skillName));
      const missing: string[] = [];

      for (const entry of mergedFiles) {
        const destPath = safePath.resolve(outputDir, entry.dest);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- destPath resolved from config
        if (!existsSync(destPath)) {
          missing.push(entry.dest);
        }
      }

      if (missing.length > 0) {
        results.push({ skillName, missing });
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
  for (const { skillName, missing } of results) {
    logger.error(`  Skill '${skillName}': missing dest file(s) in dist/skills/${skillNameToFsPath(skillName)}/:`);
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
