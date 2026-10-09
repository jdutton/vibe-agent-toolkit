/**
 * Uninstall agent from Agent Skills directory
 */

import { buildReport, toFindings, type Gate } from '@vibe-agent-toolkit/schema';
import { applyTreePlanOrLeftover, planTreeChanges } from '@vibe-agent-toolkit/utils';

import { CommandRefusalError, refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, type FinishedWork, leftoverIssueOf, NOTHING_FINISHED } from '../../utils/document-writer.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { validateAndGetScopeLocation } from '../../utils/scope-locations.js';

import { agentInstallPath } from './install-path.js';
import type { AgentUninstallData } from './uninstall-schema.js';

export interface UninstallOptions {
  scope?: 'user' | 'project';
  runtime?: string;
  debug?: boolean;
}

/** `vat agent uninstall` has no `--strict`, and its only finding is a leftover warning: the gate is fixed. */
const GATE: Gate = { strict: false };

/** What an uninstall finished: the removal, and — when the OS would not then delete the install it moved aside — that failure. */
interface Uninstalled {
  readonly data: AgentUninstallData;
  readonly leftover?: unknown;
}

/**
 * Uninstall agent command. A refusal before the install left its path
 * publishes NOTHING_FINISHED: nothing changed. Once it is moved off its path
 * the uninstall is done; a deletion the OS then stops is still RUN_INCOMPLETE,
 * but publishes the finished removal beside a TREE_CLEANUP_INCOMPLETE warning
 * naming where the moved-aside install now is.
 */
export async function uninstallAgent(
  agentName: string,
  options: UninstallOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  let uninstalled: Uninstalled;
  try {
    uninstalled = await uninstall(agentName, options, logger);
  } catch (error) {
    return refuse(error, NOTHING_FINISHED);
  }
  const { data, leftover } = uninstalled;
  if (leftover !== undefined) return refuse(leftover, { examined: 1, findings: toFindings([leftoverIssueOf(leftover)]), data });
  logger.debug(`Uninstall completed in ${Date.now() - startTime}ms`);
  endWithReport('agent uninstall', buildReport({ examined: 1, findings: [], data, gate: GATE, durationMs: Date.now() - startTime }), 'yaml');
}

/** End on the envelope's error branch: `error` refused, `finished` the work done before it. */
function refuse(error: unknown, finished: FinishedWork): never {
  return endWithRefusal('agent uninstall', refusalCodeOf(error), error, 'yaml', GATE, finished);
}

/** The removal itself; every throw carries the refusal code of its cause. */
async function uninstall(agentName: string, options: UninstallOptions, logger: Logger): Promise<Uninstalled> {
  const { runtime = 'agent-skill', scope = 'user' } = options;

  const targetLocation = validateAndGetScopeLocation(runtime, scope);

  // Refused by name before anything is examined: the positional is the one
  // thing on this path the user typed, and a recursive removal is where it ends up.
  const installPath = agentInstallPath(targetLocation, agentName);

  // ONE remove plan: the install is renamed off its path whole, then removed, so a removal the OS
  // stops never leaves half an install where the user looks. The plan examines the ENTRY (`lstat`):
  // a `--dev` link whose build was cleaned is dangling and still installed, and only the link goes,
  // never its target. A refused examination is a fault on the install this verb removes (`destination`).
  const plan = await planTreeChanges([{ op: 'remove', dest: installPath, ownership: { kind: 'force' }, label: `agent ${agentName}` }]);
  const [planned] = plan.changes;
  if (planned === undefined || planned.existing === 'absent') {
    throw new CommandRefusalError('USAGE_INVALID', `${agentName} is not installed at ${installPath}`);
  }
  const wasSymlink = planned.existing === 'link';

  const { leftover } = await applyTreePlanOrLeftover(plan);

  if (wasSymlink) {
    logger.info(`✓ Removed symlink for ${agentName} from ${installPath}`);
  } else {
    logger.info(`✓ Uninstalled ${agentName} from ${installPath}`);
  }

  const data = { agent: agentName, installPath, wasSymlink };
  return leftover === undefined ? { data } : { data, leftover };
}
