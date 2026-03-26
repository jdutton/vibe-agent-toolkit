/**
 * `vat build` — top-level build orchestration
 *
 * Builds everything the project describes, in dependency order:
 *   1. vat skills build  (portable dist/skills/ output)
 */

import { spawnSync } from 'node:child_process';

import { Command } from 'commander';

import { handleCommandError } from '../utils/command-error.js';
import { writeYamlOutput } from '../utils/output.js';

import { createPhaseContext, type Phase } from './phase-utils.js';

export interface BuildCommandOptions {
  only?: string;
  debug?: boolean;
}

export function createBuildTopLevelCommand(): Command {
  const command = new Command('build');

  command
    .description('Build all project artifacts in dependency order (skills)')
    .option('--only <phase>', 'Build only a specific phase: skills')
    .option('--debug', 'Enable debug logging')
    .action(buildTopLevelCommand)
    .addHelpText(
      'after',
      `
Description:
  Builds all project artifacts in dependency order. Equivalent to running
  vat skills build.

  Phases:
    skills  → builds dist/skills/ from package.json vat.skills (platform-agnostic)

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

  return phases;
}

async function buildTopLevelCommand(options: BuildCommandOptions): Promise<void> {
  const phases = buildPhaseList(options);
  const { logger, startTime, binPath } = createPhaseContext(options.debug, phases, options.only, 'skills');

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
