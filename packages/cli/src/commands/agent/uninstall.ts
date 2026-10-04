/**
 * Uninstall agent from Agent Skills directory
 */

import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';

import { codedUserStateWrite } from '@vibe-agent-toolkit/claude-marketplace';
import { buildReport, type Gate } from '@vibe-agent-toolkit/schema';
import { isPathAbsentError } from '@vibe-agent-toolkit/utils';

import { CommandRefusalError, refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, NOTHING_FINISHED } from '../../utils/document-writer.js';
import { createLogger, type Logger } from '../../utils/logger.js';
import { unstatablePathRefusal } from '../../utils/project-root-policy.js';
import { validateAndGetScopeLocation } from '../../utils/scope-locations.js';

import { agentInstallPath } from './install-path.js';
import type { AgentUninstallData } from './uninstall-schema.js';

export interface UninstallOptions {
  scope?: 'user' | 'project';
  runtime?: string;
  debug?: boolean;
}

/** `vat agent uninstall` has no `--strict`, and an uninstall carries no finding: the gate is fixed. */
const GATE: Gate = { strict: false };

/**
 * Uninstall agent command. Every refusal publishes NOTHING_FINISHED: the one
 * unit of work is the removal, and a run that refused did not remove it.
 */
export async function uninstallAgent(
  agentName: string,
  options: UninstallOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  let data: AgentUninstallData;
  try {
    data = await uninstall(agentName, options, logger);
  } catch (error) {
    return endWithRefusal('agent uninstall', refusalCodeOf(error), error, 'yaml', GATE, NOTHING_FINISHED);
  }
  logger.debug(`Uninstall completed in ${Date.now() - startTime}ms`);
  endWithReport('agent uninstall', buildReport({ examined: 1, findings: [], data, gate: GATE, durationMs: Date.now() - startTime }), 'yaml');
}

/** The removal itself; every throw carries the refusal code of its cause. */
async function uninstall(agentName: string, options: UninstallOptions, logger: Logger): Promise<AgentUninstallData> {
  const { runtime = 'agent-skill', scope = 'user' } = options;

  const targetLocation = validateAndGetScopeLocation(runtime, scope);

  // Refused by name before anything is examined: the positional is the one
  // thing on this path the user typed, and `rm -rf` is where it ends up.
  const installPath = agentInstallPath(targetLocation, agentName);

  // `lstat`: the ENTRY is what is installed. A `--dev` link whose build was
  // cleaned is dangling, and a following probe called it "not installed" and
  // left it in place. "Not installed" is an absence; a refused `lstat` is the
  // input's refusal.
  let stats: Stats;
  try {
    stats = await fs.lstat(installPath);
  } catch (error) {
    if (isPathAbsentError(error)) {
      throw new CommandRefusalError('USAGE_INVALID', `${agentName} is not installed at ${installPath}`, { cause: error });
    }
    throw unstatablePathRefusal(installPath, error);
  }
  const wasSymlink = stats.isSymbolicLink();

  await codedUserStateWrite(`remove ${installPath}`, () => fs.rm(installPath, { recursive: true, force: true }));

  if (wasSymlink) {
    logger.info(`✓ Removed symlink for ${agentName} from ${installPath}`);
  } else {
    logger.info(`✓ Uninstalled ${agentName} from ${installPath}`);
  }

  return { agent: agentName, installPath, wasSymlink };
}
