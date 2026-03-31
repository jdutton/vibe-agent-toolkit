/**
 * `vat verify` — top-level verification orchestration
 *
 * Validates everything in scope, in dependency order:
 *   1. vat resources validate  (link integrity, collection schemas)
 *   2. vat skills validate     (SKILL.md frontmatter validation)
 */

import { Command } from 'commander';

import { handleCommandError } from '../utils/command-error.js';
import { writeYamlOutput } from '../utils/output.js';

import { createPhaseContext, runPhase, type Phase, type PhaseResult } from './phase-utils.js';

export interface VerifyCommandOptions {
  only?: string;
  debug?: boolean;
}

export function createVerifyTopLevelCommand(): Command {
  const command = new Command('verify');

  command
    .description('Verify all project artifacts in dependency order (resources → skills)')
    .option('--only <phase>', 'Verify only a specific phase: resources, skills')
    .option('--debug', 'Enable debug logging')
    .action(verifyTopLevelCommand)
    .addHelpText(
      'after',
      `
Description:
  Validates all project artifacts without building anything. Each phase
  validates different aspects of the project.

  Phases:
    resources  → link integrity, collection frontmatter schemas
    skills     → SKILL.md frontmatter and packaging validation

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
`
    );

  return command;
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

  return phases;
}

async function verifyTopLevelCommand(options: VerifyCommandOptions): Promise<void> {
  const phases = buildPhaseList(options);
  const { logger, startTime, binPath } = createPhaseContext(options.debug, phases, options.only, 'resources, skills');

  try {
    logger.info(`🔍 vat verify (phases: ${phases.map((p) => p.name).join(' → ')})`);

    const phaseResults: PhaseResult[] = [];
    for (const phase of phases) {
      logger.info(`\n▶ Phase: ${phase.name}`);
      phaseResults.push(runPhase(binPath, phase));
    }

    const hasErrors = phaseResults.some((r) => r.status === 'failed');
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
