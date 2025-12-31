/**
 * Uninstall agent from Claude Skills directory
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';
import { validateAndGetScopeLocation } from '../../utils/scope-locations.js';

export interface UninstallOptions {
  scope?: 'user' | 'project';
  runtime?: string;
  debug?: boolean;
}

/**
 * Uninstall agent command
 */
export async function uninstallAgent(
  agentName: string,
  options: UninstallOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const { runtime = 'claude-skill', scope = 'user' } = options;

    // Validate scope and get target location
    const targetLocation = validateAndGetScopeLocation(runtime, scope);

    const installPath = path.join(targetLocation, agentName);

    // Check if installed
    try {
      await fs.access(installPath);
    } catch {
      logger.error(`\n${agentName} is not installed at ${installPath}\n`);
      process.exit(1);
    }

    // Check if symlink
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path from validated scope + agent name
    const stats = await fs.lstat(installPath);
    const isSymlink = stats.isSymbolicLink();

    // Remove installation
    await fs.rm(installPath, { recursive: true, force: true });

    if (isSymlink) {
      logger.info(`✓ Removed symlink for ${agentName} from ${installPath}`);
    } else {
      logger.info(`✓ Uninstalled ${agentName} from ${installPath}`);
    }

    const duration = Date.now() - startTime;
    logger.debug(`Uninstall completed in ${duration}ms`);

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Uninstall');
  }
}
