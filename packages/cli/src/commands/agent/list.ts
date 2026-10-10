/**
 * Agent list command - discovers and lists all agents
 */

import { materializeIssue } from '@vibe-agent-toolkit/agent-skills';
import { buildReport, toFindings, type Gate, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { AGENT_SEARCH_PATHS, surveyAgents, type DiscoveredAgent, type UnreadableAgentPath } from '../../utils/agent-discovery.js';
import { refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, NOTHING_FINISHED } from '../../utils/document-writer.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { relativizePathEntries } from '../../utils/relativize-paths.js';

import type { AgentListData, AgentListReport } from './list-schema.js';

export interface ListCommandOptions {
  debug?: boolean;
}

/** `vat agent list` has no `--strict`; an unreadable search path is a warning: the gate is fixed. */
const GATE: Gate = { strict: false };

/**
 * Build the agent-list `data`.
 *
 * Pure, so the payload's shape — including the fact that `path` is root-relative
 * — is under unit test rather than only under a CLI spawn. `root` is stated
 * once and is the only absolute path in the document; without it a relative
 * `path` is unresolvable, and with absolute paths the payload names the machine
 * it ran on. No `manifestPath`: it is derivable.
 */
export function buildAgentListData(agents: readonly DiscoveredAgent[], root: string): AgentListData {
  const reported = agents.map(agent => ({ name: agent.name, version: agent.version, path: agent.path }));
  return { root, agents: relativizePathEntries(reported, root) };
}

export async function listCommand(options: ListCommandOptions): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  let report: AgentListReport;
  try {
    logger.debug(`Search paths: ${AGENT_SEARCH_PATHS.join(', ')}`);

    const { agents, unreadable } = await surveyAgents();

    // `surveyAgents` resolves its search paths against cwd, so cwd — not a
    // config/git projectRoot — is the honest base for what it found.
    const root = safePath.resolve(process.cwd());
    const data = buildAgentListData(agents, root);
    logAgents(data, logger);

    report = buildReport({
      examined: AGENT_SEARCH_PATHS.length,
      findings: toFindings(unreadable.map(gap => unreadablePathFinding(gap, root))),
      data,
      gate: GATE,
      durationMs: Date.now() - startTime,
    });
  } catch (error) {
    return endWithRefusal('agent list', refusalCodeOf(error), error, 'yaml', GATE, NOTHING_FINISHED);
  }
  endWithReport('agent list', report, 'yaml');
}

/** The human listing, on stderr. */
function logAgents(data: AgentListData, logger: Logger): void {
  if (data.agents.length === 0) {
    logger.info('No agents discovered');
    return;
  }
  logger.info(`Found ${data.agents.length} agent(s):`);
  for (const agent of data.agents) {
    logger.info(`  ${agent.name} (${agent.version ?? 'no version'}) - ${agent.path}`);
  }
}

/**
 * The warning for a path discovery could not read: the listing is then a
 * floor. Located relative to `root`, with the errno in the detail.
 */
function unreadablePathFinding(gap: UnreadableAgentPath, root: string): ValidationIssue {
  const where = toForwardSlash(safePath.relative(root, gap.path)) || '.';
  return materializeIssue('SCAN_PATH_UNREADABLE', {
    location: where,
    detail: `${where}: read was refused with ${gap.errno}; any agent beneath it is missing from this list`,
  });
}
