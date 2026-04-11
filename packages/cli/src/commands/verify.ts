/**
 * `vat verify` — top-level verification orchestration
 *
 * Validates everything in scope, in dependency order:
 *   1. vat resources validate  (link integrity, collection schemas)
 *   2. vat skills validate     (SKILL.md frontmatter validation)
 *   3. vat claude marketplace validate  (strict marketplace validation, when configured)
 */

import { existsSync } from 'node:fs';

import { mergeFilesConfig } from '@vibe-agent-toolkit/agent-skills';
import { safePath } from '@vibe-agent-toolkit/utils';
import { Command } from 'commander';

import { handleCommandError } from '../utils/command-error.js';
import { loadConfig } from '../utils/config-loader.js';
import { type createLogger } from '../utils/logger.js';
import { writeYamlOutput } from '../utils/output.js';

import { createPhaseContext, runPhase, type Phase, type PhaseResult } from './phase-utils.js';

export interface VerifyCommandOptions {
  only?: string;
  debug?: boolean;
}

export function createVerifyTopLevelCommand(): Command {
  const command = new Command('verify');

  command
    .description('Verify all project artifacts in dependency order (resources → skills → marketplace)')
    .option('--only <phase>', 'Verify only a specific phase: resources, skills, marketplace')
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

async function verifyTopLevelCommand(options: VerifyCommandOptions): Promise<void> {
  const phases = buildPhaseList(options);
  const { logger, startTime, binPath } = createPhaseContext(options.debug, phases, options.only, 'resources, skills, marketplace');

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
