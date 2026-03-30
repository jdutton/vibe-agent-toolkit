/**
 * `vat build` — top-level build orchestration
 *
 * Builds everything the project describes, in dependency order:
 *   1. vat skills build       (portable dist/skills/ output)
 *   2. vat claude plugin build (Claude plugin tree, skipped if no claude config)
 */

import { spawnSync } from 'node:child_process';

import { Command } from 'commander';

import { handleCommandError } from '../utils/command-error.js';
import { loadConfig } from '../utils/config-loader.js';
import { writeYamlOutput } from '../utils/output.js';

import { createPhaseContext, type Phase } from './phase-utils.js';

export interface BuildCommandOptions {
  only?: string;
  debug?: boolean;
}

export function createBuildTopLevelCommand(): Command {
  const command = new Command('build');

  command
    .description('Build all project artifacts in dependency order (skills → claude plugin tree)')
    .option('--only <phase>', 'Build only a specific phase: skills, claude')
    .option('--debug', 'Enable debug logging')
    .action(buildTopLevelCommand)
    .addHelpText(
      'after',
      `
Description:
  Builds all project artifacts in dependency order.

  Phases:
    skills  → builds dist/skills/ from vibe-agent-toolkit.config.yaml (platform-agnostic)
    claude  → builds dist/.claude/plugins/ from dist/skills/ + config (skipped if no claude config)

Output:
  YAML summary for each phase → stdout
  Build progress → stderr

Exit Codes:
  0 - All phases completed successfully
  1 - Build error
  2 - System error

Example:
  $ vat build                         # Build everything
  $ vat build --only skills           # Build portable skills only
  $ vat build --only claude           # Build Claude plugin tree only
`
    );

  return command;
}

/**
 * Check whether the current project has a claude.marketplaces config.
 * Returns false if no config file found or no claude section.
 */
function hasClaudeMarketplacesConfig(cwd: string): boolean {
  try {
    const config = loadConfig(cwd);
    return Boolean(config?.claude?.marketplaces && Object.keys(config.claude.marketplaces).length > 0);
  } catch {
    return false;
  }
}

function buildPhaseList(options: BuildCommandOptions, cwd: string): Phase[] {
  const { only } = options;
  const phases: Phase[] = [];

  if (!only || only === 'skills') {
    phases.push({ name: 'skills', args: ['skills', 'build'] });
  }

  if (!only || only === 'claude') {
    // Only include the claude phase when a marketplace config is present
    if (hasClaudeMarketplacesConfig(cwd)) {
      phases.push({ name: 'claude', args: ['claude', 'plugin', 'build'] });
    }
  }

  return phases;
}

async function buildTopLevelCommand(options: BuildCommandOptions): Promise<void> {
  const cwd = process.cwd();
  const phases = buildPhaseList(options, cwd);
  const { logger, startTime, binPath } = createPhaseContext(options.debug, phases, options.only, 'skills, claude');

  try {
    logger.info(`🔨 vat build (phases: ${phases.map((p) => p.name).join(' → ')})`);

    for (const phase of phases) {
      logger.info(`\n▶ Phase: ${phase.name}`);
      const result = spawnSync(process.execPath, [binPath, ...phase.args], {
        stdio: ['inherit', 'inherit', 'inherit'],
      });

      if (result.status !== 0) {
        const duration = Date.now() - startTime;
        writeYamlOutput({
          status: 'error',
          error: `Phase '${phase.name}' failed with exit code ${result.status ?? 'unknown'}`,
          phase: phase.name,
          duration: `${duration}ms`,
        });
        process.exit(result.status ?? 1);
      }
    }

    const duration = Date.now() - startTime;
    logger.info(`\n✅ Build complete`);
    writeYamlOutput({
      status: 'success',
      phasesCompleted: phases.map((p) => p.name),
      duration: `${duration}ms`,
    });

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Build');
  }
}
