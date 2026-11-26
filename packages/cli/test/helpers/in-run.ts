/**
 * Run one phase, or one resource load, inside a run of its own rooted at the
 * project, as the verb that owns it does: a verb opens ONE run per process
 * (`withRunContext`) and every phase reads through it.
 */

import type { PhaseOutcome } from '../../src/commands/phase-utils.js';
import { runResourcesValidatePhase, type ValidateOptions } from '../../src/commands/resources/validate.js';
import { runSkillsValidatePhase, type SkillsValidateCommandOptions } from '../../src/commands/skills/validate.js';
import type { Logger } from '../../src/utils/logger.js';
import { loadResourcesWithConfig, NO_HOME_SETTLED_LISTENER, withRunContext, type ResourceLoadResult } from '../../src/utils/resource-loader.js';

/**
 * `vat skills validate <root>` in a run rooted at `root`.
 *
 * @param root - The project directory, which is also the path argument
 * @param options - The command's options; none by default
 * @returns The phase's outcome
 */
export function skillsValidateInRun(root: string, options: SkillsValidateCommandOptions = {}): Promise<PhaseOutcome> {
  return withRunContext({ projectionStore: 'on-demand', root, tree: 'read-only', outputs: [], homeSettledListener: NO_HOME_SETTLED_LISTENER }, (run) => runSkillsValidatePhase(root, options, run));
}

/**
 * `vat resources validate <root>` in a run rooted at `root`.
 *
 * @param root - The project directory, which is also the path argument
 * @param options - The command's options; none by default
 * @returns The phase's outcome
 */
export function resourcesValidateInRun(
  root: string,
  options: ValidateOptions = {},
): Promise<PhaseOutcome> {
  return withRunContext({ projectionStore: 'on-demand', root, tree: 'read-only', outputs: [], homeSettledListener: NO_HOME_SETTLED_LISTENER }, (run) => runResourcesValidatePhase(root, options, run));
}

/**
 * One resource load in a run rooted at `projectRoot`.
 *
 * @param pathArg - The path argument, if any
 * @param projectRoot - The run's root, which is the load's project root
 * @param logger - The logger
 * @returns The load result
 */
export function loadResourcesInRun(pathArg: string | undefined, projectRoot: string, logger: Logger): Promise<ResourceLoadResult> {
  return withRunContext({ projectionStore: 'on-demand', root: projectRoot, tree: 'read-only', outputs: [], homeSettledListener: NO_HOME_SETTLED_LISTENER }, (run) => loadResourcesWithConfig(pathArg, run, logger));
}
