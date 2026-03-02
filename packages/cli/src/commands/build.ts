/**
 * `vat build` — top-level build orchestration
 *
 * Builds everything the project describes, in dependency order:
 *   1. vat skills build  (portable dist/skills/ output)
 *   2. vat claude build  (Claude plugin artifacts)
 */

import { spawnSync } from 'node:child_process';

import { Command } from 'commander';

import { handleCommandError } from '../utils/command-error.js';
import { writeYamlOutput } from '../utils/output.js';

import { buildClaudePhaseArgs, createPhaseContext, type Phase } from './phase-utils.js';

export interface BuildCommandOptions {
  only?: string;
  marketplace?: string;
  debug?: boolean;
}

export function createBuildTopLevelCommand(): Command {
  const command = new Command('build');

  command
    .description('Build all project artifacts in dependency order (skills → claude plugins)')
    .option('--only <phase>', 'Build only a specific phase: skills, claude')
    .option('--marketplace <name>', 'Build specific marketplace only (claude phase)')
    .option('--debug', 'Enable debug logging')
    .action(buildTopLevelCommand)
    .addHelpText(
      'after',
      `
Description:
  Builds all project artifacts in dependency order. Equivalent to running
  vat skills build followed by vat claude build.

  Phases:
    skills  → builds dist/skills/ from package.json vat.skills (platform-agnostic)
    claude  → wraps dist/skills/ into Claude plugin structure (requires skills phase)

Output:
  YAML summary for each phase → stdout
  Build progress → stderr

Exit Codes:
  0 - All phases completed successfully
  1 - Build error
  2 - System error

Examples:
  $ vat build                         # Build everything
  $ vat build --only skills           # Build portable skills only
  $ vat build --only claude           # Build Claude artifacts only (skills must be pre-built)
  $ vat build --marketplace acme      # Build specific marketplace
`
    );

  return command;
}

function buildPhaseList(options: BuildCommandOptions): Phase[] {
  const { only } = options;
  const phases: Phase[] = [];

  if (!only || only === 'skills') {
    phases.push({ name: 'skills', args: ['skills', 'build'] });
  }

  if (!only || only === 'claude') {
    phases.push({ name: 'claude', args: buildClaudePhaseArgs('build', options) });
  }

  return phases;
}

async function buildTopLevelCommand(options: BuildCommandOptions): Promise<void> {
  const phases = buildPhaseList(options);
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
