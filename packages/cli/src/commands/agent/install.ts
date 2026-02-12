/**
 * Install agent to Agent Skills directory
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { loadAgentManifest } from '@vibe-agent-toolkit/agent-config';
import { copyDirectory } from '@vibe-agent-toolkit/utils';

import { resolveAgentPath } from '../../utils/agent-discovery.js';
import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';
import { validateAndGetScopeLocation } from '../../utils/scope-locations.js';

export interface InstallOptions {
  scope?: 'user' | 'project';
  dev?: boolean;
  force?: boolean;
  runtime?: string;
  debug?: boolean;
}

/**
 * Install agent command
 */
export async function installAgent(
  agentName: string,
  options: InstallOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const { runtime = 'agent-skill', scope = 'user', dev = false, force = false } = options;

    // Windows check for dev mode
    if (dev && process.platform === 'win32') {
      throw new Error(
        '--dev (symlink) not supported on Windows.\n' +
          'Use copy mode (omit --dev) or WSL for development.'
      );
    }

    // Validate scope and get target location
    const targetLocation = validateAndGetScopeLocation(runtime, scope);

    // Find built skill
    const builtSkillPath = await findBuiltSkill(agentName, runtime, logger);
    const installPath = path.join(targetLocation, agentName);

    // Ensure target directory exists
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path constructed from validated scope location
    await fs.mkdir(targetLocation, { recursive: true });

    // Check if already installed
    try {
      await fs.access(installPath);
      if (!force) {
        logger.error(
          `\n${agentName} already installed at ${installPath}\n` +
            `Use --force to overwrite\n`
        );
        process.exit(1);
      }
      // Remove existing if force flag is set
      await fs.rm(installPath, { recursive: true, force: true });
    } catch {
      // Not installed, continue
    }

    if (dev) {
      // Symlink for development
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths from validated sources
      await fs.symlink(builtSkillPath, installPath, 'dir');
      logger.info(`✓ Symlinked ${agentName} to ${installPath} (dev mode)`);
      logger.info(`  Rebuild agent to see changes immediately`);
    } else {
      // Copy for production
      await copyDirectory(builtSkillPath, installPath);
      logger.info(`✓ Installed ${agentName} to ${installPath}`);
    }

    const duration = Date.now() - startTime;
    logger.debug(`Install completed in ${duration}ms`);

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'Install');
  }
}

/**
 * Find built skill bundle
 */
async function findBuiltSkill(
  agentName: string,
  runtime: string,
  logger: ReturnType<typeof createLogger>
): Promise<string> {
  // Resolve agent path
  const agentPath = await resolveAgentPath(agentName, logger);
  const manifest = await loadAgentManifest(agentPath);

  // Find package root by walking up from manifest path
  const packageRoot = await findAgentPackageRoot(manifest.__manifestPath ?? agentPath);

  // Runtime-specific bundle location
  const runtimeDir = runtime === 'agent-skill' ? 'skill' : runtime;
  const builtPath = path.join(
    packageRoot,
    'dist',
    'vat-bundles',
    runtimeDir,
    manifest.metadata.name
  );

  try {
    await fs.access(builtPath);
    return builtPath;
  } catch {
    throw new Error(
      `Built skill not found at ${builtPath}\n` +
        `Run: vat agent build ${agentName} --runtime ${runtime}`
    );
  }
}

/**
 * Find the agent package root (directory containing package.json)
 */
async function findAgentPackageRoot(manifestPath: string): Promise<string> {
  let currentDir = path.dirname(path.resolve(manifestPath));

  // Walk up until we find a package.json or hit the filesystem root
  while (currentDir !== path.dirname(currentDir)) {
    const packageJsonPath = path.join(currentDir, 'package.json');
    try {
      await fs.access(packageJsonPath);
      return currentDir;
    } catch {
      currentDir = path.dirname(currentDir);
    }
  }

  throw new Error(
    `Could not find package.json for agent at ${manifestPath}. ` +
      `Agent must be within an npm package to install.`
  );
}

