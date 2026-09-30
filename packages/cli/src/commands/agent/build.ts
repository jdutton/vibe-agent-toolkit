/**
 * Agent build command - Package agents for deployment targets
 */

import { buildAgentSkill, isSkillPackagingInputError } from '@vibe-agent-toolkit/agent-skills';
import { buildReport, toFindings, type Gate } from '@vibe-agent-toolkit/schema';
import { issueLocation, relativeEscapesRoot, safePath } from '@vibe-agent-toolkit/utils';

import { resolveAgentPath } from '../../utils/agent-discovery.js';
import { CommandRefusalError, refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, NOTHING_FINISHED, type FinishedWork } from '../../utils/document-writer.js';
import { createLogger } from '../../utils/logger.js';
import { requireProjectRoot } from '../../utils/project-root-policy.js';
import { packagingFailedIssue } from '../skills/build.js';

import type { AgentBuildReport } from './build-schema.js';

export interface BuildCommandOptions {
  target?: string;
  output?: string;
  debug?: boolean;
}

/** `vat agent build` has no `--strict` and publishes no finding: the gate is fixed. */
const GATE: Gate = { strict: false };

/** The one deployment target VAT builds. */
const SKILL_TARGET = 'skill';

/** One agent per run. */
const AGENTS_BUILT = 1;

/**
 * Build an agent for a specific deployment target
 */
export async function buildCommand(
  pathOrName: string,
  options: BuildCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  let report: AgentBuildReport;
  // Kept outside the try: a packager refusal is located at the agent, under the project root.
  let projectRoot: string | undefined;
  let agentPath: string | undefined;
  try {
    // Spec §7: `vat agent build` requires a projectRoot.
    projectRoot = requireProjectRoot(process.cwd(), 'vat agent build');

    // A target VAT does not build is the invocation's mistake, refused before the agent is resolved or read.
    const target = options.target ?? SKILL_TARGET;
    if (target !== SKILL_TARGET) {
      throw new CommandRefusalError('USAGE_INVALID', `Unsupported build target: ${target} (supported: ${SKILL_TARGET})`);
    }

    agentPath = await resolveAgentPath(pathOrName, logger);
    logger.debug(`Agent path resolved: ${agentPath}`);

    logger.info('Building Agent Skill...');
    // Only pass outputPath if explicitly provided by user
    const result = await buildAgentSkill(options.output ? { agentPath, target, outputPath: options.output } : { agentPath, target });

    const durationMs = Date.now() - startTime;
    logger.info(`Build completed in ${durationMs}ms`);
    logger.info(`Output: ${result.outputPath}`);

    report = buildReport({
      examined: AGENTS_BUILT,
      findings: [],
      data: { agent: result.agent.name, target, output: result.outputPath, files: result.files },
      gate: GATE,
      durationMs,
    });
  } catch (error) {
    const refusal = buildRefusalOf(error, agentPath, projectRoot);
    endWithRefusal('agent build', refusal.code, error, 'yaml', GATE, refusal.finished);
  }
  endWithReport('agent build', report, 'yaml');
}

/**
 * The refusal a build that threw ends on. A coded cause keeps its own code. The
 * packager refusing the generated bundle's content — content the adopter's
 * prompt and output directory decide — is the `SKILL_PACKAGING_FAILED` finding
 * at the agent on a run that stopped (`RUN_INCOMPLETE`), as `vat skill test run`
 * publishes it; anything uncoded is a defect, `INTERNAL_ERROR`.
 */
function buildRefusalOf(
  error: unknown,
  agentPath: string | undefined,
  projectRoot: string | undefined,
): { code: ReturnType<typeof refusalCodeOf>; finished: FinishedWork } {
  const code = refusalCodeOf(error);
  if (code !== 'INTERNAL_ERROR' || !isSkillPackagingInputError(error)) return { code, finished: NOTHING_FINISHED };
  const issue = packagingFailedIssue(error instanceof Error ? error.message : String(error), agentLocation(agentPath, projectRoot));
  return { code: 'RUN_INCOMPLETE', finished: { examined: 0, findings: toFindings([issue]), data: null } };
}

/** The agent's path relative to the project root, or `undefined` when it is outside it (or unknown). */
function agentLocation(agentPath: string | undefined, projectRoot: string | undefined): string | undefined {
  if (agentPath === undefined || projectRoot === undefined) return undefined;
  const location = issueLocation(safePath.resolve(agentPath), projectRoot);
  return relativeEscapesRoot(location) ? undefined : location;
}
